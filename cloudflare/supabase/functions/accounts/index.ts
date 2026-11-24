// accounts: the Accounts screen behind the app's Money tab. Every account and
// service Nexus reads, how fresh it is, what is missing, and the connections
// that keep it current. Keys and tokens go to Vault; nothing here prints them.
//
// POST { action: "overview" }                              signed in
// POST { action: "etoro_connect", api_key, user_key }      signed in; read-only eToro keys
// POST { action: "eb_setup", app_id, private_key }         signed in; the Enable Banking application key
// POST { action: "eb_start", service_id }                  signed in; returns the bank's consent URL
// POST { action: "eb_finish", code, state }                signed in; must be the user who started it
// POST { action: "sync" }                                  signed in: banks, Wise and eToro now
// POST { action: "disconnect", service_id }                signed in
// POST { action: "dismiss_need", code }                    signed in
// POST {} with the service key                             every user: the daily sync
// POST { action: "overview", user_id } with the service key  one user's overview (checks)
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize } from "../_shared/client.ts";
import { type AppConfig, loadConfig, need } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { claimState, type Connection, connections, markConnection, type Provider, readSecret, redirectUri, saveConnection, signState } from "../_shared/connect.ts";
import {
  type BankRow, type EbAccount, type EbAspsp, type EbBalance, type EbCredentials, type EbSession, type EbTransaction,
  EnableBanking, importSigningKey, last4, pickBalance, toBankRow,
} from "../_shared/enableBanking.ts";
import {
  type AccountState, addDays, buildNeeds, type CatalogItem, dayBatches, mapAccounts, type NexusAccount, newRows, parseCatalog, type ServiceState,
} from "../_shared/accounts.ts";
import { round2 } from "../_shared/fiscal/params.ts";

const today = () => new Date().toISOString().slice(0, 10);

function text(cfg: AppConfig, key: string): string {
  const v = cfg[key];
  if (!v) throw new Error(`app_config ${key} is missing`);
  return v;
}

/** One bank account inside a consent, as stored in nx_bank_links.accounts. */
interface LinkAccount {
  uid: string;
  last4: string | null;
  name: string | null;
  currency: string | null;
  cash_account_type: string | null;
  source: string;
  account: string;
  label: string;
  synced_to: string | null;
  balance: number | null;
  balance_type: string | null;
  balance_date: string | null;
}

interface BankLink {
  id: string;
  catalog_id: string;
  aspsp_name: string;
  aspsp_country: string;
  session_id: string;
  valid_until: string | null;
  accounts: LinkAccount[];
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
}

async function bankLinks(db: SupabaseClient, userId: string): Promise<BankLink[]> {
  const { data, error } = await db.from("nx_bank_links")
    .select("id, catalog_id, aspsp_name, aspsp_country, session_id, valid_until, accounts, status, last_sync_at, last_error").eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as BankLink[];
}

async function nexusAccounts(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("nx_accounts").select("source, account, label, kind, opening_date, opening_balance, include_in_cash").eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as (NexusAccount & { opening_date: string; opening_balance: number; include_in_cash: boolean })[];
}

/** All of a user's bank lines from a date (PostgREST pages are capped, so this reads page by page). */
async function lines(db: SupabaseClient, userId: string, filter: { source?: string; account?: string; from?: string }) {
  const out: { source: string; account: string; booked_on: string; amount: number }[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    let q = db.from("nx_transactions").select("source, account, booked_on, amount").eq("user_id", userId);
    if (filter.source) q = q.eq("source", filter.source);
    if (filter.account) q = q.eq("account", filter.account);
    if (filter.from) q = q.gte("booked_on", filter.from);
    const { data, error } = await q.order("id").range(offset, offset + page - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as typeof out).map((r) => ({ ...r, amount: Number(r.amount) })));
    if (!data || data.length < page) return out;
  }
}

async function ebClient(db: SupabaseClient, cfg: AppConfig, conns: Map<Provider, Connection>): Promise<EnableBanking | null> {
  const c = conns.get("enable_banking");
  if (!c || c.status !== "active") return null;
  const secret = await readSecret(db, c);
  if (!secret) return null;
  return new EnableBanking(text(cfg, "integrations.enable_banking.api_base"), JSON.parse(secret) as EbCredentials, need(cfg, "integrations.enable_banking.jwt_ttl_seconds"));
}

const KIND_BY_TYPE: Record<string, string> = { CACC: "current", SVGS: "savings", CARD: "card" };

// ---------------------------------------------------------------- bank sync

async function syncBank(db: SupabaseClient, cfg: AppConfig, userId: string, eb: EnableBanking, link: BankLink, item: CatalogItem) {
  const overlap = need(cfg, "accounts.overlap_days");
  const window = need(cfg, "accounts.match_window_days");
  const firstDays = need(cfg, "accounts.first_sync_days");
  const limit = need(cfg, "budget.import_batch_rows");
  const now = today();
  const totals = { received: 0, inserted: 0, duplicates: 0, needs_review: 0, skipped_known: 0 };
  try {
    const known = await nexusAccounts(db, userId);
    const accounts: LinkAccount[] = [];
    for (const a of link.accounts) {
      const existing = known.find((k) => k.source === a.source && k.account === a.account);
      const { data: newest } = await db.from("nx_transactions").select("booked_on").eq("user_id", userId)
        .eq("source", a.source).eq("account", a.account).order("booked_on", { ascending: false }).limit(1);
      const lastBooked = (newest?.[0]?.booked_on as string | undefined) ?? null;
      const from = a.synced_to ? addDays(a.synced_to, -overlap) : lastBooked ? addDays(lastBooked, -overlap) : addDays(now, -firstDays);

      const rows: BankRow[] = [];
      let key: string | null = null;
      const seen = new Set<string>();
      do {
        const q = new URLSearchParams({ date_from: from });
        if (key) q.set("continuation_key", key);
        const page = await eb.call<{ transactions?: EbTransaction[]; continuation_key?: string | null }>("GET", `/accounts/${encodeURIComponent(a.uid)}/transactions?${q}`);
        for (const t of page.transactions ?? []) {
          const r = toBankRow(t, a.source, a.account);
          if (r) rows.push(r);
        }
        key = page.continuation_key ?? null;
        if (key && seen.has(key)) break;
        if (key) seen.add(key);
      } while (key);

      const have = await lines(db, userId, { source: a.source, account: a.account, from: addDays(from, -window) });
      const fresh = newRows(rows, have.map((h) => ({ date: h.booked_on, amount: h.amount })), window);
      totals.skipped_known += rows.length - fresh.length;

      const bal = await eb.call<{ balances?: EbBalance[] }>("GET", `/accounts/${encodeURIComponent(a.uid)}/balances`).then((b) => pickBalance(b.balances ?? [])).catch(() => null);

      if (!existing) {
        // A bank account Nexus has not seen: it starts on the first day fetched,
        // with the opening balance that makes today's balance come out right.
        const opening = fresh.length ? fresh.reduce((m, r) => (r.date < m ? r.date : m), fresh[0].date) : now;
        const moved = fresh.reduce((s, r) => s + r.amount, 0);
        const { error } = await db.from("nx_accounts").insert({
          user_id: userId, source: a.source, account: a.account, label: a.label,
          kind: KIND_BY_TYPE[a.cash_account_type ?? ""] ?? (["current", "savings", "pot", "card", "wallet"].includes(item.kind) ? item.kind : "current"),
          opening_date: opening, opening_balance: bal ? round2(bal.amount - moved) : 0, include_in_cash: bal != null,
        });
        if (error && error.code !== "23505") throw new Error(`new account: ${error.message}`);
      }

      for (const batch of dayBatches(fresh, limit)) {
        const { data, error } = await db.rpc("nx_ingest_transactions", { p_user: userId, p_rows: batch });
        if (error) throw new Error(error.message);
        const r = data as Record<string, number>;
        totals.received += r.received ?? 0;
        totals.inserted += r.inserted ?? 0;
        totals.duplicates += r.duplicates ?? 0;
        totals.needs_review += r.needs_review ?? 0;
      }
      const newestRow = rows.reduce<string | null>((m, r) => (!m || r.date > m ? r.date : m), a.synced_to);
      accounts.push({ ...a, synced_to: newestRow, balance: bal?.amount ?? a.balance, balance_type: bal?.type ?? a.balance_type, balance_date: bal ? (bal.date ?? now) : a.balance_date });
    }
    await db.from("nx_bank_links").update({ accounts, status: "active", last_error: null, last_sync_at: new Date().toISOString() }).eq("id", link.id);
    return { service_id: item.id, ok: true, ...totals };
  } catch (e) {
    const message = (e as Error).message;
    const expired = /expired|EXPIRED|revoked|REVOKED/.test(message);
    await db.from("nx_bank_links").update({ status: expired ? "expired" : "error", last_error: message.slice(0, 300) }).eq("id", link.id);
    return { service_id: item.id, ok: false, error: message };
  }
}

// ---------------------------------------------------------------- Wise and eToro

async function syncWise(db: SupabaseClient, cfg: AppConfig, userId: string, conn: Connection) {
  try {
    const token = await readSecret(db, conn);
    const profile = conn.settings?.wise_profile_id;
    if (!token || !profile) throw new Error("connect Wise again");
    const res = await fetch(`${text(cfg, "integrations.wise_api_base")}/v4/profiles/${profile}/balances?types=STANDARD,SAVINGS`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Wise ${res.status}`);
    const balances = (await res.json()) as { id: number; currency: string; amount?: { value?: number }; type?: string; name?: string | null }[];
    const rows = balances.map((b) => ({
      user_id: userId, currency: b.currency, balance: Number(b.amount?.value ?? 0), is_jar: b.type === "SAVINGS", label: b.name ?? null, external_id: String(b.id),
    }));
    if (rows.length) {
      const { error } = await db.from("wise_accounts").upsert(rows, { onConflict: "user_id,external_id" });
      if (error) throw new Error(error.message);
    }
    const ids = rows.map((r) => r.external_id);
    const del = db.from("wise_accounts").delete().eq("user_id", userId);
    await (ids.length ? del.not("external_id", "in", `(${ids.join(",")})`) : del);
    await markConnection(db, userId, "wise", { status: "active", last_error: null, cursor: { as_of: new Date().toISOString(), balances: rows.length } });
    return { service_id: "wise", ok: true, balances: rows.length };
  } catch (e) {
    await markConnection(db, userId, "wise", { status: "error", last_error: (e as Error).message.slice(0, 300) });
    return { service_id: "wise", ok: false, error: (e as Error).message };
  }
}

interface EtoroKeys { api_key: string; user_key: string }

async function etoro<T>(cfg: AppConfig, keys: EtoroKeys, path: string): Promise<T> {
  const res = await fetch(`${text(cfg, "integrations.etoro.api_base")}${path}`, {
    headers: { "x-api-key": keys.api_key, "x-user-key": keys.user_key, "x-request-id": crypto.randomUUID() },
  });
  if (!res.ok) throw new Error(`eToro ${res.status}`);
  return (await res.json()) as T;
}

type Pos = Record<string, unknown>;
const pnum = (o: Pos, ...keys: string[]) => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
};

/** Positions with their profit and current rate, from the real-account PnL view. */
export function readEtoroPortfolio(raw: unknown) {
  const p = ((raw as { clientPortfolio?: Pos })?.clientPortfolio ?? {}) as Pos;
  const own = (p.positions as Pos[] | undefined) ?? [];
  const copied = ((p.mirrors as Pos[] | undefined) ?? []).flatMap((m) => (m.positions as Pos[] | undefined) ?? []);
  const positions = [...own, ...copied].map((x) => {
    const u = (x.unrealizedPnL && typeof x.unrealizedPnL === "object" ? x.unrealizedPnL : {}) as Pos;
    const pnl = pnum(u, "pnL", "pnl") ?? pnum(x, "pnL", "pnl");
    const amount = pnum(x, "amount") ?? 0;
    return {
      id: String(x.positionID ?? x.positionId ?? ""),
      instrument: pnum(x, "instrumentID", "instrumentId"),
      units: pnum(x, "units"),
      open_rate: pnum(x, "openRate"),
      current_rate: pnum(u, "closeRate") ?? pnum(x, "closeRate", "currentRate"),
      pnl,
      value: round2(amount + (pnl ?? 0)),
    };
  }).filter((x) => x.id !== "");
  const totalPnl = typeof p.unrealizedPnL === "number" ? p.unrealizedPnL : positions.reduce((s, x) => s + (x.pnl ?? 0), 0);
  return { credit: pnum(p, "credit") ?? 0, unrealized_pnl: round2(totalPnl), positions };
}

async function syncEtoro(db: SupabaseClient, cfg: AppConfig, userId: string, conn: Connection) {
  try {
    const secret = await readSecret(db, conn);
    if (!secret) throw new Error("connect eToro again");
    const keys = JSON.parse(secret) as EtoroKeys;
    const book = readEtoroPortfolio(await etoro(cfg, keys, "/api/v1/trading/info/real/pnl"));
    const ids = [...new Set(book.positions.map((x) => x.instrument).filter((x): x is number => x != null))];
    const names = new Map<number, string>();
    if (ids.length) {
      const meta = await etoro<{ instrumentDisplayDatas?: { instrumentID: number; instrumentDisplayName?: string; symbolFull?: string }[] }>(
        cfg, keys, `/api/v1/market-data/instruments?instrumentIds=${ids.join(",")}`).catch(() => ({ instrumentDisplayDatas: [] }));
      for (const m of meta.instrumentDisplayDatas ?? []) names.set(m.instrumentID, m.symbolFull ?? m.instrumentDisplayName ?? String(m.instrumentID));
    }
    const asOf = new Date().toISOString();
    const rows = book.positions.map((x) => ({
      user_id: userId, source: "etoro", external_id: x.id, symbol: x.instrument != null ? (names.get(x.instrument) ?? String(x.instrument)) : null,
      units: x.units, open_rate: x.open_rate, current_rate: x.current_rate, value: x.value, currency: "USD", pnl: x.pnl, as_of: asOf,
    }));
    if (rows.length) {
      const { error } = await db.from("nx_positions").upsert(rows, { onConflict: "user_id,source,external_id" });
      if (error) throw new Error(error.message);
    }
    const del = db.from("nx_positions").delete().eq("user_id", userId).eq("source", "etoro");
    await (rows.length ? del.not("external_id", "in", `(${rows.map((r) => r.external_id).join(",")})`) : del);
    await markConnection(db, userId, "etoro", {
      status: "active", last_error: null,
      cursor: { as_of: asOf, credit_usd: book.credit, unrealized_pnl_usd: book.unrealized_pnl, positions: rows.length, invested_usd: round2(rows.reduce((s, r) => s + (r.value ?? 0), 0)) },
    });
    return { service_id: "etoro", ok: true, positions: rows.length };
  } catch (e) {
    await markConnection(db, userId, "etoro", { status: "error", last_error: (e as Error).message.slice(0, 300) });
    return { service_id: "etoro", ok: false, error: (e as Error).message };
  }
}

async function syncAll(db: SupabaseClient, cfg: AppConfig, userId: string) {
  const catalog = parseCatalog(cfg["integrations.catalog"]);
  const conns = await connections(db, userId);
  const results: Record<string, unknown>[] = [];
  const eb = await ebClient(db, cfg, conns);
  if (eb) {
    for (const link of await bankLinks(db, userId)) {
      if (link.status === "revoked") continue;
      const item = catalog.find((c) => c.id === link.catalog_id);
      if (item) results.push(await syncBank(db, cfg, userId, eb, link, item));
    }
  }
  const wise = conns.get("wise");
  if (wise && wise.status !== "revoked") results.push(await syncWise(db, cfg, userId, wise));
  const et = conns.get("etoro");
  if (et && et.status !== "revoked") results.push(await syncEtoro(db, cfg, userId, et));
  return results;
}

// ---------------------------------------------------------------- overview

async function overview(db: SupabaseClient, cfg: AppConfig, userId: string) {
  const now = today();
  const year = Number(now.slice(0, 4));
  const catalog = parseCatalog(cfg["integrations.catalog"]);
  const [conns, links, known, all, wise, positions, forecast, reviews, inputs, settings] = await Promise.all([
    connections(db, userId),
    bankLinks(db, userId),
    nexusAccounts(db, userId),
    lines(db, userId, {}),
    db.from("wise_accounts").select("currency, balance, is_jar, label").eq("user_id", userId).order("balance", { ascending: false }),
    db.from("nx_positions").select("value, pnl, currency").eq("user_id", userId).eq("source", "etoro"),
    db.from("nx_tax_forecast_live").select("figures, computed_at").eq("user_id", userId).eq("year", year).maybeSingle(),
    db.from("review_items").select("id, summary, item_type, reason_codes").eq("user_id", userId).eq("status", "open").order("created_at"),
    db.from("nx_tax_year_inputs").select("year").eq("user_id", userId).eq("year", year + 1),
    db.from("nx_user_settings").select("key, value").eq("user_id", userId).eq("key", "needs.dismissed"),
  ]);
  for (const r of [wise, positions, forecast, reviews, inputs, settings]) if (r.error) throw new Error(r.error.message);

  const fed = new Map<string, LinkAccount>();
  for (const l of links) if (l.status !== "revoked") for (const a of l.accounts) fed.set(`${a.source}|${a.account}`, a);

  const accounts: AccountState[] = known.map((a): AccountState => {
    const mine = all.filter((x) => x.source === a.source && x.account === a.account);
    const since = mine.filter((x) => x.booked_on >= a.opening_date);
    const lastBooked = mine.reduce<string | null>((m, x) => (!m || x.booked_on > m ? x.booked_on : m), null);
    const link = fed.get(`${a.source}|${a.account}`);
    return {
      label: a.label, source: a.source, account: a.account, kind: a.kind,
      balance: round2(Number(a.opening_balance) + since.reduce((s, x) => s + x.amount, 0)),
      last_booked: lastBooked, bank_balance: link?.balance ?? null, bank_balance_date: link?.balance_date ?? null, feed: link ? "bank" : "file",
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  const googleReady = !!Deno.env.get("GOOGLE_CLIENT_ID") && !!Deno.env.get("GOOGLE_CLIENT_SECRET");
  const ebConn = conns.get("enable_banking");
  const ebReady = ebConn?.status === "active";
  const services: ServiceState[] = catalog.map((item) => {
    const fromConn = (c: Connection | undefined): ServiceState => !c || c.status === "revoked"
      ? { item, status: "not_connected", detail: null, valid_until: null }
      : { item, status: c.status === "active" ? "connected" : "error", detail: c.last_error ?? c.account_label, valid_until: null };
    switch (item.via) {
      case "enable_banking_app": return { ...fromConn(ebConn), detail: ebReady ? `Application ${String(ebConn?.settings?.app_id ?? "").slice(0, 8)}` : null };
      case "enable_banking": {
        const l = links.find((x) => x.catalog_id === item.id && x.status !== "revoked");
        if (!l) return { item, status: "not_connected", detail: ebReady ? null : "Set up Enable Banking first.", valid_until: null };
        return { item, status: l.status === "active" ? "connected" : "error", detail: l.last_error ?? (l.last_sync_at ? `Synced ${l.last_sync_at.slice(0, 16).replace("T", " ")}` : null), valid_until: l.valid_until };
      }
      case "wise_token": return fromConn(conns.get("wise"));
      case "etoro_keys": return fromConn(conns.get("etoro"));
      case "google_oauth": return googleReady ? fromConn(conns.get("google"))
        : { item, status: "unavailable", detail: "Google sign-in is not set up on the server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).", valid_until: null };
      default: return { item, status: "unavailable", detail: null, valid_until: null };
    }
  });

  let dismissed = new Set<string>();
  try { dismissed = new Set(JSON.parse(settings.data?.[0]?.value ?? "[]") as string[]); } catch { /* none */ }
  let manual: { code: string; title: string; detail: string; until?: string }[] = [];
  try { manual = JSON.parse(cfg["accounts.manual_needs"] ?? "[]"); } catch { /* none */ }
  const fmt = new Intl.NumberFormat("en-NL", { style: "currency", currency: "EUR" });
  const needs = buildNeeds({
    today: now, services, accounts,
    staleDays: need(cfg, "accounts.stale_days"), consentWarnDays: need(cfg, "accounts.consent_warn_days"), balanceTolerance: need(cfg, "accounts.balance_tolerance_eur"),
    forecastWarnings: ((forecast.data?.figures as { warnings?: { code: string; severity: string; message: string }[] } | undefined)?.warnings ?? []),
    reviews: (reviews.data ?? []).map((r) => ({ id: r.id as string, summary: r.summary as string, item_type: r.item_type as string, reason_codes: (r.reason_codes ?? []) as string[] })),
    nextYearPlanned: (inputs.data ?? []).length > 0, nextYear: year + 1,
    manual, dismissed, formatMoney: (x) => fmt.format(x),
  });

  const et = conns.get("etoro");
  const cursor = (et?.cursor ?? {}) as Record<string, unknown>;
  return {
    as_of: now,
    redirect_url: redirectUri(),
    callback_url: text(cfg, "integrations.app_callback_url"),
    services: services.map((s) => ({
      id: s.item.id, name: s.item.name, kind: s.item.kind, via: s.item.via, status: s.status, detail: s.detail, valid_until: s.valid_until,
      open_url: s.item.open_url ?? null, help_url: s.item.help_url ?? null, help: s.item.help ?? null, optional: s.item.optional === true,
    })),
    accounts,
    wallets: (wise.data ?? []).map((w) => ({ label: w.label ?? (w.is_jar ? `Jar ${w.currency}` : `Wise ${w.currency}`), currency: w.currency as string, balance: Number(w.balance) })),
    broker: et && et.status !== "revoked" ? {
      as_of: (cursor.as_of as string | undefined) ?? null,
      cash_usd: Number(cursor.credit_usd ?? 0),
      invested_usd: round2((positions.data ?? []).reduce((s, p) => s + Number(p.value ?? 0), 0)),
      unrealized_pnl_usd: Number(cursor.unrealized_pnl_usd ?? 0),
      positions: (positions.data ?? []).length,
    } : null,
    needs,
  };
}

// ---------------------------------------------------------------- handler

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const cfg = await loadConfig(db);
    if (who.kind === "service") {
      // The scheduler: one named user's overview (checks), or the daily sync for everyone.
      const sb = await req.clone().json().catch(() => ({}));
      if (sb.action === "overview" && typeof sb.user_id === "string") return json(await overview(db, cfg, sb.user_id));
      const { data: users } = await db.from("profiles").select("id");
      const out: Record<string, unknown>[] = [];
      for (const u of users ?? []) out.push({ user: (u.id as string).slice(0, 8), results: await syncAll(db, cfg, u.id as string) });
      return json({ ok: true, users: out });
    }
    const userId = who.id;
    const body = await req.json().catch(() => ({}));
    const catalog = parseCatalog(cfg["integrations.catalog"]);
    switch (body.action ?? "overview") {
      case "overview":
        return json(await overview(db, cfg, userId));

      case "sync":
        return json({ results: await syncAll(db, cfg, userId), overview: await overview(db, cfg, userId) });

      case "etoro_connect": {
        const keys = { api_key: String(body.api_key ?? "").trim(), user_key: String(body.user_key ?? "").trim() };
        if (!keys.api_key || !keys.user_key) return json({ error: "both the public API key and the user key are needed" }, 400);
        try {
          await etoro(cfg, keys, "/api/v1/trading/info/real/pnl");
        } catch (e) {
          return json({ error: `eToro rejected the keys (${(e as Error).message})` }, 400);
        }
        await saveConnection(db, userId, "etoro", JSON.stringify(keys), { account_label: "eToro", settings: {} });
        const conn = (await connections(db, userId)).get("etoro")!;
        return json({ ok: true, sync: await syncEtoro(db, cfg, userId, conn) });
      }

      case "eb_setup": {
        const appId = String(body.app_id ?? "").trim();
        const pem = String(body.private_key ?? "").trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) return json({ error: "the application ID is the long code in the .pem file name" }, 400);
        try {
          await importSigningKey(pem);
        } catch {
          return json({ error: "that is not the private key (.pem) Enable Banking gave you" }, 400);
        }
        const eb = new EnableBanking(text(cfg, "integrations.enable_banking.api_base"), { app_id: appId, private_key: pem }, need(cfg, "integrations.enable_banking.jwt_ttl_seconds"));
        const country = catalog.find((c) => c.via === "enable_banking" && c.country)?.country;
        if (!country) return json({ error: "no bank in app_config integrations.catalog" }, 500);
        try {
          await eb.call("GET", `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
        } catch (e) {
          return json({ error: `Enable Banking rejected the key: ${(e as Error).message}` }, 400);
        }
        await saveConnection(db, userId, "enable_banking", JSON.stringify({ app_id: appId, private_key: pem }), { account_label: "Enable Banking", settings: { app_id: appId } });
        return json({ ok: true, redirect_url: redirectUri() });
      }

      case "eb_start": {
        const item = catalog.find((c) => c.id === body.service_id && c.via === "enable_banking");
        if (!item || !item.aspsp || !item.country || !item.source) return json({ error: "unknown bank" }, 400);
        const eb = await ebClient(db, cfg, await connections(db, userId));
        if (!eb) return json({ error: "set up Enable Banking first" }, 409);
        const list = await eb.call<{ aspsps?: EbAspsp[] }>("GET", `/aspsps?country=${encodeURIComponent(item.country)}&psu_type=personal`);
        const want = item.aspsp.toLowerCase();
        const aspsp = (list.aspsps ?? []).find((a) => a.name.toLowerCase() === want) ?? (list.aspsps ?? []).find((a) => a.name.toLowerCase().startsWith(want));
        if (!aspsp) return json({ error: `Enable Banking does not list ${item.aspsp} in ${item.country}` }, 404);
        const seconds = Math.min(need(cfg, "integrations.enable_banking.consent_days") * 86_400, aspsp.maximum_consent_validity ?? Infinity);
        const auth = await eb.call<{ url: string }>("POST", "/auth", {
          access: { valid_until: new Date(Date.now() + seconds * 1000).toISOString() },
          aspsp: { name: aspsp.name, country: aspsp.country },
          state: await signState(db, userId, "bank", "app", item.id),
          redirect_url: redirectUri(),
          psu_type: "personal",
        });
        return json({ url: auth.url });
      }

      case "eb_finish": {
        const st = await claimState(db, String(body.state ?? ""), userId, "bank");
        if (!st) return json({ error: "this bank link was not started by you, has expired or was already used; start again" }, 403);
        const item = catalog.find((c) => c.id === st.c && c.via === "enable_banking");
        if (!item || !item.source) return json({ error: "unknown bank" }, 400);
        const eb = await ebClient(db, cfg, await connections(db, userId));
        if (!eb) return json({ error: "set up Enable Banking first" }, 409);
        const session = await eb.call<EbSession>("POST", "/sessions", { code: String(body.code ?? "") });
        const details: EbAccount[] = [];
        for (const a of session.accounts ?? []) {
          if (typeof a !== "string") { details.push(a); continue; }
          const known = (session.accounts_data ?? []).find((d) => d.uid === a);
          details.push(known ?? { ...(await eb.call<EbAccount>("GET", `/accounts/${encodeURIComponent(a)}/details`)), uid: a });
        }
        const bank = details.filter((d) => d.uid).map((d) => ({ uid: d.uid!, last4: last4(d), name: d.name ?? d.product ?? null, currency: d.currency ?? null, type: d.cash_account_type ?? null }));
        const pairs = mapAccounts(bank, await nexusAccounts(db, userId), item.source);
        const accounts: LinkAccount[] = bank.map((b) => {
          const n = pairs.get(b.uid) ?? null;
          const tail = b.last4 ?? b.uid.slice(-4);
          return {
            uid: b.uid, last4: b.last4, name: b.name, currency: b.currency, cash_account_type: b.type, source: item.source!,
            account: n?.account ?? tail, label: n?.label ?? `${item.name} ${b.name ?? ""} ${tail}`.replace(/\s+/g, " ").trim(),
            synced_to: null, balance: null, balance_type: null, balance_date: null,
          };
        });
        const { data: link, error } = await db.from("nx_bank_links").upsert({
          user_id: userId, catalog_id: item.id, aspsp_name: session.aspsp?.name ?? item.aspsp, aspsp_country: session.aspsp?.country ?? item.country,
          session_id: session.session_id, valid_until: session.access?.valid_until ?? null, accounts, status: "active", last_error: null,
        }, { onConflict: "user_id,catalog_id" }).select("id, catalog_id, aspsp_name, aspsp_country, session_id, valid_until, accounts, status, last_sync_at, last_error").single();
        if (error) throw new Error(error.message);
        return json({ ok: true, accounts: accounts.length, sync: await syncBank(db, cfg, userId, eb, link as BankLink, item) });
      }

      case "disconnect": {
        const item = catalog.find((c) => c.id === body.service_id);
        if (!item) return json({ error: "unknown service" }, 400);
        if (item.via === "enable_banking") {
          const link = (await bankLinks(db, userId)).find((l) => l.catalog_id === item.id);
          if (link) {
            const eb = await ebClient(db, cfg, await connections(db, userId));
            await eb?.call("DELETE", `/sessions/${encodeURIComponent(link.session_id)}`).catch(() => null);
            await db.from("nx_bank_links").update({ status: "revoked" }).eq("id", link.id);
          }
        } else {
          const provider: Provider | null = item.via === "wise_token" ? "wise" : item.via === "etoro_keys" ? "etoro" : item.via === "google_oauth" ? "google" : item.via === "enable_banking_app" ? "enable_banking" : null;
          if (provider) await markConnection(db, userId, provider, { status: "revoked" });
        }
        return json({ ok: true });
      }

      case "dismiss_need": {
        const code = String(body.code ?? "");
        if (!code) return json({ error: "code required" }, 400);
        const { data } = await db.from("nx_user_settings").select("value").eq("user_id", userId).eq("key", "needs.dismissed").maybeSingle();
        let list: string[] = [];
        try { list = JSON.parse(data?.value ?? "[]"); } catch { /* start over */ }
        if (!list.includes(code)) list.push(code);
        const { error } = await db.from("nx_user_settings").upsert({ user_id: userId, key: "needs.dismissed", value: JSON.stringify(list) }, { onConflict: "user_id,key" });
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

// spend: v2 budget feed. Reads order emails and Apple receipts from the v2
// mailbox, reads receipt photos, names the shop behind Klarna and PayPal lines,
// splits supermarket lines into Food staples and Food luxury, finds recurring
// charges for the purchase review, follows cancels, raises stop-list alerts
// and closes a month with a Drive archive. Every setting comes from app_config.
//
// POST { mode: "daily" } with the service key           every user: the scheduled run
// POST { action: "status" }                              signed in: mailbox state for Settings
// POST { action: "google_start" }                        signed in: consent URL for the v2 mailbox
// POST { action: "google_finish", code, state }          signed in: must be the user who started it
// POST { action: "disconnect" }                          signed in: stops the mailbox
// POST { action: "run" }                                 signed in: the daily run now
// POST { action: "receipt_photo", path }                 signed in: a receipt photo in the documents bucket
// POST { action: "close_month", month }                  signed in: month = YYYY-MM-01
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize, requireEnv } from "../_shared/client.ts";
import { type AppConfig, loadConfig, need } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { claimState, connections, markConnection, redirectUri, saveConnection, signState } from "../_shared/connect.ts";
import { googleAccessToken } from "../_shared/collectors.ts";
import { Google } from "../_shared/google.ts";
import { type ContentBlock, type Structured, structuredFor } from "../_shared/llm.ts";
import {
  applyCalls, type CallRule, cancelUpdates, cleanReading, detectRecurring, foodSplit, type Item, matchReceipt, matchTap,
  type Reading, receiptInTime, type SpendLine, stopAlerts, stopLists,
} from "../_shared/spend.ts";

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function text(cfg: AppConfig, key: string): string {
  const v = cfg[key];
  if (!v) throw new Error(`app_config ${key} is missing`);
  return v;
}
function list<T>(cfg: AppConfig, key: string): T {
  return JSON.parse(text(cfg, key)) as T;
}

/** The settings for one user: their own values (nx_user_settings, changed in the app) over the defaults. */
async function userCfg(db: SupabaseClient, cfg: AppConfig, userId: string): Promise<AppConfig> {
  const { data } = await db.from("nx_user_settings").select("key, value").eq("user_id", userId);
  return { ...cfg, ...Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value as string])) };
}

/** Reads every row of a query in pages; PostgREST caps one response. */
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

// ------------------------------------------------------------ reading -------

const READ_TOOL = {
  name: "record_purchase",
  description: "Record what this purchase document shows.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["order", "apple", "grocery", "other"] },
      merchant: { type: ["string", "null"], description: "The shop that sold the goods, not the payment service" },
      total: { type: ["number", "null"], description: "Order or receipt total as paid" },
      currency: { type: ["string", "null"], description: "ISO code, for example EUR" },
      date: { type: ["string", "null"], description: "Purchase date YYYY-MM-DD" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            amount: { type: ["number", "null"] },
            staple: { type: "boolean" },
            period: { type: ["string", "null"], enum: ["weekly", "monthly", "yearly", null], description: "Subscriptions only: how often it renews" },
            renews_on: { type: ["string", "null"], description: "Subscriptions only: next renewal date YYYY-MM-DD" },
          },
          required: ["name", "amount", "staple"],
        },
      },
    },
    required: ["kind", "merchant", "total", "currency", "date", "items"],
  },
};

interface Reader { llm: Structured; system: string }

async function reader(db: SupabaseClient): Promise<Reader> {
  const { data: a, error } = await db.from("agent_configs")
    .select("system_prompt, llm_provider, llm_model, max_tokens, temperature, enabled").eq("agent_id", "spend_reader").single();
  if (error || !a) throw new Error("agent_configs spend_reader is missing");
  if (!a.enabled) throw new Error("the receipt reader is disabled in agent_configs");
  return {
    llm: structuredFor({ provider: a.llm_provider, model: a.llm_model, maxTokens: a.max_tokens, temperature: Number(a.temperature) }),
    system: a.system_prompt,
  };
}

async function read(r: Reader, staples: string[], content: ContentBlock[]): Promise<Reading> {
  const res = await r.llm<Record<string, unknown>>(
    `${r.system}\n\nStaples: ${staples.join(", ")}.`,
    content,
    READ_TOOL,
  );
  return cleanReading(res.value);
}

// ------------------------------------------------------------ mailbox -------

async function mailToken(db: SupabaseClient, cfg: AppConfig, userId: string): Promise<{ token: string; cursor: Record<string, unknown> } | null> {
  const { data: c } = await db.from("integration_connections").select("id, provider, vault_secret_id, settings, cursor, status")
    .eq("user_id", userId).eq("provider", "gmail").maybeSingle();
  if (!c || c.status !== "active" || !c.vault_secret_id) return null;
  try {
    const token = await googleAccessToken(db, cfg, c as never);
    return { token, cursor: (c.cursor ?? {}) as Record<string, unknown> };
  } catch (e) {
    await markConnection(db, userId, "gmail", { status: "error", last_error: (e as Error).message.slice(0, 500) });
    return null;
  }
}

/** New order emails and Apple receipts into nx_receipts; each message is read once. */
async function readMail(db: SupabaseClient, cfg: AppConfig, userId: string, rd: () => Promise<Reader>, m: Record<string, number>) {
  const auth = await mailToken(db, cfg, userId);
  if (!auth) return;
  const lastRead = typeof auth.cursor.mail_read_at === "string" ? auth.cursor.mail_read_at : null;
  const lookback = lastRead
    ? Math.max(1, Math.ceil((Date.now() - Date.parse(lastRead)) / 86_400_000) + 1)
    : need(cfg, "spend.mail_lookback_days");
  const g = new Google(auth.token, cfg);
  const ids = await g.searchIds(text(cfg, "spend.mail_query").replace("{days}", String(lookback)), need(cfg, "spend.mail_max_per_run"));
  if (ids.length) {
    const { data: seen } = await db.from("nx_receipts").select("external_id").eq("user_id", userId).eq("source", "gmail").in("external_id", ids);
    const known = new Set((seen ?? []).map((r) => r.external_id as string));
    const staples = list<string[]>(cfg, "food.staples");
    const apple = new RegExp(text(cfg, "spend.apple_sender_pattern"), "i");
    let r: Reader | null = null;
    for (const id of ids.filter((x) => !known.has(x))) {
      const msg = await g.message(id);
      r ??= await rd();
      const reading = await read(r, staples, [{ type: "text", text: `From: ${msg.from}\nSubject: ${msg.subject}\nReceived: ${msg.receivedAt}\n\n${msg.text.slice(0, 12_000)}` }]);
      const kind = apple.test(msg.from) ? "apple" : reading.kind;
      await db.from("nx_receipts").upsert({
        user_id: userId, source: "gmail", external_id: id, received_at: msg.receivedAt, kind,
        merchant: kind === "apple" ? "Apple" : reading.merchant, total: reading.total, currency: reading.currency,
        order_date: reading.date ?? msg.receivedAt.slice(0, 10), items: reading.items,
        match_status: kind === "other" ? "ignored" : "unmatched",
      }, { onConflict: "user_id,source,external_id", ignoreDuplicates: true });
      m.mail_read = (m.mail_read ?? 0) + 1;
    }
  }
  await markConnection(db, userId, "gmail", { cursor: { ...auth.cursor, mail_read_at: new Date().toISOString() }, last_error: null, status: "active" });
}

// ------------------------------------------------------------ matching ------

interface ReceiptRow {
  id: string; source: string; kind: string; merchant: string | null; total: number | null; currency: string | null;
  order_date: string | null; received_at: string; items: Item[]; txn_id: string | null; match_status: string;
}

async function writeSplit(db: SupabaseClient, userId: string, txn: SpendLine, parts: { category: string; amount: number }[], origin: "receipt" | "tap", receiptId: string | null) {
  await db.from("nx_txn_splits").delete().eq("txn_id", txn.id);
  if (!parts.length) return;
  const { error } = await db.from("nx_txn_splits").insert(parts.map((p) => ({ user_id: userId, txn_id: txn.id, category: p.category, amount: p.amount, origin, receipt_id: receiptId })));
  if (error) throw new Error(error.message);
}

/** Pairs receipts and Wallet taps with bank lines, names hidden shops, and splits supermarket lines. */
async function matchAll(db: SupabaseClient, cfg: AppConfig, userId: string, lines: SpendLine[], m: Record<string, number>) {
  const opts = { windowDays: need(cfg, "spend.match_window_days"), toleranceEur: need(cfg, "spend.match_tolerance_eur"), hiddenRails: list<string[]>(cfg, "spend.unmask_rails") };
  const staples = list<string[]>(cfg, "food.staples");
  const cats = { staples: text(cfg, "food.staples_category"), luxury: text(cfg, "food.luxury_category") };
  const receiptDays = need(cfg, "food.receipt_days");
  const byId = new Map(lines.map((l) => [l.id, l]));

  const receipts = await all<ReceiptRow>((a, b) => db.from("nx_receipts")
    .select("id, source, kind, merchant, total, currency, order_date, received_at, items, txn_id, match_status")
    .eq("user_id", userId).gte("received_at", daysAgo(90)).order("received_at").range(a, b));
  const taken = new Set(receipts.filter((r) => r.txn_id).map((r) => r.txn_id as string));
  const { data: splitRows } = await db.from("nx_txn_splits").select("txn_id, origin").eq("user_id", userId);
  const split = new Map((splitRows ?? []).map((s) => [s.txn_id as string, s.origin as string]));

  for (const r of receipts.filter((x) => x.match_status === "unmatched")) {
    const hit = matchReceipt({ merchant: r.merchant, total: r.total, currency: r.currency, date: r.order_date ?? r.received_at }, lines, taken, opts);
    if (!hit) continue;
    taken.add(hit.id);
    await db.from("nx_receipts").update({ txn_id: hit.id, match_status: "matched" }).eq("id", r.id);
    m.receipts_matched = (m.receipts_matched ?? 0) + 1;
    if (hit.rail && opts.hiddenRails.includes(hit.rail.toLowerCase()) && r.merchant && !/klarna|paypal/i.test(r.merchant)) {
      await db.from("nx_transactions").update({ merchant: r.merchant }).eq("id", hit.id);
      await db.rpc("nx_reclassify_line", { p_txn: hit.id });
      m.shops_named = (m.shops_named ?? 0) + 1;
    }
    if (r.kind === "grocery" && receiptInTime(r.received_at, r.order_date, hit.booked_on, receiptDays)) {
      const parts = foodSplit(hit.amount, r.items, staples, cats);
      if (parts.length) {
        await writeSplit(db, userId, hit, parts, "receipt", r.id);
        split.set(hit.id, "receipt");
        m.food_splits = (m.food_splits ?? 0) + 1;
      }
    }
  }

  const taps = await all<{ id: string; merchant: string; amount: number | null; currency: string; tapped_at: string; food: string | null; txn_id: string | null }>(
    (a, b) => db.from("nx_wallet_taps").select("id, merchant, amount, currency, tapped_at, food, txn_id")
      .eq("user_id", userId).gte("tapped_at", daysAgo(60)).order("tapped_at").range(a, b));
  const tapTaken = new Set(taps.filter((t) => t.txn_id).map((t) => t.txn_id as string));
  for (const t of taps) {
    let txn = t.txn_id ? byId.get(t.txn_id) ?? null : null;
    if (!txn) {
      txn = matchTap(t, lines, tapTaken, opts);
      if (!txn) continue;
      tapTaken.add(txn.id);
      await db.from("nx_wallet_taps").update({ txn_id: txn.id }).eq("id", t.id);
      m.taps_matched = (m.taps_matched ?? 0) + 1;
    }
    if (t.food === "staples" && !split.has(txn.id)) {
      await writeSplit(db, userId, txn, [{ category: cats.staples, amount: txn.amount }], "tap", null);
      split.set(txn.id, "tap");
      m.food_splits = (m.food_splits ?? 0) + 1;
    }
  }
  return receipts;
}

// ------------------------------------------------------------ review --------

interface RecurringRow {
  id: string; key: string; label: string; source: string; call: string | null; tag: string | null; proposed_call: string | null;
  note: string | null; status: string | null; decided_at: string | null; next_due: string | null;
}

async function review(db: SupabaseClient, cfg: AppConfig, userId: string, lines: SpendLine[], receipts: ReceiptRow[], m: Record<string, number>) {
  const classes = new Set(list<string[]>(cfg, "recurring.classes"));
  const since = new Date(Date.now() - need(cfg, "recurring.lookback_months") * 30.44 * 86_400_000).toISOString().slice(0, 10);
  const pool = lines.filter((l) => l.booked_on >= since && classes.has((l as SpendLine & { class: string }).class));
  const found = detectRecurring(pool, {
    minCharges: need(cfg, "recurring.min_charges"),
    cadenceDays: list(cfg, "recurring.cadence_days"),
    tolerancePct: need(cfg, "recurring.amount_tolerance_pct"),
    today: today(),
  });
  const standing = list<CallRule[]>(cfg, "review.standing_calls");
  const proposals = list<CallRule[]>(cfg, "review.proposals");
  const { data: existing } = await db.from("nx_recurring")
    .select("id, key, label, source, call, tag, proposed_call, note, status, decided_at, next_due").eq("user_id", userId);
  const rows = new Map(((existing ?? []) as RecurringRow[]).map((r) => [r.key, r]));

  const upserts: Record<string, unknown>[] = [];
  for (const f of found) {
    const prior = rows.get(f.key);
    const calls = applyCalls({ label: f.label, call: (prior?.call ?? null) as never, tag: (prior?.tag ?? null) as never, proposed_call: (prior?.proposed_call ?? null) as never, note: prior?.note ?? null }, standing, proposals);
    upserts.push({
      user_id: userId, key: f.key, label: f.label, category: f.category, source: "bank", cadence: f.cadence, amount: f.amount, per_year: f.per_year,
      charges: f.charges, paid_this_year: f.paid_this_year, last_charge: f.last_charge, next_due: f.next_due,
      call: calls.call, tag: calls.tag, proposed_call: calls.proposed_call, note: calls.note, updated_at: new Date().toISOString(),
    });
  }
  // Named Apple subscriptions from their receipts: the item, its price, how often and when it renews.
  const appleSubs = new Map<string, { label: string; amount: number | null; period: string; renews: string | null; last: string }>();
  for (const r of receipts.filter((x) => x.kind === "apple")) {
    for (const it of r.items) {
      if (!it.period) continue;
      const key = `apple:${squash(it.name)}`;
      const date = r.order_date ?? r.received_at.slice(0, 10);
      const prev = appleSubs.get(key);
      if (!prev || date >= prev.last) appleSubs.set(key, { label: it.name, amount: it.amount, period: it.period, renews: it.renews_on ?? null, last: date });
    }
  }
  const perYear: Record<string, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };
  for (const [key, s] of appleSubs) {
    const prior = rows.get(key);
    const calls = applyCalls({ label: s.label, call: (prior?.call ?? null) as never, tag: (prior?.tag ?? null) as never, proposed_call: (prior?.proposed_call ?? null) as never, note: prior?.note ?? null }, standing, proposals);
    upserts.push({
      user_id: userId, key, label: s.label, category: "Subscriptions and phone", source: "apple", cadence: perYear[s.period] ? s.period : "irregular",
      amount: s.amount, per_year: s.amount !== null && perYear[s.period] ? Math.round(s.amount * perYear[s.period] * 100) / 100 : null,
      last_charge: s.last, next_due: s.renews, call: calls.call, tag: calls.tag, proposed_call: calls.proposed_call, note: calls.note,
      updated_at: new Date().toISOString(),
    });
  }
  if (upserts.length) {
    const { error } = await db.from("nx_recurring").upsert(upserts, { onConflict: "user_id,key" });
    if (error) throw new Error(error.message);
  }
  m.recurring = upserts.length;

  // Cancel follow-up: charges per key from the lines and the Apple receipts.
  const charges = new Map<string, string[]>();
  for (const l of lines) {
    if (l.amount >= 0 || !l.merchant) continue;
    const k = `${squash(l.merchant)}|${Math.round(-l.amount)}`;
    charges.set(k, [...(charges.get(k) ?? []), l.booked_on]);
  }
  for (const r of receipts.filter((x) => x.kind === "apple")) {
    for (const it of r.items) {
      const k = `apple:${squash(it.name)}`;
      charges.set(k, [...(charges.get(k) ?? []), r.order_date ?? r.received_at.slice(0, 10)]);
    }
  }
  const { data: open } = await db.from("nx_recurring").select("id, key, label, status, decided_at, next_due, call")
    .eq("user_id", userId).eq("call", "cancel").in("status", ["requested", "confirmed"]);
  const updates = cancelUpdates((open ?? []) as never, charges, today(), need(cfg, "spend.match_window_days"));
  for (const u of updates) {
    await db.from("nx_recurring").update({ status: u.status, updated_at: new Date().toISOString() }).eq("id", u.id);
    if (u.status === "charged_after_cancel") {
      const row = (open ?? []).find((r) => r.id === u.id)!;
      await db.from("nx_alerts").upsert({
        user_id: userId, kind: "charged_after_cancel", ref: `${u.id}:${u.charged_on}`, title: `Charged after you cancelled: ${row.label}`,
        detail: `Charged on ${u.charged_on}. A SEPA direct debit can be reversed at your bank within 8 weeks; Apple refunds go through Report a Problem; an Amex charge through a dispute in the Amex app.`,
      }, { onConflict: "user_id,kind,ref", ignoreDuplicates: true });
    }
  }
  m.cancel_updates = updates.length;
}

async function stopList(db: SupabaseClient, cfg: AppConfig, userId: string, lines: SpendLine[], receipts: ReceiptRow[], m: Record<string, number>) {
  const c = {
    lists: stopLists(cfg),
    appleLinePattern: text(cfg, "stop.apple_line_pattern"), appleFrom: cfg["stop.apple_from"] || null,
    appleAllowed: list<string[]>(cfg, "stop.apple_allowed"),
  };
  const alerts = stopAlerts({ lines, receipts: receipts.map((r) => ({ id: r.id, kind: r.kind, order_date: r.order_date, txn_id: r.txn_id, items: r.items })) }, c);
  if (!alerts.length) return;
  const { error } = await db.from("nx_alerts").upsert(
    alerts.map((a) => ({ user_id: userId, kind: a.kind, ref: a.ref, title: a.title, detail: a.detail, txn_id: a.txn_id })),
    { onConflict: "user_id,kind,ref", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
  m.stop_alerts = alerts.length;
}

async function loadLines(db: SupabaseClient, cfg: AppConfig, userId: string): Promise<(SpendLine & { class: string })[]> {
  const months = need(cfg, "recurring.lookback_months");
  const since = new Date(Date.now() - months * 30.44 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<SpendLine & { class: string }>((a, b) => db.from("nx_transactions")
    .select("id, booked_on, amount, currency, merchant, rail, category, class")
    .eq("user_id", userId).gte("booked_on", since).order("booked_on").order("id").range(a, b));
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** One user's run: mail, matching, review and the stop list. A failing stage is recorded and the rest still run. */
async function daily(db: SupabaseClient, base: AppConfig, userId: string): Promise<Record<string, unknown>> {
  const cfg = await userCfg(db, base, userId);
  const m: Record<string, number> = {};
  const errors: string[] = [];
  const stage = async (name: string, f: () => Promise<unknown>) => {
    try { await f(); } catch (e) { errors.push(`${name}: ${(e as Error).message}`); }
  };
  let rd: Reader | null = null;
  await stage("mail", () => readMail(db, cfg, userId, async () => (rd ??= await reader(db)), m));
  const lines = await loadLines(db, cfg, userId);
  let receipts: ReceiptRow[] = [];
  await stage("match", async () => { receipts = await matchAll(db, cfg, userId, lines, m); });
  await stage("review", () => review(db, cfg, userId, lines, receipts, m));
  await stage("stop", () => stopList(db, cfg, userId, lines, receipts, m));
  return { metrics: m, errors };
}

// ------------------------------------------------------------ close ---------

async function driveFolder(token: string, cfg: AppConfig, name: string, parent: string | null): Promise<string> {
  const base = text(cfg, "integrations.drive_api_base");
  const h = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const q = [`name = '${name.replace(/'/g, "\\'")}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false", parent ? `'${parent}' in parents` : null].filter(Boolean).join(" and ");
  const found = await fetch(`${base}/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: h });
  if (!found.ok) throw new Error(`Drive search failed: ${found.status}`);
  const hit = (await found.json()).files?.[0]?.id as string | undefined;
  if (hit) return hit;
  const made = await fetch(`${base}/files?fields=id`, { method: "POST", headers: h, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) }) });
  if (!made.ok) throw new Error(`Drive folder failed: ${made.status}`);
  return (await made.json()).id as string;
}

async function driveUpload(token: string, cfg: AppConfig, folder: string, name: string, type: string, bytes: Uint8Array): Promise<void> {
  const boundary = `nexus${crypto.randomUUID()}`;
  const head = new TextEncoder().encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder] })}\r\n--${boundary}\r\ncontent-type: ${type}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const res = await fetch(`${text(cfg, "integrations.drive_upload_base")}/files?uploadType=multipart&fields=id`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function closeMonth(db: SupabaseClient, cfg: AppConfig, userId: string, month: string): Promise<Record<string, unknown>> {
  if (!/^\d{4}-\d{2}-01$/.test(month)) throw new Error("month must be YYYY-MM-01");
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const { data: costs } = await db.from("expenses").select("amount, amount_eur, business_use_pct, evidence_path")
    .eq("user_id", userId).neq("status", "rejected").in("treatment", ["fully_deductible", "limited_deductible", "asset"]).gte("date", month).lt("date", end);
  const value = (e: { amount: number; amount_eur: number | null; business_use_pct: number | null }) => Number(e.amount_eur ?? e.amount) * Number(e.business_use_pct ?? 1);
  const all_ = (costs ?? []).reduce((s, e) => s + value(e), 0);
  const withDoc = (costs ?? []).filter((e) => e.evidence_path).reduce((s, e) => s + value(e), 0);
  const lines = await all<{ id: string; booked_on: string; amount: number; currency: string; merchant: string | null; category: string; class: string; review_status: string }>(
    (a, b) => db.from("nx_transactions").select("id, booked_on, amount, currency, merchant, category, class, review_status")
      .eq("user_id", userId).gte("booked_on", month).lt("booked_on", end).order("booked_on").order("id").range(a, b));
  const open = lines.filter((l) => l.review_status === "needs_review" || l.category === "Uncategorised").length;
  const food = [text(cfg, "food.staples_category"), text(cfg, "food.luxury_category")];
  const { data: rcpt } = await db.from("nx_receipts").select("txn_id").eq("user_id", userId).not("txn_id", "is", null);
  const explained = new Set((rcpt ?? []).map((r) => r.txn_id as string));
  const foodLines = lines.filter((l) => food.includes(l.category) && l.amount < 0);
  const { data: vat } = await db.from("tax_filings").select("period_label, status, figures").eq("user_id", userId)
    .eq("kind", text(cfg, "close.vat_kind")).eq("status", "approved").lte("figures->>period_start", month).gte("figures->>period_end", month)
    .order("created_at", { ascending: false }).limit(1);
  const figures = {
    month,
    business_costs_eur: Math.round(all_ * 100) / 100,
    business_costs_with_invoice_eur: Math.round(withDoc * 100) / 100,
    invoice_coverage_pct: all_ > 0 ? Math.round((withDoc / all_) * 1000) / 10 : null,
    lines: lines.length,
    lines_open: open,
    food_lines: foodLines.length,
    food_lines_with_receipt: foodLines.filter((l) => explained.has(l.id)).length,
    vat: vat?.[0] ? { period: vat[0].period_label, payable: (vat[0].figures as Record<string, unknown>).payable_5g ?? null } : null,
  };

  // Archive: the month's lines as a CSV and every receipt photo of the month, in Drive.
  let archive: Record<string, unknown> | null = null;
  const auth = await mailToken(db, cfg, userId);
  if (auth) {
    const { data: conn } = await db.from("integration_connections").select("settings").eq("user_id", userId).eq("provider", "gmail").single();
    const settings = (conn?.settings ?? {}) as Record<string, unknown>;
    let root = typeof settings.archive_folder_id === "string" ? settings.archive_folder_id : null;
    if (!root) {
      root = await driveFolder(auth.token, cfg, text(cfg, "close.drive_root_name"), null);
      await markConnection(db, userId, "gmail", { settings: { ...settings, archive_folder_id: root } });
    }
    let folder = root;
    for (const part of text(cfg, "close.drive_subpath").replace("{year}", month.slice(0, 4)).replace("{month}", month.slice(5, 7)).split("/").filter(Boolean)) {
      folder = await driveFolder(auth.token, cfg, part, folder);
    }
    const csv = ["date,amount,currency,shop,category,class", ...lines.map((l) =>
      [l.booked_on, l.amount, l.currency, `"${(l.merchant ?? "").replace(/"/g, '""')}"`, `"${l.category.replace(/"/g, '""')}"`, l.class].join(","))].join("\n");
    await driveUpload(auth.token, cfg, folder, `lines-${month.slice(0, 7)}.csv`, "text/csv", new TextEncoder().encode(csv));
    const bucket = text(cfg, "storage.documents_bucket");
    const { data: inMonth } = await db.from("nx_receipts").select("external_id").eq("user_id", userId).eq("source", "photo")
      .gte("order_date", month).lt("order_date", end);
    let files = 1;
    for (const p of (inMonth ?? []).map((r) => r.external_id as string)) {
      const dl = await db.storage.from(bucket).download(p);
      if (dl.error || !dl.data) continue;
      await driveUpload(auth.token, cfg, folder, p.split("/").pop()!, dl.data.type || "image/jpeg", new Uint8Array(await dl.data.arrayBuffer()));
      files++;
    }
    archive = { folder_id: folder, files };
  }
  const { error } = await db.from("nx_month_closes").upsert({ user_id: userId, month, figures, archive, closed_at: new Date().toISOString() }, { onConflict: "user_id,month" });
  if (error) throw new Error(error.message);
  return { figures, archive };
}

// ------------------------------------------------------------ handler -------

const googleReady = () => !!Deno.env.get("GOOGLE_CLIENT_ID") && !!Deno.env.get("GOOGLE_CLIENT_SECRET");

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const cfg = await loadConfig(db);

    if (who.kind === "service") {
      if (body.mode !== "daily") return json({ error: "unknown mode" }, 400);
      const { data: users } = await db.from("nx_category_rules").select("user_id");
      const out: Record<string, unknown> = {};
      for (const u of [...new Set((users ?? []).map((x) => x.user_id as string))]) out[u.slice(0, 8)] = await daily(db, cfg, u);
      return json({ ok: true, users: out });
    }

    const userId = who.id;
    const mine = await userCfg(db, cfg, userId);
    switch (body.action) {
      case "status": {
        const conn = (await connections(db, userId)).get("gmail");
        return json({
          google_ready: googleReady(),
          connected: conn?.status === "active",
          status: conn?.status ?? "not_connected",
          account: conn?.account_label ?? null,
          last_error: conn?.last_error ?? null,
          last_read_at: (conn?.cursor?.mail_read_at as string | undefined) ?? null,
          redirect_url: redirectUri(),
        });
      }
      case "google_start": {
        if (!googleReady()) return json({ error: "Google sign-in is not set up on the server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)" }, 409);
        const u = new URL(text(cfg, "integrations.google_auth_url"));
        u.search = new URLSearchParams({
          client_id: requireEnv("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
          scope: text(cfg, "spend.google_scopes"), access_type: "offline", prompt: "consent",
          state: await signState(db, userId, "gmail", "app"),
        }).toString();
        return json({ url: u.toString() });
      }
      case "google_finish": {
        if (!(await claimState(db, String(body.state ?? ""), userId, "gmail"))) {
          return json({ error: "this link was not started by you, has expired or was already used; start again" }, 403);
        }
        const res = await fetch(text(cfg, "integrations.google_token_url"), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: String(body.code ?? ""), client_id: requireEnv("GOOGLE_CLIENT_ID"), client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
            redirect_uri: redirectUri(), grant_type: "authorization_code",
          }),
        });
        const tok = await res.json();
        if (!res.ok || !tok.refresh_token) return json({ error: "Google did not return a refresh token; try again" }, 400);
        const profile = await fetch(`${text(cfg, "integrations.gmail_api_base")}/users/me/profile`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const email = profile.ok ? String((await profile.json()).emailAddress ?? "") : "";
        const { data: existing } = await db.from("integration_connections").select("settings").eq("user_id", userId).eq("provider", "gmail").maybeSingle();
        await saveConnection(db, userId, "gmail", tok.refresh_token, { account_label: email || "Gmail", scopes: String(tok.scope ?? "").split(" "), settings: existing?.settings ?? {}, cursor: {} });
        return json({ ok: true, account: email });
      }
      case "disconnect": {
        await markConnection(db, userId, "gmail", { status: "revoked" });
        return json({ ok: true });
      }
      case "run":
        return json(await daily(db, cfg, userId));
      case "receipt_photo": {
        const path = String(body.path ?? "");
        if (!path.startsWith(`${userId}/`)) return json({ error: "that file is not yours" }, 403);
        const dl = await db.storage.from(text(cfg, "storage.documents_bucket")).download(path);
        if (dl.error || !dl.data) return json({ error: "the photo did not arrive; try again" }, 404);
        const bytes = new Uint8Array(await dl.data.arrayBuffer());
        let b64 = "";
        for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const reading = await read(await reader(db), list<string[]>(mine, "food.staples"), [
          { type: "image", source: { type: "base64", media_type: dl.data.type || "image/jpeg", data: btoa(b64) } },
        ]);
        const { error } = await db.from("nx_receipts").upsert({
          user_id: userId, source: "photo", external_id: path, received_at: new Date().toISOString(),
          kind: reading.kind === "apple" ? "other" : reading.kind, merchant: reading.merchant, total: reading.total, currency: reading.currency,
          order_date: reading.date ?? today(), items: reading.items, match_status: reading.kind === "other" ? "ignored" : "unmatched",
        }, { onConflict: "user_id,source,external_id" });
        if (error) throw new Error(error.message);
        const m: Record<string, number> = {};
        const lines = await loadLines(db, mine, userId);
        await matchAll(db, mine, userId, lines, m);
        return json({ ok: true, reading, metrics: m });
      }
      case "close_month":
        return json({ ok: true, ...(await closeMonth(db, mine, userId, String(body.month ?? ""))) });
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

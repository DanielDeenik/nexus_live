// moneybird: the link between Nexus and the books.
//
// POST { mode: "sync" }   the scheduler: everyone with Moneybird connected; signed in: yourself
// POST { mode: "push_sales", user_id, invoice_numbers }   scheduler only: the named Nexus invoices
//      go into Moneybird as external sales invoices with their document, using the client, VAT
//      rate and revenue account of an invoice already in the books; then a sync pairs them
//
// Reads receipts, purchase invoices and sales invoices (only documents whose
// version changed), keeps a mirror in nx_moneybird_documents, marks the cost
// line each receipt proves (expenses.evidence_path = moneybird:<kind>:<id>;
// an invoice paid in instalments proves each debit of its period)
// and pairs sales invoices with Nexus invoices by number. Read only towards
// Moneybird. Tolerances, window, start date and pace come from app_config.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize } from "../_shared/client.ts";
import { type AppConfig, loadConfig, need } from "../_shared/config.ts";
import { type Connection, connections, markConnection, readSecret } from "../_shared/connect.ts";
import { json, preflight } from "../_shared/cors.ts";
import { eurRate } from "../_shared/fx.ts";
import { changedDocs, type CostLine, externalSalesInvoice, linkSalesInvoices, matchEvidence, matchInstalments, type MbDoc, type MbKind, mbClient, type SalesTemplate, toEuro } from "../_shared/moneybird.ts";

const KINDS: MbKind[] = ["receipt", "purchase_invoice", "sales_invoice"];
const DOC_COLS = "id, kind, version, doc_date, reference, contact, currency, total_incl, total_incl_eur, total_excl_eur, state, paid_at, attachments, expense_id, invoice_id";

function setting(cfg: AppConfig, key: string): string {
  const v = cfg[key];
  if (!v) throw new Error(`app_config ${key} is missing`);
  return v;
}

const evidenceOf = (kind: MbKind, id: string) => `moneybird:${kind}:${id}`;

export async function syncUser(db: SupabaseClient, cfg: AppConfig, userId: string, conn: Connection): Promise<Record<string, unknown>> {
  const token = await readSecret(db, conn);
  if (!token) return { skipped: "not connected" };
  const adminId = String((conn.settings as Record<string, unknown> | null)?.administration_id ?? "");
  if (!adminId) throw new Error("no Moneybird administration chosen; connect again");
  const client = mbClient(setting(cfg, "integrations.moneybird.api_base"), token, need(cfg, "api.moneybird_requests_per_minute"));
  const now = new Date().toISOString();

  const have = await db.from("nx_moneybird_documents").select("id, kind, version").eq("user_id", userId);
  if (have.error) throw new Error(have.error.message);
  let fetched = 0, removed = 0;
  for (const kind of KINDS) {
    const known = new Map((have.data ?? []).filter((d) => d.kind === kind).map((d) => [d.id as string, Number(d.version)]));
    const { docs, ids } = await changedDocs(client, adminId, kind, known);
    if (docs.length) {
      const rows = docs.map((d) => ({
        user_id: userId, administration_id: adminId, kind: d.kind, id: d.id, version: d.version, doc_date: d.date, reference: d.reference,
        contact: d.contact, currency: d.currency, total_incl: d.total_incl, total_incl_eur: d.total_incl_eur, total_excl_eur: d.total_excl_eur,
        state: d.state, paid_at: d.paid_at, attachments: d.attachments, synced_at: now,
      }));
      const up = await db.from("nx_moneybird_documents").upsert(rows, { onConflict: "user_id,kind,id" });
      if (up.error) throw new Error(up.error.message);
      fetched += docs.length;
    }
    // Documents deleted in Moneybird no longer prove anything.
    const gone = [...known.keys()].filter((id) => !ids.has(id));
    for (const id of gone) {
      await db.from("expenses").update({ evidence_path: null, updated_at: now }).eq("user_id", userId).eq("evidence_path", evidenceOf(kind, id));
      await db.from("nx_moneybird_documents").delete().eq("user_id", userId).eq("kind", kind).eq("id", id);
    }
    removed += gone.length;
  }

  // Receipts and purchase invoices prove cost lines.
  const all = await db.from("nx_moneybird_documents").select(DOC_COLS).eq("user_id", userId);
  if (all.error) throw new Error(all.error.message);
  const docs: (MbDoc & { expense_id: string | null; invoice_id: string | null })[] = (all.data ?? []).map((r) => ({
    id: r.id, kind: r.kind, version: Number(r.version), date: r.doc_date, reference: r.reference, contact: r.contact, currency: r.currency,
    total_incl: r.total_incl == null ? null : Number(r.total_incl), total_incl_eur: r.total_incl_eur == null ? null : Number(r.total_incl_eur),
    total_excl_eur: r.total_excl_eur == null ? null : Number(r.total_excl_eur), state: r.state, paid_at: r.paid_at, attachments: r.attachments,
    expense_id: r.expense_id, invoice_id: r.invoice_id,
  }));
  const since = setting(cfg, "moneybird.sync_from");
  const costs = await db.from("expenses").select("id, date, amount, currency, vendor, description, evidence_path")
    .eq("user_id", userId).gte("date", since).neq("status", "rejected").is("evidence_path", null);
  if (costs.error) throw new Error(costs.error.message);
  const lines: CostLine[] = (costs.data ?? []).map((c) => ({ ...c, amount: Number(c.amount), currency: c.currency ?? "EUR" }) as CostLine);
  // Documents in another currency are compared in euros at the ECB rate of their date.
  const rates = new Map<string, number | null>();
  for (const d of docs) {
    if (d.currency === "EUR" || !d.date || rates.has(`${d.currency}|${d.date}`)) continue;
    const r = await eurRate(db, setting(cfg, "integrations.fx_api_base"), d.currency, d.date);
    rates.set(`${d.currency}|${d.date}`, r?.rate ?? null);
  }
  const inEuro = toEuro(docs, (cur, day) => rates.get(`${cur}|${day}`) ?? null);
  let aliases: Record<string, string> = {};
  try { aliases = JSON.parse(cfg["moneybird.shop_aliases"] ?? "{}"); } catch { /* none */ }
  const matches = matchEvidence(inEuro, lines, {
    toleranceEur: need(cfg, "expense_agent.amount_tolerance_eur"),
    tolerancePct: need(cfg, "moneybird.fx_tolerance_pct"),
    windowDays: need(cfg, "moneybird.match_window_days"),
    linkedDocIds: new Set(docs.filter((d) => d.expense_id).map((d) => d.id)),
    aliases,
  });
  // An invoice paid in instalments (insurance billed for the year, debited monthly) proves each
  // debit of that shop in its period; what it already proves counts against its total.
  const proven = await db.from("expenses").select("amount, evidence_path").eq("user_id", userId).like("evidence_path", `${evidenceOf("purchase_invoice", "")}%`);
  if (proven.error) throw new Error(proven.error.message);
  const linked = new Map<string, { count: number; sum: number }>();
  for (const p of proven.data ?? []) {
    const id = String(p.evidence_path).slice(evidenceOf("purchase_invoice", "").length);
    const l = linked.get(id) ?? { count: 0, sum: 0 };
    linked.set(id, { count: l.count + 1, sum: Math.round((l.sum + Math.abs(Number(p.amount))) * 100) / 100 });
  }
  const instalments = matchInstalments(inEuro, lines, {
    toleranceEur: need(cfg, "expense_agent.amount_tolerance_eur"),
    periodDays: need(cfg, "moneybird.instalment_period_days"),
    windowDays: need(cfg, "moneybird.match_window_days"),
    minLines: need(cfg, "moneybird.instalment_min_lines"),
    linked,
    taken: new Set(matches.keys()),
    aliases,
  });
  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const [costId, docId] of [...matches, ...instalments]) {
    const d = byId.get(docId)!;
    const ex = await db.from("expenses").update({ evidence_path: evidenceOf(d.kind, d.id), updated_at: now })
      .eq("id", costId).eq("user_id", userId).is("evidence_path", null).select("id, invoice_number").maybeSingle();
    if (ex.error) throw new Error(ex.error.message);
    if (!ex.data) continue;
    if (!ex.data.invoice_number && d.reference) await db.from("expenses").update({ invoice_number: d.reference }).eq("id", costId);
    await db.from("nx_moneybird_documents").update({ expense_id: costId }).eq("user_id", userId).eq("kind", d.kind).eq("id", d.id).is("expense_id", null);
  }

  // Sales invoices pair with the invoices Nexus already holds.
  const inv = await db.from("invoices").select("id, invoice_number, amount, currency, issued_date").eq("user_id", userId).is("voided_at", null);
  if (inv.error) throw new Error(inv.error.message);
  const pairedIds = new Set(docs.filter((d) => d.invoice_id).map((d) => d.invoice_id as string));
  const sales = linkSalesInvoices(docs.filter((d) => !d.invoice_id), (inv.data ?? []).filter((i) => !pairedIds.has(i.id)).map((i) => ({ ...i, amount: Number(i.amount) })),
    need(cfg, "moneybird.match_window_days"));
  for (const [docId, invoiceId] of sales) {
    await db.from("nx_moneybird_documents").update({ invoice_id: invoiceId }).eq("user_id", userId).eq("kind", "sales_invoice").eq("id", docId);
  }

  await markConnection(db, userId, "moneybird", { status: "active", last_error: null, cursor: { synced_at: now, documents: docs.length } });
  return { fetched, removed, documents: docs.length, matched: matches.size, instalments: instalments.size, sales_linked: sales.size };
}

type Detail = { tax_rate_id?: string | number | null; ledger_account_id?: string | number | null };

/** Book the named Nexus invoices in Moneybird. Each call names its invoices; nothing else is written. */
export async function pushSales(db: SupabaseClient, cfg: AppConfig, userId: string, numbers: string[]): Promise<Record<string, unknown>> {
  const conn = (await connections(db, userId)).get("moneybird");
  const token = await readSecret(db, conn);
  if (!conn || !token) throw new Error("Moneybird is not connected");
  const adminId = String((conn.settings as Record<string, unknown> | null)?.administration_id ?? "");
  const client = mbClient(setting(cfg, "integrations.moneybird.api_base"), token, need(cfg, "api.moneybird_requests_per_minute"));

  // The template: an invoice to the same client already in the books.
  const paired = await db.from("nx_moneybird_documents").select("id, invoice_id").eq("user_id", userId).eq("kind", "sales_invoice").not("invoice_id", "is", null).limit(1);
  if (paired.error) throw new Error(paired.error.message);
  if (!paired.data?.length) throw new Error("no sales invoice in Moneybird is paired with Nexus yet; run a sync first");
  let src: { contact_id: string | number; details: Detail[] };
  try {
    src = await client.get(`/${adminId}/sales_invoices/${paired.data[0].id}.json`);
  } catch {
    src = await client.get(`/${adminId}/external_sales_invoices/${paired.data[0].id}.json`);
  }
  const t: SalesTemplate = {
    contact_id: String(src.contact_id),
    tax_rate_id: src.details?.[0]?.tax_rate_id == null ? null : String(src.details[0].tax_rate_id),
    ledger_account_id: src.details?.[0]?.ledger_account_id == null ? null : String(src.details[0].ledger_account_id),
  };

  const have = await db.from("nx_moneybird_documents").select("invoice_id").eq("user_id", userId).not("invoice_id", "is", null);
  const inBooks = new Set((have.data ?? []).map((r) => r.invoice_id as string));
  const out: Record<string, unknown>[] = [];
  for (const number of numbers) {
    const { data: inv, error } = await db.from("invoices")
      .select("id, invoice_number, issued_date, due_date, currency, amount, hours, unit_rate, description, period_start, period_end, document_path")
      .eq("user_id", userId).eq("invoice_number", number).is("voided_at", null).maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) { out.push({ invoice: number, skipped: "not in Nexus or voided" }); continue; }
    if (inBooks.has(inv.id)) { out.push({ invoice: number, skipped: "already in Moneybird" }); continue; }
    const payload = externalSalesInvoice({ ...inv, amount: Number(inv.amount), hours: inv.hours == null ? null : Number(inv.hours), unit_rate: inv.unit_rate == null ? null : Number(inv.unit_rate) }, t);
    const created = await client.post<{ id: string | number }>(`/${adminId}/external_sales_invoices.json`, payload);
    let attached: string | null = null;
    if (inv.document_path) {
      const bucket = setting(cfg, "storage.documents_bucket");
      const dl = await db.storage.from(bucket).download(inv.document_path);
      const mime = dl.data?.type ?? "";
      if (dl.data && (mime === "application/pdf" || mime.startsWith("image/"))) {
        const name = inv.document_path.split("/").pop() ?? `${number}`;
        await client.upload(`/${adminId}/external_sales_invoices/${created.id}/attachment.json`, name, new Uint8Array(await dl.data.arrayBuffer()), mime);
        attached = name;
      } else {
        attached = `not attached (${mime || "missing"})`;
      }
    }
    out.push({ invoice: number, moneybird_id: String(created.id), attached });
  }
  const sync = await syncUser(db, cfg, userId, (await connections(db, userId)).get("moneybird")!);
  return { results: out, sync };
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const cfg = await loadConfig(db);
    if (body.mode === "push_sales") {
      if (who.kind !== "service") return json({ error: "push_sales runs only from the server" }, 403);
      const numbers = Array.isArray(body.invoice_numbers) ? body.invoice_numbers.map(String) : [];
      if (typeof body.user_id !== "string" || !numbers.length) return json({ error: "user_id and invoice_numbers are required" }, 400);
      return json({ ok: true, ...(await pushSales(db, cfg, body.user_id, numbers)) });
    }
    if ((body.mode ?? "sync") !== "sync") return json({ error: "unknown mode" }, 400);
    let users: string[];
    if (who.kind === "service") {
      const { data, error } = await db.from("integration_connections").select("user_id").eq("provider", "moneybird").neq("status", "revoked");
      if (error) throw new Error(error.message);
      users = (data ?? []).map((r) => r.user_id as string);
    } else {
      users = [who.id];
    }
    const out: Record<string, unknown>[] = [];
    for (const userId of users) {
      const conn = (await connections(db, userId)).get("moneybird");
      if (!conn || conn.status === "revoked") { out.push({ user: userId.slice(0, 8), skipped: "not connected" }); continue; }
      try {
        out.push({ user: userId.slice(0, 8), ...(await syncUser(db, cfg, userId, conn)) });
      } catch (e) {
        await markConnection(db, userId, "moneybird", { status: "error", last_error: (e as Error).message });
        out.push({ user: userId.slice(0, 8), error: (e as Error).message });
      }
    }
    return json({ ok: true, users: out });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

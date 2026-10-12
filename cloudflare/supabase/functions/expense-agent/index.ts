// expense-agent: collects receipts, extracts and classifies them with the
// model, runs the deterministic gate, and either books the expense or opens a
// review item. Also ingests uploaded sales invoices into the income ledger.
//
// POST {}                                  cron: every user with a connection
// POST { mode: "collect" }                 the signed-in user, all sources
// POST { mode: "upload", path, kind }      one uploaded file in receipts/
//        kind: "receipt" | "sales_invoice"
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize } from "../_shared/client.ts";
import { loadConfig, need, type AppConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { eurRate } from "../_shared/fx.ts";
import { callStructured, type ContentBlock, type LlmParams } from "../_shared/llm.ts";
import { AgentRun, openReview, sha256Hex, toBase64, type Trigger } from "../_shared/harness.ts";
import { Annotation, END, START, StateGraph } from "npm:@langchain/langgraph@1.4.17";
import {
  type CollectedDoc, type Connection, collectDrive, collectGmail, collectWise, googleAccessToken,
} from "../_shared/collectors.ts";
import {
  EU_COUNTRIES, type ExpenseProposal, type FiscalParams, type GateConfig, type ParamRow, type Treatment,
  REASON_TEXT, detectDuplicates, gate, paramsFromRows, round2,
} from "../_shared/fiscal/index.ts";

// --------------------------------------------------------------- schemas ----

const TREATMENTS: Treatment[] = ["fully_deductible", "limited_deductible", "asset", "private", "unknown"];

function receiptTool(categories: string[]) {
  return {
    name: "record_expense",
    description: "Record what the document says and how it should be treated for Dutch income tax.",
    input_schema: {
      type: "object",
      required: ["is_business_document", "vendor", "date", "currency", "total", "treatment", "category", "business_use_pct", "confidence", "rationale"],
      properties: {
        is_business_document: { type: "boolean", description: "False for marketing mail, private purchases, order confirmations without amounts." },
        vendor: { type: ["string", "null"] },
        vendor_country: { type: ["string", "null"], description: "ISO 3166-1 alpha-2 of the seller, from the document." },
        invoice_number: { type: ["string", "null"] },
        date: { type: ["string", "null"], description: "Invoice date, YYYY-MM-DD." },
        currency: { type: ["string", "null"], description: "ISO 4217." },
        total: { type: ["number", "null"], description: "Amount paid including VAT." },
        amount_excl_vat: { type: ["number", "null"] },
        vat_amount: { type: ["number", "null"] },
        vat_rate: { type: ["number", "null"], description: "As a fraction, e.g. 0.21." },
        vat_shown_on_document: { type: "boolean" },
        description: { type: "string", description: "Short line naming what was bought." },
        category: { type: "string", enum: categories },
        treatment: { type: "string", enum: TREATMENTS },
        business_use_pct: { type: "number", minimum: 0, maximum: 1, description: "1 unless the item is plainly also for private use." },
        asset_class: { type: ["string", "null"], enum: ["computer", "furniture", "phone", "other", null] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string" },
      },
    },
  };
}

const salesInvoiceTool = {
  name: "record_sales_invoice",
  description: "Record an invoice the owner issued to a client.",
  input_schema: {
    type: "object",
    required: ["invoice_number", "issued_date", "client", "currency", "amount", "confidence"],
    properties: {
      invoice_number: { type: "string" },
      issued_date: { type: "string" },
      due_date: { type: ["string", "null"] },
      client: { type: "string" },
      client_country: { type: ["string", "null"], description: "ISO alpha-2 of the billed party." },
      client_region: { type: ["string", "null"], description: "Province or state code, e.g. ON, BC." },
      currency: { type: "string" },
      amount: { type: "number", description: "Total excluding VAT." },
      vat_amount: { type: ["number", "null"] },
      hours: { type: ["number", "null"] },
      unit_rate: { type: ["number", "null"] },
      period_start: { type: ["string", "null"], description: "Service period start if stated, else null." },
      period_end: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

interface ReceiptOut {
  is_business_document: boolean; vendor: string | null; vendor_country?: string | null; invoice_number?: string | null;
  date: string | null; currency: string | null; total: number | null; amount_excl_vat?: number | null; vat_amount?: number | null;
  vat_rate?: number | null; vat_shown_on_document?: boolean; description?: string; category: string; treatment: Treatment;
  business_use_pct: number; asset_class?: string | null; confidence: number; rationale: string;
}

/** Deterministic validation of model output: the harness never trusts shape. */
function validReceipt(o: unknown, categories: string[]): o is ReceiptOut {
  const r = o as ReceiptOut;
  const n = (v: unknown) => v === null || v === undefined || typeof v === "number";
  return !!r && typeof r.is_business_document === "boolean" && TREATMENTS.includes(r.treatment) &&
    categories.includes(r.category) && typeof r.business_use_pct === "number" && r.business_use_pct >= 0 &&
    r.business_use_pct <= 1 && typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 &&
    n(r.total) && n(r.amount_excl_vat) && n(r.vat_amount) &&
    (r.date === null || /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? ""));
}

// ---------------------------------------------------------------- helpers ---

const vendorKey = (v: string | null) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
const extOf = (mediaType: string) => ({ "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mediaType] ?? "bin";

interface Ctx {
  db: SupabaseClient;
  cfg: AppConfig;
  params: Map<number, FiscalParams>;
  llm: LlmParams;
  system: string;
  categories: string[];
  gateCfg: GateConfig;
}

async function loadCtx(db: SupabaseClient): Promise<Ctx> {
  const cfg = await loadConfig(db);
  const { data: rows, error } = await db.from("tax_parameters").select("year, key, value, verified");
  if (error) throw new Error(`tax_parameters: ${error.message}`);
  const params = new Map<number, FiscalParams>();
  for (const y of new Set((rows ?? []).map((r) => r.year as number))) params.set(y, paramsFromRows(rows as ParamRow[], y));
  const { data: agent, error: aErr } = await db.from("agent_configs")
    .select("system_prompt, llm_provider, llm_model, max_tokens, temperature, enabled").eq("agent_id", "expense").single();
  if (aErr || !agent) throw new Error("expense agent config missing");
  if (!agent.enabled) throw new Error("expense agent is disabled in agent_configs");
  const categories = requireList(cfg, "expense_agent.categories");
  return {
    db, cfg, params, categories,
    llm: { provider: agent.llm_provider, model: agent.llm_model, maxTokens: agent.max_tokens, temperature: Number(agent.temperature) },
    system: agent.system_prompt,
    gateCfg: {
      autoBookMinConfidence: need(cfg, "expense_agent.auto_book_min_confidence"),
      autoBookMaxAmountEur: need(cfg, "expense_agent.auto_book_max_amount_eur"),
      amountToleranceEur: need(cfg, "expense_agent.amount_tolerance_eur"),
      reviewCategories: requireList(cfg, "expense_agent.review_categories"),
    },
  };
}

function requireList(cfg: AppConfig, key: string): string[] {
  const v = JSON.parse(cfg[key] ?? "[]");
  if (!Array.isArray(v) || !v.length) throw new Error(`app_config ${key} missing or empty`);
  return v;
}

type VendorRule = { treatment: Treatment; category: string; business_use_pct: number };
async function vendorRules(db: SupabaseClient, userId: string): Promise<Map<string, VendorRule>> {
  const { data } = await db.from("agent_knowledge_graph").select("context_json, output_json")
    .eq("agent_id", "expense").eq("user_id", userId).eq("entry_type", "rule").is("superseded_by", null);
  const m = new Map<string, VendorRule>();
  for (const r of data ?? []) if (r.context_json?.vendor_key) m.set(r.context_json.vendor_key, r.output_json);
  return m;
}

async function alreadyHave(db: SupabaseClient, userId: string, hash: string | null, externalId: string): Promise<boolean> {
  const byId = await db.from("expenses").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("external_txn_id", externalId);
  if (byId.error) throw new Error(`dedupe: ${byId.error.message}`);
  if ((byId.count ?? 0) > 0) return true;
  if (!hash) return false;
  const byHash = await db.from("expenses").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("evidence_hash", hash);
  if (byHash.error) throw new Error(`dedupe: ${byHash.error.message}`);
  return (byHash.count ?? 0) > 0;
}

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

/** Same purchase arriving twice with different bytes (Gmail and Drive, or an
 *  order mail plus a PDF): same vendor and invoice number, or same vendor,
 *  date and total. Sends the newcomer to review instead of booking it. */
async function possibleDuplicate(db: SupabaseClient, userId: string, o: ReceiptOut): Promise<boolean> {
  if (!o.vendor) return false;
  const base = () => db.from("expenses").select("id, vendor").eq("user_id", userId).neq("status", "rejected");
  const key = vendorKey(o.vendor);
  const same = (rows: { vendor: string | null }[] | null) => (rows ?? []).some((r) => vendorKey(r.vendor) === key);
  if (o.invoice_number) {
    const { data } = await base().eq("invoice_number", o.invoice_number);
    if (same(data)) return true;
  }
  if (o.date && o.total != null) {
    const { data } = await base().eq("date", o.date).gte("amount", o.total - 0.01).lte("amount", o.total + 0.01);
    if (same(data)) return true;
  }
  return false;
}

// --------------------------------------------------------- receipt flow ----

// The receipt pipeline as a LangGraph state graph:
//   dedupe, then either the bank payment branch or extract (one retry),
//   classify (vendor rules, FX, deterministic gate), then persist or discard.
// The model only fills the extraction; every decision after it is code.
const ReceiptState = Annotation.Root({
  hash: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  done: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  attempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  out: Annotation<ReceiptOut | null>({ reducer: (_a, b) => b, default: () => null }),
  extractionFailed: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  ruleApplied: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  date: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
  currency: Annotation<string>({ reducer: (_a, b) => b, default: () => "EUR" }),
  rate: Annotation<number | null>({ reducer: (_a, b) => b, default: () => null }),
  amountEur: Annotation<number | null>({ reducer: (_a, b) => b, default: () => null }),
  domestic: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  foreign: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  vatShown: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  route: Annotation<"book" | "review" | "discard">({ reducer: (_a, b) => b, default: () => "review" }),
  reasons: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
});
type RState = typeof ReceiptState.State;

function receiptGraph(ctx: Ctx, run: AgentRun, userId: string, doc: CollectedDoc, uploadedPath?: string) {
  const { db, cfg } = ctx;
  let rules = new Map<string, VendorRule>();
  let p: FiscalParams | undefined;

  const dedupe = async (): Promise<Partial<RState>> => {
    const hash = doc.file ? await sha256Hex(doc.file.bytes) : doc.text ? await sha256Hex(new TextEncoder().encode(doc.text)) : null;
    if (await alreadyHave(db, userId, hash, doc.external_id)) {
      run.count("duplicates");
      return { hash, done: true };
    }
    return { hash };
  };

  // Bank payments without a document: link to an existing receipt if one
  // matches, otherwise ask the owner for the evidence.
  const bankPayment = async (): Promise<Partial<RState>> => {
    const h = doc.hint!;
    const window = need(cfg, "expense_agent.bank_match_window_days");
    const { data: match } = await db.from("expenses").select("id").eq("user_id", userId).eq("currency", h.currency)
      .gte("date", addDays(h.date, -window)).lte("date", addDays(h.date, window)).gte("amount", h.amount - 0.01).lte("amount", h.amount + 0.01)
      .is("bank_txn_id", null).neq("status", "rejected").limit(1);
    if (match?.length) {
      await db.from("expenses").update({ bank_txn_id: doc.external_id, updated_at: new Date().toISOString() }).eq("id", match[0].id);
      run.count("bank_matched");
      return { done: true };
    }
    const rate = await eurRate(db, cfg["integrations.fx_api_base"], h.currency, h.date);
    const { data: ins, error } = await db.from("expenses").insert({
      user_id: userId, amount: h.amount, currency: h.currency, category: "uncategorised", description: h.vendor,
      date: h.date, source: "wise", external_txn_id: doc.external_id, bank_txn_id: doc.external_id, status: "needs_review", treatment: "unknown",
      vendor: h.vendor, fx_rate_eur: rate?.rate ?? null, amount_eur: rate ? round2(h.amount * rate.rate) : null,
      confidence: 0, rationale: "Bank payment found without a receipt.", agent_run_id: run.id,
    }).select("id").single();
    if (error) throw new Error(`insert bank expense: ${error.message}`);
    await openReview(db, {
      user_id: userId, item_type: "expense", item_id: ins.id, reason_codes: ["missing_evidence"],
      summary: `${h.vendor}: ${h.amount.toFixed(2)} ${h.currency} on ${h.date}`,
      proposed: { treatment: "unknown" }, agent_run_id: run.id,
    });
    run.count("needs_review");
    return { done: true };
  };

  const extract = async (st: RState): Promise<Partial<RState>> => {
    if (st.attempts === 0) {
      rules = await vendorRules(db, userId);
      const year = Number((doc.received_at ?? "").slice(0, 4)) || new Date().getUTCFullYear();
      p = ctx.params.get(year) ?? ctx.params.get(Math.max(...ctx.params.keys()));
      if (!p) throw new Error("no fiscal parameters loaded");
    }
    const content: ContentBlock[] = [];
    if (doc.file?.mediaType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(doc.file.bytes) } });
    } else if (doc.file) {
      content.push({ type: "image", source: { type: "base64", media_type: doc.file.mediaType, data: toBase64(doc.file.bytes) } });
    }
    content.push({
      type: "text",
      text: JSON.stringify({
        source: doc.source, title: doc.title, email_text: doc.text ?? null,
        fiscal_parameters: { year: p!.year, capitalisation_threshold_excl_vat: p!.capitalisationThreshold, limited_deductible: p!.limitedDeductible },
        owner_vendor_rules: Object.fromEntries(rules),
      }),
    });
    const res = await run.step(`extract:${doc.external_id}:${st.attempts}`, () =>
      callStructured<ReceiptOut>(ctx.llm, ctx.system, content, receiptTool(ctx.categories)), {
      tolerate: true,
      summarize: (r) => ({ tokens: r.usage }),
    });
    if (res) {
      run.count("input_tokens", res.usage.input_tokens);
      run.count("output_tokens", res.usage.output_tokens);
      if (validReceipt(res.value, ctx.categories)) return { attempts: st.attempts + 1, out: res.value };
    }
    return { attempts: st.attempts + 1 };
  };

  const classify = async (st: RState): Promise<Partial<RState>> => {
    let out = st.out;
    let extractionFailed = false;
    if (!out) {
      extractionFailed = true;
      out = { is_business_document: true, vendor: null, date: null, currency: null, total: null, category: "uncategorised",
        treatment: "unknown", business_use_pct: 1, confidence: 0, rationale: "The document could not be read reliably." };
    } else {
      out = { ...out };
    }

    // Owner-confirmed vendor rule overrides the model's judgement.
    const key = vendorKey(out.vendor);
    const rule = !extractionFailed && key ? rules.get(key) : undefined;
    if (rule) { out.treatment = rule.treatment; out.category = rule.category; out.business_use_pct = rule.business_use_pct; }

    const date = out.date ?? doc.received_at.slice(0, 10);
    const currency = out.currency ?? "EUR";
    const rate = out.total != null ? await eurRate(db, cfg["integrations.fx_api_base"], currency, date) : null;
    const amountEur = out.total != null && rate ? round2(out.total * rate.rate) : null;
    const domestic = (out.vendor_country ?? "").toUpperCase() === (cfg["locale.primary_region"] ?? "").toUpperCase();
    const foreign = !!out.vendor_country && !domestic;
    const vatShown = out.vat_shown_on_document === true && (out.vat_amount ?? 0) > 0;

    const proposal: ExpenseProposal = {
      vendor: out.vendor, date: out.date, currency: out.currency, total: out.total,
      amount_excl_vat: out.amount_excl_vat ?? null, vat_amount: out.vat_amount ?? null,
      treatment: out.treatment, category: out.category, business_use_pct: out.business_use_pct,
      confidence: out.confidence, is_business_document: out.is_business_document, vendor_rule_applied: !!rule,
    };
    const yearP = ctx.params.get(Number(date.slice(0, 4)));
    const maybeDup = !extractionFailed && await possibleDuplicate(db, userId, out);
    const decision = yearP
      ? gate(proposal, amountEur, ctx.gateCfg, yearP, false, maybeDup)
      : { route: "review" as const, reasons: ["missing_parameters" as const] };
    let route: RState["route"] = decision.route;
    const reasons: string[] = [...decision.reasons];
    // Something the owner uploaded themselves is never silently dropped.
    if (doc.source === "upload" && route === "discard") route = "review";
    if (extractionFailed && !reasons.includes("extraction_failed")) reasons.push("extraction_failed");
    if (extractionFailed) route = "review";

    run.count(`route_${route}`);
    return { out, extractionFailed, ruleApplied: !!rule, date, currency, rate: rate?.rate ?? null, amountEur, domestic, foreign, vatShown, route, reasons };
  };

  const persist = async (st: RState): Promise<Partial<RState>> => {
    const out = st.out!;
    const { date, currency, hash } = st;
    const yearP = ctx.params.get(Number(date.slice(0, 4)));

    // Keep the evidence. Uploaded files are already in the bucket.
    let evidencePath = uploadedPath ?? null;
    if (!evidencePath && doc.file && hash) {
      evidencePath = `${userId}/${date.slice(0, 4)}/${hash}.${extOf(doc.file.mediaType)}`;
      const up = await db.storage.from("receipts").upload(evidencePath, doc.file.bytes, { contentType: doc.file.mediaType, upsert: true });
      if (up.error) throw new Error(`store evidence: ${up.error.message}`);
    }

    const isAsset = st.reasons.includes("asset_threshold");
    const treatment: Treatment = isAsset ? "asset" : out.treatment;
    const status = st.route === "book" ? "booked" : "needs_review";

    // If this receipt belongs to a bank payment already waiting for evidence,
    // complete that row instead of creating a second cost.
    let bankTxnId: string | null = null;
    if (out.total != null && !st.extractionFailed) {
      const window = need(cfg, "expense_agent.bank_match_window_days");
      const { data: waiting } = await db.from("expenses").select("id, bank_txn_id").eq("user_id", userId)
        .eq("source", "wise").eq("status", "needs_review").is("evidence_path", null).eq("currency", currency)
        .gte("date", addDays(date, -window)).lte("date", addDays(date, window))
        .gte("amount", out.total - 0.01).lte("amount", out.total + 0.01).limit(1);
      if (waiting?.length) {
        bankTxnId = waiting[0].bank_txn_id;
        await db.from("review_items").update({ status: "rejected", decision: { action: "superseded_by_receipt" }, decided_at: new Date().toISOString() })
          .eq("user_id", userId).eq("item_id", waiting[0].id).eq("status", "open");
        await db.from("expenses").delete().eq("id", waiting[0].id).eq("user_id", userId).is("evidence_path", null);
        run.count("bank_payment_completed");
      }
    }

    const { data: exp, error } = await db.from("expenses").insert({
      user_id: userId, amount: out.total ?? 0, currency, category: out.category, description: out.description ?? doc.title,
      date, source: doc.source, external_txn_id: doc.external_id, bank_txn_id: bankTxnId, status, treatment,
      business_use_pct: out.business_use_pct, vendor: out.vendor, vendor_country: out.vendor_country ?? null,
      amount_excl_vat: out.amount_excl_vat ?? null, vat_amount: out.vat_amount ?? null, vat_rate: out.vat_rate ?? null,
      vat_reclaimable: st.vatShown && st.domestic, vat_reverse_charge: st.foreign && !st.vatShown && treatment !== "private",
      fx_rate_eur: st.rate, amount_eur: st.amountEur, invoice_number: out.invoice_number ?? null,
      evidence_path: evidencePath, evidence_hash: hash, confidence: out.confidence, rationale: out.rationale, agent_run_id: run.id,
    }).select("id").single();
    if (error) throw new Error(`insert expense: ${error.message}`);

    let assetId: string | null = null;
    if (isAsset && yearP && st.rate) {
      const cls = out.asset_class ?? "other";
      const excl = out.amount_excl_vat ?? out.total ?? 0;
      const { data: asset, error: aErr } = await db.from("fixed_assets").insert({
        user_id: userId, description: out.description ?? out.vendor ?? "Asset", asset_class: cls, acquired_date: date,
        cost_excl_vat: round2(excl * st.rate), useful_life_years: yearP.usefulLife[cls] ?? yearP.usefulLife.other,
        status: "needs_review",
      }).select("id").single();
      if (aErr) throw new Error(`insert asset: ${aErr.message}`);
      assetId = asset.id;
      await db.from("expenses").update({ asset_id: assetId }).eq("id", exp.id);
    }

    if (status === "needs_review") {
      await openReview(db, {
        user_id: userId, item_type: assetId ? "asset" : "expense", item_id: assetId ?? exp.id,
        reason_codes: st.reasons,
        summary: `${out.vendor ?? "Unknown vendor"}: ${(out.total ?? 0).toFixed(2)} ${currency}${out.description ? ` (${out.description})` : ""}`,
        proposed: {
          expense_id: exp.id, treatment, category: out.category, business_use_pct: out.business_use_pct,
          useful_life_years: isAsset && yearP ? yearP.usefulLife[out.asset_class ?? "other"] ?? yearP.usefulLife.other : null,
          rationale: out.rationale, reasons_text: st.reasons.map((r) => REASON_TEXT[r as keyof typeof REASON_TEXT]),
        },
        agent_run_id: run.id,
      });
    }
    return { done: true };
  };

  return new StateGraph(ReceiptState)
    .addNode("dedupe", dedupe)
    .addNode("bank_payment", bankPayment)
    .addNode("extract", extract)
    .addNode("classify", classify)
    .addNode("persist", persist)
    .addEdge(START, "dedupe")
    .addConditionalEdges("dedupe", (st) => (st.done ? END : doc.source === "wise" && doc.hint ? "bank_payment" : "extract"), [END, "bank_payment", "extract"])
    .addEdge("bank_payment", END)
    .addConditionalEdges("extract", (st) => (st.out || st.attempts >= EXTRACT_ATTEMPTS ? "classify" : "extract"), ["classify", "extract"])
    .addConditionalEdges("classify", (st) => (st.route === "discard" ? END : "persist"), [END, "persist"])
    .addEdge("persist", END)
    .compile();
}

/** One retry when the model's answer fails validation. */
const EXTRACT_ATTEMPTS = 2;

async function processReceipt(ctx: Ctx, run: AgentRun, userId: string, doc: CollectedDoc, uploadedPath?: string) {
  await receiptGraph(ctx, run, userId, doc, uploadedPath).invoke({});
}

// ---------------------------------------------------- sales invoice flow ----

interface SalesOut {
  invoice_number: string; issued_date: string; due_date?: string | null; client: string; client_country?: string | null;
  client_region?: string | null; currency: string; amount: number; vat_amount?: number | null; hours?: number | null;
  unit_rate?: number | null; period_start?: string | null; period_end?: string | null; description?: string | null; confidence: number;
}

async function processSalesInvoice(ctx: Ctx, run: AgentRun, userId: string, doc: CollectedDoc, path: string) {
  const { db, cfg } = ctx;
  const res = await run.step("extract:sales_invoice", () => callStructured<SalesOut>(ctx.llm,
    "You read an invoice the owner issued. Return exactly what is printed; null when absent. Never infer hours or periods that are not on the document.",
    [doc.file!.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(doc.file!.bytes) } }
      : { type: "image", source: { type: "base64", media_type: doc.file!.mediaType, data: toBase64(doc.file!.bytes) } }],
    salesInvoiceTool));
  const o = res!.value;
  run.count("input_tokens", res!.usage.input_tokens);
  const isDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!o || typeof o.invoice_number !== "string" || !o.invoice_number.trim() || !isDate(o.issued_date) ||
      typeof o.amount !== "number" || !(o.amount > 0) || typeof o.currency !== "string" || !/^[A-Z]{3}$/.test(o.currency) ||
      typeof o.client !== "string" || typeof o.confidence !== "number" ||
      (o.period_start != null && !isDate(o.period_start)) || (o.period_end != null && !isDate(o.period_end))) {
    throw new Error("sales invoice could not be read reliably; add it manually");
  }
  const country = (o.client_country ?? "").toUpperCase();
  const home = (cfg["locale.primary_region"] ?? "").toUpperCase();
  const vat = o.vat_amount ?? 0;
  const treatment = country === home ? "nl_standard"
    : EU_COUNTRIES.has(country) ? (vat > 0 ? "nl_standard" : "eu_reverse_charge")
    : vat > 0 ? "nl_standard" : "export_outside_eu_services";
  const rate = await eurRate(db, cfg["integrations.fx_api_base"], o.currency, o.issued_date);
  const lagDays = need(cfg, "fx.default_payment_lag_days");
  const due = o.due_date ?? new Date(Date.parse(o.issued_date) + lagDays * 864e5).toISOString().slice(0, 10);

  const reasons: string[] = [];
  if (!/^[A-Z]{2}$/.test(country)) reasons.push("invoice_needs_country");
  if (o.confidence < ctx.gateCfg.autoBookMinConfidence) reasons.push("low_confidence");

  const { data: inv, error } = await db.from("invoices").insert({
    user_id: userId, invoice_number: o.invoice_number, client: o.client, amount: o.amount, currency: o.currency,
    issued_date: o.issued_date, due_date: due, hours: o.hours ?? null, unit_rate: o.unit_rate ?? null,
    period_start: o.period_start ?? null, period_end: o.period_end ?? null, client_country: country || null,
    client_region: o.client_region ?? null, vat_treatment: treatment, vat_amount: vat, fx_rate_eur: rate?.rate ?? null,
    fx_rate_date: rate?.date ?? null, amount_eur: rate ? round2(o.amount * rate.rate) : null, description: o.description ?? null,
    source: "manual", ingest_channel: "upload", document_path: path,
    review_state: reasons.length ? "needs_review" : "confirmed",
  }).select("id, invoice_number, client, amount, currency, issued_date, period_start, period_end, hours, unit_rate, duplicate_of, voided_at, amount_eur").single();
  if (error?.code === "23505") {
    // Never overwrite an existing invoice; ask instead.
    const { data: existing } = await db.from("invoices").select("id").eq("user_id", userId).eq("invoice_number", o.invoice_number).single();
    await openReview(db, {
      user_id: userId, item_type: "invoice_anomaly", item_id: existing?.id ?? null, reason_codes: ["invoice_number_exists"],
      summary: `${o.invoice_number} is already in your ledger; the uploaded copy was not applied`,
      proposed: { uploaded: o, path }, agent_run_id: run.id,
    });
    run.count("invoice_conflicts");
    return;
  }
  if (error) throw new Error(`insert invoice: ${error.message}`);

  const { data: same } = await db.from("invoices")
    .select("id, invoice_number, client, amount, currency, issued_date, period_start, period_end, hours, unit_rate, duplicate_of, voided_at, amount_eur")
    .eq("user_id", userId).eq("client", inv.client).is("voided_at", null);
  const { anomalies } = detectDuplicates((same ?? []) as never);
  const hit = anomalies.find((a) => a.invoice_ids.includes(inv.id));
  if (hit) reasons.push("invoice_duplicate_period");
  if (reasons.length) {
    await openReview(db, {
      user_id: userId, item_type: "invoice_anomaly", item_id: inv.id,
      reason_codes: reasons,
      summary: hit?.message ?? `${o.invoice_number}: please confirm the extracted figures`,
      proposed: { invoice: o }, agent_run_id: run.id,
    });
  }
  run.count("invoices_ingested");
}

// ------------------------------------------------------------- entrypoint ---

async function runForUser(ctx: Ctx, userId: string, trigger: Trigger, docs: () => Promise<CollectedDoc[]>, handler?: (d: CollectedDoc, run: AgentRun) => Promise<void>) {
  const run = await AgentRun.start(ctx.db, userId, "expense", trigger, { trigger });
  try {
    const list = (await run.step("collect", docs, { summarize: (d) => ({ documents: d.length }) })) ?? [];
    const max = need(ctx.cfg, "expense_agent.max_documents_per_run");
    const done = list.slice(0, max);
    const failedDrive: string[] = [];
    for (const d of done) {
      const ok = await run.step(`process:${d.source}:${d.external_id}`, async () => { await (handler ? handler(d, run) : processReceipt(ctx, run, userId, d)); return true; }, { tolerate: true });
      if (!ok && d.source === "drive") failedDrive.push(d.received_at);
    }
    // Advance the Drive cursor only past files that were processed; a failed
    // file (or one beyond this run's cap) is picked up again next run.
    const driveDone = done.filter((d) => d.source === "drive").map((d) => d.received_at).sort();
    const skipped = list.slice(max).filter((d) => d.source === "drive").map((d) => d.received_at);
    const blockers = [...failedDrive, ...skipped].sort();
    const cursor = blockers.length ? driveDone.filter((t) => t < blockers[0]).at(-1) : driveDone.at(-1);
    if (cursor) {
      const { data: c } = await ctx.db.from("integration_connections").select("id, cursor").eq("user_id", userId).eq("provider", "google").maybeSingle();
      if (c) await ctx.db.from("integration_connections").update({ cursor: { ...c.cursor, drive_modified_after: cursor } }).eq("id", c.id);
    }
    run.count("documents", done.length);
    return { run_id: run.id, status: await run.finish(), metrics: run.metrics };
  } catch (e) {
    await run.finish(e);
    throw e;
  }
}

async function collectAll(ctx: Ctx, userId: string): Promise<CollectedDoc[]> {
  const { db, cfg } = ctx;
  const lookback = need(cfg, "expense_agent.lookback_days");
  const max = need(cfg, "expense_agent.max_documents_per_run");
  const { data: conns } = await db.from("integration_connections").select("id, provider, vault_secret_id, settings, cursor")
    .eq("user_id", userId).eq("status", "active");
  const docs: CollectedDoc[] = [];
  for (const c of (conns ?? []) as Connection[]) {
    try {
      if (c.provider === "google") {
        const token = await googleAccessToken(db, cfg, c);
        docs.push(...await collectGmail(token, cfg, lookback, max));
        docs.push(...(await collectDrive(token, cfg, c, max)).docs);
      } else if (c.provider === "wise") {
        docs.push(...await collectWise(db, cfg, c, lookback, max));
      }
      await db.from("integration_connections").update({ last_error: null }).eq("id", c.id);
    } catch (e) {
      await db.from("integration_connections").update({ last_error: (e as Error).message.slice(0, 500) }).eq("id", c.id);
    }
  }
  // Documents with files first so bank payments can match them in the same run.
  return docs.sort((a, b) => Number(a.source === "wise") - Number(b.source === "wise"));
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const caller = who.kind === "user" ? who.id : null;
    const body = await req.json().catch(() => ({}));
    const ctx = await loadCtx(db);

    if (body.mode === "upload") {
      // A signed-in user uploads their own file; the scheduler identity may
      // submit one on a named user's behalf (backfills). Either way the file
      // must sit in that user's folder.
      const owner = caller ?? (who.kind === "service" && typeof body.user_id === "string" ? body.user_id : null);
      if (!owner) return json({ error: "sign in required" }, 401);
      const path = String(body.path ?? "");
      if (!path.startsWith(`${owner}/`) || path.split("/").some((seg) => seg === ".." || seg === "")) {
        return json({ error: "path outside your folder" }, 403);
      }
      const dl = await db.storage.from("receipts").download(path);
      if (dl.error) return json({ error: dl.error.message }, 400);
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      const mediaType = dl.data.type || (path.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
      const doc: CollectedDoc = { source: "upload", external_id: `upload:${path}`, received_at: new Date().toISOString(), title: path.split("/").pop()!, file: { bytes, mediaType, name: path } };
      const handler = body.kind === "sales_invoice"
        ? (d: CollectedDoc, run: AgentRun) => processSalesInvoice(ctx, run, owner, d, path)
        : (d: CollectedDoc, run: AgentRun) => processReceipt(ctx, run, owner, d, path);
      return json(await runForUser(ctx, owner, "upload", async () => [doc], handler));
    }

    const users = caller ? [caller] : [...new Set(((await db.from("integration_connections").select("user_id").eq("status", "active")).data ?? []).map((r) => r.user_id as string))];
    const results = [];
    for (const u of users) results.push(await runForUser(ctx, u, caller ? "manual" : "cron", () => collectAll(ctx, u)));
    return json({ results });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

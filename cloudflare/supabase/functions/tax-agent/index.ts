// tax-agent: prepares VAT quarter and income tax drafts. Numbers are computed
// deterministically by the fiscal engine; the model only writes warnings.
// Every draft lands in review_items. Approved or filed drafts are never
// overwritten: if the books change afterwards the owner is told instead.
//
// POST {}                                   cron: every user, current + previous quarter, current year
// POST { kind, period }                     the signed-in user, one period ("2026-Q3" or "2026")
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize } from "../_shared/client.ts";
import { loadConfig, need, type AppConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { callStructured } from "../_shared/llm.ts";
import { AgentRun, openReview, sha256Hex, type Trigger } from "../_shared/harness.ts";
import { Annotation, END, START, StateGraph } from "npm:@langchain/langgraph@1.4.17";
import { backfillInvoiceFx, loadForecastData, loadParams, loadTaxData, type TaxData } from "../_shared/taxData.ts";
import {
  type ExpenseRow, type FiscalParams, type InvoiceRow,
  COUNTABLE, buildForecast, deductibleEur, depreciationForYear, draftVat, estimateIncomeTax, kiaForYear,
  quarterBounds, round2, summarizeIncome,
} from "../_shared/fiscal/index.ts";

interface Warning { code: string; severity: "info" | "warn" | "block"; message: string }

async function backfillFx(db: SupabaseClient, cfg: AppConfig, userId: string, run: AgentRun) {
  run.count("fx_backfilled", await backfillInvoiceFx(db, cfg, userId));
}

function baseWarnings(p: FiscalParams, data: TaxData, periodStart: string, periodEnd: string): Warning[] {
  const w: Warning[] = [];
  for (const k of p.unverifiedKeys) {
    w.push({ code: "unverified_parameter", severity: k.startsWith("vat.") ? "block" : "warn", message: `Fiscal parameter ${k} is not yet verified against a primary source. Confirm it before filing.` });
  }
  const inPeriod = (d: string) => d >= periodStart && d <= periodEnd;
  const pendingExp = data.expenses.filter((e) => inPeriod(e.date) && !COUNTABLE.has(e.status) && e.status !== "rejected");
  if (pendingExp.length) w.push({ code: "expenses_awaiting_review", severity: "warn", message: `${pendingExp.length} expense(s) in this period still wait for your review and are not included.` });
  const noEvidence = data.expenses.filter((e) => inPeriod(e.date) && COUNTABLE.has(e.status) && !e.evidence_path);
  if (noEvidence.length) w.push({ code: "missing_evidence", severity: "warn", message: `${noEvidence.length} counted expense(s) have no stored receipt.` });
  const pendingAssets = data.assets.filter((a) => a.status === "needs_review" && inPeriod(a.acquired_date));
  if (pendingAssets.length) w.push({ code: "assets_awaiting_review", severity: "warn", message: `${pendingAssets.length} asset(s) wait for review; depreciation and KIA exclude them.` });
  return w;
}

async function modelWarnings(db: SupabaseClient, run: AgentRun, figures: unknown, warnings: Warning[]): Promise<Warning[]> {
  const { data: agent } = await db.from("agent_configs").select("system_prompt, llm_provider, llm_model, max_tokens, temperature, enabled").eq("agent_id", "tax_drafter").single();
  if (!agent?.enabled) return [];
  const res = await run.step("drafter:warnings", () => callStructured<{ warnings: Warning[] }>(
    { provider: agent.llm_provider, model: agent.llm_model, maxTokens: agent.max_tokens, temperature: Number(agent.temperature) },
    agent.system_prompt,
    [{ type: "text", text: JSON.stringify({ figures, deterministic_warnings: warnings }) }],
    {
      name: "report_warnings", description: "Plain-language warnings for the owner.",
      input_schema: { type: "object", required: ["warnings"], properties: { warnings: { type: "array", items: { type: "object", required: ["code", "severity", "message"], properties: { code: { type: "string" }, severity: { type: "string", enum: ["info", "warn", "block"] }, message: { type: "string" } } } } } },
    }), { tolerate: true });
  // The model may add context but never relaxes a deterministic block.
  return (res?.value.warnings ?? []).filter((x) => ["info", "warn", "block"].includes(x.severity) && typeof x.message === "string").map((x) => ({ ...x, code: `ai_${x.code}` }));
}

/** The date-independent part of a draft. The income tax projection moves
 *  every day, so it never counts as a change to the books. */
function stableFigures(kind: string, figures: Record<string, unknown>) {
  if (kind !== "income_tax_year") return figures;
  const { ledger, costs_eur, depreciation_eur, kia, ytd } = figures;
  return { ledger, costs_eur, depreciation_eur, kia, ytd };
}
const stableHash = async (kind: string, f: Record<string, unknown>) => sha256Hex(new TextEncoder().encode(JSON.stringify(stableFigures(kind, f))));

async function saveDraft(db: SupabaseClient, run: AgentRun, userId: string, kind: string, label: string, start: string, end: string, figures: Record<string, unknown>, warnings: Warning[]) {
  const { data: current } = await db.from("tax_filings").select("id, status, figures").eq("user_id", userId).eq("kind", kind).eq("period_label", label).neq("status", "superseded").maybeSingle();
  const hash = await stableHash(kind, figures);
  const same = current && (await stableHash(kind, current.figures)) === hash;
  if (current && same) {
    // Refresh the projection on an open draft without reopening review.
    if (current.status === "needs_review") await db.from("tax_filings").update({ figures, warnings }).eq("id", current.id);
    run.count("drafts_unchanged");
    return;
  }
  if (current && current.status !== "needs_review") {
    // Approved and filed drafts are immutable. Tell the owner once per
    // distinct change; review-decide turns an accepted change into a new
    // draft (approved) or a correction draft (filed).
    const { data: last } = await db.from("review_items").select("proposed").eq("user_id", userId).eq("item_id", current.id)
      .contains("reason_codes", ["changed_after_approval"]).order("created_at", { ascending: false }).limit(1);
    if (last?.[0]?.proposed?.stable_hash === hash) { run.count("change_already_raised"); return; }
    await openReview(db, {
      user_id: userId, item_type: "filing", item_id: current.id, reason_codes: ["changed_after_approval"],
      summary: `${label} ${kind === "vat_quarter" ? "VAT" : "income tax"}: the books changed after you ${current.status === "filed" ? "filed" : "approved"} this draft`,
      proposed: { change: true, new_figures: figures, new_warnings: warnings, stable_hash: hash }, agent_run_id: run.id,
    });
    run.count("changed_after_approval");
    return;
  }
  if (current) {
    await db.from("tax_filings").update({ status: "superseded" }).eq("id", current.id);
    await db.from("review_items").update({ status: "rejected", decision: { action: "superseded_by_agent" }, decided_at: new Date().toISOString() })
      .eq("item_id", current.id).eq("status", "open");
  }
  const { data: f, error } = await db.from("tax_filings").insert({
    user_id: userId, kind, period_label: label, period_start: start, period_end: end, status: "needs_review", figures, warnings, agent_run_id: run.id,
  }).select("id").single();
  if (error) throw new Error(`save draft: ${error.message}`);
  const blocks = warnings.filter((w) => w.severity === "block").length;
  await openReview(db, {
    user_id: userId, item_type: "filing", item_id: f.id, reason_codes: blocks ? ["blocking_warnings"] : ["needs_sign_off"],
    summary: `${label} ${kind === "vat_quarter" ? "VAT return" : "income tax estimate"} ready for review${blocks ? ` (${blocks} blocking)` : ""}`,
    proposed: { figures }, agent_run_id: run.id,
  });
  run.count("drafts_created");
}

async function vatDraft(db: SupabaseClient, run: AgentRun, userId: string, year: number, q: 1 | 2 | 3 | 4, p: FiscalParams, data: TaxData) {
  const b = quarterBounds(year, q);
  const d = draftVat(data.invoices, data.expenses, b.start, b.end, p);
  const warnings = baseWarnings(p, data, b.start, b.end);
  if (d.not_reported.items) warnings.push({ code: "not_reported", severity: "info", message: `${d.not_reported.items} invoice(s), ${d.not_reported.base_eur.toFixed(2)} EUR, are B2B services to a non-EU business: not part of the Dutch VAT return.` });
  for (const u of d.unplaced) warnings.push({ code: "unplaced", severity: "block", message: `Item ${u.id} could not be placed: ${u.reason}.` });
  warnings.push(...await modelWarnings(db, run, d, warnings));
  await saveDraft(db, run, userId, "vat_quarter", b.label, b.start, b.end, d as unknown as Record<string, unknown>, warnings);
}

async function incomeTaxDraft(db: SupabaseClient, cfg: AppConfig, run: AgentRun, userId: string, year: number, p: FiscalParams, params: Map<number, FiscalParams>, data: TaxData) {
  const start = `${year}-01-01`, end = `${year}-12-31`;
  const ledger = summarizeIncome(data.invoices as InvoiceRow[], data.time, year);
  const yearExp = data.expenses.filter((e) => e.date.startsWith(String(year)));
  const costs = round2(yearExp.reduce((s, e) => s + deductibleEur(e as ExpenseRow, p), 0));
  const depreciation = round2(data.assets.reduce((s, a) => s + depreciationForYear(a, year), 0));
  const kia = kiaForYear(data.assets, year, p);
  const hours = ledger.billed_hours + ledger.non_billable_hours;
  const today = new Date().toISOString().slice(0, 10);

  // The current year runs through the live forecast: billed income plus any
  // wage, withheld tax and prepayments, projected from the day after the last
  // billed period at the owner's hours. Other years are what is billed.
  let ytd;
  let projection = null;
  const warnings = baseWarnings(p, data, start, end);
  if (year === Number(today.slice(0, 4))) {
    const f = buildForecast(await loadForecastData(db, cfg, userId, today, data, params));
    ytd = f.to_date;
    if (f.remaining && f.rate) {
      projection = {
        from: f.remaining.from,
        capacity: { from: f.remaining.from, to: f.remaining.to, working_days: f.remaining.working_days, days_off: f.remaining.days_off, hours: f.remaining.hours },
        eur_per_hour: f.rate.eur_per_hour,
        revenue_eur: f.year_end.revenue_eur,
        estimate: f.year_end,
      };
    }
    for (const w of f.warnings) if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
  } else {
    const starters = data.profile?.startersaftrek_eligible === true;
    ytd = estimateIncomeTax({ revenue_eur: ledger.revenue_eur, deductible_costs_eur: costs, depreciation_eur: depreciation, kia_eur: kia.kia, total_hours: hours, starters_eligible: starters }, p);
    for (const a of ledger.anomalies) warnings.push({ code: a.code, severity: a.code === "duplicate_period" || a.code === "missing_fx" ? "block" : "warn", message: a.message });
    if (!ytd.urencriterium_met) warnings.push({ code: "urencriterium", severity: "warn", message: `${hours} of ${p.urencriteriumHours} hours logged; zelfstandigenaftrek is not applied yet.` });
  }
  const buffer = need(cfg, "tax_agent.reserve_buffer_pct");
  const target = projection?.estimate.total_due ?? ytd.total_due;
  const figures = { ledger: { billed_hours: ledger.billed_hours, non_billable_hours: ledger.non_billable_hours, revenue_eur: ledger.revenue_eur, revenue_by_currency: ledger.revenue_by_currency }, costs_eur: costs, depreciation_eur: depreciation, kia, ytd, projection, reserve_target_eur: round2(target * (1 + buffer)) };
  warnings.push(...await modelWarnings(db, run, figures, warnings));
  await saveDraft(db, run, userId, "income_tax_year", String(year), start, end, figures, warnings);
}

type Target = { kind: string; year: number; q?: 1 | 2 | 3 | 4 };

/** Which drafts a run prepares: one asked-for period, or the previous and
 *  current VAT quarter plus the current income tax year. */
export function targetsFor(now: Date, only?: { kind: string; period: string }): Target[] {
  if (only) {
    const m = only.period.match(/^(\d{4})(?:-Q([1-4]))?$/);
    if (!m) throw new Error("period must look like 2026 or 2026-Q3");
    return [{ kind: only.kind, year: Number(m[1]), q: m[2] ? (Number(m[2]) as 1 | 2 | 3 | 4) : undefined }];
  }
  const y = now.getUTCFullYear();
  const q = (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const prevQ = q === 1 ? { year: y - 1, q: 4 as const } : { year: y, q: (q - 1) as 1 | 2 | 3 };
  return [{ kind: "vat_quarter", ...prevQ }, { kind: "vat_quarter", year: y, q }, { kind: "income_tax_year", year: y }];
}

// The tax run as a LangGraph state graph: backfill FX, load the books, then
// one draft node per target. Figures are computed by the fiscal engine; the
// only model call is the warnings writer inside each draft.
const TaxState = Annotation.Root({
  data: Annotation<TaxData | null>({ reducer: (_a, b) => b, default: () => null }),
  targets: Annotation<Target[]>({ reducer: (_a, b) => b, default: () => [] }),
  next: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
});

function taxGraph(db: SupabaseClient, cfg: AppConfig, params: Map<number, FiscalParams>, run: AgentRun, userId: string, only?: { kind: string; period: string }) {
  return new StateGraph(TaxState)
    .addNode("fx_backfill", async () => {
      await run.step("fx_backfill", () => backfillFx(db, cfg, userId, run));
      return {};
    })
    .addNode("load", async () => ({ data: (await run.step("load", () => loadTaxData(db, userId)))!, targets: targetsFor(new Date(), only) }))
    .addNode("draft", async (st) => {
      const t = st.targets[st.next];
      const p = params.get(t.year);
      if (!p) run.count("missing_parameters");
      else {
        await run.step(`${t.kind}:${t.year}${t.q ? `-Q${t.q}` : ""}`, () =>
          t.kind === "vat_quarter" ? vatDraft(db, run, userId, t.year, t.q!, p, st.data!) : incomeTaxDraft(db, cfg, run, userId, t.year, p, params, st.data!), { tolerate: true });
      }
      return { next: st.next + 1 };
    })
    .addEdge(START, "fx_backfill")
    .addEdge("fx_backfill", "load")
    .addConditionalEdges("load", (st) => (st.targets.length ? "draft" : END), ["draft", END])
    .addConditionalEdges("draft", (st) => (st.next < st.targets.length ? "draft" : END), ["draft", END])
    .compile();
}

async function runForUser(db: SupabaseClient, cfg: AppConfig, params: Map<number, FiscalParams>, userId: string, trigger: Trigger, only?: { kind: string; period: string }) {
  const run = await AgentRun.start(db, userId, "tax_drafter", trigger, only ?? { scope: "default" });
  try {
    await taxGraph(db, cfg, params, run, userId, only).invoke({});
    return { run_id: run.id, status: await run.finish(), metrics: run.metrics };
  } catch (e) {
    await run.finish(e);
    throw e;
  }
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
    const cfg = await loadConfig(db);
    const params = await loadParams(db);
    const only = body.kind && body.period ? { kind: String(body.kind), period: String(body.period) } : undefined;
    if (only && !["vat_quarter", "income_tax_year"].includes(only.kind)) return json({ error: "invalid kind" }, 400);
    const users = caller ? [caller] : ((await db.from("profiles").select("id")).data ?? []).map((r) => r.id as string);
    const results = [];
    for (const u of users) results.push(await runForUser(db, cfg, params, u, caller ? "manual" : "cron", only));
    return json({ results });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

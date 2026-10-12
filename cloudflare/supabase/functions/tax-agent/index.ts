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
import { eurRate } from "../_shared/fx.ts";
import { callStructured } from "../_shared/llm.ts";
import { AgentRun, openReview, type Trigger } from "../_shared/harness.ts";
import {
  type AssetRow, type ExpenseRow, type FiscalParams, type InvoiceRow, type ParamRow, type VatExpense,
  COUNTABLE, deductibleEur, depreciationForYear, draftVat, estimateIncomeTax, kiaForYear, paramsFromRows,
  quarterBounds, round2, summarizeIncome, workingCapacity,
} from "../_shared/fiscal/index.ts";

interface Warning { code: string; severity: "info" | "warn" | "block"; message: string }

const INVOICE_COLS = "id, invoice_number, client, amount, currency, amount_eur, status, issued_date, period_start, period_end, hours, unit_rate, duplicate_of, voided_at, vat_amount, vat_treatment, fx_rate_eur";
const EXPENSE_COLS = "id, date, status, treatment, amount, currency, amount_excl_vat, vat_amount, vat_reclaimable, vat_reverse_charge, business_use_pct, fx_rate_eur, category, vendor_country, evidence_path";

async function backfillFx(db: SupabaseClient, cfg: AppConfig, userId: string, run: AgentRun) {
  const { data } = await db.from("invoices").select("id, amount, currency, issued_date").eq("user_id", userId).is("amount_eur", null);
  for (const inv of data ?? []) {
    const r = await eurRate(db, cfg["integrations.fx_api_base"], inv.currency, inv.issued_date);
    if (!r) continue;
    await db.from("invoices").update({ fx_rate_eur: r.rate, fx_rate_date: r.date, amount_eur: round2(Number(inv.amount) * r.rate) }).eq("id", inv.id);
    run.count("fx_backfilled");
  }
}

async function load(db: SupabaseClient, userId: string) {
  const [inv, exp, assets, time, profile, openReviews] = await Promise.all([
    db.from("invoices").select(INVOICE_COLS).eq("user_id", userId),
    db.from("expenses").select(EXPENSE_COLS).eq("user_id", userId),
    db.from("fixed_assets").select("id, description, acquired_date, cost_excl_vat, residual_value, useful_life_years, kia_eligible, status").eq("user_id", userId),
    db.from("time_entries").select("entry_date, hours, category").eq("user_id", userId),
    db.from("profiles").select("work_calendar_region, standard_hours_per_day, startersaftrek_eligible").eq("id", userId).single(),
    db.from("review_items").select("item_type", { count: "exact" }).eq("user_id", userId).eq("status", "open"),
  ]);
  for (const r of [inv, exp, assets, time]) if (r.error) throw new Error(r.error.message);
  const n = (x: unknown) => (x == null ? null : Number(x));
  return {
    invoices: (inv.data ?? []).map((r) => ({ ...r, amount: Number(r.amount), amount_eur: n(r.amount_eur), hours: n(r.hours), unit_rate: n(r.unit_rate), vat_amount: Number(r.vat_amount) })),
    expenses: (exp.data ?? []).map((r) => ({ ...r, amount: Number(r.amount), amount_excl_vat: n(r.amount_excl_vat), vat_amount: n(r.vat_amount), business_use_pct: Number(r.business_use_pct), fx_rate_eur: n(r.fx_rate_eur) })) as (VatExpense & { evidence_path: string | null })[],
    assets: (assets.data ?? []).map((r) => ({ ...r, cost_excl_vat: Number(r.cost_excl_vat), residual_value: Number(r.residual_value), useful_life_years: Number(r.useful_life_years) })) as AssetRow[],
    time: (time.data ?? []).map((r) => ({ ...r, hours: Number(r.hours) })),
    profile: profile.data,
    openReviews: openReviews.data ?? [],
  };
}

function baseWarnings(p: FiscalParams, data: Awaited<ReturnType<typeof load>>, periodStart: string, periodEnd: string): Warning[] {
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

async function saveDraft(db: SupabaseClient, run: AgentRun, userId: string, kind: string, label: string, start: string, end: string, figures: unknown, warnings: Warning[]) {
  const { data: current } = await db.from("tax_filings").select("id, status, figures").eq("user_id", userId).eq("kind", kind).eq("period_label", label).neq("status", "superseded").maybeSingle();
  const same = current && JSON.stringify(current.figures) === JSON.stringify(figures);
  if (current && same) { run.count("drafts_unchanged"); return; }
  if (current && current.status !== "needs_review") {
    await openReview(db, {
      user_id: userId, item_type: "filing", item_id: current.id, reason_codes: ["changed_after_approval"],
      summary: `${label} ${kind === "vat_quarter" ? "VAT" : "income tax"}: the books changed after you ${current.status} this draft`,
      proposed: { new_figures: figures }, agent_run_id: run.id,
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

async function vatDraft(db: SupabaseClient, run: AgentRun, userId: string, year: number, q: 1 | 2 | 3 | 4, p: FiscalParams, data: Awaited<ReturnType<typeof load>>) {
  const b = quarterBounds(year, q);
  const d = draftVat(data.invoices, data.expenses, b.start, b.end, p);
  const warnings = baseWarnings(p, data, b.start, b.end);
  for (const u of d.unplaced) warnings.push({ code: "unplaced", severity: "block", message: `Item ${u.id} could not be placed: ${u.reason}.` });
  warnings.push(...await modelWarnings(db, run, d, warnings));
  await saveDraft(db, run, userId, "vat_quarter", b.label, b.start, b.end, d, warnings);
}

async function incomeTaxDraft(db: SupabaseClient, cfg: AppConfig, run: AgentRun, userId: string, year: number, p: FiscalParams, data: Awaited<ReturnType<typeof load>>) {
  const start = `${year}-01-01`, end = `${year}-12-31`;
  const ledger = summarizeIncome(data.invoices as InvoiceRow[], data.time, year);
  const yearExp = data.expenses.filter((e) => e.date.startsWith(String(year)));
  const costs = round2(yearExp.reduce((s, e) => s + deductibleEur(e as ExpenseRow, p), 0));
  const depreciation = round2(data.assets.reduce((s, a) => s + depreciationForYear(a, year), 0));
  const kia = kiaForYear(data.assets, year, p);
  const hours = ledger.billed_hours + ledger.non_billable_hours;
  const starters = data.profile?.startersaftrek_eligible === true;
  const ytd = estimateIncomeTax({ revenue_eur: ledger.revenue_eur, deductible_costs_eur: costs, depreciation_eur: depreciation, kia_eur: kia.kia, total_hours: hours, starters_eligible: starters }, p);

  // Projection to year end at the latest billed rate on the client's calendar.
  let projection = null;
  const region = data.profile?.work_calendar_region;
  const perDay = data.profile?.standard_hours_per_day != null ? Number(data.profile.standard_hours_per_day) : null;
  const latest = [...data.invoices].filter((i) => !i.voided_at && i.unit_rate && i.amount_eur).sort((a, b) => b.issued_date.localeCompare(a.issued_date))[0];
  const today = new Date().toISOString().slice(0, 10);
  const lastBilled = ledger.months.at(-1)?.month;
  if (region && perDay && latest && lastBilled && today <= end) {
    const nextDay = new Date(Date.UTC(Number(lastBilled.slice(0, 4)), Number(lastBilled.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const from = nextDay > today ? nextDay : today;
    const { data: hol } = await db.from("public_holidays").select("holiday_date, name").eq("region_code", region).gte("holiday_date", from).lte("holiday_date", end);
    const cap = workingCapacity(from, end, hol ?? [], perDay);
    const eurPerHour = Number(latest.amount_eur) / Number(latest.amount) * Number(latest.unit_rate);
    const extraRev = round2(cap.hours * eurPerHour);
    projection = {
      from, capacity: cap, eur_per_hour: round2(eurPerHour),
      revenue_eur: round2(ledger.revenue_eur + extraRev),
      estimate: estimateIncomeTax({ revenue_eur: ledger.revenue_eur + extraRev, deductible_costs_eur: costs, depreciation_eur: depreciation, kia_eur: kia.kia, total_hours: hours + cap.hours, starters_eligible: starters }, p),
    };
  }
  const buffer = need(cfg, "tax_agent.reserve_buffer_pct");
  const target = projection?.estimate.total_due ?? ytd.total_due;
  const figures = { ledger: { billed_hours: ledger.billed_hours, non_billable_hours: ledger.non_billable_hours, revenue_eur: ledger.revenue_eur, revenue_by_currency: ledger.revenue_by_currency }, costs_eur: costs, depreciation_eur: depreciation, kia, ytd, projection, reserve_target_eur: round2(target * (1 + buffer)) };

  const warnings = baseWarnings(p, data, start, end);
  for (const a of ledger.anomalies) warnings.push({ code: a.code, severity: a.code === "duplicate_period" || a.code === "missing_fx" ? "block" : "warn", message: a.message });
  if (!ytd.urencriterium_met) warnings.push({ code: "urencriterium", severity: "warn", message: `${hours} of ${p.urencriteriumHours} hours logged; zelfstandigenaftrek is not applied yet.` });
  if (!region || !perDay) warnings.push({ code: "no_calendar", severity: "info", message: "Set your work calendar and standard hours in Settings to see a year-end projection." });
  warnings.push(...await modelWarnings(db, run, figures, warnings));
  await saveDraft(db, run, userId, "income_tax_year", String(year), start, end, figures, warnings);
}

async function runForUser(db: SupabaseClient, cfg: AppConfig, params: Map<number, FiscalParams>, userId: string, trigger: Trigger, only?: { kind: string; period: string }) {
  const run = await AgentRun.start(db, userId, "tax_drafter", trigger, only ?? { scope: "default" });
  try {
    await run.step("fx_backfill", () => backfillFx(db, cfg, userId, run));
    const data = (await run.step("load", () => load(db, userId)))!;
    const now = new Date();
    const y = now.getUTCFullYear();
    const q = (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
    const targets: { kind: string; year: number; q?: 1 | 2 | 3 | 4 }[] = [];
    if (only) {
      const m = only.period.match(/^(\d{4})(?:-Q([1-4]))?$/);
      if (!m) throw new Error("period must look like 2026 or 2026-Q3");
      targets.push({ kind: only.kind, year: Number(m[1]), q: m[2] ? (Number(m[2]) as 1 | 2 | 3 | 4) : undefined });
    } else {
      const prevQ = q === 1 ? { year: y - 1, q: 4 as const } : { year: y, q: (q - 1) as 1 | 2 | 3 };
      targets.push({ kind: "vat_quarter", ...prevQ }, { kind: "vat_quarter", year: y, q }, { kind: "income_tax_year", year: y });
    }
    for (const t of targets) {
      const p = params.get(t.year);
      if (!p) { run.count("missing_parameters"); continue; }
      await run.step(`${t.kind}:${t.year}${t.q ? `-Q${t.q}` : ""}`, () =>
        t.kind === "vat_quarter" ? vatDraft(db, run, userId, t.year, t.q!, p, data) : incomeTaxDraft(db, cfg, run, userId, t.year, p, data), { tolerate: true });
    }
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
    const cfg = await loadConfig(db);
    const { data: rows } = await db.from("tax_parameters").select("year, key, value, verified");
    const params = new Map<number, FiscalParams>();
    for (const y of new Set((rows ?? []).map((r) => r.year as number))) params.set(y, paramsFromRows(rows as ParamRow[], y));
    const body = await req.json().catch(() => ({}));
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const caller = who.kind === "user" ? who.id : null;
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

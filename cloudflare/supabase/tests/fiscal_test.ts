// Engine tests on Dan's real 2026 invoices and receipts. Parameters come from
// the same seed the migration loads (tax_parameters_2026.json is generated
// from it), so a test failure means the DB and the engine disagree.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import rows from "./tax_parameters_2026.json" with { type: "json" };
import {
  type AssetRow, type ExpenseRow, type InvoiceRow,
  depreciationForYear, draftVat, deductibleEur, estimateIncomeTax, gate, kiaForYear,
  paramsFromRows, quarterBounds, reclaimableVatEur, summarizeIncome, workingCapacity,
} from "../functions/_shared/fiscal/index.ts";

const p = paramsFromRows(rows as never, 2026);

const inv = (n: string, issued: string, hours: number, start: string | null, end: string | null, client = "Alpha FM Consulting Canada Inc"): InvoiceRow => ({
  id: n, invoice_number: n, client, amount: hours * 185, currency: "CAD", amount_eur: null,
  status: "pending", issued_date: issued, period_start: start, period_end: end, hours, unit_rate: 185, duplicate_of: null, voided_at: null,
});
const JPSB = "JPSB Consulting Limited";
const invoices: InvoiceRow[] = [
  inv("INV-001", "2026-01-30", 120, "2026-01-12", "2026-01-31", JPSB),
  inv("INV-002", "2026-01-31", 120, "2026-01-12", "2026-01-31", JPSB),
  inv("INV-003", "2026-01-31", 120, "2026-01-12", "2026-01-31", JPSB),
  inv("INV-004", "2026-02-28", 160, "2026-02-01", "2026-02-28", JPSB),
  inv("INV-005", "2026-03-31", 176, "2026-03-01", "2026-03-31", JPSB),
  inv("INV-006", "2026-04-30", 160, "2026-04-01", "2026-04-30", JPSB),
  inv("INV-007", "2026-05-31", 160, "2026-05-01", "2026-05-31"),
  inv("INV-008", "2026-06-30", 176, "2026-06-01", "2026-06-30"),
  inv("INV-009", "2026-07-31", 160, "2026-07-01", "2026-07-31"),
  inv("INV-010", "2026-08-31", 144, "2026-08-01", "2026-08-31"),
  inv("INV-012", "2026-09-30", 246, "2026-09-01", "2026-09-30"),
];

Deno.test("ledger: hours and revenue count January once", () => {
  const s = summarizeIncome(invoices, [], 2026);
  assertEquals(s.billed_hours, 1502);
  assertEquals(s.revenue_by_currency.CAD, 277870);
  assertEquals(s.months.length, 9);
});

Deno.test("ledger: flags the triple January invoice and the INV-011 gap", () => {
  const s = summarizeIncome(invoices, [], 2026);
  const dup = s.anomalies.find((a) => a.code === "duplicate_period")!;
  assertEquals(dup.invoice_ids, ["INV-001", "INV-002", "INV-003"]);
  const gap = s.anomalies.filter((a) => a.code === "numbering_gap");
  assertEquals(gap.length, 1);
  assertEquals(gap[0].message.startsWith("INV-011"), true);
});

Deno.test("ledger: void invoices drop out", () => {
  const voided = invoices.map((i) => (i.id === "INV-002" || i.id === "INV-003" ? { ...i, voided_at: "2026-10-12T00:00:00Z" } : i));
  const s = summarizeIncome(voided, [], 2026);
  assertEquals(s.billed_hours, 1502);
  assertEquals(s.anomalies.some((a) => a.code === "duplicate_period"), false);
});

Deno.test("calendar: 56 working days left from 12 Oct on Ontario and BC calendars", () => {
  const on = [
    { holiday_date: "2026-10-12", name: "Thanksgiving" },
    { holiday_date: "2026-12-25", name: "Christmas Day" },
    { holiday_date: "2026-12-28", name: "Boxing Day (observed)" },
  ];
  const bc = [
    { holiday_date: "2026-10-12", name: "Thanksgiving" },
    { holiday_date: "2026-11-11", name: "Remembrance Day" },
    { holiday_date: "2026-12-25", name: "Christmas Day" },
  ];
  const a = workingCapacity("2026-10-12", "2026-12-31", on, 8);
  assertEquals(a.weekdays, 59);
  assertEquals(a.working_days, 56);
  assertEquals(a.hours, 448);
  assertEquals(workingCapacity("2026-10-12", "2026-12-31", bc, 8).working_days, 56);
});

Deno.test("income tax: worked example at 100k profit", () => {
  const r = estimateIncomeTax({ revenue_eur: 100000, deductible_costs_eur: 0, depreciation_eur: 0, kia_eur: 0, total_hours: 1502, starters_eligible: false }, p);
  assertEquals(r.urencriterium_met, true);
  assertEquals(r.zelfstandigenaftrek, 1200);
  assertAlmostEquals(r.mkb_winstvrijstelling, 12547.6, 0.01);
  assertAlmostEquals(r.taxable_profit, 86252.4, 0.01);
  assertAlmostEquals(r.income_tax_before_credits, 32627.09, 0.02);
  assertEquals(r.algemene_heffingskorting, 0);
  assertAlmostEquals(r.arbeidskorting, 3038.01, 0.02);
  assertAlmostEquals(r.zvw, 3851.34, 0.01);
  assertAlmostEquals(r.total_due, 33440.42, 0.05);
});

Deno.test("income tax: no zelfstandigenaftrek below the urencriterium", () => {
  const r = estimateIncomeTax({ revenue_eur: 50000, deductible_costs_eur: 0, depreciation_eur: 0, kia_eur: 0, total_hours: 1000, starters_eligible: true }, p);
  assertEquals(r.zelfstandigenaftrek, 0);
  assertEquals(r.startersaftrek, 0);
  assertAlmostEquals(r.mkb_winstvrijstelling, 6350, 0.01);
});

const exp = (id: string, date: string, gross: number, excl: number, vat: number, treatment: ExpenseRow["treatment"], use = 1, status = "approved"): ExpenseRow => ({
  id, date, status, treatment, amount: gross, currency: "EUR", amount_excl_vat: excl, vat_amount: vat,
  vat_reclaimable: true, vat_reverse_charge: false, business_use_pct: use, fx_rate_eur: null, category: "hardware",
});
// Coolblue receipts sent 12 Oct 2026.
const receipts: ExpenseRow[] = [
  exp("macmini", "2026-10-10", 999.00, 825.62, 173.38, "asset"),
  exp("sleeve", "2026-08-16", 44.99, 37.18, 7.81, "fully_deductible"),
  exp("asus", "2026-08-03", 264.00, 218.18, 45.82, "fully_deductible"),
  exp("philips", "2026-06-17", 119.00, 98.35, 20.65, "fully_deductible"),
  exp("airpods", "2026-01-19", 249.00, 205.79, 43.21, "fully_deductible", 0.5),
];

Deno.test("costs: Coolblue receipts", () => {
  const d = receipts.reduce((s, e) => s + deductibleEur(e, p), 0);
  // 37.18 + 218.18 + 98.35 + half of AirPods (205.79 + private VAT share 21.605) / 2
  assertAlmostEquals(d, 37.18 + 218.18 + 98.35 + (205.79 + 0.5 * 43.21) * 0.5, 0.02);
  const v = receipts.reduce((s, e) => s + reclaimableVatEur(e), 0);
  assertAlmostEquals(v, 173.38 + 7.81 + 45.82 + 20.65 + 21.61, 0.02);
});

Deno.test("costs: Mac mini depreciation and no KIA", () => {
  const mac: AssetRow = { id: "m", description: "Mac mini", acquired_date: "2026-10-10", cost_excl_vat: 825.62, residual_value: 0, useful_life_years: 5, kia_eligible: true, status: "active" };
  assertAlmostEquals(depreciationForYear(mac, 2026), 41.28, 0.01);
  assertAlmostEquals(depreciationForYear(mac, 2027), 165.12, 0.01);
  assertEquals(kiaForYear([mac], 2026, p).kia, 0);
  assertEquals(kiaForYear([{ ...mac, cost_excl_vat: 3000 }], 2026, p).kia, 840);
});

Deno.test("vat: Q3 draft places Canadian invoices in 1e and reclaims hardware VAT", () => {
  const q = quarterBounds(2026, 3);
  const vInv = invoices.map((i) => ({ id: i.id, issued_date: i.issued_date, voided_at: i.voided_at, amount: i.amount, currency: i.currency, amount_eur: round(i.amount * 0.6), vat_amount: 0, vat_treatment: "export_outside_eu_services" }));
  const vExp = receipts.map((e) => ({ ...e, vendor_country: "NL" }));
  const d = draftVat(vInv, vExp, q.start, q.end, p);
  assertEquals(d.boxes["1e"].items, 3);
  assertAlmostEquals(d.boxes["1e"].base_eur, round((160 + 144 + 246) * 185 * 0.6), 0.01);
  assertAlmostEquals(d.input_vat_5b, 45.82 + 7.81, 0.01);
  assertAlmostEquals(d.payable_5g, -(45.82 + 7.81), 0.01);
});

Deno.test("vat: foreign SaaS subscription is reverse charged and neutral", () => {
  const claude: ExpenseRow & { vendor_country: string } = { ...exp("claude", "2026-09-01", 100, 100, 0, "fully_deductible"), vat_reclaimable: false, vat_reverse_charge: true, currency: "USD", fx_rate_eur: 0.9, vendor_country: "US" };
  const q = quarterBounds(2026, 3);
  const d = draftVat([], [claude], q.start, q.end, p);
  assertAlmostEquals(d.boxes["4a"].vat_eur, 18.9, 0.01);
  assertAlmostEquals(d.payable_5g, 0, 0.01);
});

const cfg = { autoBookMinConfidence: 0.9, autoBookMaxAmountEur: 250, amountToleranceEur: 0.05, reviewCategories: ["representation", "club_membership"] };
const prop = (o: Partial<Parameters<typeof gate>[0]>) => ({
  vendor: "Coolblue", date: "2026-08-16", currency: "EUR", total: 44.99, amount_excl_vat: 37.18, vat_amount: 7.81,
  treatment: "fully_deductible" as const, category: "hardware", business_use_pct: 1, confidence: 0.96,
  is_business_document: true, vendor_rule_applied: false, ...o,
});

Deno.test("gate: sleeve books itself", () => {
  assertEquals(gate(prop({}), 44.99, cfg, p, false), { route: "book", reasons: [] });
});
Deno.test("gate: Mac mini waits as an asset", () => {
  const g = gate(prop({ total: 999, amount_excl_vat: 825.62, vat_amount: 173.38, treatment: "asset" }), 999, cfg, p, false);
  assertEquals(g.route, "review");
  assertEquals(g.reasons.includes("asset_threshold"), true);
});
Deno.test("gate: AirPods wait for the business share", () => {
  const g = gate(prop({ total: 249, amount_excl_vat: 205.79, vat_amount: 43.21, business_use_pct: 0.5 }), 249, cfg, p, false);
  assertEquals(g.reasons, ["private_or_mixed"]);
});
Deno.test("gate: Soho House-type membership always waits", () => {
  const g = gate(prop({ category: "club_membership", treatment: "limited_deductible", total: 200, amount_excl_vat: 165.29, vat_amount: 34.71 }), 200, cfg, p, false);
  assertEquals(g.reasons.includes("limited_deductible") && g.reasons.includes("review_category"), true);
});
Deno.test("gate: arithmetic errors and duplicates", () => {
  assertEquals(gate(prop({ vat_amount: 9 }), 44.99, cfg, p, false).reasons, ["vat_arithmetic"]);
  assertEquals(gate(prop({}), 44.99, cfg, p, true).route, "discard");
});
Deno.test("params: unverified rubriek map is surfaced", () => {
  assertEquals(p.unverifiedKeys, ["vat.rubriek_map"]);
});

function round(n: number) { return Math.round(n * 100) / 100; }

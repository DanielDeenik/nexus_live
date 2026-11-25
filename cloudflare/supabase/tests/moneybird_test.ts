// Moneybird link rules on made-up documents and cost lines: how a Moneybird
// document is read, which cost line it proves, and how sales invoices pair up.
import { assertEquals } from "jsr:@std/assert@1";
import { type CostLine, linkSalesInvoices, matchEvidence, type MbDoc, normalizeDoc } from "../functions/_shared/moneybird.ts";

const doc = (over: Partial<MbDoc>): MbDoc => ({
  id: "1", kind: "receipt", version: 1, date: "2026-06-09", reference: null, contact: "Anthropic, PBC",
  currency: "EUR", total_incl: 21.78, total_incl_eur: 21.78, total_excl_eur: 18, state: "open", paid_at: null, attachments: 1, ...over,
});
const cost = (over: Partial<CostLine>): CostLine => ({
  id: "c1", date: "2026-06-09", amount: 21.78, currency: "EUR", vendor: "ANTHROPIC* CLAUDE SUB   SAN FRANCISCO", description: null, evidence_path: null, ...over,
});
const opts = { toleranceEur: 0.05, tolerancePct: 5, windowDays: 10 };

Deno.test("normalize: a receipt keeps its euro total from the administration currency", () => {
  const d = normalizeDoc("receipt", {
    id: 4891, version: 1730000000, date: "2026-10-02", reference: "SA-123", currency: "USD",
    total_price_incl_tax: "239.0", total_price_incl_tax_base: "205.42", total_price_excl_tax_base: "205.42",
    state: "open", paid_at: null, contact: { company_name: "Seeking Alpha", firstname: null, lastname: null }, attachments: [{ id: 1 }],
  });
  assertEquals(d, {
    id: "4891", kind: "receipt", version: 1730000000, date: "2026-10-02", reference: "SA-123", contact: "Seeking Alpha",
    currency: "USD", total_incl: 239, total_incl_eur: 205.42, total_excl_eur: 205.42, state: "open", paid_at: null, attachments: 1,
  });
});

Deno.test("normalize: a sales invoice reads its number and invoice date; a person contact reads first and last name", () => {
  const d = normalizeDoc("sales_invoice", {
    id: "77", version: 5, invoice_id: "INV-013", invoice_date: "2026-11-28", currency: "CAD",
    total_price_incl_tax: "30000.0", total_price_incl_tax_base: "18562.10", total_price_excl_tax_base: "18562.10",
    state: "open", contact: { company_name: "", firstname: "Ann", lastname: "Lee" }, attachments: [],
  });
  assertEquals([d.reference, d.date, d.contact, d.total_incl_eur, d.attachments], ["INV-013", "2026-11-28", "Ann Lee", 18562.1, 0]);
});

Deno.test("match: a euro receipt proves the cost line with the same amount, shop and nearby date", () => {
  const m = matchEvidence([doc({ date: "2026-06-08" })], [cost({})], opts);
  assertEquals([...m], [["c1", "1"]]);
});

Deno.test("match: a dollar receipt matches within the percentage band only when the shop names agree", () => {
  const usd = doc({ id: "9", currency: "USD", total_incl: 239, total_incl_eur: 205.42, contact: "Seeking Alpha", date: "2026-10-01" });
  const card = cost({ id: "sa", date: "2026-10-02", amount: 210.55, vendor: "SEEKINGALPHA.COM        NEW YORK" });
  const other = cost({ id: "x", date: "2026-10-02", amount: 210.55, vendor: "TICKERTRENDS.IO         DALLAS" });
  assertEquals([...matchEvidence([usd], [card], opts)], [["sa", "9"]]);
  assertEquals(matchEvidence([usd], [other], opts).size, 0);
});

Deno.test("match: monthly charges of the same amount pair by nearest date, one receipt per line", () => {
  const docs = [doc({ id: "jun", date: "2026-06-09" }), doc({ id: "jul", date: "2026-07-09" })];
  const costs = [cost({ id: "c-jul", date: "2026-07-10" }), cost({ id: "c-jun", date: "2026-06-10" }), cost({ id: "c-aug", date: "2026-08-10" })];
  const m = matchEvidence(docs, costs, opts);
  assertEquals([m.get("c-jun"), m.get("c-jul"), m.get("c-aug")], ["jun", "jul", undefined]);
});

Deno.test("match: lines that already have evidence and documents already linked stay out", () => {
  const costs = [cost({ id: "has", evidence_path: "receipts/u/a.pdf" }), cost({ id: "free" })];
  const m = matchEvidence([doc({ id: "taken" }), doc({ id: "new" })], costs, { ...opts, linkedDocIds: new Set(["taken"]) });
  assertEquals([...m], [["free", "new"]]);
});

Deno.test("match: a receipt dated outside the window or for another amount proves nothing", () => {
  assertEquals(matchEvidence([doc({ date: "2026-05-20" })], [cost({})], opts).size, 0);
  assertEquals(matchEvidence([doc({ total_incl: 22.5, total_incl_eur: 22.5 })], [cost({})], opts).size, 0);
  assertEquals(matchEvidence([doc({ kind: "sales_invoice" })], [cost({})], opts).size, 0);
});

Deno.test("sales invoices pair with Nexus invoices by number, ignoring case and separators", () => {
  const docs = [doc({ id: "a", kind: "sales_invoice", reference: "inv 013" }), doc({ id: "b", kind: "sales_invoice", reference: "2026-0001" })];
  const invoices = [{ id: "n13", invoice_number: "INV-013" }, { id: "n12", invoice_number: "INV-012" }];
  assertEquals([...linkSalesInvoices(docs, invoices)], [["a", "n13"]]);
});

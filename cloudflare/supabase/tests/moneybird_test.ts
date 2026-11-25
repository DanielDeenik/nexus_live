// Moneybird link rules on made-up documents and cost lines: how a Moneybird
// document is read, which cost line it proves, and how sales invoices pair up.
import { assertEquals } from "jsr:@std/assert@1";
import { type CostLine, linkSalesInvoices, matchEvidence, type MbDoc, externalSalesInvoice, normalizeDoc, sameShop, toEuro } from "../functions/_shared/moneybird.ts";

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

Deno.test("euro: a dollar document gets its euro total from the day's rate; euro documents stay as they are", () => {
  const usd = doc({ id: "u", currency: "USD", total_incl: 98.7, total_incl_eur: 98.7, date: "2026-08-27" });
  const eur = doc({ id: "e" });
  const out = toEuro([usd, eur], (cur, day) => (cur === "USD" && day === "2026-08-27" ? 0.86 : null));
  assertEquals(out.map((d) => [d.id, d.total_incl_eur]), [["u", 84.88], ["e", 21.78]]);
  assertEquals(toEuro([usd], () => null)[0].total_incl_eur, null);
});

Deno.test("shops: a legal name proves a card line under its trade name only through the alias list", () => {
  const aliases = { ravenpack: "bigdata" };
  assertEquals(sameShop("RavenPack International S.L.U.", "BLS*BIGDATA SUBSCRIPTIO MARBELLA"), false);
  assertEquals(sameShop("RavenPack International S.L.U.", "BLS*BIGDATA SUBSCRIPTIO MARBELLA", aliases), true);
  const usd = doc({ id: "bd", currency: "USD", total_incl: 60.5, total_incl_eur: 52.03, contact: "RavenPack International S.L.U.", date: "2026-11-02" });
  const card = cost({ id: "c-bd", date: "2026-11-02", amount: 53.33, vendor: "BLS*BIGDATA SUBSCRIPTIO MARBELLA" });
  assertEquals([...matchEvidence([usd], [card], { ...opts, aliases })], [["c-bd", "bd"]]);
});

Deno.test("sales invoices: a different number still pairs on currency, amount and date when only one invoice fits", () => {
  const docs = [
    doc({ id: "feb", kind: "sales_invoice", reference: "2026-0002", currency: "CAD", total_incl: 29600, date: "2026-02-27" }),
    doc({ id: "jan", kind: "sales_invoice", reference: "2026-0001", currency: "CAD", total_incl: 22200, date: "2026-01-31" }),
  ];
  const invoices = [
    { id: "n4", invoice_number: "INV-004", amount: 29600, currency: "CAD", issued_date: "2026-02-28" },
    { id: "n6", invoice_number: "INV-006", amount: 29600, currency: "CAD", issued_date: "2026-04-30" },
    { id: "n1", invoice_number: "INV-001", amount: 22200, currency: "CAD", issued_date: "2026-01-30" },
    { id: "n2", invoice_number: "INV-002", amount: 22200, currency: "CAD", issued_date: "2026-01-31" },
  ];
  // February has one fit; January has two (INV-001 and INV-002), so it waits for a person.
  assertEquals([...linkSalesInvoices(docs, invoices, 10)], [["feb", "n4"]]);
});

Deno.test("normalize: an external sales invoice reads its date and its own reference", () => {
  const d = normalizeDoc("sales_invoice", { id: 9, version: 1, date: "2026-03-31", reference: "INV-005", currency: "CAD", total_price_incl_tax: "32560.0", contact: { company_name: "Client Ltd" } });
  assertEquals([d.date, d.reference, d.total_incl], ["2026-03-31", "INV-005", 32560]);
});

Deno.test("external sales invoice: hours times rate when they add up, one line otherwise; tax and ledger from the template", () => {
  const t = { contact_id: "c1", tax_rate_id: "t0", ledger_account_id: "l8" };
  const inv = { invoice_number: "INV-005", issued_date: "2026-03-31", due_date: "2026-04-30", currency: "CAD", amount: 32560, hours: 176, unit_rate: 185, description: null, period_start: "2026-03-01", period_end: "2026-03-31" };
  assertEquals(externalSalesInvoice(inv, t), { external_sales_invoice: {
    contact_id: "c1", reference: "INV-005", date: "2026-03-31", due_date: "2026-04-30", currency: "CAD", prices_are_incl_tax: false,
    details_attributes: [{ description: "Services 2026-03-01 to 2026-03-31", amount: "176", price: "185", tax_rate_id: "t0", ledger_account_id: "l8" }],
  } });
  const odd = externalSalesInvoice({ ...inv, hours: 100, due_date: null, description: "Consulting, October" }, { contact_id: "c1", tax_rate_id: null, ledger_account_id: null });
  assertEquals(odd.external_sales_invoice.details_attributes, [{ description: "Consulting, October", amount: "1", price: "32560" }]);
  assertEquals("due_date" in odd.external_sales_invoice, false);
});

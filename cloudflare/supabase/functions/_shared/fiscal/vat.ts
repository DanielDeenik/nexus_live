// VAT return draft for one period. Turnover is placed by invoice date (the
// tax point); boxes come from the rubriek map in tax_parameters.
import { type ExpenseRow, COUNTABLE, reclaimableVatEur, toEur } from "./costs.ts";
import { type FiscalParams, round2 } from "./params.ts";

export interface VatInvoice {
  id: string;
  issued_date: string;
  voided_at: string | null;
  amount: number;
  currency: string;
  amount_eur: number | null;
  vat_amount: number;
  vat_treatment: string | null;
  fx_rate_eur: number | null;
}

export interface VatExpense extends ExpenseRow { vendor_country: string | null }

export interface VatBox { base_eur: number; vat_eur: number; items: number }

export interface VatDraft {
  period_start: string;
  period_end: string;
  boxes: Record<string, VatBox>;
  input_vat_5b: number;
  output_vat: number;
  payable_5g: number;
  unplaced: { id: string; reason: string }[];
  /** Turnover deliberately left out of the return (e.g. B2B services taxed in
   *  the customer's country outside the EU). */
  not_reported: { base_eur: number; items: number; treatments: string[] };
}

export const EU_COUNTRIES = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","PL","PT","RO","SK","SI","ES","SE",
]);

export function quarterBounds(year: number, q: 1 | 2 | 3 | 4): { start: string; end: string; label: string } {
  const sm = (q - 1) * 3;
  const start = new Date(Date.UTC(year, sm, 1));
  const end = new Date(Date.UTC(year, sm + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), label: `${year}-Q${q}` };
}

export function draftVat(
  invoices: VatInvoice[],
  expenses: VatExpense[],
  periodStart: string,
  periodEnd: string,
  p: FiscalParams,
): VatDraft {
  const boxes: Record<string, VatBox> = {};
  const unplaced: VatDraft["unplaced"] = [];
  const notReported = { base_eur: 0, items: 0, treatments: [] as string[] };
  const add = (box: string, base: number, vat: number) => {
    const b = boxes[box] ?? { base_eur: 0, vat_eur: 0, items: 0 };
    b.base_eur = round2(b.base_eur + base);
    b.vat_eur = round2(b.vat_eur + vat);
    b.items++;
    boxes[box] = b;
  };
  const inPeriod = (d: string) => d >= periodStart && d <= periodEnd;

  for (const inv of invoices) {
    if (inv.voided_at || !inPeriod(inv.issued_date)) continue;
    const base = inv.currency === "EUR" ? inv.amount : inv.amount_eur;
    if (inv.vat_treatment && p.vatNotReported.includes(inv.vat_treatment)) {
      if (base == null) { unplaced.push({ id: inv.id, reason: "no EUR conversion" }); continue; }
      notReported.base_eur = round2(notReported.base_eur + base);
      notReported.items++;
      if (!notReported.treatments.includes(inv.vat_treatment)) notReported.treatments.push(inv.vat_treatment);
      continue;
    }
    const box = inv.vat_treatment ? p.rubriekMap[inv.vat_treatment] : undefined;
    if (!box) { unplaced.push({ id: inv.id, reason: "no VAT treatment set" }); continue; }
    if (base == null) { unplaced.push({ id: inv.id, reason: "no EUR conversion" }); continue; }
    const vatEur = inv.vat_treatment?.startsWith("nl_") ? toEur(inv.vat_amount, inv.currency, inv.fx_rate_eur) : 0;
    if (vatEur == null) { unplaced.push({ id: inv.id, reason: "no EUR conversion for VAT" }); continue; }
    add(box, base, vatEur);
  }

  let input = 0;
  let reverseChargeDue = 0;
  for (const e of expenses) {
    if (!COUNTABLE.has(e.status) || !inPeriod(e.date)) continue;
    if (e.vat_reverse_charge) {
      // Foreign supplier, no VAT on the invoice: owner self-assesses the VAT
      // (due) and, for the business share, deducts the same amount.
      const base = toEur(e.amount, e.currency, e.fx_rate_eur);
      if (base == null) { unplaced.push({ id: e.id, reason: "no EUR conversion" }); continue; }
      const key = e.vendor_country && EU_COUNTRIES.has(e.vendor_country) ? "purchases_eu" : "purchases_services_outside_eu";
      const box = p.rubriekMap[key];
      const due = round2(base * p.vatRates.standard);
      add(box, base, due);
      reverseChargeDue += due;
      if (e.treatment !== "private") input += round2(due * e.business_use_pct);
    } else {
      input += reclaimableVatEur(e);
    }
  }

  const outputFromSales = Object.entries(boxes)
    .filter(([k]) => k === p.rubriekMap.nl_standard || k === p.rubriekMap.nl_reduced)
    .reduce((s, [, b]) => s + b.vat_eur, 0);
  const output = round2(outputFromSales + reverseChargeDue);
  input = round2(input);
  return {
    period_start: periodStart,
    period_end: periodEnd,
    boxes,
    input_vat_5b: input,
    output_vat: output,
    payable_5g: round2(output - input),
    unplaced,
    not_reported: notReported,
  };
}

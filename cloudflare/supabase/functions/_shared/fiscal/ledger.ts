// Income and hours ledger: what was billed, what counts toward the
// urencriterium, and what looks wrong in the invoice series.
import { round2 } from "./params.ts";

export interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  client: string;
  amount: number;
  currency: string;
  amount_eur: number | null;
  status: string;
  issued_date: string; // YYYY-MM-DD
  period_start: string | null;
  period_end: string | null;
  hours: number | null;
  unit_rate: number | null;
  duplicate_of: string | null;
  voided_at: string | null;
}

export interface TimeEntryRow { entry_date: string; hours: number; category: string }

export type AnomalyCode = "duplicate_period" | "numbering_gap" | "amount_mismatch" | "missing_fx";

export interface Anomaly {
  code: AnomalyCode;
  invoice_ids: string[];
  message: string;
}

export interface MonthBucket {
  month: string; // YYYY-MM by service period (falls back to issue date)
  hours: number;
  revenue: Record<string, number>;
  revenue_eur: number;
}

export interface IncomeSummary {
  year: number;
  counted_invoice_ids: string[];
  billed_hours: number;
  revenue_by_currency: Record<string, number>;
  revenue_eur: number;
  revenue_eur_complete: boolean;
  months: MonthBucket[];
  non_billable_hours: number;
  anomalies: Anomaly[];
}

const yearOf = (d: string) => Number(d.slice(0, 4));
const monthOf = (inv: InvoiceRow) => (inv.period_start ?? inv.issued_date).slice(0, 7);

function periodKey(inv: InvoiceRow): string | null {
  if (!inv.period_start || !inv.period_end) return null;
  return [inv.client.trim().toLowerCase(), inv.period_start, inv.period_end, inv.hours ?? "", inv.amount].join("|");
}

function seqNumber(n: string | null): { prefix: string; num: number; width: number } | null {
  if (!n) return null;
  const m = n.match(/^(.*?)(\d+)$/);
  return m ? { prefix: m[1], num: Number(m[2]), width: m[2].length } : null;
}

/** Invoices that should not count: void, explicitly linked duplicates, or
 *  detected same-period duplicates (the earliest-issued one is kept). */
export function detectDuplicates(invoices: InvoiceRow[]): { keep: InvoiceRow[]; anomalies: Anomaly[] } {
  const live = invoices.filter((i) => !i.voided_at && !i.duplicate_of);
  const groups = new Map<string, InvoiceRow[]>();
  const keep: InvoiceRow[] = [];
  for (const inv of live) {
    const k = periodKey(inv);
    if (!k) { keep.push(inv); continue; }
    const g = groups.get(k) ?? [];
    g.push(inv);
    groups.set(k, g);
  }
  const anomalies: Anomaly[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.issued_date.localeCompare(b.issued_date) || (a.invoice_number ?? "").localeCompare(b.invoice_number ?? ""));
    keep.push(g[0]);
    if (g.length > 1) {
      anomalies.push({
        code: "duplicate_period",
        invoice_ids: g.map((i) => i.id),
        message: `${g.map((i) => i.invoice_number ?? i.id).join(", ")} bill the same period ` +
          `${g[0].period_start} to ${g[0].period_end} for ${g[0].client}. Counted once; ` +
          `void the extras or confirm they are separate work.`,
      });
    }
  }
  return { keep, anomalies };
}

export function numberingGaps(invoices: InvoiceRow[]): Anomaly[] {
  const byPrefix = new Map<string, { nums: Set<number>; width: number }>();
  for (const inv of invoices) {
    const s = seqNumber(inv.invoice_number);
    if (!s) continue;
    const e = byPrefix.get(s.prefix) ?? { nums: new Set<number>(), width: s.width };
    e.nums.add(s.num);
    byPrefix.set(s.prefix, e);
  }
  const out: Anomaly[] = [];
  for (const [prefix, { nums, width }] of byPrefix) {
    const sorted = [...nums].sort((a, b) => a - b);
    for (let n = sorted[0] + 1; n < sorted[sorted.length - 1]; n++) {
      if (!nums.has(n)) {
        const label = prefix + String(n).padStart(width, "0");
        out.push({
          code: "numbering_gap",
          invoice_ids: [],
          message: `${label} is missing from the sequence. Add it, or record it as voided.`,
        });
      }
    }
  }
  return out;
}

export function summarizeIncome(
  invoices: InvoiceRow[],
  timeEntries: TimeEntryRow[],
  year: number,
): IncomeSummary {
  const inYear = invoices.filter((i) => yearOf(i.period_start ?? i.issued_date) === year);
  const { keep, anomalies } = detectDuplicates(inYear);
  anomalies.push(...numberingGaps(inYear));

  const months = new Map<string, MonthBucket>();
  const revenue: Record<string, number> = {};
  let hours = 0;
  let eur = 0;
  let eurComplete = true;
  for (const inv of keep) {
    if (inv.hours != null && inv.unit_rate != null && Math.abs(inv.hours * inv.unit_rate - inv.amount) > 0.01) {
      anomalies.push({
        code: "amount_mismatch",
        invoice_ids: [inv.id],
        message: `${inv.invoice_number ?? inv.id}: ${inv.hours} h x ${inv.unit_rate} does not equal ${inv.amount} ${inv.currency}.`,
      });
    }
    if (inv.amount_eur == null && inv.currency !== "EUR") {
      eurComplete = false;
      anomalies.push({
        code: "missing_fx",
        invoice_ids: [inv.id],
        message: `${inv.invoice_number ?? inv.id} has no EUR conversion yet.`,
      });
    }
    const invEur = inv.currency === "EUR" ? inv.amount : inv.amount_eur ?? 0;
    hours += inv.hours ?? 0;
    eur += invEur;
    revenue[inv.currency] = round2((revenue[inv.currency] ?? 0) + inv.amount);
    const m = monthOf(inv);
    const b = months.get(m) ?? { month: m, hours: 0, revenue: {}, revenue_eur: 0 };
    b.hours += inv.hours ?? 0;
    b.revenue[inv.currency] = round2((b.revenue[inv.currency] ?? 0) + inv.amount);
    b.revenue_eur = round2(b.revenue_eur + invEur);
    months.set(m, b);
  }
  const nonBillable = timeEntries
    .filter((t) => yearOf(t.entry_date) === year)
    .reduce((s, t) => s + Number(t.hours), 0);

  return {
    year,
    counted_invoice_ids: keep.map((i) => i.id),
    billed_hours: round2(hours),
    revenue_by_currency: revenue,
    revenue_eur: round2(eur),
    revenue_eur_complete: eurComplete,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    non_billable_hours: round2(nonBillable),
    anomalies,
  };
}

// v2 spend rules, kept pure so they can be tested on made-up data: which bank
// line a receipt or a Wallet tap explains, how a supermarket receipt splits
// into staples and luxury, which charges recur, which review calls apply,
// what the stop list flags and when a cancel is confirmed or broken.
// Every threshold, list and pattern comes from app_config through the caller.
import { sameShop } from "./moneybird.ts";

export interface SpendLine {
  id: string;
  booked_on: string;
  amount: number;
  currency: string;
  merchant: string | null;
  rail: string | null;
  category: string;
}

export interface Item {
  name: string;
  amount: number | null;
  staple: boolean | null;
  period?: string | null;
  renews_on?: string | null;
}

export interface MatchOptions {
  windowDays: number;
  toleranceEur: number;
  /** Rails whose line hides the shop (Klarna card, PayPal): any shop name may match them. */
  hiddenRails?: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: string) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / 86_400_000);
const isoDay = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** The line a purchase explains: money out of the same size and currency, booked inside the
 *  window around the purchase date, from the same shop or from a rail that hides the shop.
 *  Same-shop lines go first, then the closest date. */
function pick(
  shop: string | null, amount: number | null, currency: string | null, date: string | null,
  lines: SpendLine[], taken: Set<string>, o: MatchOptions, allowHidden: boolean,
): SpendLine | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0 || !date) return null;
  const hidden = new Set((o.hiddenRails ?? ["klarna", "paypal"]).map((r) => r.toLowerCase()));
  const d0 = day(date);
  let best: { line: SpendLine; rank: number; gap: number } | null = null;
  for (const l of lines) {
    if (taken.has(l.id) || l.amount >= 0) continue;
    if (currency && l.currency !== currency) continue;
    if (Math.abs(-l.amount - amount) > o.toleranceEur) continue;
    const gap = Math.abs(day(l.booked_on) - d0);
    if (gap > o.windowDays) continue;
    const same = sameShop(shop, l.merchant);
    const rail = allowHidden && !!l.rail && hidden.has(l.rail.toLowerCase());
    if (!same && !rail) continue;
    const rank = same ? 0 : 1;
    if (!best || rank < best.rank || (rank === best.rank && gap < best.gap)) best = { line: l, rank, gap };
  }
  return best?.line ?? null;
}

export function matchReceipt(
  r: { merchant: string | null; total: number | null; currency: string | null; date: string | null },
  lines: SpendLine[], taken: Set<string>, o: MatchOptions,
): SpendLine | null {
  return pick(r.merchant, r.total, r.currency, r.date, lines, taken, o, true);
}

export function matchTap(
  t: { merchant: string; amount: number | null; currency: string; tapped_at: string },
  lines: SpendLine[], taken: Set<string>, o: MatchOptions,
): SpendLine | null {
  return pick(t.merchant, t.amount, t.currency, t.tapped_at, lines, taken, o, false);
}

/** True when the item is a staple: the reader's flag when it gave one, else a word of the staples list in its name. */
export function isStaple(item: Item, staples: string[]): boolean {
  if (typeof item.staple === "boolean") return item.staple;
  const name = item.name.toLowerCase();
  return staples.some((s) => {
    const word = s.toLowerCase().replace(/s$/, "");
    return word.length > 0 && name.includes(word);
  });
}

/** Spreads a supermarket line (money out, negative) over the two food lines by the share of
 *  staple items on the receipt. Returns no split when there is nothing to split: no priced items,
 *  or no staples (the line then stays in the luxury line its rule gave it). */
export function foodSplit(
  lineAmount: number, items: Item[], staples: string[], cats: { staples: string; luxury: string },
): { category: string; amount: number }[] {
  const priced = items.filter((i) => typeof i.amount === "number" && Number.isFinite(i.amount) && (i.amount as number) > 0);
  if (!priced.length || priced.length < items.length) return [];
  const all = priced.reduce((s, i) => s + (i.amount as number), 0);
  const staple = priced.filter((i) => isStaple(i, staples)).reduce((s, i) => s + (i.amount as number), 0);
  if (all <= 0 || staple <= 0) return [];
  const total = Math.abs(lineAmount);
  const sign = lineAmount < 0 ? -1 : 1;
  const stapleAmount = round2(total * Math.min(1, staple / all));
  const luxuryAmount = round2(total - stapleAmount);
  const out = [{ category: cats.staples, amount: sign * stapleAmount }];
  if (luxuryAmount > 0) out.push({ category: cats.luxury, amount: sign * luxuryAmount });
  return out;
}

/** A receipt counts for the split when it arrives no later than the given days after the purchase
 *  or the booking, whichever is later. */
export function receiptInTime(receivedAt: string, purchaseDate: string | null, bookedOn: string, days: number): boolean {
  const start = Math.max(day(bookedOn), purchaseDate ? day(purchaseDate) : day(bookedOn));
  return day(receivedAt) <= start + days;
}

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";
export interface RecurringOptions {
  minCharges: number;
  cadenceDays: Record<Cadence, [number, number]>;
  tolerancePct: number;
  today: string;
  /** Days past the longest gap of its cadence that the next charge may be late and the charge still runs. */
  graceDays: number;
}
export interface RecurringFound {
  key: string;
  label: string;
  category: string;
  cadence: Cadence;
  amount: number;
  per_year: number;
  charges: number;
  paid_this_year: number;
  last_charge: string;
  next_due: string;
}

const perYear: Record<Cadence, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A gap fits the cadence when it is one period, or a whole number of periods (a skipped bill). */
const fitsCadence = (gap: number, [lo, hi]: [number, number]) => {
  const periods = Math.max(1, Math.round(gap / ((lo + hi) / 2)));
  return gap >= lo * periods && gap <= hi * periods;
};

/** Recurring charges: per shop, charges of about the same amount (within the tolerance) where
 *  every gap fits one cadence, and the last charge is recent enough that the charge still runs.
 *  One shop billing several subscriptions (Apple) gives one charge per amount. */
export function detectRecurring(lines: SpendLine[], o: RecurringOptions): RecurringFound[] {
  const byShop = new Map<string, SpendLine[]>();
  for (const l of lines) {
    if (l.amount >= 0 || !l.merchant) continue;
    const k = squash(l.merchant);
    if (!k) continue;
    byShop.set(k, [...(byShop.get(k) ?? []), l]);
  }
  const out: RecurringFound[] = [];
  const year = o.today.slice(0, 4);
  for (const [shop, group] of byShop) {
    const sorted = [...group].sort((a, b) => -a.amount - -b.amount);
    const clusters: SpendLine[][] = [];
    for (const l of sorted) {
      const c = clusters.at(-1);
      if (c && -l.amount <= -c[0].amount * (1 + o.tolerancePct / 100)) c.push(l);
      else clusters.push([l]);
    }
    const found: RecurringFound[] = [];
    for (const c of clusters) {
      if (c.length < o.minCharges) continue;
      const byDate = [...c].sort((a, b) => a.booked_on.localeCompare(b.booked_on));
      const gaps = byDate.slice(1).map((l, i) => day(l.booked_on) - day(byDate[i].booked_on));
      const g = median(gaps);
      const cadence = (Object.keys(o.cadenceDays) as Cadence[]).find((k) => g >= o.cadenceDays[k][0] && g <= o.cadenceDays[k][1]);
      if (!cadence || !gaps.every((x) => fitsCadence(x, o.cadenceDays[cadence]))) continue;
      const last = byDate.at(-1)!;
      if (day(o.today) - day(last.booked_on) > o.cadenceDays[cadence][1] + o.graceDays) continue;
      const amount = round2(median(c.map((l) => -l.amount)));
      const next = cadence === "weekly" ? isoDay(day(last.booked_on) + 7)
        : addMonths(last.booked_on, cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12);
      found.push({
        key: `${shop}|${Math.round(amount)}`,
        label: last.merchant!,
        category: last.category,
        cadence,
        amount,
        per_year: round2(amount * perYear[cadence]),
        charges: c.length,
        paid_this_year: round2(c.filter((l) => l.booked_on.startsWith(year)).reduce((s, l) => s - l.amount, 0)),
        last_charge: last.booked_on,
        next_due: next,
      });
    }
    if (found.length > 1) for (const f of found) f.label = `${f.label} ${f.amount.toFixed(2)}`;
    out.push(...found);
  }
  return out.sort((a, b) => b.per_year - a.per_year);
}

/** Rows a run no longer finds and that carry nothing of yours (no decision, no cancel status):
 *  they go, so the review shows only charges that still run. */
export function staleRecurring(
  rows: { id: string; key: string; decided_at: string | null; status: string | null }[], found: Set<string>,
): string[] {
  return rows.filter((r) => !found.has(r.key) && !r.decided_at && !r.status).map((r) => r.id);
}

export type Call = "keep" | "cancel" | "move_business";
export type Tag = "social_arb" | "net_worth" | "life" | "cut";
export interface CallRule { pattern: string; call: Call; tag?: Tag; note?: string }
export interface CallState { label: string; call: Call | null; tag: Tag | null; proposed_call: Call | null; note: string | null }

/** Your standing calls apply to matching charges; suggestions only fill proposed_call.
 *  A call already on the row (yours) is never changed. */
export function applyCalls<T extends CallState>(row: T, standing: CallRule[], proposals: CallRule[]): T {
  const hit = (rules: CallRule[]) => rules.find((r) => new RegExp(r.pattern, "i").test(row.label));
  const out = { ...row };
  if (!out.call) {
    const s = hit(standing);
    if (s) {
      out.call = s.call;
      out.tag = out.tag ?? s.tag ?? null;
      out.note = out.note ?? s.note ?? null;
      return out;
    }
  }
  if (!out.call && !out.proposed_call) {
    const p = hit(proposals);
    if (p) {
      out.proposed_call = p.call;
      out.note = out.note ?? p.note ?? null;
    }
  }
  return out;
}

/** A stop list: shops that are not allowed from a date. Each one is a pair of settings,
 *  stop.<name>_pattern and stop.<name>_from; its alerts carry the name as their kind. */
export interface StopList { name: string; label: string; pattern: string; from: string }

/** Every stop list in the settings: a stop.<name>_pattern with a stop.<name>_from beside it.
 *  A pattern without a start date (stop.apple_line_pattern) is not a stop list. */
export function stopLists(cfg: Record<string, string | undefined>): StopList[] {
  const out: StopList[] = [];
  for (const [key, pattern] of Object.entries(cfg)) {
    const name = /^stop\.([a-z0-9_]+)_pattern$/.exec(key)?.[1];
    const from = name ? cfg[`stop.${name}_from`] : undefined;
    if (!name || !pattern || !from) continue;
    out.push({ name, label: name.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()), pattern, from });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface StopConfig {
  lists: StopList[];
  appleLinePattern: string;
  /** From this date Apple charges outside the allowed list alert; null: no Apple stop date. */
  appleFrom: string | null;
  appleAllowed: string[];
}
export interface StopReceipt { id: string; kind: string; order_date: string | null; txn_id: string | null; items: Item[] }
export interface StopAlert { kind: string; ref: string; title: string; detail: string; txn_id: string | null }

const allowedItem = (name: string, allowed: string[]) =>
  allowed.some((a) => squash(name).includes(squash(a)) || squash(a).includes(squash(name)));

/** The stop lists: a charge on a list from its start date, and from the Apple stop date any Apple
 *  charge that no allowed receipt explains. One alert per line or receipt (the ref). */
export function stopAlerts(input: { lines: SpendLine[]; receipts: StopReceipt[] }, c: StopConfig): StopAlert[] {
  const lists = c.lists.map((s) => ({ ...s, re: new RegExp(s.pattern, "i") }));
  const onList = (name: string) => lists.some((s) => s.re.test(name));
  const apple = new RegExp(c.appleLinePattern, "i");
  const out: StopAlert[] = [];
  for (const l of input.lines) {
    if (l.amount >= 0 || !l.merchant) continue;
    for (const s of lists) {
      if (l.booked_on < s.from || !s.re.test(l.merchant)) continue;
      out.push({ kind: s.name, ref: `line:${l.id}`, title: `${s.label} charge: ${l.merchant}`, detail: `${(-l.amount).toFixed(2)} ${l.currency} on ${l.booked_on}. Not allowed since ${s.from}.`, txn_id: l.id });
    }
  }
  const explained = new Set<string>();
  for (const r of input.receipts) {
    if (r.kind !== "apple") continue;
    const date = r.order_date ?? "";
    r.items.forEach((it, i) => {
      for (const s of lists) {
        if (date < s.from || !s.re.test(it.name)) continue;
        out.push({ kind: s.name, ref: `receipt:${r.id}:${i}`, title: `${s.label} purchase on Apple: ${it.name}`, detail: `${it.amount ?? "?"} on ${date}. Not allowed since ${s.from}.`, txn_id: r.txn_id });
      }
    });
    const outside = r.items.filter((it) => !allowedItem(it.name, c.appleAllowed) && !onList(it.name));
    if (c.appleFrom && date >= c.appleFrom && outside.length) {
      out.push({ kind: "apple_outside", ref: `receipt:${r.id}`, title: `Apple purchase outside the allowed list: ${outside.map((i) => i.name).join(", ")}`, detail: `On ${date}. Allowed after ${c.appleFrom}: ${c.appleAllowed.join(", ")}.`, txn_id: r.txn_id });
    }
    if (r.txn_id && r.items.length && r.items.every((it) => allowedItem(it.name, c.appleAllowed))) explained.add(r.txn_id);
    if (r.txn_id && (outside.length || r.items.some((it) => onList(it.name)))) explained.add(r.txn_id);
  }
  if (!c.appleFrom) return out;
  for (const l of input.lines) {
    if (l.amount >= 0 || !l.merchant || l.booked_on < c.appleFrom || !apple.test(l.merchant) || explained.has(l.id)) continue;
    out.push({ kind: "apple_outside", ref: `line:${l.id}`, title: `Apple charge ${(-l.amount).toFixed(2)} ${l.currency} on ${l.booked_on}`, detail: `No receipt shows it is ${c.appleAllowed.join(" or ")}.`, txn_id: l.id });
  }
  return out;
}

/** Cancel follow-up: a charge after you requested the cancel breaks it; the expected charge
 *  date passing (plus the grace days) with no charge confirms it. */
export function cancelUpdates(
  rows: { id: string; key: string; status: string | null; decided_at: string | null; next_due: string | null; call: string | null }[],
  chargesByKey: Map<string, string[]>, today: string, graceDays: number,
): { id: string; status: "charged_after_cancel" | "confirmed"; charged_on: string | null }[] {
  const out: { id: string; status: "charged_after_cancel" | "confirmed"; charged_on: string | null }[] = [];
  for (const r of rows) {
    if (r.call !== "cancel" || (r.status !== "requested" && r.status !== "confirmed")) continue;
    const since = (r.decided_at ?? "").slice(0, 10);
    const after = (chargesByKey.get(r.key) ?? []).filter((d) => d >= since).sort();
    if (after.length) {
      out.push({ id: r.id, status: "charged_after_cancel", charged_on: after[0] });
    } else if (r.status === "requested" && r.next_due && day(r.next_due) + graceDays < day(today)) {
      out.push({ id: r.id, status: "confirmed", charged_on: null });
    }
  }
  return out;
}

export interface Reading {
  kind: "order" | "apple" | "grocery" | "other";
  merchant: string | null;
  total: number | null;
  currency: string | null;
  date: string | null;
  items: Required<Item>[];
}

const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.replace(/[^\d,.-]/g, "");
  const n = Number(t.includes(",") && !t.includes(".") ? t.replace(",", ".") : t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const toDate = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const toText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The model's reading in clean types; anything it could not show stays null. */
export function cleanReading(raw: Record<string, unknown>): Reading {
  const kinds = ["order", "apple", "grocery", "other"];
  const items = Array.isArray(raw.items) ? raw.items as Record<string, unknown>[] : [];
  return {
    kind: (kinds.includes(String(raw.kind)) ? raw.kind : "other") as Reading["kind"],
    merchant: toText(raw.merchant),
    total: toNumber(raw.total),
    currency: toText(raw.currency)?.toUpperCase() ?? null,
    date: toDate(raw.date),
    items: items
      .filter((i) => toText(i?.name))
      .map((i) => ({
        name: toText(i.name)!,
        amount: toNumber(i.amount),
        staple: typeof i.staple === "boolean" ? i.staple : null,
        period: toText(i.period),
        renews_on: toDate(i.renews_on),
      })),
  };
}

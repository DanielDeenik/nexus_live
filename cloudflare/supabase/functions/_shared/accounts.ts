// Pure rules behind the Accounts screen: which bank lines are new, which bank
// account feeds which Nexus account, and what Nexus still needs from you.
import type { BankRow } from "./enableBanking.ts";

export interface CatalogItem {
  id: string;
  name: string;
  kind: string;
  via: "enable_banking" | "enable_banking_app" | "wise_token" | "etoro_keys" | "google_oauth";
  aspsp?: string;
  country?: string;
  source?: string;
  open_url?: string;
  help_url?: string;
  help?: string;
  optional?: boolean;
}

export function parseCatalog(raw: string | undefined): CatalogItem[] {
  if (!raw) throw new Error("app_config integrations.catalog is missing");
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("app_config integrations.catalog must be a JSON array");
  return items as CatalogItem[];
}

const DAY_MS = 86_400_000;
const dayNumber = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / DAY_MS;
const cents = (x: number) => Math.round(x * 100);

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Bank lines Nexus does not have yet. A line already in Nexus (from an export
 *  or an earlier sync) absorbs one bank line of the same amount: the same day
 *  first, then the nearest day within the window, since export dates and
 *  booking dates can differ by a day or two. */
export function newRows(rows: BankRow[], existing: { date: string; amount: number }[], windowDays: number): BankRow[] {
  const pool = existing.map((e) => ({ day: dayNumber(e.date), amount: cents(e.amount), used: false }));
  const keyed = rows.map((r) => ({ day: dayNumber(r.date), amount: cents(r.amount) }));
  const matched = new Array(rows.length).fill(false);
  keyed.forEach((r, i) => {
    const hit = pool.find((e) => !e.used && e.amount === r.amount && e.day === r.day);
    if (hit) { hit.used = true; matched[i] = true; }
  });
  keyed.forEach((r, i) => {
    if (matched[i]) return;
    let best = -1;
    let gap = Infinity;
    pool.forEach((e, k) => {
      if (e.used || e.amount !== r.amount) return;
      const g = Math.abs(e.day - r.day);
      if (g <= windowDays && g < gap) { best = k; gap = g; }
    });
    if (best >= 0) { pool[best].used = true; matched[i] = true; }
  });
  return rows.filter((_, i) => !matched[i]);
}

export interface NexusAccount { source: string; account: string; label: string; kind: string }
export interface BankAccount { uid: string; last4: string | null; name: string | null; currency: string | null }

/** Pairs each bank account with a Nexus account of the same bank: by the last
 *  four characters, then the only one left on each side. Unpaired bank
 *  accounts get a new Nexus account. */
export function mapAccounts(bank: BankAccount[], nexus: NexusAccount[], source: string): Map<string, NexusAccount | null> {
  const mine = nexus.filter((a) => a.source === source);
  const out = new Map<string, NexusAccount | null>();
  const taken = new Set<string>();
  for (const b of bank) {
    const hit = b.last4 ? mine.find((a) => !taken.has(a.account) && a.account.toUpperCase() === b.last4!.toUpperCase()) : undefined;
    if (hit) { out.set(b.uid, hit); taken.add(hit.account); }
  }
  const leftBank = bank.filter((b) => !out.has(b.uid));
  const leftNexus = mine.filter((a) => !taken.has(a.account));
  if (leftBank.length === 1 && leftNexus.length === 1) {
    out.set(leftBank[0].uid, leftNexus[0]);
    leftBank.length = 0;
  }
  for (const b of leftBank) out.set(b.uid, null);
  return out;
}

/** Day-whole batches: identical lines on one day stay together so their numbering holds. */
export function dayBatches<T extends { date: string }>(rows: T[], limit: number): T[][] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const out: T[][] = [];
  let batch: T[] = [];
  let last = "";
  for (const r of sorted) {
    if (batch.length >= limit && r.date !== last) { out.push(batch); batch = []; }
    batch.push(r);
    last = r.date;
  }
  if (batch.length) out.push(batch);
  return out;
}

export interface Need {
  code: string;
  severity: "info" | "warn";
  title: string;
  detail: string;
  /** connect, import, plan, review, open or none */
  action: string;
  service_id: string | null;
  review_item_id: string | null;
  /** Button labels for a review decision: approve first, reject second. */
  decide: { approve: string; reject: string } | null;
  dismissible: boolean;
}

export interface AccountState {
  label: string;
  source: string;
  account: string;
  kind: string;
  balance: number;
  last_booked: string | null;
  bank_balance: number | null;
  bank_balance_date: string | null;
  feed: "bank" | "file";
}

export interface ServiceState {
  item: CatalogItem;
  status: "connected" | "not_connected" | "error" | "unavailable";
  detail: string | null;
  valid_until: string | null;
}

export interface NeedInputs {
  today: string;
  services: ServiceState[];
  accounts: AccountState[];
  staleDays: number;
  consentWarnDays: number;
  balanceTolerance: number;
  forecastWarnings: { code: string; severity: string; message: string }[];
  reviews: { id: string; summary: string; item_type: string; reason_codes: string[] }[];
  nextYearPlanned: boolean;
  nextYear: number;
  manual: { code: string; title: string; detail: string; until?: string }[];
  dismissed: Set<string>;
  formatMoney: (x: number) => string;
}

/** What approve and reject do for a review item, in words; null when the app cannot decide it. */
export function reviewButtons(itemType: string, reasons: string[]): { approve: string; reject: string; detail: string } | null {
  if (itemType !== "filing") return null;
  if (reasons.includes("changed_after_approval")) {
    return { approve: "New draft", reject: "Keep approved", detail: "The books changed after you approved this draft. New draft rebuilds it from today's books for you to check; Keep approved leaves it as it is." };
  }
  return { approve: "Approve", reject: "Reject", detail: "Approve signs off this draft; Reject drops it." };
}

/** Everything Nexus needs from you, most urgent first. */
export function buildNeeds(i: NeedInputs): Need[] {
  const needs: Need[] = [];
  const add = (n: Omit<Need, "service_id" | "review_item_id" | "decide" | "dismissible"> & Partial<Need>) =>
    needs.push({ service_id: null, review_item_id: null, decide: null, dismissible: false, ...n });

  for (const r of i.reviews) {
    const decide = reviewButtons(r.item_type, r.reason_codes);
    add({
      code: `review_${r.id}`, severity: "warn", title: r.summary, detail: decide?.detail ?? "This review needs the full review screen; the app cannot decide it yet.",
      action: decide ? "review" : "none", review_item_id: r.id, decide: decide ? { approve: decide.approve, reject: decide.reject } : null,
    });
  }
  for (const w of i.forecastWarnings) {
    add({ code: `forecast_${w.code}`, severity: w.severity === "info" ? "info" : "warn", title: w.message, detail: "From the tax forecast.", action: "plan" });
  }
  for (const a of i.accounts) {
    if (a.bank_balance != null && Math.abs(a.bank_balance - a.balance) > i.balanceTolerance) {
      add({
        code: `balance_${a.source}_${a.account}`, severity: "warn", title: `${a.label}: the bank says ${i.formatMoney(a.bank_balance)}, Nexus has ${i.formatMoney(a.balance)}`,
        detail: "A line is missing or counted twice. Sync again or import an export covering the gap.", action: a.feed === "bank" ? "connect" : "import",
        service_id: a.source,
      });
    }
    // An empty account with no recent lines is dormant, not missing data.
    const age = a.last_booked ? dayNumber(i.today) - dayNumber(a.last_booked) : Infinity;
    if (age > i.staleDays && Math.abs(a.balance) > i.balanceTolerance) {
      add({
        code: `stale_${a.source}_${a.account}`, severity: "warn",
        title: a.last_booked ? `${a.label}: newest line ${a.last_booked}` : `${a.label}: no lines yet`,
        detail: a.feed === "bank" ? "The bank sync has not brought new lines. Check the connection." : "Connect the bank, or import a fresh export.",
        action: a.feed === "bank" ? "connect" : "import", service_id: a.source,
      });
    }
  }
  // Banks connect through Enable Banking: until it is set up, one item covers them all.
  const bankApp = i.services.find((s) => s.item.via === "enable_banking_app");
  const banksWaiting = !bankApp || bankApp.status !== "connected";
  const waitingNames = i.services.filter((s) => s.item.via === "enable_banking" && !s.item.optional && s.status === "not_connected").map((s) => s.item.name);
  for (const s of i.services) {
    if (banksWaiting && s.item.via === "enable_banking" && s.status === "not_connected") continue;
    if (s.item.via === "enable_banking_app" && s.status === "not_connected" && waitingNames.length) {
      add({
        code: `connect_${s.item.id}`, severity: "info", title: `Set up ${s.item.name} to connect ${waitingNames.join(" and ")}`,
        detail: s.item.help ?? "One setup, then each bank is a sign in.", action: "connect", service_id: s.item.id, dismissible: true,
      });
      continue;
    }
    if (s.status === "error") {
      add({ code: `error_${s.item.id}`, severity: "warn", title: `${s.item.name}: the connection failed`, detail: s.detail ?? "Connect it again.", action: "connect", service_id: s.item.id });
    } else if (s.status === "connected" && s.valid_until) {
      const left = dayNumber(s.valid_until) - dayNumber(i.today);
      if (left <= i.consentWarnDays) {
        add({ code: `consent_${s.item.id}`, severity: "warn", title: `${s.item.name}: consent ends ${s.valid_until.slice(0, 10)}`, detail: "Renew it so the daily sync keeps running.", action: "connect", service_id: s.item.id });
      }
    } else if (s.status === "not_connected" && !s.item.optional) {
      add({ code: `connect_${s.item.id}`, severity: "info", title: `Connect ${s.item.name}`, detail: s.item.help ?? "Read only. Keys stay in the vault.", action: "connect", service_id: s.item.id, dismissible: true });
    } else if (s.status === "unavailable" && !s.item.optional) {
      add({ code: `unavailable_${s.item.id}`, severity: "info", title: `${s.item.name} cannot connect yet`, detail: s.detail ?? "Not set up on the server.", action: "none", service_id: s.item.id, dismissible: true });
    }
  }
  if (!i.nextYearPlanned) {
    add({ code: `plan_${i.nextYear}`, severity: "info", title: `Plan your days off in ${i.nextYear}`, detail: "The next-year tax and the monthly set-aside assume you work every working day.", action: "plan", dismissible: true });
  }
  for (const m of i.manual) {
    if (m.until && m.until < i.today) continue;
    add({ code: m.code, severity: "info", title: m.title, detail: m.detail, action: "none", dismissible: true });
  }
  const order = { warn: 0, info: 1 };
  return needs.filter((n) => !(n.dismissible && i.dismissed.has(n.code))).sort((a, b) => order[a.severity] - order[b.severity]);
}

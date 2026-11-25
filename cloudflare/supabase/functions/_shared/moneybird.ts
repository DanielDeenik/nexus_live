// Moneybird: read the books, and the rules for what a document proves.
// The API base, the request pace and every matching tolerance come from app_config;
// the personal API token comes from Vault through integration_connections.

export type MbKind = "receipt" | "purchase_invoice" | "sales_invoice";

/** The API paths of each document kind, under /{administration_id}/. Sales invoices made
 *  outside Moneybird live under external_sales_invoices; Nexus treats both as sales invoices. */
export const MB_PATHS: Record<MbKind, string[]> = {
  receipt: ["documents/receipts"],
  purchase_invoice: ["documents/purchase_invoices"],
  sales_invoice: ["sales_invoices", "external_sales_invoices"],
};

export interface MbDoc {
  id: string;
  kind: MbKind;
  version: number;
  date: string | null;
  reference: string | null;
  contact: string | null;
  currency: string;
  total_incl: number | null;
  total_incl_eur: number | null;
  total_excl_eur: number | null;
  state: string | null;
  paid_at: string | null;
  attachments: number;
}

/** A business cost line in Nexus (expenses) that a receipt can prove. */
export interface CostLine {
  id: string;
  date: string;
  amount: number;
  currency: string;
  vendor: string | null;
  description: string | null;
  evidence_path: string | null;
}

export interface MatchOptions {
  toleranceEur: number; // same-currency amounts may differ by this much
  tolerancePct: number; // a foreign-currency document against a euro line: percent of the line
  windowDays: number; // document date to payment date
  linkedDocIds?: Set<string>; // documents that already prove a line
  aliases?: Record<string, string>; // legal name word -> trade name word, from app_config
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function contactName(c: unknown): string | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Raw;
  return text(o.company_name) ?? text([o.firstname, o.lastname].filter((x) => typeof x === "string" && x).join(" "));
}

export function normalizeDoc(kind: MbKind, raw: Raw): MbDoc {
  const sales = kind === "sales_invoice";
  const currency = text(raw.currency) ?? "EUR";
  const total = num(raw.total_price_incl_tax);
  return {
    id: String(raw.id),
    kind,
    version: Number(raw.version),
    date: text(sales ? (raw.invoice_date ?? raw.date) : raw.date),
    reference: text(sales ? (raw.invoice_id ?? raw.reference) : raw.reference),
    contact: contactName(raw.contact),
    currency,
    total_incl: total,
    total_incl_eur: num(raw.total_price_incl_tax_base) ?? (currency === "EUR" ? total : null),
    total_excl_eur: num(raw.total_price_excl_tax_base),
    state: text(raw.state),
    paid_at: text(raw.paid_at),
    attachments: Array.isArray(raw.attachments) ? raw.attachments.length : 0,
  };
}

// Words that say nothing about which shop it is.
const GENERIC = new Set([
  "the", "inc", "ltd", "llc", "pbc", "pte", "gmbh", "com", "www", "limited", "corp", "company", "via", "sub",
  "subscription", "subscriptio", "new", "york", "san", "francisco", "dublin", "london", "services", "service",
]);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t));

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Documents in another currency get their euro total from the day's rate (Moneybird's own
 *  base amount is only filled once a document is processed). No rate, no euro total. */
export function toEuro(docs: MbDoc[], rate: (currency: string, day: string) => number | null): MbDoc[] {
  return docs.map((d) => {
    if (d.currency === "EUR" || d.total_incl == null || !d.date) return d;
    const r = rate(d.currency, d.date);
    return { ...d, total_incl_eur: r == null ? null : round2(d.total_incl * r) };
  });
}

/** True when a word of one name appears in the other (card lines glue words together).
 *  Aliases add the trade name for a legal name (RavenPack sells Bigdata.com). */
export function sameShop(a: string | null, b: string | null, aliases: Record<string, string> = {}): boolean {
  if (!a || !b) return false;
  const expand = (x: string) => [x, ...Object.entries(aliases).filter(([k]) => squash(x).includes(squash(k))).map(([, v]) => v)].join(" ");
  a = expand(a);
  b = expand(b);
  const sa = squash(a), sb = squash(b);
  return tokens(a).some((t) => sb.includes(t)) || tokens(b).some((t) => sa.includes(t));
}

const dayNumber = (d: string) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / 86_400_000);

/** Which document proves which cost line: amount, shop and date, one document per line. */
export function matchEvidence(docs: MbDoc[], costs: CostLine[], o: MatchOptions): Map<string, string> {
  const pairs: { cost: string; doc: string; shop: number; days: number; diff: number }[] = [];
  for (const d of docs) {
    if (d.kind === "sales_invoice" || !d.date || o.linkedDocIds?.has(d.id)) continue;
    for (const c of costs) {
      if (c.evidence_path) continue;
      const days = Math.abs(dayNumber(d.date) - dayNumber(c.date));
      if (days > o.windowDays) continue;
      const amount = Math.abs(c.amount);
      const shop = sameShop(d.contact, c.vendor ?? c.description, o.aliases);
      let diff: number;
      if (d.currency === c.currency && d.total_incl != null) {
        diff = Math.abs(amount - d.total_incl);
        if (diff > o.toleranceEur) continue;
      } else {
        if (d.total_incl_eur == null || !shop) continue;
        diff = Math.abs(amount - d.total_incl_eur);
        if (diff > (amount * o.tolerancePct) / 100) continue;
      }
      pairs.push({ cost: c.id, doc: d.id, shop: shop ? 1 : 0, days, diff });
    }
  }
  pairs.sort((a, b) => b.shop - a.shop || a.days - b.days || a.diff - b.diff);
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.cost) || used.has(p.doc)) continue;
    out.set(p.cost, p.doc);
    used.add(p.doc);
  }
  return out;
}

export interface NexusInvoice {
  id: string;
  invoice_number: string | null;
  amount?: number | null;
  currency?: string | null;
  issued_date?: string | null;
}

/** Moneybird sales invoices paired with Nexus invoices: by number (case and separators
 *  ignored), otherwise by currency, amount and date when exactly one invoice fits. */
export function linkSalesInvoices(docs: MbDoc[], invoices: NexusInvoice[], windowDays = 0): Map<string, string> {
  const byNumber = new Map<string, string>();
  for (const inv of invoices) if (inv.invoice_number) byNumber.set(squash(inv.invoice_number), inv.id);
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const d of docs) {
    if (d.kind !== "sales_invoice") continue;
    const hit = d.reference ? byNumber.get(squash(d.reference)) : undefined;
    if (hit && !taken.has(hit)) { out.set(d.id, hit); taken.add(hit); continue; }
    if (!d.date || d.total_incl == null) continue;
    const fits = invoices.filter((inv) => !taken.has(inv.id) && inv.currency === d.currency && inv.amount != null && inv.issued_date &&
      Math.abs(Number(inv.amount) - d.total_incl!) < 0.005 && Math.abs(dayNumber(inv.issued_date) - dayNumber(d.date!)) <= windowDays);
    if (fits.length === 1) { out.set(d.id, fits[0].id); taken.add(fits[0].id); }
  }
  return out;
}

// ---------------------------------------------------------------- API

export interface MbClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  upload<T>(path: string, filename: string, bytes: Uint8Array, mime: string): Promise<T>;
}

/** A paced client: at most `perMinute` requests a minute, one retry after a 429. */
export function mbClient(apiBase: string, token: string, perMinute: number): MbClient {
  const gap = 60_000 / perMinute;
  let last = 0;
  const call = async <T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      if (res.status === 429 && attempt === 0) {
        const after = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : gap));
        continue;
      }
      if (!res.ok) throw new Error(`Moneybird ${method} ${path.split("?")[0]}: ${res.status}`);
      return await res.json() as T;
    }
    throw new Error(`Moneybird ${method} ${path}: rate limited`);
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    upload: (p, filename, bytes, mime) => {
      const form = new FormData();
      form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
      return call("POST", p, undefined, form);
    },
  };
}

export async function administrations(c: MbClient): Promise<{ id: string; name: string }[]> {
  const list = await c.get<{ id: string | number; name: string }[]>("/administrations.json");
  return list.map((a) => ({ id: String(a.id), name: a.name }));
}

/** The documents of one kind whose version changed, and every id Moneybird still has. */
export async function changedDocs(c: MbClient, adminId: string, kind: MbKind, known: Map<string, number>): Promise<{ docs: MbDoc[]; ids: Set<string> }> {
  const ids = new Set<string>();
  const docs: MbDoc[] = [];
  for (const p of MB_PATHS[kind]) {
    const path = `/${adminId}/${p}/synchronization.json`;
    const list = await c.get<{ id: string | number; version: number }[]>(path);
    for (const x of list) ids.add(String(x.id));
    const todo = list.filter((x) => known.get(String(x.id)) !== Number(x.version)).map((x) => String(x.id));
    for (let i = 0; i < todo.length; i += 100) {
      const batch = await c.post<Raw[]>(path, { ids: todo.slice(i, i + 100) });
      for (const raw of batch) docs.push(normalizeDoc(kind, raw));
    }
  }
  return { docs, ids };
}

export interface SalesTemplate { contact_id: string; tax_rate_id: string | null; ledger_account_id: string | null }
export interface InvoiceForBooks {
  invoice_number: string;
  issued_date: string;
  due_date: string | null;
  currency: string;
  amount: number;
  hours: number | null;
  unit_rate: number | null;
  description: string | null;
  period_start: string | null;
  period_end: string | null;
}

/** A Nexus invoice as a Moneybird external sales invoice, with the client, VAT rate and
 *  revenue account of an invoice already in the books. Hours times rate when they add up. */
export function externalSalesInvoice(inv: InvoiceForBooks, t: SalesTemplate) {
  const byHours = inv.hours != null && inv.unit_rate != null && Math.abs(inv.hours * inv.unit_rate - inv.amount) < 0.01;
  const detail: Record<string, string> = {
    description: inv.description ?? `Services ${inv.period_start} to ${inv.period_end}`,
    amount: byHours ? String(inv.hours) : "1",
    price: byHours ? String(inv.unit_rate) : String(inv.amount),
  };
  if (t.tax_rate_id) detail.tax_rate_id = t.tax_rate_id;
  if (t.ledger_account_id) detail.ledger_account_id = t.ledger_account_id;
  const body: Record<string, unknown> = {
    contact_id: t.contact_id, reference: inv.invoice_number, date: inv.issued_date, currency: inv.currency, prices_are_incl_tax: false,
    details_attributes: [detail],
  };
  if (inv.due_date) body.due_date = inv.due_date;
  return { external_sales_invoice: body as Record<string, unknown> & { details_attributes: Record<string, string>[] } };
}

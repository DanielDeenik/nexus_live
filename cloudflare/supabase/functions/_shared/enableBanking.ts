// Enable Banking (PSD2 account information). Every request carries a
// short-lived RS256 token signed with the application's private key; the key
// id is the application id. Keys live in Vault; this module only signs.
import { round2 } from "./fiscal/params.ts";

export interface EbCredentials { app_id: string; private_key: string }

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** Wraps a PKCS#1 RSAPrivateKey ("BEGIN RSA PRIVATE KEY") in a PKCS#8 PrivateKeyInfo. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  // AlgorithmIdentifier { rsaEncryption, NULL }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const key = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [...version, ...algorithm, ...key];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

/** The DER bytes of a PEM private key, as PKCS#8. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const m = pem.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (?:RSA )?PRIVATE KEY-----/);
  if (!m) throw new Error("that is not a private key file (.pem)");
  const der: Uint8Array<ArrayBuffer> = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return m[1] ? pkcs1ToPkcs8(der) : der;
}

export async function importSigningKey(pem: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** The request token: kid is the application id; the audience is the API host. */
export async function signToken(cred: EbCredentials, apiBase: string, ttlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = { typ: "JWT", alg: "RS256", kid: cred.app_id };
  const claims = { iss: "enablebanking.com", aud: new URL(apiBase).host, iat: nowSeconds, exp: nowSeconds + ttlSeconds };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const key = await importSigningKey(cred.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input)));
  return `${input}.${b64url(sig)}`;
}

function errorText(status: number, text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j.message ?? j.detail ?? j.error ?? j.code;
    if (m) return `Enable Banking ${status}: ${String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 200)}`;
  } catch { /* not JSON */ }
  return `Enable Banking ${status}`;
}

export class EnableBanking {
  private token: { value: string; until: number } | null = null;
  constructor(private base: string, private cred: EbCredentials, private ttlSeconds: number) {}

  async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const now = Math.floor(Date.now() / 1000);
    if (!this.token || this.token.until - 60 < now) {
      this.token = { value: await signToken(this.cred, this.base, this.ttlSeconds, now), until: now + this.ttlSeconds };
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token.value}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(errorText(res.status, text));
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export interface EbAspsp { name: string; country: string; maximum_consent_validity?: number }

export interface EbAccount {
  uid?: string;
  account_id?: { iban?: string | null; other?: { identification?: string | null } | null } | null;
  name?: string | null;
  details?: string | null;
  product?: string | null;
  currency?: string | null;
  cash_account_type?: string | null;
}

export interface EbSession {
  session_id: string;
  accounts: (EbAccount | string)[];
  accounts_data?: EbAccount[];
  aspsp?: { name: string; country: string };
  access?: { valid_until?: string };
}

export interface EbBalance {
  name?: string;
  balance_amount: { amount: string; currency: string };
  balance_type?: string;
  reference_date?: string | null;
  last_change_date_time?: string | null;
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator?: string | null;
  status?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  remittance_information?: string[] | string | null;
  note?: string | null;
}

/** One bank line in the shape nx_ingest_transactions reads. */
export interface BankRow {
  source: string;
  account: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  payee: string;
  counterparty: string;
}

/** The last four characters of an account identifier, as nx_accounts stores it. */
export function last4(a: EbAccount): string | null {
  const id = (a.account_id?.iban ?? a.account_id?.other?.identification ?? "").replace(/\s+/g, "");
  return id.length >= 4 ? id.slice(-4) : null;
}

/** Booked lines only. Money out is negative. The bank's reference keeps two
 *  identical-looking lines on one day apart. */
export function toBankRow(t: EbTransaction, source: string, account: string): BankRow | null {
  if (t.status && t.status !== "BOOK") return null;
  const date = (t.booking_date ?? t.value_date ?? t.transaction_date ?? "").slice(0, 10);
  const raw = Number(t.transaction_amount?.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(raw)) return null;
  const out = t.credit_debit_indicator === "DBIT" || (!t.credit_debit_indicator && raw < 0);
  const amount = round2(out ? -Math.abs(raw) : Math.abs(raw));
  const remittance = Array.isArray(t.remittance_information) ? t.remittance_information : t.remittance_information ? [t.remittance_information] : [];
  const text = [...remittance, t.note ?? ""].map((s) => String(s).trim()).filter(Boolean).join(" ");
  const party = (out ? t.creditor?.name : t.debtor?.name)?.trim() ?? "";
  const counterparty = (out ? t.creditor_account?.iban : t.debtor_account?.iban)?.replace(/\s+/g, "") ?? "";
  const ref = t.entry_reference?.trim();
  return {
    source, account, date, amount,
    currency: t.transaction_amount?.currency || "EUR",
    description: ref ? `${text} [ref ${ref}]`.trim() : text,
    payee: party || text.slice(0, 60),
    counterparty,
  };
}

const BALANCE_PREFERENCE = ["CLBD", "ITBD", "XPCD", "ITAV", "CLAV", "OPBD"];

/** The booked balance when the bank gives one, else the first it gives. */
export function pickBalance(balances: EbBalance[]): { amount: number; currency: string; type: string | null; date: string | null } | null {
  if (!balances.length) return null;
  const ranked = [...balances].sort((a, b) => {
    const ia = BALANCE_PREFERENCE.indexOf(a.balance_type ?? ""), ib = BALANCE_PREFERENCE.indexOf(b.balance_type ?? "");
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const b = ranked[0];
  const amount = Number(b.balance_amount?.amount);
  if (!Number.isFinite(amount)) return null;
  return { amount: round2(amount), currency: b.balance_amount.currency, type: b.balance_type ?? null, date: b.reference_date ?? b.last_change_date_time?.slice(0, 10) ?? null };
}

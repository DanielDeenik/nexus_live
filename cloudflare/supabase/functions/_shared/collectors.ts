// Receipt collectors. Each returns CollectedDoc items for the expense agent;
// none of them writes to the ledger. Endpoints and queries come from
// app_config; credentials come from Vault via integration_connections.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEnv } from "./client.ts";
import type { AppConfig } from "./config.ts";

export interface CollectedDoc {
  source: "gmail" | "drive" | "wise" | "upload";
  external_id: string;
  received_at: string;
  title: string;
  text?: string;
  file?: { bytes: Uint8Array; mediaType: string; name: string };
  hint?: { amount: number; currency: string; date: string; vendor: string };
}

export interface Connection {
  id: string;
  provider: "google" | "wise";
  vault_secret_id: string;
  settings: Record<string, unknown>;
  cursor: Record<string, unknown>;
}

const SUPPORTED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);

async function secret(db: SupabaseClient, id: string): Promise<string> {
  const { data, error } = await db.rpc("read_integration_secret", { p_secret_id: id });
  if (error || !data) throw new Error(`could not read integration secret: ${error?.message ?? "empty"}`);
  return data as string;
}

function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- Google ----

export async function googleAccessToken(db: SupabaseClient, cfg: AppConfig, conn: Connection): Promise<string> {
  const refresh = await secret(db, conn.vault_secret_id);
  const res = await fetch(cfg["integrations.google_token_url"], {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token as string;
}

interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GmailPart[] }

function walk(p: GmailPart, out: GmailPart[] = []): GmailPart[] {
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

export async function collectGmail(token: string, cfg: AppConfig, lookbackDays: number, max: number): Promise<CollectedDoc[]> {
  const base = cfg["integrations.gmail_api_base"];
  const q = (cfg["expense_agent.gmail_query"] ?? "").replace("{days}", String(lookbackDays));
  const h = { Authorization: `Bearer ${token}` };
  const list = await fetch(`${base}/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, { headers: h });
  if (!list.ok) throw new Error(`Gmail list failed: ${list.status}`);
  const ids: { id: string }[] = (await list.json()).messages ?? [];
  const docs: CollectedDoc[] = [];
  for (const { id } of ids) {
    const m = await (await fetch(`${base}/users/me/messages/${id}?format=full`, { headers: h })).json();
    const headers: { name: string; value: string }[] = m.payload?.headers ?? [];
    const subject = headers.find((x) => x.name.toLowerCase() === "subject")?.value ?? "(no subject)";
    const from = headers.find((x) => x.name.toLowerCase() === "from")?.value ?? "";
    const received = new Date(Number(m.internalDate)).toISOString();
    const parts = walk(m.payload ?? {});
    const textPart = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    const htmlPart = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
    const bodyText = textPart
      ? new TextDecoder().decode(b64urlToBytes(textPart.body!.data!))
      : htmlPart ? new TextDecoder().decode(b64urlToBytes(htmlPart.body!.data!)).replace(/<[^>]+>/g, " ") : "";
    const attachments = parts.filter((p) => p.filename && p.body?.attachmentId && SUPPORTED.has(p.mimeType ?? ""));
    if (attachments.length === 0) {
      docs.push({ source: "gmail", external_id: `gmail:${id}`, received_at: received, title: `${from}: ${subject}`, text: bodyText.slice(0, 20000) });
      continue;
    }
    for (const a of attachments) {
      const att = await (await fetch(`${base}/users/me/messages/${id}/attachments/${a.body!.attachmentId}`, { headers: h })).json();
      docs.push({
        source: "gmail",
        external_id: `gmail:${id}:${a.filename}`,
        received_at: received,
        title: `${from}: ${subject}`,
        text: bodyText.slice(0, 4000),
        file: { bytes: b64urlToBytes(att.data), mediaType: a.mimeType!, name: a.filename! },
      });
    }
  }
  return docs;
}

export async function collectDrive(token: string, cfg: AppConfig, conn: Connection, max: number): Promise<{ docs: CollectedDoc[]; cursor: string | null }> {
  const folder = conn.settings.drive_folder_id as string | undefined;
  if (!folder) return { docs: [], cursor: null };
  const base = cfg["integrations.drive_api_base"];
  const since = (conn.cursor.drive_modified_after as string | undefined) ?? "1970-01-01T00:00:00Z";
  const q = `'${folder}' in parents and trashed = false and modifiedTime > '${since}'`;
  const h = { Authorization: `Bearer ${token}` };
  const res = await fetch(`${base}/files?pageSize=${max}&orderBy=modifiedTime&fields=files(id,name,mimeType,modifiedTime)&q=${encodeURIComponent(q)}`, { headers: h });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const files: { id: string; name: string; mimeType: string; modifiedTime: string }[] = (await res.json()).files ?? [];
  const docs: CollectedDoc[] = [];
  let cursor: string | null = null;
  for (const f of files) {
    cursor = f.modifiedTime;
    if (!SUPPORTED.has(f.mimeType)) continue;
    const bytes = new Uint8Array(await (await fetch(`${base}/files/${f.id}?alt=media`, { headers: h })).arrayBuffer());
    docs.push({ source: "drive", external_id: `drive:${f.id}`, received_at: f.modifiedTime, title: f.name, file: { bytes, mediaType: f.mimeType, name: f.name } });
  }
  return { docs, cursor };
}

// ------------------------------------------------------------------ Wise ----

/** Card payments and outgoing transfers. These carry no receipt, so they are
 *  matched against documents by the agent; unmatched ones ask for evidence. */
export async function collectWise(db: SupabaseClient, cfg: AppConfig, conn: Connection, lookbackDays: number, max: number): Promise<CollectedDoc[]> {
  const token = await secret(db, conn.vault_secret_id);
  const base = cfg["integrations.wise_api_base"];
  const h = { Authorization: `Bearer ${token}` };
  const profiles = await fetch(`${base}/v1/profiles`, { headers: h });
  if (!profiles.ok) throw new Error(`Wise profiles failed: ${profiles.status}`);
  const plist: { id: number; type: string }[] = await profiles.json();
  const profile = (conn.settings.wise_profile_id as number | undefined) ??
    (plist.find((p) => p.type.toLowerCase() === "business") ?? plist[0])?.id;
  if (!profile) return [];
  const since = new Date(Date.now() - lookbackDays * 864e5).toISOString();
  const res = await fetch(`${base}/v1/profiles/${profile}/activities?since=${since}&size=${max}`, { headers: h });
  if (!res.ok) throw new Error(`Wise activities failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const acts: { id: string; type: string; title?: string; primaryAmount?: string; createdOn: string; status?: string }[] =
    (await res.json()).activities ?? [];
  const docs: CollectedDoc[] = [];
  for (const a of acts) {
    if (!["CARD_PAYMENT", "TRANSFER", "DIRECT_DEBIT_TRANSACTION"].includes(a.type)) continue;
    if (a.status && a.status !== "COMPLETED") continue;
    const m = (a.primaryAmount ?? "").replace(/<[^>]+>/g, "").match(/([\d.,]+)\s*([A-Z]{3})/);
    if (!m) continue;
    const amount = Number(m[1].replace(/,/g, ""));
    const vendor = (a.title ?? "").replace(/<[^>]+>/g, "").trim();
    const isOutgoing = /^-|sent|paid/i.test(a.primaryAmount ?? "") || a.type === "CARD_PAYMENT";
    if (!isOutgoing) continue;
    docs.push({
      source: "wise",
      external_id: `wise:${a.id}`,
      received_at: a.createdOn,
      title: vendor || a.type,
      text: `Wise ${a.type}: ${vendor} ${amount} ${m[2]} on ${a.createdOn.slice(0, 10)}`,
      hint: { amount, currency: m[2], date: a.createdOn.slice(0, 10), vendor },
    });
  }
  return docs;
}

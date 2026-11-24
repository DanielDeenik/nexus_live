// Shared plumbing for connections: signed single-use consent state, the
// redirect URI every consent returns to, and storing a connection's secret in
// Vault (integration_connections keeps only metadata).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, internalSecret, requireEnv, timingSafeEqual } from "./client.ts";
import { cacheGet, cacheSet } from "./cache.ts";

export type Provider = "google" | "wise" | "etoro" | "enable_banking";
/** Where the browser goes after a consent: the web app or the iPhone app. */
export type ReturnTo = "web" | "app";

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmac(data: string): Promise<string> {
  const secret = await internalSecret(adminClient(), "oauth_state_secret");
  if (!secret) throw new Error("oauth_state_secret missing from Vault");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const STATE_TTL_S = 600;

export interface StateClaims { u: string; n: string; p: string; r: ReturnTo; c?: string }

/** A signed state naming the user, the flow (p), where to return (r) and an optional catalog id (c). */
export async function signState(db: SupabaseClient, userId: string, flow: string, returnTo: ReturnTo, catalogId?: string): Promise<string> {
  const nonce = crypto.randomUUID();
  await cacheSet(db, `oauth_nonce:${nonce}`, { u: userId, used: false }, STATE_TTL_S);
  const claims: Record<string, unknown> = { u: userId, exp: Date.now() + STATE_TTL_S * 1000, n: nonce, p: flow, r: returnTo };
  if (catalogId) claims.c = catalogId;
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  return `${payload}.${await hmac(payload)}`;
}

/** Unverified read of the routing hints only (flow and return target), for the redirect bounce. */
export function peekState(state: string): { p: string; r: ReturnTo } | null {
  try {
    const o = JSON.parse(fromB64url(state.split(".")[0] ?? ""));
    return { p: typeof o.p === "string" ? o.p : "google", r: o.r === "app" ? "app" : "web" };
  } catch {
    return null;
  }
}

export async function verifyState(state: string): Promise<StateClaims | null> {
  try {
    const [payload, sig] = state.split(".");
    if (!payload || !sig || !timingSafeEqual(await hmac(payload), sig)) return null;
    const o = JSON.parse(fromB64url(payload));
    if (typeof o.u !== "string" || typeof o.n !== "string" || !(o.exp > Date.now())) return null;
    return { u: o.u, n: o.n, p: typeof o.p === "string" ? o.p : "google", r: o.r === "app" ? "app" : "web", c: typeof o.c === "string" ? o.c : undefined };
  } catch {
    return null;
  }
}

/** Single use: the nonce must exist, belong to this user, and not be spent. */
export async function consumeNonce(db: SupabaseClient, nonce: string, userId: string): Promise<boolean> {
  const hit = await cacheGet<{ u: string; used: boolean }>(db, `oauth_nonce:${nonce}`);
  if (!hit || hit.used || hit.u !== userId) return false;
  await cacheSet(db, `oauth_nonce:${nonce}`, { u: userId, used: true }, STATE_TTL_S);
  return true;
}

/** Signed state for this user and flow, verified and spent; null when forged, expired or reused. */
export async function claimState(db: SupabaseClient, state: string, userId: string, flow: string): Promise<StateClaims | null> {
  const st = await verifyState(state);
  if (!st || st.u !== userId || st.p !== flow) return null;
  return (await consumeNonce(db, st.n, userId)) ? st : null;
}

/** Every consent (Google and the banks) returns here, then bounces to the web app or the iPhone app. */
export const redirectUri = () => `${requireEnv("SUPABASE_URL")}/functions/v1/${Deno.env.get("INTEGRATIONS_PATH") ?? "nexus/integrations"}`;

export async function saveConnection(db: SupabaseClient, userId: string, provider: Provider, secret: string, meta: Record<string, unknown>) {
  const { data: secretId, error } = await db.rpc("store_integration_secret", { p_user: userId, p_provider: provider, p_secret: secret });
  if (error) throw new Error(`vault: ${error.message}`);
  const { error: e2 } = await db.from("integration_connections").upsert(
    { user_id: userId, provider, vault_secret_id: secretId, status: "active", last_error: null, connected_at: new Date().toISOString(), ...meta },
    { onConflict: "user_id,provider" },
  );
  if (e2) throw new Error(e2.message);
}

export interface Connection {
  provider: Provider;
  status: string;
  account_label: string | null;
  settings: Record<string, unknown>;
  cursor: Record<string, unknown>;
  last_error: string | null;
  connected_at: string;
  vault_secret_id: string | null;
}

export async function connections(db: SupabaseClient, userId: string): Promise<Map<Provider, Connection>> {
  const { data, error } = await db.from("integration_connections")
    .select("provider, status, account_label, settings, cursor, last_error, connected_at, vault_secret_id").eq("user_id", userId);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((c) => [c.provider as Provider, c as Connection]));
}

/** The decrypted secret of an active connection, or null. */
export async function readSecret(db: SupabaseClient, c: Connection | undefined): Promise<string | null> {
  if (!c || c.status === "revoked" || !c.vault_secret_id) return null;
  const { data, error } = await db.rpc("read_integration_secret", { p_secret_id: c.vault_secret_id });
  if (error) throw new Error(`vault: ${error.message}`);
  return (data as string | null) ?? null;
}

export async function markConnection(db: SupabaseClient, userId: string, provider: Provider, fields: Record<string, unknown>) {
  const { error } = await db.from("integration_connections").update(fields).eq("user_id", userId).eq("provider", provider);
  if (error) throw new Error(error.message);
}

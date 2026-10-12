// integrations: connect Google (Gmail + Drive, read-only) and Wise.
// Secrets go to Vault; integration_connections keeps only metadata.
//
// POST { action: "google_start" }                    signed in; returns the consent URL
// GET  ?code=...&state=...                            Google redirect: bounced to the SPA, no exchange here
// POST { action: "google_finish", code, state }       signed in; must be the user who started the flow
// POST { action: "google_settings", drive_folder_id } signed in
// POST { action: "wise_connect", token, profile_id? } signed in
// POST { action: "disconnect", provider }             signed in
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, internalSecret, requireEnv, timingSafeEqual, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig } from "../_shared/config.ts";
import { cacheGet, cacheSet } from "../_shared/cache.ts";
import { json, preflight } from "../_shared/cors.ts";

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(data: string): Promise<string> {
  const secret = await internalSecret(adminClient(), "oauth_state_secret");
  if (!secret) throw new Error("oauth_state_secret missing from Vault");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const STATE_TTL_S = 600;

async function signState(db: SupabaseClient, userId: string): Promise<string> {
  const nonce = crypto.randomUUID();
  await cacheSet(db, `oauth_nonce:${nonce}`, { u: userId, used: false }, STATE_TTL_S);
  const payload = b64url(enc.encode(JSON.stringify({ u: userId, exp: Date.now() + STATE_TTL_S * 1000, n: nonce })));
  return `${payload}.${await hmac(payload)}`;
}

async function verifyState(state: string): Promise<{ u: string; n: string } | null> {
  try {
    const [payload, sig] = state.split(".");
    if (!payload || !sig || !timingSafeEqual(await hmac(payload), sig)) return null;
    const o = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof o.u === "string" && typeof o.n === "string" && o.exp > Date.now() ? { u: o.u, n: o.n } : null;
  } catch {
    return null;
  }
}

/** Single use: the nonce must exist, belong to this user, and not be spent. */
async function consumeNonce(db: SupabaseClient, nonce: string, userId: string): Promise<boolean> {
  const hit = await cacheGet<{ u: string; used: boolean }>(db, `oauth_nonce:${nonce}`);
  if (!hit || hit.used || hit.u !== userId) return false;
  await cacheSet(db, `oauth_nonce:${nonce}`, { u: userId, used: true }, STATE_TTL_S);
  return true;
}

const redirectUri = () => `${requireEnv("SUPABASE_URL")}/functions/v1/${Deno.env.get("INTEGRATIONS_PATH") ?? "nexus/integrations"}`;

async function saveConnection(db: SupabaseClient, userId: string, provider: "google" | "wise", secret: string, meta: Record<string, unknown>) {
  const { data: secretId, error } = await db.rpc("store_integration_secret", { p_user: userId, p_provider: provider, p_secret: secret });
  if (error) throw new Error(`vault: ${error.message}`);
  const { error: e2 } = await db.from("integration_connections").upsert(
    { user_id: userId, provider, vault_secret_id: secretId, status: "active", last_error: null, connected_at: new Date().toISOString(), ...meta },
    { onConflict: "user_id,provider" },
  );
  if (e2) throw new Error(e2.message);
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  const web = Deno.env.get("WEB_ORIGIN") ?? "";

  // OAuth redirect from Google. Nothing is exchanged here: the browser carries
  // code and state back to the app, which finishes the flow in an
  // authenticated request (binding the grant to the signed-in user).
  if (req.method === "GET") {
    if (!web) return json({ error: "WEB_ORIGIN is not configured" }, 503);
    const url = new URL(req.url);
    const q = new URLSearchParams();
    if (url.searchParams.get("error")) q.set("integration_error", url.searchParams.get("error")!);
    else { q.set("google_code", url.searchParams.get("code") ?? ""); q.set("google_state", url.searchParams.get("state") ?? ""); }
    return Response.redirect(`${web}/agent-settings?${q}`, 302);
  }

  const userId = await userIdFromRequest(req, db);
  if (!userId) return json({ error: "sign in required" }, 401);
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "google_start": {
        const cfg = await loadConfig(db);
        const u = new URL(cfg["integrations.google_auth_url"]);
        u.search = new URLSearchParams({
          client_id: requireEnv("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(), response_type: "code",
          scope: [cfg["integrations.google_scopes"], cfg["integrations.google_scopes_extra"]].filter(Boolean).join(" "), access_type: "offline", prompt: "consent", state: await signState(db, userId),
        }).toString();
        return json({ url: u.toString() });
      }
      case "google_finish": {
        const st = await verifyState(String(body.state ?? ""));
        if (!st || st.u !== userId) return json({ error: "this connection link was not started by you" }, 403);
        if (!(await consumeNonce(db, st.n, userId))) return json({ error: "link expired or already used; start again" }, 409);
        const cfg = await loadConfig(db);
        const res = await fetch(cfg["integrations.google_token_url"], {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code: String(body.code ?? ""), client_id: requireEnv("GOOGLE_CLIENT_ID"), client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
            redirect_uri: redirectUri(), grant_type: "authorization_code",
          }),
        });
        const tok = await res.json();
        if (!res.ok || !tok.refresh_token) return json({ error: "Google did not return a refresh token; try again" }, 400);
        const { data: existing } = await db.from("integration_connections").select("settings").eq("user_id", userId).eq("provider", "google").maybeSingle();
        await saveConnection(db, userId, "google", tok.refresh_token, { scopes: String(tok.scope ?? "").split(" "), settings: existing?.settings ?? {} });
        return json({ ok: true });
      }
      case "google_settings": {
        const folder = String(body.drive_folder_id ?? "").trim();
        if (!/^[A-Za-z0-9_-]{10,}$/.test(folder)) return json({ error: "paste the folder id from the Drive URL" }, 400);
        const { data: c } = await db.from("integration_connections").select("settings").eq("user_id", userId).eq("provider", "google").single();
        if (!c) return json({ error: "connect Google first" }, 409);
        await db.from("integration_connections").update({ settings: { ...c.settings, drive_folder_id: folder } }).eq("user_id", userId).eq("provider", "google");
        return json({ ok: true });
      }
      case "wise_connect": {
        const token = String(body.token ?? "").trim();
        if (!token) return json({ error: "token required" }, 400);
        const cfg = await loadConfig(db);
        const r = await fetch(`${cfg["integrations.wise_api_base"]}/v1/profiles`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return json({ error: `Wise rejected the token (${r.status})` }, 400);
        const profiles: { id: number; type: string }[] = await r.json();
        const pick = body.profile_id ? profiles.find((p) => p.id === Number(body.profile_id)) : profiles.find((p) => p.type.toLowerCase() === "business") ?? profiles[0];
        if (!pick) return json({ error: "no Wise profile found" }, 400);
        await saveConnection(db, userId, "wise", token, { account_label: `${pick.type} ${pick.id}`, settings: { wise_profile_id: pick.id } });
        return json({ ok: true, profile: pick });
      }
      case "disconnect": {
        await db.from("integration_connections").update({ status: "revoked" }).eq("user_id", userId).eq("provider", body.provider);
        return json({ ok: true });
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

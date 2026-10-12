// integrations: connect Google (Gmail + Drive, read-only) and Wise.
// Secrets go to Vault; integration_connections keeps only metadata.
//
// POST { action: "google_start" }                    signed in; returns the consent URL
// GET  ?code=...&state=...                            Google redirect (state is HMAC-signed)
// POST { action: "google_settings", drive_folder_id } signed in
// POST { action: "wise_connect", token, profile_id? } signed in
// POST { action: "disconnect", provider }             signed in
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, requireEnv, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(requireEnv("OAUTH_STATE_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function signState(userId: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ u: userId, exp: Date.now() + 10 * 60_000, n: crypto.randomUUID() })));
  return `${payload}.${await hmac(payload)}`;
}

async function verifyState(state: string): Promise<string | null> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig || (await hmac(payload)) !== sig) return null;
  const o = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  return o.exp > Date.now() ? (o.u as string) : null;
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

  // OAuth redirect from Google: authenticated by the signed state, not a JWT.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const back = (q: string) => Response.redirect(`${web}/settings?${q}`, 302);
    const userId = await verifyState(url.searchParams.get("state") ?? "");
    if (!userId) return back("integration_error=invalid_state");
    if (url.searchParams.get("error")) return back(`integration_error=${encodeURIComponent(url.searchParams.get("error")!)}`);
    const cfg = await loadConfig(db);
    const res = await fetch(cfg["integrations.google_token_url"], {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") ?? "", client_id: requireEnv("GOOGLE_CLIENT_ID"), client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
        redirect_uri: redirectUri(), grant_type: "authorization_code",
      }),
    });
    const tok = await res.json();
    if (!res.ok || !tok.refresh_token) return back("integration_error=no_refresh_token");
    const { data: existing } = await db.from("integration_connections").select("settings").eq("user_id", userId).eq("provider", "google").maybeSingle();
    await saveConnection(db, userId, "google", tok.refresh_token, { scopes: String(tok.scope ?? "").split(" "), settings: existing?.settings ?? {} });
    return back("connected=google");
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
          scope: cfg["integrations.google_scopes"], access_type: "offline", prompt: "consent", state: await signState(userId),
        }).toString();
        return json({ url: u.toString() });
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

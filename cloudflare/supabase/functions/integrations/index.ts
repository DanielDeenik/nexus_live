// integrations: connect Google (Gmail + Drive, read-only) and Wise.
// Secrets go to Vault; integration_connections keeps only metadata.
//
// POST { action: "google_start", return_to? }        signed in; returns the consent URL ("app" returns to the iPhone app)
// GET  ?code=...&state=...                            every consent (Google, banks) lands here and is bounced
//                                                     to the web app or the iPhone app; nothing is exchanged here
// POST { action: "google_finish", code, state }       signed in; must be the user who started the flow
// POST { action: "google_settings", drive_folder_id } signed in
// POST { action: "wise_connect", token, profile_id? } signed in
// POST { action: "moneybird_connect", token, administration_id? } signed in
// POST { action: "disconnect", provider }             signed in
import { adminClient, requireEnv, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { claimState, peekState, redirectUri, saveConnection, signState } from "../_shared/connect.ts";
import { administrations, mbClient } from "../_shared/moneybird.ts";

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  const web = Deno.env.get("WEB_ORIGIN") ?? "";

  // Every consent lands here. Nothing is exchanged: the browser carries code
  // and state back to the app that started it, which finishes the flow in an
  // authenticated request (binding the grant to the signed-in user).
  if (req.method === "GET") {
    const url = new URL(req.url);
    const hint = peekState(url.searchParams.get("state") ?? "");
    if (hint?.r === "app") {
      const cfg = await loadConfig(db);
      const target = cfg["integrations.app_callback_url"];
      if (!target) return json({ error: "app_config integrations.app_callback_url is missing" }, 503);
      const q = new URLSearchParams({ flow: hint.p });
      for (const k of ["code", "state", "error", "error_description"]) {
        const v = url.searchParams.get(k);
        if (v) q.set(k, v);
      }
      return Response.redirect(`${target}?${q}`, 302);
    }
    if (!web) return json({ error: "WEB_ORIGIN is not configured" }, 503);
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
          scope: [cfg["integrations.google_scopes"], cfg["integrations.google_scopes_extra"]].filter(Boolean).join(" "), access_type: "offline", prompt: "consent", state: await signState(db, userId, "google", body.return_to === "app" ? "app" : "web"),
        }).toString();
        return json({ url: u.toString() });
      }
      case "google_finish": {
        if (!(await claimState(db, String(body.state ?? ""), userId, "google"))) {
          return json({ error: "this link was not started by you, has expired or was already used; start again" }, 403);
        }
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
      case "moneybird_connect": {
        const token = String(body.token ?? "").trim();
        if (!token) return json({ error: "token required" }, 400);
        const cfg = await loadConfig(db);
        const base = cfg["integrations.moneybird.api_base"];
        if (!base) return json({ error: "app_config integrations.moneybird.api_base is missing" }, 503);
        let admins: { id: string; name: string }[];
        try {
          admins = await administrations(mbClient(base, token, Number(cfg["api.moneybird_requests_per_minute"])));
        } catch (e) {
          return json({ error: `Moneybird rejected the token (${(e as Error).message})` }, 400);
        }
        const pick = body.administration_id ? admins.find((a) => a.id === String(body.administration_id)) : admins.length === 1 ? admins[0] : undefined;
        if (!pick) {
          return json({ error: admins.length ? "this token sees more than one administration; choose one" : "this token sees no administration", administrations: admins }, admins.length ? 409 : 400);
        }
        await saveConnection(db, userId, "moneybird", token, { account_label: pick.name, settings: { administration_id: pick.id } });
        return json({ ok: true, administration: pick });
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

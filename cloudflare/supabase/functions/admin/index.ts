// admin: service-only maintenance (bootstrap an allow-listed owner, set profile
// settings, issue a single-use signed upload URL into the owner's private
// folder). Callable only with the scheduler secret, i.e. from inside Postgres
// via invoke_edge; never from a browser.
//
// POST { action: "create_user", email }
// POST { action: "set_profile", user_id, work_calendar_region?, standard_hours_per_day? }
// POST { action: "signed_upload", user_id, path }      path is relative to the user's folder
import { adminClient, authorize } from "../_shared/client.ts";
import { loadConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  const who = await authorize(req, db);
  if (who?.kind !== "service") return json({ error: "service only" }, 403);
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "create_user": {
        const email = String(body.email ?? "").toLowerCase();
        const allowed: string[] = JSON.parse((await loadConfig(db))["auth.allowed_emails"] ?? "[]");
        if (!allowed.includes(email)) return json({ error: "email not on the allow-list" }, 403);
        const { data: existing } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
        if (existing) return json({ user_id: existing.id, created: false });
        const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
        if (error) return json({ error: error.message }, 400);
        return json({ user_id: data.user.id, created: true });
      }
      case "set_profile": {
        const patch: Record<string, unknown> = {};
        if (typeof body.work_calendar_region === "string") patch.work_calendar_region = body.work_calendar_region;
        if (typeof body.standard_hours_per_day === "number") patch.standard_hours_per_day = body.standard_hours_per_day;
        const { error } = await db.from("profiles").update(patch).eq("id", body.user_id);
        return error ? json({ error: error.message }, 400) : json({ ok: true });
      }
      case "signed_upload": {
        const rel = String(body.path ?? "");
        if (!rel || rel.split("/").some((s) => s === ".." || s === "")) return json({ error: "bad path" }, 400);
        const path = `${body.user_id}/${rel}`;
        const { data, error } = await db.storage.from("receipts").createSignedUploadUrl(path);
        return error ? json({ error: error.message }, 400) : json({ path, signed_url: data.signedUrl });
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

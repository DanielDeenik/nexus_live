// admin: service-only maintenance (bootstrap an allow-listed owner, set profile
// settings, issue a single-use signed upload URL into the owner's private
// folder). Callable only with the scheduler secret, i.e. from inside Postgres
// via invoke_edge; never from a browser.
//
// POST { action: "create_user", email }
// POST { action: "set_profile", user_id, work_calendar_region?, standard_hours_per_day? }
// POST { action: "signed_upload", user_id, path }      path is relative to the user's folder
// POST { action: "ingest_bank_file", user_id, path }   a staged JSON array of bank lines in the
//      user's folder goes through nx_ingest_transactions in day-whole batches, then the file is removed
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
      case "ingest_bank_file": {
        const rel = String(body.path ?? "");
        if (!rel || rel.split("/").some((s) => s === ".." || s === "")) return json({ error: "bad path" }, 400);
        const cfg = await loadConfig(db);
        const limit = Number(cfg["budget.import_batch_rows"]);
        if (!Number.isFinite(limit) || limit <= 0) return json({ error: "app_config budget.import_batch_rows is missing" }, 500);
        const path = `${body.user_id}/${rel}`;
        const dl = await db.storage.from("receipts").download(path);
        if (dl.error) return json({ error: dl.error.message }, 400);
        const rows = JSON.parse(await dl.data.text());
        if (!Array.isArray(rows)) return json({ error: "the file must hold a JSON array of bank lines" }, 400);
        // Same rule as the app: a batch never splits a day, so identical lines
        // on one day keep their numbering and a re-import adds nothing.
        rows.sort((a: { date?: string }, b: { date?: string }) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
        const totals = { received: 0, inserted: 0, duplicates: 0, needs_review: 0 };
        let batch: unknown[] = [];
        let lastDate = "";
        const flush = async () => {
          if (!batch.length) return;
          const { data, error } = await db.rpc("nx_ingest_transactions", { p_user: body.user_id, p_rows: batch });
          if (error) throw new Error(error.message);
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number((data as Record<string, number>)[k] ?? 0);
          batch = [];
        };
        for (const r of rows as { date?: string }[]) {
          const d = String(r.date ?? "");
          if (batch.length >= limit && d !== lastDate) await flush();
          batch.push(r);
          lastDate = d;
        }
        await flush();
        await db.storage.from("receipts").remove([path]);
        return json(totals);
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

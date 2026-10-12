// sync-wise — pulls Wise multi-currency balances into public.wise_accounts.
// Token from WISE_API_KEY secret; per-user profile id from
// data_sources.config_json.profile_id.
import { adminClient, getEnv, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig, str } from "../_shared/config.ts";
import { preflight, json } from "../_shared/cors.ts";

interface WiseBalance {
  id: number;
  currency: string;
  amount?: { value?: number };
  type?: string;
  name?: string;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const supabase = adminClient();
  const token = getEnv("WISE_API_KEY");
  if (!token) return json({ error: "WISE_API_KEY not set" }, 500);

  const cfg = await loadConfig(supabase);
  const apiBase = str(cfg, "integrations.wise.api_base", "https://api.wise.com");

  const only = await userIdFromRequest(req, supabase);
  let q = supabase.from("data_sources").select("user_id, config_json").eq("type", "wise")
    .neq("sync_status", "paused");
  if (only) q = q.eq("user_id", only);
  const { data: sources, error: srcErr } = await q;
  if (srcErr) return json({ error: srcErr.message }, 500);

  const results: Array<{ user_id: string; upserted: number; error?: string }> = [];

  for (const src of sources ?? []) {
    const userId = src.user_id as string;
    const profileId = (src.config_json as Record<string, unknown>)?.profile_id as string | undefined;
    await supabase.from("data_sources").update({ sync_status: "syncing" })
      .eq("user_id", userId).eq("type", "wise");
    try {
      if (!profileId) throw new Error("profile_id missing in data_sources.config_json");
      const url = `${apiBase}/v4/profiles/${profileId}/balances?types=STANDARD`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Wise ${res.status}`);
      const balances = (await res.json()) as WiseBalance[];
      const rows = balances.map((b) => ({
        user_id: userId,
        currency: b.currency,
        balance: Number(b.amount?.value ?? 0),
        is_jar: b.type === "SAVINGS",
        label: b.name ?? null,
        external_id: String(b.id),
      }));
      if (rows.length > 0) {
        const { error } = await supabase.from("wise_accounts")
          .upsert(rows, { onConflict: "user_id,external_id" });
        if (error) throw new Error(error.message);
      }
      await supabase.from("data_sources")
        .update({ sync_status: "idle", last_sync_at: new Date().toISOString(), error_message: null })
        .eq("user_id", userId).eq("type", "wise");
      results.push({ user_id: userId, upserted: rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("data_sources")
        .update({ sync_status: "error", error_message: msg })
        .eq("user_id", userId).eq("type", "wise");
      results.push({ user_id: userId, upserted: 0, error: msg });
    }
  }

  return json({ ok: true, sources: results.length, results });
});

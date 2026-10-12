// sync-stripe — pulls succeeded Stripe charges into public.invoices as paid
// revenue (source='api'). Key from STRIPE_SECRET_KEY secret. Mapping is
// refined in the financial-linking sub-project; this establishes the pipe.
import { adminClient, getEnv, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig, str } from "../_shared/config.ts";
import { preflight, json } from "../_shared/cors.ts";

interface StripeCharge {
  id: string;
  amount: number; // minor units
  currency: string;
  paid: boolean;
  created: number; // epoch seconds
  billing_details?: { name?: string };
  description?: string;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const supabase = adminClient();
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) return json({ error: "STRIPE_SECRET_KEY not set" }, 500);

  const cfg = await loadConfig(supabase);
  const apiBase = str(cfg, "integrations.stripe.api_base", "https://api.stripe.com");

  const only = await userIdFromRequest(req, supabase);
  let q = supabase.from("data_sources").select("user_id").eq("type", "stripe")
    .neq("sync_status", "paused");
  if (only) q = q.eq("user_id", only);
  const { data: sources, error: srcErr } = await q;
  if (srcErr) return json({ error: srcErr.message }, 500);

  const results: Array<{ user_id: string; upserted: number; error?: string }> = [];

  for (const src of sources ?? []) {
    const userId = src.user_id as string;
    await supabase.from("data_sources").update({ sync_status: "syncing" })
      .eq("user_id", userId).eq("type", "stripe");
    try {
      const res = await fetch(`${apiBase}/v1/charges?limit=100`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`Stripe ${res.status}`);
      const body = await res.json() as { data: StripeCharge[] };
      const rows = (body.data ?? [])
        .filter((c) => c.paid)
        .map((c) => {
          const date = new Date(c.created * 1000).toISOString().slice(0, 10);
          return {
            user_id: userId,
            client: c.billing_details?.name || c.description || "Stripe payment",
            amount: c.amount / 100,
            currency: c.currency.toUpperCase(),
            status: "paid" as const,
            issued_date: date,
            due_date: date,
            paid_date: date,
            source: "api",
            external_id: c.id,
          };
        });
      if (rows.length > 0) {
        const { error } = await supabase.from("invoices")
          .upsert(rows, { onConflict: "user_id,source,external_id" });
        if (error) throw new Error(error.message);
      }
      await supabase.from("data_sources")
        .update({ sync_status: "idle", last_sync_at: new Date().toISOString(), error_message: null })
        .eq("user_id", userId).eq("type", "stripe");
      results.push({ user_id: userId, upserted: rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("data_sources")
        .update({ sync_status: "error", error_message: msg })
        .eq("user_id", userId).eq("type", "stripe");
      results.push({ user_id: userId, upserted: 0, error: msg });
    }
  }

  return json({ ok: true, sources: results.length, results });
});

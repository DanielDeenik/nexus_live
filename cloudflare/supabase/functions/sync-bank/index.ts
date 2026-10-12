// sync-bank — pulls bank transactions via GoCardless Bank Account Data into
// public.expenses (debits) using access tokens minted from the secret id/key.
// Per-user account id lives in data_sources.config_json.account_id. Mapping is
// refined in the financial-linking sub-project; this establishes the pipe.
import { adminClient, getEnv, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig, str } from "../_shared/config.ts";
import { preflight, json } from "../_shared/cors.ts";

interface GcTxn {
  transactionId?: string;
  bookingDate?: string;
  transactionAmount?: { amount?: string; currency?: string };
  remittanceInformationUnstructured?: string;
}

async function accessToken(apiBase: string): Promise<string> {
  const id = getEnv("GOCARDLESS_SECRET_ID");
  const key = getEnv("GOCARDLESS_SECRET_KEY");
  if (!id || !key) throw new Error("GOCARDLESS_SECRET_ID / GOCARDLESS_SECRET_KEY not set");
  const res = await fetch(`${apiBase}/token/new/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret_id: id, secret_key: key }),
  });
  if (!res.ok) throw new Error(`GoCardless token ${res.status}`);
  return (await res.json()).access as string;
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const supabase = adminClient();
  const cfg = await loadConfig(supabase);
  const apiBase = str(cfg, "integrations.gocardless.api_base",
    "https://bankaccountdata.gocardless.com/api/v2");

  const only = await userIdFromRequest(req, supabase);
  let q = supabase.from("data_sources").select("user_id, config_json").eq("type", "gocardless")
    .neq("sync_status", "paused");
  if (only) q = q.eq("user_id", only);
  const { data: sources, error: srcErr } = await q;
  if (srcErr) return json({ error: srcErr.message }, 500);

  const results: Array<{ user_id: string; upserted: number; error?: string }> = [];
  let bearer: string | null = null;

  for (const src of sources ?? []) {
    const userId = src.user_id as string;
    const accountId = (src.config_json as Record<string, unknown>)?.account_id as string | undefined;
    await supabase.from("data_sources").update({ sync_status: "syncing" })
      .eq("user_id", userId).eq("type", "gocardless");
    try {
      if (!accountId) throw new Error("account_id missing in data_sources.config_json");
      if (!bearer) bearer = await accessToken(apiBase);
      const res = await fetch(`${apiBase}/accounts/${accountId}/transactions/`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) throw new Error(`GoCardless ${res.status}`);
      const body = await res.json() as { transactions?: { booked?: GcTxn[] } };
      const booked = body.transactions?.booked ?? [];
      const rows = booked
        .map((t) => {
          const amt = Number(t.transactionAmount?.amount ?? 0);
          return {
            user_id: userId,
            amount: Math.abs(amt),
            currency: t.transactionAmount?.currency ?? "EUR",
            category: "uncategorized",
            description: t.remittanceInformationUnstructured ?? null,
            date: t.bookingDate ?? new Date().toISOString().slice(0, 10),
            source: "gocardless",
            external_txn_id: t.transactionId ?? null,
            _debit: amt < 0,
          };
        })
        .filter((r) => r._debit && r.external_txn_id)
        .map(({ _debit, ...r }) => r);
      if (rows.length > 0) {
        const { error } = await supabase.from("expenses")
          .upsert(rows, { onConflict: "user_id,external_txn_id" });
        if (error) throw new Error(error.message);
      }
      await supabase.from("data_sources")
        .update({ sync_status: "idle", last_sync_at: new Date().toISOString(), error_message: null })
        .eq("user_id", userId).eq("type", "gocardless");
      results.push({ user_id: userId, upserted: rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("data_sources")
        .update({ sync_status: "error", error_message: msg })
        .eq("user_id", userId).eq("type", "gocardless");
      results.push({ user_id: userId, upserted: 0, error: msg });
    }
  }

  return json({ ok: true, sources: results.length, results });
});

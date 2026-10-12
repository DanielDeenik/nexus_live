// sync-moneybird — pulls Moneybird sales invoices into public.invoices.
// Read-only against Moneybird. Token from MONEYBIRD_API_TOKEN secret;
// per-user administration id from data_sources.config_json. Invoked by cron
// (processes every moneybird data_source) or directly for a single user.
import { adminClient, getEnv, userIdFromRequest } from "../_shared/client.ts";
import { loadConfig, num, str } from "../_shared/config.ts";
import { preflight, json } from "../_shared/cors.ts";

interface MoneybirdInvoice {
  id: string;
  contact?: { company_name?: string; firstname?: string; lastname?: string };
  total_price_incl_tax?: string;
  currency?: string;
  state?: string;
  invoice_date?: string;
  due_date?: string;
}

function mapStatus(state?: string): "paid" | "overdue" | "pending" {
  if (state === "paid") return "paid";
  if (state === "late") return "overdue";
  return "pending";
}

function contactName(c?: MoneybirdInvoice["contact"]): string {
  if (!c) return "Unknown";
  return c.company_name || [c.firstname, c.lastname].filter(Boolean).join(" ") || "Unknown";
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const supabase = adminClient();
  const token = getEnv("MONEYBIRD_API_TOKEN");
  if (!token) return json({ error: "MONEYBIRD_API_TOKEN not set" }, 500);

  const cfg = await loadConfig(supabase);
  const apiBase = str(cfg, "integrations.moneybird.api_base", "https://moneybird.com/api/v2");
  const perPage = num(cfg, "integrations.moneybird.per_page", 100);

  const only = await userIdFromRequest(req, supabase);
  let q = supabase.from("data_sources").select("user_id, config_json").eq("type", "moneybird")
    .neq("sync_status", "paused");
  if (only) q = q.eq("user_id", only);
  const { data: sources, error: srcErr } = await q;
  if (srcErr) return json({ error: srcErr.message }, 500);

  const results: Array<{ user_id: string; upserted: number; error?: string }> = [];

  for (const src of sources ?? []) {
    const userId = src.user_id as string;
    const adminId = (src.config_json as Record<string, unknown>)?.administration_id as string | undefined;
    await supabase.from("data_sources").update({ sync_status: "syncing" })
      .eq("user_id", userId).eq("type", "moneybird");
    try {
      if (!adminId) throw new Error("administration_id missing in data_sources.config_json");
      const invoices: MoneybirdInvoice[] = [];
      let page = 1;
      while (true) {
        const url = `${apiBase}/${adminId}/sales_invoices.json?per_page=${perPage}&page=${page}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Moneybird ${res.status}`);
        const batch = (await res.json()) as MoneybirdInvoice[];
        invoices.push(...batch);
        if (batch.length < perPage) break;
        page++;
      }
      const rows = invoices.map((inv) => ({
        user_id: userId,
        client: contactName(inv.contact),
        amount: Number(inv.total_price_incl_tax ?? 0),
        currency: inv.currency ?? "EUR",
        status: mapStatus(inv.state),
        issued_date: inv.invoice_date ?? new Date().toISOString().slice(0, 10),
        due_date: inv.due_date ?? inv.invoice_date ?? new Date().toISOString().slice(0, 10),
        source: "moneybird",
        external_id: inv.id,
      }));
      if (rows.length > 0) {
        const { error } = await supabase.from("invoices")
          .upsert(rows, { onConflict: "user_id,source,external_id" });
        if (error) throw new Error(error.message);
      }
      await supabase.from("data_sources")
        .update({ sync_status: "idle", last_sync_at: new Date().toISOString(), error_message: null })
        .eq("user_id", userId).eq("type", "moneybird");
      results.push({ user_id: userId, upserted: rows.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase.from("data_sources")
        .update({ sync_status: "error", error_message: msg })
        .eq("user_id", userId).eq("type", "moneybird");
      results.push({ user_id: userId, upserted: 0, error: msg });
    }
  }

  return json({ ok: true, sources: results.length, results });
});

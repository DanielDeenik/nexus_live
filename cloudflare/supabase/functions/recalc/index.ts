// recalc — daily recomputation. Rebuilds monthly cashflow_history and
// burn_history for each user from their invoices and expenses, and logs the run
// to recalc_log. This is the job that was deploy-blocked on Cloudflare/D1.
// Integration syncs and the agent swarm run as their own functions (invoked by
// cron alongside this one); recalc owns the derived-metrics recompute.
import { adminClient, userIdFromRequest } from "../_shared/client.ts";
import { preflight, json } from "../_shared/cors.ts";

interface Row { amount: number; currency: string; month: string }

function ym(d: string): string {
  return (d ?? "").slice(0, 7);
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const supabase = adminClient();
  const only = await userIdFromRequest(req, supabase);

  let uq = supabase.from("profiles").select("id, base_currency");
  if (only) uq = uq.eq("id", only);
  const { data: users, error: uErr } = await uq;
  if (uErr) return json({ error: uErr.message }, 500);

  const results: Array<{ user_id: string; months: number; error?: string }> = [];

  for (const u of users ?? []) {
    const userId = u.id as string;
    const { data: logRow } = await supabase.from("recalc_log")
      .insert({ user_id: userId, trigger: "cron-daily", status: "running" })
      .select("id").single();
    const logId = logRow?.id;
    try {
      const { data: invoices } = await supabase.from("invoices")
        .select("amount, currency, paid_date, issued_date, status").eq("user_id", userId);
      const { data: expenses } = await supabase.from("expenses")
        .select("amount, currency, date").eq("user_id", userId);

      // Aggregate revenue (paid invoices) and costs (expenses) by month+currency.
      const revenue = new Map<string, Row>();
      for (const inv of invoices ?? []) {
        if (inv.status !== "paid") continue;
        const month = ym(inv.paid_date ?? inv.issued_date);
        if (!month) continue;
        const k = `${month}|${inv.currency}`;
        const cur = revenue.get(k) ?? { amount: 0, currency: inv.currency, month };
        cur.amount += Number(inv.amount);
        revenue.set(k, cur);
      }
      const costs = new Map<string, Row>();
      for (const e of expenses ?? []) {
        const month = ym(e.date);
        if (!month) continue;
        const k = `${month}|${e.currency}`;
        const cur = costs.get(k) ?? { amount: 0, currency: e.currency, month };
        cur.amount += Number(e.amount);
        costs.set(k, cur);
      }

      const months = new Set<string>([...revenue.keys(), ...costs.keys()]);
      const cashflowRows = [...months].map((k) => {
        const rev = revenue.get(k)?.amount ?? 0;
        const cost = costs.get(k)?.amount ?? 0;
        const [month, currency] = k.split("|");
        return {
          user_id: userId, month, currency,
          revenue: rev, costs: cost, profit: rev - cost, source: "recalc",
        };
      });
      const burnRows = [...costs.values()].map((r) => ({
        user_id: userId, month: r.month, amount: r.amount, currency: r.currency,
      }));

      if (cashflowRows.length > 0) {
        const { error } = await supabase.from("cashflow_history")
          .upsert(cashflowRows, { onConflict: "user_id,month,currency" });
        if (error) throw new Error(error.message);
      }
      if (burnRows.length > 0) {
        const { error } = await supabase.from("burn_history")
          .upsert(burnRows, { onConflict: "user_id,month" });
        if (error) throw new Error(error.message);
      }

      if (logId) {
        await supabase.from("recalc_log").update({
          status: "completed", completed_at: new Date().toISOString(),
          steps_json: { cashflow_rows: cashflowRows.length, burn_rows: burnRows.length },
        }).eq("id", logId);
      }
      results.push({ user_id: userId, months: months.size });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (logId) {
        await supabase.from("recalc_log").update({
          status: "error", completed_at: new Date().toISOString(), error_message: msg,
        }).eq("id", logId);
      }
      results.push({ user_id: userId, months: 0, error: msg });
    }
  }

  return json({ ok: true, users: results.length, results });
});

// run-agents — the agent swarm, rewritten off the Cloudflare Workers AI binding.
// For each enabled agent_config and each user it: enforces the per-agent daily
// rate limit, builds a compact financial context, calls the configured LLM
// (provider/model/params from agent_configs), stores the insight in
// agent_knowledge_graph, caches it, and records agent_execution_log.
import { adminClient, userIdFromRequest } from "../_shared/client.ts";
import { cacheGet, cacheSet, rateLimitCheck } from "../_shared/cache.ts";
import { callLLM, type LlmParams } from "../_shared/llm.ts";
import { preflight, json } from "../_shared/cors.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

interface AgentConfig {
  agent_id: string;
  system_prompt: string;
  llm_provider: string;
  llm_model: string;
  max_tokens: number;
  temperature: number;
  cache_ttl_seconds: number;
  rate_limit_per_day: number;
  enabled: boolean;
}

async function buildContext(supabase: SupabaseClient, userId: string): Promise<string> {
  const [{ count: invCount }, { count: expCount }, { data: signals }] = await Promise.all([
    supabase.from("invoices").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("expenses").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("market_signals").select("title, score, tier").eq("user_id", userId)
      .order("score", { ascending: false }).limit(5),
  ]);
  const { data: cash } = await supabase.from("cashflow_history")
    .select("month, revenue, costs, profit, currency").eq("user_id", userId)
    .order("month", { ascending: false }).limit(6);
  return JSON.stringify({
    invoices: invCount ?? 0,
    expenses: expCount ?? 0,
    recent_cashflow: cash ?? [],
    top_signals: signals ?? [],
  });
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  const supabase = adminClient();
  const only = await userIdFromRequest(req, supabase);

  const { data: agents, error: aErr } = await supabase.from("agent_configs")
    .select("agent_id, system_prompt, llm_provider, llm_model, max_tokens, temperature, cache_ttl_seconds, rate_limit_per_day, enabled")
    .eq("enabled", true);
  if (aErr) return json({ error: aErr.message }, 500);

  let uq = supabase.from("profiles").select("id");
  if (only) uq = uq.eq("id", only);
  const { data: users, error: uErr } = await uq;
  if (uErr) return json({ error: uErr.message }, 500);

  const results: Array<{ agent: string; user_id: string; status: string; error?: string }> = [];

  for (const user of users ?? []) {
    const userId = user.id as string;
    const context = await buildContext(supabase, userId);
    for (const agent of (agents ?? []) as AgentConfig[]) {
      const started = Date.now();
      try {
        const allowed = await rateLimitCheck(supabase, agent.agent_id, userId, agent.rate_limit_per_day);
        if (!allowed) {
          results.push({ agent: agent.agent_id, user_id: userId, status: "rate_limited" });
          continue;
        }
        const cacheKey = `agent:${agent.agent_id}:${userId}`;
        const cached = await cacheGet(supabase, cacheKey);
        if (cached) {
          results.push({ agent: agent.agent_id, user_id: userId, status: "cached" });
          continue;
        }

        const params: LlmParams = {
          provider: agent.llm_provider,
          model: agent.llm_model,
          maxTokens: agent.max_tokens,
          temperature: Number(agent.temperature),
        };
        const output = await callLLM(params, [
          { role: "system", content: agent.system_prompt },
          { role: "user", content: `Current financial context:\n${context}\n\nProvide your top insight and one recommended action as JSON with keys "insight" and "action".` },
        ]);

        await supabase.from("agent_knowledge_graph").insert({
          agent_id: agent.agent_id,
          user_id: userId,
          entry_type: "insight",
          context_json: JSON.parse(context),
          output_json: { text: output },
          confidence: 0.6,
        });
        await cacheSet(supabase, cacheKey, { text: output }, agent.cache_ttl_seconds);
        await supabase.from("agent_execution_log").insert({
          user_id: userId, agent_id: agent.agent_id, status: "success",
          duration_ms: Date.now() - started,
        });
        results.push({ agent: agent.agent_id, user_id: userId, status: "success" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("agent_execution_log").insert({
          user_id: userId, agent_id: agent.agent_id, status: "error",
          duration_ms: Date.now() - started,
        });
        results.push({ agent: agent.agent_id, user_id: userId, status: "error", error: msg });
      }
    }
  }

  return json({ ok: true, runs: results.length, results });
});

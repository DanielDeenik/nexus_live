// models: checks that an agent's configured model answers, without saving
// anything. Runs one structured call with the probe in app_config
// `llm.model_check` through the same LangChain path the agent uses, and
// reports provider, model, time taken, tokens and the answer.
//
// POST { agent_id }   signed-in owner, or the scheduler identity
import { adminClient, authorize } from "../_shared/client.ts";
import { loadConfig } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { callStructured, type ToolSpec } from "../_shared/llm.ts";

interface Probe { system: string; text: string; tool: ToolSpec }

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  const who = await authorize(req, db);
  if (!who) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const agentId = String(body.agent_id ?? "");
  if (!/^[a-z_]+$/.test(agentId)) return json({ error: "agent_id required" }, 400);

  const { data: a, error } = await db.from("agent_configs")
    .select("llm_provider, llm_model, max_tokens, temperature, enabled").eq("agent_id", agentId).maybeSingle();
  if (error || !a) return json({ error: `no agent '${agentId}' in agent_configs` }, 404);
  if (a.llm_model === "none") return json({ agent_id: agentId, ok: true, note: "this agent uses no model" });

  const raw = (await loadConfig(db))["llm.model_check"];
  if (!raw) return json({ error: "app_config llm.model_check is missing" }, 500);
  const probe = JSON.parse(raw) as Probe;

  const started = Date.now();
  try {
    const out = await callStructured<Record<string, unknown>>(
      { provider: a.llm_provider, model: a.llm_model, maxTokens: a.max_tokens, temperature: Number(a.temperature) },
      probe.system, [{ type: "text", text: probe.text }], probe.tool);
    return json({
      agent_id: agentId, ok: true, provider: a.llm_provider, model: a.llm_model, enabled: a.enabled,
      ms: Date.now() - started, usage: out.usage, answer: out.value,
    });
  } catch (e) {
    return json({ agent_id: agentId, ok: false, provider: a.llm_provider, model: a.llm_model, ms: Date.now() - started, error: (e as Error).message }, 200);
  }
}

if (import.meta.main) Deno.serve(handler);

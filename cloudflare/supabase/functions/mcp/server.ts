// The Nexus agents MCP server: its four tools, built per request for one signed-in user.
// Settings are read per request, so a change in app_config needs no deploy.
import { McpServer } from "npm:@modelcontextprotocol/server@^2.4.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@^2.119.2";
import { z } from "npm:zod@^4.1.13";
import { type Agent, clampLimit, clip, intSetting, overview, parseRegistry, type RunRow, runRequest, type Schedule } from "./agents.ts";

const SETTINGS = ["mcp.agents", "mcp.runs_default", "mcp.runs_max", "mcp.reviews_max", "mcp.result_max_chars"];
const RUN_COLUMNS = "id, agent_id, trigger, status, started_at, finished_at, metrics, error_message";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const failure = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** The server for one request. supabase is the client scoped to the caller;
 *  authorization is the caller's own bearer, passed to an agent's route on a
 *  run; functionsBase is this project's functions address. */
export async function nexusServer(
  supabase: SupabaseClient,
  authorization: string,
  functionsBase: string,
  fetcher: typeof fetch = fetch,
): Promise<McpServer> {
  const { data: rows, error } = await supabase.from("app_config").select("key, value").in("key", SETTINGS);
  if (error) throw new Error(`settings: ${error.message}`);
  const cfg = new Map((rows ?? []).map((r) => [r.key as string, r.value as unknown]));
  const agents: Agent[] = parseRegistry(cfg.get("mcp.agents"));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const ids = agents.map((a) => a.id) as [string, ...string[]];
  const runsDefault = intSetting(cfg, "mcp.runs_default");
  const runsMax = intSetting(cfg, "mcp.runs_max");
  const reviewsMax = intSetting(cfg, "mcp.reviews_max");
  const resultMax = intSetting(cfg, "mcp.result_max_chars");

  const latestRun = async (a: Agent, since?: string): Promise<RunRow | null> => {
    let q = supabase.from("agent_runs").select(RUN_COLUMNS).eq("agent_id", a.runs_as);
    if (since) q = q.gte("started_at", since);
    const { data, error } = await q.order("started_at", { ascending: false }).limit(1);
    if (error) throw new Error(`agent_runs: ${error.message}`);
    return (data?.[0] as RunRow | undefined) ?? null;
  };

  const server = new McpServer({ name: "nexus-agents", version: "1.0.0" });

  server.registerTool(
    "list_agents",
    {
      title: "Nexus agents",
      description: `The Nexus agents (${ids.join(", ")}): what each does, its schedule, and its latest run for you, with the count of review items waiting for your decision in Nexus.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [sched, latest, open] = await Promise.all([
        supabase.rpc("nx_agent_schedules"),
        Promise.all(agents.map((a) => latestRun(a))),
        supabase.from("review_items").select("item_type").eq("status", "open"),
      ]);
      if (sched.error) throw new Error(`schedules: ${sched.error.message}`);
      if (open.error) throw new Error(`review_items: ${open.error.message}`);
      const counts: Record<string, number> = {};
      for (const r of open.data ?? []) counts[r.item_type as string] = (counts[r.item_type as string] ?? 0) + 1;
      return text(overview(agents, (sched.data ?? []) as Schedule[], latest.filter((r): r is RunRow => !!r), counts));
    },
  );

  server.registerTool(
    "agent_runs",
    {
      title: "Runs of one agent",
      description: `Recent runs of one agent for you, newest first, with status, metrics and errors; with_steps adds the step trace of each run. At most ${runsMax} runs.`,
      inputSchema: z.object({
        agent: z.enum(ids),
        limit: z.number().int().min(1).max(runsMax).optional(),
        with_steps: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ agent, limit, with_steps }) => {
      const a = byId.get(agent)!;
      const { data, error } = await supabase.from("agent_runs")
        .select(with_steps ? `${RUN_COLUMNS}, steps` : RUN_COLUMNS)
        .eq("agent_id", a.runs_as)
        .order("started_at", { ascending: false })
        .limit(clampLimit(limit, runsDefault, runsMax));
      if (error) throw new Error(`agent_runs: ${error.message}`);
      return text(clip(JSON.stringify({ agent: a.id, runs: data ?? [] }, null, 2), resultMax));
    },
  );

  server.registerTool(
    "review_queue",
    {
      title: "Review items waiting for you",
      description: `Open review items the agents raised (expenses, assets, filings, invoice anomalies), newest first, at most ${reviewsMax}. Read only: you decide them in Nexus.`,
      inputSchema: z.object({
        item_type: z.enum(["expense", "asset", "filing", "invoice_anomaly"]).optional(),
        limit: z.number().int().min(1).max(reviewsMax).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item_type, limit }) => {
      let q = supabase.from("review_items")
        .select("id, item_type, summary, reason_codes, proposed, agent_run_id, created_at")
        .eq("status", "open");
      if (item_type) q = q.eq("item_type", item_type);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(clampLimit(limit, reviewsMax, reviewsMax));
      if (error) throw new Error(`review_items: ${error.message}`);
      return text(clip(JSON.stringify({ open: data ?? [], decide_in: "Nexus, the Review screen" }, null, 2), resultMax));
    },
  );

  server.registerTool(
    "run_agent",
    {
      title: "Run an agent now",
      description:
        "Runs one Nexus agent now for you, the same run the schedule does, and returns its result and run record. " +
        "Agents read your mail, banks, Moneybird or job sources as their schedule does and write only to your Nexus data; " +
        "anything that needs a decision opens a review item in Nexus. " +
        agents.map((a) => `${a.id}: ${a.does}${a.run_args.length ? ` (takes ${a.run_args.join(", ")})` : ""}`).join(". ") + ".",
      inputSchema: z.object({
        agent: z.enum(ids),
        args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ agent, args }) => {
      const a = byId.get(agent)!;
      let call: { url: string; body: Record<string, unknown> };
      try {
        call = runRequest(a, args, functionsBase);
      } catch (e) {
        return failure((e as Error).message);
      }
      const started = new Date().toISOString();
      const res = await fetcher(call.url, {
        method: "POST",
        headers: { Authorization: authorization, "content-type": "application/json" },
        body: JSON.stringify(call.body),
      });
      const body = await res.text();
      const run = await latestRun(a, started);
      const out = { agent: a.id, http_status: res.status, run, result: (() => { try { return JSON.parse(body); } catch { return body; } })() };
      const shown = clip(JSON.stringify(out, null, 2), resultMax);
      return res.ok ? text(shown) : failure(shown);
    },
  );

  return server;
}

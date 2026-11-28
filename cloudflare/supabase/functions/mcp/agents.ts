// The rules behind the Nexus agents MCP server, kept free of I/O so they are
// tested on their own: reading the registry, laying out the overview, and
// building the request that runs an agent for the caller.

export interface Agent {
  id: string;
  label: string;
  does: string;
  route: string;
  run_body: Record<string, unknown>;
  runs_as: string;
  cron_job: string;
  run_args: string[];
}

export interface Schedule {
  jobname: string;
  schedule: string;
  active: boolean;
  last_start: string | null;
  last_status: string | null;
}

export interface RunRow {
  id: string;
  agent_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  metrics: Record<string, unknown> | null;
  error_message: string | null;
  steps?: unknown;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The mcp.agents setting as agents. Anything malformed is refused whole, so
 *  a typo in the setting never runs the wrong route. */
export function parseRegistry(raw: unknown): Agent[] {
  const list = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(list) || !list.length) throw new Error("mcp.agents is not a list of agents");
  const seen = new Set<string>();
  return list.map((a, i) => {
    if (!isObject(a)) throw new Error(`mcp.agents[${i}] is not an object`);
    for (const k of ["id", "label", "does", "route", "runs_as", "cron_job"]) {
      if (!isText(a[k])) throw new Error(`mcp.agents[${i}].${k} is missing`);
    }
    const route = String(a.route);
    // A route is a function path inside this project, never a full address.
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(route)) throw new Error(`mcp.agents[${i}].route '${route}' is not a function path`);
    if (seen.has(String(a.id))) throw new Error(`mcp.agents has '${a.id}' twice`);
    seen.add(String(a.id));
    const runArgs = a.run_args ?? [];
    if (!Array.isArray(runArgs) || !runArgs.every(isText)) throw new Error(`mcp.agents[${i}].run_args is not a list of names`);
    return {
      id: String(a.id), label: String(a.label), does: String(a.does), route,
      run_body: isObject(a.run_body) ? a.run_body : {},
      runs_as: String(a.runs_as), cron_job: String(a.cron_job), run_args: runArgs as string[],
    };
  });
}

/** A whole number setting, or a clear error naming it. */
export function intSetting(cfg: Map<string, unknown>, key: string): number {
  const n = Number(cfg.get(key));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`setting ${key} is missing or not a positive whole number`);
  return n;
}

/** A requested count kept between one and the setting's maximum. */
export function clampLimit(asked: number | undefined, fallback: number, max: number): number {
  if (asked === undefined || !Number.isFinite(asked)) return Math.min(fallback, max);
  return Math.max(1, Math.min(Math.trunc(asked), max));
}

/** One line per agent: what it does, when the scheduler runs it, and how its
 *  latest run for the caller went. */
export function overview(agents: Agent[], schedules: Schedule[], latest: RunRow[], openReviews: Record<string, number>) {
  const sched = new Map(schedules.map((s) => [s.jobname, s]));
  const last = new Map<string, RunRow>();
  for (const r of latest) {
    const had = last.get(r.agent_id);
    if (!had || r.started_at > had.started_at) last.set(r.agent_id, r);
  }
  return {
    agents: agents.map((a) => {
      const s = sched.get(a.cron_job);
      const r = last.get(a.runs_as);
      return {
        id: a.id,
        label: a.label,
        does: a.does,
        schedule: s ? { cron: s.schedule, active: s.active, scheduler_last_start: s.last_start, scheduler_last_status: s.last_status } : null,
        last_run: r
          ? { id: r.id, status: r.status, trigger: r.trigger, started_at: r.started_at, finished_at: r.finished_at, metrics: r.metrics, error: r.error_message }
          : null,
        run_args: a.run_args,
      };
    }),
    open_reviews: openReviews,
    approvals: "Review items are decided in Nexus (the Review screen on the web or the phone). This server reads them and cannot decide them.",
  };
}

/** The request that runs an agent for the caller: the agent's own body plus
 *  only the extra arguments its registry entry allows. */
export function runRequest(agent: Agent, args: Record<string, unknown> | undefined, functionsBase: string) {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!agent.run_args.includes(k)) throw new Error(`${agent.id} takes no argument '${k}'${agent.run_args.length ? `; it takes ${agent.run_args.join(", ")}` : ""}`);
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new Error(`argument '${k}' must be text, a number or true/false`);
    extra[k] = v;
  }
  return { url: `${functionsBase.replace(/\/+$/, "")}/${agent.route}`, body: { ...extra, ...agent.run_body } };
}

/** Text of a result, cut at the configured length with a note saying so. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut at ${max} characters; the full result is in Nexus]`;
}

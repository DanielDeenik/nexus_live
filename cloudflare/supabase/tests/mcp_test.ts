// The Nexus agents MCP server on an in-memory Postgres with the real migration and the
// live row rules for agent_runs and review_items: the registry the migration writes, the
// request a run sends, and the four tools over the MCP protocol, as the signed-in user.
// Everyone here is made up. Run: deno test --allow-read --allow-env supabase/tests/mcp_test.ts
import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.6.0";
import { createMcpHandler } from "npm:@modelcontextprotocol/server@^2.4.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@^2.119.2";
import { parseRegistry, runRequest } from "../functions/mcp/agents.ts";
import { nexusServer } from "../functions/mcp/server.ts";

const here = new URL("../", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, here));
const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BASE = "https://example.test/functions/v1";
const BEARER = "Bearer user-token-for-the-test";

async function world(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table app_config (key text primary key, value text not null, description text, updated_at timestamptz not null default now());
    alter table app_config enable row level security;
    create policy app_config_read on app_config for select using (true);
    create table agent_runs (id uuid primary key default gen_random_uuid(), user_id uuid not null, agent_id text not null, trigger text not null,
      status text not null default 'running', started_at timestamptz not null default now(), finished_at timestamptz, input_json jsonb,
      steps jsonb, metrics jsonb, error_message text);
    alter table agent_runs enable row level security;
    create policy agent_runs_select_own on agent_runs for select using (user_id = auth.uid());
    create table review_items (id uuid primary key default gen_random_uuid(), user_id uuid not null, item_type text not null, item_id uuid,
      reason_codes text[], summary text, proposed jsonb, status text not null default 'open', decision jsonb, decided_by uuid,
      decided_at timestamptz, agent_run_id uuid, created_at timestamptz not null default now());
    alter table review_items enable row level security;
    create policy review_items_select_own on review_items for select using (user_id = auth.uid());
    grant usage on schema public, auth to authenticated;
    grant select on app_config, agent_runs, review_items to authenticated;
    create schema cron;
    create table cron.job (jobid bigint primary key, jobname text, schedule text, active boolean);
    create table cron.job_run_details (runid bigint primary key, jobid bigint, status text, start_time timestamptz);
    insert into cron.job values (1, 'nexus-expense-agent', '17 5 * * *', true), (2, 'nexus-tax-agent', '41 5 * * 1', true),
      (3, 'something-else', '* * * * *', true);
    insert into cron.job_run_details values (10, 1, 'succeeded', now() - interval '2 hours'), (11, 1, 'failed', now() - interval '1 hour'),
      (12, 3, 'succeeded', now());`);
  await db.exec(read("migrations/20261128000004_agents_mcp.sql"));
  await db.query(`insert into agent_runs (user_id, agent_id, trigger, status, started_at, metrics) values
    ($1, 'expense', 'cron', 'succeeded', now() - interval '1 day', '{"docs": 3}'),
    ($1, 'expense', 'cron', 'partial', now() - interval '1 hour', '{"docs": 1, "step_errors": 1}'),
    ($2, 'expense', 'manual', 'failed', now(), '{}'),
    ($1, 'tax_drafter', 'cron', 'succeeded', now() - interval '5 days', '{}')`, [U, OTHER]);
  await db.query(`insert into review_items (user_id, item_type, summary, status) values
    ($1, 'expense', 'Receipt without a bank line', 'open'), ($1, 'filing', 'VAT Q4 draft', 'open'),
    ($1, 'expense', 'Already decided', 'approved'), ($2, 'expense', 'Someone else', 'open')`, [U, OTHER]);
  return db;
}

// The few supabase-js calls the server makes, run as the signed-in user against PGlite,
// so the live row rules decide what comes back.
function asUser(db: PGlite, user: string | null): SupabaseClient {
  const run = async (sql: string, params: unknown[]) => {
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user ?? ""]);
        return (await tx.query(sql, params)).rows;
      });
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
  const from = (table: string) => {
    let cols = "*";
    const where: string[] = [];
    const params: unknown[] = [];
    let order = "";
    let limit = "";
    const q = {
      select(c: string) { cols = c; return q; },
      eq(c: string, v: unknown) { params.push(v); where.push(`${c} = $${params.length}`); return q; },
      gte(c: string, v: unknown) { params.push(v); where.push(`${c} >= $${params.length}`); return q; },
      in(c: string, vs: unknown[]) { params.push(vs); where.push(`${c} = any($${params.length})`); return q; },
      order(c: string, o: { ascending: boolean }) { order = ` order by ${c} ${o.ascending ? "asc" : "desc"}`; return q; },
      limit(n: number) { limit = ` limit ${n}`; return q; },
      then(ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) {
        const sql = `select ${cols} from ${table}${where.length ? ` where ${where.join(" and ")}` : ""}${order}${limit}`;
        return run(sql, params).then(ok, bad);
      },
    };
    return q;
  };
  const rpc = (name: string) => run(`select * from ${name}()`, []);
  return { from, rpc } as unknown as SupabaseClient;
}

type Sent = { url: string; init: RequestInit };
async function call(db: PGlite, method: string, params: Record<string, unknown> = {}, sent: Sent[] = [], status = 200) {
  const fetcher = ((url: string, init: RequestInit) => {
    sent.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ results: [{ ok: true }] }), { status }));
  }) as typeof fetch;
  const handler = createMcpHandler(() => nexusServer(asUser(db, U), BEARER, BASE, fetcher));
  const res = await handler.fetch(new Request("https://example.test/functions/v1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  const raw = await res.text();
  const json = raw.trim().startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json);
}
const toolText = (r: { result: { content: { text: string }[] } }) => JSON.parse(r.result.content[0].text);

Deno.test("the registry the migration writes names eight agents whose runs the code logs under their names", async () => {
  const db = await world();
  const raw = (await db.query<{ value: string }>("select value from app_config where key = 'mcp.agents'")).rows[0].value;
  const agents = parseRegistry(raw);
  assertEquals(agents.map((a) => a.id), ["expense", "tax", "forecast", "accounts", "spend", "moneybird", "recruiter", "role_monitor"]);
  const fns = new URL("functions/", here);
  const nexusRouter = Deno.readTextFileSync(new URL("nexus/index.ts", fns));
  for (const a of agents) {
    const [fn, sub] = a.route.split("/");
    if (sub) {
      assertEquals(fn, "nexus");
      assert(nexusRouter.includes(`"${sub}": `), `${a.route} is not a nexus route`);
    } else {
      Deno.statSync(new URL(`${fn}/index.ts`, fns));
    }
    // The agent's own code logs its runs under runs_as.
    const dir = sub ?? fn;
    const code = Deno.readTextFileSync(new URL(`${dir}/index.ts`, fns));
    assert(code.includes(`"${a.runs_as}"`), `${dir} never logs a run as ${a.runs_as}`);
  }
  await db.close();
});

Deno.test("a registry with a full address, a twice-named agent or a missing field is refused whole", () => {
  const ok = { id: "x", label: "X", does: "d", route: "nexus/x", runs_as: "x", cron_job: "j", run_body: {}, run_args: [] };
  parseRegistry([ok]);
  assertThrows(() => parseRegistry([{ ...ok, route: "https://elsewhere.test/x" }]), Error, "not a function path");
  assertThrows(() => parseRegistry([ok, ok]), Error, "twice");
  assertThrows(() => parseRegistry([{ ...ok, runs_as: "" }]), Error, "runs_as");
  assertThrows(() => parseRegistry([]), Error, "not a list");
});

Deno.test("a run sends the agent's own body, and only the arguments its entry allows", () => {
  const tax = { id: "tax", label: "Tax", does: "d", route: "nexus/tax-agent", runs_as: "tax_drafter", cron_job: "j", run_body: { mode: "x" }, run_args: ["kind", "period", "mode"] };
  const r = runRequest(tax, { kind: "vat_quarter", period: "2026-Q4", mode: "other" }, `${BASE}/`);
  assertEquals(r.url, `${BASE}/nexus/tax-agent`);
  assertEquals(r.body, { kind: "vat_quarter", period: "2026-Q4", mode: "x" }); // the entry's own body wins
  assertThrows(() => runRequest({ ...tax, run_args: [] }, { user_id: OTHER }, BASE), Error, "takes no argument 'user_id'");
});

Deno.test("Claude Code sees four tools, three of them read only, and no tool that decides", async () => {
  const db = await world();
  const r = await call(db, "tools/list");
  const tools = r.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
  assertEquals(tools.map((t) => t.name).sort(), ["agent_runs", "list_agents", "review_queue", "run_agent"]);
  assertEquals(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort(), ["agent_runs", "list_agents", "review_queue"]);
  assert(!tools.some((t) => /approve|decide|reject/.test(t.name)));
  await db.close();
});

Deno.test("list_agents shows your latest run, the schedule and your open reviews, nobody else's", async () => {
  const db = await world();
  const o = toolText(await call(db, "tools/call", { name: "list_agents", arguments: {} }));
  const expense = o.agents.find((a: { id: string }) => a.id === "expense");
  assertEquals(expense.last_run.status, "partial"); // OTHER's newer failed run is not yours
  assertEquals(expense.schedule.cron, "17 5 * * *");
  assertEquals(expense.schedule.scheduler_last_status, "failed");
  assertEquals(o.agents.find((a: { id: string }) => a.id === "tax").last_run.status, "succeeded");
  assertEquals(o.agents.find((a: { id: string }) => a.id === "forecast").last_run, null);
  assertEquals(o.agents.find((a: { id: string }) => a.id === "forecast").schedule, null); // no such job in this cron
  assertEquals(o.open_reviews, { expense: 1, filing: 1 });
  assertMatch(o.approvals, /decided in Nexus/);
  await db.close();
});

Deno.test("agent_runs lists your runs newest first and keeps to the limit", async () => {
  const db = await world();
  const o = toolText(await call(db, "tools/call", { name: "agent_runs", arguments: { agent: "expense", limit: 1 } }));
  assertEquals(o.runs.length, 1);
  assertEquals(o.runs[0].status, "partial");
  const all = toolText(await call(db, "tools/call", { name: "agent_runs", arguments: { agent: "expense", with_steps: true } }));
  assertEquals(all.runs.map((r: { status: string }) => r.status), ["partial", "succeeded"]);
  assert("steps" in all.runs[0]);
  await db.close();
});

Deno.test("review_queue reads your open items and says where to decide them", async () => {
  const db = await world();
  const o = toolText(await call(db, "tools/call", { name: "review_queue", arguments: { item_type: "expense" } }));
  assertEquals(o.open.map((i: { summary: string }) => i.summary), ["Receipt without a bank line"]);
  assertEquals(o.decide_in, "Nexus, the Review screen");
  await db.close();
});

Deno.test("run_agent calls the agent's route with your own sign-in and its own body", async () => {
  const db = await world();
  const sent: Sent[] = [];
  const r = await call(db, "tools/call", { name: "run_agent", arguments: { agent: "accounts" } }, sent);
  assert(!r.result.isError);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url, `${BASE}/nexus/accounts`);
  assertEquals(JSON.parse(String(sent[0].init.body)), { action: "sync" });
  assertEquals((sent[0].init.headers as Record<string, string>).Authorization, BEARER);
  assertEquals(toolText(r).http_status, 200);
  await db.close();
});

Deno.test("run_agent refuses an argument the agent does not take, before anything runs", async () => {
  const db = await world();
  const sent: Sent[] = [];
  const r = await call(db, "tools/call", { name: "run_agent", arguments: { agent: "spend", args: { user_id: OTHER } } }, sent);
  assert(r.result.isError);
  assertEquals(sent.length, 0);
  const failed = await call(db, "tools/call", { name: "run_agent", arguments: { agent: "spend" } }, [], 500);
  assert(failed.result.isError);
  await db.close();
});

Deno.test("schedules show only the registry's jobs, and nothing without a sign-in", async () => {
  const db = await world();
  const mine = await asUser(db, U).rpc("nx_agent_schedules");
  assertEquals((mine.data as { jobname: string }[]).map((j) => j.jobname).sort(), ["nexus-expense-agent", "nexus-tax-agent"]);
  const none = await asUser(db, null).rpc("nx_agent_schedules");
  assertEquals(none.data, []);
  await db.close();
});

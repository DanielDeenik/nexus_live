// recruiter: the recruiter agent and the role monitor.
//
// POST { mode: "intake" }   scheduler or Dan: work the Gmail intake queue
// POST { mode: "roles" }    scheduler or Dan: scan job sources
// POST { mode: "assess", spec, role?, company? }   Dan: weigh a pasted spec (no drafts)
// POST { mode: "role_status", role_id, status }    Dan: shortlist, dismiss or mark applied
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize, getEnv } from "../_shared/client.ts";
import { type AppConfig, loadConfig, need } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { googleAccessToken, type Connection } from "../_shared/collectors.ts";
import { Google } from "../_shared/google.ts";
import { AgentRun, type Trigger } from "../_shared/harness.ts";
import { type LlmParams, structuredFor } from "../_shared/llm.ts";
import { masterName, cvMarkdown } from "./cv.ts";
import { readingPrompt, readingTool, scoreSpec, type SpecReading } from "./fit.ts";
import { buildGraph, parseIntake, type RecruiterState, type Submission } from "./graph.ts";
import { loadKnowledge } from "./knowledge.ts";
import { dedup, dedupKey, fetchSource, type RoleItem } from "./roles.ts";
import { localDate } from "./slots.ts";

const ROLE_STATUSES = new Set(["new", "shortlisted", "dismissed", "applied"]);

async function agentLlm(db: SupabaseClient, agentId: string): Promise<{ params: LlmParams; system: string }> {
  const { data, error } = await db.from("agent_configs")
    .select("system_prompt, llm_provider, llm_model, max_tokens, temperature, enabled").eq("agent_id", agentId).single();
  if (error || !data) throw new Error(`${agentId} agent config missing`);
  if (!data.enabled) throw new Error(`${agentId} agent is disabled in agent_configs`);
  return {
    params: { provider: data.llm_provider, model: data.llm_model, maxTokens: data.max_tokens, temperature: Number(data.temperature) },
    system: data.system_prompt,
  };
}

/** The agent prompt from agent_configs leads every call; the node adds its own context. */
function withSystem(base: ReturnType<typeof structuredFor>, system: string): ReturnType<typeof structuredFor> {
  return (s, content, tool) => base(`${system}\n\n${s}`, content, tool);
}

async function googleFor(db: SupabaseClient, cfg: AppConfig, userId: string): Promise<Google> {
  const { data } = await db.from("integration_connections").select("id, provider, vault_secret_id, settings, cursor, scopes")
    .eq("user_id", userId).eq("provider", "google").eq("status", "active").maybeSingle();
  if (!data) throw new Error("Google is not connected: connect it in Agent settings");
  const want = (cfg["integrations.google_scopes_extra"] ?? "").split(/\s+/).filter(Boolean);
  const have = new Set((data.scopes as string[] | null) ?? []);
  const missing = want.filter((s) => !have.has(s));
  if (missing.length) throw new Error(`Google is connected without draft and calendar access; press Connect Google again to grant: ${missing.join(", ")}`);
  return new Google(await googleAccessToken(db, cfg, data as Connection), cfg);
}

async function runIntake(db: SupabaseClient, cfg: AppConfig, userId: string, trigger: Trigger) {
  const run = await AgentRun.start(db, userId, "recruiter", trigger, { mode: "intake" });
  try {
    const k = (await run.step("load_knowledge", () => loadKnowledge(db, cfg, userId), { summarize: (k) => ({ fetched: k.fetched, cached: k.cached }) }))!;
    const google = (await run.step("connect_google", () => googleFor(db, cfg, userId)))!;
    const { params, system } = await agentLlm(db, "recruiter");
    const structured = withSystem(structuredFor(params), system);
    const name = masterName(k.cvMaster);

    // Already handled: by this agent (recorded) or by the earlier Cowork batch (its "handled" mails).
    const legacyQ = cfg["recruiter.legacy_handled_query"].replace("{prefix}", k.agent.handled_subject_prefix);
    const legacy = new Set((await run.step("legacy_handled", () => google.subjects(legacyQ, 200)))!.map((s) => s.match(/\[([0-9a-f]+)\]/)?.[1]).filter(Boolean) as string[]);
    const intakeQ = cfg["recruiter.intake_query"].replace("{intake_from}", k.agent.intake_from);
    const ids = (await run.step("intake_search", () => google.searchIds(intakeQ, 100)))!;
    const { data: known } = await db.from("rec_submissions").select("gmail_message_id").eq("user_id", userId).in("gmail_message_id", ids.length ? ids : ["-"]);
    const done = new Set((known ?? []).map((r) => r.gmail_message_id as string));
    const todo = ids.filter((id) => !done.has(id) && !legacy.has(id)).reverse().slice(0, need(cfg, "recruiter.max_per_run"));
    run.count("queued", todo.length);

    for (const id of todo) {
      await run.step(`submission:${id}`, async () => {
        const msg = await google.message(id);
        const sub = parseIntake(id, msg.receivedAt, msg.text);
        if (!sub) {
          await db.from("rec_submissions").insert({ user_id: userId, gmail_message_id: id, received_at: msg.receivedAt, kind: "question", status: "skipped", error: "no LensIQ JSON block in the message", agent_run_id: run.id });
          run.count("skipped");
          return;
        }
        const { data: row, error } = await db.from("rec_submissions").insert({
          user_id: userId, gmail_message_id: id, received_at: sub.receivedAt, kind: sub.kind, name: sub.name, email: sub.email,
          company: sub.company, role: sub.role, call_preference: sub.call_preference, question: sub.question, spec: sub.spec, agent_run_id: run.id,
        }).select("id").single();
        if (error) throw new Error(error.message);
        try {
          const st = await processSubmission(db, cfg, userId, run, google, structured, k, name, sub);
          await record(db, userId, run, row.id as string, sub, st, name);
          run.count(`handled_${sub.kind}`);
        } catch (e) {
          await db.from("rec_submissions").update({ status: "failed", error: (e as Error).message.slice(0, 1000), handled_at: new Date().toISOString() }).eq("id", row.id);
          throw e;
        }
      }, { tolerate: true });
    }
    await run.finish();
  } catch (e) {
    await run.finish(e);
  }
  return { run_id: run.id, metrics: run.metrics };
}

async function processSubmission(
  db: SupabaseClient, cfg: AppConfig, userId: string, run: AgentRun, google: Google,
  structured: ReturnType<typeof structuredFor>, k: Awaited<ReturnType<typeof loadKnowledge>>, name: string, sub: Submission,
): Promise<RecruiterState> {
  const bucket = cfg["recruiter.cv_bucket"];
  const graph = buildGraph({
    structured,
    mail: google,
    k,
    name,
    now: new Date(),
    step: async (n, fn) => (await run.step(`${sub.id}:${n}`, fn))!,
    saveCv: async (file, bytes) => {
      const path = `${userId}/${sub.id}/${file}`;
      const { error } = await db.storage.from(bucket).upload(path, bytes, { upsert: true, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      if (error) throw new Error(`CV upload: ${error.message}`);
      return path;
    },
    callsPerDay: async () => {
      const { data } = await db.from("rec_submissions").select("outcome").eq("user_id", userId).not("calendar_event_id", "is", null);
      const m = new Map<string, number>();
      for (const r of data ?? []) {
        const at = (r.outcome as { call_at?: string })?.call_at;
        if (at) {
          const d = localDate(new Date(at), k.agent.call_timezone);
          m.set(d, (m.get(d) ?? 0) + 1);
        }
      }
      return m;
    },
  });
  return await graph.invoke({ sub }) as RecruiterState;
}

async function record(db: SupabaseClient, userId: string, run: AgentRun, submissionId: string, sub: Submission, st: RecruiterState, name: string) {
  let fitId: string | null = null;
  if (st.fit && st.reading) {
    const { data, error } = await db.from("rec_fit_reports").insert({
      user_id: userId, submission_id: submissionId, role_title: st.reading.role_title, company: st.reading.company,
      score: st.fit.score, verdict: st.fit.verdict, is_match: st.fit.isMatch, centre_of_gravity: st.fit.centre.label,
      requirements: st.fit.requirements, gaps: st.fit.gaps, report: st.fit.report, agent_run_id: run.id,
    }).select("id").single();
    if (error) throw new Error(error.message);
    fitId = data.id as string;
  }
  const appDraft = st.cv ? st.drafts[st.drafts.length - 1] : null;
  if (st.cv && appDraft) {
    const { error } = await db.from("rec_applications").insert({
      user_id: userId, submission_id: submissionId, fit_report_id: fitId, role_title: st.reading?.role_title || sub.role || "role",
      company: st.reading?.company ?? sub.company, recipient_email: appDraft.to, cv_markdown: cvMarkdown(st.cv, name), cover_letter: st.cv.cover_letter,
      cv_path: st.cvPath, gmail_draft_id: appDraft.id, agent_run_id: run.id,
    });
    if (error) throw new Error(error.message);
  }
  const status = st.fit && !st.fit.isMatch ? "no_match" : st.drafts.length ? "drafted" : st.eventId ? "scheduled" : "skipped";
  await db.from("rec_submissions").update({
    status,
    gmail_draft_id: st.drafts[st.drafts.length - 1]?.id ?? null,
    calendar_event_id: st.eventId,
    outcome: { drafts: st.drafts, call_at: st.callAt, score: st.fit?.score ?? null, answer: st.answer },
    handled_at: new Date().toISOString(),
  }).eq("id", submissionId);
}

async function runRoles(db: SupabaseClient, cfg: AppConfig, userId: string, trigger: Trigger) {
  const run = await AgentRun.start(db, userId, "role_monitor", trigger, { mode: "roles" });
  try {
    const k = (await run.step("load_knowledge", () => loadKnowledge(db, cfg, userId)))!;
    const now = new Date();
    const maxAge = need(cfg, "recruiter.role_max_age_days");
    const minScore = need(cfg, "recruiter.role_min_score");
    const items: RoleItem[] = [];
    for (const src of k.jobs.sources) {
      const got = await run.step(`source:${src.id}`, () => fetchSource(src, k.jobs, now, maxAge, getEnv), { tolerate: true, summarize: (r) => ({ items: r.length }) });
      if (got) items.push(...got);
    }
    const roles = dedup(items, k.jobs).filter((r) => r.score >= minScore);
    run.count("roles", roles.length);
    await run.step("store", async () => {
      for (const r of roles) {
        const key = dedupKey(r.title, k.jobs.scoring.dedupKeyLen);
        const { data: ex } = await db.from("rec_roles").select("id, source_ids").eq("user_id", userId).eq("dedup_key", key).maybeSingle();
        const fields = { title: r.title, company: r.company, link: r.link, posted_at: r.postedAt, snippet: r.snippet, score: r.score, tier: r.tier, matched: r.matched, last_seen_at: now.toISOString() };
        if (ex) {
          await db.from("rec_roles").update({ ...fields, source_ids: [...new Set([...(ex.source_ids as string[]), ...r.sources])] }).eq("id", ex.id);
        } else {
          await db.from("rec_roles").insert({ user_id: userId, dedup_key: key, source_ids: r.sources, ...fields });
          run.count("new_roles");
        }
      }
    });
    await run.finish();
  } catch (e) {
    await run.finish(e);
  }
  return { run_id: run.id, metrics: run.metrics };
}

async function assess(db: SupabaseClient, cfg: AppConfig, userId: string, body: Record<string, unknown>) {
  const spec = String(body.spec ?? "").trim();
  if (spec.length < 40) throw new Error("paste the job spec (at least a few lines)");
  const run = await AgentRun.start(db, userId, "recruiter", "manual", { mode: "assess", chars: spec.length });
  try {
    const k = (await run.step("load_knowledge", () => loadKnowledge(db, cfg, userId)))!;
    const { params, system } = await agentLlm(db, "recruiter");
    const res = (await run.step("read_spec", () =>
      structuredFor(params)<SpecReading>(`${system}\n\n${readingPrompt(k.profile)}`,
        [{ type: "text", text: `Role field: ${body.role ?? "(empty)"}\nCompany field: ${body.company ?? "(empty)"}\n\nSPEC:\n${spec}` }], readingTool(k.profile))))!;
    const fit = scoreSpec(res.value, k.profile, k.agent);
    const { data, error } = await db.from("rec_fit_reports").insert({
      user_id: userId, role_title: res.value.role_title, company: res.value.company, score: fit.score, verdict: fit.verdict,
      is_match: fit.isMatch, centre_of_gravity: fit.centre.label, requirements: fit.requirements, gaps: fit.gaps, report: fit.report, agent_run_id: run.id,
    }).select("id").single();
    if (error) throw new Error(error.message);
    await run.finish();
    return { fit_report_id: data.id, score: fit.score, is_match: fit.isMatch, verdict: fit.verdict, report: fit.report };
  } catch (e) {
    await run.finish(e);
    throw e;
  }
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const caller = who.kind === "user" ? who.id : null;
    const body = await req.json().catch(() => ({}));
    const cfg = await loadConfig(db);

    if (body.mode === "assess") {
      if (!caller) return json({ error: "sign in required" }, 401);
      return json(await assess(db, cfg, caller, body));
    }
    if (body.mode === "role_status") {
      if (!caller) return json({ error: "sign in required" }, 401);
      if (!ROLE_STATUSES.has(String(body.status))) return json({ error: "unknown status" }, 400);
      const { data, error } = await db.from("rec_roles").update({ status: body.status }).eq("id", String(body.role_id)).eq("user_id", caller).select("id");
      if (error) return json({ error: error.message }, 400);
      if (!data?.length) return json({ error: "no such role" }, 404);
      return json({ ok: true });
    }
    if (body.mode !== "intake" && body.mode !== "roles") return json({ error: "mode must be intake, roles, assess or role_status" }, 400);

    // The scheduler runs for every owner with a profile; Dan runs it for himself.
    const users = caller ? [caller] : ((await db.from("profiles").select("id")).data ?? []).map((r) => r.id as string);
    const results = [];
    for (const u of users) {
      results.push(body.mode === "intake" ? await runIntake(db, cfg, u, caller ? "manual" : "cron") : await runRoles(db, cfg, u, caller ? "manual" : "cron"));
    }
    return json({ results });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

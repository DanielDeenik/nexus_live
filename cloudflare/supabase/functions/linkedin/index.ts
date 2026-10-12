// linkedin: imports LinkedIn exports Dan uploads into the li_ tables.
//
// POST { mode: "import", path, kind? }
//   path  a file Dan uploaded to his own folder in the configured bucket
//   kind  "content" (analytics .xlsx), "archive" (data .zip), "screenshot",
//         or "profile_views" / "search_appearances" for a screenshot whose
//         page is known; detected from the file when left out.
// Every import is idempotent: rows upsert on natural keys and the li_imports
// row upserts on the file hash. The insights themselves are read by the web
// app through the li_summary RPC under the owner's own RLS.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, authorize } from "../_shared/client.ts";
import { type AppConfig, loadConfig, need } from "../_shared/config.ts";
import { json, preflight } from "../_shared/cors.ts";
import { AgentRun, sha256Hex, toBase64 } from "../_shared/harness.ts";
import { callStructured, type LlmParams } from "../_shared/llm.ts";
import {
  type ArchiveImport, cleanReading, type ContentExport, detectKind, imageMediaType, type Kind, type LinkedInConfig,
  linkedinConfig, nameKey, parseArchive, parseContentExport, type ScreenshotReading, screenshotTool, urlKey,
} from "./parse.ts";

const KINDS: Record<string, { kind: Kind; hint?: "views" | "search" }> = {
  content: { kind: "content" },
  archive: { kind: "archive" },
  screenshot: { kind: "screenshot" },
  profile_views: { kind: "screenshot", hint: "views" },
  search_appearances: { kind: "screenshot", hint: "search" },
};

type Counts = Record<string, number | string | null>;
interface Outcome { counts: Counts; period: { from: string; to: string } | null; warnings: string[] }

/** Upserts in chunks, grouping rows by their key set so a column one export
 *  lacks is never written as null over a value an earlier export gave. */
async function upsert(db: SupabaseClient, tableName: string, rows: Record<string, unknown>[], onConflict: string, chunk: number) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = Object.keys(r).sort().join(",");
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i += chunk) {
      const { error } = await db.from(tableName).upsert(g.slice(i, i + chunk), { onConflict });
      if (error) throw new Error(`${tableName}: ${error.message}`);
    }
  }
}

async function storeContent(db: SupabaseClient, userId: string, importId: string, x: ContentExport, chunk: number): Promise<Outcome> {
  const now = new Date().toISOString();
  const days = x.days.map((d) => {
    const r: Record<string, unknown> = { user_id: userId, day: d.day, import_id: importId, updated_at: now };
    for (const k of ["impressions", "engagements", "new_followers"] as const) if (d[k] !== undefined) r[k] = d[k];
    return r;
  });
  await upsert(db, "li_content_daily", days, "user_id,day", chunk);
  const posts = x.posts.map((p) => {
    const r: Record<string, unknown> = { user_id: userId, url: p.url, import_id: importId, updated_at: now };
    if (p.published_on) r.published_on = p.published_on;
    if (p.impressions !== undefined) r.impressions = p.impressions;
    if (p.engagements !== undefined) r.engagements = p.engagements;
    return r;
  });
  await upsert(db, "li_posts", posts, "user_id,url", chunk);
  if (x.followersTotal?.as_of) {
    await upsert(db, "li_followers_total", [{ user_id: userId, as_of: x.followersTotal.as_of, total: x.followersTotal.total, import_id: importId }], "user_id,as_of", chunk);
  }
  const asOf = x.period?.to ?? x.followersTotal?.as_of ?? now.slice(0, 10);
  await upsert(db, "li_audience", x.audience.map((a) => ({ user_id: userId, as_of: asOf, ...a, import_id: importId })), "user_id,as_of,dimension,value", chunk);
  return {
    counts: {
      days: days.length, posts: posts.length, audience_rows: x.audience.length,
      followers_total: x.followersTotal?.total ?? null,
      impressions_overall: x.discovery.impressions, members_reached: x.discovery.members_reached,
      sheets: x.sheetsFound.join(","),
    },
    period: x.period,
    warnings: x.warnings,
  };
}

async function storeArchive(db: SupabaseClient, userId: string, importId: string, x: ArchiveImport, chunk: number): Promise<Outcome> {
  const now = new Date().toISOString();
  // A connection is keyed by profile URL when the export gives one, else by name.
  const conns = new Map<string, Record<string, unknown>>();
  for (const c of x.connections) {
    const key = c.profile_url ? `url:${urlKey(c.profile_url)}` : `name:${nameKey(c.name)}`;
    conns.set(key, { user_id: userId, conn_key: key, ...c, import_id: importId, updated_at: now });
  }
  await upsert(db, "li_connections", [...conns.values()], "user_id,conn_key", chunk);
  await upsert(db, "li_messages", x.messages.map((m) => ({ user_id: userId, ...m, import_id: importId })), "user_id,msg_key", chunk);
  return {
    counts: {
      connections: conns.size,
      recruiter_connections: x.connections.filter((c) => c.is_recruiter).length,
      inbound_messages: x.messages.length,
      inbound_recruiter_messages: x.messages.filter((m) => m.is_recruiter).length,
      own_messages_skipped: x.skipped.own_messages,
      unreadable_messages: x.skipped.unreadable,
      invitations_inbound: x.invitations.inbound,
      invitations_inbound_recruiter: x.invitations.inbound_recruiter,
      self_identified_by: x.self.source,
      files: x.filesFound.join(","),
    },
    period: x.period,
    warnings: x.warnings,
  };
}

async function agentLlm(db: SupabaseClient): Promise<{ params: LlmParams; system: string }> {
  const { data, error } = await db.from("agent_configs")
    .select("system_prompt, llm_provider, llm_model, max_tokens, temperature, enabled").eq("agent_id", "linkedin").single();
  if (error || !data) throw new Error("linkedin agent config missing");
  if (!data.enabled) throw new Error("linkedin agent is disabled in agent_configs");
  return {
    params: { provider: data.llm_provider, model: data.llm_model, maxTokens: data.max_tokens, temperature: Number(data.temperature) },
    system: data.system_prompt,
  };
}

async function readScreenshot(db: SupabaseClient, cfg: AppConfig, run: AgentRun, bytes: Uint8Array, mediaType: string, hint?: "views" | "search"): Promise<ScreenshotReading> {
  const { params, system } = await agentLlm(db);
  const instruction = cfg["linkedin.screenshot_instruction"];
  if (!instruction) throw new Error("app_config linkedin.screenshot_instruction is missing");
  const hints = JSON.parse(cfg["linkedin.screenshot_hints"] ?? "{}") as Record<string, string>;
  const text = [instruction, hint ? hints[hint] : ""].filter(Boolean).join("\n\n");
  const out = await callStructured<unknown>(params, system, [
    { type: "image", source: { type: "base64", media_type: mediaType, data: toBase64(bytes) } },
    { type: "text", text },
  ], screenshotTool);
  run.count("input_tokens", out.usage.input_tokens);
  run.count("output_tokens", out.usage.output_tokens);
  const r = cleanReading(out.value);
  // The owner's label wins only when the model could not tell the page.
  if (r.kind === "unknown" && hint) r.kind = hint;
  return r;
}

async function storeScreenshot(db: SupabaseClient, userId: string, importId: string, sha: string, r: ScreenshotReading): Promise<Outcome> {
  if (r.kind === "unknown") throw new Error("the screenshot is not a Who viewed your profile or Search appearances page");
  const to = new Date().toISOString().slice(0, 10);
  const from = r.period_days ? new Date(Date.now() - r.period_days * 86400000).toISOString().slice(0, 10) : null;
  const details = r.kind === "views"
    ? { titles: r.viewer_titles, companies: r.viewer_companies, locations: r.viewer_locations, change_pct: r.change_pct }
    : { appeared_where: r.appeared_where, keywords: r.keywords, companies: r.searcher_companies, titles: r.searcher_titles, change_pct: r.change_pct };
  const { error } = await db.from("li_profile_snapshots").upsert({
    user_id: userId, kind: r.kind, source_sha256: sha, period_label: r.period_label, period_days: r.period_days,
    period_from: from, period_to: to, total: r.total, details, import_id: importId,
  }, { onConflict: "user_id,kind,source_sha256" });
  if (error) throw new Error(`li_profile_snapshots: ${error.message}`);
  return {
    counts: { snapshot: r.kind, total: r.total, period: r.period_label, entries: Object.values(details).filter(Array.isArray).reduce((n, a) => n + a.length, 0) },
    period: from ? { from, to } : null,
    warnings: r.total === null ? ["no total was visible in the screenshot"] : [],
  };
}

async function importFile(db: SupabaseClient, cfg: AppConfig, owner: string, path: string, kindArg: unknown) {
  const li: LinkedInConfig = linkedinConfig(cfg);
  const bucket = cfg["linkedin.bucket"];
  if (!bucket) throw new Error("app_config linkedin.bucket is missing");
  const chunk = need(cfg, "linkedin.upsert_chunk");
  const dl = await db.storage.from(bucket).download(path);
  if (dl.error) throw new Error(dl.error.message);
  const bytes = new Uint8Array(await dl.data.arrayBuffer());
  if (bytes.length > need(cfg, "linkedin.max_import_bytes")) throw new Error("file is larger than linkedin.max_import_bytes");
  const sha = await sha256Hex(bytes);
  const name = path.split("/").pop() ?? path;

  const given = kindArg == null || kindArg === "" ? null : KINDS[String(kindArg)];
  if (kindArg != null && kindArg !== "" && !given) throw new Error(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
  const kind = given?.kind ?? detectKind(name, bytes, li);
  if (!kind) throw new Error("not a LinkedIn content export (.xlsx), data archive (.zip) or screenshot (.png, .jpg)");

  const run = await AgentRun.start(db, owner, "linkedin", "upload", { mode: "import", path, kind });
  // One li_imports row per file content; re-importing the same file updates it.
  const { data: imp, error: impErr } = await db.from("li_imports").upsert({
    user_id: owner, sha256: sha, kind, path, status: "running", error: null, agent_run_id: run.id, imported_at: new Date().toISOString(),
  }, { onConflict: "user_id,sha256" }).select("id").single();
  if (impErr || !imp) {
    await run.finish(impErr ?? new Error("li_imports upsert returned nothing"));
    throw new Error(`li_imports: ${impErr?.message ?? "no row"}`);
  }
  const importId = imp.id as string;

  let outcome: Outcome | null = null;
  try {
    if (kind === "content") {
      const x = (await run.step("parse_content", async () => parseContentExport(bytes, li), { summarize: (r) => ({ days: r.days.length, posts: r.posts.length, audience: r.audience.length, warnings: r.warnings }) }))!;
      outcome = (await run.step("store_content", () => storeContent(db, owner, importId, x, chunk), { summarize: (o) => o.counts }))!;
    } else if (kind === "archive") {
      const x = (await run.step("parse_archive", () => parseArchive(bytes, li), { summarize: (r) => ({ connections: r.connections.length, messages: r.messages.length, self: r.self.source, warnings: r.warnings }) }))!;
      outcome = (await run.step("store_archive", () => storeArchive(db, owner, importId, x, chunk), { summarize: (o) => o.counts }))!;
    } else {
      const mediaType = imageMediaType(name, bytes);
      if (!mediaType) throw new Error("screenshots must be PNG or JPEG");
      const r = (await run.step("read_screenshot", () => readScreenshot(db, cfg, run, bytes, mediaType, given?.hint), { summarize: (r) => ({ kind: r.kind, total: r.total, period: r.period_label }) }))!;
      outcome = (await run.step("store_snapshot", () => storeScreenshot(db, owner, importId, sha, r), { summarize: (o) => o.counts }))!;
    }
    for (const [k, v] of Object.entries(outcome.counts)) if (typeof v === "number") run.count(k, v);
    await db.from("li_imports").update({
      status: outcome.warnings.length ? "partial" : "succeeded",
      period_from: outcome.period?.from ?? null, period_to: outcome.period?.to ?? null,
      counts: outcome.counts, warnings: outcome.warnings,
    }).eq("id", importId);
    const status = await run.finish();
    return { import_id: importId, run_id: run.id, kind, status, counts: outcome.counts, period: outcome.period, warnings: outcome.warnings };
  } catch (e) {
    const msg = (e as Error).message;
    await db.from("li_imports").update({ status: "failed", error: msg.slice(0, 1000) }).eq("id", importId);
    await run.finish(e);
    return { import_id: importId, run_id: run.id, kind, status: "failed", error: msg };
  }
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  try {
    const who = await authorize(req, db);
    if (!who) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body.mode !== "import") return json({ error: "mode must be import" }, 400);
    // Dan imports his own files; the scheduler identity may import for a named user (backfills).
    const owner = who.kind === "user" ? who.id : typeof body.user_id === "string" ? body.user_id : null;
    if (!owner) return json({ error: "sign in required" }, 401);
    const path = String(body.path ?? "");
    if (!path.startsWith(`${owner}/`) || path.split("/").some((seg) => seg === ".." || seg === "")) {
      return json({ error: "path outside your folder" }, 403);
    }
    const cfg = await loadConfig(db);
    const out = await importFile(db, cfg, owner, path, body.kind);
    return json(out, out.status === "failed" ? 422 : 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);

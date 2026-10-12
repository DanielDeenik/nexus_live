// The recruiter's knowledge lives in the lensiq repo, where Dan edits it.
// Each run fetches the configured files, caches them per user, and falls
// back to the cache when the repo is unreachable. A missing file with no
// cached copy stops the run rather than letting the agent guess.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AppConfig } from "../_shared/config.ts";
import { sha256Hex } from "../_shared/harness.ts";

export interface Area {
  id: string;
  tier: string;
  group: string;
  label: string;
  line: string;
  terms: string[];
  short?: string;
}

export interface SkillProfile {
  tiers: Record<string, { weight: number; label: string }>;
  areas: Area[];
  verdicts: { min: number; text: string }[];
  no_match: { threshold: number; headline: string; body: string };
}

export interface AgentSettings {
  owner_email: string;
  intake_from: string;
  call_timezone: string;
  call_window: { days: string[]; start: string; end: string };
  call_minutes: number;
  call_lead_hours: number;
  call_horizon_days: number;
  call_max_per_day: number;
  call_organizer_calendar: string;
  no_match_threshold: number;
  handled_subject_prefix: string;
}

export interface JobSource {
  id: string;
  name: string;
  authority: number;
  kind: "rss" | "json";
  url: string;
  needs?: string[];
  map?: Record<string, string>;
  company?: string;
  minScore?: number;
}

export interface JobConfig {
  sources: JobSource[];
  keywords: { re: string; flags: string; pts: number; tier: string }[];
  scoring: {
    recency: { noDate: number; bands: { maxDays: number; mult: number }[]; older: number };
    tiers: { min: number; tier: string }[];
    tierFloor: string;
    dedupKeyLen: number;
    scoreCap: number;
    multiSourceBonus: number;
  };
}

export interface Knowledge {
  agent: AgentSettings;
  profile: SkillProfile;
  jobs: JobConfig;
  cvMaster: string;
  factBase: string;
  sharingRules: string;
  tailoringRules: string;
  fetched: string[];
  cached: string[];
}

export async function loadKnowledge(db: SupabaseClient, cfg: AppConfig, userId: string): Promise<Knowledge> {
  const base = cfg["recruiter.knowledge_base_url"];
  const files: string[] = JSON.parse(cfg["recruiter.knowledge_files"] ?? "[]");
  if (!base || files.length === 0) throw new Error("app_config recruiter.knowledge_base_url or recruiter.knowledge_files is missing");
  const text: Record<string, string> = {};
  const fetched: string[] = [];
  const cached: string[] = [];
  for (const name of files) {
    const url = base + name;
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      const body = await res.text();
      text[name] = body;
      fetched.push(name);
      const sha = await sha256Hex(new TextEncoder().encode(body));
      await db.from("rec_knowledge").upsert({ user_id: userId, name, content: body, sha256: sha, source_url: url, fetched_at: new Date().toISOString() });
      continue;
    }
    const { data } = await db.from("rec_knowledge").select("content").eq("user_id", userId).eq("name", name).maybeSingle();
    if (!data) throw new Error(`could not load ${name} from ${url} and there is no cached copy`);
    text[name] = data.content as string;
    cached.push(name);
  }
  const need = (n: string) => {
    if (!(n in text)) throw new Error(`recruiter.knowledge_files must include ${n}`);
    return text[n];
  };
  const agent = JSON.parse(need("agent.json")) as AgentSettings;
  const profile = JSON.parse(need("skill-profile.json")) as SkillProfile;
  const jobs = JSON.parse(need("nexus-agent-config.json")) as JobConfig;
  return {
    agent,
    profile,
    jobs,
    cvMaster: need("cv_master.md"),
    factBase: need("fact_base.md"),
    sharingRules: need("sharing_rules.md"),
    tailoringRules: need("cv_tailoring_rules.md"),
    fetched,
    cached,
  };
}

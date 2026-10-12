// Agent harness. Every agent run is a row in public.agent_runs with an
// ordered step trace (what ran, how long, what it decided, what failed), so
// the owner can audit any number back to the run and the evidence behind it.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Trigger = "cron" | "manual" | "upload" | "review_feedback";

export interface StepTrace {
  name: string;
  started_at: string;
  ms: number;
  ok: boolean;
  summary?: unknown;
  error?: string;
}

export class AgentRun {
  readonly steps: StepTrace[] = [];
  readonly metrics: Record<string, number> = {};
  private constructor(
    private readonly db: SupabaseClient,
    readonly id: string,
    readonly userId: string,
    readonly agentId: string,
  ) {}

  static async start(db: SupabaseClient, userId: string, agentId: string, trigger: Trigger, input: unknown): Promise<AgentRun> {
    const { data, error } = await db.from("agent_runs")
      .insert({ user_id: userId, agent_id: agentId, trigger, input_json: input })
      .select("id").single();
    if (error) throw new Error(`agent_runs insert failed: ${error.message}`);
    return new AgentRun(db, data.id as string, userId, agentId);
  }

  count(metric: string, by = 1) {
    this.metrics[metric] = (this.metrics[metric] ?? 0) + by;
  }

  /** Runs fn as a traced step. Errors are recorded and rethrown unless
   *  `tolerate` is set, in which case the step returns null. */
  async step<T>(name: string, fn: () => Promise<T>, opts: { tolerate?: boolean; summarize?: (r: T) => unknown } = {}): Promise<T | null> {
    const t0 = Date.now();
    const started_at = new Date(t0).toISOString();
    try {
      const r = await fn();
      this.steps.push({ name, started_at, ms: Date.now() - t0, ok: true, summary: opts.summarize ? opts.summarize(r) : undefined });
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.steps.push({ name, started_at, ms: Date.now() - t0, ok: false, error: msg.slice(0, 2000) });
      this.count("step_errors");
      if (opts.tolerate) return null;
      throw e;
    }
  }

  async finish(error?: unknown) {
    const failed = this.steps.filter((s) => !s.ok).length;
    const status = error ? "failed" : failed ? "partial" : "succeeded";
    await this.db.from("agent_runs").update({
      status,
      finished_at: new Date().toISOString(),
      steps: this.steps,
      metrics: this.metrics,
      error_message: error ? (error instanceof Error ? error.message : String(error)).slice(0, 2000) : null,
    }).eq("id", this.id);
    return status;
  }
}

/** Opens a review item unless one is already open for the same subject. */
export async function openReview(
  db: SupabaseClient,
  r: { user_id: string; item_type: string; item_id: string | null; reason_codes: string[]; summary: string; proposed: unknown; agent_run_id: string },
) {
  const { error } = await db.from("review_items").insert(r);
  // 23505: an open review for this item already exists; keep the original.
  if (error && error.code !== "23505") throw new Error(`review_items insert failed: ${error.message}`);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

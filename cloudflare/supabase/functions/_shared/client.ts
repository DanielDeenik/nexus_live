// Service-role Supabase client for Edge Functions. Bypasses RLS deliberately
// (server-side sync/agent writes) — always scope writes with an explicit user_id.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

export function adminClient(): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// Resolves the caller's user id from the Authorization bearer token, when a
// function is invoked directly by the SPA rather than by cron.
export async function userIdFromRequest(
  req: Request,
  supabase: SupabaseClient,
): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const { data, error } = await supabase.auth.getUser(auth.slice(7));
  if (error || !data.user) return null;
  return data.user.id;
}

export type Caller = { kind: "user"; id: string } | { kind: "service" };

/** Agents run for one signed-in user, or for everyone when called by the
 *  scheduler with the service key. Anything else is rejected. */
export async function authorize(req: Request, supabase: SupabaseClient): Promise<Caller | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  // The scheduler authenticates with NEXUS_CRON_SECRET (stored in Vault as
  // edge_service_key), so the service-role key never has to leave Supabase.
  for (const name of ["NEXUS_CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const s = Deno.env.get(name);
    if (s && s.length >= 32 && timingSafeEqual(token, s)) return { kind: "service" };
  }
  const id = await userIdFromRequest(req, supabase);
  return id ? { kind: "user", id } : null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

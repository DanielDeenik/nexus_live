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
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (service && token === service) return { kind: "service" };
  const id = await userIdFromRequest(req, supabase);
  return id ? { kind: "user", id } : null;
}

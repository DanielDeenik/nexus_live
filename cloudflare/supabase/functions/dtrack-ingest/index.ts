// dtrack-ingest: Relay pushes the time Dan confirmed there into DTrack.
//
// POST /functions/v1/nexus/dtrack-ingest
//   Authorization: Bearer dtk_...   (a device token made on DTrack's Devices page)
//   { tz, window: {from, to}, entries: [...], flows: [...] }
//
// Only the SHA-256 of the token travels to the database. The mapping,
// mirroring and limits live in public.dt_ingest and app_config.
import { adminClient } from "../_shared/client.ts";
import { json, preflight } from "../_shared/cors.ts";
import { sha256Hex } from "../_shared/harness.ts";

const TOKEN = /^Bearer (dtk_[0-9a-f]{64})$/;

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const m = TOKEN.exec(req.headers.get("authorization") ?? "");
  if (!m) return json({ error: "a DTrack device token is required" }, 401);
  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "body must be a JSON object" }, 400);
  }
  const hash = await sha256Hex(new TextEncoder().encode(m[1]));
  const { data, error } = await adminClient().rpc("dt_ingest", { p_token_hash: hash, p_payload: payload });
  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return json({ error: error.message }, status);
  }
  return json(data);
}

if (import.meta.main) Deno.serve(handler);

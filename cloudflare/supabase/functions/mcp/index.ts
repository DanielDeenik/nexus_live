// mcp: the Nexus agents as an MCP server for Claude Code.
//
//   claude mcp add --transport http nexus https://<project>.supabase.co/functions/v1/mcp
//
// The client signs in through the Supabase OAuth 2.1 server and the consent
// page of the Nexus web app. Every tool runs as that user: reads go through
// row level security, and a run calls the agent's own route with the user's
// token, exactly as the Nexus app does. Approvals stay in Nexus: no tool here
// decides a review item or a filing.
import { createMcpHandler } from "npm:@modelcontextprotocol/server@^2.4.0";
import { pipeline } from "npm:@supabase/middleware@^1.0.0";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@^1.9.2";
import { nexusServer } from "./server.ts";

function functionsBase(): string {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not set");
  return `${url.replace(/\/+$/, "")}/functions/v1`;
}

Deno.serve(
  pipeline(
    [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
    async (req, { supabase }) => {
      const handler = createMcpHandler(
        () => nexusServer(supabase, req.headers.get("Authorization") ?? "", functionsBase()),
        { onerror: (error) => console.error("mcp request failed", error) },
      );
      return handler.fetch(req);
    },
  ),
);

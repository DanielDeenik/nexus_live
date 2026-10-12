// nexus: one deployment routing to the agent modules by path.
//   /functions/v1/nexus/expense-agent   collect, classify, ingest uploads
//   /functions/v1/nexus/tax-agent       VAT and income tax drafts
//   /functions/v1/nexus/review-decide   human decisions on review items
//   /functions/v1/nexus/integrations    Google and Wise connections (+ OAuth callback)
//   /functions/v1/nexus/admin           service-only maintenance (scheduler secret)
//   /functions/v1/nexus/dtrack-ingest   Relay pushes confirmed time into DTrack (device token)
//   /functions/v1/nexus/recruiter       recruiter agent (LangGraph) and role monitor
// Each module authenticates its own callers.
import { handler as expenseAgent } from "../expense-agent/index.ts";
import { handler as taxAgent } from "../tax-agent/index.ts";
import { handler as reviewDecide } from "../review-decide/index.ts";
import { handler as integrations } from "../integrations/index.ts";
import { handler as admin } from "../admin/index.ts";
import { handler as dtrackIngest } from "../dtrack-ingest/index.ts";
import { handler as recruiter } from "../recruiter/index.ts";
import { json, preflight } from "../_shared/cors.ts";

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "expense-agent": expenseAgent,
  "tax-agent": taxAgent,
  "review-decide": reviewDecide,
  "integrations": integrations,
  "admin": admin,
  "dtrack-ingest": dtrackIngest,
  "recruiter": recruiter,
};

Deno.serve((req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const route = parts[parts.indexOf("nexus") + 1] ?? "";
  const h = routes[route];
  return h ? h(req) : json({ error: `unknown route '${route}'`, routes: Object.keys(routes) }, 404);
});

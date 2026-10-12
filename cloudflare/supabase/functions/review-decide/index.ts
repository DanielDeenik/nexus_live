// review-decide: the only path by which a human decision changes agent output.
// Validates ownership and state, applies the decision, records it on the
// review item, and (when asked) turns it into a vendor rule the expense agent
// applies next time. Every decision is traced as an agent run.
//
// POST { review_item_id, action: "approve"|"edit"|"reject", edits?, remember? }
// POST { action: "mark_filed", filing_id, filed_reference }
import { adminClient, userIdFromRequest } from "../_shared/client.ts";
import { json, preflight } from "../_shared/cors.ts";
import { AgentRun } from "../_shared/harness.ts";

const TREATMENTS = ["fully_deductible", "limited_deductible", "asset", "private"];
const EXPENSE_EDITABLE = ["treatment", "category", "business_use_pct", "vendor", "date", "amount", "amount_excl_vat", "vat_amount", "vat_reclaimable", "vat_reverse_charge", "description"];
const ASSET_EDITABLE = ["useful_life_years", "residual_value", "kia_eligible", "asset_class", "description"];

const vendorKey = (v: string | null) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
const pick = (o: Record<string, unknown> = {}, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));

function validateExpenseEdits(e: Record<string, unknown>): string | null {
  if (e.treatment !== undefined && !TREATMENTS.includes(e.treatment as string)) return "invalid treatment";
  if (e.business_use_pct !== undefined) {
    const n = Number(e.business_use_pct);
    if (!(n >= 0 && n <= 1)) return "business_use_pct must be between 0 and 1";
  }
  return null;
}

export async function handler(req: Request): Promise<Response> {
  const pf = preflight(req);
  if (pf) return pf;
  const db = adminClient();
  const userId = await userIdFromRequest(req, db);
  if (!userId) return json({ error: "sign in required" }, 401);
  const body = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  // Filing is a human act outside Nexus; this only records that it happened.
  if (body.action === "mark_filed") {
    const ref = String(body.filed_reference ?? "").trim();
    if (!ref) return json({ error: "filed_reference required" }, 400);
    const { data: f } = await db.from("tax_filings").select("id, status").eq("id", body.filing_id).eq("user_id", userId).single();
    if (!f) return json({ error: "filing not found" }, 404);
    if (f.status !== "approved") return json({ error: "approve the draft before marking it filed" }, 409);
    await db.from("tax_filings").update({ status: "filed", filed_at: now, filed_reference: ref }).eq("id", f.id);
    return json({ ok: true });
  }

  const { data: item } = await db.from("review_items").select("*").eq("id", body.review_item_id).eq("user_id", userId).single();
  if (!item) return json({ error: "review item not found" }, 404);
  if (item.status !== "open") return json({ error: `already ${item.status}` }, 409);
  const action = body.action as "approve" | "edit" | "reject";
  if (!["approve", "edit", "reject"].includes(action)) return json({ error: "invalid action" }, 400);

  const agentId = item.item_type === "filing" ? "tax_drafter" : "expense";
  const run = await AgentRun.start(db, userId, agentId, "review_feedback", { review_item_id: item.id, action });
  try {
    await run.step(`apply:${item.item_type}:${action}`, async () => {
      switch (item.item_type) {
        case "expense": {
          const edits = pick(body.edits, EXPENSE_EDITABLE);
          const bad = validateExpenseEdits(edits);
          if (bad) throw new Error(bad);
          const status = action === "reject" ? "rejected" : "approved";
          const { data: exp, error } = await db.from("expenses")
            .update({ ...edits, status, reviewed_by: userId, reviewed_at: now, updated_at: now })
            .eq("id", item.item_id).eq("user_id", userId).select("vendor, treatment, category, business_use_pct").single();
          if (error) throw new Error(error.message);
          if (body.remember && status === "approved" && exp.vendor && exp.treatment !== "asset") {
            await rememberRule(db, userId, exp, run.id);
          }
          break;
        }
        case "asset": {
          const expenseId = item.proposed?.expense_id as string | undefined;
          if (action === "reject") {
            // Not an asset after all: expense it with the owner's treatment.
            const t = (body.edits?.treatment as string) ?? "fully_deductible";
            if (!TREATMENTS.includes(t) || t === "asset") throw new Error("choose how to treat it instead");
            if (expenseId) {
              await db.from("expenses").update({ treatment: t, asset_id: null, status: "approved", reviewed_by: userId, reviewed_at: now, updated_at: now })
                .eq("id", expenseId).eq("user_id", userId);
            }
            await db.from("fixed_assets").delete().eq("id", item.item_id).eq("user_id", userId).eq("status", "needs_review");
          } else {
            const edits = pick(body.edits, ASSET_EDITABLE);
            if (edits.useful_life_years !== undefined && !(Number(edits.useful_life_years) > 0)) throw new Error("useful life must be positive");
            const { error } = await db.from("fixed_assets").update({ ...edits, status: "active" }).eq("id", item.item_id).eq("user_id", userId);
            if (error) throw new Error(error.message);
            if (expenseId) {
              await db.from("expenses").update({ status: "approved", reviewed_by: userId, reviewed_at: now, updated_at: now })
                .eq("id", expenseId).eq("user_id", userId);
            }
          }
          break;
        }
        case "filing": {
          if (action === "reject") {
            await db.from("tax_filings").update({ status: "superseded" }).eq("id", item.item_id).eq("user_id", userId);
          } else {
            const { data: f } = await db.from("tax_filings").select("warnings").eq("id", item.item_id).eq("user_id", userId).single();
            const blocking = ((f?.warnings ?? []) as { severity: string }[]).filter((w) => w.severity === "block");
            if (blocking.length && !body.acknowledge_blocking) {
              throw new Error(`${blocking.length} blocking warning(s): resolve them or acknowledge explicitly`);
            }
            await db.from("tax_filings").update({ status: "approved", approved_by: userId, approved_at: now }).eq("id", item.item_id).eq("user_id", userId);
          }
          break;
        }
        case "invoice_anomaly": {
          const voidIds: string[] = Array.isArray(body.edits?.void_invoice_ids) ? body.edits.void_invoice_ids : [];
          if (action !== "reject" && voidIds.length) {
            await db.from("invoices").update({ voided_at: now, void_reason: String(body.edits?.void_reason ?? "duplicate") })
              .in("id", voidIds).eq("user_id", userId);
          }
          break;
        }
      }
    });
    await db.from("review_items").update({
      status: action === "approve" ? "approved" : action === "edit" ? "edited" : "rejected",
      decision: { action, edits: body.edits ?? null, remember: !!body.remember },
      decided_by: userId, decided_at: now,
    }).eq("id", item.id);
    await run.finish();
    return json({ ok: true });
  } catch (e) {
    await run.finish(e);
    return json({ error: (e as Error).message }, 400);
  }
}

if (import.meta.main) Deno.serve(handler);

async function rememberRule(
  db: ReturnType<typeof adminClient>, userId: string,
  exp: { vendor: string; treatment: string; category: string; business_use_pct: number }, runId: string,
) {
  const key = vendorKey(exp.vendor);
  const { data: prev } = await db.from("agent_knowledge_graph").select("id")
    .eq("agent_id", "expense").eq("user_id", userId).eq("entry_type", "rule").is("superseded_by", null)
    .contains("context_json", { vendor_key: key });
  const { data: rule, error } = await db.from("agent_knowledge_graph").insert({
    agent_id: "expense", user_id: userId, entry_type: "rule", confidence: 1,
    context_json: { vendor_key: key, vendor: exp.vendor, learned_from_run: runId },
    output_json: { treatment: exp.treatment, category: exp.category, business_use_pct: Number(exp.business_use_pct) },
  }).select("id").single();
  if (error) throw new Error(`remember rule: ${error.message}`);
  if (prev?.length) await db.from("agent_knowledge_graph").update({ superseded_by: rule.id }).in("id", prev.map((p) => p.id));
}

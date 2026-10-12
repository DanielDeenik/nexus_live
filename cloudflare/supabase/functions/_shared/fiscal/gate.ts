// Deterministic guardrails between the model and the ledger. The model
// proposes; this decides whether a proposal books itself or waits for the
// owner. Every reason is a stable code the review UI can explain.
import type { Treatment } from "./costs.ts";
import { type FiscalParams, round2 } from "./params.ts";

export interface ExpenseProposal {
  vendor: string | null;
  date: string | null;
  currency: string | null;
  total: number | null;
  amount_excl_vat: number | null;
  vat_amount: number | null;
  treatment: Treatment;
  category: string;
  business_use_pct: number;
  confidence: number;
  is_business_document: boolean;
  vendor_rule_applied: boolean;
}

export interface GateConfig {
  autoBookMinConfidence: number;
  autoBookMaxAmountEur: number;
  amountToleranceEur: number;
  reviewCategories: string[];
}

export type ReasonCode =
  | "not_a_business_document"
  | "missing_total" | "missing_date" | "missing_vendor" | "missing_currency"
  | "vat_arithmetic" | "missing_fx"
  | "asset_threshold" | "limited_deductible" | "private_or_mixed" | "review_category"
  | "low_confidence" | "above_auto_book_amount" | "unknown_treatment" | "duplicate"
  | "missing_evidence" | "missing_parameters" | "extraction_failed" | "invoice_duplicate_period";

export interface GateDecision { route: "book" | "review" | "discard"; reasons: ReasonCode[] }

export function gate(
  e: ExpenseProposal,
  amountEur: number | null,
  cfg: GateConfig,
  p: FiscalParams,
  isDuplicate: boolean,
): GateDecision {
  if (isDuplicate) return { route: "discard", reasons: ["duplicate"] };
  if (!e.is_business_document && e.confidence >= cfg.autoBookMinConfidence) {
    return { route: "discard", reasons: ["not_a_business_document"] };
  }
  const r: ReasonCode[] = [];
  if (!e.is_business_document) r.push("not_a_business_document");
  if (e.total == null) r.push("missing_total");
  if (!e.date) r.push("missing_date");
  if (!e.vendor) r.push("missing_vendor");
  if (!e.currency) r.push("missing_currency");
  if (e.total != null && e.amount_excl_vat != null && e.vat_amount != null &&
      Math.abs(round2(e.amount_excl_vat + e.vat_amount) - e.total) > cfg.amountToleranceEur) {
    r.push("vat_arithmetic");
  }
  if (amountEur == null && e.total != null) r.push("missing_fx");

  const exclEur = e.amount_excl_vat ?? e.total;
  const fx = amountEur != null && e.total ? amountEur / e.total : null;
  if (e.treatment === "asset" || (exclEur != null && fx != null && exclEur * fx >= p.capitalisationThreshold)) {
    r.push("asset_threshold");
  }
  if (e.treatment === "limited_deductible") r.push("limited_deductible");
  if (e.treatment === "private" || e.business_use_pct < 1) r.push("private_or_mixed");
  if (e.treatment === "unknown") r.push("unknown_treatment");
  if (cfg.reviewCategories.includes(e.category)) r.push("review_category");
  // A rule the owner confirmed earlier substitutes for model confidence.
  if (!e.vendor_rule_applied && e.confidence < cfg.autoBookMinConfidence) r.push("low_confidence");
  if (amountEur != null && amountEur > cfg.autoBookMaxAmountEur) r.push("above_auto_book_amount");

  return { route: r.length ? "review" : "book", reasons: r };
}

export const REASON_TEXT: Record<ReasonCode, string> = {
  not_a_business_document: "May not be a business purchase",
  missing_total: "Total not found on the document",
  missing_date: "Date not found",
  missing_vendor: "Vendor not found",
  missing_currency: "Currency not found",
  vat_arithmetic: "Excl. VAT plus VAT does not add up to the total",
  missing_fx: "No EUR exchange rate for this date",
  asset_threshold: "At or above the capitalisation line: depreciate as an asset",
  limited_deductible: "Limited deductible (representation-type cost)",
  private_or_mixed: "Private or mixed use: confirm the business share",
  review_category: "Category the Belastingdienst scrutinises",
  low_confidence: "Agent not confident in the classification",
  above_auto_book_amount: "Above the auto-book amount limit",
  unknown_treatment: "Could not determine the tax treatment",
  duplicate: "Already in the ledger",
  missing_evidence: "Bank payment without a receipt or invoice: add the document",
  missing_parameters: "No fiscal parameters loaded for this year",
  extraction_failed: "Could not read the document reliably",
  invoice_duplicate_period: "Another invoice already bills this period",
};

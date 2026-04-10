/**
 * Commitment Pacing Engine
 *
 * Implements the 4-stage decision gate model:
 *   Explore → Soft Commit → Hard Commit → Locked
 *
 * Pure functions only — no DB access here. The service layer reads/writes D1.
 *
 * Zero hardcoded values: every threshold and weight comes from app_config
 * via the FinancialContext / GateConfig parameters.
 */

export type CommitmentStage = 'explore' | 'soft_commit' | 'hard_commit' | 'locked' | 'abandoned';

export type CommitmentType =
  | 'contract'
  | 'expense'
  | 'investment'
  | 'project'
  | 'hire'
  | 'subscription';

export interface Commitment {
  id: string;
  userId: string;
  title: string;
  commitmentType: CommitmentType;
  currentStage: CommitmentStage;
  amount: number;
  currency: string;
  monthlyImpact?: number;
  counterparty?: string;
  relatedScenarioId?: string | null;
  relatedContractId?: string | null;
  relatedInvoiceId?: string | null;
  riskScore?: number;
  reversibilityScore?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialContext {
  // Snapshot of the user's financial state at evaluation time
  monthlyRevenue: number;
  monthlyBurn: number;
  cashOnHand: number;
  currency: string;
  taxReservePct: number;
  hardCommitTotal: number; // sum of all hard_commit amounts
  totalRevenueAnnual: number;
  largestCurrencyExposurePct: number;
  hasScenarioModel: boolean;
  hasConflictingHardCommits: boolean;
  hasContractOrInvoice: boolean;
}

export interface GateConfig {
  runwayMinMonths: number;
  taxReserveMinPct: number;
  maxHardCommitPct: number;
  autoApproveThreshold: number;
  fxExposureWarnPct: number;
  weights: Record<CommitmentStage, number>;
  velocityWindowDays: number;
  maxExploreDays: number;
  maxSoftCommitDays: number;
}

export interface GateRuleResult {
  rule: string;
  passed: boolean;
  required: boolean;
  actual?: number | string | boolean;
  threshold?: number | string;
  message: string;
}

export interface GateResult {
  fromStage: CommitmentStage;
  toStage: CommitmentStage;
  passed: boolean;
  rules: GateRuleResult[];
  blockingFailures: GateRuleResult[];
  evaluatedAt: string;
}

export const STAGE_ORDER: CommitmentStage[] = ['explore', 'soft_commit', 'hard_commit', 'locked'];

/**
 * Build a fully-resolved GateConfig from raw app_config values.
 */
export function gateConfigFromAppConfig(cfg: Record<string, unknown>): GateConfig {
  const num = (k: string, fallback: number): number => {
    const v = cfg[k];
    return v == null ? fallback : Number(v);
  };
  return {
    runwayMinMonths: num('commitment.runway_min_months', 3),
    taxReserveMinPct: num('commitment.tax_reserve_min_pct', 0.25),
    maxHardCommitPct: num('commitment.max_hard_commit_pct', 0.7),
    autoApproveThreshold: num('commitment.auto_approve_threshold', 500),
    fxExposureWarnPct: num('commitment.fx_exposure_warn_pct', 0.3),
    weights: {
      explore: num('commitment.weight.explore', 0.15),
      soft_commit: num('commitment.weight.soft_commit', 0.5),
      hard_commit: num('commitment.weight.hard_commit', 0.85),
      locked: num('commitment.weight.locked', 1.0),
      abandoned: 0,
    },
    velocityWindowDays: num('commitment.velocity_window_days', 30),
    maxExploreDays: num('commitment.max_explore_days', 14),
    maxSoftCommitDays: num('commitment.max_soft_commit_days', 30),
  };
}

/**
 * Evaluate whether a commitment can advance from its current stage to a target stage.
 * Each stage transition has its own rule set; rules are configurable, never hardcoded.
 */
export function evaluateGate(
  commitment: Commitment,
  targetStage: CommitmentStage,
  ctx: FinancialContext,
  gate: GateConfig
): GateResult {
  const fromStage = commitment.currentStage;
  const rules: GateRuleResult[] = [];
  const transition = `${fromStage}→${targetStage}`;

  if (fromStage === targetStage) {
    return {
      fromStage,
      toStage: targetStage,
      passed: false,
      rules: [
        {
          rule: 'no-op',
          passed: false,
          required: true,
          message: 'Already at target stage',
        },
      ],
      blockingFailures: [],
      evaluatedAt: new Date().toISOString(),
    };
  }

  // Validate forward transition only
  const fromIdx = STAGE_ORDER.indexOf(fromStage);
  const toIdx = STAGE_ORDER.indexOf(targetStage);
  if (fromIdx < 0 || toIdx < 0 || toIdx !== fromIdx + 1) {
    rules.push({
      rule: 'sequential-transition',
      passed: false,
      required: true,
      message: `Invalid transition ${transition}: must advance one stage at a time through ${STAGE_ORDER.join('→')}`,
    });
    return finalize(fromStage, targetStage, rules);
  }

  if (transition === 'explore→soft_commit') {
    rules.push({
      rule: 'scenario-model-exists',
      passed: ctx.hasScenarioModel,
      required: true,
      message: ctx.hasScenarioModel
        ? 'Scenario model attached'
        : 'A scenario model must be attached before soft committing',
    });

    const runwayMonths = ctx.monthlyBurn > 0 ? ctx.cashOnHand / ctx.monthlyBurn : Infinity;
    rules.push({
      rule: 'runway-min-months',
      passed: runwayMonths >= gate.runwayMinMonths,
      required: true,
      actual: Number(runwayMonths.toFixed(1)),
      threshold: gate.runwayMinMonths,
      message: `Runway ${runwayMonths.toFixed(1)}mo (min ${gate.runwayMinMonths}mo)`,
    });

    rules.push({
      rule: 'no-conflicting-hard-commits',
      passed: !ctx.hasConflictingHardCommits,
      required: true,
      message: ctx.hasConflictingHardCommits
        ? 'A conflicting hard commit already exists for this counterparty/scope'
        : 'No conflicting hard commits',
    });
  } else if (transition === 'soft_commit→hard_commit') {
    const projected = ctx.monthlyRevenue + (commitment.monthlyImpact || 0) - ctx.monthlyBurn;
    rules.push({
      rule: 'positive-projected-cashflow',
      passed: projected >= 0,
      required: true,
      actual: Math.round(projected),
      threshold: 0,
      message: `Projected monthly cashflow ${projected.toFixed(0)} ${ctx.currency}`,
    });

    rules.push({
      rule: 'tax-reserve-min-pct',
      passed: ctx.taxReservePct >= gate.taxReserveMinPct,
      required: true,
      actual: Number((ctx.taxReservePct * 100).toFixed(1)),
      threshold: Number((gate.taxReserveMinPct * 100).toFixed(1)),
      message: `Tax reserve ${(ctx.taxReservePct * 100).toFixed(1)}% (min ${(gate.taxReserveMinPct * 100).toFixed(1)}%)`,
    });

    rules.push({
      rule: 'fx-exposure-cap',
      passed: ctx.largestCurrencyExposurePct <= gate.fxExposureWarnPct,
      required: false, // warning, not block
      actual: Number((ctx.largestCurrencyExposurePct * 100).toFixed(1)),
      threshold: Number((gate.fxExposureWarnPct * 100).toFixed(1)),
      message: `FX concentration ${(ctx.largestCurrencyExposurePct * 100).toFixed(1)}% (warn at ${(gate.fxExposureWarnPct * 100).toFixed(1)}%)`,
    });

    const projectedHardPct = ctx.totalRevenueAnnual > 0
      ? (ctx.hardCommitTotal + commitment.amount) / ctx.totalRevenueAnnual
      : 1;
    rules.push({
      rule: 'max-hard-commit-pct',
      passed: projectedHardPct <= gate.maxHardCommitPct,
      required: true,
      actual: Number((projectedHardPct * 100).toFixed(1)),
      threshold: Number((gate.maxHardCommitPct * 100).toFixed(1)),
      message: `Hard commit total would be ${(projectedHardPct * 100).toFixed(1)}% of annual revenue (max ${(gate.maxHardCommitPct * 100).toFixed(1)}%)`,
    });
  } else if (transition === 'hard_commit→locked') {
    rules.push({
      rule: 'contract-or-invoice-linked',
      passed: ctx.hasContractOrInvoice,
      required: true,
      message: ctx.hasContractOrInvoice
        ? 'Contract or invoice linked'
        : 'A signed contract or issued invoice must be linked',
    });

    const isAutoApprove = commitment.amount < gate.autoApproveThreshold;
    rules.push({
      rule: 'auto-approve-or-hitl',
      passed: true, // either path is valid; just informational
      required: false,
      actual: commitment.amount,
      threshold: gate.autoApproveThreshold,
      message: isAutoApprove
        ? `Auto-approve (amount < ${gate.autoApproveThreshold})`
        : `Requires HITL approval (amount ≥ ${gate.autoApproveThreshold})`,
    });
  }

  return finalize(fromStage, targetStage, rules);
}

function finalize(
  fromStage: CommitmentStage,
  toStage: CommitmentStage,
  rules: GateRuleResult[]
): GateResult {
  const blockingFailures = rules.filter(r => r.required && !r.passed);
  return {
    fromStage,
    toStage,
    passed: blockingFailures.length === 0,
    rules,
    blockingFailures,
    evaluatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pacing & weighted forecast
// ---------------------------------------------------------------------------

export interface PacingMetrics {
  totalCommitments: number;
  byStage: Record<CommitmentStage, { count: number; total: number }>;
  weightedRevenue: number;
  hardCommitPctOfRevenue: number;
  velocity: { advancements: number; abandonments: number; windowDays: number };
  staleAlerts: { commitmentId: string; stage: CommitmentStage; daysInStage: number }[];
}

export interface CommitmentTransition {
  commitmentId: string;
  fromStage: CommitmentStage;
  toStage: CommitmentStage;
  createdAt: string;
}

export function computePacingMetrics(
  commitments: Commitment[],
  transitions: CommitmentTransition[],
  totalRevenueAnnual: number,
  gate: GateConfig,
  now: Date = new Date()
): PacingMetrics {
  const byStage: Record<CommitmentStage, { count: number; total: number }> = {
    explore: { count: 0, total: 0 },
    soft_commit: { count: 0, total: 0 },
    hard_commit: { count: 0, total: 0 },
    locked: { count: 0, total: 0 },
    abandoned: { count: 0, total: 0 },
  };

  let weightedRevenue = 0;
  for (const c of commitments) {
    const slot = byStage[c.currentStage];
    slot.count += 1;
    slot.total += c.amount || 0;
    weightedRevenue += (c.amount || 0) * (gate.weights[c.currentStage] ?? 0);
  }

  const hardCommitPctOfRevenue = totalRevenueAnnual > 0
    ? byStage.hard_commit.total / totalRevenueAnnual
    : 0;

  const windowMs = gate.velocityWindowDays * 86400 * 1000;
  const cutoff = now.getTime() - windowMs;
  let advancements = 0;
  let abandonments = 0;
  for (const t of transitions) {
    if (new Date(t.createdAt).getTime() < cutoff) continue;
    if (t.toStage === 'abandoned') abandonments++;
    else advancements++;
  }

  const staleAlerts: PacingMetrics['staleAlerts'] = [];
  for (const c of commitments) {
    const ageDays = (now.getTime() - new Date(c.updatedAt).getTime()) / 86400000;
    if (c.currentStage === 'explore' && ageDays > gate.maxExploreDays) {
      staleAlerts.push({ commitmentId: c.id, stage: 'explore', daysInStage: Math.round(ageDays) });
    }
    if (c.currentStage === 'soft_commit' && ageDays > gate.maxSoftCommitDays) {
      staleAlerts.push({ commitmentId: c.id, stage: 'soft_commit', daysInStage: Math.round(ageDays) });
    }
  }

  return {
    totalCommitments: commitments.length,
    byStage,
    weightedRevenue,
    hardCommitPctOfRevenue,
    velocity: { advancements, abandonments, windowDays: gate.velocityWindowDays },
    staleAlerts,
  };
}

/**
 * Forecast overlay: layer commitment-weighted revenue on top of historical projection.
 */
export function computeWeightedForecast(
  commitments: Commitment[],
  gate: GateConfig
): { weightedTotal: number; byStage: Record<CommitmentStage, number> } {
  const byStage: Record<CommitmentStage, number> = {
    explore: 0,
    soft_commit: 0,
    hard_commit: 0,
    locked: 0,
    abandoned: 0,
  };
  let weightedTotal = 0;
  for (const c of commitments) {
    const w = gate.weights[c.currentStage] ?? 0;
    const contribution = (c.amount || 0) * w;
    byStage[c.currentStage] += contribution;
    weightedTotal += contribution;
  }
  return { weightedTotal, byStage };
}

/**
 * Per-commitment reversibility score (1.0 = fully reversible, 0 = locked in)
 */
export function computeReversibilityScore(commitment: Commitment): number {
  switch (commitment.currentStage) {
    case 'explore': return 1.0;
    case 'soft_commit': return 0.7;
    case 'hard_commit': return 0.25;
    case 'locked': return 0.0;
    case 'abandoned': return 1.0;
  }
}

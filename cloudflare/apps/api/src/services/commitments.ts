/**
 * Commitments service — bridges the pure engine with D1 + KV.
 */

import {
  loadConfig,
  evaluateGate,
  gateConfigFromAppConfig,
  computePacingMetrics,
  computeWeightedForecast,
  type Commitment,
  type CommitmentStage,
  type CommitmentTransition,
  type CommitmentType,
  type FinancialContext,
  type GateConfig,
  type GateResult,
  type PacingMetrics,
  STAGE_ORDER,
} from '@nexus-live/shared';
import { queryDb, execDb } from '../utils/db';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

interface CommitmentRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  commitment_type: CommitmentType;
  current_stage: CommitmentStage;
  amount: number | null;
  currency: string;
  monthly_impact: number | null;
  counterparty: string | null;
  related_contract_id: string | null;
  related_invoice_id: string | null;
  related_scenario_id: string | null;
  gate_rules_json: string | null;
  stage_history_json: string | null;
  risk_score: number | null;
  reversibility_score: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCommitment(r: CommitmentRow): Commitment {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    commitmentType: r.commitment_type,
    currentStage: r.current_stage,
    amount: r.amount ?? 0,
    currency: r.currency,
    monthlyImpact: r.monthly_impact ?? undefined,
    counterparty: r.counterparty ?? undefined,
    relatedContractId: r.related_contract_id,
    relatedInvoiceId: r.related_invoice_id,
    relatedScenarioId: r.related_scenario_id,
    riskScore: r.risk_score ?? undefined,
    reversibilityScore: r.reversibility_score ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listCommitments(db: D1Database, userId: string): Promise<Commitment[]> {
  const rows = await queryDb<CommitmentRow>(
    db,
    `SELECT * FROM commitment_stages WHERE user_id = ?1 ORDER BY updated_at DESC`,
    [userId]
  );
  return rows.map(rowToCommitment);
}

export async function getCommitment(db: D1Database, userId: string, id: string): Promise<Commitment | null> {
  const rows = await queryDb<CommitmentRow>(
    db,
    `SELECT * FROM commitment_stages WHERE id = ?1 AND user_id = ?2`,
    [id, userId]
  );
  return rows[0] ? rowToCommitment(rows[0]) : null;
}

export interface CreateCommitmentInput {
  title: string;
  description?: string;
  commitmentType: CommitmentType;
  amount: number;
  currency: string;
  monthlyImpact?: number;
  counterparty?: string;
  relatedScenarioId?: string;
}

export async function createCommitment(
  db: D1Database,
  userId: string,
  input: CreateCommitmentInput
): Promise<Commitment> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await execDb(
    db,
    `INSERT INTO commitment_stages
       (id, user_id, title, description, commitment_type, current_stage, amount, currency, monthly_impact, counterparty, related_scenario_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'explore', ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    [
      id,
      userId,
      input.title,
      input.description ?? null,
      input.commitmentType,
      input.amount,
      input.currency,
      input.monthlyImpact ?? null,
      input.counterparty ?? null,
      input.relatedScenarioId ?? null,
      now,
    ]
  );
  const row = await getCommitment(db, userId, id);
  if (!row) throw new Error('Failed to create commitment');
  return row;
}

export async function abandonCommitment(db: D1Database, userId: string, id: string, reason?: string): Promise<void> {
  const existing = await getCommitment(db, userId, id);
  if (!existing) throw new Error('Commitment not found');
  const now = new Date().toISOString();
  await execDb(
    db,
    `UPDATE commitment_stages SET current_stage = 'abandoned', updated_at = ?1 WHERE id = ?2 AND user_id = ?3`,
    [now, id, userId]
  );
  await execDb(
    db,
    `INSERT INTO commitment_transitions (id, commitment_id, from_stage, to_stage, decision_notes, decided_by, created_at)
       VALUES (?1, ?2, ?3, 'abandoned', ?4, ?5, ?6)`,
    [crypto.randomUUID(), id, existing.currentStage, reason ?? '', userId, now]
  );
}

export async function buildFinancialContext(
  db: D1Database,
  userId: string,
  commitment: Commitment
): Promise<FinancialContext> {
  const cfg = await loadConfig(db as any);
  const baseCurrency = (cfg['fx.base_currency'] as string) || 'EUR';

  // Cash on hand from wise_accounts (sum balances; treat all currencies as base for simplicity)
  const wiseRows = await queryDb<{ balance: number; currency: string }>(
    db,
    `SELECT balance, currency FROM wise_accounts WHERE user_id = ?1`,
    [userId]
  );
  const cashOnHand = wiseRows.reduce((s, r) => s + (r.balance || 0), 0);

  // Currency exposure: largest single-currency share of wise balances
  const totalsByCurrency = new Map<string, number>();
  for (const r of wiseRows) {
    totalsByCurrency.set(r.currency, (totalsByCurrency.get(r.currency) || 0) + (r.balance || 0));
  }
  const totalCash = Array.from(totalsByCurrency.values()).reduce((s, v) => s + v, 0);
  let largestCurrencyExposurePct = 0;
  if (totalCash > 0) {
    for (const v of totalsByCurrency.values()) {
      largestCurrencyExposurePct = Math.max(largestCurrencyExposurePct, v / totalCash);
    }
  }

  // 12-month revenue + monthly burn from cashflow_history
  const cf = await queryDb<{ revenue: number; costs: number }>(
    db,
    `SELECT COALESCE(revenue, 0) as revenue, COALESCE(costs, 0) as costs
       FROM cashflow_history
       WHERE user_id = ?1
       ORDER BY month DESC
       LIMIT 12`,
    [userId]
  );
  const totalRevenueAnnual = cf.reduce((s, r) => s + r.revenue, 0);
  const monthlyRevenue = cf.length > 0 ? totalRevenueAnnual / cf.length : 0;
  const monthlyBurn = cf.length > 0 ? cf.reduce((s, r) => s + r.costs, 0) / cf.length : 0;

  // Hard commit total (excluding the one being evaluated)
  const hardRows = await queryDb<{ amount: number }>(
    db,
    `SELECT COALESCE(amount, 0) as amount FROM commitment_stages
       WHERE user_id = ?1 AND current_stage = 'hard_commit' AND id != ?2`,
    [userId, commitment.id]
  );
  const hardCommitTotal = hardRows.reduce((s, r) => s + r.amount, 0);

  // Tax reserve % from app_config (advisor-set, not derived)
  const taxReservePct = Number(cfg['user.tax_reserve_pct'] ?? cfg['commitment.tax_reserve_min_pct'] ?? 0.25);

  // Conflicting hard commits with same counterparty
  let hasConflictingHardCommits = false;
  if (commitment.counterparty) {
    const conflicts = await queryDb<{ c: number }>(
      db,
      `SELECT COUNT(*) as c FROM commitment_stages
         WHERE user_id = ?1 AND current_stage = 'hard_commit'
           AND counterparty = ?2 AND id != ?3`,
      [userId, commitment.counterparty, commitment.id]
    );
    hasConflictingHardCommits = (conflicts[0]?.c ?? 0) > 0;
  }

  return {
    monthlyRevenue,
    monthlyBurn,
    cashOnHand,
    currency: baseCurrency,
    taxReservePct,
    hardCommitTotal,
    totalRevenueAnnual,
    largestCurrencyExposurePct,
    hasScenarioModel: Boolean(commitment.relatedScenarioId),
    hasConflictingHardCommits,
    hasContractOrInvoice: Boolean(commitment.relatedContractId || commitment.relatedInvoiceId),
  };
}

export async function evaluateCommitmentGate(
  db: D1Database,
  userId: string,
  commitmentId: string,
  targetStage: CommitmentStage
): Promise<GateResult> {
  const commitment = await getCommitment(db, userId, commitmentId);
  if (!commitment) throw new Error('Commitment not found');
  const cfg = await loadConfig(db as any);
  const gate = gateConfigFromAppConfig(cfg);
  const ctx = await buildFinancialContext(db, userId, commitment);
  return evaluateGate(commitment, targetStage, ctx, gate);
}

export async function advanceCommitment(
  db: D1Database,
  userId: string,
  commitmentId: string,
  targetStage: CommitmentStage,
  notes?: string
): Promise<{ commitment: Commitment; gate: GateResult }> {
  const commitment = await getCommitment(db, userId, commitmentId);
  if (!commitment) throw new Error('Commitment not found');

  const cfg = await loadConfig(db as any);
  const gate = gateConfigFromAppConfig(cfg);
  const ctx = await buildFinancialContext(db, userId, commitment);
  const result = evaluateGate(commitment, targetStage, ctx, gate);

  if (!result.passed) {
    return { commitment, gate: result };
  }

  const now = new Date().toISOString();
  await execDb(
    db,
    `UPDATE commitment_stages SET current_stage = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4`,
    [targetStage, now, commitmentId, userId]
  );
  await execDb(
    db,
    `INSERT INTO commitment_transitions
       (id, commitment_id, from_stage, to_stage, gate_result_json, decision_notes, decided_by, financial_snapshot_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [
      crypto.randomUUID(),
      commitmentId,
      commitment.currentStage,
      targetStage,
      JSON.stringify(result),
      notes ?? '',
      userId,
      JSON.stringify(ctx),
      now,
    ]
  );

  const updated = await getCommitment(db, userId, commitmentId);
  return { commitment: updated!, gate: result };
}

export async function listTransitions(
  db: D1Database,
  commitmentId: string
): Promise<CommitmentTransition[]> {
  const rows = await queryDb<{ commitment_id: string; from_stage: CommitmentStage; to_stage: CommitmentStage; created_at: string }>(
    db,
    `SELECT commitment_id, from_stage, to_stage, created_at
       FROM commitment_transitions WHERE commitment_id = ?1 ORDER BY created_at ASC`,
    [commitmentId]
  );
  return rows.map(r => ({
    commitmentId: r.commitment_id,
    fromStage: r.from_stage,
    toStage: r.to_stage,
    createdAt: r.created_at,
  }));
}

export async function getPacingMetrics(db: D1Database, userId: string): Promise<PacingMetrics> {
  const cfg = await loadConfig(db as any);
  const gate = gateConfigFromAppConfig(cfg);
  const commitments = await listCommitments(db, userId);

  const transitionRows = await queryDb<{ commitment_id: string; from_stage: CommitmentStage; to_stage: CommitmentStage; created_at: string }>(
    db,
    `SELECT t.commitment_id, t.from_stage, t.to_stage, t.created_at
       FROM commitment_transitions t
       JOIN commitment_stages s ON s.id = t.commitment_id
       WHERE s.user_id = ?1
       ORDER BY t.created_at DESC
       LIMIT 500`,
    [userId]
  );

  const cf = await queryDb<{ revenue: number }>(
    db,
    `SELECT COALESCE(revenue, 0) as revenue FROM cashflow_history
       WHERE user_id = ?1 ORDER BY month DESC LIMIT 12`,
    [userId]
  );
  const totalRevenueAnnual = cf.reduce((s, r) => s + r.revenue, 0);

  return computePacingMetrics(
    commitments,
    transitionRows.map(r => ({
      commitmentId: r.commitment_id,
      fromStage: r.from_stage,
      toStage: r.to_stage,
      createdAt: r.created_at,
    })),
    totalRevenueAnnual,
    gate
  );
}

export async function getWeightedForecast(db: D1Database, userId: string) {
  const cfg = await loadConfig(db as any);
  const gate = gateConfigFromAppConfig(cfg);
  const commitments = await listCommitments(db, userId);
  return computeWeightedForecast(commitments, gate);
}

/**
 * Recompute pacing metrics for a user and cache them in KV.
 * Called by the daily recalc cron.
 */
export async function recomputePacingMetrics(
  db: D1Database,
  cache: KVNamespace,
  userId: string
): Promise<{ totalCommitments: number; weightedRevenue: number }> {
  const metrics = await getPacingMetrics(db, userId);
  const cfg = await loadConfig(db as any);
  const ttl = Number(cfg['cache.summary_ttl_seconds'] ?? 3600);
  await cache.put(`pacing:${userId}`, JSON.stringify(metrics), { expirationTtl: ttl });
  return { totalCommitments: metrics.totalCommitments, weightedRevenue: metrics.weightedRevenue };
}

export { STAGE_ORDER };
export type { GateConfig };

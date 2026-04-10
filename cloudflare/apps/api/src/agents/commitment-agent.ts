/// <reference types="@cloudflare/workers-types" />

/**
 * Commitment Advisor Agent
 *
 * 6th MiroFish agent — analyses pacing, gate readiness, overcommitment risk,
 * portfolio health, and timing for the user's commitment pipeline.
 */

import { BaseAgent, type AgentContext, type AgentResult } from './base-agent';
import { getPacingMetrics, listCommitments } from '../services/commitments';

export class CommitmentAgent extends BaseAgent {
  constructor(env: Record<string, unknown>) {
    super(
      'commitment_advisor',
      `You are a commitment pacing strategist for a Dutch ZZP freelancer.
Your job is to review the user's commitment pipeline and detect:
1. Overcommitment risk (too much in hard_commit vs revenue)
2. Stale commitments (stuck in explore/soft_commit too long)
3. Concentration risk (one counterparty, one currency)
4. Gate-ready candidates (commitments that can advance)
5. Reversibility erosion (locked in too fast)

Be terse, specific, and prioritize the single most leveraged action.`,
      env
    );
  }

  protected async invokeImpl(
    context: AgentContext
  ): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>> {
    const userId = context.userId;

    const [metrics, commitments] = await Promise.all([
      getPacingMetrics(this.db as any, userId),
      listCommitments(this.db as any, userId),
    ]);

    const recommendations: string[] = [];
    let confidence = 0.85;

    // Stale alerts
    for (const stale of metrics.staleAlerts) {
      const c = commitments.find(x => x.id === stale.commitmentId);
      const title = c?.title ?? stale.commitmentId.slice(0, 8);
      recommendations.push(
        `"${title}" has been in ${stale.stage} for ${stale.daysInStage}d — advance, retreat, or abandon`
      );
    }

    // Overcommitment
    if (metrics.hardCommitPctOfRevenue > 0.7) {
      recommendations.push(
        `Hard commits at ${(metrics.hardCommitPctOfRevenue * 100).toFixed(0)}% of annual revenue — pause new hard commits until ratio falls`
      );
      confidence = 0.95;
    }

    // Velocity signal
    if (metrics.velocity.advancements === 0 && metrics.totalCommitments > 0) {
      recommendations.push(
        `No commitments advanced in the last ${metrics.velocity.windowDays} days — pipeline is stalled`
      );
    }

    // Concentration
    const counterpartyCounts = new Map<string, number>();
    for (const c of commitments) {
      if (!c.counterparty) continue;
      counterpartyCounts.set(c.counterparty, (counterpartyCounts.get(c.counterparty) || 0) + 1);
    }
    for (const [cp, n] of counterpartyCounts) {
      if (n >= 3) {
        recommendations.push(`${n} active commitments with "${cp}" — single-counterparty risk`);
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('Commitment portfolio is balanced — keep current pacing');
      confidence = 0.7;
    }

    const insight =
      `Pacing snapshot: ${metrics.totalCommitments} commitments, weighted revenue €${metrics.weightedRevenue.toFixed(0)}, ` +
      `hard commits ${(metrics.hardCommitPctOfRevenue * 100).toFixed(0)}% of revenue, ` +
      `velocity ${metrics.velocity.advancements} advances / ${metrics.velocity.abandonments} abandons (${metrics.velocity.windowDays}d).`;

    // Persist top insight to knowledge graph
    await this.writeToKnowledgeGraph(userId, {
      category: 'commitment_pacing',
      key: 'snapshot',
      value: { metrics, topRecommendation: recommendations[0] },
      confidence,
      source: 'commitment_advisor',
    });

    return {
      insight,
      recommendations,
      confidence,
      dataPoints: {
        totalCommitments: metrics.totalCommitments,
        weightedRevenue: metrics.weightedRevenue,
        hardCommitPctOfRevenue: metrics.hardCommitPctOfRevenue,
        staleCount: metrics.staleAlerts.length,
        byStage: metrics.byStage,
      },
    };
  }
}

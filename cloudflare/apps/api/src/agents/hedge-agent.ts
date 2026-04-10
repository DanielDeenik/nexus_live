/**
 * Hedge Agent
 * Analyzes FX exposure, hedging positions, and risk management
 */

/// <reference types="@cloudflare/workers-types" />

import { BaseAgent, type AgentContext, type AgentResult } from './base-agent.ts';
import { loadConfig } from '@nexus-live/shared';
import { queryDb } from '../utils/db';

/**
 * Hedge Strategist Agent
 */
export class HedgeAgent extends BaseAgent {
  constructor(env: Record<string, unknown>) {
    super(
      'hedge_strategist',
      `You are a currency risk management expert. Analyze FX exposure and hedging to provide:
1. Total FX exposure by currency and timeline
2. Hedged vs unhedged exposure breakdown
3. Recommended hedging strategies
4. Cost-benefit of active hedging
5. Payment timing optimization

Focus on practical, cost-effective recommendations.`,
      env
    );
  }

  protected async invokeImpl(
    context: AgentContext
  ): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>> {
    const userId = context.userId as string;

    // Load config
    await loadConfig(this.db as any);

    // Get pending invoices (FX exposure)
    const pendingInvoices = await queryDb<any>(
      this.db as any,
      `
      SELECT id, amount, currency, due_date as dueDate
      FROM invoices
      WHERE user_id = ?1 AND status IN ('sent', 'viewed', 'overdue')
      `,
      [userId]
    );

    // Get existing hedges
    const hedges = await queryDb<any>(
      this.db as any,
      `
      SELECT invoice_id, original_currency, hedged_currency, rate, premium, status
      FROM hedging_contracts
      WHERE user_id = ?1 AND status = 'active'
      `,
      [userId]
    );

    // Get Wise accounts
    const wiseAccounts = await queryDb<any>(
      this.db as any,
      `
      SELECT currency, balance, balance_usd as balanceUsd
      FROM wise_accounts
      WHERE user_id = ?1 AND status = 'active'
      `,
      [userId]
    );

    // Calculate exposures
    const exposure: Record<string, number> = {};
    let totalExposure = 0;

    for (const inv of pendingInvoices) {
      const amt = inv.amount;
      exposure[inv.currency] = (exposure[inv.currency] || 0) + amt;
      totalExposure += amt;
    }

    const hedgedAmount = hedges.reduce((sum, h) => sum + (h.originalAmount || 0), 0);
    const unhedgedAmount = totalExposure - hedgedAmount;

    // Generate insights
    const messages = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      {
        role: 'user',
        content: `Analyze FX exposure and hedging:
- Total pending invoices: €${totalExposure.toFixed(2)}
- Unhedged exposure: €${unhedgedAmount.toFixed(2)}
- Hedged exposure: €${hedgedAmount.toFixed(2)}
- Currency breakdown: ${Object.entries(exposure)
          .map(([curr, amt]) => `${curr}: €${amt.toFixed(0)}`)
          .join('; ')}
- Active hedges: ${hedges.length}
- Wise multi-currency accounts: ${wiseAccounts.length}

Provide hedging recommendations.`,
      },
    ];

    const response = await this.callLLM(messages, 0.6);

    // Write insights
    await this.writeToKnowledgeGraph(userId, {
      category: 'hedging',
      key: 'unhedged_exposure',
      value: unhedgedAmount,
      confidence: 0.95,
      source: 'invoice_analysis',
    });

    const recommendations = [
      `Total FX exposure: €${totalExposure.toFixed(2)}`,
      `Unhedged: €${unhedgedAmount.toFixed(2)} (${((unhedgedAmount / totalExposure) * 100).toFixed(0)}%)`,
      `Active hedges: ${hedges.length}`,
      unhedgedAmount > 10000
        ? 'Consider hedging significant exposure'
        : 'Exposure within acceptable range',
    ];

    return {
      insight: response,
      recommendations,
      confidence: 0.85,
      dataPoints: {
        totalExposure,
        hedgedAmount,
        unhedgedAmount,
        hedgeRatio: totalExposure > 0 ? hedgedAmount / totalExposure : 0,
        activeBudgets: hedges.length,
        pendingInvoices: pendingInvoices.length,
        wiseAccounts: wiseAccounts.length,
      },
    };
  }
}

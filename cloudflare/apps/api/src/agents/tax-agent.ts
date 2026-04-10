/// <reference types="@cloudflare/workers-types" />

/**
 * Tax Agent
 * Handles Dutch tax computation, compliance alerts, and optimization suggestions
 */

import { BaseAgent, type AgentContext, type AgentResult } from './base-agent.ts';
import { computeDutchTax, loadConfig } from '@nexus-live/shared';
import { queryDb } from '../utils/db';
import type { Invoice } from '@nexus-live/shared';

/**
 * Tax Advisor Agent
 */
export class TaxAgent extends BaseAgent {
  constructor(env: Record<string, unknown>) {
    super(
      'tax_advisor',
      `You are a Dutch tax specialist advisor. Analyze financial data and provide:
1. Tax liability estimates based on income and expenses
2. Compliance alerts for Dutch ZZP (freelancer) requirements
3. Deduction opportunities (zelfstandigenaftrek, MKB winstvrijstelling)
4. Quarterly/annual payment recommendations
5. Tax optimization strategies

Be specific with amounts, dates, and regulations.`,
      env
    );
  }

  protected async invokeImpl(
    context: AgentContext
  ): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>> {
    const userId = context.userId as string;

    // Load config
    const config = await loadConfig(this.db as any);

    // Get income data
    const invoices = await queryDb<Invoice>(
      this.db as any,
      `
      SELECT amount, status, currency, paid_date as paidDate
      FROM invoices
      WHERE user_id = ?1 AND status = 'paid'
      `,
      [userId]
    );

    const yearStart = new Date(Date.now() - 365 * 24 * 3600 * 1000)
      .toISOString()
      .split('T')[0];

    const recentInvoices = await queryDb<Invoice>(
      this.db as any,
      `
      SELECT amount
      FROM invoices
      WHERE user_id = ?1 AND status = 'paid' AND paid_date >= ?2
      `,
      [userId, yearStart]
    );

    const annualIncome = recentInvoices.reduce((sum, inv) => sum + inv.amount, 0);

    // Compute Dutch tax
    const taxResult = computeDutchTax(annualIncome, config.taxConfig);

    // Generate insights
    const messages = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      {
        role: 'user',
        content: `Analyze tax situation:
- Annual income: €${annualIncome.toFixed(2)}
- Estimated tax liability: €${(taxResult.totalTaxAndContributions || 0).toFixed(2)}
- Effective tax rate: ${((taxResult.effectiveTaxRate || 0) * 100).toFixed(1)}%
- Paid invoices: ${invoices.length}

Provide tax recommendations.`,
      },
    ];

    const response = await this.callLLM(messages, 0.6);

    // Write insights to knowledge graph
    await this.writeToKnowledgeGraph(userId, {
      category: 'tax',
      key: 'annual_tax_liability',
      value: taxResult.totalTaxAndContributions || 0,
      confidence: 0.95,
      source: 'tax_computation',
    });

    const recommendations = [
      `Estimated annual tax: €${(taxResult.totalTaxAndContributions || 0).toFixed(2)}`,
      `Effective rate: ${((taxResult.effectiveTaxRate || 0) * 100).toFixed(1)}%`,
      `Consider quarterly tax payments to manage cash flow`,
    ];

    return {
      insight: response,
      recommendations,
      confidence: 0.9,
      dataPoints: {
        annualIncome,
        estimatedTax: taxResult.totalTaxAndContributions || 0,
        effectiveRate: taxResult.effectiveTaxRate || 0,
        invoicesAnalyzed: invoices.length,
      },
    };
  }
}

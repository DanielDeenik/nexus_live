/// <reference types="@cloudflare/workers-types" />

/**
 * Cashflow Agent
 * Handles cashflow forecasting and actionable recommendations
 */

import { BaseAgent, type AgentContext, type AgentResult } from './base-agent.ts';
import { computeForecast, loadConfig } from '@nexus-live/shared';
import { queryDb } from '../utils/db';

/**
 * Cashflow Manager Agent
 */
export class CashflowAgent extends BaseAgent {
  constructor(env: Record<string, unknown>) {
    super(
      'cashflow_manager',
      `You are a cashflow management expert. Analyze historical data and forecasts to provide:
1. Cash runway analysis (months until cash depletes)
2. Payment timing recommendations
3. Reserve recommendations (tax, operating expenses)
4. Growth/contraction impact on runway
5. Actionable improvement strategies

Be specific with timelines and amounts.`,
      env
    );
  }

  protected async invokeImpl(
    context: AgentContext
  ): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>> {
    const userId = context.userId as string;

    // Load config
    const config = await loadConfig(this.db as any);

    // Get 24 months of history
    const cutoffDate = new Date(Date.now() - 24 * 30 * 24 * 3600 * 1000)
      .toISOString()
      .split('T')[0];

    const history = await queryDb<any>(
      this.db as any,
      `
      SELECT date, net_cashflow as value
      FROM cashflow_history
      WHERE user_id = ?1 AND date >= ?2
      ORDER BY date ASC
      `,
      [userId, cutoffDate]
    );

    let forecast = null;
    let trend = 0;
    let confidence = 0;

    if (history.length >= 2) {
      forecast = computeForecast(history, config.forecastConfig);
      trend = forecast.trend;
      confidence = forecast.confidence;
    }

    // Calculate metrics
    const recentMonths = history.slice(-3);
    const avgMonthlyBurn = recentMonths.length > 0
      ? Math.abs(
          recentMonths.reduce((sum, m) => sum + (m.value || 0), 0) /
            recentMonths.length
        )
      : 0;

    const currentCash = history[history.length - 1]?.value || 0;
    const runwayMonths = avgMonthlyBurn > 0 ? currentCash / avgMonthlyBurn : 0;

    // Generate insights
    const messages = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      {
        role: 'user',
        content: `Analyze cashflow:
- Current cash: €${currentCash.toFixed(2)}
- Monthly burn: €${avgMonthlyBurn.toFixed(2)}
- Runway: ${runwayMonths.toFixed(1)} months
- 12-month trend: ${trend > 0 ? 'improving' : 'declining'} (${Math.abs(trend * 100).toFixed(1)}%)
- Forecast confidence: ${(confidence * 100).toFixed(0)}%
- Data points: ${history.length} months

Provide cashflow recommendations.`,
      },
    ];

    const response = await this.callLLM(messages, 0.7);

    // Write insights
    await this.writeToKnowledgeGraph(userId, {
      category: 'cashflow',
      key: 'current_runway',
      value: runwayMonths,
      confidence: 0.85,
      source: 'forecast_engine',
    });

    const recommendations = [
      `Current runway: ${runwayMonths.toFixed(1)} months`,
      `Average monthly burn: €${avgMonthlyBurn.toFixed(2)}`,
      trend > 0
        ? 'Cashflow trend is improving'
        : 'Cashflow trend is declining - consider cost reduction',
      forecast
        ? `12-month forecast shows ${forecast.trend > 0 ? 'positive' : 'negative'} trend`
        : 'Insufficient data for forecast',
    ];

    return {
      insight: response,
      recommendations,
      confidence: Math.min(0.9, confidence),
      dataPoints: {
        currentCash,
        monthlyBurn: avgMonthlyBurn,
        runwayMonths,
        trend,
        historyMonths: history.length,
        forecastAvailable: !!forecast,
      },
    };
  }
}

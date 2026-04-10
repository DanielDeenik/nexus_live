/**
 * Market Agent
 * Analyzes market signals, trends, and opportunity timing
 */

import { BaseAgent, type AgentContext, type AgentResult } from './base-agent.ts';
import { queryDb } from '../utils/db';

/**
 * Market Analyst Agent
 */
export class MarketAgent extends BaseAgent {
  constructor(env: Record<string, unknown>) {
    super(
      'market_analyst',
      `You are a market intelligence analyst. Analyze market signals and trends to provide:
1. Hot market opportunities (scoring > 75)
2. Emerging industry trends
3. Hiring market strength in your sector
4. Lead quality analysis
5. Timing recommendations for business pivots or expansion

Focus on actionable insights.`,
      env
    );
  }

  protected async invokeImpl(
    context: AgentContext
  ): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>> {
    const userId = context.userId as string;

    // Get hot signals
    const hotSignals = await queryDb<any>(
      this.db,
      `
      SELECT type, subtype, score, tier, description, action, created_at
      FROM market_signals
      WHERE user_id = ?1 AND tier = 'HOT'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY score DESC
      LIMIT 10
      `,
      [userId]
    );

    // Get market trends
    const trends = await queryDb<any>(
      this.db,
      `
      SELECT metric, period, direction, slope, start_date, end_date
      FROM market_trends
      WHERE user_id = ?1
      ORDER BY created_at DESC
      LIMIT 5
      `,
      [userId]
    );

    // Get lead statistics
    const leadStats = await queryDb<any>(
      this.db,
      `
      SELECT score, COUNT(*) as count
      FROM leads
      WHERE user_id = ?1
      GROUP BY score
      `,
      [userId]
    );

    // Build context for LLM
    const signalSummary = hotSignals.length > 0
      ? `${hotSignals.length} hot signals: ${hotSignals.map(s => `${s.subtype} (score: ${s.score})`).join(', ')}`
      : 'No hot signals currently';

    const trendSummary = trends.length > 0
      ? `${trends.map(t => `${t.metric} is ${t.direction}`).join('; ')}`
      : 'No trend data available';

    const messages = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      {
        role: 'user',
        content: `Market analysis:
- ${signalSummary}
- Trends: ${trendSummary}
- Lead distribution: ${JSON.stringify(
          leadStats.reduce(
            (acc: Record<string, number>, s: any) => {
              acc[s.score] = s.count;
              return acc;
            },
            {}
          )
        )}

Provide market opportunity recommendations.`,
      },
    ];

    const response = await this.callLLM(messages, 0.8);

    // Write insights
    await this.writeToKnowledgeGraph(userId, {
      category: 'market',
      key: 'hot_signal_count',
      value: hotSignals.length,
      confidence: 0.9,
      source: 'signal_analysis',
    });

    const recommendations = [
      `${hotSignals.length} hot market opportunities identified`,
      trends.some((t: any) => t.direction === 'increasing')
        ? 'Positive market trends detected'
        : 'Monitor market conditions',
      leadStats.length > 0 ? 'Review qualified leads' : 'Focus on lead generation',
    ];

    return {
      insight: response,
      recommendations,
      confidence: Math.min(0.85, 0.5 + hotSignals.length * 0.1),
      dataPoints: {
        hotSignalsCount: hotSignals.length,
        trendsAnalyzed: trends.length,
        leadSegments: leadStats.length,
        topOpportunities: hotSignals.slice(0, 3).map((s: any) => s.subtype),
      },
    };
  }
}

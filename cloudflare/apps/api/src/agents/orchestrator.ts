/**
 * Orchestrator Agent
 * Routes queries to specialist agents and runs them in parallel.
 */

import { BaseAgent, type AgentContext, type AgentResult, type AgentId } from './base-agent';
import { TaxAgent } from './tax-agent';
import { CashflowAgent } from './cashflow-agent';
import { MarketAgent } from './market-agent';
import { HedgeAgent } from './hedge-agent';
import { CommitmentAgent } from './commitment-agent';

export type SpecialistName =
  | 'tax_advisor'
  | 'cashflow_manager'
  | 'market_analyst'
  | 'hedge_strategist'
  | 'commitment_advisor';

export class Orchestrator extends BaseAgent {
  private readonly env: Record<string, unknown>;

  constructor(env: Record<string, unknown>) {
    super(
      'market_analyst', // base log id; orchestrator does not have its own enum slot yet
      `You are a financial AI orchestrator. Analyze user queries and decide which specialist agents to invoke:
- tax_advisor: tax questions, compliance, deductions, brackets
- cashflow_manager: cashflow, forecasts, runway, burn
- market_analyst: market signals, opportunities, leads, trends
- hedge_strategist: currency risk, hedging, FX exposure
- commitment_advisor: commitment pacing, gate decisions, overcommitment risk

Return a comma-separated list of agent ids that should respond, ordered by relevance.`,
      env
    );
    this.env = env;
  }

  protected async invokeImpl(
    context: AgentContext
  ): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>> {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: context.query },
    ];

    let plan: string;
    try {
      plan = await this.callLLM(messages, 0.2);
    } catch {
      plan = '';
    }

    const agents = this.parseOrchestrationPlan(plan, context.query);
    return {
      insight: `Routing to ${agents.length} specialist agent(s): ${agents.join(', ')}`,
      recommendations: agents.map(a => `Consult ${a.replace('_', ' ')}`),
      confidence: 0.9,
      dataPoints: { agentsSelected: agents, queryAnalyzed: true },
    };
  }

  private parseOrchestrationPlan(llmResponse: string, originalQuery: string): SpecialistName[] {
    const haystack = `${llmResponse} ${originalQuery}`.toLowerCase();
    const agents: SpecialistName[] = [];

    if (/tax|deduct|vat|btw|bracket|zelfstandig/.test(haystack)) agents.push('tax_advisor');
    if (/cashflow|forecast|runway|burn|liquid/.test(haystack)) agents.push('cashflow_manager');
    if (/market|signal|opportun|lead|trend/.test(haystack)) agents.push('market_analyst');
    if (/hedge|currency|fx|exposure|usd|gbp|exchange/.test(haystack)) agents.push('hedge_strategist');
    if (/commit|stage|gate|pacing|reversib|hard.commit|soft.commit/.test(haystack)) agents.push('commitment_advisor');

    return agents.length > 0 ? agents : ['cashflow_manager'];
  }

  private buildAgent(name: SpecialistName): BaseAgent {
    switch (name) {
      case 'tax_advisor': return new TaxAgent(this.env);
      case 'cashflow_manager': return new CashflowAgent(this.env);
      case 'market_analyst': return new MarketAgent(this.env);
      case 'hedge_strategist': return new HedgeAgent(this.env);
      case 'commitment_advisor': return new CommitmentAgent(this.env);
    }
  }

  /**
   * Run multiple specialist agents in parallel and collect their real results.
   */
  async invokeMultiple(context: AgentContext, agentIds: SpecialistName[]): Promise<AgentResult[]> {
    const results = await Promise.allSettled(
      agentIds.map(id => this.buildAgent(id).invoke(context))
    );

    const out: AgentResult[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        out.push(r.value);
      } else {
        out.push({
          agentId: agentIds[i] as AgentId,
          status: 'error',
          insight: `Agent ${agentIds[i]} failed`,
          recommendations: [],
          confidence: 0,
          dataPoints: { error: String(r.reason) },
          executedAt: new Date().toISOString(),
        });
      }
    }
    return out;
  }

  /**
   * End-to-end: analyze query, select agents, run them, return all results.
   */
  async route(context: AgentContext): Promise<{ orchestration: AgentResult; specialists: AgentResult[] }> {
    const orchestration = await this.invoke(context);
    const ids = (orchestration.dataPoints?.agentsSelected as SpecialistName[] | undefined) ?? ['cashflow_manager'];
    const specialists = await this.invokeMultiple(context, ids);
    return { orchestration, specialists };
  }
}

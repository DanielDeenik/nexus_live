/// <reference types="@cloudflare/workers-types" />

/**
 * Abstract base agent class
 * All agents inherit from this for LLM integration, caching, and rate limiting
 */

import { execDb } from '../utils/db';

export type AgentId =
  | 'tax_advisor'
  | 'cashflow_manager'
  | 'market_analyst'
  | 'hedge_strategist'
  | 'commitment_advisor';

export interface AgentContext {
  userId: string;
  userState: Record<string, unknown>;
  query: string;
  data: Record<string, unknown>;
}

export interface AgentResult {
  agentId: AgentId;
  status: 'success' | 'error' | 'cached';
  insight: string;
  recommendations: string[];
  confidence: number;
  dataPoints: Record<string, unknown>;
  executedAt: string;
  cached?: boolean;
}

/**
 * Base Agent class
 */
export abstract class BaseAgent {
  protected id: AgentId;
  protected systemPrompt: string;
  protected db: D1Database;
  protected cache: KVNamespace;
  protected llm: any; // AI Gateway
  protected jwtSecret: string;

  constructor(
    id: AgentId,
    systemPrompt: string,
    env: Record<string, unknown>
  ) {
    this.id = id;
    this.systemPrompt = systemPrompt;
    this.db = env.DB as D1Database;
    this.cache = env.CACHE as KVNamespace;
    this.llm = env.AI; // Cloudflare Workers AI
    this.jwtSecret = env.JWT_SECRET as string;
  }

  /**
   * Main invoke method - called to get agent insight
   */
  async invoke(context: AgentContext): Promise<AgentResult> {
    // Check cache first
    const cached = await this.getFromCache(context);
    if (cached) {
      return {
        ...cached,
        cached: true,
        status: 'cached',
      };
    }

    // Check rate limit
    const allowed = await this.checkRateLimit(context.userId);
    if (!allowed) {
      // Return last cached insight as fallback
      const fallback = await this.getFromCache(context);
      if (fallback) {
        return {
          ...fallback,
          status: 'cached',
          cached: true,
        };
      }

      throw new Error(`Rate limit exceeded for ${this.id}`);
    }

    // Call LLM
    const startTime = Date.now();
    const result = await this.invokeImpl(context);
    const duration = Date.now() - startTime;

    // Cache result
    await this.cacheResult(context.userId, result);

    // Log execution
    await this.logExecution(context.userId, duration, 'success');

    return {
      agentId: this.id,
      status: 'success',
      executedAt: new Date().toISOString(),
      ...result,
    };
  }

  /**
   * Implementation-specific invoke logic (override in subclass)
   */
  protected abstract invokeImpl(context: AgentContext): Promise<Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>>;

  /**
   * Call LLM via AI Gateway
   */
  protected async callLLM(
    messages: Array<{ role: string; content: string }>,
    temperature: number = 0.7
  ): Promise<string> {
    try {
      if (!this.llm) {
        throw new Error('LLM not configured');
      }

      const response = await this.llm.run('@cf/meta/llama-2-7b-chat-int8', {
        messages,
        temperature,
        max_tokens: 1024,
      });

      return response.response || '';
    } catch (error) {
      throw new Error(`LLM call failed: ${error}`);
    }
  }

  /**
   * Get cached insight
   */
  private async getFromCache(context: AgentContext): Promise<AgentResult | null> {
    try {
      const cacheKey = `agent:${this.id}:${context.userId}`;
      const cached = await this.cache.get(cacheKey, 'json');
      return cached as AgentResult | null;
    } catch {
      return null;
    }
  }

  /**
   * Cache insight result
   */
  private async cacheResult(
    userId: string,
    result: Omit<AgentResult, 'agentId' | 'status' | 'executedAt'>
  ): Promise<void> {
    try {
      const cacheKey = `agent:${this.id}:${userId}`;
      const ttl = 3600; // 1 hour default

      await this.cache.put(cacheKey, JSON.stringify(result), {
        expirationTtl: ttl,
      });
    } catch {
      // Silently fail cache write
    }
  }

  /**
   * Check and enforce daily rate limit
   */
  private async checkRateLimit(userId: string): Promise<boolean> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const limitKey = `agent-limit:${this.id}:${userId}:${today}`;

      const current = await this.cache.get<number>(limitKey, 'json');
      const count = (current || 0) + 1;
      const limit = 10; // 10 invocations per day per agent

      if (count > limit) {
        return false;
      }

      await this.cache.put(limitKey, JSON.stringify(count), {
        expirationTtl: 86400, // 24 hours
      });

      return true;
    } catch {
      return true; // Allow if check fails
    }
  }

  /**
   * Log execution metrics
   */
  private async logExecution(
    userId: string,
    duration: number,
    status: string
  ): Promise<void> {
    try {
      const logId = crypto.randomUUID();
      const now = new Date().toISOString();

      await execDb(
        this.db as any,
        `
        INSERT INTO agent_execution_log (id, user_id, agent_id, status, duration_ms, executed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
        [logId, userId, this.id, status, duration, now]
      );
    } catch {
      // Silently fail logging
    }
  }

  /**
   * Write to knowledge graph
   */
  protected async writeToKnowledgeGraph(
    userId: string,
    entry: {
      category: string;
      key: string;
      value: unknown;
      confidence: number;
      source: string;
    }
  ): Promise<void> {
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await execDb(
        this.db as any,
        `
        INSERT INTO agent_knowledge_graph (id, user_id, agent_id, category, key, value, confidence, source, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        `,
        [
          id,
          userId,
          this.id,
          entry.category,
          entry.key,
          JSON.stringify(entry.value),
          entry.confidence,
          entry.source,
          now,
        ]
      );
    } catch {
      // Silently fail knowledge graph write
    }
  }
}

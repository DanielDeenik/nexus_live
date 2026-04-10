/**
 * Signal Scoring Engine
 * Scores market signals and leads using configurable tiers
 * HOT > WARM > MONITOR > COLD
 */

export interface RawSignal {
  id: string;
  type: 'currency' | 'market' | 'industry' | 'lead' | 'operational';
  subtype: string;
  data: Record<string, number | string | boolean>;
  timestamp: string;
}

export interface UserProfile {
  riskTolerance: 'low' | 'medium' | 'high';
  industry?: string;
  targetMarkets?: string[];
  goals: string[];
  constraints: string[];
}

export interface ScoringConfig {
  // Tier thresholds (0-100 scale)
  hotThreshold: number;
  warmThreshold: number;
  monitorThreshold: number;
  // Signal type weights
  weights: {
    currency: number;
    market: number;
    industry: number;
    lead: number;
    operational: number;
  };
  // Time decay factor (how old signals lose value)
  timeDecayFactor: number;
  // Confidence adjustments by risk tolerance
  confidenceByRiskTolerance: {
    low: number;
    medium: number;
    high: number;
  };
}

export interface ScoredSignal {
  id: string;
  type: string;
  subtype: string;
  score: number;
  tier: 'HOT' | 'WARM' | 'MONITOR' | 'COLD';
  probability: number;
  action: string;
  confidence: number;
  rationale: string;
  dataPoints: Record<string, number | string | boolean>;
}

/**
 * Score a signal based on type, data, user profile, and config
 * All thresholds and weights come from config, never hardcoded
 */
export function scoreSignal(
  signal: RawSignal,
  profile: UserProfile,
  config: ScoringConfig
): ScoredSignal {
  // Calculate base score (0-100)
  const baseScore = calculateBaseScore(
    signal,
    config
  );

  // Apply profile adjustments
  const profileAdjustment = calculateProfileAdjustment(
    signal,
    profile
  );

  // Apply time decay
  const ageInHours = getSignalAge(signal.timestamp);
  const timeDecay = Math.exp(
    -config.timeDecayFactor * (ageInHours / 24)
  );

  // Final score
  const finalScore = Math.max(
    0,
    Math.min(100, baseScore + profileAdjustment) * timeDecay
  );

  // Determine tier
  let tier: 'HOT' | 'WARM' | 'MONITOR' | 'COLD' = 'COLD';
  if (finalScore >= config.hotThreshold) {
    tier = 'HOT';
  } else if (finalScore >= config.warmThreshold) {
    tier = 'WARM';
  } else if (finalScore >= config.monitorThreshold) {
    tier = 'MONITOR';
  }

  // Calculate probability and action
  const probability = finalScore / 100;
  const action = generateAction(signal, tier, probability);

  // Adjust confidence based on risk tolerance
  const baseConfidence = probability;
  const confidenceAdjustment =
    config.confidenceByRiskTolerance[profile.riskTolerance];
  const confidence = Math.max(
    0,
    Math.min(1, baseConfidence * confidenceAdjustment)
  );

  const rationale = generateRationale(
    signal,
    baseScore,
    profileAdjustment,
    timeDecay,
    tier
  );

  return {
    id: signal.id,
    type: signal.type,
    subtype: signal.subtype,
    score: Math.round(finalScore),
    tier,
    probability: Math.round(probability * 100) / 100,
    action,
    confidence: Math.round(confidence * 100) / 100,
    rationale,
    dataPoints: signal.data,
  };
}

/**
 * Calculate base score from signal characteristics
 */
function calculateBaseScore(
  signal: RawSignal,
  config: ScoringConfig
): number {
  const typeWeight = config.weights[signal.type] || 0.5;

  // Score based on signal type
  let typeScore = 50; // Default middle score

  if (signal.type === 'currency') {
    typeScore = scoreCurrencySignal(signal);
  } else if (signal.type === 'market') {
    typeScore = scoreMarketSignal(signal);
  } else if (signal.type === 'industry') {
    typeScore = scoreIndustrySignal(signal);
  } else if (signal.type === 'lead') {
    typeScore = scoreLeadSignal(signal);
  } else if (signal.type === 'operational') {
    typeScore = scoreOperationalSignal(signal);
  }

  // Apply type weight
  return typeScore * typeWeight;
}

/**
 * Score currency-related signals
 */
function scoreCurrencySignal(signal: RawSignal): number {
  const data = signal.data;
  let score = 50;

  // Volatility factor
  if (typeof data.volatility === 'number') {
    if (data.volatility > 0.05) {
      score += 20; // High volatility = opportunity
    } else if (data.volatility < 0.01) {
      score -= 10; // Low volatility = less interesting
    }
  }

  // Trend direction
  if (typeof data.trend === 'string') {
    if (data.trend === 'strengthening') {
      score += 15;
    } else if (data.trend === 'weakening') {
      score -= 10;
    }
  }

  // Momentum
  if (typeof data.momentum === 'number') {
    score += Math.min(20, data.momentum * 10);
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Score market signals
 */
function scoreMarketSignal(signal: RawSignal): number {
  const data = signal.data;
  let score = 50;

  // Market size
  if (typeof data.marketSize === 'number') {
    if (data.marketSize > 1000000) {
      score += 15;
    }
  }

  // Growth rate
  if (typeof data.growthRate === 'number') {
    score += Math.min(20, data.growthRate * 5);
  }

  // Competition
  if (typeof data.competitionLevel === 'string') {
    if (data.competitionLevel === 'low') {
      score += 15;
    } else if (data.competitionLevel === 'high') {
      score -= 10;
    }
  }

  // Timing
  if (typeof data.timing === 'string') {
    if (
      data.timing === 'emerging' ||
      data.timing === 'peak'
    ) {
      score += 10;
    }
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Score industry signals
 */
function scoreIndustrySignal(
  signal: RawSignal
): number {
  const data = signal.data;
  let score = 50;

  // Regulation changes
  if (
    typeof data.regulationChange === 'string'
  ) {
    if (data.regulationChange === 'favorable') {
      score += 20;
    } else if (
      data.regulationChange === 'unfavorable'
    ) {
      score -= 15;
    }
  }

  // Technology disruption
  if (typeof data.disruption === 'boolean') {
    if (data.disruption) {
      score += 25;
    }
  }

  // Consolidation activity
  if (typeof data['m&a_activity'] === 'number') {
    score += Math.min(15, (data['m&a_activity'] as number) * 5);
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Score lead quality signals
 */
function scoreLeadSignal(signal: RawSignal): number {
  const data = signal.data;
  let score = 50;

  // Budget size
  if (typeof data.budget === 'number') {
    if (data.budget > 100000) {
      score += 20;
    } else if (data.budget < 10000) {
      score -= 15;
    }
  }

  // Buying timeline
  if (typeof data.buyingTimeline === 'string') {
    if (data.buyingTimeline === 'immediate') {
      score += 25;
    } else if (data.buyingTimeline === 'unknown') {
      score -= 10;
    }
  }

  // Decision maker accessibility
  if (typeof data.decisionMaker === 'boolean') {
    if (data.decisionMaker) {
      score += 15;
    } else {
      score -= 10;
    }
  }

  // Fit assessment
  if (typeof data.fit === 'string') {
    if (data.fit === 'strong') {
      score += 20;
    } else if (data.fit === 'weak') {
      score -= 15;
    }
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Score operational signals
 */
function scoreOperationalSignal(
  signal: RawSignal
): number {
  const data = signal.data;
  let score = 50;

  // Urgency level
  if (typeof data.urgency === 'string') {
    if (data.urgency === 'critical') {
      score += 30;
    } else if (data.urgency === 'low') {
      score -= 10;
    }
  }

  // Impact level
  if (typeof data.impact === 'string') {
    if (data.impact === 'high') {
      score += 20;
    } else if (data.impact === 'low') {
      score -= 10;
    }
  }

  // Controllability
  if (typeof data.controllable === 'boolean') {
    if (data.controllable) {
      score += 10;
    } else {
      score -= 15;
    }
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Adjust score based on user profile alignment
 */
function calculateProfileAdjustment(
  signal: RawSignal,
  profile: UserProfile
): number {
  let adjustment = 0;

  // Industry alignment
  if (
    profile.industry &&
    typeof signal.data.industry === 'string'
  ) {
    if (
      signal.data.industry.toLowerCase() ===
      profile.industry.toLowerCase()
    ) {
      adjustment += 15;
    }
  }

  // Market alignment
  if (
    profile.targetMarkets &&
    typeof signal.data.market === 'string'
  ) {
    if (
      profile.targetMarkets.some(
        m =>
          m.toLowerCase() ===
          (signal.data.market as string).toLowerCase()
      )
    ) {
      adjustment += 10;
    }
  }

  // Goal alignment
  if (signal.type === 'lead' && profile.goals.includes('growth')) {
    adjustment += 10;
  }

  if (
    signal.type === 'currency' &&
    profile.goals.includes('cash_stability')
  ) {
    adjustment += 10;
  }

  // Risk tolerance adjustment
  if (profile.riskTolerance === 'high') {
    adjustment += 5; // More aggressive scoring
  } else if (profile.riskTolerance === 'low') {
    adjustment -= 10; // More conservative scoring
  }

  return adjustment;
}

/**
 * Get signal age in hours
 */
function getSignalAge(timestamp: string): number {
  const now = new Date();
  const signalTime = new Date(timestamp);
  const diffMs = now.getTime() - signalTime.getTime();
  return diffMs / (1000 * 60 * 60);
}

/**
 * Generate actionable recommendation based on tier
 */
function generateAction(
  signal: RawSignal,
  tier: string,
  _probability: number
): string {
  const baseAction: Record<string, string> = {
    currency:
      'Monitor exchange rates and consider hedging strategy',
    market: 'Research market opportunity and feasibility',
    industry: 'Analyze industry trends and positioning',
    lead: 'Initiate contact and qualification process',
    operational: 'Address immediately to prevent impact',
  };

  let action = baseAction[signal.type] || 'Review signal';

  if (tier === 'HOT') {
    action = 'URGENT: ' + action;
  } else if (tier === 'COLD') {
    action = 'Archive and revisit periodically: ' + action;
  }

  return action;
}

/**
 * Generate human-readable rationale for the score
 */
function generateRationale(
  _signal: RawSignal,
  baseScore: number,
  profileAdjustment: number,
  timeDecay: number,
  tier: string
): string {
  let rationale = `Base score: ${Math.round(baseScore)}/100. `;

  if (profileAdjustment > 0) {
    rationale += `Profile alignment boost: +${Math.round(profileAdjustment)}. `;
  } else if (profileAdjustment < 0) {
    rationale += `Profile mismatch: ${Math.round(profileAdjustment)}. `;
  }

  rationale += `Time decay applied: ${Math.round(timeDecay * 100)}%. `;
  rationale += `Signal tier: ${tier}.`;

  return rationale;
}

/**
 * Batch score multiple signals
 */
export function batchScoreSignals(
  signals: RawSignal[],
  profile: UserProfile,
  config: ScoringConfig
): ScoredSignal[] {
  return signals.map(signal =>
    scoreSignal(signal, profile, config)
  );
}

/**
 * Calculate portfolio signal summary
 */
export function summarizeSignals(
  signals: ScoredSignal[]
): {
  total: number;
  byTier: Record<string, number>;
  averageScore: number;
  topSignals: ScoredSignal[];
  actionItems: number;
} {
  const byTier: Record<string, number> = {
    HOT: 0,
    WARM: 0,
    MONITOR: 0,
    COLD: 0,
  };

  for (const signal of signals) {
    byTier[signal.tier]++;
  }

  const averageScore =
    signals.length > 0
      ? signals.reduce((sum, s) => sum + s.score, 0) /
        signals.length
      : 0;

  const topSignals = [...signals]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const actionItems = signals.filter(
    s => s.tier === 'HOT' || s.tier === 'WARM'
  ).length;

  return {
    total: signals.length,
    byTier,
    averageScore: Math.round(averageScore),
    topSignals,
    actionItems,
  };
}

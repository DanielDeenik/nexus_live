/**
 * Configuration Loader
 * Reads and manages application configuration from D1 database
 * All runtime values come from database, defaults used only for seeding
 */

import type { D1Database } from '../types/env';
import type { DutchTaxConfig } from '../engines/tax';
import type { ForecastConfig } from '../engines/forecast';
import type { ScoringConfig } from '../engines/scoring';

export interface AppConfiguration {
  // Tax configuration
  taxConfig: DutchTaxConfig;
  // Forecast configuration
  forecastConfig: ForecastConfig;
  // Scoring configuration
  scoringConfig: ScoringConfig;
  // Application settings
  appSettings: AppSettings;
  // Feature flags
  featureFlags: Record<string, boolean>;
}

export interface AppSettings {
  maxRequestSize: number;
  requestTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  agentCachingEnabled: boolean;
  maxConcurrentRequests: number;
}

/**
 * Load full application configuration from database
 */
export async function loadConfig(
  db: D1Database
): Promise<AppConfiguration> {
  // Fetch all config values from database
  const configRows = await db
    .prepare('SELECT key, value, type FROM app_config')
    .all<{
      key: string;
      value: string;
      type: string;
    }>();

  if (!configRows.results) {
    // Return defaults if table is empty
    return DEFAULT_CONFIG;
  }

  // Parse configuration values
  const configMap = new Map<string, unknown>();

  for (const row of configRows.results) {
    const value = parseConfigValue(row.value, row.type);
    configMap.set(row.key, value);
  }

  return buildConfiguration(configMap);
}

/**
 * Get a specific configuration value
 */
export async function getConfigValue(
  db: D1Database,
  key: string
): Promise<string | null> {
  const result = await db
    .prepare(
      'SELECT value FROM app_config WHERE key = ?1'
    )
    .bind(key)
    .first<{ value: string }>();

  return result?.value || null;
}

/**
 * Set a configuration value
 */
export async function setConfigValue(
  db: D1Database,
  key: string,
  value: string
): Promise<void> {
  const existing = await getConfigValue(db, key);

  if (existing) {
    await db
      .prepare(
        'UPDATE app_config SET value = ?1, updated_at = ?2 WHERE key = ?3'
      )
      .bind(value, new Date().toISOString(), key)
      .run();
  } else {
    await db
      .prepare(
        'INSERT INTO app_config (key, value, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
      .bind(key, value, 'string', new Date().toISOString(), new Date().toISOString())
      .run();
  }
}

/**
 * Parse configuration value based on type
 */
function parseConfigValue(
  value: string,
  type: string
): unknown {
  switch (type) {
    case 'number':
      return parseFloat(value);
    case 'boolean':
      return value.toLowerCase() === 'true';
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

/**
 * Build AppConfiguration from config map
 */
function buildConfiguration(
  configMap: Map<string, unknown>
): AppConfiguration {
  return {
    taxConfig: {
      taxBrackets: getTaxBrackets(configMap),
      zvwRate:
        (configMap.get('tax_zvw_rate') as number) ||
        DEFAULT_CONFIG.taxConfig.zvwRate,
      zelfstandigenaftrek:
        (configMap.get('tax_zelfstandigenaftrek') as number) ||
        DEFAULT_CONFIG.taxConfig.zelfstandigenaftrek,
      mkbWinstvrijstelling:
        (configMap.get('tax_mkb_winstvrijstelling') as number) ||
        DEFAULT_CONFIG.taxConfig.mkbWinstvrijstelling,
      aowRate:
        (configMap.get('tax_aow_rate') as number) ||
        DEFAULT_CONFIG.taxConfig.aowRate,
      uvwBaseRate:
        (configMap.get('tax_uvw_rate') as number) ||
        DEFAULT_CONFIG.taxConfig.uvwBaseRate,
      arbeidskorting:
        (configMap.get('tax_arbeidskorting') as typeof DEFAULT_CONFIG.taxConfig.arbeidskorting) ||
        DEFAULT_CONFIG.taxConfig.arbeidskorting,
      generalTaxCredit:
        (configMap.get('tax_general_credit') as number) ||
        DEFAULT_CONFIG.taxConfig.generalTaxCredit,
      earningAllowance:
        (configMap.get('tax_earning_allowance') as number) ||
        DEFAULT_CONFIG.taxConfig.earningAllowance,
    },
    forecastConfig: {
      alpha:
        (configMap.get('forecast_alpha') as number) ||
        DEFAULT_CONFIG.forecastConfig.alpha,
      beta:
        (configMap.get('forecast_beta') as number) ||
        DEFAULT_CONFIG.forecastConfig.beta,
      gamma:
        (configMap.get('forecast_gamma') as number) ||
        DEFAULT_CONFIG.forecastConfig.gamma,
      seasonLength:
        (configMap.get('forecast_season_length') as number) ||
        DEFAULT_CONFIG.forecastConfig.seasonLength,
      horizonMonths:
        (configMap.get('forecast_horizon_months') as number) ||
        DEFAULT_CONFIG.forecastConfig.horizonMonths,
      confidenceWidth:
        (configMap.get('forecast_confidence_width') as number) ||
        DEFAULT_CONFIG.forecastConfig.confidenceWidth,
    },
    scoringConfig: {
      hotThreshold:
        (configMap.get('score_hot_threshold') as number) ||
        DEFAULT_CONFIG.scoringConfig.hotThreshold,
      warmThreshold:
        (configMap.get('score_warm_threshold') as number) ||
        DEFAULT_CONFIG.scoringConfig.warmThreshold,
      monitorThreshold:
        (configMap.get('score_monitor_threshold') as number) ||
        DEFAULT_CONFIG.scoringConfig.monitorThreshold,
      weights:
        (configMap.get('score_weights') as typeof DEFAULT_CONFIG.scoringConfig.weights) ||
        DEFAULT_CONFIG.scoringConfig.weights,
      timeDecayFactor:
        (configMap.get('score_time_decay') as number) ||
        DEFAULT_CONFIG.scoringConfig.timeDecayFactor,
      confidenceByRiskTolerance:
        (configMap.get('score_confidence_risk') as typeof DEFAULT_CONFIG.scoringConfig.confidenceByRiskTolerance) ||
        DEFAULT_CONFIG.scoringConfig.confidenceByRiskTolerance,
    },
    appSettings: {
      maxRequestSize:
        (configMap.get('max_request_size') as number) ||
        DEFAULT_CONFIG.appSettings.maxRequestSize,
      requestTimeoutMs:
        (configMap.get('request_timeout_ms') as number) ||
        DEFAULT_CONFIG.appSettings.requestTimeoutMs,
      cacheEnabled:
        (configMap.get('cache_enabled') as boolean) ||
        DEFAULT_CONFIG.appSettings.cacheEnabled,
      cacheTtlSeconds:
        (configMap.get('cache_ttl_seconds') as number) ||
        DEFAULT_CONFIG.appSettings.cacheTtlSeconds,
      logLevel:
        (configMap.get('log_level') as AppSettings['logLevel']) ||
        DEFAULT_CONFIG.appSettings.logLevel,
      agentCachingEnabled:
        (configMap.get('agent_caching_enabled') as boolean) ||
        DEFAULT_CONFIG.appSettings.agentCachingEnabled,
      maxConcurrentRequests:
        (configMap.get('max_concurrent_requests') as number) ||
        DEFAULT_CONFIG.appSettings.maxConcurrentRequests,
    },
    featureFlags: getFeatureFlags(configMap),
  };
}

/**
 * Extract tax brackets from config
 */
function getTaxBrackets(
  configMap: Map<string, unknown>
): Array<[number, number]> {
  const bracketsJson = configMap.get('tax_brackets');
  if (typeof bracketsJson === 'string') {
    try {
      return JSON.parse(bracketsJson);
    } catch {
      return DEFAULT_CONFIG.taxConfig.taxBrackets;
    }
  }
  if (Array.isArray(bracketsJson)) {
    return bracketsJson as Array<[number, number]>;
  }
  return DEFAULT_CONFIG.taxConfig.taxBrackets;
}

/**
 * Extract feature flags from config
 */
function getFeatureFlags(
  configMap: Map<string, unknown>
): Record<string, boolean> {
  const flags: Record<string, boolean> = {};

  for (const [key, value] of configMap) {
    if (key.startsWith('feature_')) {
      const flagName = key.replace('feature_', '');
      flags[flagName] =
        typeof value === 'boolean'
          ? value
          : value === 'true';
    }
  }

  return flags;
}

/**
 * DEFAULT_CONFIG - Used only for seeding database
 * NEVER read directly at runtime - always fetch from database
 */
export const DEFAULT_CONFIG: AppConfiguration = {
  taxConfig: {
    // Dutch tax brackets for 2024 (Box 1)
    // [threshold, rate]
    taxBrackets: [
      [0, 0.0],
      [22041, 0.1037],
      [67001, 0.1655],
      [117398, 0.19],
      [242705, 0.49],
    ],
    // ZVW (health insurance contribution)
    zvwRate: 0.01, // 1% of income
    // Zelfstandigenaftrek (self-employed deduction)
    zelfstandigenaftrek: 5000, // Annual deduction
    // MKB winstvrijstelling (SME profit exemption)
    mkbWinstvrijstelling: 2000, // Annual exemption
    // AOW contribution (state pension)
    aowRate: 0.1709, // 17.09%
    // UVW contribution (disability/unemployment)
    uvwBaseRate: 0.08, // 8% base rate
    // Arbeidskorting (wage tax credit)
    arbeidskorting: {
      threshold: 22041,
      maxCredit: 3256,
      reductionRate: 0.05,
    },
    // General tax credit
    generalTaxCredit: 3256,
    // Earning allowance
    earningAllowance: 0,
  },

  forecastConfig: {
    // Holt-Winters smoothing parameters
    alpha: 0.3, // Level smoothing
    beta: 0.1, // Trend smoothing
    gamma: 0.1, // Seasonality smoothing
    seasonLength: 12, // Monthly data
    horizonMonths: 12, // Forecast 12 months ahead
    confidenceWidth: 0.8, // 80% confidence interval
  },

  scoringConfig: {
    // Signal scoring thresholds (0-100 scale)
    hotThreshold: 75,
    warmThreshold: 50,
    monitorThreshold: 25,
    // Signal type weights
    weights: {
      currency: 0.8,
      market: 1.0,
      industry: 0.9,
      lead: 1.2,
      operational: 1.1,
    },
    // Time decay: signals lose value over time
    timeDecayFactor: 0.1, // 10% decay per day
    // Risk tolerance adjustments
    confidenceByRiskTolerance: {
      low: 0.8, // More conservative
      medium: 1.0, // Standard
      high: 1.2, // More aggressive
    },
  },

  appSettings: {
    maxRequestSize: 10 * 1024 * 1024, // 10 MB
    requestTimeoutMs: 30000, // 30 seconds
    cacheEnabled: true,
    cacheTtlSeconds: 300, // 5 minutes
    logLevel: 'info',
    agentCachingEnabled: true,
    maxConcurrentRequests: 10,
  },

  featureFlags: {
    agent_enabled: true,
    advanced_forecasting: true,
    hedging_enabled: true,
    scenario_simulation: true,
    signal_scoring: true,
    multi_currency: true,
    wise_integration: true,
  },
};

/**
 * Seed database with default configuration
 * Called during initialization if config table is empty
 */
export async function seedDefaultConfig(
  db: D1Database
): Promise<void> {
  const now = new Date().toISOString();

  // Clear existing config
  await db
    .prepare('DELETE FROM app_config')
    .run();

  // Flatten DEFAULT_CONFIG and insert
  const entries: Array<{
    key: string;
    value: string;
    type: string;
  }> = [];

  // Tax config
  entries.push(
    {
      key: 'tax_brackets',
      value: JSON.stringify(DEFAULT_CONFIG.taxConfig.taxBrackets),
      type: 'json',
    },
    {
      key: 'tax_zvw_rate',
      value: DEFAULT_CONFIG.taxConfig.zvwRate.toString(),
      type: 'number',
    },
    {
      key: 'tax_zelfstandigenaftrek',
      value: DEFAULT_CONFIG.taxConfig.zelfstandigenaftrek.toString(),
      type: 'number',
    },
    {
      key: 'tax_mkb_winstvrijstelling',
      value: DEFAULT_CONFIG.taxConfig.mkbWinstvrijstelling.toString(),
      type: 'number',
    },
    {
      key: 'tax_aow_rate',
      value: DEFAULT_CONFIG.taxConfig.aowRate.toString(),
      type: 'number',
    },
    {
      key: 'tax_uvw_rate',
      value: DEFAULT_CONFIG.taxConfig.uvwBaseRate.toString(),
      type: 'number',
    },
    {
      key: 'tax_arbeidskorting',
      value: JSON.stringify(DEFAULT_CONFIG.taxConfig.arbeidskorting),
      type: 'json',
    },
    {
      key: 'tax_general_credit',
      value: DEFAULT_CONFIG.taxConfig.generalTaxCredit.toString(),
      type: 'number',
    }
  );

  // Forecast config
  entries.push(
    {
      key: 'forecast_alpha',
      value: DEFAULT_CONFIG.forecastConfig.alpha.toString(),
      type: 'number',
    },
    {
      key: 'forecast_beta',
      value: DEFAULT_CONFIG.forecastConfig.beta.toString(),
      type: 'number',
    },
    {
      key: 'forecast_gamma',
      value: DEFAULT_CONFIG.forecastConfig.gamma.toString(),
      type: 'number',
    },
    {
      key: 'forecast_season_length',
      value: DEFAULT_CONFIG.forecastConfig.seasonLength.toString(),
      type: 'number',
    },
    {
      key: 'forecast_horizon_months',
      value: DEFAULT_CONFIG.forecastConfig.horizonMonths.toString(),
      type: 'number',
    },
    {
      key: 'forecast_confidence_width',
      value: DEFAULT_CONFIG.forecastConfig.confidenceWidth.toString(),
      type: 'number',
    }
  );

  // Scoring config
  entries.push(
    {
      key: 'score_hot_threshold',
      value: DEFAULT_CONFIG.scoringConfig.hotThreshold.toString(),
      type: 'number',
    },
    {
      key: 'score_warm_threshold',
      value: DEFAULT_CONFIG.scoringConfig.warmThreshold.toString(),
      type: 'number',
    },
    {
      key: 'score_monitor_threshold',
      value: DEFAULT_CONFIG.scoringConfig.monitorThreshold.toString(),
      type: 'number',
    },
    {
      key: 'score_weights',
      value: JSON.stringify(DEFAULT_CONFIG.scoringConfig.weights),
      type: 'json',
    },
    {
      key: 'score_time_decay',
      value: DEFAULT_CONFIG.scoringConfig.timeDecayFactor.toString(),
      type: 'number',
    },
    {
      key: 'score_confidence_risk',
      value: JSON.stringify(
        DEFAULT_CONFIG.scoringConfig.confidenceByRiskTolerance
      ),
      type: 'json',
    }
  );

  // App settings
  entries.push(
    {
      key: 'max_request_size',
      value: DEFAULT_CONFIG.appSettings.maxRequestSize.toString(),
      type: 'number',
    },
    {
      key: 'request_timeout_ms',
      value: DEFAULT_CONFIG.appSettings.requestTimeoutMs.toString(),
      type: 'number',
    },
    {
      key: 'cache_enabled',
      value: DEFAULT_CONFIG.appSettings.cacheEnabled.toString(),
      type: 'boolean',
    },
    {
      key: 'cache_ttl_seconds',
      value: DEFAULT_CONFIG.appSettings.cacheTtlSeconds.toString(),
      type: 'number',
    },
    {
      key: 'log_level',
      value: DEFAULT_CONFIG.appSettings.logLevel,
      type: 'string',
    },
    {
      key: 'agent_caching_enabled',
      value: DEFAULT_CONFIG.appSettings.agentCachingEnabled.toString(),
      type: 'boolean',
    },
    {
      key: 'max_concurrent_requests',
      value: DEFAULT_CONFIG.appSettings.maxConcurrentRequests.toString(),
      type: 'number',
    }
  );

  // Feature flags
  for (const [flag, enabled] of Object.entries(
    DEFAULT_CONFIG.featureFlags
  )) {
    entries.push({
      key: `feature_${flag}`,
      value: enabled.toString(),
      type: 'boolean',
    });
  }

  // Batch insert all entries
  const statements = entries.map(entry =>
    db
      .prepare(
        'INSERT INTO app_config (key, value, type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)'
      )
      .bind(entry.key, entry.value, entry.type, now, now)
  );

  await db.batch(statements);
}

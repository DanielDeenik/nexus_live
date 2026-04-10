/**
 * Forecast Engine
 * Implements Holt-Winters exponential smoothing, linear regression, and anomaly detection
 */

export interface MonthlyDataPoint {
  date: string;
  value: number;
}

export interface ForecastConfig {
  alpha: number; // Level smoothing (0-1)
  beta: number; // Trend smoothing (0-1)
  gamma: number; // Seasonality smoothing (0-1)
  seasonLength: number; // Period for seasonality (e.g., 12 for monthly)
  horizonMonths: number; // Number of months to forecast
  confidenceWidth: number; // Confidence interval width (0-1)
}

export interface ForecastResult {
  forecast: Array<{
    date: string;
    point: number;
    lower: number;
    upper: number;
  }>;
  trend: number;
  seasonality: number[];
  confidence: number;
  rmse: number;
}

export interface AnomalyResult {
  date: string;
  value: number;
  zscore: number;
  isAnomaly: boolean;
  severity: 'low' | 'medium' | 'high';
}

export interface TrendResult {
  slope: number;
  intercept: number;
  rSquared: number;
  predictions: Array<{
    period: number;
    value: number;
  }>;
}

/**
 * Holt-Winters Exponential Smoothing
 * Handles level, trend, and seasonality
 */
export function computeForecast(
  data: MonthlyDataPoint[],
  config: ForecastConfig
): ForecastResult {
  if (data.length < 2) {
    throw new Error('At least 2 data points required for forecast');
  }

  const values = data.map(d => d.value);
  const n = values.length;

  // Initialize level and trend
  let level = values[0];
  let trend = (values[1] - values[0]) / values[0] || 0;

  // Initialize seasonality
  const seasonality = Array(config.seasonLength).fill(1);
  if (n >= config.seasonLength) {
    const avgValue = values.reduce((a, b) => a + b) / n;
    for (let i = 0; i < config.seasonLength; i++) {
      seasonality[i] =
        values[i % n] / avgValue || 1;
    }
  }

  // Holt-Winters smoothing
  const smoothedValues: number[] = [];
  let currentLevel = level;
  let currentTrend = trend;
  const currentSeasonality = [...seasonality];

  for (let t = 0; t < n; t++) {
    const seasonIndex = t % config.seasonLength;
    const deseasonalized = values[t] / currentSeasonality[seasonIndex];

    // Update level
    const newLevel =
      config.alpha * deseasonalized +
      (1 - config.alpha) * (currentLevel + currentTrend);

    // Update trend
    const newTrend =
      config.beta * (newLevel - currentLevel) +
      (1 - config.beta) * currentTrend;

    // Update seasonality
    const newSeasonality =
      config.gamma * (values[t] / newLevel) +
      (1 - config.gamma) * currentSeasonality[seasonIndex];

    smoothedValues.push(
      newLevel *
        newSeasonality
    );

    currentLevel = newLevel;
    currentTrend = newTrend;
    currentSeasonality[seasonIndex] = newSeasonality;
  }

  // Generate forecast
  const forecast: ForecastResult['forecast'] = [];
  let forecastLevel = currentLevel;
  let forecastTrend = currentTrend;

  for (let h = 1; h <= config.horizonMonths; h++) {
    const seasonIndex = (n + h - 1) % config.seasonLength;
    const pointForecast =
      (forecastLevel + h * forecastTrend) *
      currentSeasonality[seasonIndex];

    // Calculate confidence interval
    const rmse = calculateRMSE(values, smoothedValues);
    const stdError = rmse * Math.sqrt(h);
    const zValue = 1.96; // 95% confidence

    forecast.push({
      date: new Date(
        new Date(data[n - 1].date).getTime() +
          h * 30 * 24 * 60 * 60 * 1000
      )
        .toISOString()
        .split('T')[0],
      point: Math.max(0, pointForecast),
      lower: Math.max(
        0,
        pointForecast - zValue * stdError * config.confidenceWidth
      ),
      upper:
        pointForecast + zValue * stdError * config.confidenceWidth,
    });
  }

  const rmse = calculateRMSE(values, smoothedValues);
  const confidence = Math.max(
    0.5,
    1 - rmse / (values.reduce((a, b) => a + b) / n)
  );

  return {
    forecast,
    trend: currentTrend,
    seasonality: currentSeasonality,
    confidence: Math.min(1, confidence),
    rmse,
  };
}

/**
 * Detect anomalies using Z-score method
 */
export function detectAnomalies(
  data: number[],
  threshold: number = 2.5
): AnomalyResult[] {
  if (data.length < 2) {
    return [];
  }

  // Calculate mean and standard deviation
  const mean = data.reduce((a, b) => a + b) / data.length;
  const variance =
    data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    data.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return [];
  }

  // Calculate Z-scores and identify anomalies
  return data.map((value, index) => {
    const zscore = (value - mean) / stdDev;
    const isAnomaly = Math.abs(zscore) > threshold;
    const absZ = Math.abs(zscore);

    let severity: 'low' | 'medium' | 'high' = 'low';
    if (absZ > threshold * 1.5) {
      severity = 'high';
    } else if (absZ > threshold) {
      severity = 'medium';
    }

    return {
      date: new Date(
        Date.now() - (data.length - index) * 30 * 24 * 60 * 60 * 1000
      )
        .toISOString()
        .split('T')[0],
      value,
      zscore,
      isAnomaly,
      severity,
    };
  });
}

/**
 * Linear regression for trend analysis
 */
export function linearRegression(data: number[]): TrendResult {
  if (data.length < 2) {
    throw new Error('At least 2 data points required for regression');
  }

  const n = data.length;
  const xValues = Array.from({ length: n }, (_, i) => i);

  // Calculate means
  const xMean = xValues.reduce((a, b) => a + b) / n;
  const yMean = data.reduce((a, b) => a + b) / n;

  // Calculate slope and intercept
  const numerator = xValues.reduce(
    (sum, x, i) => sum + (x - xMean) * (data[i] - yMean),
    0
  );
  const denominator = xValues.reduce(
    (sum, x) => sum + Math.pow(x - xMean, 2),
    0
  );

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  // Calculate R-squared
  const yPredicted = xValues.map(x => slope * x + intercept);
  const ssRes = data.reduce(
    (sum, y, i) => sum + Math.pow(y - yPredicted[i], 2),
    0
  );
  const ssTot = data.reduce(
    (sum, y) => sum + Math.pow(y - yMean, 2),
    0
  );
  const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  // Generate predictions
  const predictions = Array.from({ length: 12 }, (_, i) => ({
    period: i + 1,
    value: slope * (n + i) + intercept,
  }));

  return {
    slope,
    intercept,
    rSquared: Math.max(0, Math.min(1, rSquared)),
    predictions: predictions.map(p => ({
      ...p,
      value: Math.max(0, p.value),
    })),
  };
}

/**
 * Calculate Root Mean Square Error
 */
function calculateRMSE(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length);
  const sumSquaredError = Array.from({ length: n }, (_, i) =>
    Math.pow(actual[i] - predicted[i], 2)
  ).reduce((a, b) => a + b, 0);

  return Math.sqrt(sumSquaredError / n);
}

/**
 * Calculate moving average for smoothing
 */
export function movingAverage(
  data: number[],
  windowSize: number
): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(data.length, i + Math.ceil(windowSize / 2));
    const window = data.slice(start, end);
    const avg = window.reduce((a, b) => a + b) / window.length;
    result.push(avg);
  }
  return result;
}

/**
 * Calculate exponential moving average
 */
export function exponentialMovingAverage(
  data: number[],
  alpha: number
): number[] {
  if (data.length === 0) return [];

  const ema: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(
      alpha * data[i] + (1 - alpha) * ema[i - 1]
    );
  }
  return ema;
}

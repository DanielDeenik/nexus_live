-- Forecast page configuration.
--
-- The web Forecast page (apps/web/src/pages/Forecast.tsx, maths in
-- apps/web/src/lib/forecast.ts) reads these keys at runtime next to the
-- smoothing keys seeded in 20260810000004 (forecast.alpha, forecast.beta,
-- forecast.gamma, forecast.confidence_level, forecast.horizon_months,
-- forecast.history_months). Nothing here is personal financial data.
-- Insert only: an existing value Dan has changed is never overwritten.

insert into public.app_config (key, value, description) values
('forecast.seasonality_presets', '{
  "Asset Management":   [88, 90, 82, 70, 75, 65, 22, 18, 72, 85, 55, 20],
  "Investment Banking": [90, 88, 85, 72, 70, 60, 20, 15, 68, 88, 60, 15],
  "Banking":            [82, 84, 78, 72, 70, 62, 28, 22, 70, 80, 58, 25],
  "FinTech":            [78, 82, 80, 78, 76, 70, 45, 40, 72, 80, 62, 30],
  "Insurance":          [80, 82, 76, 70, 72, 65, 30, 28, 68, 78, 60, 35],
  "Accounting & Audit": [85, 88, 92, 80, 70, 58, 25, 22, 65, 75, 68, 30],
  "Risk & Compliance":  [82, 84, 80, 78, 72, 65, 30, 25, 72, 80, 62, 28],
  "Technology":         [80, 82, 82, 78, 78, 72, 50, 45, 76, 82, 68, 38],
  "Data & Analytics":   [78, 80, 82, 78, 76, 68, 42, 38, 74, 80, 64, 32],
  "Consulting":         [82, 84, 80, 76, 74, 65, 30, 28, 72, 80, 62, 28],
  "Real Estate":        [68, 72, 82, 86, 84, 80, 60, 55, 80, 78, 62, 40],
  "Healthcare":         [75, 78, 76, 72, 70, 68, 55, 50, 72, 76, 65, 55],
  "Energy":             [72, 74, 78, 80, 78, 72, 45, 42, 76, 78, 62, 38],
  "Payments":           [76, 80, 80, 78, 76, 70, 45, 42, 74, 80, 64, 35],
  "Wealth Management":  [86, 88, 82, 72, 74, 62, 22, 18, 70, 84, 56, 20],
  "default":            [78, 80, 80, 76, 74, 66, 35, 32, 70, 78, 58, 30]
}', 'Consulting demand index per industry, January to December, 0 to 100 (presets from the old seasonality engine)'),
('forecast.industry', 'Asset Management', 'Industry whose demand season shapes the income forecast; the page can compare others'),
('forecast.seasonality_weight', '1.0', 'How strongly the market season shapes the projection: 0 none, 1 the full pattern'),
('forecast.daily_hours', '10', 'Billable hours per working day assumed for the rest of the year'),
('forecast.work_calendar', '{
  "region": "CA-ON",
  "weekdays": [1, 2, 3, 4, 5],
  "non_working_dates": [
    {"date": "2026-10-12", "name": "Thanksgiving"},
    {"date": "2026-12-25", "name": "Christmas Day"},
    {"date": "2026-12-28", "name": "Boxing Day (observed)"},
    {"date": "2027-01-01", "name": "New Year''s Day"},
    {"date": "2027-02-15", "name": "Family Day"},
    {"date": "2027-04-02", "name": "Good Friday"},
    {"date": "2027-05-24", "name": "Victoria Day"},
    {"date": "2027-07-01", "name": "Canada Day"},
    {"date": "2027-08-02", "name": "Civic Holiday"},
    {"date": "2027-09-06", "name": "Labour Day"},
    {"date": "2027-10-11", "name": "Thanksgiving"},
    {"date": "2027-12-27", "name": "Christmas Day (observed)"},
    {"date": "2027-12-28", "name": "Boxing Day (observed)"}
  ]
}', 'Client work calendar for the hours projection: ISO weekdays worked (1 Monday) and days off'),
('forecast.min_model_months', '3', 'Below this many months of income the forecast is a flat run-rate'),
('forecast.anomaly_z_threshold', '2.0', 'A month is unusual when its deseasonalised income is this many standard deviations from the mean'),
('forecast.peak_slow_count', '3', 'How many peak and slow months the seasonality panel names')
on conflict (key) do nothing;

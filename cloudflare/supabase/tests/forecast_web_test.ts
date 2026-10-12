// Checks for the web Forecast maths (apps/web/src/lib/forecast.ts), which is
// pure and runs here unchanged. All figures are synthetic.
// Run: deno test supabase/tests/forecast_web_test.ts --allow-read
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  CONFIG_KEYS, type ForecastConfig, type ForecastInvoice,
  addMonths, anomalyDetect, configFromRows, forecastIncome, holtDouble, holtWinters, invoicedHours,
  latestEurPerHour, monthlyIncome, presetFor, probit, projectHours, seasonalFactors, topMonths,
  workingDaysBetween, zFor,
} from "../../apps/web/src/lib/forecast.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

// Config as the migrations seed it, built from synthetic values here.
const PRESETS = {
  "Asset Management": [88, 90, 82, 70, 75, 65, 22, 18, 72, 85, 55, 20],
  default: [78, 80, 80, 76, 74, 66, 35, 32, 70, 78, 58, 30],
};
const rows = [
  { key: "forecast.alpha", value: "0.3" },
  { key: "forecast.beta", value: "0.1" },
  { key: "forecast.gamma", value: "0.3" },
  { key: "forecast.confidence_level", value: "0.95" },
  { key: "forecast.horizon_months", value: "12" },
  { key: "forecast.history_months", value: "24" },
  { key: "forecast.min_model_months", value: "3" },
  { key: "forecast.anomaly_z_threshold", value: "2.0" },
  { key: "forecast.peak_slow_count", value: "3" },
  { key: "forecast.seasonality_presets", value: JSON.stringify(PRESETS) },
  { key: "forecast.industry", value: "Asset Management" },
  { key: "forecast.seasonality_weight", value: "1.0" },
  { key: "forecast.daily_hours", value: "8" },
  {
    key: "forecast.work_calendar",
    value: JSON.stringify({ weekdays: [1, 2, 3, 4, 5], non_working_dates: [{ date: "2030-12-25", name: "Christmas" }] }),
  },
];
const cfg: ForecastConfig = configFromRows(rows);

Deno.test("every config key the page reads is seeded by a migration", async () => {
  let sql = "";
  for await (const f of Deno.readDir(MIGRATIONS)) {
    if (f.name.endsWith(".sql")) sql += await Deno.readTextFile(new URL(f.name, MIGRATIONS));
  }
  for (const k of Object.values(CONFIG_KEYS)) assert(sql.includes(`'${k}'`), `${k} is not seeded`);
});

Deno.test("config: parses JSON and bare strings, fails on a missing key", () => {
  assertEquals(cfg.industry, "Asset Management");
  assertEquals(cfg.horizonMonths, 12);
  assertEquals(cfg.workCalendar.weekdays, [1, 2, 3, 4, 5]);
  assertThrows(() => configFromRows(rows.filter((r) => r.key !== "forecast.daily_hours")), Error, "forecast.daily_hours");
});

Deno.test("z for a confidence level", () => {
  assertAlmostEquals(zFor(0.95), 1.95996, 1e-4);
  assertAlmostEquals(zFor(0.8), 1.28155, 1e-4);
  assertAlmostEquals(probit(0.5), 0, 1e-9);
  assertAlmostEquals(probit(0.001), -3.09023, 1e-4);
});

Deno.test("Holt double follows a straight line exactly", () => {
  const s = holtDouble([10, 20, 30, 40, 50], { alpha: 0.3, beta: 0.1, h: 3, z: 2 });
  assertEquals(s.forecast.map((v) => Math.round(v)), [60, 70, 80]);
  assertAlmostEquals(s.sigma, 0, 1e-9);
});

Deno.test("Holt-Winters reproduces a pure seasonal pattern", () => {
  const season = [5, 3, 0, -2, -4, -6, -4, -2, 0, 2, 4, 4];
  const series = Array.from({ length: 36 }, (_, t) => 100 + season[t % 12]);
  const s = holtWinters(series, { alpha: 0.3, beta: 0.1, gamma: 0.3, m: 12, h: 12, z: 2 });
  assertEquals(s.type, "holt-winters");
  s.forecast.forEach((f, k) => assertAlmostEquals(f, 100 + season[k], 1e-6));
  // Fewer than two seasons falls back to Holt double.
  assertEquals(holtWinters(series.slice(0, 20), { alpha: 0.3, beta: 0.1, gamma: 0.3, m: 12, h: 1, z: 2 }).type, "holt-double");
});

Deno.test("anomalies beyond the threshold", () => {
  const r = anomalyDetect([10, 10, 10, 10, 10, 10, 10, 10, 10, 50], 2);
  assertEquals(r.anomalies.map((a) => a.idx), [9]);
  assertEquals(anomalyDetect([1, 2], 2).anomalies, []);
});

Deno.test("seasonal factors average 1 and the weight flattens them", () => {
  const f = seasonalFactors(PRESETS["Asset Management"], 1);
  assertAlmostEquals(f.reduce((s, v) => s + v, 0) / 12, 1, 1e-12);
  assert(f[1] > 1 && f[7] < 1);
  assertEquals(seasonalFactors(PRESETS["Asset Management"], 0), Array(12).fill(1));
  // Clamped: a weight above 1 acts as 1, so no factor goes negative.
  assertEquals(seasonalFactors(PRESETS["Asset Management"], 5), f);
  assertEquals(presetFor(cfg, "Unknown"), PRESETS.default);
});

Deno.test("peak and slow months", () => {
  assertEquals(topMonths(PRESETS["Asset Management"], 3, true), [1, 0, 9]);
  assertEquals(topMonths(PRESETS["Asset Management"], 3, false), [7, 11, 6]);
});

Deno.test("working days skip weekends and the calendar's days off", () => {
  // 2030-12-23 is a Monday; the 25th is a day off; 28 and 29 are a weekend.
  const r = workingDaysBetween("2030-12-23", "2030-12-31", cfg.workCalendar);
  assertEquals(r.days, 6);
  assertEquals(r.holidays.map((h) => h.date), ["2030-12-25"]);
  assertEquals(addMonths("2030-11", 3), "2031-02");
  assertEquals(addMonths("2030-01", -1), "2029-12");
});

const inv = (id: string, client: string, start: string | null, end: string | null, hours: number | null, eur: number | null, extra: Partial<ForecastInvoice> = {}): ForecastInvoice => ({
  id, client, amount_eur: eur, hours, issued_date: end ?? "2030-01-31", period_start: start, period_end: end, voided_at: null, duplicate_of: null, ...extra,
});

Deno.test("income and hours follow the dedupe rules", () => {
  const invoices = [
    inv("a", "Client A", "2030-01-01", "2030-01-31", 100, 1000),
    inv("b", "Client A", "2030-01-01", "2030-01-31", 120, 1200), // same period, more hours: kept for hours
    inv("c", "Client A", "2030-02-01", "2030-02-28", 80, 800, { voided_at: "2030-03-01" }),
    inv("d", "Client A", "2030-02-01", "2030-02-28", 90, 900, { duplicate_of: "x" }),
    inv("e", "Client B", "2030-03-01", "2030-03-31", 50, null),
    inv("f", "Client B", "2029-12-01", "2029-12-31", 40, 400),
  ];
  const inc = monthlyIncome(invoices);
  assertEquals(inc.byMonth.get("2030-01"), 2200); // income only drops void and linked duplicates
  assertEquals(inc.byMonth.has("2030-02"), false);
  assertEquals(inc.pendingEur, 1);
  const h = invoicedHours(invoices, "2030-01-01", "2031-01-01");
  assertEquals(h.total, 170);
  assertEquals(h.lastPeriodEnd, "2030-03-31");
  assertEquals(latestEurPerHour(invoices), 10);
});

Deno.test("forecast picks run-rate, seasonal Holt or Holt-Winters by history", () => {
  const two = new Map([["2030-01", 1000], ["2030-02", 1000]]);
  const r = forecastIncome(two, Array(12).fill(1), cfg);
  assertEquals(r.method, "run-rate");
  assertEquals(r.points.filter((p) => p.forecast != null).length, 12);
  assertEquals(r.points.at(-1)!.forecast, 1000);

  // A flat income seasonalised by the market pattern comes back to the pattern.
  const f = seasonalFactors(PRESETS["Asset Management"], 1);
  const six = new Map(["2030-01", "2030-02", "2030-03", "2030-04", "2030-05", "2030-06"].map((m, i) => [m, 1000 * f[i]]));
  const s = forecastIncome(six, f, cfg);
  assertEquals(s.method, "holt-seasonal");
  assertEquals(s.points[6].month, "2030-07");
  assertAlmostEquals(s.points[6].forecast!, 1000 * f[6], 1e-6);
  assert(s.points.every((p) => p.lower == null || (p.lower >= 0 && p.lower <= p.forecast! && p.upper! >= p.forecast!)));

  const long = new Map(Array.from({ length: 30 }, (_, i) => [addMonths("2028-01", i), 1000 + (i % 12) * 10] as [string, number]));
  const w = forecastIncome(long, f, cfg);
  assertEquals(w.method, "holt-winters");
  assertEquals(w.historyUsed, 24);
  assertEquals(forecastIncome(new Map(), f, cfg).method, "none");
});

Deno.test("hours projection: logged time covers up to today, the calendar the rest", () => {
  const base = { today: "2030-12-20", yearEnd: "2030-12-31", yearStart: "2030-01-01", invoicedYtd: 1000, lastPeriodEnd: "2030-11-30", cfg };
  const logged = projectHours({ ...base, loggedUnbilled: 100 });
  assertEquals(logged.capacityFrom, "2030-12-21");
  assertEquals(logged.remainingDays, 6); // 23, 24, 26, 27, 30, 31
  assertEquals(logged.projected, 1000 + 100 + 6 * 8);
  const none = projectHours({ ...base, loggedUnbilled: 0 });
  assertEquals(none.capacityFrom, "2030-12-01");
  assertEquals(none.remainingDays, 21);
  assertEquals(none.projected, 1000 + 21 * 8);
});

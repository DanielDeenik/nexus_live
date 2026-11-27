// A made-up household for the glance and look-through tests (invented accounts,
// shops and figures) in an in-memory Postgres, built from the schema cut, the real
// nx_money_summary and the glance migration. Every date is set from today, so the
// tests read the same on any day.
import { PGlite } from "npm:@electric-sql/pglite@0.6.0";

const here = new URL("../../", import.meta.url);
export const read = (path: string) => Deno.readTextFileSync(new URL(path, here));
export const U = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";

// nx_money_summary as its own migration defines it, so the test runs the real one.
export function moneySummarySql(): string {
  const sql = read("../migrations/20261124000001_live_forecast.sql");
  const hit = sql.match(/create or replace function public\.nx_money_summary\(\)[\s\S]*?\$function\$;/);
  if (!hit) throw new Error("nx_money_summary not found in its migration");
  return hit[0];
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const today = new Date(iso(new Date()) + "T00:00:00Z");
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export const monthStart = (d: Date, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
export const M = monthStart(today);
export const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
const yearStart = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
export const year = today.getUTCFullYear();
const ym = iso(today).slice(0, 7);

const forecast = {
  year, hours_per_day: 8,
  rate: { unit_rate: 100, currency: "CAD", fx_eur: 0.5, eur_per_hour: 50, invoice_number: "T-2" },
  marginal: { revenue: 0.4, cost: 0.4 },
  billed: { hours: 100, through: iso(addDays(M, -1)), revenue_eur: 5000, invoices: 2 },
  remaining: { revenue_eur: 8000 },
  to_date: { revenue_eur: 5000, to_pay: 1500 },
  year_end: { to_pay: 16000, hours: 260 },
  timeline: { file_before: `${year + 1}-05-01`, interest_from: `${year + 1}-07-01`, interest_rate: 0.05 },
  months: [{ month: ym, status: "projected", hours: 160, revenue_eur: 8000, invoice_date: iso(monthEnd), payment_date: iso(addDays(monthEnd, 45)) }],
  next_year: {
    year: year + 1, indicative: true,
    figures: { revenue_eur: 96000, to_pay: 36000, costs_eur: 6000, hours: 1920 },
    structures: { results: [{ label: "eenmanszaak", net_to_you_eur: 54000 }, { label: "bv_payout", net_to_you_eur: 57600 }] },
  },
};

export async function household(reserve = 15000): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(read("fixtures/glance/schema.sql"));
  await db.exec(moneySummarySql());
  await db.exec(`insert into app_config (key, value) values
    ('budget.average_months', '3'),
    ('budget.spend_classes', '["fixed", "variable", "discretionary"]'),
    ('budget.planned_classes', '["discretionary"]'),
    ('review.weekly', '{"weekday": 1, "hour": 10, "minute": 0}')`);
  await db.exec(read("../migrations/20261127000001_glance.sql"));
  await db.query("insert into profiles (id, email) values ($1, 'one@example.test'), ($2, 'two@example.test')", [U, OTHER]);
  await db.query("insert into nx_user_settings (user_id, key, value) values ($1, 'invest.monthly_target_eur', '3500')", [U]);
  await db.query(`insert into nx_accounts (user_id, source, account, label, kind, opening_date, opening_balance) values
    ($1, 'bank', 'CUR', 'Current', 'current', $2, 10000),
    ($1, 'bank', 'SAV', 'Savings', 'savings', $2, 20000),
    ($1, 'card', 'CRD', 'Card (owed)', 'card', $2, -500)`, [U, iso(yearStart)]);
  // Three full months of the same spending, then this month so far.
  for (const back of [3, 2, 1]) {
    const day = iso(addDays(monthStart(today, back), 4));
    await db.query(`insert into nx_transactions (user_id, source, account, booked_on, amount, merchant, category, class) values
      ($1, 'bank', 'CUR', $2, -1000, 'Landlord', 'Rent', 'fixed'),
      ($1, 'bank', 'CUR', $2, -300, 'Greengrocer', 'Groceries', 'variable'),
      ($1, 'bank', 'CUR', $2, -950, 'Gadgetshop', 'Shopping', 'discretionary'),
      ($1, 'bank', 'CUR', $2, 50, 'Gadgetshop', 'Shopping', 'discretionary')`, [U, day]);
  }
  await db.query(`insert into nx_transactions (user_id, source, account, booked_on, amount, merchant, category, class) values
    ($1, 'bank', 'CUR', $2, -200, 'Gadgetshop', 'Shopping', 'discretionary'),
    ($1, 'bank', 'CUR', $2, -500, 'Broker', 'Investing', 'investing'),
    ($1, 'bank', 'CUR', $3, -10, 'Bookworld', 'Shopping', 'discretionary')`, [U, iso(M), iso(today)]);
  // Someone else's line must never show up.
  await db.query("insert into nx_transactions (user_id, source, account, booked_on, amount, category, class) values ($1, 'bank', 'X', $2, -9999, 'Shopping', 'discretionary')", [OTHER, iso(M)]);
  await db.query(`insert into nx_budgets (user_id, category, monthly_amount, currency, valid_from) values
    ($1, 'Rent', 1000, 'EUR', $2), ($1, 'Groceries', 300, 'EUR', $2), ($1, 'Shopping', 400, 'EUR', $2), ($1, 'Software', 250, 'EUR', $2)`, [U, iso(yearStart)]);
  await db.query(`insert into nx_category_rules (user_id, priority, category, class) values
    ($1, 1, 'Rent', 'fixed'), ($1, 2, 'Groceries', 'variable'), ($1, 3, 'Shopping', 'discretionary'), ($1, 4, 'Software', 'business')`, [U]);
  await db.query("insert into nx_tax_forecast_live (user_id, year, reserve_eur, figures) values ($1, $2, $3, $4)", [U, year, reserve, JSON.stringify(forecast)]);
  await db.query(`insert into invoices (user_id, client, amount, currency, status, issued_date, due_date, paid_date, invoice_number, hours, unit_rate, period_start, fx_rate_eur, amount_eur) values
    ($1, 'Client Co', 6000, 'CAD', 'paid', $2, $3, $4, 'T-1', 60, 100, $5, 0.5, 3000),
    ($1, 'Client Co', 4000, 'CAD', 'pending', $6, $7, null, 'T-2', 40, 100, $8, 0.5, 2000)`,
    [U, iso(addDays(M, -40)), iso(addDays(M, -10)), iso(addDays(M, -8)), iso(monthStart(today, 2)),
      iso(addDays(M, -1)), iso(addDays(today, 10)), iso(monthStart(today, 1))]);
  await db.query("insert into integration_connections (user_id, provider, cursor, status) values ($1, 'etoro', $2, 'active')", [U, JSON.stringify({ credit_usd: 1000, as_of: new Date().toISOString() })]);
  await db.query("insert into nx_positions (user_id, source, external_id, value, currency) values ($1, 'etoro', 'p1', 500, 'USD')", [U]);
  await db.query(`insert into kv_cache (key, value) values ('fx:USD:2020-01-02', '{"rate": 0.5, "date": "2020-01-02"}'), ('fx:USD:2020-06-01', '{"rate": 0.9, "date": "2020-06-01"}')`);
  await db.query("insert into dt_time_entries (user_id, entry_date, minutes) values ($1, $2, 480)", [U, iso(addDays(M, -3))]);
  await db.query(`insert into rec_roles (user_id, title, tier) values ($1, 'A', 'HOT'), ($1, 'B', 'HOT'), ($1, 'C', 'WARM'), ($1, 'D', 'MONITOR'), ($1, 'E', 'MONITOR')`, [U]);
  await db.query(`insert into nx_recurring (user_id, key, label, cadence, amount, per_year, next_due, ends_on, call, proposed_call) values
    ($1, 'rent', 'Landlord', 'monthly', 1000, 12000, $2, null, null, null),
    ($1, 'stream', 'Streamhouse', 'monthly', 12.5, 150, $3, null, 'cancel', null),
    ($1, 'gym', 'Gymbox', 'weekly', 10, 520, $4, null, null, 'cancel'),
    ($1, 'old', 'Old club', 'monthly', 40, 480, $2, $5, null, null),
    ($1, 'phone', 'Phoneco', 'monthly', 20, 240, $6, null, null, null)`,
    [U, iso(addDays(today, 3)), iso(addDays(today, 5)), iso(addDays(today, 1)), iso(addDays(today, -1)), iso(addDays(today, -4))]);
  // The rules started in the middle of last month.
  await db.query(`insert into nx_decisions (user_id, kind, area, if_condition, then_action, created_at) values
    ($1, 'rule', 'Purchases', 'a purchase would push safe-to-spend below zero once the tax reserve is set aside', 'I do not buy it', $2)`,
    [U, iso(addDays(monthStart(today, 1), 14)) + "T12:00:00Z"]);
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [U]);
  return db;
}

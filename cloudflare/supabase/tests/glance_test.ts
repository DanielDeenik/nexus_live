// The glance functions on a made-up household (invented accounts, shops and
// figures), in an in-memory Postgres: what you hold and owe, an average month
// of next year, what is slipping and in which order, the next action, the days
// until the next payment, the renegotiation answer and who may call what.
// Every date is set from today, so the test reads the same on any day.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.6.0";
import { addDays, household, iso, monthEnd, monthStart, moneySummarySql, read, today, year } from "./fixtures/glance/household.ts";

// deno-lint-ignore no-explicit-any
type Json = any;
const one = async (db: PGlite, sql: string): Promise<Json> => (await db.query<{ j: Json }>(`select (${sql}) as j`)).rows[0].j;

Deno.test("money is worded the same everywhere", async () => {
  const db = new PGlite();
  await db.exec(read("fixtures/glance/schema.sql"));
  await db.exec(moneySummarySql());
  await db.exec(read("../migrations/20261127000001_glance.sql"));
  assertEquals(await one(db, "nx_fmt_eur(-19635.86)"), "−€19,636");
  assertEquals(await one(db, "nx_fmt_eur(22879.05, 2)"), "€22,879.05");
  assertEquals(await one(db, "nx_fmt_eur(0)"), "€0");
  assertEquals(await one(db, "nx_fmt_num(185)"), "185");
  assertEquals(await one(db, "nx_fmt_num(211.50)"), "211.5");
  assertEquals(await one(db, "nx_fmt_num(1920)"), "1,920");
  await db.close();
});

Deno.test("what you hold: cash, what you are owed and the broker at the newest rate, less tax", async () => {
  const db = await household();
  const look = await one(db, "nx_look()");
  const hold = look.facts.hold;
  // Current 10000 - 3 x 2200 - 200 - 500 - 10 = 2690; savings 20000; card -500.
  assertEquals(hold.cash, 22190);
  assertEquals(hold.receivable, 2000);
  // 1000 cash and a 500 position in dollars, at the newest cached rate of 0.9.
  assertEquals(hold.investments, 1350);
  assertEquals(hold.investment_rows[0].rate_date, "2020-06-01");
  assertEquals(hold.hold, 25540);
  assertEquals(hold.yours, 10540);
  // Fixed budget of 1000 still to leave this month.
  assertEquals(hold.safe_to_spend, 6190);
  const t = look.glance.today;
  assertEquals(t.slices.map((s: Json) => [s.key, s.amount]), [["tax", 15000], ["yours", 10540]]);
  assertEquals(t.caption, "yours, after tax");
  assertEquals(look.glance.review.snapshot, { cash: 24190, investments: 1350, liabilities: 15000, total: 10540, currency: "EUR" });
  await db.close();
});

Deno.test("an average month of next year, as now and on budget", async () => {
  const db = await household();
  const look = await one(db, "nx_look()");
  const m = look.facts.month;
  assertEquals([m.billed, m.tax, m.business, m.net, m.hours], [8000, 3000, 500, 4500, 160]);
  // Three months of 1000 + 300 + 900 after the refund; the plan is 1000 + 300 + 400. A business budget is not living.
  assertEquals([m.living_now, m.living_budget], [2200, 1700]);
  assertEquals([m.left_now, m.left_budget, m.short_now, m.short_budget], [2300, 2800, 1200, 700]);
  assertEquals(look.facts.spend.classes, { fixed: 1000, variable: 300, discretionary: 900 });
  assertEquals(look.facts.spend.categories.map((c: Json) => [c.category, c.budget, c.avg, c.mtd]),
    [["Rent", 1000, 1000, 0], ["Shopping", 400, 900, 210], ["Groceries", 300, 300, 0]]);
  const v = look.glance.month;
  assertEquals(v.now.line, "€1,200 short of your €3,500 target.");
  assertEquals(v.budget.line, "€700 short of your €3,500 target.");
  await db.close();
});

Deno.test("renegotiate: the rate that closes the plan, the levers and the runway", async () => {
  const db = await household();
  const look = await one(db, "nx_look()");
  const a = look.facts.assignment;
  // One more dollar an hour: 160 hours, 60% kept, at 0.5 = 48 a month.
  assertEquals(a.per_unit, 48);
  assertEquals([a.rate_budget, a.rate_now], [114.58, 125]);
  assertEquals([a.lever_spend, a.lever_day, a.lever_bv], [500, 240, 300]);
  // 25540 held + 8000 still to bill - 16000 tax at year end.
  assertEquals(a.pot, 17540);
  assertEquals([a.runway_now, a.runway_budget], [8, 10.3]);
  // Only this calendar year's invoices are listed.
  const listed = [["T-1", "paid", 32, 2, monthStart(today, 2)], ["T-2", "pending", null, null, monthStart(today, 1)]]
    .filter((x) => (x[4] as Date).getUTCFullYear() === year).map((x) => x.slice(0, 4));
  assertEquals(a.invoices.map((i: Json) => [i.number, i.status, i.lag_days, i.late_days]), listed);
  const v = look.glance.assignment;
  assertEquals([v.question, v.answer], [`Renegotiate for ${year + 1}?`, "Yes"]);
  assertEquals(v.reason, "On these terms your plan is short €700 a month, even on budget.");
  assertEquals(v.tiles.map((t: Json) => t.value), ["CAD 100", "CAD 115", "8.0 mo"]);
  assertEquals(v.tiles[1].label, "closes the plan on budget");
  assertEquals(v.end_date, null);
  await db.close();
});

Deno.test("slipping: only what is off plan, in a fixed order, and the next action is the nearest date", async () => {
  const db = await household();
  const g = await one(db, "nx_glance()");
  const keys = g.slipping.items.map((i: Json) => i.key);
  assertEquals(keys, ["discretionary", "investing", "living", "hours", "snapshot", "month_close", "alternatives", "cancel:stream"]);
  assertEquals(g.today.slipping_count, 8);
  assertEquals(g.slipping.shown, 3);
  const by = Object.fromEntries(g.slipping.items.map((i: Json) => [i.key, i]));
  assertEquals(by.discretionary.now, "225% of budget");
  assertEquals(by.discretionary.short, "€900 a month against €400.");
  assertEquals(by.investing.now, "14% of target");
  assertEquals(by.living.now, "129% of budget");
  assertEquals(by.hours.now, "0 logged");
  assertEquals(by.hours.due, iso(monthEnd));
  assertEquals(by.alternatives.short, "5 roles tracked, 2 hot.");
  assertEquals(by["cancel:stream"].now, "€12.50");
  assertEquals(by["cancel:stream"].due, iso(addDays(today, 5)));
  // The review is due on the next Sunday, today included.
  const sunday = addDays(today, (7 - today.getUTCDay()) % 7);
  assertEquals(by.snapshot.due, iso(sunday));
  const dated = [by.hours, by.snapshot, by["cancel:stream"]].sort((x, y) => x.due < y.due ? -1 : x.due > y.due ? 1 : keys.indexOf(x.key) - keys.indexOf(y.key));
  assertEquals(g.today.next.key, dated[0].key);
  // Since the rules started: 210 over at least two weeks, against 950 in the month before them.
  assertEquals(g.slipping.better.map((x: Json) => x.key), ["purchases"]);
  assert(/^€\d+ a day since \d+ \w{3}\. \w+ was €3\d a day\.$/.test(g.slipping.better[0].detail), g.slipping.better[0].detail);
  await db.close();
});

Deno.test("below zero, safe to spend leads and your own rule is quoted", async () => {
  const db = await household(30000);
  const g = await one(db, "nx_glance()");
  const first = g.slipping.items[0];
  assertEquals([first.key, first.now], ["safe_to_spend", "−€8,810"]);
  assertEquals(first.short, "Your rule: I do not buy it.");
  // The ring never shows more tax than there is money, and yours never below nothing.
  assertEquals(g.today.yours, -4460);
  assertEquals(g.today.slices.map((s: Json) => s.amount), [25540, 0]);
  await db.close();
});

Deno.test("until the next payment: charges day by day, weekly ones repeat, ended ones are left out", async () => {
  const db = await household();
  const c = (await one(db, "nx_look()")).facts.calendar;
  assertEquals(c.start, 2690);
  assertEquals(c.until, iso(addDays(today, 10)));
  assertEquals(c.days.map((d: Json) => [d.date, d.balance]), [
    [iso(addDays(today, 1)), 2680], [iso(addDays(today, 3)), 1680], [iso(addDays(today, 5)), 1667.5],
    [iso(addDays(today, 8)), 1657.5], [iso(addDays(today, 10)), 3657.5]]);
  assertEquals(c.days[4].items[0], { label: "T-2", amount: 2000, payment: true });
  assertEquals([c.first_negative, c.low, c.low_date], [null, 1657.5, iso(addDays(today, 8))]);
  const r = (await one(db, "nx_look()")).facts.recurring;
  assertEquals(r.count, 4);
  assertEquals(r.per_year, 12910);
  assertEquals(r.rows.find((x: Json) => x.key === "phone").overdue, true);
  await db.close();
});

Deno.test("without a forecast the hold still shows and the plan screens stay empty", async () => {
  const db = await household();
  await db.exec("delete from nx_tax_forecast_live");
  const g = await one(db, "nx_glance()");
  assertEquals(g.month, null);
  assertEquals(g.assignment, null);
  assertEquals(g.today.hold, 25540);
  assert(!g.slipping.items.some((i: Json) => i.key === "hours" || i.key === "alternatives"));
  await db.close();
});

Deno.test("the end date is the one thing you write: first from the newest invoice, then in place", async () => {
  const db = await household();
  const end = iso(addDays(today, 200));
  await db.query("select nx_set_assignment_end($1)", [end]);
  const row = (await db.query<Json>("select client, rate, currency, rate_type, start_date::text, end_date::text, status from contracts")).rows;
  assertEquals(row, [{ client: "Client Co", rate: "100", currency: "CAD", rate_type: "hourly", start_date: iso(monthStart(today, 2)), end_date: end, status: "active" }]);
  const later = iso(addDays(today, 230));
  await db.query("select nx_set_assignment_end($1)", [later]);
  assertEquals((await db.query<Json>("select count(*)::int as n, max(end_date)::text as e from contracts")).rows[0], { n: 1, e: later });
  const v = (await one(db, "nx_glance()")).assignment;
  assertEquals(v.end_date, later);
  assert(v.end_line.endsWith(", in 230 days."));
  await db.close();
});

Deno.test("signed out nothing answers, and only the three entry points are open to the app", async () => {
  const db = await household();
  const can = async (role: string, fn: string) => (await db.query<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).rows[0].ok;
  for (const fn of ["nx_glance()", "nx_look()", "nx_set_assignment_end(date)"]) {
    assertEquals(await can("authenticated", fn), true, fn);
    assertEquals(await can("anon", fn), false, fn);
  }
  for (const fn of ["nx_glance_facts()", "nx_glance_view(jsonb)", "nx_fx_latest(text)"]) {
    assertEquals(await can("authenticated", fn), false, fn);
    assertEquals(await can("anon", fn), false, fn);
  }
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await assertRejects(() => db.query("select nx_glance()"), Error, "not signed in");
  await assertRejects(() => db.query("select nx_set_assignment_end(current_date)"), Error, "not signed in");
  await db.close();
});

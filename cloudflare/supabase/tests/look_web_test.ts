// The web look-through (apps/web/src/lib/look.ts) on the answer of the real
// nx_look(), from the same made-up household as glance_test.ts. This is the
// contract between the database and the page: if a key the page reads is renamed
// in the function, a table here comes out wrong.
// Run: deno test --allow-read supabase/tests/look_web_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addDays, household, iso, today, year } from "./fixtures/glance/household.ts";
import { type Look, SLICE_TOPIC, day, dayShort, eur0, eur2, monthName, rings, topics } from "../../apps/web/src/lib/look.ts";

async function look(reserve?: number, change?: string): Promise<Look> {
  const db = await household(reserve);
  if (change) await db.exec(change);
  const out = (await db.query<{ j: Look }>("select nx_look() as j")).rows[0].j;
  await db.close();
  return out;
}
const month = monthName(iso(today));

Deno.test("money and days read as the database words them", () => {
  assertEquals(eur0(-19635.86), "−€19,636");
  assertEquals(eur0(-0.4), "€0");
  assertEquals(eur0(-1342.5), "−€1,343");
  assertEquals(eur2(22879.05), "€22,879.05");
  assertEquals(eur2(-2917.61), "−€2,917.61");
  assertEquals(day("2026-12-15", "2026-11-27"), "Tue 15 Dec");
  assertEquals(day("2027-01-15", "2026-11-27"), "Fri 15 Jan 2027");
  assertEquals(dayShort("2026-11-09T07:12:26+00:00", "2026-11-27"), "9 Nov");
});

Deno.test("the rings: every slice is a fact, and a month adds up to what is billed", async () => {
  const l = await look();
  const now = rings(l, "now");
  assertEquals(now.map((r) => r.key), ["yours", "month", "living"]);
  assertEquals([now[0].centre, now[0].caption], ["€10,540", "yours, after tax"]);
  assertEquals(now[0].slices.map((s) => [s.key, s.amount]), [["tax", 15000], ["yours", 10540]]);
  assertEquals(now[1].title, `An average month in ${year + 1}`);
  assertEquals(now[1].slices.map((s) => [s.key, s.amount]), [["tax", 3000], ["business", 500], ["living", 2200], ["left", 2300]]);
  assertEquals(now[1].slices.reduce((sum, s) => sum + s.amount, 0), l.facts.month!.billed);
  assertEquals([now[1].centre, now[1].caption], ["€2,300", "left to invest"]);
  const budget = rings(l, "budget")[1];
  assertEquals(budget.slices.map((s) => s.amount), [3000, 500, 1700, 2800]);
  assertEquals(now[2].slices.map((s) => [s.key, s.amount]), [["discretionary", 900], ["fixed", 1000], ["variable", 300], ["other", 0]]);
  assertEquals(now[2].centre, "€2,200");
  // Every slice opens a table that exists.
  const keys = topics(l).map((t) => t.key);
  for (const r of now) for (const s of r.slices) assert(keys.includes(SLICE_TOPIC[`${r.key}:${s.key}`]), `${r.key}:${s.key}`);
});

Deno.test("the tables: eight views, each row from the facts", async () => {
  const l = await look();
  const t = Object.fromEntries(topics(l).map((x) => [x.key, x]));
  assertEquals(Object.keys(t), ["hold", "tax", "living", "levers", "slipping", "assignment", "calendar", "recurring"]);
  for (const x of Object.values(t)) for (const r of x.rows) assertEquals(r.length, 3);

  assertEquals(t.hold.rows.map((r) => r[0]), ["Savings", "Current", "Card (owed)", `T-2, ${monthName(iso(addDays(today, -today.getUTCDate() - 1)))}`, "eToro", "Tax " + year + " to set aside", "Yours"]);
  assertEquals(t.hold.rows[4], ["eToro", "USD 1,500.00, 1 position, at 0.9, ECB rate of 1 Jun 2020", "€1,350.00"]);
  assertEquals(t.hold.rows[5][2], "−€15,000.00");
  assertEquals(t.hold.rows[6], ["Yours", "", "€10,540.00"]);
  assertEquals(t.hold.note, "Cash of €22,190 plus €2,000 owed to you and €1,350 at the broker, less €15,000 of tax. That leaves €10,540.");

  assertEquals(t.tax.label, `Tax ${year}`);
  assertEquals(t.tax.rows.at(-1), ["Year end, to pay", `With the rest of ${year} billed, 260 hours`, "€16,000.00"]);
  assertEquals(t.tax.rows.find((r) => r[0] === "Reserve Nexus sets aside")![2], "€15,000.00");

  assertEquals(t.living.rows.map((r) => [r[0], r[2]]), [["Rent", "€1,000"], ["Shopping", "€900"], ["Groceries", "€300"], ["Total", "€2,200"]]);
  assertEquals(t.living.rows[1][1], `Budget €400. ${month} so far €210`);
  assertEquals(t.living.rows.at(-1)![1], `Budget €1,700. ${month} so far €210`);

  assertEquals(t.levers.rows.map((r) => [r[0], r[2]]), [
    ["Spend on your budget", "+€500"], ["Each CAD 1 more an hour", "+€48"], ["One more billed day a month", "+€240"],
    ["BV, profit paid out", "+€300"], ["Investing target", "€700 short"], ["A year on these terms", "€38,140 as now"]]);
  assertEquals(t.levers.rows.at(-1)![1], "Before market returns: €44,140 on budget");
  assertEquals(t.levers.note, "What each lever frees a month, after tax at your 40% marginal rate where tax applies.");

  assertEquals(t.slipping.rows.length, 9);
  assertEquals(t.slipping.rows.at(-1)![2], "better");
  assertEquals(t.slipping.note, "8 open items, each against your own plan or rule.");

  const a = Object.fromEntries(t.assignment.rows.map((r) => [r[0], r]));
  assertEquals(a["Rate"][2], "CAD 100 an hour");
  assertEquals(a[`${year + 1} to you`], [`${year + 1} to you`, "€4,500 a month", "€54,000"]);
  assertEquals(a["Plan closes, living on budget"].slice(1), ["Rate up 15%", "CAD 115"]);
  assertEquals(a["Plan closes, living as now"].slice(1), ["Rate up 25%", "CAD 125"]);
  assertEquals(a["Runway if it ended 31 Dec"].slice(1), [`10.3 months on budget. After €16,000 of ${year} tax.`, "8 months"]);
  assertEquals(a["End date"].slice(1), ["No contract on file", "not set"]);
  assertEquals(a["Next assignment"].slice(1), ["5 roles tracked, 2 hot", "0 applications sent"]);

  assertEquals(t.calendar.rows.length, 6);
  assertEquals(t.calendar.rows[0], [day(iso(addDays(today, 1)), iso(today)), "Gymbox €10.00 (Nexus proposes: cancel)", "€2,680"]);
  assertEquals(t.calendar.rows[2][1], "Streamhouse €12.50 (your call: cancel)");
  assertEquals(t.calendar.rows[4].slice(1), ["T-2 lands, €2,000.00", "€3,658"]);
  assertEquals(t.calendar.rows[5], ["Not in this line", "Day to day spending. Due and not seen yet: Phoneco €20.00", ""]);
  assert(t.calendar.note.endsWith("On fixed debits alone they stay above zero."), t.calendar.note);

  assertEquals(t.recurring.rows.map((r) => r[0]), ["Landlord", "Phoneco", "Streamhouse", "Gymbox"]);
  assertEquals(t.recurring.rows[1][1], `Monthly, was due ${dayShort(iso(addDays(today, -4)), iso(today))}`);
  assertEquals(t.recurring.rows[2][1], `Monthly, next ${dayShort(iso(addDays(today, 5)), iso(today))}. Your call: cancel`);
  assertEquals(t.recurring.note, "4 charges, €12,910 a year. Your call, or Nexus's proposal, where there is one.");
});

Deno.test("below zero the days until the payment say so, and without a forecast three tables step aside", async () => {
  // A second rent leaves tomorrow: the day to day accounts dip under zero.
  const dip = await look(undefined, `insert into nx_recurring (user_id, key, label, cadence, amount, per_year, next_due)
    select user_id, 'second', 'Second home', 'monthly', 3000, 36000, current_date + 1 from nx_recurring where key = 'rent'`);
  const cal = topics(dip).find((x) => x.key === "calendar")!;
  assert(cal.note.includes(`below zero from ${day(iso(addDays(today, 1)), iso(today))}, lowest −€1,343 on ${day(iso(addDays(today, 8)), iso(today))}.`), cal.note);

  const bare = await look(undefined, "delete from nx_tax_forecast_live");
  assertEquals(topics(bare).map((x) => x.key), ["hold", "living", "slipping", "calendar", "recurring"]);
  assertEquals(rings(bare, "now").map((r) => r.key), ["yours", "living"]);
});

Deno.test("the tax table shows every line from what is billed to what is to pay", async () => {
  const l = await look();
  l.facts.tax!.to_date = {
    revenue_eur: 100000, costs_eur: 10000, depreciation_eur: 1000, profit: 89000, kia: 500, zelfstandigenaftrek: 1200, startersaftrek: 2123,
    mkb_winstvrijstelling: 10817.48, taxable_profit: 74359.52, wage: 5000, lijfrente: 1000, box1_income: 78359.52,
    bracket_tax: [{ rate: 0.3575, base: 38883, tax: 13900.67 }, { rate: 0.3756, base: 39476.52, tax: 14827.38 }], tariefsaanpassing: 250,
    income_tax_before_credits: 28978.05, algemene_heffingskorting: 300, arbeidskorting: 700, income_tax: 27978.05, zvw: 3000, total_due: 30978.05,
    withheld: 1500, prepaid: 2000, to_pay: 27478.05,
  };
  const rows = topics(l).find((x) => x.key === "tax")!.rows;
  // Between the billed line on top and the reserve and year end below: each step of the sum.
  assertEquals(rows.slice(1, -2), [
    ["Business costs", "", "−€10,000.00"],
    ["Depreciation", "", "−€1,000.00"],
    ["Profit", "", "€89,000.00"],
    ["KIA", "Kleinschaligheidsinvesteringsaftrek", "−€500.00"],
    ["Zelfstandigenaftrek", "", "−€1,200.00"],
    ["Startersaftrek", "", "−€2,123.00"],
    ["MKB winstvrijstelling", "", "−€10,817.48"],
    ["Taxable profit", "", "€74,359.52"],
    ["Wage", "", "€5,000.00"],
    ["Lijfrente", "", "−€1,000.00"],
    ["Box 1 income", "", "€78,359.52"],
    ["Tax at 35.75%", "On €38,883.00", "€13,900.67"],
    ["Tax at 37.56%", "On €39,476.52", "€14,827.38"],
    ["Tariefsaanpassing", "On the deductions that fall in the top bracket", "€250.00"],
    ["Algemene heffingskorting", "", "−€300.00"],
    ["Arbeidskorting", "", "−€700.00"],
    ["Income tax", "", "€27,978.05"],
    ["Zvw", "", "€3,000.00"],
    ["Total due", "", "€30,978.05"],
    ["Withheld on the wage", "", "−€1,500.00"],
    ["Prepaid", "", "−€2,000.00"],
    ["To pay, to date", "", "€27,478.05"],
  ]);
  // A line that is zero stays out.
  l.facts.tax!.to_date = { ...l.facts.tax!.to_date, kia: 0, lijfrente: 0, tariefsaanpassing: 0, algemene_heffingskorting: 0, arbeidskorting: 0 };
  const lean = topics(l).find((x) => x.key === "tax")!.rows.map((r) => r[0]);
  for (const gone of ["KIA", "Lijfrente", "Tariefsaanpassing", "Algemene heffingskorting", "Arbeidskorting"]) assert(!lean.includes(gone), gone);
});

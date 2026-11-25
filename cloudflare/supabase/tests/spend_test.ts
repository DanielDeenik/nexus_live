// v2 spend rules on made-up lines and receipts (invented shops and figures):
// which bank line a receipt explains, how a supermarket receipt splits into
// staples and luxury, which charges recur, which calls apply, what the stop
// lists flag, and when a cancel is confirmed or broken.
import { assertEquals } from "jsr:@std/assert@1";
import {
  applyCalls, cancelUpdates, cleanReading, detectRecurring, foodSplit, matchReceipt, matchTap, receiptInTime, stopAlerts,
  stopLists, type SpendLine,
} from "../functions/_shared/spend.ts";

const line = (over: Partial<SpendLine>): SpendLine => ({
  id: "l1", booked_on: "2026-11-26", amount: -42.5, currency: "EUR", merchant: "Gadgetshop", rail: null, category: "Shopping", ...over,
});
const opts = { windowDays: 5, toleranceEur: 0.05 };

Deno.test("a receipt explains the line from the same shop, with the same amount, inside the window", () => {
  const lines = [line({ id: "a", merchant: "Bookworld", amount: -42.5 }), line({ id: "b", merchant: "Gadgetshop", amount: -42.5 })];
  const hit = matchReceipt({ merchant: "Gadgetshop B.V.", total: 42.5, currency: "EUR", date: "2026-11-25" }, lines, new Set(), opts);
  assertEquals(hit?.id, "b");
});

Deno.test("a receipt names the shop behind a PayPal line with the same amount", () => {
  const lines = [line({ id: "p", merchant: "PayPal", rail: "paypal", amount: -19.99 })];
  const hit = matchReceipt({ merchant: "Fashionhouse", total: 19.99, currency: "EUR", date: "2026-11-24" }, lines, new Set(), opts);
  assertEquals(hit?.id, "p");
});

Deno.test("a receipt leaves a line alone when the amount, currency, window or an earlier match says no", () => {
  const base = { merchant: "Gadgetshop", total: 42.5, currency: "EUR", date: "2026-11-25" };
  assertEquals(matchReceipt(base, [line({ amount: -43.5 })], new Set(), opts), null);
  assertEquals(matchReceipt(base, [line({ currency: "USD" })], new Set(), opts), null);
  assertEquals(matchReceipt(base, [line({ booked_on: "2026-12-05" })], new Set(), opts), null);
  assertEquals(matchReceipt(base, [line({ id: "l1" })], new Set(["l1"]), opts), null);
  assertEquals(matchReceipt({ ...base, total: null }, [line({})], new Set(), opts), null);
});

Deno.test("an unrelated shop line with the same amount is not taken for the receipt", () => {
  const hit = matchReceipt({ merchant: "Gadgetshop", total: 42.5, currency: "EUR", date: "2026-11-25" }, [line({ merchant: "Freshmart" })], new Set(), opts);
  assertEquals(hit, null);
});

const cats = { staples: "Food staples", luxury: "Food luxury" };
const staples = ["bread", "pasta", "beans", "apples"];

Deno.test("a supermarket receipt splits the line by the share of staple items", () => {
  const split = foodSplit(-30, [
    { name: "Volkoren brood", amount: 10, staple: true },
    { name: "Pasta penne", amount: 5, staple: true },
    { name: "Chocolade", amount: 15, staple: false },
  ], staples, cats);
  assertEquals(split, [{ category: "Food staples", amount: -15 }, { category: "Food luxury", amount: -15 }]);
});

Deno.test("a receipt total that differs from the line (deposit, discount) still splits to the line total", () => {
  const split = foodSplit(-20, [
    { name: "Bonen", amount: 3, staple: true },
    { name: "Wijn", amount: 9, staple: false },
  ], staples, cats);
  assertEquals(split, [{ category: "Food staples", amount: -5 }, { category: "Food luxury", amount: -15 }]);
});

Deno.test("only staples means one staples split; no staples or missing prices means no split", () => {
  assertEquals(foodSplit(-12, [{ name: "pasta", amount: 12, staple: true }], staples, cats), [{ category: "Food staples", amount: -12 }]);
  assertEquals(foodSplit(-12, [{ name: "Chips", amount: 12, staple: false }], staples, cats), []);
  assertEquals(foodSplit(-12, [{ name: "Bread", amount: null, staple: true }], staples, cats), []);
});

Deno.test("an item without the reader's staple flag is checked against the staples list", () => {
  const split = foodSplit(-10, [
    { name: "Organic apples 1kg", amount: 4, staple: null },
    { name: "Ice cream", amount: 6, staple: null },
  ], staples, cats);
  assertEquals(split, [{ category: "Food staples", amount: -4 }, { category: "Food luxury", amount: -6 }]);
});

Deno.test("a receipt counts only when it arrives within the days after the purchase", () => {
  assertEquals(receiptInTime("2026-11-25T18:00:00Z", "2026-11-25", "2026-11-26", 2), true);
  assertEquals(receiptInTime("2026-11-28T09:00:00Z", "2026-11-25", "2026-11-26", 2), true);
  assertEquals(receiptInTime("2026-11-29T09:00:00Z", "2026-11-25", "2026-11-26", 2), false);
});

Deno.test("a Wallet tap finds its bank line by shop, amount and date", () => {
  const lines = [line({ id: "x", merchant: "Freshmart 1234", amount: -23.1, booked_on: "2026-11-26" })];
  assertEquals(matchTap({ merchant: "Freshmart", amount: 23.1, currency: "EUR", tapped_at: "2026-11-25T17:40:00Z" }, lines, new Set(), opts)?.id, "x");
  assertEquals(matchTap({ merchant: "Grocerly", amount: 23.1, currency: "EUR", tapped_at: "2026-11-25T17:40:00Z" }, lines, new Set(), opts), null);
});

const cadence = { weekly: [6, 8] as [number, number], monthly: [26, 35] as [number, number], quarterly: [85, 97] as [number, number], yearly: [350, 380] as [number, number] };
const rOpts = { minCharges: 2, cadenceDays: cadence, tolerancePct: 20, today: "2026-11-25" };
const charge = (date: string, amount: number, merchant: string, category = "Subscriptions") =>
  line({ id: `${merchant}-${date}-${amount}`, booked_on: date, amount: -amount, merchant, category });

Deno.test("monthly and yearly charges are recurring, with the next date and the cost a year", () => {
  const found = detectRecurring([
    charge("2026-08-03", 9.99, "Streamly"), charge("2026-09-03", 9.99, "Streamly"), charge("2026-10-03", 9.99, "Streamly"), charge("2026-11-03", 9.99, "Streamly"),
    charge("2025-12-01", 150, "Sitebuilder"), charge("2026-11-30", 150, "Sitebuilder"),
    charge("2026-10-10", 54.2, "Fuelco"), charge("2026-11-02", 18.4, "Fuelco"),
  ], rOpts);
  const st = found.find((r) => r.label === "Streamly")!;
  assertEquals([st.cadence, st.amount, st.per_year, st.next_due, st.charges, st.paid_this_year], ["monthly", 9.99, 119.88, "2026-12-03", 4, 39.96]);
  const sb = found.find((r) => r.label === "Sitebuilder")!;
  assertEquals([sb.cadence, sb.next_due, sb.per_year], ["yearly", "2027-11-30", 150]);
  assertEquals(found.some((r) => r.label === "Fuelco"), false);
});

Deno.test("one shop billing several subscriptions gives one recurring charge per amount", () => {
  const found = detectRecurring([
    charge("2026-09-12", 3.49, "apple.com/bill"), charge("2026-10-12", 3.49, "apple.com/bill"), charge("2026-11-12", 3.49, "apple.com/bill"),
    charge("2026-09-20", 7.99, "apple.com/bill"), charge("2026-10-20", 7.99, "apple.com/bill"), charge("2026-11-20", 7.99, "apple.com/bill"),
    charge("2026-10-02", 19.99, "apple.com/bill"),
  ], rOpts);
  assertEquals(found.map((r) => [r.amount, r.cadence]).sort(), [[3.49, "monthly"], [7.99, "monthly"]]);
  assertEquals(new Set(found.map((r) => r.key)).size, 2);
});

Deno.test("standing calls apply, suggestions stay suggestions, and a call already made is never overwritten", () => {
  const standing = [{ pattern: "streamly", call: "cancel" as const, tag: "cut" as const, note: "Owner's call" }];
  const proposals = [{ pattern: "sitebuilder", call: "cancel" as const, note: "keep the add-on" }];
  const st = applyCalls({ label: "Streamly", call: null, tag: null, proposed_call: null, note: null }, standing, proposals);
  assertEquals([st.call, st.tag, st.note], ["cancel", "cut", "Owner's call"]);
  const sb = applyCalls({ label: "Sitebuilder", call: null, tag: null, proposed_call: null, note: null }, standing, proposals);
  assertEquals([sb.call, sb.proposed_call, sb.note], [null, "cancel", "keep the add-on"]);
  const made = applyCalls({ label: "Streamly", call: "keep", tag: "net_worth", proposed_call: null, note: "mine" }, standing, proposals);
  assertEquals([made.call, made.tag, made.note], ["keep", "net_worth", "mine"]);
});

const settings: Record<string, string> = {
  "stop.gaming_pattern": "pixelcoins|gemstore",
  "stop.gaming_from": "2026-11-25",
  "stop.late_night_pattern": "nightbites",
  "stop.apple_line_pattern": "apple\\.com/bill",
  "stop.apple_from": "2027-01-01",
  "stop.apple_allowed": "[\"Cloudbox\", \"Dev Program\"]",
  "food.staples": "[]",
};
const stopCfg = { lists: stopLists(settings), appleLinePattern: "apple\\.com/bill", appleFrom: "2027-01-01", appleAllowed: ["Cloudbox", "Dev Program"] };

Deno.test("a stop list is a pattern with a start date; a pattern without one is not a list", () => {
  assertEquals(stopLists(settings), [{ name: "gaming", label: "Gaming", pattern: "pixelcoins|gemstore", from: "2026-11-25" }]);
  assertEquals(stopLists({ "stop.food_delivery_pattern": "quickbite", "stop.food_delivery_from": "2027-02-01" }).map((s) => s.label), ["Food delivery"]);
  assertEquals(stopLists({ "stop.gaming_pattern": "", "stop.gaming_from": "2026-11-25" }), []);
});

Deno.test("a charge on a stop list from its start date raises one alert; older ones do not", () => {
  const alerts = stopAlerts({
    lines: [line({ id: "t1", merchant: "PIXELCOINS", booked_on: "2026-11-26", amount: -14.99 }), line({ id: "t0", merchant: "Pixelcoins", booked_on: "2026-11-10" })],
    receipts: [],
  }, stopCfg);
  assertEquals(alerts.map((a) => [a.kind, a.ref, a.title]), [["gaming", "line:t1", "Gaming charge: PIXELCOINS"]]);
});

Deno.test("an Apple receipt with an item on a stop list alerts now; other Apple items alert only from the Apple date unless allowed", () => {
  const alerts = stopAlerts({
    lines: [],
    receipts: [
      { id: "r1", kind: "apple", order_date: "2026-11-27", txn_id: null, items: [{ name: "Gemstore 500 gems", amount: 24.99, staple: false }] },
      { id: "r2", kind: "apple", order_date: "2026-12-12", txn_id: null, items: [{ name: "Tunnelguard", amount: 6.99, staple: false }] },
      { id: "r3", kind: "apple", order_date: "2027-01-12", txn_id: null, items: [{ name: "Tunnelguard", amount: 6.99, staple: false }] },
      { id: "r4", kind: "apple", order_date: "2027-01-14", txn_id: null, items: [{ name: "Cloudbox 200 GB", amount: 3.49, staple: false }] },
    ],
  }, stopCfg);
  assertEquals(alerts.map((a) => [a.kind, a.ref]), [["gaming", "receipt:r1:0"], ["apple_outside", "receipt:r3"]]);
});

Deno.test("an Apple bank line from the Apple date with no allowed receipt behind it alerts", () => {
  const alerts = stopAlerts({
    lines: [
      line({ id: "a1", merchant: "apple.com/bill", booked_on: "2027-01-15", amount: -6.99 }),
      line({ id: "a2", merchant: "apple.com/bill", booked_on: "2027-01-16", amount: -3.49 }),
    ],
    receipts: [{ id: "r4", kind: "apple", order_date: "2027-01-14", txn_id: "a2", items: [{ name: "Cloudbox", amount: 3.49, staple: false }] }],
  }, stopCfg);
  assertEquals(alerts.map((a) => [a.kind, a.ref]), [["apple_outside", "line:a1"]]);
});

Deno.test("without an Apple date only the stop lists alert", () => {
  const alerts = stopAlerts({
    lines: [line({ id: "a1", merchant: "apple.com/bill", booked_on: "2027-01-15", amount: -6.99 }), line({ id: "t1", merchant: "Pixelcoins", booked_on: "2027-01-15" })],
    receipts: [{ id: "r3", kind: "apple", order_date: "2027-01-12", txn_id: null, items: [{ name: "Tunnelguard", amount: 6.99, staple: false }] }],
  }, { ...stopCfg, appleFrom: null });
  assertEquals(alerts.map((a) => [a.kind, a.ref]), [["gaming", "line:t1"]]);
});

Deno.test("a charge after a cancel breaks it; a due date passed with no charge confirms it", () => {
  const rows = [
    { id: "r1", key: "streamly|10", status: "requested", decided_at: "2026-11-26T10:00:00Z", next_due: "2026-12-03", call: "cancel" },
    { id: "r2", key: "sitebuilder|150", status: "requested", decided_at: "2026-11-26T10:00:00Z", next_due: "2026-11-30", call: "cancel" },
    { id: "r3", key: "musicbox|5", status: "to_cancel", decided_at: "2026-11-26T10:00:00Z", next_due: "2026-12-01", call: "cancel" },
  ];
  const charges = new Map([["streamly|10", ["2026-12-03"]], ["musicbox|5", ["2026-12-01"]]]);
  const out = cancelUpdates(rows, charges, "2026-12-08", 5);
  assertEquals(out, [
    { id: "r1", status: "charged_after_cancel", charged_on: "2026-12-03" },
    { id: "r2", status: "confirmed", charged_on: null },
  ]);
});

Deno.test("a reading keeps only what the document shows, in clean types", () => {
  const r = cleanReading({ kind: "grocery", merchant: " Freshmart ", total: "23,10", currency: "eur", date: "2026-11-25T00:00:00", items: [{ name: "Pasta", amount: 7.5, staple: true }, { name: "", amount: 1 }] });
  assertEquals(r, { kind: "grocery", merchant: "Freshmart", total: 23.1, currency: "EUR", date: "2026-11-25", items: [{ name: "Pasta", amount: 7.5, staple: true, period: null, renews_on: null }] });
  assertEquals(cleanReading({ kind: "nonsense" }).kind, "other");
});

// Accounts screen rules on made-up lines: which bank lines are new, which bank
// account feeds which Nexus account, what Nexus asks for, and the bank token.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  addDays, buildNeeds, dayBatches, mapAccounts, type NeedInputs, newRows, reviewButtons,
} from "../functions/_shared/accounts.ts";
import { type BankRow, pemToPkcs8, pickBalance, pkcs1ToPkcs8, signToken, toBankRow } from "../functions/_shared/enableBanking.ts";
import { readEtoroPortfolio } from "../functions/accounts/index.ts";

const row = (date: string, amount: number, payee = "Shop"): BankRow =>
  ({ source: "bunq", account: "0001", date, amount, currency: "EUR", description: "", payee, counterparty: "" });

Deno.test("new lines: a line already in Nexus absorbs one bank line, same day first, then within the window", () => {
  const bank = [row("2026-11-20", -4.5), row("2026-11-20", -4.5), row("2026-11-21", -12), row("2026-11-23", -30), row("2026-11-24", -9)];
  const have = [{ date: "2026-11-20", amount: -4.5 }, { date: "2026-11-20", amount: -12 }, { date: "2026-11-19", amount: -30 }];
  const fresh = newRows(bank, have, 3);
  // one coffee is new, the 12 matched a day apart, the 30 is four days off (outside), the 9 is new
  assertEquals(fresh.map((r) => `${r.date} ${r.amount}`), ["2026-11-20 -4.5", "2026-11-23 -30", "2026-11-24 -9"]);
});

Deno.test("new lines: a re-sync of the same bank lines adds nothing", () => {
  const bank = [row("2026-11-20", -4.5), row("2026-11-20", -4.5)];
  assertEquals(newRows(bank, bank.map((r) => ({ date: r.date, amount: r.amount })), 3).length, 0);
});

Deno.test("account pairing: last four first, then the only one left", () => {
  const nexus = [
    { source: "bunq", account: "7001", label: "bunq main", kind: "current" },
    { source: "bunq", account: "7539", label: "bunq pot", kind: "pot" },
    { source: "amex", account: "AMEX", label: "Amex", kind: "card" },
  ];
  const bunq = mapAccounts([{ uid: "a", last4: "7001", name: null, currency: "EUR" }, { uid: "b", last4: "9999", name: null, currency: "EUR" }], nexus, "bunq");
  assertEquals(bunq.get("a")?.label, "bunq main");
  assertEquals(bunq.get("b")?.label, "bunq pot");
  const amex = mapAccounts([{ uid: "c", last4: "1234", name: null, currency: "EUR" }], nexus, "amex");
  assertEquals(amex.get("c")?.account, "AMEX");
  const two = mapAccounts([{ uid: "d", last4: "1111", name: null, currency: "EUR" }, { uid: "e", last4: "2222", name: null, currency: "EUR" }], nexus, "amex");
  assertEquals([two.get("d"), two.get("e")], [null, null]);
});

Deno.test("batches never split a day", () => {
  const rows = [row("2026-11-01", 1), row("2026-11-01", 2), row("2026-11-01", 3), row("2026-11-02", 4)];
  assertEquals(dayBatches(rows, 2).map((b) => b.length), [3, 1]);
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
});

Deno.test("bank lines: direction, booked only, payee and the bank reference", () => {
  const out = toBankRow({
    entry_reference: "R1", transaction_amount: { amount: "12.30", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "BOOK",
    booking_date: "2026-11-22", creditor: { name: "Albert Heijn" }, creditor_account: { iban: "NL00 TEST 0000 0000 00" }, remittance_information: ["Boodschappen"],
  }, "abn", "0368");
  assertEquals(out, { source: "abn", account: "0368", date: "2026-11-22", amount: -12.3, currency: "EUR", description: "Boodschappen [ref R1]", payee: "Albert Heijn", counterparty: "NL00TEST0000000000" });
  const inflow = toBankRow({ transaction_amount: { amount: "100", currency: "EUR" }, credit_debit_indicator: "CRDT", booking_date: "2026-11-22", remittance_information: ["Card refund"] }, "bunq", "7001");
  assertEquals([inflow?.amount, inflow?.payee], [100, "Card refund"]);
  assertEquals(toBankRow({ transaction_amount: { amount: "5", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "PDNG", booking_date: "2026-11-22" }, "bunq", "7001"), null);
});

Deno.test("balances: the booked balance wins", () => {
  const b = pickBalance([
    { balance_amount: { amount: "90.00", currency: "EUR" }, balance_type: "XPCD" },
    { balance_amount: { amount: "100.00", currency: "EUR" }, balance_type: "CLBD", reference_date: "2026-11-23" },
  ]);
  assertEquals(b, { amount: 100, currency: "EUR", type: "CLBD", date: "2026-11-23" });
});

const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

Deno.test("bank token: PKCS#8 and PKCS#1 keys sign an RS256 token the public key verifies", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // The PKCS#1 key is the OCTET STRING inside the PKCS#8 wrapper; wrapping it again must give the same bytes.
  const lenBytes = pkcs8[1] & 0x80 ? (pkcs8[1] & 0x7f) : 0;
  let i = 2 + lenBytes + 3 + 15; // SEQUENCE header, version, algorithm
  assertEquals(pkcs8[i], 0x04);
  const octLenBytes = pkcs8[i + 1] & 0x80 ? (pkcs8[i + 1] & 0x7f) : 0;
  i += 2 + octLenBytes;
  const pkcs1 = pkcs8.slice(i);
  assertEquals(pkcs1ToPkcs8(pkcs1), pkcs8);
  assertEquals(pemToPkcs8(pem("RSA PRIVATE KEY", pkcs1)), pkcs8);

  const token = await signToken({ app_id: "00000000-0000-4000-8000-000000000000", private_key: pem("PRIVATE KEY", pkcs8) }, "https://api.example.test", 3600, 1_700_000_000);
  const [h, c, s] = token.split(".");
  const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/")));
  assertEquals(dec(h), { typ: "JWT", alg: "RS256", kid: "00000000-0000-4000-8000-000000000000" });
  assertEquals(dec(c), { iss: "enablebanking.com", aud: "api.example.test", iat: 1_700_000_000, exp: 1_700_003_600 });
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  assert(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, sig, new TextEncoder().encode(`${h}.${c}`)));
  assertThrows(() => pemToPkcs8("not a key"));
});

const inputs = (over: Partial<NeedInputs> = {}): NeedInputs => ({
  today: "2026-11-24", services: [], accounts: [], staleDays: 7, consentWarnDays: 14, balanceTolerance: 1,
  forecastWarnings: [], reviews: [], nextYearPlanned: true, nextYear: 2027, manual: [], dismissed: new Set(), formatMoney: (x) => x.toFixed(2),
  ...over,
});

Deno.test("needs: stale and mismatched accounts, reviews and warnings first; dismissed and expired items drop out", () => {
  const needs = buildNeeds(inputs({
    accounts: [
      { label: "ABN current", source: "abn", account: "0368", kind: "current", balance: 100, last_booked: "2026-11-10", bank_balance: null, bank_balance_date: null, feed: "file" },
      { label: "bunq main", source: "bunq", account: "7001", kind: "current", balance: 100, last_booked: "2026-11-23", bank_balance: 150, bank_balance_date: "2026-11-24", feed: "bank" },
    ],
    services: [{ item: { id: "wise", name: "Wise", kind: "wallet", via: "wise_token" }, status: "not_connected", detail: null, valid_until: null }],
    reviews: [{ id: "r1", summary: "2026-Q4 VAT: the books changed", item_type: "filing", reason_codes: ["changed_after_approval"] }],
    forecastWarnings: [{ code: "numbering_gap", severity: "warn", message: "Invoice numbers skip INV-011" }],
    nextYearPlanned: false,
    manual: [{ code: "old", title: "Past", detail: "", until: "2026-01-01" }, { code: "vat", title: "VAT", detail: "" }],
    dismissed: new Set(["vat"]),
  }));
  assertEquals(needs.map((n) => n.code), ["review_r1", "forecast_numbering_gap", "stale_abn_0368", "balance_bunq_7001", "connect_wise", "plan_2027"]);
  assertEquals(needs[0].decide, { approve: "New draft", reject: "Keep approved" });
  assertEquals(needs[2].action, "import");
  assertEquals(reviewButtons("invoice_anomaly", []), null);
});

Deno.test("eToro: positions with profit, current rate and value from both payload spellings", () => {
  const schema = readEtoroPortfolio({ clientPortfolio: { credit: 120.5, unrealizedPnL: 15, positions: [
    { positionID: 1, instrumentID: 1001, units: 2, openRate: 100, amount: 200, unrealizedPnL: { pnL: 15, closeRate: 107.5 } },
  ], mirrors: [{ positions: [{ positionID: 2, instrumentID: 1002, units: 1, openRate: 50, amount: 50, unrealizedPnL: { pnL: -5, closeRate: 45 } }] }] } });
  assertEquals(schema.credit, 120.5);
  assertEquals(schema.unrealized_pnl, 15);
  assertEquals(schema.positions.map((p) => [p.id, p.value, p.current_rate]), [["1", 215, 107.5], ["2", 45, 45]]);
  const example = readEtoroPortfolio({ clientPortfolio: { credit: 0, positions: [{ positionId: 9, instrumentId: 7, amount: 10, pnL: 2, closeRate: 12 }] } });
  assertEquals(example.positions[0], { id: "9", instrument: 7, units: null, open_rate: null, current_rate: 12, pnl: 2, value: 12 });
  assertEquals(example.unrealized_pnl, 2);
});

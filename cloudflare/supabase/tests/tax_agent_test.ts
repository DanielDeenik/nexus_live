import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { targetsFor } from "../functions/tax-agent/index.ts";

Deno.test("tax graph targets: previous and current quarter plus the year", () => {
  assertEquals(targetsFor(new Date("2026-10-12T00:00:00Z")), [
    { kind: "vat_quarter", year: 2026, q: 3 },
    { kind: "vat_quarter", year: 2026, q: 4 },
    { kind: "income_tax_year", year: 2026 },
  ]);
  assertEquals(targetsFor(new Date("2027-02-01T00:00:00Z"))[0], { kind: "vat_quarter", year: 2026, q: 4 });
});

Deno.test("tax graph targets: one asked-for period", () => {
  assertEquals(targetsFor(new Date(), { kind: "vat_quarter", period: "2026-Q2" }), [{ kind: "vat_quarter", year: 2026, q: 2 }]);
  assertThrows(() => targetsFor(new Date(), { kind: "vat_quarter", period: "Q2" }));
});

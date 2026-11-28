// The Nexus live menu in the LensIQ top bar: every page the app routes to sits under one
// section, every menu entry is a real page, and a sub page lights its own section.
// Run: deno test supabase/tests/nav_web_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { NAV, sectionFor } from "../../apps/web/src/lib/nav.ts";

// The pages App.tsx renders (redirect and catch-all routes are not pages).
const app = Deno.readTextFileSync(new URL("../../apps/web/src/App.tsx", import.meta.url));
const pages = [...app.matchAll(/<Route path="([^"*]+)" element={<(?!RedirectKeepQuery|Navigate)/g)].map((m) => m[1]);

Deno.test("every routed page belongs to one menu section", () => {
  const orphans = pages.filter((p) => !sectionFor(p));
  assertEquals(orphans, []);
});

Deno.test("every menu entry and sub entry is a routed page", () => {
  const entries = NAV.flatMap((n) => [n.path, ...(n.sub ?? []).map((s) => s.path)]);
  assertEquals(entries.filter((e) => !pages.includes(e)), []);
});

Deno.test("a sub page lights its own section, and the start page is Income & Tax only", () => {
  assertEquals(sectionFor("/time/entries")?.label, "Time");
  assertEquals(sectionFor("/recruiter/fit")?.label, "Recruiter");
  assertEquals(sectionFor("/")?.label, "Income & Tax");
  assertEquals(sectionFor("/nowhere"), undefined);
});

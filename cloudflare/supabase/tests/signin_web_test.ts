// The decisions of the web sign-in page (apps/web/src/lib/signIn.ts), which are
// pure and run here unchanged: what the page does once it has asked for a code,
// and how it reads the code that is typed. The failures are worded the way
// Supabase Auth words them. Addresses and codes are made up.
// Run: deno test supabase/tests/signin_web_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { afterSend, cleanCode, codeProblem } from "../../apps/web/src/lib/signIn.ts";

Deno.test("a typed or pasted code goes out as its digits, whatever its length", () => {
  assertEquals(cleanCode("01234567"), "01234567");
  assertEquals(cleanCode(" 0123 4567\n"), "01234567");
  assertEquals(cleanCode("012-345"), "012345");
  assertEquals(cleanCode("Your code: 0123456789"), "0123456789");
  assertEquals(cleanCode("no digits"), "");
});

Deno.test("once the email is out, the page moves on to the code box", () => {
  assertEquals(afterSend(null, "one@example.test"), {
    toCode: true,
    note: { text: "A code is on its way to one@example.test.", bad: false },
  });
});

Deno.test("a request that came too soon still leads to the code box, with the server's own reason", () => {
  const soon = afterSend({
    status: 429,
    code: "over_email_send_rate_limit",
    message: "For security purposes, you can only request this after 16 seconds.",
  }, "one@example.test");
  assertEquals(soon, {
    toCode: true,
    note: {
      text: "For security purposes, you can only request this after 16 seconds. No new email was sent. If you already have a code, type it here.",
      bad: false,
    },
  });
  const cap = afterSend({ status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" }, "one@example.test");
  assertEquals(cap.toCode, true);
  assertEquals(cap.note.text, "Email rate limit exceeded. No new email was sent. If you already have a code, type it here.");
});

Deno.test("an address without an account stays on the email step and says so", () => {
  assertEquals(afterSend({ status: 422, code: "otp_disabled", message: "Signups not allowed for otp" }, "typo@example.test"), {
    toCode: false,
    note: { text: "There is no Nexus account for typo@example.test. Check the address for typos.", bad: true },
  });
});

Deno.test("any other failure stays on the email step, in the server's words", () => {
  assertEquals(afterSend({ message: "Failed to fetch" }, "one@example.test"), {
    toCode: false,
    note: { text: "Failed to fetch", bad: true },
  });
});

Deno.test("a wrong or expired code says so, and anything else is shown as the server words it", () => {
  const stale = "That code is wrong or has expired. Use the newest email, or send a new code.";
  assertEquals(codeProblem({ status: 403, code: "otp_expired", message: "Token has expired or is invalid" }), { text: stale, bad: true });
  assertEquals(codeProblem({ status: 403, message: "Email link is invalid or has expired" }), { text: stale, bad: true });
  assertEquals(codeProblem({ status: 500, message: "Database error" }), { text: "Database error", bad: true });
});

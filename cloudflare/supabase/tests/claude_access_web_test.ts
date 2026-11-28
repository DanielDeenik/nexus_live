// The consent rules of the Nexus web app for Claude Code: which redirects look like
// Claude Code or Claude, the address and command Settings shows, and the consent
// request kept through sign-in. Run: deno test supabase/tests/claude_access_web_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { addCommand, expectedRedirect, keepConsentPath, mcpAddress, redirectHost, scopeList, takeConsentPath } from "../../apps/web/src/lib/claudeAccess.ts";

// The default of mcp.consent_trusted_hosts in its migration.
const migration = Deno.readTextFileSync(new URL("../migrations/20261128000004_agents_mcp.sql", import.meta.url));
const trusted: string[] = JSON.parse(migration.match(/\('mcp\.consent_trusted_hosts', '([^']+)'/)![1]);

Deno.test("Claude Code's local callback and Claude's own callback are expected", () => {
  assertEquals(expectedRedirect("http://localhost:54123/callback", trusted), true);
  assertEquals(expectedRedirect("http://127.0.0.1:8080/callback", trusted), true);
  assertEquals(expectedRedirect("http://[::1]:3000/callback", trusted), true);
  assertEquals(expectedRedirect("https://claude.ai/api/mcp/auth_callback", trusted), true);
});

Deno.test("any other host, plain http away from this machine, or a non-web scheme gets the warning", () => {
  assertEquals(expectedRedirect("https://elsewhere.test/callback", trusted), false);
  assertEquals(expectedRedirect("http://claude.ai/api/mcp/auth_callback", trusted), false);
  assertEquals(expectedRedirect("https://claude.ai.elsewhere.test/cb", trusted), false);
  assertEquals(expectedRedirect("myapp://callback", trusted), false);
  assertEquals(expectedRedirect("not a url", trusted), false);
  assertEquals(redirectHost("myapp://callback"), null);
});

Deno.test("Settings shows this project's address and the command to add it", () => {
  const a = mcpAddress("https://ref.example.test/");
  assertEquals(a, "https://ref.example.test/functions/v1/mcp");
  assertEquals(addCommand("nexus", a), "claude mcp add --transport http nexus https://ref.example.test/functions/v1/mcp");
  assertEquals(scopeList("  openid  email "), ["openid", "email"]);
  assertEquals(scopeList(undefined), []);
});

Deno.test("a consent request that arrives before sign-in comes back once, and nothing else is kept", () => {
  const m = new Map<string, string>();
  const store = { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
  keepConsentPath("/review", "?x=1", store);
  assertEquals(takeConsentPath(store), null);
  keepConsentPath("/oauth/consent", "", store);
  assertEquals(takeConsentPath(store), null);
  keepConsentPath("/oauth/consent", "?authorization_id=abc", store);
  assertEquals(takeConsentPath(store), "/oauth/consent?authorization_id=abc");
  assertEquals(takeConsentPath(store), null);
  m.set("nexus.oauth_consent", "https://elsewhere.test/");
  assertEquals(takeConsentPath(store), null);
});

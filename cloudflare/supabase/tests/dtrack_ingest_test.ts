// The ingest route rejects bad callers before it touches the database.
import { assertEquals } from "jsr:@std/assert@1";
import { handler } from "../functions/dtrack-ingest/index.ts";

const url = "http://localhost/functions/v1/nexus/dtrack-ingest";
const goodToken = "dtk_" + "a".repeat(64);

Deno.test("GET is refused", async () => {
  const r = await handler(new Request(url, { method: "GET" }));
  assertEquals(r.status, 405);
});

Deno.test("missing token is refused", async () => {
  const r = await handler(new Request(url, { method: "POST", body: "{}" }));
  assertEquals(r.status, 401);
});

Deno.test("a user JWT is not a device token", async () => {
  const r = await handler(new Request(url, { method: "POST", body: "{}", headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" } }));
  assertEquals(r.status, 401);
});

Deno.test("malformed token is refused", async () => {
  const r = await handler(new Request(url, { method: "POST", body: "{}", headers: { authorization: "Bearer dtk_short" } }));
  assertEquals(r.status, 401);
});

Deno.test("non-object body is refused", async () => {
  for (const body of ["[]", "not json", "null"]) {
    const r = await handler(new Request(url, { method: "POST", body, headers: { authorization: `Bearer ${goodToken}` } }));
    assertEquals(r.status, 400, body);
  }
});

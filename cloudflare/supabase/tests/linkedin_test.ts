// LinkedIn insights: parsers, kind detection and recruiter detection, run
// against synthetic files built on the fly and against the configuration the
// migration seeds (so a seed that the parser cannot use fails here). No network.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import {
  cleanReading, detectKind, identifySelf, type LinkedInConfig, linkedinConfig, messageKey, parseArchive, parseContentExport,
  parseCsv, parseDate, parseRange, parseTimestamp, readXlsx, recruiterHits, snippetOf, toPct, urlKey,
} from "../functions/linkedin/parse.ts";
import { buildArchiveZip, buildContentXlsx, buildXlsx, contentSheets } from "./fixtures/linkedin/build.ts";

/** linkedin.* rows exactly as the migration seeds them. */
async function seededConfig(): Promise<Record<string, string>> {
  const sql = await Deno.readTextFile(new URL("../migrations/20261012000010_linkedin_insights.sql", import.meta.url));
  const out: Record<string, string> = {};
  for (const m of sql.matchAll(/\('(linkedin\.[a-z_]+)',\s*'((?:[^']|'')*)'/g)) out[m[1]] = m[2].replace(/''/g, "'");
  return out;
}

const raw = await seededConfig();
const cfg: LinkedInConfig = linkedinConfig(raw);

Deno.test("seeded config is complete and parses", () => {
  assertEquals(cfg.dateOrder, "MDY");
  assert(cfg.recruiterKeywords.includes("recruiter"));
  assert(cfg.recruiterKeywords.includes("werving"));
  assertEquals(cfg.snippetMaxChars, 200);
  for (const k of ["linkedin.bucket", "linkedin.max_import_bytes", "linkedin.upsert_chunk", "linkedin.summary_top_n", "linkedin.company_suffixes", "linkedin.screenshot_instruction", "linkedin.screenshot_hints"]) {
    assert(raw[k] !== undefined, `${k} seeded`);
  }
  JSON.parse(raw["linkedin.company_suffixes"]);
  JSON.parse(raw["linkedin.screenshot_hints"]);
  const broken = { ...raw };
  delete broken["linkedin.content_sheets"];
  assertThrows(() => linkedinConfig(broken), Error, "linkedin.content_sheets");
});

Deno.test("recruiter detection matches keywords at word starts only", () => {
  const kw = cfg.recruiterKeywords;
  assertEquals(recruiterHits("Senior Recruiter", kw), ["recruiter"]);
  assert(recruiterHits("Recruitment Consultant, Finance", kw).includes("recruitment"));
  assert(recruiterHits("Talent Acquisition Partner", kw).includes("talent acquisition"));
  assert(recruiterHits("Adviseur Werving en Selectie", kw).includes("werving"));
  assert(recruiterHits("I am a headhunter", kw).includes("headhunter"));
  assertEquals(recruiterHits("Restaffing Lead Engineer", kw), []);
  assertEquals(recruiterHits("Software Engineer", kw), []);
  assertEquals(recruiterHits(null, kw), []);
});

Deno.test("dates, ranges, timestamps, percentages and urls", () => {
  assertEquals(parseDate("9/3/2026", "MDY"), "2026-09-03");
  assertEquals(parseDate("9/3/2026", "DMY"), "2026-03-09");
  assertEquals(parseDate("12 Sep 2026", "MDY"), "2026-09-12");
  assertEquals(parseDate("Sep 12, 2026", "MDY"), "2026-09-12");
  assertEquals(parseDate("2026-09-12", "MDY"), "2026-09-12");
  assertEquals(parseDate("46277", "MDY"), "2026-09-12");
  assertEquals(parseDate("2/30/2026", "MDY"), null);
  assertEquals(parseDate("soon", "MDY"), null);
  assertEquals(parseRange("9/1/2026 - 9/3/2026", "MDY"), { from: "2026-09-01", to: "2026-09-03" });
  assertEquals(parseTimestamp("2026-09-14 08:30:00 UTC"), "2026-09-14T08:30:00.000Z");
  assertEquals(toPct("5%"), 0.05);
  assertEquals(toPct("0.081"), 0.081);
  assertEquals(toPct("< 1%"), null);
  assertEquals(urlKey("https://www.LinkedIn.com/in/rita-vos-example/?trk=x"), "linkedin.com/in/rita-vos-example");
});

Deno.test("csv parser handles quotes, doubled quotes and line breaks", () => {
  const g = parseCsv('a,b,c\n1,"x, y","he said ""hi"""\n2,"line\nbreak",\r\n');
  assertEquals(g, [["a", "b", "c"], ["1", "x, y", 'he said "hi"'], ["2", "line\nbreak", ""]]);
});

Deno.test("xlsx reader keeps positions with shared and inline strings", () => {
  const x = buildXlsx({ S: [["a", 1], [null, "b"]], I: [["c & d"]] }, { inline: ["I"], offset: { S: 1 } });
  const s = readXlsx(x, cfg.limits);
  assertEquals(s.get("S"), [[], ["a", "1"], ["", "b"]]);
  assertEquals(s.get("I"), [["c & d"]]);
});

Deno.test("kind detection from bytes and name", async () => {
  assertEquals(detectKind("export.xlsx", buildContentXlsx(), cfg), "content");
  assertEquals(detectKind("data.zip", await buildArchiveZip(), cfg), "archive");
  assertEquals(detectKind("anything.bin", buildContentXlsx(), cfg), "content");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assertEquals(detectKind("x", png, cfg), "screenshot");
  assertEquals(detectKind("x", jpg, cfg), "screenshot");
  assertEquals(detectKind("other.zip", zipSync({ "readme.txt": strToU8("hi") }), cfg), null);
  assertEquals(detectKind("notes.txt", strToU8("hello"), cfg), null);
});

Deno.test("content export: period, daily merge, side by side top posts, followers, audience", () => {
  const x = parseContentExport(buildContentXlsx(), cfg);
  assertEquals(x.warnings, []);
  assertEquals(x.period, { from: "2026-09-01", to: "2026-09-03" });
  assertEquals(x.discovery, { impressions: 1234, members_reached: 567 });
  assertEquals(x.days, [
    { day: "2026-09-01", impressions: 100, engagements: 5, new_followers: 2 },
    { day: "2026-09-02", impressions: 250, engagements: 20, new_followers: 0 },
    { day: "2026-09-03", impressions: 1000, engagements: 30, new_followers: 5 },
  ]);
  const posts = Object.fromEntries(x.posts.map((p) => [p.url.slice(-1), p]));
  assertEquals(posts["1"].engagements, 30);
  assertEquals(posts["1"].impressions, 400);
  assertEquals(posts["1"].published_on, "2026-09-01");
  assertEquals(posts["2"].impressions, 900);
  assertEquals(x.followersTotal, { as_of: "2026-09-03", total: 812 });
  assertEquals(x.audience.length, 7);
  const byDim = Object.groupBy(x.audience, (a) => a.dimension);
  assertEquals(Object.keys(byDim).sort(), ["company", "company_size", "industry", "job_title", "location", "seniority"]);
  assertEquals(byDim.job_title!.find((a) => a.value === "Portfolio Manager")!.pct, 0.05);
  const acme = byDim.company![0];
  assertEquals([acme.pct, acme.pct_label], [null, "< 1%"]);
});

Deno.test("content export: a renamed sheet is a config change", () => {
  const sheets = contentSheets({ discovery: "DISCOVERY", engagement: "Daily engagement", top: "TOP POSTS", followers: "FOLLOWERS", demographics: "DEMOGRAPHICS" });
  const bytes = buildXlsx(sheets);
  const before = parseContentExport(bytes, cfg);
  assert(before.warnings.some((w) => w.includes("engagement")));
  assertEquals(before.days[0].impressions, undefined);
  const renamed = { ...cfg, contentSheets: { ...cfg.contentSheets, engagement: [...cfg.contentSheets.engagement, "Daily engagement"] } };
  const after = parseContentExport(bytes, renamed);
  assertEquals(after.warnings, []);
  assertEquals(after.days[0].impressions, 100);
});

Deno.test("archive: connections without email, recruiters flagged, inbound metadata only", async () => {
  const x = await parseArchive(await buildArchiveZip(), cfg);
  assertEquals(x.warnings, []);
  assertEquals(x.self, { name: "Sam Testowner", source: "profile" });
  assertEquals(x.connections.length, 5);
  const rec = Object.fromEntries(x.connections.map((c) => [c.name, c.is_recruiter]));
  assertEquals(rec, { "Rita Vos": true, "Otto Bakker": false, "Mila Jansen": true, "Ward Smit": true, "Nina Kok": false });
  assertEquals(x.connections.find((c) => c.name === "Rita Vos")!.connected_on, "2026-09-12");
  // Privacy: no email address survives parsing, and nothing Sam sent is kept.
  const all = JSON.stringify(x);
  assert(!all.includes("@example.test"), "no email address in the import");
  assert(!all.includes("happy to talk"), "own messages are skipped");
  assertEquals(x.skipped.own_messages, 2);
  assertEquals(x.messages.length, 4);
  for (const m of x.messages) assert(!m.snippet || m.snippet.length <= cfg.snippetMaxChars);

  const by = Object.fromEntries(x.messages.map((m) => [m.sender_name, m]));
  assertEquals(by["Rita Vos"].company, "Acme Talent B.V.");
  assertEquals(by["Rita Vos"].is_recruiter, true);
  assert(by["Rita Vos"].snippet!.endsWith("..."));
  assertEquals(by["Otto Bakker"].is_recruiter, false);
  assertEquals(by["Otto Bakker"].snippet, 'Coffee next week? Bring the slides, "the good ones".');
  assertEquals(by["Pat Hunter"].company, null);
  assertEquals(by["Pat Hunter"].is_recruiter, true); // by the word headhunter in the text
  assertEquals(by["Mila Jansen"].is_recruiter, true); // by her position
  assertEquals(x.invitations, { inbound: 2, inbound_recruiter: 1 });
  assertEquals(x.period, { from: "2024-03-03", to: "2026-10-05" });
});

Deno.test("archive: re-import gives the same keys (idempotent upserts)", async () => {
  const a = await parseArchive(await buildArchiveZip(), cfg);
  const b = await parseArchive(await buildArchiveZip(), cfg);
  assertEquals(a.messages.map((m) => m.msg_key), b.messages.map((m) => m.msg_key));
  assertEquals(new Set(a.messages.map((m) => m.msg_key)).size, a.messages.length);
  assertEquals(await messageKey("c", "2026-01-01T00:00:00.000Z", "Rita  VOS"), await messageKey("c", "2026-01-01T00:00:00.000Z", "rita vos"));
});

Deno.test("archive owner found without Profile.csv", async () => {
  const x = await parseArchive(await buildArchiveZip({ withProfile: false }), cfg);
  assertEquals(x.self, { name: "Sam Testowner", source: "sent_folder" });
  assertEquals(x.messages.length, 4);
  // No sent folder at all: whoever is in the most conversations.
  const msgs = [
    { conversation_id: "1", from: "A Person", to: "Owner Name", folder: "INBOX" },
    { conversation_id: "2", from: "Owner Name", to: "B Person", folder: "INBOX" },
    { conversation_id: "3", from: "C Person", to: "Owner Name", folder: "INBOX" },
  ];
  assertEquals(identifySelf(null, msgs, cfg.sentFolders), { name: "Owner Name", source: "conversations" });
  assertEquals(identifySelf(null, msgs.slice(0, 1), cfg.sentFolders), { name: null, source: null });
});

Deno.test("snippets never exceed the configured length", () => {
  assertEquals(snippetOf("  short\n text ", 200), "short text");
  assertEquals(snippetOf("x".repeat(500), 200)!.length, 200);
  assertEquals(snippetOf("", 200), null);
});

Deno.test("screenshot reading is checked deterministically", () => {
  const r = cleanReading({
    kind: "views", period_label: " Past 90 days ", period_days: 90, total: "1,204", change_pct: -12.5,
    viewer_titles: [{ label: "Analyst", count: 3 }, { label: "analyst", count: 9 }, { label: "", count: 1 }, { label: "Engineer", count: -2 }],
    viewer_companies: "not a list",
  });
  assertEquals(r.kind, "views");
  assertEquals(r.period_label, "Past 90 days");
  assertEquals(r.total, 1204);
  assertEquals(r.change_pct, -12.5);
  assertEquals(r.viewer_titles, [{ label: "Analyst", count: 3 }, { label: "Engineer", count: null }]);
  assertEquals(r.viewer_companies, []);
  assertEquals(r.keywords, []);
  assertEquals(cleanReading({ kind: "profile" }).kind, "unknown");
});

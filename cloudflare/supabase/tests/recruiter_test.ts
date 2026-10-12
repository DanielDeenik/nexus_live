// Recruiter agent: deterministic parts and the LangGraph flow, end to end,
// with a scripted model and a fake Gmail and Calendar. No network.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { checkCv, cvDocx, masterName, type TailoredCv } from "../functions/recruiter/cv.ts";
import { scoreSpec, type SpecReading } from "../functions/recruiter/fit.ts";
import { buildGraph, type Mail, parseIntake, type Submission } from "../functions/recruiter/graph.ts";
import type { AgentSettings, JobConfig, Knowledge, SkillProfile } from "../functions/recruiter/knowledge.ts";
import { dedup, parseJson, parseRss, scoreItems } from "../functions/recruiter/roles.ts";
import { pickSlot, zoned } from "../functions/recruiter/slots.ts";
import { mime } from "../functions/_shared/google.ts";
import type { Structured } from "../functions/_shared/llm.ts";

const dir = new URL("./fixtures/recruiter/", import.meta.url);
const profile = JSON.parse(await Deno.readTextFile(new URL("skill-profile.json", dir))) as SkillProfile;
const jobs = JSON.parse(await Deno.readTextFile(new URL("jobs.json", dir))) as JobConfig;

const agent: AgentSettings = {
  owner_email: "owner@example.test",
  intake_from: "intake@example.test",
  call_timezone: "Europe/Amsterdam",
  call_window: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], start: "09:00", end: "13:00" },
  call_minutes: 15,
  call_lead_hours: 24,
  call_horizon_days: 14,
  call_max_per_day: 3,
  call_organizer_calendar: "Networking",
  no_match_threshold: 45,
  handled_subject_prefix: "LensIQ handled",
};

const master = `# Master CV

**JANE EXAMPLE**

Consultant | Front Office

+00 000 | jane@example.test | Amsterdam

**EXPERIENCE**

**Example Bank** 01/2026 – Present
  - Front office order management on the platform.

**Sample Asset Management** 02/2022 – 12/2025
  - IBOR and data management.
`;

const k: Knowledge = {
  agent, profile, jobs, cvMaster: master, factBase: "Jane is a front office consultant.", sharingRules: "Never share rates.",
  tailoringRules: "Lead with front office.", fetched: [], cached: [],
};

const goodCv: TailoredCv = {
  headline: "Consultant | Front Office",
  contact: "+00 000 | jane@example.test | Amsterdam",
  summary: "Front office and IBOR consultant.",
  competencies: ["Front office", "IBOR"],
  experience: [
    { title: "Consultant", employer: "Example Bank", dates: "01/2026 – Present", location: null, bullets: ["Order management on the platform."] },
    { title: "Consultant", employer: "Sample Asset Management", dates: "02/2022 – 12/2025", location: null, bullets: ["IBOR."] },
  ],
  certifications: [], education: [], languages: ["English"], skills: ["SQL"],
  cover_letter: "Hello. I would like to talk about the role.",
};

const frontOffice: SpecReading = {
  role_title: "SimCorp Front Office Consultant",
  company: "Acme AM",
  centre_area_id: "front_office",
  requirements: [
    { text: "SimCorp Dimension Order Manager", must_have: true, area_id: "front_office" },
    { text: "IBOR", must_have: true, area_id: "ibor" },
    { text: "Communication Server", must_have: false, area_id: "comm_server" },
  ],
};

const axioma: SpecReading = {
  role_title: "Axioma Risk Modeller",
  company: null,
  centre_area_id: "quant_modelling",
  requirements: [
    { text: "Axioma factor model calibration", must_have: true, area_id: "quant_modelling" },
    { text: "Python model validation", must_have: true, area_id: "software_engineering" },
    { text: "SimCorp exposure", must_have: false, area_id: "simcorp" },
  ],
};

Deno.test("intake mail: fields come from the JSON block", () => {
  const body = 'Kind: spec\n...\n---LENSIQ-JSON---\n{"kind":"spec","received":"2026-10-12T08:00:00Z","name":"Ann","email":"ann@agency.test","spec":"Front office role"}\n---END---';
  const s = parseIntake("abc", "2026-10-12T08:01:00Z", body)!;
  assertEquals(s.kind, "spec");
  assertEquals(s.email, "ann@agency.test");
  assertEquals(s.receivedAt, "2026-10-12T08:00:00Z");
  assertEquals(parseIntake("x", "", "no block"), null);
  assertEquals(parseIntake("x", "", '---LENSIQ-JSON---{"kind":"other"}---END---'), null);
});

Deno.test("fit: a front office spec is a match, scored by tier not by term count", () => {
  const f = scoreSpec(frontOffice, profile, agent);
  // must 1.0*2 + must 1.0*2 + nice working 0.45*1 = 4.45 of 5
  assertEquals(f.score, 89);
  assert(f.isMatch);
  assertMatch(f.report, /centre of gravity is Front office/);
  assertEquals(f.gaps.length, 0);
});

Deno.test("fit: an Axioma modelling spec is no match even with SimCorp named", () => {
  const f = scoreSpec(axioma, profile, agent);
  assert(!f.isMatch);
  assert(f.score < agent.no_match_threshold);
  assertEquals(f.gaps.length, 2);
  assertMatch(f.report, /not a logical match/);
});

Deno.test("fit: a high score centred outside his leading tiers is still no match", () => {
  const f = scoreSpec({ ...frontOffice, centre_area_id: "comm_server" }, profile, agent);
  assert(f.score >= agent.no_match_threshold);
  assert(!f.isMatch);
});

Deno.test("cv check: invented employer, changed dates and dropped roles are caught", () => {
  assertEquals(checkCv(goodCv, master), []);
  const bad = { ...goodCv, experience: [{ ...goodCv.experience[0], employer: "Made Up Ltd" }] };
  const p = checkCv(bad, master);
  assert(p.some((x) => x.includes("employer not in the master CV")));
  assert(p.some((x) => x.includes("role dropped")));
  assert(checkCv({ ...goodCv, summary: "Front office — IBOR" }, master).some((x) => x.includes("em dash")));
  assertEquals(masterName(master), "Jane Example");
});

Deno.test("cv docx is a real Word file", async () => {
  const bytes = await cvDocx(goodCv, "Jane Example");
  assertEquals(String.fromCharCode(bytes[0], bytes[1]), "PK");
  assert(bytes.length > 2000);
});

Deno.test("mime: multipart with the attachment base64 encoded", () => {
  const raw = new TextDecoder().decode(mime({ to: "a@b.test", subject: "Jane Example for Rôle", text: "Hi", attachment: { name: "cv.docx", type: "application/x-test", bytes: new Uint8Array([1, 2, 3]) } }));
  assertMatch(raw, /Subject: =\?UTF-8\?B\?/);
  assertMatch(raw, /Content-Disposition: attachment; filename="cv.docx"/);
  assertMatch(raw, /AQID/);
});

Deno.test("slots: a Tuesday morning request lands on a free Tuesday morning slot", () => {
  const now = new Date("2026-10-12T08:00:00Z"); // Monday 10:00 in Amsterdam
  const busy = [{ start: zoned("2026-10-13", "09:00", agent.call_timezone).toISOString(), end: zoned("2026-10-13", "10:00", agent.call_timezone).toISOString() }];
  const s = pickSlot({ weekdays: ["Tue"], earliest_date: null, latest_date: null, part_of_day: "morning" }, agent, busy, new Map(), now)!;
  assertEquals(s.toISOString(), zoned("2026-10-13", "10:00", agent.call_timezone).toISOString());
});

Deno.test("slots: lead time, daily cap and weekends are respected", () => {
  const now = new Date("2026-10-16T08:00:00Z"); // Friday
  const capped = new Map([["2026-10-19", 3]]);
  const s = pickSlot({ weekdays: [], earliest_date: null, latest_date: null, part_of_day: "any" }, agent, [], capped, now)!;
  // Saturday and Sunday are outside the window, Monday is full, so Tuesday 09:00
  assertEquals(s.toISOString(), zoned("2026-10-20", "09:00", agent.call_timezone).toISOString());
});

// ---- the graph, with a scripted model and a fake Google ----

function fakes(script: Record<string, unknown>) {
  const calls: string[] = [];
  const structured: Structured = async <T>(_s: string, _c: unknown, tool: { name: string }) => {
    calls.push(tool.name);
    if (!(tool.name in script)) throw new Error(`unexpected model call ${tool.name}`);
    return { value: script[tool.name] as T, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const drafts: { raw: string }[] = [];
  const events: { calendarId: string; start: Date; attendees: string[] }[] = [];
  const mail: Mail = {
    createDraft: async (raw) => {
      drafts.push({ raw: new TextDecoder().decode(raw) });
      return `d${drafts.length}`;
    },
    findDraft: async () => null,
    calendars: async () => [{ id: "primary@x", summary: "Jane", primary: true }, { id: "net@x", summary: "Networking" }],
    busy: async () => [],
    eventWithRef: async () => null,
    createEvent: async (cid, e) => {
      events.push({ calendarId: cid, start: e.start, attendees: e.attendees });
      return "ev1";
    },
  };
  const saved: string[] = [];
  const graph = buildGraph({
    structured, mail, k, name: "Jane Example", now: new Date("2026-10-12T08:00:00Z"),
    step: (_n, fn) => fn(),
    saveCv: async (file) => {
      saved.push(file);
      return `u/${file}`;
    },
    callsPerDay: async () => new Map(),
  });
  return { graph, calls, drafts, events, saved };
}

const sub = (over: Partial<Submission>): Submission => ({
  id: "m1", kind: "spec", receivedAt: "2026-10-12T07:00:00Z", name: "Ann", email: "ann@agency.test", company: null, role: null,
  call_preference: null, question: null, spec: "We need a SimCorp front office consultant with IBOR.", ...over,
});

Deno.test("graph: matching spec gets a tailored CV draft with the docx, and a call when asked", async () => {
  const f = fakes({
    spec_reading: frontOffice,
    tailored_cv: goodCv,
    call_preference: { weekdays: ["Wed"], earliest_date: null, latest_date: null, part_of_day: "any" },
  });
  const st = await f.graph.invoke({ sub: sub({ call_preference: "Wednesday works" }) });
  assertEquals(f.calls, ["spec_reading", "tailored_cv", "call_preference"]);
  assert(st.fit!.isMatch);
  assertEquals(f.saved, ["Jane Example CV - SimCorp Front Office Consultant.docx"]);
  assertEquals(f.drafts.length, 1);
  assertMatch(f.drafts[0].raw, /To: ann@agency.test/);
  assertMatch(f.drafts[0].raw, /filename="Jane Example CV - SimCorp Front Office Consultant.docx"/);
  assertEquals(f.events.length, 1);
  assertEquals(f.events[0].calendarId, "net@x");
  assertEquals(f.events[0].start.toISOString(), zoned("2026-10-14", "09:00", agent.call_timezone).toISOString());
  assertEquals(f.events[0].attendees, ["owner@example.test", "ann@agency.test"]);
});

Deno.test("graph: a CV that invents an employer is retried, then refused", async () => {
  const bad = { ...goodCv, experience: [{ ...goodCv.experience[0], employer: "Made Up Ltd" }] };
  const f = fakes({ spec_reading: frontOffice, tailored_cv: bad });
  let err = "";
  try {
    await f.graph.invoke({ sub: sub({}) });
  } catch (e) {
    err = (e as Error).message;
  }
  assertMatch(err, /failed the master CV check/);
  assertEquals(f.calls, ["spec_reading", "tailored_cv", "tailored_cv"]);
  assertEquals(f.drafts.length, 0);
});

Deno.test("graph: no match gets a short reply draft and no CV", async () => {
  const f = fakes({ spec_reading: axioma, no_match_reply: { reply: "Thanks Ann, on paper this is not a match. Fifteen minutes?" } });
  const st = await f.graph.invoke({ sub: sub({}) });
  assert(!st.fit!.isMatch);
  assertEquals(f.calls, ["spec_reading", "no_match_reply"]);
  assertEquals(f.saved.length, 0);
  assertMatch(f.drafts[0].raw, /Subject: Re: Axioma Risk Modeller/);
});

Deno.test("graph: a question without an email is answered but not drafted", async () => {
  const f = fakes({ question_answer: { answer: "Jane works in front office.", in_fact_base: true } });
  const st = await f.graph.invoke({ sub: sub({ kind: "question", question: "What does she do?", email: null, spec: null }) });
  assertEquals(st.answer, "Jane works in front office.");
  assertEquals(f.drafts.length, 0);
});

Deno.test("roles: RSS and JSON sources are scored, filtered and deduplicated", () => {
  const now = new Date("2026-10-12T08:00:00Z");
  const rss = parseRss(`<rss><channel><item><title><![CDATA[Freelance SimCorp consultant, Amsterdam]]></title><link>https://x.test/1</link><pubDate>Sat, 10 Oct 2026 09:00:00 GMT</pubDate><description>Remote friendly interim</description></item></channel></rss>`);
  assertEquals(rss[0].title, "Freelance SimCorp consultant, Amsterdam");
  const src = jobs.sources.find((s) => s.kind === "rss")!;
  const a = scoreItems(src, rss, jobs, now, 30);
  assert(a[0].score > 0);
  const jsonSrc = { ...jobs.sources.find((s) => s.kind === "json" && !s.needs)!, minScore: 0 };
  const b = scoreItems(jsonSrc, parseJson({ [jsonSrc.map!.list]: [{ [jsonSrc.map!.title]: "Freelance SimCorp consultant, Amsterdam" }] }, jsonSrc.map!), jobs, now, 30);
  const merged = dedup([...a, ...b], jobs);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].sources.sort(), [jsonSrc.id, src.id].sort());
  const junior = scoreItems(src, [{ title: "Junior trainee", company: null, link: null, date: null, snippet: "" }], jobs, now, 30);
  assertEquals(junior[0].score, 0);
});

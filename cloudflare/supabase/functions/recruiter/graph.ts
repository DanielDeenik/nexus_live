// The recruiter agent as a LangGraph state graph. One submission per run of
// the graph. Each node is a traced harness step, so the run record shows
// what was read, scored, drafted and booked. The graph writes Gmail drafts
// and calendar invitations only; Dan's Send and Accept are the approvals.
import { Annotation, END, START, StateGraph } from "npm:@langchain/langgraph@1.4.17";
import type { ContentBlock, Structured } from "../_shared/llm.ts";
import { mime } from "../_shared/google.ts";
import { checkCv, cvDocx, cvMarkdown, cvTool, type TailoredCv } from "./cv.ts";
import { type Fit, readingPrompt, readingTool, scoreSpec, type SpecReading } from "./fit.ts";
import type { Knowledge } from "./knowledge.ts";
import { localDate, pickSlot, type Preference, preferenceTool } from "./slots.ts";

export interface Submission {
  id: string; // Gmail message id of the intake mail
  kind: "spec" | "question" | "call";
  receivedAt: string;
  name: string | null;
  email: string | null;
  company: string | null;
  role: string | null;
  call_preference: string | null;
  question: string | null;
  spec: string | null;
}

/** The Google calls the graph needs (the real class, or a stand-in in tests). */
export interface Mail {
  createDraft(raw: Uint8Array): Promise<string>;
  findDraft(to: string, subject: string): Promise<string | null>;
  calendars(): Promise<{ id: string; summary: string; primary?: boolean }[]>;
  busy(ids: string[], from: Date, to: Date): Promise<{ start: string; end: string }[]>;
  eventWithRef(calendarId: string, ref: string, from: Date, to: Date): Promise<string | null>;
  createEvent(calendarId: string, e: { summary: string; description: string; start: Date; end: Date; timeZone: string; attendees: string[]; requestId: string }): Promise<string>;
}

export interface Deps {
  structured: Structured;
  mail: Mail;
  k: Knowledge;
  name: string; // Dan's name as the master CV has it
  now: Date;
  step: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  saveCv: (fileName: string, bytes: Uint8Array) => Promise<string>;
  callsPerDay: () => Promise<Map<string, number>>;
}

export interface Draft {
  to: string;
  subject: string;
  id: string;
}

const State = Annotation.Root({
  sub: Annotation<Submission>(),
  reading: Annotation<SpecReading | null>({ reducer: (_a, b) => b, default: () => null }),
  fit: Annotation<Fit | null>({ reducer: (_a, b) => b, default: () => null }),
  cv: Annotation<TailoredCv | null>({ reducer: (_a, b) => b, default: () => null }),
  cvPath: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  drafts: Annotation<Draft[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  eventId: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  callAt: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  answer: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
});
export type RecruiterState = typeof State.State;

const txt = (text: string): ContentBlock[] => [{ type: "text", text }];

function context(d: Deps, parts: ("fact" | "rules" | "cv" | "tailoring")[]) {
  const map = {
    fact: `FACT BASE (the only facts you may use):\n${d.k.factBase}`,
    rules: `SHARING RULES (bind every word a recruiter can read):\n${d.k.sharingRules}`,
    cv: `MASTER CV (source of every claim; keep every role and date):\n${d.k.cvMaster}`,
    tailoring: `TAILORING RULES:\n${d.k.tailoringRules}`,
  };
  return parts.map((p) => map[p]).join("\n\n");
}

async function draftOnce(d: Deps, to: string, subject: string, text: string, attachment?: { name: string; type: string; bytes: Uint8Array }): Promise<Draft> {
  const existing = await d.mail.findDraft(to, subject);
  if (existing) return { to, subject, id: existing };
  return { to, subject, id: await d.mail.createDraft(mime({ to, subject, text, attachment })) };
}

const recipient = (d: Deps, s: Submission) => s.email ?? d.k.agent.owner_email;

export function buildGraph(d: Deps) {
  const answerQuestion = async (st: RecruiterState) => {
    const s = st.sub;
    const out = await d.step("answer_question", () =>
      d.structured<{ answer: string; in_fact_base: boolean }>(
        context(d, ["fact", "rules"]),
        txt(`A recruiter asked, through Dan's site:\n${s.question ?? ""}\n\nAnswer only from the fact base, under the sharing rules. If it is not in the fact base, say Dan will answer directly. Sign off as Dan.`),
        {
          name: "question_answer",
          description: "The reply to the recruiter's question.",
          input_schema: { type: "object", required: ["answer", "in_fact_base"], properties: { answer: { type: "string" }, in_fact_base: { type: "boolean" } } },
        },
      ));
    const drafts = s.email ? [await d.step("draft_answer", () => draftOnce(d, s.email!, "Re: your question to Dan Deenik", out.value.answer))] : [];
    return { answer: out.value.answer, drafts };
  };

  const assess = async (st: RecruiterState) => {
    const s = st.sub;
    const reading = await d.step("read_spec", () =>
      d.structured<SpecReading>(readingPrompt(d.k.profile), txt(`Role field: ${s.role ?? "(empty)"}\nCompany field: ${s.company ?? "(empty)"}\n\nSPEC:\n${s.spec ?? ""}`), readingTool(d.k.profile)));
    const fit = scoreSpec(reading.value, d.k.profile, d.k.agent);
    return { reading: reading.value, fit };
  };

  const tailor = async (st: RecruiterState) => {
    const s = st.sub;
    const ask = (problems: string[]) =>
      d.structured<TailoredCv>(
        context(d, ["cv", "fact", "rules", "tailoring"]),
        txt([
          `Rewrite the full CV for this spec and write the cover letter, following the tailoring rules exactly.`,
          `Address the letter to ${s.name ?? "Hello"}.`,
          `FIT REPORT (computed from the skill profile; lead with what it says is strongest):\n${st.fit!.report}`,
          `SPEC:\n${s.spec ?? ""}`,
          problems.length ? `Your previous attempt was rejected for: ${problems.join("; ")}. Fix exactly these.` : "",
        ].join("\n\n")),
        cvTool,
      );
    let cv = (await d.step("tailor_cv", () => ask([]))).value;
    let problems = checkCv(cv, d.k.cvMaster);
    if (problems.length) {
      cv = (await d.step("tailor_cv_retry", () => ask(problems))).value;
      problems = checkCv(cv, d.k.cvMaster);
    }
    if (problems.length) throw new Error(`tailored CV failed the master CV check: ${problems.join("; ")}`);
    return { cv };
  };

  const packageCv = async (st: RecruiterState) => {
    const s = st.sub;
    const role = st.reading?.role_title || s.role || "the role";
    const file = `${d.name} CV - ${role.replace(/[\\/:*?"<>|]/g, " ").trim()}.docx`;
    const bytes = await d.step("build_docx", () => cvDocx(st.cv!, d.name));
    const cvPath = await d.step("store_cv", () => d.saveCv(file, bytes));
    const draft = await d.step("draft_application", () =>
      draftOnce(d, recipient(d, s), `${d.name} for ${role}`, st.cv!.cover_letter, {
        name: file,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes,
      }));
    return { cvPath, drafts: [draft] };
  };

  const noMatch = async (st: RecruiterState) => {
    const s = st.sub;
    const nm = d.k.profile.no_match;
    const out = await d.step("no_match_reply", () =>
      d.structured<{ reply: string }>(
        context(d, ["rules"]),
        txt(`Write a short, warm reply to ${s.name ?? "the recruiter"} saying plainly that on paper this is not a logical match, and offering a fifteen minute call instead. Use this framing, in your own words: "${nm.headline} ${nm.body}". Centre of gravity found: ${st.fit!.centre.label}. Sign off as Dan. Under 120 words.`),
        { name: "no_match_reply", description: "The reply.", input_schema: { type: "object", required: ["reply"], properties: { reply: { type: "string" } } } },
      ));
    const role = st.reading?.role_title || s.role || "your role";
    const draft = await d.step("draft_no_match", () => draftOnce(d, recipient(d, s), `Re: ${role}`, out.value.reply));
    return { drafts: [draft] };
  };

  const schedule = async (st: RecruiterState) => {
    const s = st.sub;
    const a = d.k.agent;
    if (!s.email) return {};
    const pref = (await d.step("read_call_preference", () =>
      d.structured<Preference>(
        `Today is ${localDate(d.now, a.call_timezone)} in ${a.call_timezone}.`,
        txt(`Turn this timing request into a window: "${s.call_preference ?? ""}". Leave fields empty or null when it says nothing about them.`),
        preferenceTool,
      ))).value;
    const cals = await d.step("calendars", () => d.mail.calendars());
    const organiser = cals.find((c) => c.summary === a.call_organizer_calendar);
    if (!organiser) throw new Error(`no writable calendar named "${a.call_organizer_calendar}"`);
    const horizon = new Date(d.now.getTime() + (a.call_horizon_days + 1) * 864e5);
    const ref = `Ref ${s.id}`;
    const existing = await d.step("find_invitation", () => d.mail.eventWithRef(organiser.id, ref, d.now, horizon));
    if (existing) return { eventId: existing };
    const busy = await d.step("free_busy", () => d.mail.busy(cals.map((c) => c.id), d.now, horizon));
    const slot = pickSlot(pref, a, busy, await d.callsPerDay(), d.now);
    if (!slot) throw new Error("no free slot in the call window within the horizon");
    const who = s.name ?? s.company ?? s.email;
    const eventId = await d.step("create_invitation", () =>
      d.mail.createEvent(organiser.id, {
        summary: `${a.call_minutes} minute call: ${d.name} and ${who}`,
        description: [s.role ? `Role: ${s.role}` : "", s.company ? `Company: ${s.company}` : "", `Their timing: ${s.call_preference ?? "not given"}`, ref].filter(Boolean).join("\n"),
        start: slot,
        end: new Date(slot.getTime() + a.call_minutes * 60e3),
        timeZone: a.call_timezone,
        attendees: [a.owner_email, s.email!],
        requestId: s.id,
      }));
    return { eventId, callAt: slot.toISOString() };
  };

  const wantsCall = (st: RecruiterState) => Boolean(st.sub.call_preference && st.sub.email);

  return new StateGraph(State)
    .addNode("answer_question", answerQuestion)
    .addNode("assess", assess)
    .addNode("tailor", tailor)
    .addNode("package_cv", packageCv)
    .addNode("no_match", noMatch)
    .addNode("schedule", schedule)
    .addConditionalEdges(START, (st) => (st.sub.kind === "question" ? "answer_question" : st.sub.kind === "spec" ? "assess" : "schedule"),
      ["answer_question", "assess", "schedule"])
    .addEdge("answer_question", END)
    .addConditionalEdges("assess", (st) => (st.fit!.isMatch ? "tailor" : "no_match"), ["tailor", "no_match"])
    .addEdge("tailor", "package_cv")
    .addConditionalEdges("package_cv", (st) => (wantsCall(st) ? "schedule" : END), ["schedule", END])
    .addConditionalEdges("no_match", (st) => (wantsCall(st) ? "schedule" : END), ["schedule", END])
    .addEdge("schedule", END)
    .compile();
}

/** The website mail carries its fields as JSON between these markers. */
export function parseIntake(id: string, receivedAt: string, body: string): Submission | null {
  const m = body.match(/---LENSIQ-JSON---\s*([\s\S]*?)\s*---END---/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[1].replace(/\r?\n/g, ""));
  } catch {
    return null;
  }
  const kind = j.kind;
  if (kind !== "spec" && kind !== "question" && kind !== "call") return null;
  const s = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim() : null);
  return {
    id,
    kind,
    receivedAt: s("received") ?? receivedAt,
    name: s("name"),
    email: s("email"),
    company: s("company"),
    role: s("role"),
    call_preference: s("call_preference"),
    question: s("question"),
    spec: s("spec"),
  };
}

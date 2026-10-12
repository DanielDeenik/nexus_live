// Picks a call slot. The model only turns the recruiter's words ("Tuesday
// or Wednesday morning") into a window; the slot itself is chosen here from
// Dan's call window, lead time, horizon, daily cap and real free/busy.
import type { AgentSettings } from "./knowledge.ts";

export interface Preference {
  weekdays: string[]; // Mon..Sun; empty = any
  earliest_date: string | null; // YYYY-MM-DD
  latest_date: string | null;
  part_of_day: "morning" | "afternoon" | "any";
}

export const preferenceTool = {
  name: "call_preference",
  description: "The recruiter's stated timing turned into a window.",
  input_schema: {
    type: "object",
    required: ["weekdays", "earliest_date", "latest_date", "part_of_day"],
    properties: {
      weekdays: { type: "array", items: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] } },
      earliest_date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
      latest_date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
      part_of_day: { type: "string", enum: ["morning", "afternoon", "any"] },
    },
  },
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutes(tz: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]),
  );
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at.getTime()) / 60000;
}

/** The instant a wall-clock time in `tz` happens. */
export function zoned(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const first = new Date(guess.getTime() - offsetMinutes(tz, guess) * 60000);
  return new Date(guess.getTime() - offsetMinutes(tz, first) * 60000);
}

export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export function pickSlot(
  pref: Preference,
  a: AgentSettings,
  busy: { start: string; end: string }[],
  callsPerDay: Map<string, number>,
  now: Date,
): Date | null {
  const tz = a.call_timezone;
  const earliestAt = new Date(now.getTime() + a.call_lead_hours * 3600e3);
  const today = localDate(now, tz);
  const intervals = busy.map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]);
  const free = (s: Date, e: Date) => intervals.every(([bs, be]) => e.getTime() <= bs || s.getTime() >= be);
  const mid = "12:00"; // morning ends and afternoon starts at noon

  const candidates = (strict: boolean) => {
    const out: Date[] = [];
    for (let i = 0; i <= a.call_horizon_days; i++) {
      const date = addDays(today, i);
      const dow = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
      if (!a.call_window.days.includes(dow)) continue;
      if (strict) {
        if (pref.weekdays.length && !pref.weekdays.includes(dow)) continue;
        if (pref.earliest_date && date < pref.earliest_date) continue;
        if (pref.latest_date && date > pref.latest_date) continue;
      } else if (pref.earliest_date && date < pref.earliest_date) continue;
      if ((callsPerDay.get(date) ?? 0) >= a.call_max_per_day) continue;
      let from = a.call_window.start;
      let to = a.call_window.end;
      if (strict && pref.part_of_day === "morning") to = to < mid ? to : mid;
      if (strict && pref.part_of_day === "afternoon") from = from > mid ? from : mid;
      for (let t = zoned(date, from, tz); t.getTime() + a.call_minutes * 60e3 <= zoned(date, to, tz).getTime(); t = new Date(t.getTime() + 15 * 60e3)) {
        out.push(t);
      }
    }
    return out;
  };

  for (const strict of [true, false]) {
    for (const s of candidates(strict)) {
      const e = new Date(s.getTime() + a.call_minutes * 60e3);
      if (s >= earliestAt && free(s, e)) return s;
    }
  }
  return null;
}

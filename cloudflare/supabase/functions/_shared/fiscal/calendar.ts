// Working-day calendar. Holidays come from public.public_holidays for the
// client's region; standard hours per day come from the owner's profile.

export interface Capacity {
  from: string;
  to: string;
  weekdays: number;
  holidays_on_weekdays: { date: string; name: string }[];
  working_days: number;
  hours: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function* days(from: string, to: string): Generator<Date> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield new Date(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

/** Inclusive of both ends. */
export function workingCapacity(
  from: string,
  to: string,
  holidays: { holiday_date: string; name: string }[],
  hoursPerDay: number,
): Capacity {
  const h = new Map(holidays.map((x) => [x.holiday_date, x.name]));
  let weekdays = 0;
  const hit: { date: string; name: string }[] = [];
  for (const d of days(from, to)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    weekdays++;
    const k = iso(d);
    if (h.has(k)) hit.push({ date: k, name: h.get(k)! });
  }
  const working = weekdays - hit.length;
  return { from, to, weekdays, holidays_on_weekdays: hit, working_days: working, hours: working * hoursPerDay };
}

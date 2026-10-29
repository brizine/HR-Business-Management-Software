/** Sunday-first, matching Date.getDay(). */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * A recurring time someone can't work. Null start means from midnight, null
 * end means until midnight, so both null is the whole day.
 */
export interface AvailabilityRule {
  weekday: number;
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
}

/** A shift's portion of one local day, in minutes from midnight. */
export interface DaySegment {
  weekday: number;
  from: number;
  to: number;
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const fmt = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
};

/** e.g. "All day", "Before 2pm", "After 5pm", "9am–1pm" */
export function describeRule(r: AvailabilityRule) {
  if (!r.startTime && !r.endTime) return "All day";
  if (!r.startTime) return `Before ${fmt(r.endTime!)}`;
  if (!r.endTime) return `After ${fmt(r.startTime)}`;
  return `${fmt(r.startTime)}–${fmt(r.endTime)}`;
}

/** Splits a shift into per-day segments; overnight shifts touch two days. */
export function shiftSegments(start: { weekday: number; minutes: number; date: string }, end: { weekday: number; minutes: number; date: string }): DaySegment[] {
  if (start.date === end.date) return [{ weekday: start.weekday, from: start.minutes, to: end.minutes }];
  const segs: DaySegment[] = [{ weekday: start.weekday, from: start.minutes, to: 1440 }];
  if (end.minutes > 0) segs.push({ weekday: end.weekday, from: 0, to: end.minutes });
  return segs;
}

/** Rules that a shift runs into. */
export function availabilityConflicts(rules: AvailabilityRule[], segments: DaySegment[]) {
  return rules.filter((r) => {
    const from = r.startTime ? toMinutes(r.startTime) : 0;
    const to = r.endTime ? toMinutes(r.endTime) : 1440;
    return segments.some((s) => s.weekday === r.weekday && s.from < to && from < s.to);
  });
}

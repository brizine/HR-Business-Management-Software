/** Calendar date (YYYY-MM-DD) of an instant in the company's time zone. */
export function localDate(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function fmtTime(d: Date, timeZone: string) {
  return d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
}

/** Weekday and month/day/year, e.g. "Mon 11/9/2026". */
export function fmtDayMdy(d: Date, timeZone: string) {
  const weekday = d.toLocaleDateString("en-US", { timeZone, weekday: "short" });
  return `${weekday} ${d.toLocaleDateString("en-US", { timeZone, month: "numeric", day: "numeric", year: "numeric" })}`;
}

/** e.g. "Mon, Nov 2, 7:00 AM – 3:30 PM" */
export function fmtShift(start: Date, end: Date, timeZone: string) {
  const day = start.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  return `${day}, ${fmtTime(start, timeZone)} – ${fmtTime(end, timeZone)}`;
}

/** Local calendar date, weekday (0 = Sunday) and minutes past midnight of an instant. */
export function localParts(d: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** The instant when the clock reads `time` (HH:MM) on `date` (YYYY-MM-DD) in the time zone. */
export function zonedTime(date: string, time: string, timeZone: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const want = Date.UTC(y, m - 1, d, h, min);
  // Start from the wall time read as UTC, then correct by the zone's offset (twice, for DST edges).
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), timeZone);
    const [py, pm, pd] = p.date.split("-").map(Number);
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    t += want - shown;
  }
  return new Date(t);
}

/** YYYY-MM-DD plus `n` days. */
export function addDaysYmd(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

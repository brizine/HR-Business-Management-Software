/** Calendar date (YYYY-MM-DD) of an instant in the company's time zone. */
export function localDate(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function fmtTime(d: Date, timeZone: string) {
  return d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
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

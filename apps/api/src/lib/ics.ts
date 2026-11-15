/** Minimal iCalendar (.ics) feeds, for subscribing to your shifts in Apple/Google Calendar. */

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  /** Timed event (UTC instants) … */
  start?: Date;
  end?: Date;
  /** … or an all-day event: first day and the day after the last (YYYY-MM-DD). */
  allDayStart?: string;
  allDayEndExclusive?: string;
  updated?: Date;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (s: string) => s.replace(/-/g, "");

/** Lines longer than 75 bytes are folded (continued with a leading space), as the format requires. */
function fold(line: string) {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(name: string, events: IcsEvent[], now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crewdesk//Shifts//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${utc(e.updated ?? now)}`);
    if (e.allDayStart) lines.push(`DTSTART;VALUE=DATE:${day(e.allDayStart)}`, `DTEND;VALUE=DATE:${day(e.allDayEndExclusive ?? e.allDayStart)}`, "TRANSP:TRANSPARENT");
    else lines.push(`DTSTART:${utc(e.start!)}`, `DTEND:${utc(e.end!)}`);
    lines.push(`SUMMARY:${esc(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

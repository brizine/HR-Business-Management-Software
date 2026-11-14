"use client";
import { useEffect, useRef, useState } from "react";
import { periodContaining, type PayFrequency } from "@crewdesk/shared";

type Schedule = { frequency: PayFrequency | null; anchorDate: string | null; paydayOffsetDays: number };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const short = (iso: string) => fromIso(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/** A number that goes up by one for each pay period, so neighbours get alternating colours. */
function periodIndex(start: string, s: Schedule) {
  const [y, m, d] = start.split("-").map(Number);
  if (s.frequency === "monthly") return y * 12 + m;
  if (s.frequency === "semimonthly") return (y * 12 + m) * 2 + (d > 15 ? 1 : 0);
  const len = s.frequency === "weekly" ? 7 : 14;
  const anchor = s.anchorDate ?? start;
  return Math.round((Date.UTC(y, m - 1, d) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000 / len);
}

/** "Nov 2 – 15, 2026", "Nov 30 – Dec 13, 2026", "Dec 28, 2026 – Jan 10, 2027". */
export function rangeLabel(start: string, end: string) {
  const a = fromIso(start), b = fromIso(end);
  if (a.getFullYear() !== b.getFullYear()) return `${short(start)}, ${a.getFullYear()} – ${short(end)}, ${b.getFullYear()}`;
  return `${short(start)} – ${a.getMonth() === b.getMonth() ? b.getDate() : short(end)}, ${b.getFullYear()}`;
}

/**
 * Payroll's date picker: a month calendar with each pay period shaded in alternating colours and
 * paydays marked. Clicking a day picks its whole pay period. "Custom dates" picks any range.
 */
export function PayPeriodPicker({ start, end, schedule, onChange, placeholder = "Pick a pay period" }: { start: string; end: string; schedule: Schedule | null; onChange: (start: string, end: string) => void; placeholder?: string }) {
  const hasSchedule = !!schedule?.frequency && (!(schedule.frequency === "weekly" || schedule.frequency === "biweekly") || !!schedule.anchorDate);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [month, setMonth] = useState(() => { const d = start ? fromIso(start) : new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [hover, setHover] = useState<{ start: string; end: string } | null>(null);
  const [draft, setDraft] = useState({ start, end });
  const ref = useRef<HTMLDivElement>(null);
  const today = ymd(new Date());

  useEffect(() => {
    if (!open) return;
    const d = start ? fromIso(start) : new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setDraft({ start, end });
    setCustom(!hasSchedule);
    setHover(null);
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const periodOf = (iso: string) => (hasSchedule ? periodContaining(iso, { frequency: schedule!.frequency!, anchorDate: schedule!.anchorDate, paydayOffsetDays: schedule!.paydayOffsetDays }) : null);
  const pick = (p: { start: string; end: string }) => { onChange(p.start, p.end); setOpen(false); };
  /** The pay period before or after the one shown. */
  const step = (dir: -1 | 1) => {
    const p = periodOf(start || today);
    if (!p) return;
    if (!start) return onChange(p.start, p.end);
    const next = periodOf(ymd(addDays(fromIso(dir < 0 ? p.start : p.end), dir)))!;
    onChange(next.start, next.end);
  };

  // Six weeks starting on the Sunday on or before the 1st.
  const first = addDays(month, -month.getDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i)).filter((d, i) => i < 35 || d.getMonth() === month.getMonth());
  const paydays = new Set<string>();
  if (hasSchedule) {
    // Paydays for periods that end around this month.
    for (let d = addDays(first, -40); d <= addDays(first, 42); d = addDays(d, 7)) paydays.add(periodOf(ymd(d))!.payday);
  }
  const current = start ? periodOf(start) : null;
  const isPeriod = !!current && current.start === start && current.end === end;

  return (
    <div className="weekpicker payperiod-picker" ref={ref}>
      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        {hasSchedule && <button type="button" className="btn" aria-label="Previous pay period" onClick={() => step(-1)}>‹</button>}
        <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
          📅 {start && end ? rangeLabel(start, end) : placeholder}{isPeriod && current && start <= today && today <= end ? " (current period)" : ""} ▾
        </button>
        {hasSchedule && <button type="button" className="btn" aria-label="Next pay period" onClick={() => step(1)}>›</button>}
      </div>
      {open && (
        <div className="weekpicker-pop payperiod-pop" role="dialog" aria-label="Pick a pay period">
          {!custom ? (
            <>
              <div className="weekpicker-head">
                <button type="button" className="btn sm" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
                <strong>{month.toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
                <button type="button" className="btn sm" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
              </div>
              <div className="pp-grid" onMouseLeave={() => setHover(null)}>
                {DAY_NAMES.map((d) => <div key={d} className="pp-dow">{d}</div>)}
                {days.map((d) => {
                  const iso = ymd(d);
                  const p = periodOf(iso)!;
                  const alt = ((periodIndex(p.start, schedule!) % 2) + 2) % 2;
                  const selected = !!start && iso >= start && iso <= end;
                  const hovered = hover && iso >= hover.start && iso <= hover.end;
                  return (
                    <button key={iso} type="button"
                      className={`pp-day pp-${alt ? "b" : "a"}${selected ? " selected" : ""}${hovered ? " hover" : ""}${d.getMonth() !== month.getMonth() ? " other" : ""}${iso === today ? " today" : ""}${iso === p.start ? " first" : ""}${iso === p.end ? " last" : ""}`}
                      onMouseEnter={() => setHover(p)} onFocus={() => setHover(p)} onClick={() => pick(p)}
                      aria-label={`${fromIso(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}: pay period ${rangeLabel(p.start, p.end)}${paydays.has(iso) ? ", payday" : ""}`}>
                      {d.getDate()}
                      {paydays.has(iso) && <span className="pp-payday" aria-hidden>$</span>}
                    </button>
                  );
                })}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {hover ? <>Pay period <strong>{rangeLabel(hover.start, hover.end)}</strong> · payday {short(periodOf(hover.start)!.payday)}</> : <>Each shade is one pay period; <span className="pp-payday-inline">$</span> marks payday. Click a day to pick its period.</>}
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button type="button" className="btn sm" onClick={() => pick(periodOf(today)!)}>Current period</button>
                <button type="button" className="btn sm" onClick={() => setCustom(true)}>Custom dates…</button>
              </div>
            </>
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (draft.start && draft.end && draft.start <= draft.end) pick(draft); }}>
              <strong>Custom Dates</strong>
              {!hasSchedule && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Set up a pay schedule below to pick whole pay periods from a calendar.</p>}
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <label>From<input type="date" value={draft.start} max={draft.end || undefined} onChange={(e) => setDraft({ ...draft, start: e.target.value })} required /></label>
                <label>To<input type="date" value={draft.end} min={draft.start || undefined} onChange={(e) => setDraft({ ...draft, end: e.target.value })} required /></label>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                {hasSchedule ? <button type="button" className="btn sm" onClick={() => setCustom(false)}>← Pay periods</button> : <span />}
                <button className="btn sm primary">Use these dates</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

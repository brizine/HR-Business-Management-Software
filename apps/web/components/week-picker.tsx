"use client";
import { useEffect, useRef, useState } from "react";

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Local midnight on the Monday of the week containing `d`. */
export const mondayOf = (d: Date) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(m, -((m.getDay() + 6) % 7)); };
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * A button showing the chosen week; it opens a month calendar where clicking any day picks its week
 * (Monday to Sunday).
 */
export function WeekPicker({ week, onChange }: { week: Date; onChange: (monday: Date) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(week.getFullYear(), week.getMonth(), 1));
  const [hover, setHover] = useState<Date | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const today = new Date();
  const thisWeek = mondayOf(today);

  useEffect(() => { if (open) setMonth(new Date(week.getFullYear(), week.getMonth(), 1)); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);

  const pick = (d: Date) => { onChange(mondayOf(d)); setOpen(false); };
  const first = mondayOf(month);
  const weeks = Array.from({ length: 6 }, (_, i) => addDays(first, i * 7)).filter((w, i) => i < 4 || w.getMonth() === month.getMonth());
  const end = addDays(week, 6);
  // "Nov 2 – 8, 2026", "Nov 30 – Dec 6, 2026" or "Dec 28, 2026 – Jan 3, 2027".
  const md = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  const label = week.getFullYear() !== end.getFullYear()
    ? `${md(week)}, ${week.getFullYear()} – ${md(end)}, ${end.getFullYear()}`
    : `${md(week)} – ${week.getMonth() === end.getMonth() ? end.getDate() : md(end)}, ${end.getFullYear()}`;

  return (
    <div className="weekpicker" ref={ref}>
      <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        📅 {label}{sameDay(week, thisWeek) ? " (this week)" : ""} ▾
      </button>
      {open && (
        <div className="weekpicker-pop" role="dialog" aria-label="Pick a week">
          <div className="weekpicker-head">
            <button type="button" className="btn sm" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
            <strong>{month.toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
            <button type="button" className="btn sm" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
          </div>
          <table className="weekpicker-grid">
            <thead><tr>{DAY_NAMES.map((d) => <th key={d}>{d}</th>)}</tr></thead>
            <tbody onMouseLeave={() => setHover(null)}>
              {weeks.map((w) => {
                const selected = sameDay(w, week);
                return (
                  <tr key={w.toISOString()} className={`${selected ? "selected" : ""} ${hover && sameDay(w, hover) ? "hover" : ""}`} onMouseEnter={() => setHover(w)}>
                    {DAY_NAMES.map((_, i) => {
                      const d = addDays(w, i);
                      return (
                        <td key={i}>
                          <button type="button" onClick={() => pick(d)} aria-label={`Week of ${w.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}`} aria-pressed={selected}
                            className={`${d.getMonth() !== month.getMonth() ? "other" : ""} ${sameDay(d, today) ? "today" : ""}`}>
                            {d.getDate()}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", gap: 6 }}>
            <button type="button" className="btn sm" onClick={() => pick(addDays(week, -7))}>← Prev week</button>
            <button type="button" className="btn sm" onClick={() => pick(today)}>This week</button>
            <button type="button" className="btn sm" onClick={() => pick(addDays(week, 7))}>Next week →</button>
          </div>
        </div>
      )}
    </div>
  );
}

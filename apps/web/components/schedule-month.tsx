"use client";
import { useMemo, useState } from "react";
import { useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Shifts listed in a day before "+N more". */
const PER_DAY = 4;

type Shift = { id: string; employeeId: string | null; startsAt: string; endsAt: string; status: string; position: string | null; location: string | null; assetName?: string | null; notes: string | null };

/**
 * Month calendar of the schedule: each day lists its shifts (who and when), open shifts, time off
 * and paid holidays. Click a shift to edit it (managers) or pick it up (open shifts); click a day's
 * date to open that week; managers add shifts with the + in a day.
 */
export function ScheduleMonth({ month, onMonthChange: setMonth, refreshKey = 0, meId, manager, keep, nameOf, onShift, onAdd, onOpenWeek }: {
  /** First day of the month shown (the page keeps it, so Change or delete shifts can use it). */
  month: Date;
  onMonthChange: (first: Date) => void;
  /** Changes when shifts were edited elsewhere on the page, to reload. */
  refreshKey?: number;
  meId: string | undefined;
  manager: boolean;
  /** The page's filters: true to show the shift. */
  keep: (s: Shift) => boolean;
  nameOf: (id: string | null) => string;
  onShift: (s: Shift) => void;
  onAdd: (date: string) => void;
  onOpenWeek: (day: Date) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { start, end, days } = useMemo(() => {
    const s = startOfWeek(month);
    const e = addDays(startOfWeek(new Date(month.getFullYear(), month.getMonth() + 1, 0)), 7);
    return { start: s, end: e, days: Array.from({ length: Math.round((e.getTime() - s.getTime()) / 86_400_000) }, (_, i) => addDays(s, i)) };
  }, [month]);
  const list = useApi<{ shift: Shift; assetName: string | null }[]>(`/shifts?from=${start.toISOString()}&to=${end.toISOString()}&k=${refreshKey}`);
  const off = useApi<{ id: string; startDate: string; endDate: string; firstName: string; lastName: string; policyName: string }[]>(`/pto/calendar?from=${ymd(start)}&to=${ymd(addDays(end, -1))}`);
  const hol = useApi<{ upcoming: { name: string; date: string }[] }>(`/holidays?from=${ymd(start)}&to=${ymd(addDays(end, -1))}`);
  const shifts = (list.data ?? []).map((r) => ({ ...r.shift, assetName: r.assetName })).filter(keep);
  const today = ymd(new Date());
  const inMonth = shifts.filter((s) => new Date(s.startsAt).getMonth() === month.getMonth());
  const hours = inMonth.reduce((t, s) => t + (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 3_600_000, 0);

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
          <h2 style={{ margin: 0, minWidth: 190, textAlign: "center" }}>{month.toLocaleDateString([], { month: "long", year: "numeric" })}</h2>
          <button className="btn sm" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
          <button className="btn sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</button>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          {inMonth.length} shift{inMonth.length === 1 ? "" : "s"} · {hours.toFixed(1)} hours · {inMonth.filter((s) => !s.employeeId).length} open
          {manager && inMonth.some((s) => s.status === "draft") ? ` · ${inMonth.filter((s) => s.status === "draft").length} drafts` : ""}
        </span>
      </div>
      <ErrorBox error={list.error} />
      <div className="month-grid" role="grid" aria-label="Month schedule">
        {WEEKDAYS.map((w) => <div key={w} className="month-head" role="columnheader">{w}</div>)}
        {days.map((d) => {
          const key = ymd(d);
          const dayShifts = shifts.filter((s) => ymd(new Date(s.startsAt)) === key).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
          const dayOff = (off.data ?? []).filter((o) => o.startDate <= key && key <= o.endDate);
          const dayHol = (hol.data?.upcoming ?? []).filter((h) => h.date === key);
          const all = expanded === key;
          return (
            <div key={key} role="gridcell" className={`month-day ${d.getMonth() !== month.getMonth() ? "outside" : ""} ${key === today ? "today" : ""}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <button className="month-date" title="Open this week" onClick={() => onOpenWeek(d)}>{d.getDate()}</button>
                {manager && <button className="month-add" title="Add a shift on this day" onClick={() => onAdd(key)}>+</button>}
              </div>
              {dayHol.map((h) => <div key={h.name} className="month-holiday" title="Paid holiday">🎉 {h.name}</div>)}
              {(all ? dayShifts : dayShifts.slice(0, PER_DAY)).map((s) => {
                const clickable = manager || (!s.employeeId && s.status === "published");
                return (
                  <div key={s.id} className={`month-shift ${s.status === "draft" ? "draft" : ""} ${!s.employeeId ? "open" : ""} ${s.employeeId === meId ? "mine" : ""}`}
                    style={{ cursor: clickable ? "pointer" : "default" }} onClick={() => clickable && onShift(s)}
                    title={[`${time(s.startsAt)}–${time(s.endsAt)}`, s.employeeId ? nameOf(s.employeeId) : "Open shift", s.position, s.location, s.assetName, s.notes, s.status === "draft" ? "Draft" : ""].filter(Boolean).join(" · ")}>
                    <strong>{time(s.startsAt)}</strong> {s.employeeId ? nameOf(s.employeeId).split(" ")[0] + (nameOf(s.employeeId).split(" ")[1] ? ` ${nameOf(s.employeeId).split(" ")[1][0]}.` : "") : "Open"}
                  </div>
                );
              })}
              {dayShifts.length > PER_DAY && (
                <button className="month-more" onClick={() => setExpanded(all ? null : key)}>{all ? "Show less" : `+${dayShifts.length - PER_DAY} more`}</button>
              )}
              {dayOff.map((o) => <div key={o.id} className="month-off" title={o.policyName}>🌴 {o.firstName} {o.lastName[0]}.</div>)}
            </div>
          );
        })}
      </div>
      <div className="row muted" style={{ gap: 14, fontSize: 12, flexWrap: "wrap" }}>
        <span><span className="month-key mine" /> Your shift</span>
        <span><span className="month-key" /> Shift</span>
        <span><span className="month-key open" /> Open shift</span>
        {manager && <span><span className="month-key draft" /> Draft (not published)</span>}
        <span>🌴 Time off</span>
        <span>🎉 Paid holiday</span>
        <span>Click a date to open that week.</span>
      </div>
    </div>
  );
}

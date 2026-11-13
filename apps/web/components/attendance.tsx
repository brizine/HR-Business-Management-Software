"use client";
import { useEffect, useState } from "react";
import { ATTENDANCE_LABELS, EARLY_CLOCK_IN_ACTIONS, EARLY_CLOCK_IN_LABELS, OVERRIDE_STATUSES, type AttendanceRules, type AttendanceStatus, type EarlyClockInAction } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type ShiftResult = { start: number; end: number; clockIn: number | null; clockOut: number | null; minutesLate: number; minutesEarly: number; minutesEarlyIn: number; status: string };
type Punch = { id: string; clockIn: string; clockOut: string | null };
export type AttendanceDay = { date: string; status: AttendanceStatus; auto: AttendanceStatus | null; overridden: boolean; note: string | null; points: number; earlyIn: boolean; shifts: ShiftResult[]; punches: Punch[] };
type Points = { total: number; highest: { points: number; label: string } | null; next: { points: number; label: string } | null; nextExpiry: string | null };
export type PersonAttendance = {
  employee: { id: string; firstName: string; lastName: string; title: string | null; department: string | null; active: boolean };
  days: AttendanceDay[];
  summary: { scheduledDays: number; onTime: number; tardy: number; earlyLeave: number; noShow: number; sick: number; excused: number; unscheduled: number; earlyClockIns: number; onTimeRate: number | null; minutesLate: number };
  points: Points;
};
type Response = { rules: AttendanceRules; today: string; people: PersonAttendance[]; canEdit: boolean };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const time = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
/** ISO time ↔ the value of a datetime-local box (local time). */
const toLocalInput = (iso: string | number | null) => { if (iso == null) return ""; const d = new Date(iso); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const longDay = (s: string) => fromIso(s).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/** The colours: green worked, yellow late/left early, red no-show, blue sick, grey excused. */
export const STATUS_CLASS: Record<AttendanceStatus, string> = {
  on_time: "att-green", unscheduled: "att-green-outline", tardy: "att-yellow", early_leave: "att-yellow",
  no_show: "att-red", sick: "att-blue", excused: "att-grey", pending: "att-pending",
};

export function AttendanceLegend() {
  return (
    <div className="att-legend">
      {(["on_time", "tardy", "early_leave", "no_show", "sick", "excused", "unscheduled"] as AttendanceStatus[]).map((s) => (
        <span key={s}><i className={STATUS_CLASS[s]} />{ATTENDANCE_LABELS[s]}</span>
      ))}
    </div>
  );
}

export function PointsSummary({ points, rules }: { points: Points; rules: AttendanceRules }) {
  if (!rules.pointsEnabled) return null;
  return (
    <div className="att-points">
      <div><span className="att-points-num">{points.total}</span> attendance point{points.total === 1 ? "" : "s"}</div>
      <div className="muted" style={{ fontSize: 13 }}>
        {points.highest ? <>Reached <strong>{points.highest.label}</strong> ({points.highest.points}). </> : null}
        {points.next ? <>Next level: {points.next.label} at {points.next.points}. </> : null}
        {points.nextExpiry ? <>Oldest points drop off {fromIso(points.nextExpiry).toLocaleDateString([], { month: "short", day: "numeric" })}. </> : null}
        Points last {rules.pointsExpireDays} days.
      </div>
    </div>
  );
}

/** Owner/admin: change one day (or put it back to what the punches show). */
function DayEditor({ employeeId, date, day, onSaved, onClose }: { employeeId: string; date: string; day: AttendanceDay | undefined; onSaved: () => void; onClose: () => void }) {
  const [status, setStatus] = useState<string>(day?.overridden ? day.status : "");
  const [note, setNote] = useState(day?.note ?? "");
  const [points, setPoints] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form className="stack att-editor" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api("/attendance/override", { method: "PUT", body: { employeeId, date, status: status || null, note: note || undefined, points: points === "" ? null : Number(points) } });
        onSaved();
      });
    }}>
      <strong>Change {longDay(date)}</strong>
      <label>Mark as
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Automatic{day?.auto ? ` (${ATTENDANCE_LABELS[day.auto]})` : " (nothing)"}</option>
          {OVERRIDE_STATUSES.map((s) => <option key={s} value={s}>{ATTENDANCE_LABELS[s]}</option>)}
        </select>
      </label>
      {status && (
        <>
          <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Called at 6:45am" /></label>
          <label>Points for this day<input type="number" min={0} max={10} step={0.5} value={points} onChange={(e) => setPoints(e.target.value)} placeholder="Usual amount" /></label>
        </>
      )}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary sm" disabled={busy}>Save</button><button type="button" className="btn sm" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

/**
 * Managers: fix the punches behind a day (wrong time, forgot to clock in or out, a duplicate).
 * The day's colour and points follow automatically.
 */
function PunchFixer({ employeeId, date, day, onSaved }: { employeeId: string; date: string; day: AttendanceDay | undefined; onSaved: () => void }) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState<string | null>(null); // a punch id, or "new"
  const [inAt, setInAt] = useState("");
  const [outAt, setOutAt] = useState("");
  const open = (p: Punch | null) => {
    const shift = day?.shifts[0];
    setEditing(p ? p.id : "new");
    setInAt(toLocalInput(p ? p.clockIn : shift ? shift.start : `${date}T08:00`));
    setOutAt(toLocalInput(p ? p.clockOut : shift ? shift.end : `${date}T16:30`));
  };
  const save = () => run(async () => {
    const body = { clockIn: fromLocalInput(inAt), clockOut: fromLocalInput(outAt) };
    if (!body.clockIn) throw new Error("Enter the clock-in time");
    if (editing === "new") await api("/time/entries", { body: { ...body, employeeId } });
    else await api(`/time/entries/${editing}`, { method: "PATCH", body });
    setEditing(null);
    onSaved();
  });
  const punches = day?.punches ?? [];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong style={{ fontSize: 14 }}>Punches</strong>
      {punches.length === 0 && editing !== "new" && <span className="muted" style={{ fontSize: 13 }}>No punches this day.</span>}
      {punches.map((p) => editing === p.id ? null : (
        <div key={p.id} className="row" style={{ gap: 8, fontSize: 13 }}>
          <span>In {time(Date.parse(p.clockIn))} · Out {p.clockOut ? time(Date.parse(p.clockOut)) : "— (still clocked in or forgot)"}</span>
          <button type="button" className="btn sm" onClick={() => open(p)}>Fix times</button>
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => confirm("Remove this punch? Use this for a duplicate or a mistake.") && run(async () => { await api(`/time/entries/${p.id}`, { method: "DELETE" }); onSaved(); })}>Remove</button>
        </div>
      ))}
      {editing && (
        <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ width: 210 }}>Clocked in<input type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} /></label>
          <label style={{ width: 210 }}>Clocked out<input type="datetime-local" value={outAt} onChange={(e) => setOutAt(e.target.value)} /></label>
          <button type="button" className="btn primary sm" disabled={busy} onClick={save}>{editing === "new" ? "Add punch" : "Save"}</button>
          <button type="button" className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      )}
      {!editing && <div><button type="button" className="btn sm" onClick={() => open(null)}>+ Add a missed punch</button></div>}
      <ErrorBox error={error} />
      <span className="muted" style={{ fontSize: 12 }}>Changes update the timesheet too (it will need approving again).</span>
    </div>
  );
}

/** A month of one person's attendance: each day coloured; owners/admins click a day to change it. */
export function AttendanceCalendar({ employeeId, compact = false, highlight = "" }: { employeeId: string; compact?: boolean; highlight?: string }) {
  const { can } = useAuth();
  const canFixPunches = can("manager", "time");
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const first = ymd(month);
  const last = ymd(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  const data = useApi<Response>(`/attendance?from=${first}&to=${last}&employeeId=${employeeId}`);
  useEffect(() => { setPicked(null); setEditing(false); }, [employeeId, first]);
  const person = data.data?.people[0];
  const byDate = new Map((person?.days ?? []).map((d) => [d.date, d]));
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)).filter((d, i) => i < 35 || d.getMonth() === month.getMonth());
  const today = data.data?.today ?? ymd(new Date());
  const pickedDay = picked ? byDate.get(picked) : undefined;

  return (
    <div className={`att-calendar${compact ? " compact" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn sm" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <strong>{month.toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
        <button type="button" className="btn sm" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <ErrorBox error={data.error} />
      <div className="att-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="att-dow">{d}</div>)}
        {cells.map((d) => {
          const iso = ymd(d);
          const day = byDate.get(iso);
          const other = d.getMonth() !== month.getMonth();
          // "Show days" filter: dim everything else.
          const dim = !!highlight && !(day && (highlight === "points" ? day.points > 0 : highlight === "changed" ? day.overridden : highlight === "late" ? day.status === "tardy" || day.status === "early_leave" : day.status === highlight));
          return (
            <button key={iso} type="button" disabled={other}
              className={`att-day ${day ? STATUS_CLASS[day.status] : ""}${other ? " other" : ""}${dim ? " dim" : ""}${iso === today ? " today" : ""}${picked === iso ? " picked" : ""}`}
              onClick={() => { setPicked(picked === iso ? null : iso); setEditing(false); }}
              aria-label={`${longDay(iso)}: ${day ? ATTENDANCE_LABELS[day.status] : "nothing scheduled"}`}>
              <span className="att-date">{d.getDate()}</span>
              {!compact && day && <span className="att-label">{ATTENDANCE_LABELS[day.status]}</span>}
              {day && day.points > 0 && <span className="att-pts">{day.points}</span>}
              {day?.overridden && <span className="att-edited" title="Changed by an owner/admin">✎</span>}
              {day?.earlyIn && <span className="att-earlyin" title="Clocked in earlier than allowed">⏰</span>}
            </button>
          );
        })}
      </div>
      <AttendanceLegend />
      {!compact && !picked && (canFixPunches || data.data?.canEdit) && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Click a day to see its punches, fix the times, add a missed punch{data.data?.canEdit ? ", or change its status and points" : ""}.</p>}
      {picked && (
        <div className="card stack att-day-detail" style={{ margin: 0 }}>
          {editing ? (
            <DayEditor employeeId={employeeId} date={picked} day={pickedDay} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); data.reload(); }} />
          ) : (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{longDay(picked)}</strong>
                {data.data?.canEdit && <button className="btn sm" onClick={() => setEditing(true)}>Change status or points</button>}
              </div>
              {pickedDay ? (
                <>
                  <div><span className={`att-chip ${STATUS_CLASS[pickedDay.status]}`}>{ATTENDANCE_LABELS[pickedDay.status]}</span>{pickedDay.points > 0 && <span className="muted"> · {pickedDay.points} point{pickedDay.points === 1 ? "" : "s"}</span>}</div>
                  {pickedDay.overridden && <div className="muted" style={{ fontSize: 13 }}>Set by an owner/admin{pickedDay.auto ? ` (the punches show: ${ATTENDANCE_LABELS[pickedDay.auto]})` : ""}{pickedDay.note ? `. Note: ${pickedDay.note}` : ""}</div>}
                  {pickedDay.shifts.map((s, i) => (
                    <div key={i} className="muted" style={{ fontSize: 13 }}>
                      Scheduled {time(s.start)}–{time(s.end)} · clocked in {time(s.clockIn)}{s.minutesLate ? ` (${s.minutesLate} min late)` : s.minutesEarlyIn ? ` (${s.minutesEarlyIn} min early${pickedDay.earlyIn ? ", earlier than allowed" : ""})` : ""} · out {time(s.clockOut)}{s.minutesEarly ? ` (${s.minutesEarly} min early)` : ""}
                    </div>
                  ))}
                </>
              ) : <div className="muted">Nothing scheduled or recorded.</div>}
              {canFixPunches && <PunchFixer employeeId={employeeId} date={picked} day={pickedDay} onSaved={data.reload} />}
            </>
          )}
        </div>
      )}
      {person && data.data && <PointsSummary points={person.points} rules={data.data.rules} />}
    </div>
  );
}

/** Everyone's attendance for a date range, with totals and points. */
export function AttendanceReport({ onOpen }: { onOpen: (employeeId: string) => void }) {
  const today = new Date();
  const [from, setFrom] = useState(ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)));
  const [to, setTo] = useState(ymd(today));
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("");
  const [title, setTitle] = useState("");
  const [dept, setDept] = useState("");
  const [minPoints, setMinPoints] = useState("");
  const [sort, setSort] = useState("points");
  const defaults = { from: ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: ymd(today) };
  const filtering = !!(q || only || title || dept || minPoints || sort !== "points" || from !== defaults.from || to !== defaults.to);
  const clear = () => { setQ(""); setOnly(""); setTitle(""); setDept(""); setMinPoints(""); setSort("points"); setFrom(defaults.from); setTo(defaults.to); };
  const data = useApi<Response>(`/attendance?from=${from}&to=${to}`);
  const all = data.data?.people ?? [];
  const distinct = (k: "title" | "department") => [...new Set(all.map((p) => p.employee[k]).filter((v): v is string => !!v))].sort();
  const name = (p: PersonAttendance) => `${p.employee.lastName} ${p.employee.firstName}`;
  const sorters: Record<string, (a: PersonAttendance, b: PersonAttendance) => number> = {
    points: (a, b) => b.points.total - a.points.total || name(a).localeCompare(name(b)),
    name: (a, b) => name(a).localeCompare(name(b)),
    rate: (a, b) => (a.summary.onTimeRate ?? 101) - (b.summary.onTimeRate ?? 101) || name(a).localeCompare(name(b)),
    noshow: (a, b) => b.summary.noShow - a.summary.noShow || name(a).localeCompare(name(b)),
    late: (a, b) => b.summary.tardy - a.summary.tardy || b.summary.minutesLate - a.summary.minutesLate || name(a).localeCompare(name(b)),
  };
  const rows = all
    .filter((p) => !q.trim() || `${p.employee.firstName} ${p.employee.lastName} ${p.employee.title ?? ""} ${p.employee.department ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((p) => (!title || p.employee.title === title) && (!dept || p.employee.department === dept) && (!minPoints || p.points.total >= Number(minPoints)))
    .filter((p) => !only || (only === "issues" ? p.summary.tardy + p.summary.earlyLeave + p.summary.noShow > 0 : only === "noshow" ? p.summary.noShow > 0 : only === "late" ? p.summary.tardy + p.summary.earlyLeave > 0 : only === "sick" ? p.summary.sick > 0 : only === "level" ? !!p.points.highest : only === "perfect" ? p.summary.scheduledDays > 0 && p.summary.onTime === p.summary.scheduledDays : true))
    .sort(sorters[sort]);
  return (
    <>
      <form className="card filters" role="search" aria-label="Attendance report" onSubmit={(e) => e.preventDefault()}>
        <label>Search<input type="search" placeholder="Name, job title, department…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label>Job title
          <select value={title} onChange={(e) => setTitle(e.target.value)}>
            <option value="">All</option>
            {distinct("title").map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Department
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">All</option>
            {distinct("department").map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <fieldset className="pay-range date-range">
          <legend>Dates</legend>
          <input type="date" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </fieldset>
        <label>Show
          <select value={only} onChange={(e) => setOnly(e.target.value)}>
            <option value="">Everyone</option>
            <option value="issues">Late, left early or no-show</option>
            <option value="late">Late or left early</option>
            <option value="noshow">Had a no-show</option>
            <option value="sick">Called in sick</option>
            <option value="perfect">Perfect attendance</option>
            <option value="level">Reached a point level</option>
          </select>
        </label>
        {data.data?.rules.pointsEnabled && (
          <label>Points
            <select value={minPoints} onChange={(e) => setMinPoints(e.target.value)}>
              <option value="">Any</option>
              {[0.5, 1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n} or more</option>)}
            </select>
          </label>
        )}
        <label>Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="points">Most points</option>
            <option value="noshow">Most no-shows</option>
            <option value="late">Most late arrivals</option>
            <option value="rate">Lowest on-time rate</option>
            <option value="name">Name</option>
          </select>
        </label>
        {filtering && <button type="button" className="btn" onClick={clear}>Clear filters</button>}
      </form>
      <div className="card tablewrap">
        <ErrorBox error={data.error} />
        {data.data && <p className="muted" role="status" style={{ margin: "0 0 8px", fontSize: 13 }}>{rows.length === all.length ? `${all.length} people` : `Showing ${rows.length} of ${all.length} people`}</p>}
        {rows.length ? (
          <table className="att-report">
            <thead><tr><th>Employee</th><th>Scheduled</th><th className="att-c-green">On time</th><th className="att-c-yellow">Late</th><th className="att-c-yellow">Left early</th><th className="att-c-red">No-show</th><th className="att-c-blue">Sick</th><th>Excused</th><th title="Clocked in earlier than the early buffer allows">Early in</th><th>On-time rate</th>{data.data?.rules.pointsEnabled && <th>Points</th>}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.employee.id} onClick={() => onOpen(p.employee.id)} style={{ cursor: "pointer" }}>
                <td><strong>{p.employee.firstName} {p.employee.lastName}</strong>{p.employee.title && <div className="muted" style={{ fontSize: 12 }}>{p.employee.title}</div>}</td>
                <td>{p.summary.scheduledDays}</td>
                <td>{p.summary.onTime}</td>
                <td>{p.summary.tardy}{p.summary.minutesLate ? <div className="muted" style={{ fontSize: 12 }}>{p.summary.minutesLate} min</div> : null}</td>
                <td>{p.summary.earlyLeave}</td>
                <td>{p.summary.noShow}</td>
                <td>{p.summary.sick}</td>
                <td>{p.summary.excused}</td>
                <td>{p.summary.earlyClockIns || "—"}</td>
                <td>{p.summary.onTimeRate == null ? "—" : `${p.summary.onTimeRate}%`}</td>
                {data.data?.rules.pointsEnabled && <td><strong>{p.points.total}</strong>{p.points.highest && <div className={`att-level`}>{p.points.highest.label}</div>}</td>}
              </tr>
            ))}</tbody>
          </table>
        ) : data.data ? <Empty>No one matches.</Empty> : null}
        <p className="muted" style={{ fontSize: 13 }}>Counts are for the dates above; points are everyone&apos;s current total (the last {data.data?.rules.pointsExpireDays ?? 90} days). Click someone to see their calendar.</p>
      </div>
    </>
  );
}

/** Owner/admin settings: grace periods, alerts and points. */
export function AttendanceRulesForm() {
  const { can } = useAuth();
  const admin = can("admin", "time");
  const data = useApi<AttendanceRules>("/attendance/rules");
  const [r, setR] = useState<AttendanceRules | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (data.data) setR(data.data); }, [data.data]);
  if (!r) return <ErrorBox error={data.error} />;
  const set = (patch: Partial<AttendanceRules>) => { setR({ ...r, ...patch }); setSaved(false); };
  const num = (k: keyof AttendanceRules, label: string, hint: string, props: { min?: number; max?: number; step?: number } = {}) => (
    <label>{label}
      <input type="number" value={r[k] as number} onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<AttendanceRules>)} min={props.min ?? 0} max={props.max} step={props.step ?? 1} />
      <span className="muted" style={{ fontSize: 12 }}>{hint}</span>
    </label>
  );
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { data.setData(await api<AttendanceRules>("/attendance/rules", { method: "PUT", body: r })); setSaved(true); }); }}>
      <fieldset disabled={!admin} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <h2 style={{ margin: 0 }}>Grace periods (buffers)</h2>
        <div className="formgrid">
          {num("graceMinutes", "Late buffer (minutes)", "Clocking in up to this many minutes after a shift starts still counts as on time.", { max: 120 })}
          {num("earlyLeaveGraceMinutes", "Leaving-early buffer (minutes)", "Clocking out up to this many minutes before a shift ends still counts as on time.", { max: 240 })}
          {num("noShowMinutes", "No-show after (minutes)", "Not clocked in this long after a shift starts: alert, and it counts as a no-show.", { min: 5, max: 720 })}
        </div>
        <label className="check"><input type="checkbox" checked={r.alertsEnabled} onChange={(e) => set({ alertsEnabled: e.target.checked })} /> Alert managers (and the employee) when someone hasn&apos;t clocked in by then</label>

        <h2 style={{ margin: "8px 0 0" }}>Clocking in early</h2>
        <div className="formgrid">
          {num("earlyClockInMinutes", "Clock-in early buffer (minutes)", "Clocking in up to this many minutes before a shift is fine. Earlier counts as clocking in early. 0 means no limit.", { max: 240 })}
          <label>When someone clocks in earlier
            <select value={r.earlyClockInAction} onChange={(e) => set({ earlyClockInAction: e.target.value as EarlyClockInAction })} disabled={!r.earlyClockInMinutes}>
              {EARLY_CLOCK_IN_ACTIONS.map((a) => <option key={a} value={a}>{EARLY_CLOCK_IN_LABELS[a]}</option>)}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>{r.earlyClockInAction === "block" ? "The time clock tells them when their shift starts and when they can clock in. Managers can still add a punch." : "Shown with ⏰ on the calendar and counted in the report."}</span>
          </label>
          {r.earlyClockInAction === "points" && num("earlyClockInPoints", "Early clock-in points", "Points each time (added to the day's other points).", { max: 10, step: 0.25 })}
        </div>

        <h2 style={{ margin: "8px 0 0" }}>Attendance points</h2>
        <label className="check"><input type="checkbox" checked={r.pointsEnabled} onChange={(e) => set({ pointsEnabled: e.target.checked })} /> Use attendance points</label>
        {r.pointsEnabled && (
          <>
            <div className="formgrid">
              {num("tardyPoints", "Late", "Points per late arrival.", { max: 10, step: 0.25 })}
              {num("earlyLeavePoints", "Left early", "Points per early departure.", { max: 10, step: 0.25 })}
              {num("noShowPoints", "No-show", "Points per no-show.", { max: 10, step: 0.25 })}
              {num("sickPoints", "Called in sick", "Points per sick day (0 for none).", { max: 10, step: 0.25 })}
              {num("pointsExpireDays", "Points last (days)", "Each point drops off this many days after it's earned.", { min: 7, max: 730 })}
            </div>
            <strong>Bigger amounts for bigger misses</strong>
            <div className="formgrid">
              {num("lateTierMinutes", "Very late at (minutes)", "This late or more earns the very-late points instead. 0 turns it off.", { max: 720 })}
              {num("lateTierPoints", "Very late points", "Points for a very late arrival.", { max: 10, step: 0.25 })}
              {num("earlyTierMinutes", "Left very early at (minutes)", "Leaving this early or more earns the very-early points instead. 0 turns it off.", { max: 720 })}
              {num("earlyTierPoints", "Left very early points", "Points for leaving very early.", { max: 10, step: 0.25 })}
            </div>
            <label className="check"><input type="checkbox" checked={r.countLateAndEarly} onChange={(e) => set({ countLateAndEarly: e.target.checked })} /> When someone is late <em>and</em> leaves early the same day, give points for both (otherwise only for being late)</label>
            <div className="stack">
              <strong>Point levels</strong>
              <span className="muted" style={{ fontSize: 13 }}>Managers are alerted when someone reaches a level.</span>
              {r.thresholds.map((t, i) => (
                <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
                  <input type="number" min={0.5} max={100} step={0.5} value={t.points} aria-label="Points" style={{ width: 90 }}
                    onChange={(e) => set({ thresholds: r.thresholds.map((x, j) => (j === i ? { ...x, points: Number(e.target.value) } : x)) })} />
                  <span className="muted">points:</span>
                  <input value={t.label} maxLength={80} aria-label="What it means" style={{ flex: 1 }} placeholder="e.g. Written warning"
                    onChange={(e) => set({ thresholds: r.thresholds.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <button type="button" className="btn sm" aria-label="Remove level" onClick={() => set({ thresholds: r.thresholds.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              {r.thresholds.length < 10 && <div><button type="button" className="btn sm" onClick={() => set({ thresholds: [...r.thresholds, { points: (r.thresholds.at(-1)?.points ?? 0) + 2, label: "" }] })}>Add a level</button></div>}
            </div>
          </>
        )}
      </fieldset>
      <ErrorBox error={error} />
      {admin ? <div className="row"><button className="btn primary" disabled={busy}>Save attendance settings</button>{saved && <span className="muted" role="status">Saved.</span>}</div>
        : <p className="muted" style={{ margin: 0 }}>Only owners and admins can change these.</p>}
    </form>
  );
}

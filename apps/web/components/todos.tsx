"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_TODO_COLOR, MONTH_NAMES, NTH_OPTIONS, TODO_COLORS, TODO_FREQS, TODO_FREQ_LABELS, VISIT_FILE_MAX_BYTES, WEEKDAY_NAMES, WEEKDAY_ORDER,
  formatAddress, formatMinutes, formatMonthDay, formatTodoTime, isInactive, previewSeries, ruleDates, todoState, trackedMinutes,
  type TodoEnd, type TodoFreq,
} from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { CustomerPicker } from "./customers";
import { Icon } from "./icons";
import { ErrorBox } from "./ui";

export interface Todo {
  id: string; title: string; notes: string | null; color: string;
  date: string; endDate: string | null; startTime: string | null; endTime: string | null; budgetedHours: number | null;
  customerId: string | null; propertyId: string | null; location: string | null; categoryId: string | null; crewId: string | null;
  seriesId: string | null; repeat: string; repeatLabel: string | null; doneAt: string | null; createdById: string | null;
  startedAt: string | null; trackedSeconds: number; trackedMinutes: number; fileCount: number; noteCount: number;
  customer: { id: string; name: string } | null;
  property: { id: string; name: string | null; address: string; gateCode: string | null; accessNotes?: string | null; notes?: string | null } | null;
  category: { id: string; name: string } | null;
  crew: { id: string; name: string; color: string } | null;
  assignees: { id: string; firstName: string; lastName: string }[];
  doneBy: string | null; createdBy: string | null;
}
export interface Category { id: string; name: string; todoCount?: number }
export interface Season { id: string; name: string; start: string; end: string }

/** Tells the top bar's to-do count (and any open to-do lists) that something changed. */
export const todosChanged = () => window.dispatchEvent(new Event("crewdesk:todos"));

const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const nthOf = (d: string) => { const n = Math.ceil(Number(d.slice(8)) / 7); return n > 4 ? -1 : n; };
export const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });

/** "Mon, Nov 23 · 8:00 AM – 9:30 AM", "Mon, Nov 23 – Wed, Nov 25". */
export function todoWhen(t: Pick<Todo, "date" | "endDate" | "startTime" | "endTime">) {
  const days = t.endDate && t.endDate !== t.date ? `${dayLabel(t.date)} – ${dayLabel(t.endDate)}` : dayLabel(t.date);
  return [days, formatTodoTime(t.startTime, t.endTime)].filter(Boolean).join(" · ");
}
const placeOf = (t: Todo) => t.property?.address ?? t.location;
export const todoPeople = (t: Todo) => t.assignees.map((a) => `${a.firstName} ${a.lastName}`).join(", ");

/** The checkbox that ticks a to-do off (or back on). */
export function DoneBox({ t, onChange }: { t: Todo; onChange: (t: Todo) => void }) {
  // Ticks at once; goes back if saving fails.
  const [on, setOn] = useState(!!t.doneAt);
  useEffect(() => { setOn(!!t.doneAt); }, [t.doneAt]);
  return (
    <input type="checkbox" className="todo-check" checked={on} aria-label={on ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`}
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        const done = e.target.checked;
        setOn(done);
        try { onChange(await api<Todo>(`/todos/${t.id}/done`, { method: "POST", body: { done } })); todosChanged(); } catch (err) { setOn(!done); alert((err as Error).message); }
      }} />
  );
}

/** One to-do in a list: color, checkbox, title, then when / where / who. */
export function TodoItem({ t, today, onChange, onOpen, open, showDate, extra, children }: {
  t: Todo; today: string; onChange: (t: Todo) => void; onOpen?: () => void; open?: boolean; showDate?: boolean; extra?: string; children?: ReactNode;
}) {
  const state = todoState(t, today);
  const time = showDate ? todoWhen(t) : [t.endDate && t.endDate !== t.date ? `${dayLabel(t.date)} – ${dayLabel(t.endDate)}` : null, formatTodoTime(t.startTime, t.endTime)].filter(Boolean).join(" · ");
  const meta = [
    time || null,
    t.customer?.name, placeOf(t),
    t.crew ? t.crew.name : null,
    t.assignees.length ? todoPeople(t) : "Nobody assigned",
    t.budgetedHours ? `${t.budgetedHours} h` : null,
    extra,
  ].filter(Boolean).join(" · ");
  return (
    <li id={`todo-${t.id}`} className={`todo-item${t.doneAt ? " done" : ""}${open ? " open" : ""}`} style={{ borderLeftColor: t.color }}>
      <div className="todo-line" onClick={onOpen} role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined}
        onKeyDown={(e) => { if (onOpen && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }} aria-expanded={onOpen ? !!open : undefined}>
        <DoneBox t={t} onChange={onChange} />
        <div className="todo-text">
          <div className="todo-title">
            {t.title}
            {t.category && <span className="todo-cat">{t.category.name}</span>}
            {t.seriesId && <span className="todo-repeat" title={t.repeatLabel ?? "Repeats"} aria-label={t.repeatLabel ?? "Repeats"}>↻</span>}
            {t.startedAt && !t.doneAt && <span className="badge ok" title="Work started">working</span>}
            {state === "overdue" && <span className="badge bad">overdue</span>}
            {t.fileCount > 0 && <span className="muted todo-count" title={`${t.fileCount} photo${t.fileCount === 1 ? "" : "s"} or document${t.fileCount === 1 ? "" : "s"}`}>📎 {t.fileCount}</span>}
            {t.noteCount > 0 && <span className="muted todo-count" title={`${t.noteCount} note${t.noteCount === 1 ? "" : "s"} for the dispatcher`}>💬 {t.noteCount}</span>}
          </div>
          <div className="muted todo-meta">{meta}</div>
        </div>
      </div>
      {children}
    </li>
  );
}

/** The details under an opened to-do: notes, gate code, who made it, and Job sheet / Edit / Delete. */
export function TodoDetails({ t, onEdit, onDeleted }: { t: Todo; onEdit: () => void; onDeleted: () => void }) {
  const { me, can } = useAuth();
  const del = useAction();
  const canEdit = can("manager", "todos") || t.createdById === me?.user.id;
  const remove = (scope: "one" | "following") => del.run(async () => {
    const r = await api<{ deleted: number }>(`/todos/${t.id}?scope=${scope}`, { method: "DELETE" });
    todosChanged();
    onDeleted();
    return r;
  });
  return (
    <div className="todo-details">
      {t.notes && <p className="todo-notes">{t.notes}</p>}
      <dl className="facts">
        {t.customer && <><dt>Customer</dt><dd>{can("manager", "customers") ? <Link href={`/customers/${t.customer.id}`}>{t.customer.name}</Link> : t.customer.name}</dd></>}
        {t.property && <><dt>Property</dt><dd>{can("manager", "customers") ? <Link href={`/properties/${t.property.id}`}>{t.property.address}</Link> : t.property.address}{t.property.gateCode ? ` · gate code ${t.property.gateCode}` : ""}</dd></>}
        {!t.property && t.location && <><dt>Location</dt><dd>{t.location}</dd></>}
        <dt>When</dt><dd>{todoWhen(t)}</dd>
        {t.repeatLabel && <><dt>Repeats</dt><dd>{t.repeatLabel}</dd></>}
        {t.category && <><dt>Category</dt><dd>{t.category.name}</dd></>}
        {t.crew && <><dt>Crew</dt><dd>{t.crew.name}</dd></>}
        <dt>For</dt><dd>{t.assignees.length ? todoPeople(t) : "Nobody in particular"}</dd>
        {t.budgetedHours != null && <><dt>Budgeted</dt><dd>{t.budgetedHours} hour{t.budgetedHours === 1 ? "" : "s"}</dd></>}
        {(t.trackedMinutes > 0 || t.startedAt) && <><dt>Tracked</dt><dd>{formatMinutes(t.trackedMinutes)}{t.startedAt && !t.doneAt ? " · running" : ""}</dd></>}
        {t.createdBy && <><dt>Made by</dt><dd>{t.createdBy}</dd></>}
        {t.doneAt && <><dt>Done</dt><dd>{new Date(t.doneAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{t.doneBy ? ` by ${t.doneBy}` : ""}</dd></>}
      </dl>
      <div className="row">
        <Link className="btn primary" href={`/todos/${t.id}`}>Open job sheet</Link>
        {canEdit && <button type="button" className="btn" onClick={onEdit}>Edit</button>}
        {canEdit && (t.seriesId ? (
          <>
            <button type="button" className="btn danger" disabled={del.busy} onClick={() => confirm("Delete just this one?") && remove("one")}>Delete this one</button>
            <button type="button" className="btn danger" disabled={del.busy} onClick={() => confirm("Delete this one and the later ones that aren't done? The series stops.") && remove("following")}>Delete this and later</button>
          </>
        ) : <button type="button" className="btn danger" disabled={del.busy} onClick={() => confirm("Delete this to-do?") && remove("one")}>Delete</button>)}
      </div>
      <ErrorBox error={del.error} />
    </div>
  );
}

/** Homeworks' 15 named colors. */
function ColorPicker({ color, setColor }: { color: string; setColor: (c: string) => void }) {
  const named = TODO_COLORS.find((c) => c.key === color.toLowerCase());
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="todo-label">Color{named ? `: ${named.label}` : ""}</span>
      <div className="todo-colors" role="radiogroup" aria-label="Color">
        {TODO_COLORS.map((c) => (
          <button key={c.key} type="button" role="radio" aria-checked={color.toLowerCase() === c.key} aria-label={c.label} title={c.label}
            style={{ background: c.key }} onClick={() => setColor(c.key)} />
        ))}
      </div>
    </div>
  );
}

/**
 * Homeworks' chart beside the date: budgeted hours already booked each week (to-dos and work orders)
 * for the people picked, so you can see a light week. One series, so no legend; hover for the number.
 */
function WeeklyHours({ from, ids, hours, dates, notId }: { from: string; ids: string[]; hours: number; dates: string[]; notId?: string }) {
  const data = useApi<{ start: string; end: string; hours: number }[]>(from ? `/todos/workload?from=${from}&weeks=5${ids.length ? `&ids=${ids.join(",")}` : ""}${notId ? `&not=${notId}` : ""}` : null);
  const weeks = data.data ?? [];
  // This to-do's hours, on each week it falls in (a series can land in several, or skip some).
  const extraFor = (w: { start: string; end: string }) => Math.round(hours * dates.filter((d) => d >= w.start && d <= w.end).length * 100) / 100;
  const max = Math.max(1, ...weeks.map((w) => w.hours + extraFor(w)));
  const adding = weeks.some((w) => extraFor(w) > 0);
  const who = ids.length ? "for the people picked" : "for everyone you can see";
  const summary = weeks.map((w) => `${shortDay(w.start)}–${shortDay(w.end)}: ${w.hours} h`).join("; ");
  return (
    <figure className="todo-hours" aria-label={`Budgeted hours booked each week ${who}. ${summary}`}>
      <figcaption className="todo-label">Budgeted hours already booked {who}</figcaption>
      <div className="todo-hours-bars" role="img" aria-label={summary}>
        {weeks.map((w, i) => {
          const extra = extraFor(w);
          return (
            <div key={w.start} className="todo-hours-col" title={`${shortDay(w.start)} – ${shortDay(w.end)}: ${w.hours} h booked${extra ? ` + ${extra} h for this to-do` : ""}`}>
              <span className="todo-hours-val">{w.hours + extra ? `${Math.round((w.hours + extra) * 10) / 10}` : ""}</span>
              <div className="todo-hours-track">
                {extra > 0 && <div className="todo-hours-bar adding" style={{ height: `${(extra / max) * 100}%` }} />}
                <div className="todo-hours-bar" style={{ height: `${(w.hours / max) * 100}%` }} />
              </div>
              <span className="todo-hours-week">{i === 0 ? "This week" : `+${i} wk`}<br />{shortDay(w.start)}</span>
            </div>
          );
        })}
      </div>
      {adding && <p className="muted" style={{ margin: 0, fontSize: 12 }}>The lighter part of a bar is this to-do{dates.length > 1 ? " (each week it falls in)" : ""}.</p>}
    </figure>
  );
}

/** "To-do Category" with Homeworks' "Add New Category" (managers). */
function CategoryPicker({ value, setValue }: { value: string; setValue: (v: string) => void }) {
  const { can } = useAuth();
  const list = useApi<Category[]>("/todos/categories");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const save = useAction();
  const add = () => save.run(async () => {
    const c = await api<Category>("/todos/categories", { method: "POST", body: { name } });
    await list.reload();
    setValue(c.id); setAdding(false); setName("");
  });
  return (
    <div className="stack" style={{ gap: 4 }}>
      <label>To-do category
        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <select value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }}>
            <option value="">No category</option>
            {(list.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {can("manager", "todos") && !adding && <button type="button" className="btn" onClick={() => setAdding(true)}>Add new category</button>}
        </div>
      </label>
      {adding && (
        <div className="row" style={{ gap: 8 }}>
          <input autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop, Office, Equipment…" aria-label="New category name"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (name.trim()) add(); } }} />
          <button type="button" className="btn primary" disabled={!name.trim() || save.busy} onClick={add}>Add</button>
          <button type="button" className="btn" onClick={() => { setAdding(false); setName(""); }}>Cancel</button>
        </div>
      )}
      <ErrorBox error={save.error} />
    </div>
  );
}

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const pad = (n: number) => String(n).padStart(2, "0");
/** "Pause during off-season" with the saved seasons, and Homeworks' "Add Season". */
function SeasonPicker({ on, setOn, value, setValue, seasons, reload }: {
  on: boolean; setOn: (b: boolean) => void; value: string; setValue: (v: string) => void; seasons: Season[]; reload: () => Promise<unknown>;
}) {
  const { can } = useAuth();
  const keeper = can("manager", "todos") || can("manager", "customers");
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({ name: "", sm: 12, sd: 1, em: 2, ed: 28 });
  const save = useAction();
  const add = () => save.run(async () => {
    const s = await api<Season>("/off-seasons", { method: "POST", body: { name: v.name, start: `${pad(v.sm)}-${pad(v.sd)}`, end: `${pad(v.em)}-${pad(v.ed)}` } });
    await reload();
    setValue(s.id); setAdding(false);
  });
  const monthSel = (m: number, set: (n: number) => void, label: string) => (
    <select aria-label={label} value={m} onChange={(e) => set(Number(e.target.value))}>{MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}</select>
  );
  const daySel = (d: number, set: (n: number) => void, label: string) => (
    <select aria-label={label} value={d} onChange={(e) => set(Number(e.target.value))}>{MONTH_DAYS.map((n) => <option key={n} value={n}>{n}</option>)}</select>
  );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="check switch"><input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); if (e.target.checked && !value && seasons[0]) setValue(seasons[0].id); }} /> Pause during off-season</label>
      {on && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <select aria-label="Off-season" value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }}>
              <option value="">Select off-season</option>
              {seasons.map((s) => <option key={s.id} value={s.id}>{s.name} · {formatMonthDay(s.start)} – {formatMonthDay(s.end)}</option>)}
            </select>
            {keeper && !adding && <button type="button" className="btn" onClick={() => setAdding(true)}>Add season</button>}
          </div>
          {adding && (
            <div className="todo-season-new">
              <label>Name of the off-season<input autoFocus maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Winter" /></label>
              <div className="row" style={{ gap: 6 }}><span className="todo-label" style={{ minWidth: 110 }}>Start month &amp; day</span>{monthSel(v.sm, (n) => setV({ ...v, sm: n }), "Start month")}{daySel(v.sd, (n) => setV({ ...v, sd: n }), "Start day")}</div>
              <div className="row" style={{ gap: 6 }}><span className="todo-label" style={{ minWidth: 110 }}>End month &amp; day</span>{monthSel(v.em, (n) => setV({ ...v, em: n }), "End month")}{daySel(v.ed, (n) => setV({ ...v, ed: n }), "End day")}</div>
              <div className="row"><button type="button" className="btn primary" disabled={!v.name.trim() || save.busy} onClick={add}>Add season</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
              <ErrorBox error={save.error} />
            </div>
          )}
          {!seasons.length && !adding && <p className="muted" style={{ margin: 0 }}>No off-seasons yet.{keeper ? " Add one, like Winter from December 1 to February 28." : " A manager can add them."}</p>}
        </>
      )}
    </div>
  );
}

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf,video/mp4,video/quicktime";

/**
 * Add or change a to-do, laid out like Homeworks': what it is; customer, property, color and location;
 * scheduling (single or a recurring series, with every Homeworks repeat option, how it ends, pausing in
 * an off-season, the first and last dates, and the hours already booked each week); category; notes;
 * crew and employees; photos and documents.
 */
export function TodoForm({ todo, preset, today, onSaved, onCancel }: {
  todo?: Todo; preset?: { customer?: { id: string; name: string }; propertyId?: string; date?: string };
  today?: string; onSaved: (t: Todo, created: number) => void; onCancel: () => void;
}) {
  const { me, can } = useAuth();
  const manager = can("manager", "todos");
  const canCustomers = can("manager", "customers");
  const start = todo?.date ?? preset?.date ?? today ?? localToday();
  const [title, setTitle] = useState(todo?.title ?? "");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(todo?.customer ?? preset?.customer ?? null);
  const [propertyId, setPropertyId] = useState(todo?.propertyId ?? preset?.propertyId ?? "");
  const [location, setLocation] = useState(todo?.location ?? "");
  const [color, setColor] = useState(todo?.color ?? DEFAULT_TODO_COLOR);
  const [scheduling, setScheduling] = useState<"single" | "repeat">("single");
  const [date, setDate] = useState(start);
  const [multi, setMulti] = useState(!!todo?.endDate);
  const [endDate, setEndDate] = useState(todo?.endDate ?? plusDays(start, 1));
  const [timed, setTimed] = useState(!!todo?.startTime);
  const [startTime, setStartTime] = useState(todo?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState(todo?.endTime ?? "");
  const [hours, setHours] = useState(todo?.budgetedHours != null ? String(todo.budgetedHours) : "");
  // The repeat (Homeworks' "Recurring Series of To-do").
  const [freq, setFreq] = useState<TodoFreq>("weekly");
  const [every, setEvery] = useState("1");
  const [weekdaysOnly, setWeekdaysOnly] = useState(false);
  const [weekdays, setWeekdays] = useState<number[]>([weekdayOf(start)]);
  const [by, setBy] = useState<"day" | "nth">("day");
  const [monthDay, setMonthDay] = useState(Number(start.slice(8)));
  const [nth, setNth] = useState(nthOf(start));
  const [weekday, setWeekday] = useState(weekdayOf(start));
  const [month, setMonth] = useState(Number(start.slice(5, 7)));
  const [end, setEnd] = useState<TodoEnd>("date");
  const [until, setUntil] = useState(plusDays(start, 30));
  const [count, setCount] = useState("10");
  const [pause, setPause] = useState(false);
  const [seasonId, setSeasonId] = useState("");
  const seasons = useApi<Season[]>(todo ? null : "/off-seasons");
  // The rest.
  const [categoryId, setCategoryId] = useState(todo?.categoryId ?? "");
  const [notes, setNotes] = useState(todo?.notes ?? "");
  const [crewId, setCrewId] = useState(todo?.crewId ?? "");
  const [assignees, setAssignees] = useState<string[]>(todo ? todo.assignees.map((a) => a.id) : manager || !me ? [] : [me.user.id]);
  const [applyTo, setApplyTo] = useState<"one" | "following">("one");
  const [pending, setPending] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useAction();
  const detail = useApi<any>(customer && canCustomers ? `/customers/${customer.id}` : null);
  const staff = useApi<any[]>(manager ? "/employees" : null);
  const crews = useApi<{ id: string; name: string; active: boolean; memberIds: string[]; leadId: string | null }[]>(manager ? "/crews" : null);
  const properties: { id: string; address: string }[] = (detail.data?.properties ?? []).map((p: any) => ({ id: p.id, address: [p.name, formatAddress(p)].filter(Boolean).join(" · ") }));
  // A customer with a single property: pick it.
  useEffect(() => { if (properties.length === 1 && !propertyId && !todo) setPropertyId(properties[0].id); }, [properties.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const team = (staff.data ?? []).filter((e) => !isInactive(e.status) || assignees.includes(e.id));
  const toggle = (id: string) => setAssignees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const pickCrew = (id: string) => {
    setCrewId(id);
    const c = (crews.data ?? []).find((x) => x.id === id);
    // Picking a crew ticks its people (change them after if needed).
    if (c) setAssignees([...new Set([...(c.leadId ? [c.leadId] : []), ...c.memberIds])]);
  };
  const repeating = !todo && scheduling === "repeat";
  // Keep the repeat's day pickers in step with a new first date (as Homeworks does).
  const moveDate = (d: string) => {
    setDate(d);
    if (endDate <= d) setEndDate(plusDays(d, 1));
    if (!d) return;
    if (weekdays.length <= 1) setWeekdays([weekdayOf(d)]);
    setMonthDay(Number(d.slice(8))); setNth(nthOf(d)); setWeekday(weekdayOf(d)); setMonth(Number(d.slice(5, 7)));
    if (until < d) setUntil(plusDays(d, 30));
  };
  const rule = repeating ? {
    freq, every: Number(every) || 1, weekdaysOnly, weekdays, by, day: monthDay, nth, weekday, month, end,
    until: end === "date" ? until : null, count: end === "count" ? Number(count) || null : null, offSeasonId: pause && seasonId ? seasonId : null,
  } : null;
  const season = (seasons.data ?? []).find((s) => s.id === seasonId);
  const preview = useMemo(() => {
    if (!rule || !date) return null;
    try { return previewSeries(date, rule, pause && season ? { start: season.start, end: season.end } : null); } catch { return null; }
  }, [JSON.stringify(rule), date, pause, season?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The dates this to-do (or series) falls on in the chart's five weeks.
  const chartDates = useMemo(() => {
    if (!date) return [];
    if (!rule) return [date];
    try { return ruleDates(date, rule, { offSeason: pause && season ? { start: season.start, end: season.end } : null, through: plusDays(date, 34), max: 40 }).filter((d) => d <= plusDays(date, 34)); } catch { return []; }
  }, [JSON.stringify(rule), date, pause, season?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      const body = {
        title, notes, location, color, date, categoryId: categoryId || null, crewId: crewId || null,
        customerId: customer?.id ?? null, propertyId: customer ? propertyId || null : null,
        endDate: multi && !repeating ? endDate : null,
        startTime: timed ? startTime : null, endTime: timed ? endTime || null : null,
        budgetedHours: hours.trim() === "" ? null : Number(hours),
        assigneeIds: assignees,
        ...(todo ? {} : { rule }),
      };
      const r = todo
        ? await api<Todo & { changed: number }>(`/todos/${todo.id}${todo.seriesId && applyTo === "following" ? "?applyTo=following" : ""}`, { method: "PUT", body })
        : await api<Todo & { created: number }>("/todos", { method: "POST", body });
      // Photos and documents picked on a new to-do go on it (the first one of a series).
      for (const f of pending) {
        const fd = new FormData();
        fd.append("file", f, f.name);
        await api(`/todos/${r.id}/files`, { method: "POST", body: fd });
      }
      todosChanged();
      onSaved(r, "created" in r ? r.created : 1);
    });
  };

  const dayChecks = (
    <div className="todo-weekdays" role="group" aria-label="Days of the week">
      {WEEKDAY_ORDER.map((w) => (
        <label key={w} className="check"><input type="checkbox" checked={weekdays.includes(w)}
          onChange={() => setWeekdays((d) => (d.includes(w) ? (d.length > 1 ? d.filter((x) => x !== w) : d) : [...d, w]))} /> {WEEKDAY_NAMES[w]}</label>
      ))}
    </div>
  );
  const nthPick = (
    <>
      <select aria-label="Which week" value={nth} onChange={(e) => setNth(Number(e.target.value))}>{NTH_OPTIONS.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select>
      <select aria-label="Day of the week" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{WEEKDAY_ORDER.map((w) => <option key={w} value={w}>{WEEKDAY_NAMES[w]}</option>)}</select>
    </>
  );
  const monthPick = (
    <select aria-label="Month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
  );

  return (
    <form className="card stack todo-form" onSubmit={submit}>
      <h2>{todo ? "Edit to-do" : "New to-do"}</h2>
      <label>To-do title or description *<input required autoFocus maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call the HOA about the gate code" /></label>

      <h3 className="todo-section">Customer</h3>
      <div className="formgrid">
        {customer ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="todo-label">Customer</span>
            <div className="row"><strong>{customer.name}</strong>
              {canCustomers && <button type="button" className="linkbtn" onClick={() => { setCustomer(null); setPropertyId(""); }}>Change</button>}
            </div>
          </div>
        ) : canCustomers ? <CustomerPicker label="Customer (optional)" onPick={(c) => { setCustomer({ id: c.id, name: c.name }); setPropertyId(""); }} />
          : <p className="muted" style={{ margin: 0 }}>Linking a customer needs Customers &amp; billing access.</p>}
        {customer && canCustomers && (
          <label>Property
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">No property is assigned</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.address}</option>)}
            </select>
          </label>
        )}
        {customer && !canCustomers && todo?.property && <div className="stack" style={{ gap: 4 }}><span className="todo-label">Property</span><span>{todo.property.address}</span></div>}
        <label>Location {propertyId ? "(the property's address is used)" : "(optional)"}<input maxLength={300} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Shop, supplier, an address…" /></label>
      </div>
      <ColorPicker color={color} setColor={setColor} />

      <h3 className="todo-section">Scheduling</h3>
      {!todo && (
        <label style={{ maxWidth: 340 }}>Scheduling
          <select value={scheduling} onChange={(e) => setScheduling(e.target.value as "single" | "repeat")}>
            <option value="single">Single to-do</option>
            <option value="repeat">Recurring series of to-dos</option>
          </select>
        </label>
      )}
      <div className="todo-sched">
        <div className="stack">
          {repeating && (
            <>
              <label>How often will these to-dos be?
                <select value={freq} onChange={(e) => setFreq(e.target.value as TodoFreq)}>{TODO_FREQS.map((f) => <option key={f} value={f}>{TODO_FREQ_LABELS[f]}</option>)}</select>
              </label>
              {freq === "daily" && (
                <div className="stack" style={{ gap: 6 }}>
                  <label className="check"><input type="radio" name="daily" checked={weekdaysOnly} onChange={() => setWeekdaysOnly(true)} /> Every weekday</label>
                  <label className="check"><input type="radio" name="daily" checked={!weekdaysOnly} onChange={() => setWeekdaysOnly(false)} /> Every
                    <input type="number" min={1} max={99} className="num-sm" aria-label="Days apart" value={every} onFocus={() => setWeekdaysOnly(false)} onChange={(e) => setEvery(e.target.value)} /> day(s)</label>
                </div>
              )}
              {freq === "weekly" && (
                <>
                  <label className="check">Every <input type="number" min={1} max={99} className="num-sm" aria-label="Weeks apart" value={every} onChange={(e) => setEvery(e.target.value)} /> week(s) on</label>
                  {dayChecks}
                </>
              )}
              {freq === "monthly" && (
                <div className="stack" style={{ gap: 6 }}>
                  <label className="check wrap"><input type="radio" name="monthly" checked={by === "day"} onChange={() => setBy("day")} /> On day
                    <select aria-label="Day of the month" value={monthDay} onFocus={() => setBy("day")} onChange={(e) => setMonthDay(Number(e.target.value))}>{MONTH_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}</select>
                    of every <input type="number" min={1} max={99} className="num-sm" aria-label="Months apart" value={every} onChange={(e) => setEvery(e.target.value)} /> month(s)</label>
                  <label className="check wrap"><input type="radio" name="monthly" checked={by === "nth"} onChange={() => setBy("nth")} /> On the {nthPick} of every <input type="number" min={1} max={99} className="num-sm" aria-label="Months apart" value={every} onChange={(e) => setEvery(e.target.value)} /> month(s)</label>
                  {by === "day" && monthDay > 28 && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Shorter months use their last day.</p>}
                </div>
              )}
              {freq === "yearly" && (
                <div className="stack" style={{ gap: 6 }}>
                  <label className="check wrap"><input type="radio" name="yearly" checked={by === "day"} onChange={() => setBy("day")} /> On every {monthPick}
                    <select aria-label="Day of the month" value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>{MONTH_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
                  <label className="check wrap"><input type="radio" name="yearly" checked={by === "nth"} onChange={() => setBy("nth")} /> On the {nthPick} of {monthPick}</label>
                </div>
              )}
            </>
          )}
          <label>{repeating ? "Starting" : multi ? "First day" : "Date"}<input type="date" required value={date} onChange={(e) => moveDate(e.target.value)} /></label>
          {!repeating && <label className="check switch"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Multi-day?</label>}
          {multi && !repeating && <label>End date<input type="date" required min={date} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>}
          <label className="check switch"><input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} /> Time</label>
          {timed && (
            <div className="formgrid">
              <label>Start time<input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
              <label>End time (optional)<input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
            </div>
          )}
          <label>Budgeted hours for to-do
            <span className="input-addon"><input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0.00" /><span>Hours</span></span>
          </label>
          {repeating && <SeasonPicker on={pause} setOn={setPause} value={seasonId} setValue={setSeasonId} seasons={seasons.data ?? []} reload={seasons.reload} />}
        </div>
        <div className="stack">
          {repeating && (
            <>
              <div className="stack todo-ends" role="radiogroup" aria-label="How the series ends">
                <label className="check wrap"><input type="radio" name="end" checked={end === "date"} onChange={() => setEnd("date")} /> The last date you&apos;ll make a to-do
                  <input type="date" aria-label="Last date" value={until} min={date} disabled={end !== "date"} onChange={(e) => setUntil(e.target.value)} /></label>
                <label className="check wrap"><input type="radio" name="end" checked={end === "count"} onChange={() => setEnd("count")} /> Total number of to-dos
                  <input type="number" min={1} max={500} className="num-sm" aria-label="Total number of to-dos" value={count} disabled={end !== "count"} onChange={(e) => setCount(e.target.value)} /></label>
                <label className="check"><input type="radio" name="end" checked={end === "never"} onChange={() => setEnd("never")} /> No end date (they carry on)</label>
              </div>
              {preview && <p className={`todo-preview${preview.count === 0 ? " bad" : ""}`} role="status">{preview.text}</p>}
            </>
          )}
          <WeeklyHours from={date} ids={assignees} notId={todo?.id} hours={hours.trim() && !isNaN(Number(hours)) ? Number(hours) : 0} dates={chartDates} />
        </div>
      </div>

      <CategoryPicker value={categoryId} setValue={setCategoryId} />
      <label>Description / notes<textarea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>

      <h3 className="todo-section">Employees</h3>
      {manager ? (
        <>
          <label style={{ maxWidth: 420 }}>Crew
            <select value={crewId} onChange={(e) => pickCrew(e.target.value)}>
              <option value="">No crew assigned</option>
              {(crews.data ?? []).filter((c) => c.active || c.id === crewId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="todo-people" role="group" aria-label="Employees">
            {team.map((e) => (
              <label key={e.id} className="check"><input type="checkbox" checked={assignees.includes(e.id)} onChange={() => toggle(e.id)} /> {e.firstName} {e.lastName}{e.title ? <span className="muted"> · {e.title}</span> : null}</label>
            ))}
            {!assignees.length && <p className="muted" style={{ margin: 0, gridColumn: "1 / -1" }}>Nobody picked: it shows on the To-dos page for managers.</p>}
          </div>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>{todo && todo.assignees.length ? todoPeople(todo) : "You."} A manager can give to-dos to others or a crew.</p>}

      {!todo && (
        <>
          <h3 className="todo-section">Photos / documents</h3>
          <div className="file-drop" role="button" tabIndex={0} onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setPending((p) => [...p, ...e.dataTransfer.files]); }}>
            <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) setPending((p) => [...p, ...e.target.files!]); e.target.value = ""; }} />
            <Icon name="upload" size={18} /> Drag your files here or <span className="linkbtn">select a file</span>
            <span className="muted" style={{ display: "block", fontSize: 12 }}>Photos, PDFs and short videos (MP4, MOV), up to 25 MB each</span>
          </div>
          {pending.length > 0 && (
            <ul className="todo-pending">
              {pending.map((f, i) => (
                <li key={`${f.name}-${i}`}>{f.name}{f.size > VISIT_FILE_MAX_BYTES ? <span className="bad-text"> · over 25 MB</span> : null}
                  <button type="button" className="linkbtn" onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>Remove</button></li>
              ))}
            </ul>
          )}
        </>
      )}

      {todo?.seriesId && (
        <div className="row" style={{ gap: 16 }}>
          <label className="check"><input type="radio" checked={applyTo === "one"} onChange={() => setApplyTo("one")} /> Change just this one</label>
          <label className="check"><input type="radio" checked={applyTo === "following"} onChange={() => setApplyTo("following")} /> This one and the later ones that aren&apos;t done</label>
        </div>
      )}
      <ErrorBox error={save.error} />
      <div className="row todo-form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={save.busy || (repeating && preview?.count === 0) || pending.some((f) => f.size > VISIT_FILE_MAX_BYTES)}>
          {save.busy ? "Saving…" : todo ? "Update to-do" : repeating ? "Create to-dos" : "Create to-do"}
        </button>
      </div>
    </form>
  );
}

/**
 * Work tracking (Homeworks' "Start Work" on the job sheet): start a timer, stop it (the time is
 * kept), and mark the to-do done, which stops it too.
 */
export function WorkTracking({ t, onChange, canWork }: { t: Todo; onChange: (t: Todo) => void; canWork: boolean }) {
  const [now, setNow] = useState(() => new Date());
  const act = useAction();
  useEffect(() => {
    if (!t.startedAt || t.doneAt) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [t.startedAt, t.doneAt]);
  const run = (path: string, body?: unknown) => act.run(async () => { onChange(await api<Todo>(`/todos/${t.id}/${path}`, { method: "POST", body })); todosChanged(); });
  const secs = Math.floor((t.trackedSeconds ?? 0) + (t.startedAt && !t.doneAt ? Math.max(0, (now.getTime() - new Date(t.startedAt).getTime()) / 1000) : 0));
  const clock = `${Math.floor(secs / 3600)}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  return (
    <div className="card stack work-tracking">
      <h2 style={{ margin: 0 }}>Work tracking</h2>
      <div className="work-clock" aria-live="off" aria-label={`Tracked ${formatMinutes(trackedMinutes({ trackedSeconds: t.trackedSeconds, startedAt: t.doneAt ? null : t.startedAt }, now))}`}>{clock}</div>
      {t.budgetedHours ? <p className="muted" style={{ margin: 0 }}>Budgeted {t.budgetedHours} h</p> : null}
      {t.doneAt ? (
        <>
          <p style={{ margin: 0 }}><span className="badge ok">Done</span> {fmtDateTime(t.doneAt)}{t.doneBy ? ` by ${t.doneBy}` : ""}</p>
          {canWork && <button type="button" className="btn" disabled={act.busy} onClick={() => run("done", { done: false })}>Not done yet</button>}
        </>
      ) : canWork ? (
        t.startedAt ? (
          <div className="row">
            <button type="button" className="btn" disabled={act.busy} onClick={() => run("stop")}>Stop work</button>
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => run("done")}>Done</button>
          </div>
        ) : (
          <div className="row">
            <button type="button" className="btn go" disabled={act.busy} onClick={() => run("start")}>{t.trackedSeconds ? "Start work again" : "Start work"}</button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => run("done")}>Mark done</button>
          </div>
        )
      ) : <p className="muted" style={{ margin: 0 }}>Only the people it&apos;s for, whoever made it, or a manager can track work on it.</p>}
      <ErrorBox error={act.error} />
    </div>
  );
}

interface Note { id: string; body: string; authorId: string | null; author: string | null; createdAt: string }
/** Homeworks' "Notes for the Dispatcher": the crew and office leave notes on the to-do; newest last. */
export function DispatcherNotes({ todoId, canAdd, canManage, meId, onCount }: { todoId: string; canAdd: boolean; canManage: boolean; meId?: string; onCount?: (n: number) => void }) {
  const list = useApi<Note[]>(`/todos/${todoId}/notes`);
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const act = useAction();
  useEffect(() => { if (list.data) onCount?.(list.data.length); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => act.run(async () => { await api(`/todos/${todoId}/notes`, { method: "POST", body: { body } }); setBody(""); setAdding(false); await list.reload(); });
  const remove = (id: string) => act.run(async () => { await api(`/todos/${todoId}/notes/${id}`, { method: "DELETE" }); await list.reload(); });
  const notes = list.data ?? [];
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Notes for the dispatcher{notes.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {notes.length}</span> : null}</h2>
        {canAdd && !adding && <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add new note</button>}
      </div>
      {notes.length ? (
        <ul className="todo-notes-list">
          {notes.map((n) => (
            <li key={n.id}>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{n.body}</p>
              <span className="muted" style={{ fontSize: 12 }}>{n.author ?? "Someone"} · {fmtDateTime(n.createdAt)}
                {(canManage || n.authorId === meId) && <> · <button type="button" className="linkbtn" disabled={act.busy} onClick={() => confirm("Remove this note?") && remove(n.id)}>Remove</button></>}</span>
            </li>
          ))}
        </ul>
      ) : list.data && !adding ? <p className="muted" style={{ margin: 0 }}>No notes yet.</p> : null}
      {adding && (
        <div className="stack" style={{ gap: 8 }}>
          <textarea autoFocus maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What the office should know: a cracked lid, a locked gate, parts to order…" aria-label="Note for the dispatcher" />
          <div className="row"><button type="button" className="btn primary" disabled={!body.trim() || act.busy} onClick={add}>Add note</button><button type="button" className="btn" onClick={() => { setAdding(false); setBody(""); }}>Cancel</button></div>
        </div>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

/** Customer and property pages: their open to-dos (and recently done ones), with Add to-do. */
export function LinkedTodos({ customerId, propertyId, customer }: { customerId?: string; propertyId?: string; customer?: { id: string; name: string } | null }) {
  const query = customerId ? `customerId=${customerId}` : `propertyId=${propertyId}`;
  const open = useApi<{ today: string; items: Todo[] }>(`/todos?${query}`);
  const done = useApi<{ today: string; items: Todo[] }>(`/todos?${query}&status=done&limit=5`);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Todo | null>(null);
  useEffect(() => {
    const reload = () => { open.reload(); done.reload(); };
    window.addEventListener("crewdesk:todos", reload);
    return () => window.removeEventListener("crewdesk:todos", reload);
  }, [open.reload, done.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = open.data?.today ?? localToday();
  // A repeating to-do shows once: its next open one, with how many more are coming.
  const later = new Map<string, number>();
  const openItems = (open.data?.items ?? []).filter((t) => {
    if (!t.seriesId) return true;
    later.set(t.seriesId, (later.get(t.seriesId) ?? -1) + 1);
    return later.get(t.seriesId) === 0;
  });
  const items = [...openItems, ...(done.data?.items ?? [])];
  const more = (t: Todo) => (t.seriesId && !t.doneAt && later.get(t.seriesId) ? `${later.get(t.seriesId)} more coming` : undefined);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>To-dos{open.data?.items.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {open.data.items.length} open</span> : null}</h2>
        {!adding && <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add to-do</button>}
      </div>
      {adding && <div style={{ marginTop: 12 }}><TodoForm preset={{ customer: customer ?? undefined, propertyId: customer ? propertyId : undefined }} today={today} onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} /></div>}
      {editing && <div style={{ marginTop: 12 }}><TodoForm todo={editing} today={today} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} /></div>}
      {items.length ? (
        <ul className="todo-list">
          {items.map((t) => (
            <TodoItem key={t.id} t={t} today={today} showDate extra={more(t)} open={openId === t.id} onOpen={() => setOpenId(openId === t.id ? null : t.id)} onChange={() => todosChanged()}>
              {openId === t.id && <TodoDetails t={t} onEdit={() => { setEditing(t); setOpenId(null); }} onDeleted={() => setOpenId(null)} />}
            </TodoItem>
          ))}
        </ul>
      ) : open.data && !adding ? <p className="muted" style={{ margin: "8px 0 0" }}>No to-dos{customerId ? " for this customer" : " here"}.</p> : null}
    </div>
  );
}

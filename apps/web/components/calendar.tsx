"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CALENDAR_TYPES, CALENDAR_TYPE_INFO, eventOnDay, eventsCsv, formatMoney, formatTodoTime, sortEvents,
  type CalendarEvent, type CalendarSort, type CalendarType,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { Icon } from "./icons";
import { TodoForm, todosChanged } from "./todos";
import { VisitForm } from "./visits";

/* ───────── Dates ───────── */
export const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const weekStart = (d: string) => plusDays(d, -dow(d));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => { const x = new Date(`${monthStart(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const lastOfMonth = (d: string) => plusDays(addMonths(d, 1), -1);
export const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
export const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = plusDays(d, 1)) out.push(d); return out; };
export const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };

export type CalView = "day" | "week" | "month";
/** What the calendar shows for a view: the days on screen (a month shows whole weeks around it). */
export function rangeFor(view: CalView, anchor: string) {
  if (view === "day") return { from: anchor, to: anchor };
  if (view === "week") { const from = weekStart(anchor); return { from, to: plusDays(from, 6) }; }
  const from = weekStart(monthStart(anchor));
  return { from, to: plusDays(weekStart(lastOfMonth(anchor)), 6) };
}
export const step = (view: CalView, anchor: string, n: number) => (view === "day" ? plusDays(anchor, n) : view === "week" ? plusDays(anchor, 7 * n) : addMonths(anchor, n));
export function rangeLabel(view: CalView, anchor: string) {
  if (view === "day") return fmt(anchor, { weekday: "short", month: "short", day: "numeric" });
  if (view === "week") { const { from, to } = rangeFor("week", anchor); return `${fmt(from, { weekday: "short", month: "short", day: "numeric" })} → ${fmt(to, { weekday: "short", month: "short", day: "numeric" })}`; }
  return fmt(anchor, { month: "long", year: "numeric" });
}

/* ───────── Settings (kept per person in this browser) ───────── */
export const DETAILS = {
  time: "Time", location: "Address or location", customer: "Customer", people: "Who it's for", amount: "Price (work orders)", hours: "Hours", media: "Photos (work orders)", type: "Event type", status: "Status", notes: "Notes",
} as const;
export type DetailKey = keyof typeof DETAILS;
export interface CalSettings {
  view: CalView; mode: "calendar" | "list"; sort: CalendarSort;
  types: Record<CalendarType, boolean>; colors: Record<CalendarType, string>;
  colorByType: boolean; groupByType: boolean; highContrast: boolean;
  details: Record<DetailKey, boolean>; rollup: boolean; sidebar: boolean; unscheduled: boolean;
}
export const DEFAULT_SETTINGS: CalSettings = {
  view: "week", mode: "calendar", sort: "time",
  types: Object.fromEntries(CALENDAR_TYPES.map((t) => [t, CALENDAR_TYPE_INFO[t].defaultOn])) as Record<CalendarType, boolean>,
  colors: Object.fromEntries(CALENDAR_TYPES.map((t) => [t, CALENDAR_TYPE_INFO[t].color])) as Record<CalendarType, string>,
  colorByType: true, groupByType: false, highContrast: false,
  details: { time: true, location: true, customer: true, people: true, amount: true, hours: false, media: true, type: false, status: false, notes: false },
  rollup: false, sidebar: true, unscheduled: false,
};
export function useCalSettings(userId: string | undefined) {
  const key = `crewdesk.calendar.${userId ?? "anon"}`;
  const [s, setS] = useState<CalSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      if (saved && typeof saved === "object") setS({ ...DEFAULT_SETTINGS, ...saved, types: { ...DEFAULT_SETTINGS.types, ...saved.types }, colors: { ...DEFAULT_SETTINGS.colors, ...saved.colors }, details: { ...DEFAULT_SETTINGS.details, ...saved.details } });
    } catch { /* storage blocked or damaged: defaults */ }
  }, [key]);
  const set = useCallback((patch: Partial<CalSettings>) => setS((old) => {
    const next = { ...old, ...patch };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage blocked */ }
    return next;
  }), [key]);
  const reset = () => { try { localStorage.removeItem(key); } catch { /* storage blocked */ } setS(DEFAULT_SETTINGS); };
  return { s, set, reset };
}

/* ───────── Filters ───────── */
export type FilterKind = "status" | "recurring" | "person" | "crew" | "customer" | "tag" | "invoice" | "onsite" | "tracked" | "service";
export type CalFilter = { kind: FilterKind; value: string; label: string };
export const FILTER_LABELS: Record<FilterKind, string> = {
  status: "Status", recurring: "Repeats", invoice: "Invoice", onsite: "On site", tracked: "Tracked time", crew: "Crew", person: "Person", customer: "Customer", service: "Item/Service", tag: "Tag",
};
export function applyFilters(list: CalendarEvent[], filters: CalFilter[], search: string) {
  const q = search.trim().toLowerCase();
  return list.filter((e) => {
    if (q && ![e.title, e.customer?.name, e.property?.address, e.location, e.notes, ...e.people.map((p) => p.name)].some((x) => x?.toLowerCase().includes(q))) return false;
    return filters.every((f) => {
      if (f.kind === "status") return e.status === f.value;
      if (f.kind === "recurring") return f.value === "yes" ? e.recurring : !e.recurring;
      if (f.kind === "person") return f.value === "none" ? !e.people.length : e.people.some((p) => p.id === f.value);
      if (f.kind === "customer") return e.customer?.id === f.value;
      if (f.kind === "crew") return f.value === "none" ? e.type === "visit" && !e.crew : e.crew?.id === f.value;
      if (f.kind === "tag") return e.tagIds.includes(f.value);
      // Work-order filters leave everything else out.
      if (f.kind === "invoice") return e.invoiced !== null && e.invoiced === (f.value === "yes");
      if (f.kind === "onsite") return e.type === "visit" && e.onSite === (f.value === "yes");
      if (f.kind === "tracked") return e.type === "visit" && (e.trackedMinutes != null) === (f.value === "yes");
      if (f.kind === "service") return e.serviceIds.includes(f.value);
      return true;
    });
  });
}

/* ───────── Small pieces ───────── */

/** Closes a pop-up on an outside click or Escape. */
export function usePopover(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open, close]);
  return ref;
}

/** The month at the top of the sidebar (and in the range picker): click a day to go there. */
export function MiniMonth({ anchor, from, to, today, onPick }: { anchor: string; from: string; to: string; today: string; onPick: (d: string) => void }) {
  const [month, setMonth] = useState(monthStart(anchor));
  useEffect(() => { setMonth(monthStart(anchor)); }, [anchor]);
  const grid = days(weekStart(month), plusDays(weekStart(lastOfMonth(month)), 6));
  return (
    <div className="mini-month">
      <div className="mini-head">
        <button type="button" className="cal-icon-btn" aria-label="Go to the previous month" onClick={() => setMonth(addMonths(month, -1))}><Icon name="left" size={16} /></button>
        <strong>{fmt(month, { month: "long", year: "numeric" })}</strong>
        <button type="button" className="cal-icon-btn" aria-label="Go to the next month" onClick={() => setMonth(addMonths(month, 1))}><Icon name="right" size={16} /></button>
      </div>
      <div className="mini-grid" role="grid">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => <span key={d} className="mini-dow">{d}</span>)}
        {grid.map((d) => (
          <button key={d} type="button" onClick={() => onPick(d)} aria-label={fmt(d, { weekday: "long", month: "long", day: "numeric" })}
            className={`mini-day${d >= from && d <= to ? " in" : ""}${d === today ? " today" : ""}${d.slice(0, 7) !== month.slice(0, 7) ? " out" : ""}`}>
            {Number(d.slice(8))}
          </button>
        ))}
      </div>
    </div>
  );
}

const textOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111827" : "#ffffff";
};
export const eventColor = (e: CalendarEvent, s: CalSettings) => (s.colorByType || !e.color ? s.colors[e.type] : e.color);

/** One event on the calendar: color, icon, title and the details chosen under "Event card details". */
export function EventCard({ e, s, onOpen, compact }: { e: CalendarEvent; s: CalSettings; onOpen: (e: CalendarEvent, el: HTMLElement) => void; compact?: boolean }) {
  const color = eventColor(e, s);
  const style = s.highContrast ? { background: color, color: textOn(color), borderLeftColor: color } : { borderLeftColor: color };
  const time = e.startTime ? formatTodoTime(e.startTime, e.endTime) : e.endDate ? `${fmt(e.date, { month: "short", day: "numeric" })} – ${fmt(e.endDate, { month: "short", day: "numeric" })}` : "";
  const lines = compact ? [] : [
    s.details.time && time,
    s.details.customer && e.customer?.name,
    s.details.location && (e.property?.address ?? e.location),
    s.details.people && [e.crew?.name, e.people.map((p) => p.name).join(", ")].filter(Boolean).join(" · "),
    s.details.amount && e.amountCents != null ? formatMoney(e.amountCents) : null,
    s.details.hours && e.hours ? `${e.hours} h` : null,
    s.details.media && e.mediaCount ? `📎 ${e.mediaCount} photo${e.mediaCount === 1 ? "" : "s"}` : null,
    s.details.type && CALENDAR_TYPE_INFO[e.type].label,
    s.details.status && e.statusLabel,
    s.details.notes && e.notes,
  ].filter(Boolean) as string[];
  return (
    <button type="button" className={`cal-event${e.status === "done" ? " done" : ""}${s.highContrast ? " contrast" : ""}${compact ? " compact" : ""}`} style={style}
      draggable={e.canMove} title={e.canMove ? "Drag to another day to move it" : undefined}
      onDragStart={(ev) => { ev.dataTransfer.setData("text/plain", JSON.stringify({ type: e.type, id: e.id })); ev.dataTransfer.effectAllowed = "move"; }}
      onClick={(ev) => onOpen(e, ev.currentTarget)}>
      <span className="cal-event-title">
        <Icon name={CALENDAR_TYPE_INFO[e.type].icon} size={13} />
        {compact && e.startTime ? <span className="cal-event-time">{formatTodoTime(e.startTime).replace(":00", "").replace(" ", "").toLowerCase()}</span> : null}
        <span className="cal-event-name">{e.title}</span>
        {e.recurring && <span aria-label="Repeats">↻</span>}
      </span>
      {lines.map((l, i) => <span key={i} className="cal-event-line">{l}</span>)}
    </button>
  );
}

/** The pop-up when you click an event: everything about it, with Open, Done and Move to. */
export function EventPopover({ e, s, onClose, onChanged, anchor }: { e: CalendarEvent; s: CalSettings; onClose: () => void; onChanged: () => void; anchor: DOMRect | null }) {
  const ref = usePopover(true, onClose);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState(e.date);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); onChanged(); onClose(); } catch (x) { setErr((x as Error).message); } setBusy(false); };
  const when = [e.endDate ? `${fmt(e.date, { weekday: "short", month: "short", day: "numeric" })} – ${fmt(e.endDate, { weekday: "short", month: "short", day: "numeric" })}` : fmt(e.date, { weekday: "long", month: "long", day: "numeric" }), formatTodoTime(e.startTime, e.endTime)].filter(Boolean).join(" · ");
  // Beside the card on a wide screen; a sheet at the bottom on a phone (CSS).
  const pos = anchor && typeof window !== "undefined" && window.innerWidth > 700
    ? { top: Math.min(anchor.top, window.innerHeight - 380), left: anchor.right + 300 < window.innerWidth ? anchor.right + 8 : Math.max(8, anchor.left - 308) }
    : undefined;
  return (
    <div className="cal-pop" ref={ref} role="dialog" aria-label={e.title} style={pos}>
      <div className="cal-pop-head" style={{ borderTopColor: eventColor(e, s) }}>
        <span className="cal-pop-type"><Icon name={CALENDAR_TYPE_INFO[e.type].icon} size={14} /> {CALENDAR_TYPE_INFO[e.type].label} · {e.statusLabel}</span>
        <button type="button" className="cal-icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <h3 className={e.status === "done" ? "todo-struck" : undefined}>{e.title}{e.recurring ? " ↻" : ""}</h3>
      <dl className="facts">
        <dt>When</dt><dd>{when}</dd>
        {e.customer && <><dt>Customer</dt><dd>{e.customer.name}</dd></>}
        {(e.property || e.location) && <><dt>{e.property ? "Address" : "Where"}</dt><dd>{e.property?.address ?? e.location}</dd></>}
        {e.crew && <><dt>Crew</dt><dd>{e.crew.name}</dd></>}
        {e.people.length > 0 && <><dt>{e.type === "repair" ? "Assigned" : e.crew ? "People" : "For"}</dt><dd>{e.people.map((p) => p.name).join(", ")}</dd></>}
        {e.hours != null && <><dt>Hours</dt><dd>{e.hours}</dd></>}
        {e.amountCents != null && <><dt>Price</dt><dd>{formatMoney(e.amountCents)}{e.invoiced ? " · invoiced" : ""}</dd></>}
        {e.notes && <><dt>Notes</dt><dd className="cal-pop-notes">{e.notes}</dd></>}
      </dl>
      {e.canMove && (
        <div className="row" style={{ gap: 6 }}>
          <label className="cal-move">Move to<input type="date" value={moveTo} onChange={(x) => setMoveTo(x.target.value)} /></label>
          <button type="button" className="btn" disabled={busy || !moveTo || moveTo === e.date} onClick={() => run(() => api("/events/move", { body: { type: e.type, id: e.id, date: moveTo } }))}>Move</button>
        </div>
      )}
      <div className="row">
        {e.href && <Link className="btn" href={e.href}>Open</Link>}
        {e.type === "todo" && e.canComplete && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`/todos/${e.id}/done`, { method: "POST", body: { done: e.status !== "done" } }); todosChanged(); })}>
            {e.status === "done" ? "Mark not done" : "Mark done"}
          </button>
        )}
        {e.type === "visit" && e.canComplete && !e.onSite && (
          <button type="button" className="btn" disabled={busy} onClick={() => run(() => api(`/visits/${e.id}/start`, { method: "POST", body: {} }))}>Arrived</button>
        )}
        {e.type === "visit" && e.canComplete && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => api(`/visits/${e.id}/complete`, { method: "POST", body: {} }))}>Completed</button>
        )}
        {e.type === "repair" && e.canComplete && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => confirm("Mark this repair order completed?") && run(() => api(`/work-orders/${e.id}`, { method: "PATCH", body: { status: "completed" } }))}>Complete</button>
        )}
      </div>
      {err && <p className="error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

/** A day's events, sorted (and grouped by type when that's on). */
function DayEvents({ list, s, onOpen, compact, max, onMore }: { list: CalendarEvent[]; s: CalSettings; onOpen: (e: CalendarEvent, el: HTMLElement) => void; compact?: boolean; max?: number; onMore?: () => void }) {
  const sorted = sortEvents(list, s.sort);
  if (s.groupByType && !compact) {
    return (
      <>
        {CALENDAR_TYPES.filter((t) => sorted.some((e) => e.type === t)).map((t) => (
          <div key={t} className="cal-group">
            <div className="cal-group-head" style={{ color: s.colors[t] }}><Icon name={CALENDAR_TYPE_INFO[t].icon} size={12} /> {CALENDAR_TYPE_INFO[t].label}</div>
            {sorted.filter((e) => e.type === t).map((e) => <EventCard key={e.key} e={e} s={s} onOpen={onOpen} />)}
          </div>
        ))}
      </>
    );
  }
  const shown = max ? sorted.slice(0, max) : sorted;
  return (
    <>
      {shown.map((e) => <EventCard key={e.key} e={e} s={s} onOpen={onOpen} compact={compact} />)}
      {max && sorted.length > max && <button type="button" className="cal-more" onClick={onMore}>+{sorted.length - max} more</button>}
    </>
  );
}

/** Budgeted hours on a day: to-dos and repair orders (work), not shifts, time off or holidays. */
const isWork = (e: CalendarEvent) => e.type === "visit" || e.type === "todo" || e.type === "repair";
export const workHours = (list: CalendarEvent[]) => Math.round(list.filter(isWork).reduce((n, e) => n + (e.hours ?? 0), 0) * 100) / 100;
/** What a day's work orders bill (null when there's nothing priced you can see). */
export const workMoney = (list: CalendarEvent[]) => { const priced = list.filter((e) => e.amountCents != null); return priced.length ? priced.reduce((n, e) => n + (e.amountCents ?? 0), 0) : null; };
function Rollup({ list }: { list: CalendarEvent[] }) {
  const by = new Map<string, number>();
  for (const e of list) {
    if (!isWork(e)) continue;
    const share = (e.hours ?? 0) / Math.max(e.people.length, 1);
    for (const p of e.people.length ? e.people : [{ id: "none", name: "Nobody assigned" }]) by.set(p.name, (by.get(p.name) ?? 0) + share);
  }
  const rows = [...by.entries()].filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return null;
  return <ul className="cal-rollup">{rows.map(([n, h]) => <li key={n}><span>{n}</span><strong>{Math.round(h * 100) / 100} h</strong></li>)}</ul>;
}

/** Drop target for dragging an event to another day. */
function useDrop(day: string, onMove: (type: string, id: string, day: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (ev: React.DragEvent) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; setOver(true); },
      onDragLeave: () => setOver(false),
      onDrop: (ev: React.DragEvent) => {
        ev.preventDefault(); setOver(false);
        try { const { type, id } = JSON.parse(ev.dataTransfer.getData("text/plain")); if (type && id) onMove(type, id, day); } catch { /* not an event */ }
      },
    },
  };
}

type GridProps = {
  dayList: string[]; events: CalendarEvent[]; s: CalSettings; today: string; anchorMonth?: string;
  onOpen: (e: CalendarEvent, el: HTMLElement) => void; onMove: (type: string, id: string, day: string) => void; onAdd: (day: string) => void; onDay: (day: string) => void;
};

function WeekColumn({ day, list, s, today, onOpen, onMove, onAdd, onDay }: { day: string; list: CalendarEvent[] } & Omit<GridProps, "dayList" | "events">) {
  const drop = useDrop(day, onMove);
  return (
    <div className={`cal-col${drop.over ? " over" : ""}`} {...drop.props}>
      <div className="cal-col-head">
        <button type="button" className="cal-day-link" onClick={() => onDay(day)} aria-label={`Open ${fmt(day, { weekday: "long", month: "long", day: "numeric" })}`}>
          {fmt(day, { weekday: "short" })} <span className={day === today ? "cal-today" : undefined}>{Number(day.slice(8))}</span>
        </button>
        <button type="button" className="cal-icon-btn cal-add" aria-label={`Add on ${fmt(day, { month: "long", day: "numeric" })}`} title="Add a work order or to-do" onClick={() => onAdd(day)}><Icon name="plus" size={14} /></button>
      </div>
      <div className="cal-col-body"><DayEvents list={list} s={s} onOpen={onOpen} /></div>
      <div className="cal-col-foot"><span>{list.length} event{list.length === 1 ? "" : "s"}</span><strong>{[workMoney(list) != null ? formatMoney(workMoney(list)) : null, workHours(list) ? `${workHours(list)} h` : null].filter(Boolean).join(" · ")}</strong></div>
      {s.rollup && <Rollup list={list} />}
    </div>
  );
}

export function WeekGrid(p: GridProps) {
  return <div className="cal-week">{p.dayList.map((d) => <WeekColumn key={d} day={d} list={p.events.filter((e) => eventOnDay(e, d))} {...p} />)}</div>;
}

function MonthCell({ day, list, s, today, anchorMonth, onOpen, onMove, onAdd, onDay }: { day: string; list: CalendarEvent[] } & Omit<GridProps, "dayList" | "events">) {
  const drop = useDrop(day, onMove);
  return (
    <div className={`cal-cell${drop.over ? " over" : ""}${anchorMonth && day.slice(0, 7) !== anchorMonth ? " out" : ""}`} {...drop.props}>
      <div className="cal-cell-head">
        <button type="button" className="cal-day-link" onClick={() => onDay(day)}><span className={day === today ? "cal-today" : undefined}>{Number(day.slice(8))}</span></button>
        <button type="button" className="cal-icon-btn cal-add" aria-label={`Add on ${fmt(day, { month: "long", day: "numeric" })}`} title="Add a work order or to-do" onClick={() => onAdd(day)}><Icon name="plus" size={13} /></button>
      </div>
      <DayEvents list={list} s={s} onOpen={onOpen} compact max={4} onMore={() => onDay(day)} />
      {(s.rollup && workHours(list) > 0) || workMoney(list) ? <div className="cal-cell-hours">{[workMoney(list) ? formatMoney(workMoney(list)) : null, s.rollup && workHours(list) ? `${workHours(list)} h` : null].filter(Boolean).join(" · ")}</div> : null}
    </div>
  );
}

export function MonthGrid(p: GridProps) {
  return (
    <div className="cal-month">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="cal-month-dow">{d}</div>)}
      {p.dayList.map((d) => <MonthCell key={d} day={d} list={p.events.filter((e) => eventOnDay(e, d))} {...p} />)}
    </div>
  );
}

export function DayView({ day, events, s, today, onOpen, onMove, onAdd }: { day: string } & Omit<GridProps, "dayList" | "onDay">) {
  const list = events.filter((e) => eventOnDay(e, day));
  const drop = useDrop(day, onMove);
  return (
    <div className={`cal-dayview${drop.over ? " over" : ""}`} {...drop.props}>
      <div className="cal-col-head">
        <strong>{fmt(day, { weekday: "long", month: "long", day: "numeric" })}{day === today ? " · Today" : ""}</strong>
        <button type="button" className="btn" onClick={() => onAdd(day)}><Icon name="plus" size={14} /> Add</button>
      </div>
      {list.length ? <div className="cal-dayview-list"><DayEvents list={list} s={s} onOpen={onOpen} /></div> : <p className="cal-empty">No events on this day</p>}
      {s.rollup && <Rollup list={list} />}
    </div>
  );
}

/** List mode: each day with events, then its events in rows. */
export function ListView({ dayList, events, s, today, onOpen }: Pick<GridProps, "dayList" | "events" | "s" | "today" | "onOpen">) {
  const withEvents = dayList.map((d) => ({ d, list: sortEvents(events.filter((e) => eventOnDay(e, d)), s.sort) })).filter((x) => x.list.length);
  if (!withEvents.length) return <p className="cal-empty">No events in this range</p>;
  return (
    <div className="cal-list">
      {withEvents.map(({ d, list }) => (
        <section key={d}>
          <h3 className="cal-list-day">{fmt(d, { weekday: "long", month: "long", day: "numeric" })}{d === today ? " · Today" : ""}<span className="muted"> · {list.length}{workHours(list) ? ` · ${workHours(list)} h` : ""}</span></h3>
          {list.map((e) => <EventCard key={e.key} e={e} s={s} onOpen={onOpen} />)}
        </section>
      ))}
    </div>
  );
}

/** Downloads the events shown as a spreadsheet file. */
export function downloadCsv(list: CalendarEvent[], from: string, to: string) {
  const blob = new Blob([eventsCsv(list)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `calendar-${from}${to !== from ? `-to-${to}` : ""}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** "+" on a day: a new work order (Customers & billing managers) or to-do for that date, in a pop-up. */
export function AddTodoModal({ date, onClose, onSaved, canWorkOrder }: { date: string; onClose: () => void; onSaved: () => void; canWorkOrder?: boolean }) {
  const [kind, setKind] = useState<"visit" | "todo">(canWorkOrder ? "visit" : "todo");
  // The customer picker's results and colour pop-ups live inside the modal, so outside clicks only.
  const ref = usePopover(true, onClose);
  return (
    <div className="cal-modal-backdrop">
      <div className="cal-modal" ref={ref} role="dialog" aria-label={kind === "visit" ? "New work order" : "New to-do"}>
        {canWorkOrder && (
          <div className="cal-seg cal-add-kind" role="group" aria-label="What to add">
            <button type="button" aria-pressed={kind === "visit"} onClick={() => setKind("visit")}>Work order</button>
            <button type="button" aria-pressed={kind === "todo"} onClick={() => setKind("todo")}>To-do</button>
          </div>
        )}
        {kind === "visit"
          ? <VisitForm preset={{ date }} onCancel={onClose} onSaved={() => { onSaved(); onClose(); }} />
          : <TodoForm preset={{ date }} today={localToday()} onCancel={onClose} onSaved={() => { onSaved(); onClose(); }} />}
      </div>
    </div>
  );
}


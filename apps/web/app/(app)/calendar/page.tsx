"use client";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CALENDAR_COLORS, CALENDAR_SORTS, CALENDAR_TYPES, CALENDAR_TYPE_INFO, formatMoney, type CalendarEvent, type CalendarSort, type CalendarType } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Icon } from "@/components/icons";
import { PageHead } from "@/components/ui";
import { useCompleteVisit } from "@/components/chemicals-step";
import {
  AddTodoModal, DETAILS, DayView, EventCard, EventPopover, FILTER_LABELS, ListView, MiniMonth, MonthGrid, WeekGrid, applyFilters, days, downloadCsv,
  fmt, localToday, rangeFor, rangeLabel, step, usePopover, useCalSettings, workHours, workMoney, type CalFilter, type CalSettings, type CalView, type DetailKey, type FilterKind,
} from "@/components/calendar";

const VIEWS: { key: CalView; label: string; hotkey: string }[] = [{ key: "day", label: "Day", hotkey: "D" }, { key: "week", label: "Week", hotkey: "W" }, { key: "month", label: "Month", hotkey: "M" }];

/** A button that opens a small menu under it. */
function Menu({ label, icon, title, active, children, align = "left", text }: {
  label: string; icon?: string; title?: string; active?: boolean; children: (close: () => void) => React.ReactNode; align?: "left" | "right"; text?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = usePopover(open, close);
  return (
    <div className="cal-menu-wrap" ref={ref}>
      <button type="button" className={text ? `btn cal-menu-btn${active ? " on" : ""}` : `cal-icon-btn cal-tool${active ? " on" : ""}`} aria-label={label} title={title ?? label}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon && <Icon name={icon} size={17} />}{text}
      </button>
      {open && <div className={`cal-menu${align === "right" ? " right" : ""}`} role="menu">{children(close)}</div>}
    </div>
  );
}

/** Left side: the month, Sort events, and Event types with their colors. */
function Sidebar({ s, set, anchor, from, to, today, onPick, counts }: {
  s: CalSettings; set: (p: Partial<CalSettings>) => void; anchor: string; from: string; to: string; today: string; onPick: (d: string) => void; counts: Record<CalendarType, number>;
}) {
  const [typesOpen, setTypesOpen] = useState(true);
  const [editing, setEditing] = useState<CalendarType | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const editRef = usePopover(!!editing, closeEdit);
  return (
    <aside className="cal-side" aria-label="Calendar options">
      <MiniMonth anchor={anchor} from={from} to={to} today={today} onPick={onPick} />
      <label className="cal-sort">Sort events
        <select value={s.sort} onChange={(e) => set({ sort: e.target.value as CalendarSort })}>
          {Object.entries(CALENDAR_SORTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <div className="cal-types">
        <div className="cal-types-head">
          <button type="button" className="linkish" aria-expanded={typesOpen} onClick={() => setTypesOpen(!typesOpen)}>
            <Icon name="chevron" size={14} className={typesOpen ? undefined : "rot-90"} /> Event types
          </button>
          <span className="row" style={{ gap: 4 }}>
            <button type="button" className={`cal-icon-btn cal-tool${s.colorByType ? " on" : ""}`} aria-pressed={s.colorByType} aria-label="Color by event type" title="Color by event type (off: each to-do's own color)" onClick={() => set({ colorByType: !s.colorByType })}><Icon name="brush" size={15} /></button>
            <button type="button" className={`cal-icon-btn cal-tool${s.groupByType ? " on" : ""}`} aria-pressed={s.groupByType} aria-label="Group by event type" title="Group each day's events by type" onClick={() => set({ groupByType: !s.groupByType })}><Icon name="layers" size={15} /></button>
          </span>
        </div>
        {typesOpen && CALENDAR_TYPES.map((t) => (
          <div key={t} className="cal-type-row">
            <label className="check">
              <input type="checkbox" checked={s.types[t]} onChange={(e) => set({ types: { ...s.types, [t]: e.target.checked } })} />
              <span className="cal-type-icon" style={{ color: s.colors[t], background: `${s.colors[t]}1f` }}><Icon name={CALENDAR_TYPE_INFO[t].icon} size={14} /></span>
              {CALENDAR_TYPE_INFO[t].label}{counts[t] ? <span className="muted"> {counts[t]}</span> : null}
            </label>
            <button type="button" className="cal-icon-btn cal-edit-color" aria-label={`Edit color for ${CALENDAR_TYPE_INFO[t].label}`} title="Edit color" onClick={() => setEditing(editing === t ? null : t)}><Icon name="pencil" size={13} /></button>
            {editing === t && (
              <div className="cal-menu cal-color-pop" ref={editRef} role="dialog" aria-label="Event color">
                <strong>Event color</strong>
                <div className="cal-swatches">
                  {CALENDAR_COLORS.map((c) => <button key={c} type="button" aria-label={c} aria-pressed={s.colors[t] === c} style={{ background: c }} onClick={() => set({ colors: { ...s.colors, [t]: c } })} />)}
                  <label className="cal-swatch-custom" title="Any color"><Icon name="plus" size={14} /><input type="color" value={s.colors[t]} onChange={(e) => set({ colors: { ...s.colors, [t]: e.target.value } })} aria-label="Pick any color" /></label>
                </div>
                <label className="check cal-contrast"><input type="checkbox" checked={s.highContrast} onChange={(e) => set({ highContrast: e.target.checked })} /> High contrast (filled cards)</label>
                <button type="button" className="linkbtn" onClick={() => set({ colors: { ...s.colors, [t]: CALENDAR_TYPE_INFO[t].color } })}>Back to the standard color</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="cal-icon-btn cal-collapse" aria-label="Collapse sidebar" title="Hide this panel" onClick={() => set({ sidebar: false })}><Icon name="sidebar" size={16} /></button>
    </aside>
  );
}

/** "+ Filter": pick a kind, then a value; each filter shows as a chip you can remove. */
function FilterBar({ filters, setFilters, events, tags, services }: { filters: CalFilter[]; setFilters: (f: CalFilter[]) => void; events: CalendarEvent[]; tags: { id: string; name: string }[]; services: { id: string; name: string }[] }) {
  const [kind, setKind] = useState<FilterKind | null>(null);
  const people = useMemo(() => { const m = new Map<string, string>(); for (const e of events) for (const p of e.people) m.set(p.id, p.name); return [...m].sort((a, b) => a[1].localeCompare(b[1])); }, [events]);
  const crewsIn = useMemo(() => { const m = new Map<string, string>(); for (const e of events) if (e.crew) m.set(e.crew.id, e.crew.name); return [...m].sort((a, b) => a[1].localeCompare(b[1])); }, [events]);
  const customers = useMemo(() => { const m = new Map<string, string>(); for (const e of events) if (e.customer) m.set(e.customer.id, e.customer.name); return [...m].sort((a, b) => a[1].localeCompare(b[1])); }, [events]);
  const options: Record<FilterKind, [string, string][]> = {
    status: [["open", "Open"], ["done", "Done"]],
    recurring: [["yes", "Repeating"], ["no", "One-time"]],
    invoice: [["yes", "Invoiced"], ["no", "Not invoiced"]],
    onsite: [["yes", "On site now"], ["no", "Not on site"]],
    tracked: [["yes", "Has time tracked"], ["no", "No time tracked"]],
    service: services.filter((x) => events.some((e) => e.serviceIds.includes(x.id))).map((x) => [x.id, x.name]),
    person: [...people, ["none", "Nobody assigned"]],
    crew: [...crewsIn, ["none", "No crew (work orders)"]],
    customer: customers,
    tag: tags.map((t) => [t.id, t.name]),
  };
  const add = (f: CalFilter) => setFilters([...filters.filter((x) => x.kind !== f.kind), f]);
  return (
    <div className="cal-filters">
      <span className="muted">Filter</span>
      {filters.map((f) => (
        <span key={f.kind} className="cal-chip">{FILTER_LABELS[f.kind]}: <strong>{f.label}</strong>
          <button type="button" aria-label={`Remove the ${FILTER_LABELS[f.kind]} filter`} onClick={() => setFilters(filters.filter((x) => x !== f))}><Icon name="close" size={12} /></button>
        </span>
      ))}
      <Menu label="Add a filter" text={<><Icon name="plus" size={14} /> Filter</>}>
        {(close) => !kind ? (
          <>
            <div className="menu-heading">Filter by…</div>
            {(Object.keys(FILTER_LABELS) as FilterKind[]).map((k) => <button key={k} type="button" role="menuitem" data-tip="Show only what matches: pick the values next" onClick={() => setKind(k)}>{FILTER_LABELS[k]}<Icon name="right" size={14} /></button>)}
          </>
        ) : (
          <>
            <button type="button" className="menu-heading linkish" onClick={() => setKind(null)}><Icon name="left" size={12} /> {FILTER_LABELS[kind]}</button>
            {options[kind].length ? options[kind].map(([v, l]) => (
              <button key={v} type="button" role="menuitem" onClick={() => { add({ kind, value: v, label: l }); setKind(null); close(); }}>{l}</button>
            )) : <p className="muted cal-menu-empty">{kind === "tag" ? "No customer tags" : kind === "service" ? "No services on work orders in this range" : "Nothing in this range"}</p>}
          </>
        )}
      </Menu>
      {filters.length > 0 && <button type="button" className="linkbtn" onClick={() => setFilters([])}>Clear</button>}
    </div>
  );
}

function CalendarPage() {
  const { me, can } = useAuth();
  const params = useSearchParams();
  const { s, set, reset } = useCalSettings(me?.user.id);
  const [anchor, setAnchor] = useState<string>(params.get("d") ?? "");
  const [filters, setFilters] = useState<CalFilter[]>([]);
  const [search, setSearch] = useState("");
  const [popup, setPopup] = useState<{ e: CalendarEvent; rect: DOMRect } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view: CalView = s.view;
  // A link with ?v=week (or day / month) opens that view.
  useEffect(() => {
    const v = params.get("v");
    if (v === "day" || v === "week" || v === "month") set({ view: v });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const probe = useApi<{ today: string }>("/todos?limit=1");
  const today = probe.data?.today ?? localToday();
  useEffect(() => { if (!anchor && probe.data) setAnchor(probe.data.today); }, [anchor, probe.data]);
  const at = anchor || today;
  const { from, to } = rangeFor(view, at);
  const data = useApi<{ events: CalendarEvent[]; today: string }>(`/events?from=${from}&to=${to}`);
  const unscheduled = useApi<CalendarEvent[]>(s.unscheduled ? "/events/unscheduled" : null);
  const tagList = useApi<{ id: string; name: string }[]>(can("manager", "customers") ? "/crm/tags" : null);
  const serviceList = useApi<{ id: string; name: string }[]>(can("manager", "customers") ? "/service-types?all=1" : null);
  const reload = useCallback(() => { data.reload(); if (s.unscheduled) unscheduled.reload(); }, [data.reload, unscheduled.reload, s.unscheduled]); // eslint-disable-line react-hooks/exhaustive-deps
  // Completed from the pop-up: a chemical work order asks what was applied first.
  const completing = useCompleteVisit(reload);
  useEffect(() => {
    window.addEventListener("crewdesk:todos", reload);
    return () => window.removeEventListener("crewdesk:todos", reload);
  }, [reload]);
  // The address keeps the view and date, so Back and shared links work.
  useEffect(() => {
    if (!anchor) return;
    const url = new URL(window.location.href);
    url.searchParams.set("v", view); url.searchParams.set("d", anchor);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }, [view, anchor]);

  const all = data.data?.events ?? [];
  const counts = Object.fromEntries(CALENDAR_TYPES.map((t) => [t, all.filter((e) => e.type === t).length])) as Record<CalendarType, number>;
  const visible = applyFilters(all.filter((e) => s.types[e.type]), filters, search);
  const dayList = days(from, to);

  const go = (v: CalView, d = at) => { set({ view: v }); setAnchor(d); };
  const move = async (type: string, id: string, day: string) => {
    setError(null);
    try { await api("/events/move", { body: { type, id, date: day } }); reload(); } catch (e) { setError((e as Error).message); }
  };
  const open = (e: CalendarEvent, el: HTMLElement) => setPopup({ e, rect: el.getBoundingClientRect() });

  // Keyboard: D / W / M for the view, T for today, ← → to move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select, [contenteditable=true]")) return;
      const k = e.key.toLowerCase();
      if (k === "d") go("day"); else if (k === "w") go("week"); else if (k === "m") go("month");
      else if (k === "t") setAnchor(today);
      else if (e.key === "ArrowLeft") setAnchor(step(view, at, -1));
      else if (e.key === "ArrowRight") setAnchor(step(view, at, 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const grid = { dayList, events: visible, s, today, onOpen: open, onMove: move, onAdd: (d: string) => setAdding(d), onDay: (d: string) => go("day", d) };
  const total = workHours(visible);
  const money = workMoney(visible);

  return (
    <div className={`cal-page${s.sidebar ? "" : " no-side"}`}>
      <PageHead title="Calendar" sub="Work orders, to-dos, repair orders, time off, holidays and shifts in one place" />
      <p className="cal-print-title">Calendar · {rangeLabel(view, at)} · printed {fmt(today, { month: "short", day: "numeric", year: "numeric" })}</p>
      <div className="cal-layout">
        {s.sidebar && <Sidebar s={s} set={set} anchor={at} from={from} to={to} today={today} onPick={(d) => setAnchor(d)} counts={counts} />}
        <div className="cal-main">
          <div className="cal-toolbar card">
            {!s.sidebar && <button type="button" className="cal-icon-btn cal-tool" aria-label="Show the side panel" title="Show the side panel" onClick={() => set({ sidebar: true })}><Icon name="sidebar" size={17} /></button>}
            <FilterBar filters={filters} setFilters={setFilters} events={all} tags={tagList.data ?? []} services={serviceList.data ?? []} />
            <div className="cal-tools">
              <label className="cal-search"><Icon name="search" size={15} /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events" aria-label="Search events" /></label>
              <button type="button" className={`cal-icon-btn cal-tool${s.unscheduled ? " on" : ""}`} aria-pressed={s.unscheduled} aria-label="Waitlist" title="Waitlist: work orders with no date and repair orders with no due date (drag one onto a day)" onClick={() => set({ unscheduled: !s.unscheduled })}><Icon name="hourglass" size={17} /></button>
              <Menu label="Event card details" icon="sliders" align="right">
                {() => (
                  <>
                    <div className="menu-heading">Show on each card</div>
                    {(Object.keys(DETAILS) as DetailKey[]).map((k) => (
                      <button key={k} type="button" role="menuitemcheckbox" aria-checked={s.details[k]} className={s.details[k] ? undefined : "muted"} data-tip={s.details[k] ? "Showing on each card: click to hide it" : "Hidden: click to show it on each card"} onClick={() => set({ details: { ...s.details, [k]: !s.details[k] } })}>
                        {DETAILS[k]}<Icon name={s.details[k] ? "eye" : "eyeOff"} size={14} />
                      </button>
                    ))}
                  </>
                )}
              </Menu>
              <button type="button" className={`cal-icon-btn cal-tool${s.rollup ? " on" : ""}`} aria-pressed={s.rollup} aria-label="Budgeted hours by person" title="Budgeted hours by person, under each day" onClick={() => set({ rollup: !s.rollup })}><Icon name="clock" size={17} /></button>
              <div className="cal-seg" role="group" aria-label="Calendar or list">
                <button type="button" aria-pressed={s.mode === "calendar"} aria-label="Calendar view" title="Calendar" onClick={() => set({ mode: "calendar" })}><Icon name="calendar" size={16} /></button>
                <button type="button" aria-pressed={s.mode === "list"} aria-label="List view" title="List" onClick={() => set({ mode: "list" })}><Icon name="list" size={16} /></button>
              </div>
              <Menu label="More calendar options" icon="more" align="right">
                {(close) => (
                  <>
                    <button type="button" role="menuitem" onClick={() => { close(); setAdding(at); }}><span>Add a work order or to-do</span><Icon name="plus" size={14} /></button>
                    <Link role="menuitem" href="/visits" onClick={close}><span>Open Work orders</span><Icon name="clipboard" size={14} /></Link>
                    <Link role="menuitem" href="/todos" onClick={close}><span>Open the To-dos page</span><Icon name="todo" size={14} /></Link>
                    <button type="button" role="menuitem" onClick={() => { close(); window.print(); }}><span>Print</span><Icon name="print" size={14} /></button>
                    <button type="button" role="menuitem" onClick={() => { close(); downloadCsv(visible, from, to); }}><span>Export (spreadsheet)</span><Icon name="download" size={14} /></button>
                    <button type="button" role="menuitem" onClick={() => { close(); reset(); setFilters([]); setSearch(""); }}><span>Reset calendar settings</span></button>
                  </>
                )}
              </Menu>
            </div>
          </div>

          <div className="card cal-board">
            <div className="cal-range">
              <div className="cal-range-pick">
                <Menu label="Change the view" text={<><Icon name="calendar" size={15} /> {VIEWS.find((v) => v.key === view)?.label} <Icon name="chevron" size={14} /></>}>
                  {(close) => VIEWS.map((v) => (
                    <button key={v.key} type="button" role="menuitemradio" aria-checked={view === v.key} data-tip={`Show one ${v.label.toLowerCase()} at a time (or press ${v.hotkey})`} onClick={() => { go(v.key); close(); }}><span>{v.label}</span><kbd>{v.hotkey}</kbd></button>
                  ))}
                </Menu>
                <Menu label="Pick a date" text={<span className="cal-range-text">{rangeLabel(view, at)}</span>}>
                  {(close) => <MiniMonth anchor={at} from={from} to={to} today={today} onPick={(d) => { setAnchor(d); close(); }} />}
                </Menu>
              </div>
              <div className="cal-nav">
                <button type="button" className="btn" aria-label={`Previous ${view}`} onClick={() => setAnchor(step(view, at, -1))}><Icon name="left" size={16} /></button>
                <button type="button" className="btn" onClick={() => setAnchor(today)}>Today</button>
                <button type="button" className="btn" aria-label={`Next ${view}`} onClick={() => setAnchor(step(view, at, 1))}><Icon name="right" size={16} /></button>
              </div>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            {data.error && <p className="error" role="alert">{data.error}</p>}
            <div className="cal-body">
              <div className="cal-content" aria-busy={data.loading}>
                {s.mode === "list" ? <ListView {...grid} />
                  : view === "week" ? <WeekGrid {...grid} />
                  : view === "month" ? <MonthGrid {...grid} anchorMonth={at.slice(0, 7)} />
                  : <DayView day={at} {...grid} />}
              </div>
              {s.unscheduled && (
                <aside className="cal-unscheduled" aria-label="Waitlist">
                  <div className="cal-unscheduled-head"><strong>Waitlist</strong><button type="button" className="cal-icon-btn" aria-label="Close" onClick={() => set({ unscheduled: false })}><Icon name="close" size={14} /></button></div>
                  <p className="muted">Work orders with no date and repair orders with no due date. Drag one onto a day to schedule it.</p>
                  {unscheduled.data?.length ? unscheduled.data.map((e) => <EventCard key={e.key} e={e} s={s} onOpen={open} />)
                    : unscheduled.data ? <p className="muted">Nothing waiting.</p> : null}
                </aside>
              )}
            </div>
            <div className="cal-foot">
              <span>{visible.length} event{visible.length === 1 ? "" : "s"}{visible.length !== all.length ? ` (of ${all.length})` : ""}</span>
              <button type="button" className="cal-icon-btn" aria-label="Print" title="Print" onClick={() => window.print()}><Icon name="print" size={16} /></button>
              <button type="button" className="cal-icon-btn" aria-label="Export" title="Export to a spreadsheet" onClick={() => downloadCsv(visible, from, to)}><Icon name="download" size={16} /></button>
              <span className="cal-foot-total">{[money != null ? `Total ${formatMoney(money)}` : null, total ? `${total} h budgeted` : null].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        </div>
      </div>
      {popup && <EventPopover key={popup.e.key} e={popup.e} s={s} anchor={popup.rect} onClose={() => setPopup(null)} onChanged={reload} onComplete={completing.start} />}
      {completing.dialog}
      {completing.error && <div className="error" role="alert" style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 1001 }}>{completing.error}</div>}
      {adding && <AddTodoModal date={adding} canWorkOrder={can("manager", "customers")} onClose={() => setAdding(null)} onSaved={reload} />}
    </div>
  );
}

export default function Page() {
  return <Suspense><CalendarPage /></Suspense>;
}

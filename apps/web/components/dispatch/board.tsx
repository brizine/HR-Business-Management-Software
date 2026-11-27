"use client";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BACK_REASONS, BACK_REASON_LABELS, clock12, clockText, formatMoney, milesText, routeTimeline, type Leg } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Popover, readLocal, writeLocal } from "@/components/customer-list";
import { useTags } from "@/components/customers";
import { Icon } from "@/components/icons";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import {
  AddFilter, BOARD_FILTER_KINDS, BoardPicker, BulkMenu, Columns, EditWorkOrders, FILTER_KINDS, STATUS_LABELS, SaveView, WL_COLUMNS, WaitMap, WorkloadStrip,
  applyFilters, badgeLegend, dayLabel, describeFilter, plusDays, totalsOf,
  type Crew, type Filter, type MapLine, type SavedView, type WCol, type WaitData, type WaitRow, type WaitView,
} from "@/components/waitlist";
import { dispatchApi, type DRoute, type Preview } from "./data";
import { Ico } from "./beta-parts";
import { RouteStops } from "./route-stops";

/**
 * The Dispatch board from the Crewdesk plan. It is the same page as the waiting list, for the work
 * that has a day: the view picker and filter chips on top, a large map (each crew's route in its
 * color with numbered pins, waiting-list services in gray), the week's workload, then the list with
 * a totals row. The list is grouped by truck or crew in route order; drag rows to reorder or to give
 * them to another crew. Select rows or pins and Edit work orders moves them. Route stops opens one
 * crew's day to put in order by hand or optimize, with curbside arrival.
 */

type Note = { id: string; body: string; by: string | null; at: string };
type BoardRow = WaitRow & { assigneeIds: string[]; route: { id: string; order: number; locked: boolean } | null; startTime: string | null; finishedAt: string | null; skipReason: string | null; notes: Note[]; waiting?: boolean };
type BCrew = Crew & { memberIds: string[]; truck: string | null };
type BoardData = {
  today: string; from: string; to: string; requireCard: boolean; rows: BoardRow[]; routes: DRoute[]; holidays: Record<string, string>; waiting: number;
  crews: BCrew[]; people: { id: string; firstName: string; name: string; color: string }[]; routing: "estimate" | "road"; /** New routes start out planned for curbside arrival. */ curbside: boolean; start: { address: string; lat: number; lng: number } | null;
};
type Eta = { at: number; off: "late" | "early" | null; leg: Leg | null };
type Ctx = { crews: BCrew[]; people: Map<string, { firstName: string; name: string }>; eta: Map<string, Eta>; onNotes: () => void };
type BCol = { key: string; label: string; group: string; num?: boolean; sort?: (r: BoardRow, c: Ctx) => string | number | null; text: (r: BoardRow, c: Ctx) => string; cell?: (r: BoardRow, c: Ctx) => ReactNode };
type LoadSheet = { groups: { stops: { visitId: string; items: { product: string; unit: string; amount: number; method: string | null; sprayGal: number | null }[] }[] }[] };
type Lane = { key: string; date: string; crew: BCrew | null; rows: BoardRow[]; all: BoardRow[]; route: DRoute | undefined };

const GRAY = "#94a3b8";
const hoursOf = (min: number | null) => (min ?? 0) / 60;
const h1 = (h: number) => (Math.round(h * 10) / 10).toString();
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const startOfWeek = (d: string) => plusDays(d, -new Date(`${d}T12:00:00Z`).getUTCDay());
const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const laneKey = (date: string, crewId: string | null) => `${date}|${crewId ?? ""}`;
/** A crew's day in the order it's driven: the route's stops, then the ones with no place yet (by time). */
const inRouteOrder = (rows: BoardRow[]) => [...rows].sort((a, b) => (a.route && b.route ? a.route.order - b.route.order : a.route ? -1 : b.route ? 1 : (a.startTime ?? a.windowStart ?? "99").localeCompare(b.startTime ?? b.windowStart ?? "99") || a.number - b.number));

/* ───────────── Columns: the waiting list's, plus the board's own ───────────── */

function StatusPill({ r }: { r: BoardRow }) {
  if (r.waiting) return <span className="wl-badge">Waiting</span>;
  return <span className={`wl-badge db-st-${r.status}`} title={r.status === "skipped" && r.skipReason ? r.skipReason : undefined}>{STATUS_LABELS[r.status] ?? r.status}</span>;
}

/** The notes between the office and the field on one work order, and a box to add one. */
function RowNotes({ r, onAdded }: { r: BoardRow; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const act = useAction();
  if (r.waiting) return null;
  return (
    <Popover open={open} setOpen={setOpen} buttonClass={`linkbtn db-notes${r.notes.length ? " has" : ""}`} label={r.notes.length ? `${r.notes.length} note${r.notes.length === 1 ? "" : "s"}` : "Add"} className="cl-pop-wide" align="right">
      <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) act.run(async () => { await dispatchApi.note(`v:${r.id}`, text.trim()); setText(""); onAdded(); }); }}>
        {r.notes.map((n) => <div key={n.id} className="db-note"><div>{n.body}</div><span className="muted">{n.by ?? "Someone"} · {stamp(n.at)}</span></div>)}
        {!r.notes.length && <p className="muted" style={{ margin: 0 }}>No notes yet. Notes go between the office and the crew; customers never see them.</p>}
        <input value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Add a note for the crew" aria-label="Add a note" />
        <ErrorBox error={act.error} />
        <div className="row"><button className="btn primary sm" disabled={act.busy || !text.trim()}>Add note</button></div>
      </form>
    </Popover>
  );
}

const crewOf = (r: BoardRow, c: Ctx) => (r.crewId ? c.crews.find((x) => x.id === r.crewId) ?? null : null);
const techsOf = (r: BoardRow, c: Ctx) => r.assigneeIds.map((id) => c.people.get(id)?.firstName).filter(Boolean).join(", ");
const BOARD_ONLY: BCol[] = [
  { key: "assigned", label: "Truck / crew", group: "Dispatch", sort: (r, c) => crewOf(r, c)?.name.toLowerCase() ?? "", text: (r, c) => crewOf(r, c)?.name ?? (r.assigneeIds.length ? techsOf(r, c) : ""),
    cell: (r, c) => { const crew = crewOf(r, c); return crew ? <><span className="wl-dot" style={{ background: crew.color }} />{crew.name}</> : r.assigneeIds.length ? <>{techsOf(r, c)}</> : <span className="muted">No crew yet</span>; } },
  { key: "techs", label: "Technicians", group: "Dispatch", text: (r, c) => techsOf(r, c) },
  { key: "eta", label: "Arrives about", group: "Dispatch", sort: (r, c) => c.eta.get(r.id)?.at ?? null, text: (r, c) => { const e = c.eta.get(r.id); return e ? clock12(e.at) : ""; },
    cell: (r, c) => { const e = c.eta.get(r.id); if (!e || r.status === "completed" || r.status === "skipped") return <span className="muted">—</span>; return <span className={e.off === "late" ? "bad-text" : undefined} title={e.off === "late" ? "After its appointment window" : e.off === "early" ? "Before its appointment window opens" : "From the route's start time, the drives and the time at each stop"}>{clock12(e.at)}{e.off === "late" ? " · late" : e.off === "early" ? " · early" : ""}</span>; } },
  { key: "drive", label: "Drive (min)", group: "Dispatch", num: true, sort: (r, c) => c.eta.get(r.id)?.leg?.seconds ?? null, text: (r, c) => { const l = c.eta.get(r.id)?.leg; return l ? String(Math.max(1, Math.round(l.seconds / 60))) : ""; } },
  { key: "status", label: "Status", group: "Dispatch", sort: (r) => ["on_site", "open", "completed", "skipped"].indexOf(r.status), text: (r) => (r.waiting ? "Waiting" : STATUS_LABELS[r.status] ?? r.status), cell: (r) => <StatusPill r={r} /> },
  { key: "date", label: "Date", group: "Dispatch", sort: (r) => r.date ?? "", text: (r) => (r.date ? dayLabel(r.date) : "") },
  { key: "notes", label: "Notes", group: "Dispatch", sort: (r) => r.notes.length, text: (r) => r.notes.map((n) => n.body).join(" | "), cell: (r, c) => <RowNotes r={r} onAdded={c.onNotes} /> },
];
// The waiting list's columns that mean something for scheduled work.
const FROM_WAITLIST = (WL_COLUMNS as WCol[]).filter((c) => !["waited", "released", "back"].includes(c.key)).map((c): BCol => ({
  key: c.key, label: c.label, group: c.group, num: c.num, sort: c.sort ? (r) => c.sort!(r) : undefined, text: (r, ctx) => c.text(r, ctx.crews), cell: c.cell ? (r, ctx) => c.cell!(r, ctx.crews) : undefined,
}));
const BOARD_COLUMNS: BCol[] = [...FROM_WAITLIST.slice(0, 3), ...BOARD_ONLY, ...FROM_WAITLIST.slice(3)];
const DEFAULT_COLUMNS = ["property", "service", "mc", "eta", "window", "est", "sqft", "price", "status", "notes", "badges"];
const colByKey = new Map(BOARD_COLUMNS.map((c) => [c.key, c]));
const BY_ROUTE = { key: "route", dir: "asc" as const };
const BUILT_IN: WaitView[] = [
  { name: "Dispatch board", filters: [], columns: DEFAULT_COLUMNS, sort: BY_ROUTE },
  { name: "Not done yet", filters: [{ key: "status", value: "open" }, { key: "status", value: "on_site" }], columns: DEFAULT_COLUMNS, sort: BY_ROUTE },
  { name: "No crew yet", filters: [{ key: "assigned", value: "none" }], columns: ["property", "service", "mc", "window", "est", "sqft", "price", "badges"], sort: BY_ROUTE },
  { name: "Done or skipped", filters: [{ key: "status", value: "completed" }, { key: "status", value: "skipped" }], columns: ["property", "service", "assigned", "status", "est", "sqft", "price"], sort: BY_ROUTE },
];

function exportRows(rows: BoardRow[], columns: string[], ctx: Ctx, name: string) {
  const cols = columns.map((k) => colByKey.get(k)).filter((c): c is BCol => !!c);
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [["Stop", ...cols.map((c) => c.label)].map(q).join(","), ...rows.map((r) => [r.route ? String(r.route.order) : "", ...cols.map((c) => c.text(r, ctx))].map(q).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `dispatch-${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ───────────── The page ───────────── */

export function DispatchBoard() {
  const { can } = useAuth();
  const isAdmin = can("admin", "customers");
  const [view, setViewState] = useState<WaitView>(() => readLocal("db-view", BUILT_IN[0]));
  const setView = (v: WaitView) => { setViewState(v); writeLocal("db-view", v); };
  const [span, setSpanState] = useState<"day" | "week">(() => readLocal("db-span", "day"));
  const setSpan = (s: "day" | "week") => { setSpanState(s); writeLocal("db-span", s); };
  const [pins, setPinsState] = useState<boolean>(() => readLocal("db-waiting-pins", true));
  const [waitOpen, setWaitOpenState] = useState<boolean>(() => readLocal("db-waiting-rows", false));
  const [date, setDate] = useState<string | null>(null);
  const [q, setQ] = useState(() => view.filters.find((f) => f.key === "q")?.value ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ date?: string; crewId?: string | null; to?: "board" | "waitlist" } | null>(null);
  const [rain, setRain] = useState<{ who: string } | null>(null);
  const [routing, setRouting] = useState<{ date: string; crewId?: string | null } | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [workKey, setWorkKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ lane: string; before: string | null } | null>(null);
  const [hint, setHint] = useState<{ id: string; p: Preview } | null>(null);
  const hintWanted = useRef("");
  const [busy, setBusy] = useState<string | null>(null);
  const act = useAction();

  const from = date ? (span === "week" ? startOfWeek(date) : date) : null;
  const to = from ? (span === "week" ? plusDays(from, 6) : from) : null;
  const data = useApi<BoardData>(`/dispatch/list${from ? `?from=${from}&to=${to}` : ""}`);
  const d = data.data;
  const day = date ?? d?.today ?? "";
  // With no day picked yet the server answers for today; the week view then needs its own range.
  useEffect(() => { if (!date && d && span === "week") setDate(d.today); }, [date, d, span]);
  const waiting = useApi<WaitData>(pins || waitOpen ? "/waitlist" : null);
  const load = useApi<LoadSheet>(d && span === "day" ? `/chemical-tracking/load-sheet?date=${d.from}&by=day` : null);
  const views = useApi<SavedView[]>("/waitlist/views?page=dispatch");
  const { tags } = useTags();
  const tagNames = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags]);

  // Live: statuses and notes change as crews work, so the board re-reads every minute and when you come back to it.
  const reloadRef = useRef(data.reload);
  reloadRef.current = data.reload;
  useEffect(() => {
    if (drag) return;
    const again = () => { if (document.visibilityState === "visible") reloadRef.current(); };
    const timer = setInterval(again, 60_000);
    window.addEventListener("focus", again);
    return () => { clearInterval(timer); window.removeEventListener("focus", again); };
  }, [drag]);

  // The search box is a filter too (so it saves with a view), applied as you stop typing.
  useEffect(() => {
    const t = setTimeout(() => {
      const rest = view.filters.filter((f) => f.key !== "q");
      const next = q.trim() ? [...rest, { key: "q", value: q.trim() }] : rest;
      if (JSON.stringify(next) !== JSON.stringify(view.filters)) setView({ ...view, filters: next });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const all = useMemo(() => d?.rows ?? [], [d]);
  const crews = useMemo(() => d?.crews ?? [], [d]);
  const grouped = !view.sort || view.sort.key === "route";
  const columns = (view.columns.length ? view.columns : DEFAULT_COLUMNS).filter((k) => colByKey.has(k));

  /* ── When each stop is reached, from each route's start time, drives and time on site ── */
  const eta = useMemo(() => {
    const out = new Map<string, Eta>();
    const byId = new Map(all.map((r) => [`v:${r.id}`, r]));
    for (const rt of d?.routes ?? []) {
      const rows = rt.stops.map((s) => byId.get(s.key));
      const t = routeTimeline({ startTime: rt.startTime, minutes: rows.map((r) => r?.estMinutes ?? 0), legs: rt.stops.map((s) => s.leg), endLeg: rt.endLeg });
      rows.forEach((r, i) => {
        if (!r) return;
        const at = t.arrive[i];
        out.set(r.id, { at, leg: rt.stops[i].leg, off: r.status !== "open" ? null : r.windowEnd && at > minutesOf(r.windowEnd) ? "late" : r.windowStart && at < minutesOf(r.windowStart) - 1 ? "early" : null });
      });
    }
    return out;
  }, [all, d]);
  const ctx: Ctx = useMemo(() => ({ crews, people: new Map((d?.people ?? []).map((p) => [p.id, p])), eta, onNotes: () => reloadRef.current() }), [crews, d, eta]);

  /* ── Filtered and sorted once, so the map, the list and the export agree ── */
  const crewIndex = useMemo(() => new Map(crews.map((c, i) => [c.id, i + 1])), [crews]);
  const shown = useMemo(() => {
    const rows = applyFilters(all, view.filters) as BoardRow[];
    const col = view.sort && view.sort.key !== "route" ? colByKey.get(view.sort.key) : undefined;
    // By route: each day, "No crew yet" first, then each crew's stops in the order they're driven.
    if (!col?.sort) return [...rows].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (crewIndex.get(a.crewId ?? "") ?? 0) - (crewIndex.get(b.crewId ?? "") ?? 0) || (a.route && b.route ? a.route.order - b.route.order : a.route ? -1 : b.route ? 1 : a.number - b.number));
    const dir = view.sort!.dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const x = col.sort!(a, ctx), y = col.sort!(b, ctx);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
    });
  }, [all, view.filters, view.sort, crewIndex, ctx]);
  // Waiting-list services that match the same filters (not the board-only ones), shown in gray alongside.
  const waitShown = useMemo(() => (applyFilters(waiting.data?.rows ?? [], view.filters.filter((f) => f.key !== "status" && f.key !== "assigned")) as WaitRow[])
    .map((w): BoardRow => ({ ...w, assigneeIds: [], route: null, startTime: null, finishedAt: null, skipReason: null, notes: [], waiting: true })), [waiting.data, view.filters]);
  const mcFiltered = view.filters.some((f) => f.key === "mc" || f.key === "mcIs");
  const waitRowsOpen = waitOpen || mcFiltered;

  // Drop selections that the filters hide (so totals and the Edit window match what you see).
  useEffect(() => {
    if (!d) return;
    const ids = new Set([...shown, ...waitShown].map((r) => r.id));
    if ([...selected].some((id) => !ids.has(id))) setSelected(new Set([...selected].filter((id) => ids.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, waitShown]);
  const picked = useMemo(() => [...shown, ...waitShown].filter((r) => selected.has(r.id)), [shown, waitShown, selected]);
  const pickedTotals = totalsOf(picked);
  const services = useMemo(() => new Map([...all, ...(waiting.data?.rows ?? [])].map((r) => [r.service.id ?? `name:${r.service.name}`, r.service.name])), [all, waiting.data]);

  /* ── Lanes: each day's "No crew yet", then each truck or crew, in route order ── */
  const days = useMemo(() => (d ? Array.from({ length: Math.round((Date.parse(d.to) - Date.parse(d.from)) / 86_400_000) + 1 }, (_, i) => plusDays(d.from, i)) : []), [d]);
  const lanes: Lane[] = useMemo(() => {
    if (!d) return [];
    const out: Lane[] = [];
    for (const date of days) {
      for (const crew of [null, ...crews]) {
        const mine = (r: BoardRow) => r.date === date && (r.crewId ?? null) === (crew?.id ?? null);
        const rows = inRouteOrder(shown.filter(mine));
        const everything = inRouteOrder(all.filter(mine));
        // A day shows every crew (and "No crew yet"), even with nothing on it, so there's somewhere to drag to.
        // A week, or a filtered list, shows only the ones with something in them.
        if (!rows.length && (span === "week" || view.filters.length > 0)) continue;
        out.push({ key: laneKey(date, crew?.id ?? null), date, crew, rows, all: everything, route: crew ? d.routes.find((r) => r.date === date && r.crewId === crew.id) : undefined });
      }
    }
    return out;
  }, [d, days, crews, shown, all, span, view.filters.length]);

  // Route stops works on a crew's whole day, whatever the filters are hiding.
  const routeLanes = useMemo(() => (d ? days.flatMap((date) => crews.map((crew) => ({ key: laneKey(date, crew.id), date, crew, all: inRouteOrder(all.filter((r) => r.date === date && r.crewId === crew.id)), route: d.routes.find((r) => r.date === date && r.crewId === crew.id) }))) : []), [d, days, crews, all]);

  const say = (text: string, bad = false) => setNotice({ text, bad });
  const refresh = async () => { await data.reload(); if (pins || waitOpen) waiting.reload(); if (span === "day") load.reload(); setWorkKey((k) => k + 1); };
  const done = (msg: string) => { say(msg); setSelected(new Set()); setEdit(null); setRain(null); setRouting(null); refresh(); };
  const toggle = (ids: string[]) => { const n = new Set(selected); const allOn = ids.every((id) => n.has(id)); for (const id of ids) if (allOn) n.delete(id); else n.add(id); setSelected(n); };
  const removeFilter = (i: number) => { const f = view.filters[i]; if (f.key === "q") setQ(""); setView({ ...view, filters: view.filters.filter((_, j) => j !== i) }); };
  const onSort = (key: string) => setView({ ...view, sort: { key, dir: view.sort?.key === key && view.sort.dir === "asc" ? "desc" : "asc" } });
  const setPins = (v: boolean) => { setPinsState(v); writeLocal("db-waiting-pins", v); };
  const setWaitOpen = (v: boolean) => { setWaitOpenState(v); writeLocal("db-waiting-rows", v); };
  const go = (dd: string) => { setDate(dd); setSelected(new Set()); };

  /* ── Drag a row: reorder it in its crew's route, or give it to another crew (or day) ── */
  const pointOf = (p: DRoute["start"]) => ({ kind: p.kind, label: p.label, lat: p.lat, lng: p.lng });
  const orderWith = (lane: Lane, id: string, before: string | null) => {
    const order = lane.all.map((r) => r.id).filter((x) => x !== id);
    const i = before ? order.indexOf(before) : -1;
    if (i >= 0) order.splice(i, 0, id); else order.push(id);
    return order.map((x) => `v:${x}`);
  };
  const hover = (lane: string, before: string | null) => setOver((o) => (o && o.lane === lane && o.before === before ? o : { lane, before }));
  // Before the drop: what it would do to that crew's day (drive, hours, time windows).
  useEffect(() => {
    hintWanted.current = "";
    setHint(null);
    if (!drag || !over) return;
    const lane = lanes.find((l) => l.key === over.lane);
    const row = all.find((r) => r.id === drag);
    if (!lane?.crew || !row || row.date !== lane.date) return;
    const id = `${drag}|${over.lane}|${over.before}`;
    hintWanted.current = id;
    const keys = orderWith(lane, drag, over.before);
    const timer = setTimeout(async () => {
      try { const p = await dispatchApi.preview({ date: lane.date, keys, ...(lane.route ? { start: pointOf(lane.route.start), end: pointOf(lane.route.end) } : {}) }); if (hintWanted.current === id) setHint({ id, p }); } catch { /* the drop itself says what's wrong */ }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, over]);
  const drop = async (lane: Lane) => {
    const id = drag, at = over;
    setDrag(null); setOver(null);
    if (!id) return;
    const row = [...all, ...waitShown].find((r) => r.id === id);
    if (!row) return;
    // From the waiting list: the Edit window checks the card on file and the eligible date first.
    if (row.waiting) { setSelected(new Set([id])); setEdit({ date: lane.date, crewId: lane.crew?.id ?? null }); return; }
    const same = row.date === lane.date && (row.crewId ?? null) === (lane.crew?.id ?? null);
    if (same && !lane.crew) return;
    if (row.status === "completed" && row.date !== lane.date) { say("A completed work order can't move to another day.", true); return; }
    setBusy(lane.key);
    try {
      await dispatchApi.lane(lane.date, lane.crew?.id ?? null, lane.crew ? orderWith(lane, id, at?.lane === lane.key ? at.before : null) : [`v:${id}`]);
      if (!same) say(`${row.property.street} → ${lane.crew?.name ?? "No crew yet"}${row.date !== lane.date ? `, ${dayLabel(lane.date)}` : ""}`);
    } catch (e) { say((e as Error).message, true); }
    await refresh();
    setBusy(null);
  };
  /** Orders a crew's day to keep the drive shortest, from the shop and back, around its locked stops. */
  const optimize = async (ls: Lane[]) => {
    const targets = ls.filter((l) => l.crew && l.all.filter((r) => r.status === "open").length > 1);
    if (!targets.length) { say("No crew has two or more open stops to order."); return; }
    setBusy(targets.length === 1 ? targets[0].key : "all");
    try {
      for (const l of targets) await api("/dispatch/edit", { method: "POST", body: { visitIds: l.all.filter((r) => r.status === "open").map((r) => r.id), to: "board", date: l.date, routeOrder: "optimize" } });
      const fresh = await api<BoardData>(`/dispatch/list?from=${d!.from}&to=${d!.to}`);
      const drive = targets.reduce((s, l) => s + (fresh.routes.find((r) => r.date === l.date && r.crewId === l.crew!.id)?.totalDriveSeconds ?? 0), 0);
      const meters = targets.reduce((s, l) => s + (fresh.routes.find((r) => r.date === l.date && r.crewId === l.crew!.id)?.totalMeters ?? 0), 0);
      say(`${targets.length === 1 ? targets[0].crew!.name : `${targets.length} routes`} ordered to keep the drive shortest, from the shop and back: ${clockText(drive)} of driving, ${milesText(meters)} mi${fresh.routing === "estimate" ? " (estimated)" : ""}. Locked stops kept their place.`);
    } catch (e) { say((e as Error).message, true); }
    await refresh();
    setBusy(null);
  };
  /** Manual routing: the selected stops, in the order they were clicked, go first on their crew's route; the rest follow as they were. */
  const routeAsPicked = async () => {
    const order = [...selected];
    const mine = (l: Lane) => order.filter((id) => l.all.some((r) => r.id === id));
    const targets = lanes.filter((l) => l.crew && mine(l).length > 0);
    if (!targets.length) { say("Select stops that have a crew first, in the order they should be visited.", true); return; }
    setBusy(targets.length === 1 ? targets[0].key : "all");
    try {
      for (const l of targets) { const first = mine(l); await dispatchApi.lane(l.date, l.crew!.id, [...first, ...l.all.map((r) => r.id).filter((id) => !first.includes(id))].map((id) => `v:${id}`)); }
      say(`${targets.map((l) => l.crew!.name).join(", ")}: the selected stops now come first, in the order you picked them.`);
      setSelected(new Set());
    } catch (e) { say((e as Error).message, true); }
    await refresh();
    setBusy(null);
  };
  const lock = async (rows: BoardRow[], locked: boolean) => {
    try { for (const r of rows.filter((x) => x.route && x.route.locked !== locked)) await dispatchApi.lock(`v:${r.id}`, locked); } catch (e) { say((e as Error).message, true); }
    await data.reload();
  };
  const bulk = (body: Record<string, unknown>, label: string) => act.run(async () => {
    const r = await api<{ done: number; kept: number }>("/waitlist/bulk", { method: "POST", body: { visitIds: picked.map((x) => x.id), ...body } });
    setBulkOpen(false);
    done(`${label} ${r.done}.${r.kept ? ` ${r.kept} couldn't be (already done or invoiced).` : ""}`);
  });
  const saveView = (name: string, shared: boolean) => act.run(async () => {
    const v = await api<{ id: string; name: string; shared: boolean }>("/waitlist/views", { method: "POST", body: { page: "dispatch", name, shared, config: { filters: view.filters, columns: view.columns, sort: view.sort } } });
    setView({ ...view, id: v.id, name: v.name, shared: v.shared, mine: true });
    setSaveOpen(false);
    views.reload();
  });
  const deleteView = (id: string) => act.run(async () => { await api(`/waitlist/views/${id}`, { method: "DELETE" }); views.reload(); });

  /* ── What a crew needs on the truck (from the load sheet; hidden without Chemical Tracking access) ── */
  const loadOf = (rows: BoardRow[]) => {
    const stops = load.data?.groups.flatMap((g) => g.stops) ?? [];
    const totals = new Map<string, { product: string; unit: string; amount: number }>();
    const spray = new Map<string, number>();
    for (const r of rows) {
      const s = stops.find((x) => x.visitId === r.id);
      if (!s || r.status === "completed" || r.status === "skipped") continue;
      const per = new Map<string, number>();
      for (const it of s.items) {
        const k = `${it.product}|${it.unit}`;
        totals.set(k, { product: it.product, unit: it.unit, amount: (totals.get(k)?.amount ?? 0) + it.amount });
        if (it.method && it.sprayGal != null) per.set(it.method, Math.max(per.get(it.method) ?? 0, it.sprayGal));
      }
      for (const [m, gal] of per) spray.set(m, (spray.get(m) ?? 0) + gal);
    }
    return { products: [...totals.values()].sort((x, y) => x.product.localeCompare(y.product)), spray: [...spray] };
  };

  /* ── Map: numbered pins in each crew's color, each route's line, the shop ── */
  const crewColor = (r: WaitRow) => crews.find((c) => c.id === r.crewId)?.color ?? "#64748b";
  const mapLines: MapLine[] = useMemo(() => {
    const where = new Map(all.map((r) => [`v:${r.id}`, r.property]));
    return (d?.routes ?? []).map((rt) => {
      const pts: [number, number][] = rt.geometry ?? [
        ...(rt.start.kind !== "none" && rt.start.lat != null && rt.start.lng != null ? [[rt.start.lat, rt.start.lng] as [number, number]] : []),
        ...rt.stops.map((s) => where.get(s.key)).filter((p): p is BoardRow["property"] => p?.lat != null && p.lng != null).map((p) => [p.lat!, p.lng!] as [number, number]),
        ...(rt.end.kind !== "none" && rt.end.lat != null && rt.end.lng != null ? [[rt.end.lat, rt.end.lng] as [number, number]] : []),
      ];
      return { color: crews.find((c) => c.id === rt.crewId)?.color ?? "#64748b", points: pts, dashed: !rt.geometry };
    });
  }, [d, all, crews]);
  const fitKey = `${d?.from}|${d?.to}|${JSON.stringify(view.filters.filter((f) => f.key !== "q"))}|${d ? 1 : 0}`;

  const totals = totalsOf(shown);
  const finished = shown.filter((r) => r.status === "completed").length;
  const total = (k: string) => (k === "est" ? h1(totals.minutes / 60) : k === "sqft" ? Math.round(totals.sqFt).toLocaleString() : k === "price" ? formatMoney(totals.cents) : "");
  const cols = columns.map((k) => colByKey.get(k)!);
  const allOn = shown.length > 0 && shown.every((r) => selected.has(r.id));

  const rowOf = (r: BoardRow, lane: Lane | null) => {
    const crew = lane?.crew ?? null;
    const before = !!drag && drag !== r.id && !!lane && over?.lane === lane.key && over.before === r.id;
    return (
      <tr key={r.id} className={[selected.has(r.id) ? "picked" : "", r.waiting ? "db-waiting" : "", r.status === "completed" || r.status === "skipped" ? "db-done" : "", before ? "db-drop-before" : "", drag === r.id ? "db-dragging" : ""].filter(Boolean).join(" ") || undefined}
        draggable={grouped && (r.waiting || r.status !== "completed")} onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }} onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={lane && !r.waiting ? (e) => { if (drag) { e.preventDefault(); hover(lane.key, crew ? r.id : null); } } : undefined} onDrop={lane && !r.waiting ? (e) => { e.preventDefault(); drop(lane); } : undefined}>
        <td className="cl-check"><input type="checkbox" aria-label={`Select ${r.property.street}, ${r.service.name}`} checked={selected.has(r.id)} onChange={() => toggle([r.id])} /></td>
        <td className="db-stop">
          {r.waiting ? <span className="db-num db-num-wait" title="On the waiting list">⧗</span> : (
            <>
              <span className="db-num" style={{ background: r.crewId ? crewColor(r) : GRAY }} title={r.route ? `Stop ${r.route.order}` : "No place in the route yet"}>{r.route ? r.route.order : "–"}</span>
              {r.route && <button type="button" className={`db-lock${r.route.locked ? " on" : ""}`} aria-pressed={r.route.locked} aria-label={r.route.locked ? "Locked in place" : "Lock in place"} title={r.route.locked ? "Locked at this place in the route. Click to free it." : "Lock this stop at this place: Optimize orders the others around it."} onClick={() => lock([r], !r.route!.locked)}><Ico name="lock" size={13} /></button>}
            </>
          )}
        </td>
        {cols.map((c) => <td key={c.key} className={c.num ? "num" : undefined}>{c.cell ? c.cell(r, ctx) : c.text(r, ctx) || <span className="muted">—</span>}</td>)}
      </tr>
    );
  };

  const laneHead = (l: Lane) => {
    const onSite = l.all.reduce((s, r) => s + hoursOf(r.estMinutes), 0);
    const driving = (l.route?.totalDriveSeconds ?? 0) / 3600;
    const used = onSite + driving;
    const capacity = l.crew?.dailyHours ?? null;
    const isOver = !!drag && over?.lane === l.key;
    const dragged = drag ? [...all, ...waitShown].find((r) => r.id === drag) : undefined;
    const joining = isOver && dragged && !(dragged.date === l.date && (dragged.crewId ?? null) === (l.crew?.id ?? null)) ? dragged : null;
    const fresh = isOver && hint && hint.id === `${drag}|${over!.lane}|${over!.before}` ? hint.p : null;
    const byKey = new Map(all.map((r) => [`v:${r.id}`, r]));
    const afterHours = fresh ? fresh.keys.reduce((s, k) => s + hoursOf(byKey.get(k)?.estMinutes ?? null), 0) + fresh.totalDriveSeconds / 3600 : joining ? used + hoursOf(joining.estMinutes) : null;
    const late = fresh ? (() => { const t = routeTimeline({ startTime: l.route?.startTime ?? "08:00", minutes: fresh.keys.map((k) => byKey.get(k)?.estMinutes ?? 0), legs: fresh.stops.map((s) => s.leg), endLeg: fresh.endLeg }); return fresh.keys.map((k, i) => ({ r: byKey.get(k), at: t.arrive[i] })).filter((x) => x.r && x.r.status === "open" && x.r.windowEnd && x.at > minutesOf(x.r.windowEnd)); })() : [];
    const back = l.route ? routeTimeline({ startTime: l.route.startTime, minutes: l.route.stops.map((s) => byKey.get(s.key)?.estMinutes ?? 0), legs: l.route.stops.map((s) => s.leg), endLeg: l.route.endLeg }).endAt : null;
    const sqFt = l.rows.reduce((s, r) => s + (r.property.sqFt ?? 0), 0);
    const doneN = l.rows.filter((r) => r.status === "completed").length;
    const needs = l.crew && span === "day" ? loadOf(l.rows) : null;
    const lateNow = l.rows.filter((r) => eta.get(r.id)?.off === "late").length;
    const unordered = !!l.crew && l.rows.some((r) => !r.route && r.status === "open");
    const ids = l.rows.map((r) => r.id);
    const full = capacity != null && (afterHours ?? used) > capacity + 0.04;
    return (
      <tr key={`h${l.key}`} className={`db-group${isOver ? " over" : ""}${busy === l.key || busy === "all" ? " busy" : ""}`} onDragOver={(e) => { if (drag) { e.preventDefault(); hover(l.key, null); } }} onDrop={(e) => { e.preventDefault(); drop(l); }}>
        <td className="cl-check">{ids.length > 0 && <input type="checkbox" aria-label={`Select all of ${l.crew?.name ?? "No crew yet"}`} checked={ids.every((id) => selected.has(id))} onChange={() => toggle(ids)} />}</td>
        <td colSpan={cols.length + 1}>
          <div className="db-group-row">
            <span className="db-group-name"><span className="wl-dot" style={{ background: l.crew?.color ?? GRAY }} /><strong>{span === "week" ? `${dayLabel(l.date)} · ` : ""}{l.crew?.name ?? "No crew yet"}</strong>
              {l.crew && <span className="muted">{[l.crew.truck, l.crew.memberIds.map((m) => ctx.people.get(m)?.firstName).filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</span>}</span>
            <span className="muted">{l.rows.length} stop{l.rows.length === 1 ? "" : "s"}{sqFt ? ` · ${Math.round(sqFt).toLocaleString()} sq ft` : ""}{doneN ? ` · ${doneN} done` : ""}{l.all.length !== l.rows.length ? ` · ${l.all.length - l.rows.length} hidden by the filters` : ""}</span>
            {capacity != null ? (
              afterHours != null ? (
                <span className={full ? "bad-text" : undefined}>
                  {joining ? <>Adds {Math.round(hoursOf(joining.estMinutes) * 60)} min on site{fresh ? ` + ${Math.max(0, Math.round((fresh.totalDriveSeconds - (l.route?.totalDriveSeconds ?? 0)) / 60))} min drive` : ""}: </> : <>In this order: </>}
                  <strong>{h1(afterHours)} of {h1(capacity)} h</strong>{full ? `, over by ${h1(afterHours - capacity)} h` : ""}
                  {late.length > 0 && <> · after their window: {late.map((x) => `${x.r!.customer.name} (about ${clock12(x.at)})`).join("; ")}</>}
                </span>
              ) : l.all.length ? (
                <span className={full ? "bad-text" : undefined} title={l.route && d?.routing === "estimate" ? "Drive times are estimates" : undefined}>{h1(onSite)} h on site{l.route ? ` + ${h1(driving)} h drive` : ""} = <strong>{h1(used)} of {h1(capacity)} h</strong>{full ? ` · over by ${h1(used - capacity)} h` : ""}</span>
              ) : <span className="muted">{h1(capacity)} h free · drag work orders here</span>
            ) : l.all.length ? <span className="muted">{h1(onSite)} h waiting for a crew</span> : <span className="muted">Everything has a crew</span>}
            {back != null && l.route && !joining && <span className="muted">leaves {clock12(minutesOf(l.route.startTime))}, back about {clock12(back)}</span>}
            {lateNow > 0 && !joining && <span className="bad-text">{lateNow} after {lateNow === 1 ? "its" : "their"} window</span>}
            {unordered && !joining && <span className="db-warn">Some have no place in the route yet</span>}
            <span className="db-group-acts">
              {needs && (needs.products.length > 0 || needs.spray.length > 0) && <ToLoad needs={needs} date={l.date} />}
              {l.crew && l.all.length > 0 && <button type="button" className="linkbtn" disabled={!!busy} title="Put this crew's stops in order by hand (drag them) or optimize them, with curbside arrival" onClick={() => setRouting({ date: l.date, crewId: l.crew!.id })}>Route stops</button>}
              {l.crew && l.all.filter((r) => r.status === "open").length > 1 && <button type="button" className="linkbtn" disabled={!!busy} title="Order this crew's stops to keep the drive shortest, from the shop and back. Locked stops keep their place." onClick={() => optimize([l])}>Optimize</button>}
              {l.all.some((r) => r.status === "open") && span === "day" && <button type="button" className="linkbtn" title="Rain or wind: move this crew's open work to another day or back to the waiting list" onClick={() => setRain({ who: l.crew?.id ?? "none" })}>Rain day</button>}
            </span>
          </div>
        </td>
      </tr>
    );
  };

  const title = d ? (span === "week" ? `${dayLabel(d.from)} to ${dayLabel(d.to)}` : dayLabel(d.from, { weekday: "long", month: "long", day: "numeric" })) : "";
  return (
    <>
      <PageHead title="Dispatch board" sub={d ? <>{title} · {shown.length} work order{shown.length === 1 ? "" : "s"}{finished ? `, ${finished} done` : ""}{span === "day" && d.holidays[d.from] ? ` · ${d.holidays[d.from]}` : ""}</> : "Loading…"}>
        <Popover open={legendOpen} setOpen={setLegendOpen} label="Badges" align="right" className="cl-pop-wide">
          <div className="wl-legend-list">{badgeLegend()}</div>
        </Popover>
        <Link className="btn" href="/dispatch-beta" title="The other dispatch board, a copy of Homeworks' New Dispatch">New Dispatch <span className="nav-badge">Beta</span></Link>
        <Link className="btn" href="/visits/new">New work order</Link>
      </PageHead>
      <ErrorBox error={data.error} />
      {notice && <div className={`alert ${notice.bad ? "bad" : "ok"} row`} style={{ justifyContent: "space-between" }} role="status"><span>{notice.text}</span><button type="button" className="linkbtn" onClick={() => setNotice(null)}>Dismiss</button></div>}

      <div className="wl-toolbar">
        <BoardPicker here="dispatch" view={view} builtIn={BUILT_IN} saved={views.data} defaults={DEFAULT_COLUMNS} isAdmin={isAdmin}
          onPick={(v) => { setView(v); setQ(v.filters.find((f) => f.key === "q")?.value ?? ""); }} onDelete={deleteView} />
        <span className="db-dates">
          <button type="button" className="btn" aria-label={span === "week" ? "The week before" : "The day before"} disabled={!day} onClick={() => go(plusDays(day, span === "week" ? -7 : -1))}><Icon name="left" size={14} /></button>
          <input type="date" value={day} onChange={(e) => e.target.value && go(e.target.value)} aria-label="Day shown" />
          <button type="button" className="btn" aria-label={span === "week" ? "The week after" : "The day after"} disabled={!day} onClick={() => go(plusDays(day, span === "week" ? 7 : 1))}><Icon name="right" size={14} /></button>
          <button type="button" className="btn" disabled={!d || day === d.today} onClick={() => d && go(d.today)}>Today</button>
          <span className="wl-seg" role="group" aria-label="Days shown">
            <button type="button" aria-pressed={span === "day"} className={span === "day" ? "on" : ""} onClick={() => setSpan("day")}>Day</button>
            <button type="button" aria-pressed={span === "week"} className={span === "week" ? "on" : ""} onClick={() => { if (!date && d) setDate(d.today); setSpan("week"); }}>Week</button>
          </span>
        </span>
        <span style={{ marginLeft: "auto" }} />
        {d && span === "day" && lanes.some((l) => l.crew && l.all.length > 0) && <button type="button" className="btn" disabled={!!busy} title="Put a crew's stops in order by hand (drag them) or optimize them, with curbside arrival" onClick={() => setRouting({ date: d.from, crewId: picked.find((r) => !r.waiting && r.crewId)?.crewId })}><Ico name="route" size={14} /> Route stops</button>}
        {d && lanes.some((l) => l.crew && l.all.filter((r) => r.status === "open").length > 1) && <button type="button" className="btn" disabled={!!busy} title="Order every crew's stops to keep the drive shortest, from the shop and back. Locked stops keep their place." onClick={() => optimize(lanes)}>{busy === "all" ? "Ordering…" : "Optimize routes"}</button>}
        {d && span === "day" && all.some((r) => r.status === "open") && <button type="button" className="btn" onClick={() => setRain({ who: "all" })}>Rain or wind day…</button>}
        <button type="button" className="btn" onClick={() => d && exportRows(picked.length ? picked : shown, columns, ctx, d.from)} disabled={!shown.length}><Icon name="download" size={14} /> Export{picked.length ? ` ${picked.length}` : ""}</button>
      </div>
      {/* The filters, as on the plan's mock-up: the search, the chips in use, and "Filter" to add one. */}
      <div className="wl-toolbar">
        <input type="search" className="wl-search" placeholder="Search customer, address, service, WO-…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the dispatch board" />
        {view.filters.length > 0 && (
          <span className="cl-chips" aria-label="Filters in use">
            {view.filters.map((f, i) => (
              <span key={`${f.key}-${f.value}-${i}`} className="cl-chip">
                <span className="cl-chip-text">{describeFilter(f, { services, crews, tags: tagNames })}</span>
                <button type="button" className="cl-chip-x" aria-label="Remove this filter" onClick={() => removeFilter(i)}>✕</button>
              </span>
            ))}
          </span>
        )}
        <AddFilter rows={all} crews={crews} tags={tags} kinds={[...BOARD_FILTER_KINDS, ...FILTER_KINDS]} onAdd={(fs: Filter[]) => setView({ ...view, filters: [...view.filters, ...fs.filter((f) => !view.filters.some((x) => x.key === f.key && x.value === f.value))] })} />
        {view.filters.length > 1 && <button type="button" className="linkbtn" onClick={() => { setQ(""); setView({ ...view, filters: [] }); }}>Clear all</button>}
        <SaveView open={saveOpen} setOpen={setSaveOpen} onSave={saveView} busy={act.busy} />
      </div>

      {d && (
        <div className="stack wl-page">
          <WaitMap rows={shown} colors={new Map()} selected={selected} onToggle={toggle} onSelect={(ids) => setSelected(new Set([...selected, ...ids]))} fitKey={fitKey} unmapped={shown.filter((r) => r.property.lat == null).length} prefsKey="db-map"
            pinOf={(r) => ({ label: (r as BoardRow).route && r.crewId ? String((r as BoardRow).route!.order) : "", color: crewColor(r), dim: r.status === "completed" || r.status === "skipped" })}
            lines={mapLines} flag={d.start ? { lat: d.start.lat, lng: d.start.lng, label: `The shop: ${d.start.address}` } : null} ghosts={pins ? waitShown : []}
            legend={<>
              {crews.filter((c) => shown.some((r) => r.crewId === c.id)).map((c) => <span key={c.id}><span className="wl-dot" style={{ background: c.color }} />{c.name}</span>)}
              {shown.some((r) => !r.crewId) && <span><span className="wl-dot" style={{ background: "#64748b" }} />No crew yet</span>}
              {pins && <span><span className="wl-dot" style={{ background: GRAY }} />Gray: waiting list ({waitShown.filter((r) => r.property.lat != null).length})</span>}
              <span>Numbers are the stop order</span>
            </>}>
            <label className="check db-pins"><input type="checkbox" checked={pins} onChange={(e) => setPins(e.target.checked)} /> Waiting list pins</label>
          </WaitMap>
          <WorkloadStrip today={d.today} day={span === "day" ? d.from : undefined} start={span === "week" ? d.from : undefined} reloadKey={workKey} selectedMinutes={pickedTotals.minutes} hint="click a day to open it"
            onPick={(dd, crewId) => { if (picked.length) setEdit({ date: dd, ...(crewId ? { crewId } : {}) }); else { setSpan("day"); go(dd); } }} />
          <div className="card cl-table-card">
            <div className="cl-bulk wl-bulk">
              {picked.length ? (
                <>
                  <strong>{picked.length} selected</strong>
                  <span className="muted">{h1(pickedTotals.minutes / 60)} h · {Math.round(pickedTotals.sqFt).toLocaleString()} sq ft · {formatMoney(pickedTotals.cents)}{picked.some((r) => r.waiting) ? ` · ${picked.filter((r) => r.waiting).length} from the waiting list` : ""}</span>
                  <button type="button" className="btn primary" onClick={() => setEdit(span === "day" ? { date: d.from } : {})}>Edit work orders</button>
                  {picked.some((r) => !r.waiting && r.crewId && r.date) && <button type="button" className="btn" title="Open this crew's day to put its stops in order by hand or optimize them, with curbside arrival. The ones you ticked can go first, in the order you ticked them." onClick={() => { const r = picked.find((x) => !x.waiting && x.crewId && x.date)!; setRouting({ date: r.date!, crewId: r.crewId }); }}><Ico name="route" size={14} /> Route stops</button>}
                  <Popover open={bulkOpen} setOpen={setBulkOpen} label="More ▾">
                    <div className="cl-menu">
                      {picked.some((r) => !r.waiting && r.status !== "completed") && <button type="button" onClick={() => { setBulkOpen(false); setEdit({ to: "waitlist" }); }}>Back to the waiting list…</button>}
                      {picked.filter((r) => !r.waiting && r.crewId).length > 1 && <button type="button" title="Click pins (or tick rows) in the order they should be visited, then choose this" onClick={() => { setBulkOpen(false); routeAsPicked(); }}>Route in the order selected</button>}
                      {picked.some((r) => r.route && !r.route.locked) && <button type="button" onClick={() => { setBulkOpen(false); lock(picked, true); }}>Lock in place</button>}
                      {picked.some((r) => r.route?.locked) && <button type="button" onClick={() => { setBulkOpen(false); lock(picked, false); }}>Unlock</button>}
                      <hr />
                    </div>
                    <BulkMenu busy={act.busy} isAdmin={isAdmin} onPriority={(p) => bulk({ action: "priority", priority: p }, "Set the priority on")} onSkip={(reason) => bulk({ action: "skip", reason }, "Skipped")}
                      onDelete={() => { if (confirm(`Delete ${picked.length} work order${picked.length === 1 ? "" : "s"}? This can't be undone.`)) bulk({ action: "delete" }, "Deleted"); }} />
                  </Popover>
                  <button type="button" className="linkbtn" onClick={() => setSelected(new Set())}>Clear selection</button>
                </>
              ) : (
                <span className="muted">Select work orders here or on the map (click pins, or Draw a box), then Edit work orders to move them.{grouped ? " Drag a row to reorder it or to give it to another crew." : ""}</span>
              )}
              <span style={{ marginLeft: "auto" }} />
              {!grouped && <button type="button" className="btn" onClick={() => setView({ ...view, sort: BY_ROUTE })} title="Back to each crew's stops in route order">Group by crew</button>}
              <Columns shown={columns} all={BOARD_COLUMNS} defaults={DEFAULT_COLUMNS} onChange={(c) => setView({ ...view, columns: c })} />
            </div>
            <ErrorBox error={act.error} />
            <div className="table-wrap wl-table-wrap">
              <table className="cl-table wl-table db-table">
                <thead>
                  <tr>
                    <th className="cl-check"><input type="checkbox" aria-label="Select all shown" checked={allOn} onChange={() => setSelected(allOn ? new Set([...selected].filter((id) => !shown.some((r) => r.id === id))) : new Set([...selected, ...shown.map((r) => r.id)]))} /></th>
                    <th className="db-stop" aria-sort={grouped ? "ascending" : undefined}><button type="button" className="cl-sort" onClick={() => setView({ ...view, sort: BY_ROUTE })} title="Each crew's stops in route order">#{grouped ? " ▲" : ""}</button></th>
                    {cols.map((c) => (
                      <th key={c.key} className={c.num ? "num" : undefined} aria-sort={view.sort?.key === c.key ? (view.sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                        {c.sort ? <button type="button" className="cl-sort" onClick={() => onSort(c.key)}>{c.label}{view.sort?.key === c.key ? (view.sort.dir === "asc" ? " ▲" : " ▼") : ""}</button> : c.label}
                      </th>
                    ))}
                  </tr>
                  <tr className="wl-totals">
                    <td /><td />
                    {cols.map((c, i) => <td key={c.key} className={c.num ? "num" : undefined}>{i === 0 ? <strong>{shown.length} shown</strong> : <strong>{total(c.key)}</strong>}</td>)}
                  </tr>
                </thead>
                <tbody>
                  {grouped ? lanes.map((l) => <Fragment key={l.key}>{laneHead(l)}{l.rows.map((r) => rowOf(r, l))}</Fragment>) : shown.map((r) => rowOf(r, null))}
                  {(pins || waitRowsOpen) && (
                    <tr className="db-group db-group-wait">
                      <td className="cl-check" />
                      <td colSpan={cols.length + 1}>
                        <div className="db-group-row">
                          <span className="db-group-name"><span className="wl-dot" style={{ background: GRAY }} /><strong>Waiting list</strong></span>
                          <span className="muted">{waiting.loading && !waiting.data ? "Loading…" : `${waitShown.length} waiting${view.filters.length ? " match the filters" : ""}`}{waitShown.length ? ` · ${h1(totalsOf(waitShown).minutes / 60)} h` : ""}</span>
                          <span className="muted">Select some (here or the gray pins), then Edit work orders puts them on a day.</span>
                          <span className="db-group-acts">
                            {!mcFiltered && <button type="button" className="linkbtn" onClick={() => setWaitOpen(!waitOpen)}>{waitRowsOpen ? "Hide" : "Show them"}</button>}
                            <Link href="/waitlist">Open the waiting list</Link>
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {waitRowsOpen && waitShown.slice(0, 200).map((r) => rowOf(r, null))}
                </tbody>
              </table>
            </div>
            {!shown.length && <Empty>{all.length ? "Nothing matches these filters." : <>Nothing is scheduled {span === "week" ? "this week" : `for ${dayLabel(d.from, { weekday: "long", month: "long", day: "numeric" })}`}. Put work on it from the <Link href="/waitlist">waiting list</Link>, or select gray pins on the map and Edit work orders.</>}</Empty>}
          </div>
        </div>
      )}
      {edit && d && <EditWorkOrders board rows={picked} crews={crews} today={d.today} initial={edit} onClose={() => setEdit(null)} onDone={done} />}
      {routing && d && <RouteStops lanes={routeLanes.filter((l) => l.date === routing.date)} crewId={routing.crewId} picked={[...selected]} routing={d.routing} curbsideDefault={d.curbside} onClose={() => setRouting(null)} onSaved={done} />}
      {rain && d && <RainDay rows={all} crews={crews} date={d.from} who={rain.who} onClose={() => setRain(null)} onDone={done} />}
    </>
  );
}

/** What a crew's open stops need on the truck: the tank mix by method, and each product. */
function ToLoad({ needs, date }: { needs: { products: { product: string; unit: string; amount: number }[]; spray: [string, number][] }; date: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} setOpen={setOpen} buttonClass="linkbtn" align="right" className="cl-pop-wide" label={`To load${needs.spray.length ? `: ${needs.spray.map(([m, gal]) => `${Math.round(gal).toLocaleString()} gal ${m.toLowerCase()}`).join(", ")}` : ""} ▾`}>
      <div className="stack" style={{ gap: 6 }}>
        <table className="wl-break"><tbody>{needs.products.map((p) => <tr key={p.product + p.unit}><td>{p.product}</td><td className="num">{p.amount >= 10 ? Math.round(p.amount).toLocaleString() : h1(p.amount)} {p.unit}</td></tr>)}</tbody></table>
        <Link href={`/chemical-tracking/load-sheet?date=${date}`}>Open the load sheet</Link>
      </div>
    </Popover>
  );
}

/** Rain or wind day: a crew's, or the whole day's, open work goes to another day or back to the waiting list. */
function RainDay({ rows, crews, date, who: first, onClose, onDone }: { rows: BoardRow[]; crews: Crew[]; date: string; who: string; onClose: () => void; onDone: (text: string) => void }) {
  const [who, setWho] = useState(first);
  const [to, setTo] = useState<"waitlist" | "next">("next");
  const [reason, setReason] = useState<(typeof BACK_REASONS)[number]>("rain");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const next = useApi<{ date: string }>(`/dispatch/next-working-day?after=${date}`);
  const [toDate, setToDate] = useState("");
  useEffect(() => { if (next.data && !toDate) setToDate(next.data.date); }, [next.data, toDate]);
  const act = useAction();
  const open = rows.filter((r) => r.date === date && r.status === "open" && (who === "all" || (who === "none" ? !r.crewId : r.crewId === who)));
  const hear = (b: "text_ahead" | "call_ahead") => new Set(open.filter((r) => r.badges.includes(b)).map((r) => r.customer.id)).size;
  const texts = hear("text_ahead"), calls = hear("call_ahead");
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="cal-modal card stack wl-edit" role="dialog" aria-modal="true" aria-label="Rain or wind day" onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          const r = await dispatchApi.rain({ date, crewId: who, to, ...(to === "next" ? { toDate } : {}), reason, note, notify });
          onDone(`${r.moved} work order${r.moved === 1 ? "" : "s"} moved ${r.to ? `to ${dayLabel(r.to)}` : "back to the waiting list"}.${notify ? ` ${r.texted} customer${r.texted === 1 ? "" : "s"} texted.${r.notTexted ? ` ${r.notTexted} couldn't be texted${r.texted === 0 ? " (is texting connected?)" : ""}.` : ""}${r.toCall.length ? ` To call: ${r.toCall.join(", ")}.` : ""}` : ""}`);
        });
      }}>
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Rain or wind day</h2><button type="button" className="btn sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></div>
        <p className="muted" style={{ margin: 0 }}>Moves the open work orders on {dayLabel(date, { weekday: "long", month: "long", day: "numeric" })} in one step. Ones already started, done or skipped stay where they are.</p>
        <div className="formgrid">
          <label>Whose work
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="all">The whole day</option>
              {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="none">No crew yet</option>
            </select>
          </label>
          <label>Where it goes
            <select value={to} onChange={(e) => setTo(e.target.value as "waitlist" | "next")}>
              <option value="next">To another day</option>
              <option value="waitlist">Back to the waiting list</option>
            </select>
          </label>
          {to === "next" && <label>The day<input type="date" required value={toDate} min={plusDays(date, 1)} onChange={(e) => setToDate(e.target.value)} />{next.data && toDate === next.data.date && <span className="muted wl-sub">The next working day.</span>}</label>}
          <label>Why<select value={reason} onChange={(e) => setReason(e.target.value as (typeof BACK_REASONS)[number])}>{BACK_REASONS.map((r) => <option key={r} value={r}>{BACK_REASON_LABELS[r]}</option>)}</select></label>
          <label>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Gusts over 20 mph" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={notify && texts + calls > 0} disabled={!texts && !calls} onChange={(e) => setNotify(e.target.checked)} /> Notify customers by their preference{texts || calls ? ` (${[texts && `${texts} by text`, calls && `${calls} to call`].filter(Boolean).join(", ")})` : " (none asked for notice)"}</label>
        <p className="wl-adds" style={{ margin: 0 }}><strong>{open.length}</strong> work order{open.length === 1 ? "" : "s"} will move. Who does them stays the same; they come off their routes.</p>
        <ErrorBox error={act.error} />
        <div className="row">
          <button className="btn primary" disabled={act.busy || !open.length || (to === "next" && !toDate)}>{act.busy ? "Moving…" : `Move ${open.length}`}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { capacityText, clockText, laneKeyOf, type EtaWindow } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { readLocal, writeLocal } from "@/components/customer-list";
import { EmailComposer } from "@/components/customer-messages";
import { useTags } from "@/components/customers";
import { BulkText } from "@/components/texting";
import {
  COLOR_MODES, COLOR_MODE_LABELS, FILTER_DEFS, SELECTED_COLOR, applyFilters, assignmentText, buildLanes, dateLabel, dispatchApi, dollars, endOfMonth, eventColor,
  eventHours, eventHref, filterOptions, hiddenCounts, hoursBoth, monthDay, plusDays, relativeDay, startOfMonth, startOfWeek, time12, trim1, useBoard, wholeDollars,
  type Area, type Board, type ColorMode, type DEvent, type DRoute, type Filters, type Lane, type Truck,
} from "./data";
import { DispatchMap, type MapFlag, type MapHandle, type MapLine, type MapPin } from "./map";
import { Check, Dialog, Ico, MenuItem, MiniCal, Pop, Seg, Toasts, anchorOf, useToasts } from "./beta-parts";
import {
  AssignDialog, ConfirmDialog, EventMenu, NotesButton, RescheduleDialog, SkipDialog, StatusPill, TypeIcon, WaitlistDialog, WorkView, pad2, type EventAction,
} from "./beta-dialogs";
import { FutureDialog, RouteBanner, RouteFooter, RouteList, useRouteDraft, type PointChoice } from "./beta-route";
import { AreasPanel, PrintDialog, SettingsDialog, WaitlistPanel, type PrintKind } from "./beta-more";

/**
 * "New Dispatch" (Beta): a copy of Homeworks' beta dispatch board on Crewdesk's work orders and
 * to-dos. A header (the day, the layout, the waitlist), a toolbar (table or board, filters,
 * search, Assign, Route stops), the list beside the map, and a footer of totals that turns into
 * the bulk actions when events are selected. Choices are remembered in this browser.
 */

type Anchor = ReturnType<typeof anchorOf>;
type Mode = "day" | "week" | "month" | "custom";
type Prefs = {
  layout: "list" | "split" | "map"; list: "table" | "board"; mode: Mode; date: string | null; customTo: string | null;
  filters: Filters; order: string[]; hidden: string[]; inlineNotes: boolean; card: string[];
  color: ColorMode; showOrder: boolean; showTrucks: boolean; satellite: boolean; areas: string[];
  eta: EtaWindow; route: { start: PointChoice; end: PointChoice; startTime: string }; skipUnrouteAsk: boolean;
};
const COLUMNS: { key: string; label: string; head?: string; width: number; sort?: boolean; num?: boolean }[] = [
  { key: "stop", label: "Stop #", head: "#", width: 62, sort: true },
  { key: "type", label: "Event type", head: "", width: 40 },
  { key: "name", label: "Event Name", width: 260, sort: true },
  { key: "status", label: "Status", width: 190, sort: true },
  { key: "finished", label: "Skipped/Completed time", width: 200 },
  { key: "frequency", label: "Frequency", width: 216 },
  { key: "date", label: "Date", width: 192, sort: true },
  { key: "assignment", label: "Assignment", width: 200, sort: true },
  { key: "customer", label: "Customer", width: 200, sort: true },
  { key: "location", label: "Location", width: 280, sort: true },
  { key: "invoice", label: "Invoice", width: 150 },
  { key: "bh", label: "Budgeted hours", width: 150, sort: true, num: true },
  { key: "tracked", label: "Tracked time", width: 130, num: true },
  { key: "lastServiced", label: "Last serviced", width: 140 },
  { key: "total", label: "Visit Total", width: 120, num: true },
  { key: "items", label: "Items / Services", width: 260 },
  { key: "visitNotes", label: "Visit notes", head: "", width: 44 },
  { key: "media", label: "Media", head: "", width: 44 },
];
const CARD_DETAILS: { group: string; items: [string, string][] }[] = [
  { group: "Event", items: [["location", "Event location"], ["type", "Event type"], ["assignments", "Assignments"], ["visitNotes", "Visit notes"], ["notesInline", "Dispatch notes inline"], ["media", "Media"]] },
  { group: "Time tracking", items: [["bh", "Budgeted hours"], ["tracked", "Tracked time"], ["onSite", "On site"]] },
  { group: "Customer", items: [["phone", "Customer phone"], ["lastService", "Last service date"]] },
  { group: "Billing", items: [["revenue", "Revenue"], ["invoiceable", "Invoiceable"]] },
];
const DEFAULT_PREFS: Prefs = {
  layout: "split", list: "table", mode: "day", date: null, customTo: null, filters: {}, order: COLUMNS.map((c) => c.key), hidden: ["finished"], inlineNotes: true, card: ["location", "onSite"],
  color: "routing", showOrder: true, showTrucks: false, satellite: false, areas: [], eta: 0, route: { start: { kind: "company" }, end: { kind: "company" }, startTime: "08:00" }, skipUnrouteAsk: false,
};

const sortValue = (e: DEvent, key: string, board: Board): string | number => {
  switch (key) {
    case "stop": return e.route ? e.route.order : 9999;
    case "name": return e.title.toLowerCase();
    case "status": return e.status;
    case "date": return `${e.date} ${e.startTime ?? "99"}`;
    case "assignment": return assignmentText(e, board).toLowerCase() || "~";
    case "customer": return e.customer?.name.toLowerCase() ?? "~";
    case "location": return e.location?.address.toLowerCase() ?? "~";
    case "bh": return eventHours(e);
    default: return 0;
  }
};

export function BetaDispatch() {
  const router = useRouter();
  const { me, can } = useAuth();
  const isAdmin = can("admin", "customers");
  const canText = !!me?.access?.texting;
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { const saved = readLocal<Partial<Prefs>>("dx-prefs", {}); setPrefsState({ ...DEFAULT_PREFS, ...saved, order: [...(saved.order ?? []).filter((k) => COLUMNS.some((c) => c.key === k)), ...COLUMNS.map((c) => c.key).filter((k) => !(saved.order ?? []).includes(k))] }); setLoaded(true); }, []);
  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => { const next = { ...p, ...patch }; writeLocal("dx-prefs", next); return next; });

  const { toasts, toast } = useToasts();
  const [todayGuess] = useState(() => new Date().toLocaleDateString("en-CA"));
  const anchor = prefs.date ?? todayGuess;
  const range = useMemo(() => {
    if (prefs.mode === "week") return { from: startOfWeek(anchor), to: plusDays(startOfWeek(anchor), 6) };
    if (prefs.mode === "month") return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
    if (prefs.mode === "custom") return { from: anchor, to: prefs.customTo && prefs.customTo >= anchor ? prefs.customTo : anchor };
    return { from: anchor, to: anchor };
  }, [prefs.mode, anchor, prefs.customTo]);
  const oneDay = range.from === range.to;
  const route = useRouteDraft({ board: null, toast, defaults: prefs.route, onDefaults: (r) => setPrefs({ route: r }) });
  const routing = !!route.draft;
  const board = useBoard(loaded ? range.from : null, loaded ? range.to : null, routing);
  const b = board.data;
  const today = b?.today ?? todayGuess;
  const { tags } = useTags();
  const areas = useApi<{ areas: Area[] }>("/dispatch/areas");
  const [trucks, setTrucks] = useState<Truck[]>([]);
  useEffect(() => {
    if (!prefs.showTrucks) { setTrucks([]); return; }
    const load = () => api<{ trucks: Truck[] }>("/dispatch/trucks").then((r) => setTrucks(r.trucks), () => {});
    load();
    const timer = setInterval(load, 120_000);
    return () => clearInterval(timer);
  }, [prefs.showTrucks]);

  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastPick = useRef<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [waitlist, setWaitlist] = useState(false);
  const [menu, setMenu] = useState<{ what: "mode" | "date" | "filter" | "columns" | "view" | "print" | "color" | "status" | "more" | "card"; at: Anchor } | null>(null);
  const [eventMenu, setEventMenu] = useState<{ key: string; at: { x: number; y: number; w?: number; h?: number }; withView?: boolean } | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "assign" | "reschedule" | "waitlist" | "delete" | "skip" | "unroute" | "discard" | "assignAll" | "future" | "settings"; keys: string[] } | { kind: "print"; what: PrintKind } | { kind: "text" | "email"; customerIds: string[]; audience: string }>(null);
  const [lasso, setLasso] = useState(false);
  const [areasOpen, setAreasOpen] = useState(false);
  const [drawing, setDrawing] = useState<[number, number][] | null>(null);
  const [picking, setPicking] = useState<"start" | "end" | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [addressText, setAddressText] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [legend, setLegend] = useState(true);
  const [showHidden, setShowHidden] = useState({ crews: false, people: false });
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<string | null>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const mapRef = useRef<MapHandle>(null);

  const all = b?.events ?? [];
  const byKey = useMemo(() => new Map(all.map((e) => [e.key, e])), [all]);
  const shown = useMemo(() => {
    if (!b) return [];
    const rows = applyFilters(all, prefs.filters, search);
    const base = (a: DEvent, c: DEvent) => a.date.localeCompare(c.date) || (a.route && c.route ? a.route.id.localeCompare(c.route.id) || a.route.order - c.route.order : a.route ? -1 : c.route ? 1 : (a.startTime ?? "99").localeCompare(c.startTime ?? "99") || a.title.localeCompare(c.title));
    if (!sort) return [...rows].sort(base);
    return [...rows].sort((a, c) => { const x = sortValue(a, sort.key, b), y = sortValue(c, sort.key, b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || base(a, c); });
  }, [b, all, prefs.filters, search, sort]);
  // Selections the filters hide are dropped, so the footer and the actions match what's on screen.
  useEffect(() => {
    if (!b) return;
    const ids = new Set(shown.map((e) => e.key));
    if ([...selected].some((k) => !ids.has(k))) setSelected(new Set([...selected].filter((k) => ids.has(k))));
    if (viewing && !byKey.has(viewing)) setViewing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const picked = shown.filter((e) => selected.has(e.key));
  const lanes = useMemo(() => (b ? buildLanes(b, shown, { hiddenCrews: showHidden.crews, hiddenPeople: showHidden.people }) : []), [b, shown, showHidden]);
  const hidden = useMemo(() => (b ? hiddenCounts(b, shown) : { crews: 0, people: 0 }), [b, shown]);
  const routes = b?.routes ?? [];
  const routeOf = (id: string) => routes.find((r) => r.id === id);
  const pickedRoutes = [...new Set(picked.map((e) => e.route?.id ?? ""))];
  const oneRoute = picked.length > 0 && pickedRoutes.length === 1 && pickedRoutes[0] ? routeOf(pickedRoutes[0]) : undefined;
  const mixed = pickedRoutes.length > 1 && pickedRoutes.some((r) => r) && pickedRoutes.some((r) => !r);
  const shownAreas = (areas.data?.areas ?? []).filter((a) => prefs.areas.includes(a.id));

  const reload = () => board.reload(true);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok); await reload(); return true; } catch (e) { toast((e as Error).message, true); await reload(); return false; }
  };
  const clear = () => { setSelected(new Set()); lastPick.current = null; };
  const pick = (key: string, e?: { shiftKey?: boolean }) => {
    const next = new Set(selected);
    if (e?.shiftKey && lastPick.current) {
      const keys = shown.map((x) => x.key);
      const [a, c] = [keys.indexOf(lastPick.current), keys.indexOf(key)].sort((x, y) => x - y);
      if (a >= 0) for (const k of keys.slice(a, c + 1)) next.add(k);
    } else if (next.has(key)) next.delete(key); else next.add(key);
    lastPick.current = key;
    setSelected(next);
  };
  const setStatus = async (events: DEvent[], status: "open" | "skipped" | "completed", reason?: string) => {
    let done = 0;
    const failed: string[] = [];
    for (const e of events) {
      const now = e.status === "on_site" ? "open" : e.status;
      if (now === status) continue;
      try { await dispatchApi.setStatus(e, status, reason); done++; } catch (err) { failed.push(`${e.title}: ${(err as Error).message}`); }
    }
    if (done) toast(done === 1 ? `Event set to ${status === "completed" ? "Complete" : status === "skipped" ? "Skipped" : "Open"}` : `${done} events set to ${status === "completed" ? "Complete" : status === "skipped" ? "Skipped" : "Open"}`);
    if (failed.length) toast(failed.slice(0, 2).join(" · ") + (failed.length > 2 ? ` (+${failed.length - 2} more)` : ""), true);
    await reload();
  };
  const askStatus = (events: DEvent[], status: "open" | "skipped" | "completed") => (status === "skipped" ? setDialog({ kind: "skip", keys: events.map((e) => e.key) }) : void setStatus(events, status));
  const contact = (events: DEvent[], how: "text" | "email") => {
    const ids = [...new Set(events.map((e) => e.customer?.id).filter((x): x is string => !!x))];
    if (!ids.length) { toast("None of those have a customer to contact.", true); return; }
    setDialog({ kind: how, customerIds: ids, audience: ids.length === 1 ? events.find((e) => e.customer)!.customer!.name : `Customers (${ids.length})` });
  };
  const onAction = (e: DEvent, a: EventAction) => {
    if (a === "view") { if (prefs.list === "board" || routing) setViewing(e.key); else router.push(eventHref(e)); }
    else if (a === "zoom") { if (e.location?.lat != null && e.location.lng != null) { if (prefs.layout === "list") setPrefs({ layout: "split" }); setTimeout(() => mapRef.current?.flyTo(e.location!.lat!, e.location!.lng!), 60); } }
    else if (a === "open" || a === "skipped" || a === "completed") askStatus([e], a);
    else if (a === "assign" || a === "reschedule" || a === "delete") setDialog({ kind: a, keys: [e.key] });
    else if (a === "duplicate") void act(() => dispatchApi.duplicate([e.key]), "Event duplicated");
    else if (a === "edit") window.open(eventHref(e, true), routing ? "_blank" : "_self");
    else if (a === "text" || a === "email") contact([e], a);
    else if (a === "unroute") void act(() => dispatchApi.unroute([e.key]), "Removed from its route");
  };
  const dialogEvents = dialog && "keys" in dialog ? dialog.keys.map((k) => byKey.get(k)).filter((e): e is DEvent => !!e) : [];

  /* ── Route ordering ── */
  const startRoute = () => {
    if (!oneDay || !picked.length) return;
    if (oneRoute && picked.every((e) => e.route?.id === oneRoute.id)) return route.begin([], range.from, oneRoute);
    // Stops already on a route come first, in their saved order.
    const ordered = [...picked].sort((a, c) => (a.route && c.route ? a.route.id.localeCompare(c.route.id) || a.route.order - c.route.order : a.route ? -1 : c.route ? 1 : 0));
    route.begin(ordered.map((e) => e.key), range.from, undefined, !!b?.settings.curbside);
    setViewing(null);
  };
  const exitRoute = () => (route.draft?.dirty && (route.draft.id || route.draft.keys.length) ? setDialog({ kind: "discard", keys: [] }) : route.exit());
  const wasRouting = useRef(false);
  useEffect(() => { if (wasRouting.current && !routing) { clear(); reload(); setPicking(null); } wasRouting.current = routing; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [routing]);
  useEffect(() => {
    if (!routing) return;
    const warn = (e: BeforeUnloadEvent) => { if (route.draft?.dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [routing, route.draft?.dirty]);

  /* ── The map's pins and lines ── */
  const colorOf = (e: DEvent) => (b ? eventColor(e, prefs.color, b) : { colors: ["#78716c"], label: "" });
  const tip = (e: DEvent) => [e.title, prefs.card.includes("location") || !prefs.card.length ? e.location?.address : null, e.customer?.name, prefs.card.includes("assignments") && b ? assignmentText(e, b) : null, prefs.card.includes("bh") ? `${trim1(eventHours(e))} BH` : null].filter(Boolean).join(" · ");
  const pins: MapPin[] = useMemo(() => {
    if (!b) return [];
    const draft = route.draft;
    return shown.filter((e) => e.location?.lat != null && e.location.lng != null && (!draft || e.date <= draft.date)).map((e) => {
      const at = draft ? draft.keys.indexOf(e.key) : -1;
      return {
        key: e.key, lat: e.location!.lat!, lng: e.location!.lng!, tip: tip(e), selected: draft ? false : selected.has(e.key),
        label: draft ? (at >= 0 ? pad2(at + 1) : e.route ? pad2(e.route.order) : "00") : e.route ? pad2(e.route.order) : "00",
        colors: draft ? (at >= 0 ? ["#7c2d12"] : ["#a8a29e"]) : selected.has(e.key) ? [SELECTED_COLOR] : colorOf(e).colors, dim: !!draft && at < 0,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, shown, selected, prefs.color, prefs.card, route.draft]);
  const lines: MapLine[] = useMemo(() => {
    if (!b) return [];
    const draft = route.draft, p = route.preview;
    const through = (start: { lat: number | null; lng: number | null } | null, keys: string[], end: { lat: number | null; lng: number | null } | null) => [
      ...(start?.lat != null && start.lng != null ? [[start.lat, start.lng] as [number, number]] : []),
      ...keys.map((k) => byKey.get(k)?.location).filter((l): l is NonNullable<DEvent["location"]> => l?.lat != null && l.lng != null).map((l) => [l.lat!, l.lng!] as [number, number]),
      ...(end?.lat != null && end.lng != null ? [[end.lat, end.lng] as [number, number]] : []),
    ];
    if (draft) return [{ id: "draft", color: "#44403c", points: p && p.keys.join() === draft.keys.join() ? p.geometry ?? through(p.start, draft.keys, p.end) : through(null, draft.keys, null), dashed: !p?.geometry }];
    if (!oneDay) return [];
    return routes.filter((r) => r.stops.some((s) => shown.some((e) => e.key === s.key))).map((r) => {
      const first = byKey.get(r.stops[0]?.key ?? "");
      const color = prefs.color === "assignment" && first ? colorOf(first).colors[0] : "#57534e";
      return { id: r.id, color, points: r.geometry ?? through(r.start.kind === "none" ? null : r.start, r.stops.map((s) => s.key), r.end.kind === "none" ? null : r.end), dashed: !r.geometry };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, routes, shown, route.draft, route.preview, prefs.color, oneDay]);
  const flags: MapFlag[] = useMemo(() => {
    if (!b) return [];
    const draft = route.draft, p = route.preview;
    if (draft) {
      const out: MapFlag[] = [];
      if (p?.start) out.push({ key: "s", lat: p.start.lat, lng: p.start.lng, label: p.start.label ?? "Start", kind: "start" });
      if (p?.end && !(p.start && p.end.lat === p.start.lat && p.end.lng === p.start.lng)) out.push({ key: "e", lat: p.end.lat, lng: p.end.lng, label: p.end.label ?? "End", kind: "end" });
      else if (p?.end && !p.start) out.push({ key: "e", lat: p.end.lat, lng: p.end.lng, label: p.end.label ?? "End", kind: "end" });
      return out;
    }
    const out: MapFlag[] = [];
    if (b.start) out.push({ key: "s", lat: b.start.lat, lng: b.start.lng, label: b.start.address, kind: b.end && (b.end.lat !== b.start.lat || b.end.lng !== b.start.lng) ? "start" : "both" });
    if (b.end && b.start && (b.end.lat !== b.start.lat || b.end.lng !== b.start.lng)) out.push({ key: "e", lat: b.end.lat, lng: b.end.lng, label: b.end.address, kind: "end" });
    return out;
  }, [b, route.draft, route.preview]);
  const unplaced = shown.filter((e) => e.location?.lat == null).length;
  const legendItems = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of shown) { if (e.location?.lat == null) continue; const c = colorOf(e); if (!seen.has(c.label)) seen.set(c.label, c.colors[0]); }
    return [...seen];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, prefs.color, b]);

  /* ── Header pieces ── */
  const move = (dir: 1 | -1) => {
    if (prefs.mode === "day") setPrefs({ date: plusDays(anchor, dir) });
    else if (prefs.mode === "week") setPrefs({ date: plusDays(anchor, 7 * dir) });
    else if (prefs.mode === "month") setPrefs({ date: dir === 1 ? plusDays(endOfMonth(anchor), 1) : startOfMonth(plusDays(startOfMonth(anchor), -1)) });
    else { const len = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1; setPrefs({ date: plusDays(range.from, len * dir), customTo: plusDays(range.to, len * dir) }); }
  };
  const rangeLabel = prefs.mode === "day" ? dateLabel(range.from) : prefs.mode === "month" ? dateLabel(range.from, { month: "long", year: "numeric" }) : `${dateLabel(range.from, { weekday: prefs.mode === "week" ? "short" : undefined, month: "short", day: "numeric" })}→${dateLabel(range.to, { weekday: prefs.mode === "week" ? "short" : undefined, month: "short", day: "numeric" })}`;
  const unit = prefs.mode === "day" ? "day" : prefs.mode === "week" ? "week" : prefs.mode === "month" ? "month" : "range";
  const filterCount = Object.values(prefs.filters).filter((v) => v.length).length;
  const cols = prefs.order.map((k) => COLUMNS.find((c) => c.key === k)!).filter((c) => c && !prefs.hidden.includes(c.key));
  const showDots = prefs.color !== "routing";
  const grid = `44px ${showDots ? "18px " : ""}${cols.map((c) => `${c.width}px`).join(" ")} 48px`;

  if (!loaded) return <div className="dx" />;
  const listLabel = prefs.list === "table" ? "Table" : "Board";

  /* ── Cells ── */
  const cell = (e: DEvent, key: string) => {
    switch (key) {
      case "stop": return <span className={`dx-stop${e.route ? " routed" : ""}`}>{e.route ? pad2(e.route.order) : "00"}</span>;
      case "type": return <TypeIcon kind={e.kind} />;
      case "name": return <span className="dx-name"><span className="dx-name-text" title={e.title}>{e.title}</span><NotesButton e={e} onAdded={() => reload()} /></span>;
      case "status": return <span className="dx-cell-status"><StatusPill e={e} onPick={(s) => askStatus([e], s)} /></span>;
      case "finished": return e.finishedAt ? <span>{new Date(e.finishedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{e.skipReason ? <small className="dx-sub">{e.skipReason}</small> : null}</span> : <span className="dx-muted">—</span>;
      case "frequency": return <span className="dx-freq" title={e.frequency ?? undefined}>{e.frequency ?? "Single visit"}</span>;
      case "date": return <span className="dx-two"><span>{monthDay(e.date)}{e.startTime ? ` · ${time12(e.startTime)}` : ""}</span><small className="dx-sub">{relativeDay(e.date, today)}</small></span>;
      case "assignment": { const t = b ? assignmentText(e, b) : ""; return t ? <button type="button" className="dx-cell-assign" onClick={(ev) => { ev.stopPropagation(); setDialog({ kind: "assign", keys: [e.key] }); }}><Ico name={e.crewId ? "users" : "user"} size={14} />{t}</button> : <button type="button" className="dx-cell-assign none" onClick={(ev) => { ev.stopPropagation(); setDialog({ kind: "assign", keys: [e.key] }); }}>Unassigned</button>; }
      case "customer": return e.customer ? <Link className="dx-plain-link" href={`/customers/${e.customer.id}`} onClick={(ev) => ev.stopPropagation()}>{e.customer.name}</Link> : <span className="dx-muted">—</span>;
      case "location": return e.location ? <span title={e.location.address}>{e.location.address}{e.location.lat == null && <small className="dx-sub">Not on the map</small>}</span> : <span className="dx-muted">—</span>;
      case "invoice": return e.invoice ? <Link className="dx-plain-link" href={`/invoices/${e.invoice.id}`} onClick={(ev) => ev.stopPropagation()}>Invoice {e.invoice.number ?? "(draft)"}</Link> : <span className="dx-muted">{e.invoiceable ? "Not invoiced" : "Not invoiceable"}</span>;
      case "bh": return <span title={e.estSource === "size" ? "Estimated from the lawn's size" : e.estSource === "history" ? "From this property's past visits" : undefined}>BH {trim1(eventHours(e))}{e.estSource === "size" || e.estSource === "history" ? "~" : ""}</span>;
      case "tracked": return <span>{clockText(e.trackedSeconds)}</span>;
      case "lastServiced": return e.lastServiceOn ? <span>{monthDay(e.lastServiceOn)}</span> : <span className="dx-muted">—</span>;
      case "total": return <span>{e.totalCents == null ? "" : dollars(e.totalCents)}</span>;
      case "items": return e.services.length ? <span title={e.services.map((s) => s.name).join(", ")}>{e.services.map((s) => s.name).join(", ")}</span> : <span className="dx-muted">—</span>;
      case "visitNotes": return e.notes?.trim() ? <span className="dx-cell-icon" title={e.notes}><Ico name="doc" size={15} /></span> : null;
      case "media": return e.fileCount ? <span className="dx-cell-icon" title={`${e.fileCount} photo${e.fileCount === 1 ? "" : "s"} or file${e.fileCount === 1 ? "" : "s"}`}><Ico name="image" size={15} /></span> : null;
      default: return null;
    }
  };

  const table = (
    <div className="dx-table" role="table" aria-label="Events">
      <div className="dx-thead" role="row" style={{ gridTemplateColumns: grid }}>
        <span className="dx-th-check"><Check checked={shown.length > 0 && picked.length === shown.length} mixed={picked.length > 0 && picked.length < shown.length} label="Select all" onChange={(v) => setSelected(v ? new Set(shown.map((e) => e.key)) : new Set())} /></span>
        {showDots && <span />}
        {cols.map((c) => c.sort
          ? <button key={c.key} type="button" role="columnheader" className={`dx-th${c.num ? " num" : ""}`} aria-label={c.head === "#" ? "#" : c.label} onClick={() => setSort(sort?.key === c.key ? (sort.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>{c.head ?? c.label}{(sort?.key === c.key || c.key === "stop") && <Ico name={sort?.key === c.key ? (sort.dir === 1 ? "up" : "down") : "updown"} size={13} className={sort?.key === c.key ? "" : "dx-faint"} />}</button>
          : <span key={c.key} role="columnheader" className={`dx-th${c.num ? " num" : ""}`}>{c.head ?? c.label}</span>)}
        <button type="button" className="dx-icon-btn dx-th-cols" aria-label="Column configuration" onClick={(e) => setMenu({ what: "columns", at: anchorOf(e.currentTarget) })}><Ico name="columns" /></button>
      </div>
      <div className="dx-tbody">
        {shown.map((e) => (
          <div key={e.key} className={`dx-tr-wrap${viewing === e.key ? " viewing" : ""}${selected.has(e.key) ? " sel" : ""}`}>
            <div className="dx-tr" role="row" style={{ gridTemplateColumns: grid }} onClick={() => setViewing(viewing === e.key ? null : e.key)}
              onContextMenu={(ev) => { ev.preventDefault(); setEventMenu({ key: e.key, at: { x: ev.clientX, y: ev.clientY } }); }}>
              <span className="dx-td-check"><Check checked={selected.has(e.key)} label="Select row" onChange={(_, ev) => pick(e.key, ev)} /></span>
              {showDots && <span className="dx-td-dot"><i style={{ background: colorOf(e).colors.length > 1 ? `linear-gradient(90deg, ${colorOf(e).colors[0]} 50%, ${colorOf(e).colors[1]} 50%)` : colorOf(e).colors[0] }} /></span>}
              {cols.map((c) => <span key={c.key} role="cell" className={`dx-td${c.num ? " num" : ""} c-${c.key}`}>{cell(e, c.key)}</span>)}
              <span className="dx-td-acts"><button type="button" className="dx-icon-btn" aria-label={`Row actions for ${e.title}`} onClick={(ev) => { ev.stopPropagation(); setEventMenu({ key: e.key, at: anchorOf(ev.currentTarget) }); }}><Ico name="dots" /></button></span>
            </div>
            {prefs.inlineNotes && e.dispatchNotes.length > 0 && (
              <div className="dx-inline-notes">{e.dispatchNotes.slice(-2).map((n) => <div key={n.id}><Ico name="note" size={13} /> <span>{n.body}</span> <small>Sent by {n.by ?? "someone"} at {new Date(n.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></div>)}</div>
            )}
          </div>
        ))}
        {b && !shown.length && (
          <div className="dx-empty"><strong>No events</strong><span>{all.length ? "Nothing matches the filters or the search." : `Events scheduled for this ${unit} will show up here.`}</span></div>
        )}
      </div>
    </div>
  );

  const card = (e: DEvent) => {
    const c = colorOf(e).colors;
    const on = (k: string) => prefs.card.includes(k);
    return (
      <div key={e.key} className={`dx-card${selected.has(e.key) ? " sel" : ""}${saving.has(e.key) ? " saving" : ""}`} draggable onDragStart={(ev) => { setDragKey(e.key); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", e.key); }} onDragEnd={() => { setDragKey(null); setOverLane(null); }}
        onClick={(ev) => pick(e.key, ev)} onDoubleClick={() => setViewing(e.key)} onContextMenu={(ev) => { ev.preventDefault(); setEventMenu({ key: e.key, at: { x: ev.clientX, y: ev.clientY }, withView: true }); }}>
        <span className="dx-card-bar" style={{ background: showDots ? (c.length > 1 ? `linear-gradient(180deg, ${c[0]} 50%, ${c[1]} 50%)` : c[0]) : undefined }} />
        <div className="dx-card-body">
          <div className="dx-card-title">{e.route && <span className="dx-stop routed small">{pad2(e.route.order)}</span>}<span>{e.title}</span><NotesButton e={e} onAdded={() => reload()} /></div>
          {e.startTime && <div className="dx-card-line"><Ico name="clock" size={12} />{time12(e.startTime)}{!oneDay ? ` · ${monthDay(e.date)}` : ""}</div>}
          {!e.startTime && !oneDay && <div className="dx-card-line"><Ico name="calendar" size={12} />{monthDay(e.date)}</div>}
          {on("location") && e.location && <div className="dx-card-line"><Ico name="pin" size={12} /><span>{e.location.address}</span></div>}
          {on("type") && <div className="dx-card-line"><TypeIcon kind={e.kind} /> {e.kind === "visit" ? "Work order" : "To-do"}</div>}
          {on("assignments") && b && <div className="dx-card-line"><Ico name="user" size={12} />{assignmentText(e, b) || "Unassigned"}</div>}
          {on("visitNotes") && e.notes && <div className="dx-card-line"><Ico name="doc" size={12} /><span>{e.notes}</span></div>}
          {on("bh") && <div className="dx-card-line"><Ico name="hourglass" size={12} />{trim1(eventHours(e))} BH</div>}
          {on("tracked") && e.trackedSeconds > 0 && <div className="dx-card-line"><Ico name="clock" size={12} />{clockText(e.trackedSeconds)} tracked</div>}
          {on("onSite") && e.onSite && <div className="dx-card-line"><span className="dx-onsite">On site</span></div>}
          {on("phone") && e.customer?.phone && <div className="dx-card-line"><Ico name="phone" size={12} />{e.customer.phone}</div>}
          {on("lastService") && e.lastServiceOn && <div className="dx-card-line"><Ico name="undo" size={12} />Last serviced {monthDay(e.lastServiceOn)}</div>}
          {on("revenue") && e.totalCents != null && e.kind === "visit" && <div className="dx-card-line"><strong>{dollars(e.totalCents)}</strong></div>}
          {on("invoiceable") && e.kind === "visit" && <div className="dx-card-line">{e.invoice ? `Invoice ${e.invoice.number ?? "(draft)"}` : e.invoiceable ? "Not invoiced" : "Not invoiceable"}</div>}
          {on("media") && e.fileCount > 0 && <div className="dx-card-line"><Ico name="image" size={12} />{e.fileCount}</div>}
          {on("notesInline") && e.dispatchNotes.slice(-1).map((n) => <div key={n.id} className="dx-card-note">{n.body}</div>)}
          {e.status !== "open" && <div className="dx-card-line"><StatusPill e={e} /></div>}
        </div>
      </div>
    );
  };
  const dropOn = async (lane: Lane) => {
    const key = dragKey; setDragKey(null); setOverLane(null);
    const e = key ? byKey.get(key) : undefined;
    if (!e || laneKeyOf(e) === lane.key) return;
    setSaving((s) => new Set(s).add(e.key));
    try {
      const r = await dispatchApi.assign([e.key], lane.kind === "crew" ? { crewId: lane.crewId } : { employeeIds: lane.employeeIds });
      toast(lane.kind === "unassigned" ? "Event unassigned" : `Assigned to ${lane.name}${r.unrouted ? "; it came off its route" : ""}`);
    } catch (err) { toast(`Couldn't move it to ${lane.name}: ${(err as Error).message}`, true); }
    await reload();
    setSaving((s) => { const n = new Set(s); n.delete(e.key); return n; });
  };
  const boardView = (
    <div className="dx-lanes">
      {lanes.map((lane) => {
        const cap = capacityText(lane.hours, lane.capacity);
        const keys = lane.events.map((e) => e.key);
        const on = keys.filter((k) => selected.has(k)).length;
        return (
          <section key={lane.key} className={`dx-lane${overLane === lane.key ? " over" : ""}`} onDragOver={(ev) => { if (dragKey) { ev.preventDefault(); setOverLane(lane.key); } }} onDragLeave={() => setOverLane((l) => (l === lane.key ? null : l))} onDrop={(ev) => { ev.preventDefault(); dropOn(lane); }}>
            <header className="dx-lane-head">
              <div className="dx-lane-name">
                <Check checked={keys.length > 0 && on === keys.length} mixed={on > 0 && on < keys.length} disabled={!keys.length} label={`Select all events in ${lane.name}`} onChange={(v) => { const n = new Set(selected); for (const k of keys) if (v) n.add(k); else n.delete(k); setSelected(n); }} />
                {lane.kind !== "unassigned" && <Ico name={lane.kind === "crew" ? "users" : "user"} size={14} />}
                {lane.color && <span className="dx-dot" style={{ background: lane.color }} />}
                <strong title={lane.name}>{lane.name}</strong>
                {lane.capacity == null && <span className="dx-lane-bh">{trim1(lane.hours)} <small>BH</small></span>}
              </div>
              {lane.capacity != null && (
                <>
                  <div className={`dx-bar-track${cap.over ? " over" : ""}`}><span style={{ width: `${cap.share * 100}%` }} /></div>
                  <div className="dx-lane-cap"><span><b className={cap.over ? "over" : ""}>{trim1(lane.hours)}</b> / {trim1(lane.capacity)}</span><span className={cap.over ? "over" : ""}>{cap.rest.replace(/ [\d.]+$/, "")} <b>{cap.rest.match(/[\d.]+$/)?.[0]}</b></span></div>
                </>
              )}
            </header>
            <div className={`dx-lane-body${lane.events.length ? "" : " empty"}`}>{lane.events.length ? lane.events.map(card) : <span>No events</span>}</div>
            <footer className="dx-lane-foot"><span>{lane.events.length} event{lane.events.length === 1 ? "" : "s"}</span><strong>{b && lane.events.some((e) => e.totalCents != null) ? wholeDollars(lane.cents) : ""}</strong></footer>
          </section>
        );
      })}
      {(hidden.crews > 0 || hidden.people > 0 || showHidden.crews || showHidden.people) && (
        <div className="dx-lane-more">
          {(hidden.crews > 0 || showHidden.crews) && <button type="button" className="dx-btn" onClick={() => setShowHidden({ ...showHidden, crews: !showHidden.crews })}><Ico name={showHidden.crews ? "eyeOff" : "eye"} />{showHidden.crews ? "Hide crews with nothing scheduled" : `Show hidden crews (${hidden.crews})`}</button>}
          {(hidden.people > 0 || showHidden.people) && <button type="button" className="dx-btn" onClick={() => setShowHidden({ ...showHidden, people: !showHidden.people })}><Ico name={showHidden.people ? "eyeOff" : "eye"} />{showHidden.people ? "Hide employees with nothing scheduled" : `Show hidden employees (${hidden.people})`}</button>}
        </div>
      )}
    </div>
  );

  const totals = (events: DEvent[]) => ({ tracked: events.reduce((s, e) => s + e.trackedSeconds, 0), hours: events.reduce((s, e) => s + eventHours(e), 0), cents: events.reduce((s, e) => s + (e.totalCents ?? 0), 0), priced: events.some((e) => e.totalCents != null) });
  const foot = totals(picked.length ? picked : shown);
  const anyDone = picked.some((e) => e.status === "completed");
  const bulk: { label: string; icon: string; onClick: () => void; disabled?: boolean; hint?: string; danger?: boolean }[] = [
    { label: "Contact customer", icon: "message", onClick: () => contact(picked, canText ? "text" : "email") },
    { label: "Unassign", icon: "users", onClick: () => void act(() => dispatchApi.assign(picked.map((e) => e.key), {}), `${picked.length} event${picked.length === 1 ? "" : "s"} unassigned`) },
    { label: "Reschedule", icon: "calendar", disabled: anyDone, hint: anyDone ? "Completed events can't be rescheduled; take them out of the selection" : undefined, onClick: () => setDialog({ kind: "reschedule", keys: picked.map((e) => e.key) }) },
    { label: "Duplicate", icon: "copy", onClick: () => void act(() => dispatchApi.duplicate(picked.map((e) => e.key)), `${picked.length} event${picked.length === 1 ? "" : "s"} duplicated`) },
    { label: "Move to waitlist", icon: "hourglass", onClick: () => setDialog({ kind: "waitlist", keys: picked.map((e) => e.key) }) },
    { label: "Delete", icon: "trash", danger: true, onClick: () => setDialog({ kind: "delete", keys: picked.map((e) => e.key) }) },
  ];
  const wide = prefs.layout === "list";

  return (
    <div className={`dx dx-page layout-${prefs.layout}${routing ? " routing" : ""}${waitlist ? " with-waitlist" : ""}`}>
      {/* ── Header ── */}
      <div className="dx-head">
        <div className="dx-head-left">
          <div className="dx-group">
            <button type="button" className="dx-group-btn" aria-label={`Change view, currently ${prefs.mode[0].toUpperCase()}${prefs.mode.slice(1)}`} disabled={routing} onClick={(e) => setMenu({ what: "mode", at: anchorOf(e.currentTarget) })}><Ico name="calendar" /><strong>{prefs.mode[0].toUpperCase() + prefs.mode.slice(1)}</strong><Ico name="down" size={14} /></button>
            <button type="button" className="dx-group-btn date" aria-label="Pick a date to jump to" disabled={routing} onClick={(e) => setMenu({ what: "date", at: anchorOf(e.currentTarget) })}>{rangeLabel}</button>
          </div>
          <button type="button" className="dx-sq" aria-label={`Previous ${unit}`} disabled={routing} onClick={() => move(-1)}><Ico name="left" /></button>
          <button type="button" className="dx-sq text" disabled={routing} onClick={() => setPrefs({ date: null, ...(prefs.mode === "custom" ? { mode: "day" as Mode } : {}) })}>Today</button>
          <button type="button" className="dx-sq" aria-label={`Next ${unit}`} disabled={routing} onClick={() => move(1)}><Ico name="right" /></button>
        </div>
        <div className="dx-head-mid">
          <Seg value={prefs.layout} onChange={(v) => setPrefs({ layout: v })} options={[{ value: "list", label: listLabel, icon: prefs.list === "table" ? "table" : "board" }, { value: "split", label: "Split", icon: "split" }, { value: "map", label: "Map", icon: "map" }]} />
          <button type="button" className={`dx-sq text waitbtn${waitlist ? " on" : ""}`} aria-label="Waitlist" onClick={() => setWaitlist(!waitlist)}><Ico name="hourglass" />Waitlist{!!b?.waiting && <span className="dx-count">{b.waiting}</span>}</button>
        </div>
        <div className="dx-head-right">
          <button type="button" className="dx-icon-btn" aria-label="Print" title={routing ? "Save or leave the route first" : oneDay ? "Print" : "Printing works on one day at a time"} disabled={routing || !oneDay} onClick={(e) => setMenu({ what: "print", at: anchorOf(e.currentTarget) })}><Ico name="print" size={18} /></button>
          <Link className={`dx-icon-btn${routing ? " disabled" : ""}`} aria-label="Dispatch board" title="Open the other dispatch board (from the Crewdesk plan)" href="/dispatch"><Ico name="swap" size={18} /></Link>
          <button type="button" className="dx-icon-btn" aria-label="View" title="View" onClick={(e) => setMenu({ what: "view", at: anchorOf(e.currentTarget) })}><Ico name="sliders" size={18} /></button>
        </div>
      </div>

      {/* ── Toolbar (or the route bar) ── */}
      {routing && b ? (
        <RouteBanner r={route} board={b} onExit={exitRoute} onAssignAll={() => setDialog({ kind: "assignAll", keys: route.draft!.keys })} onFuture={() => setDialog({ kind: "future", keys: [] })} />
      ) : (
        <div className="dx-bar">
          <Seg small value={prefs.list} onChange={(v) => setPrefs({ list: v })} options={[{ value: "table", label: "Table", icon: "table" }, { value: "board", label: "Board", icon: "board" }]} />
          <div className="dx-filters">
            <button type="button" className="dx-filter-add" onClick={(e) => setMenu({ what: "filter", at: anchorOf(e.currentTarget) })}><Ico name="plus" size={14} />Filter</button>
            {b && FILTER_DEFS.filter((f) => prefs.filters[f.key]?.length).map((f) => {
              const opts = filterOptions(f.key, all, b, tags);
              const names = prefs.filters[f.key].map((v) => opts.find((o) => o.value === v)?.label ?? v);
              return <span key={f.key} className="dx-chip filter"><b>{f.label}:</b> {names.slice(0, 2).join(", ")}{names.length > 2 ? ` +${names.length - 2}` : ""}<button type="button" aria-label={`Remove the ${f.label} filter`} onClick={() => { const { [f.key]: _gone, ...rest } = prefs.filters; setPrefs({ filters: rest }); }}><Ico name="x" size={12} /></button></span>;
            })}
            {filterCount > 1 && <button type="button" className="dx-link" onClick={() => setPrefs({ filters: {} })}>Clear all</button>}
            {searching || search ? (
              <label className="dx-search"><Ico name="search" /><input autoFocus value={search} placeholder="Search events" onChange={(e) => setSearch(e.target.value)} onBlur={() => { if (!search) setSearching(false); }} aria-label="Search events" />{search && <button type="button" aria-label="Clear the search" onClick={() => { setSearch(""); setSearching(false); }}><Ico name="x" size={12} /></button>}</label>
            ) : <button type="button" className="dx-icon-btn" aria-label="Search events" onClick={() => setSearching(true)}><Ico name="search" /></button>}
          </div>
          <div className="dx-bar-right">
            {picked.length > 0 && <button type="button" className="dx-btn ghost" onClick={clear}>Clear selection</button>}
            {mixed && <span className="dx-muted dx-bar-note">Mixed selection</span>}
            {oneRoute && <span className="dx-muted dx-bar-note">{picked.length === oneRoute.stops.length ? "Route selected" : "Partial route selected"}</span>}
            <button type="button" className="dx-btn" disabled={!picked.length} onClick={() => setDialog({ kind: "assign", keys: picked.map((e) => e.key) })}><Ico name="users" />Assign</button>
            {oneRoute && <button type="button" className="dx-btn" onClick={() => (prefs.skipUnrouteAsk ? void act(() => dispatchApi.unroute(picked.map((e) => e.key)), `${picked.length} stop${picked.length === 1 ? "" : "s"} taken off the route`).then(clear) : setDialog({ kind: "unroute", keys: picked.map((e) => e.key) }))}>{picked.length === oneRoute.stops.length ? "Unroute all stops" : `Unroute ${picked.length} stop${picked.length === 1 ? "" : "s"}`}</button>}
            <button type="button" className="dx-btn dark" disabled={!picked.length || !oneDay} title={!oneDay ? "Routing is available for a single day." : undefined} onClick={startRoute}><Ico name="route" />{oneRoute ? "Edit route" : picked.length ? `Route ${picked.length} stop${picked.length === 1 ? "" : "s"}` : "Route stops"}</button>
          </div>
        </div>
      )}

      {board.error && <div className="dx-banner bad">{board.error}</div>}

      {/* ── The list, the map, the waitlist ── */}
      <div className="dx-body">
        {prefs.layout !== "map" && (
          <div className="dx-list">
            {routing && b ? <RouteList r={route} board={b} events={byKey} etaWindow={prefs.eta} onEta={(eta) => setPrefs({ eta })} onMapPick={(w) => { setPicking(w); if (prefs.layout === "list") setPrefs({ layout: "split" }); }}
              onStopAction={(e, a) => (a === "reschedule" ? setDialog({ kind: "reschedule", keys: [e.key] }) : onAction(e, a))} />
              : prefs.list === "table" ? table : boardView}
          </div>
        )}
        {prefs.layout !== "list" && (
          <div className="dx-mapwrap">
            <DispatchMap ref={mapRef} pins={pins} lines={lines} flags={flags} areas={shownAreas} trucks={trucks} addressPin={address} showNumbers={prefs.showOrder} satellite={prefs.satellite}
              fitKey={`${range.from}|${range.to}|${JSON.stringify(prefs.filters)}|${b ? 1 : 0}|${routing ? `${route.draft!.id ?? "new"}${route.preview ? 1 : 0}` : ""}`}
              lasso={lasso && !routing} onLasso={(keys) => { setSelected(new Set([...selected, ...keys])); setLasso(false); if (keys.length) toast(`${keys.length} added to the selection`); }}
              onPin={(keys, o) => { if (routing) { for (const k of keys) route.toggle(k); } else if (keys.length === 1 && !o.additive) pick(keys[0]); else { const n = new Set(selected); const allOn = keys.every((k) => n.has(k)); for (const k of keys) if (allOn) n.delete(k); else n.add(k); setSelected(n); } }}
              onPinMenu={(key, x, y) => { if (!routing) setEventMenu({ key, at: { x, y }, withView: true }); else if (route.draft!.keys.includes(key)) setEventMenu({ key, at: { x, y } }); }}
              drawing={drawing} onDrawPoint={(pt) => setDrawing((d) => (d ? [...d, pt] : d))}
              picking={!!picking} onPick={(pt) => { const p: PointChoice = { kind: "custom", label: `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`, lat: pt.lat, lng: pt.lng }; if (picking === "end") route.setEnd(p); else route.setStart(p); setPicking(null); }}>
              <div className="dx-map-tools tl">
                <button type="button" className={`dx-map-btn${addressOpen ? " on" : ""}`} aria-label="Search for an address" title="Search for an address" onClick={() => setAddressOpen(!addressOpen)}><Ico name="pin" /></button>
                {addressOpen && (
                  <form className="dx-address" onSubmit={async (e) => { e.preventDefault(); if (addressText.trim().length < 3) return; setAddressError(null); try { const r = await api<{ lat: number; lng: number; label: string }>(`/dispatch/locate?q=${encodeURIComponent(addressText.trim())}`); setAddress(r); mapRef.current?.flyTo(r.lat, r.lng, 16); } catch { setAddressError("Couldn't find that address."); } }}>
                    <input value={addressText} onChange={(e) => setAddressText(e.target.value)} placeholder="Search an address…" aria-label="Search an address" autoFocus />
                    {(address || addressText) && <button type="button" aria-label="Clear" onClick={() => { setAddress(null); setAddressText(""); setAddressError(null); }}><Ico name="x" size={14} /></button>}
                    {addressError && <span className="dx-address-error">{addressError}</span>}
                  </form>
                )}
              </div>
              <div className="dx-map-tools tr">
                <button type="button" className={`dx-map-btn${areasOpen ? " on" : ""}`} aria-label="Custom areas" title="Custom areas" onClick={() => setAreasOpen(!areasOpen)}><Ico name="shapes" /></button>
                <button type="button" className={`dx-map-btn${lasso ? " on" : ""}`} aria-label="Lasso select" title={routing ? "The lasso isn't available while you build a route" : "Lasso select: drag a loop around pins"} disabled={routing} onClick={() => setLasso(!lasso)}><Ico name="lasso" /></button>
              </div>
              {areasOpen && <AreasPanel areas={areas.data?.areas ?? []} shown={prefs.areas} onShown={(ids) => setPrefs({ areas: ids })} drawing={drawing} setDrawing={setDrawing} onChanged={() => areas.reload()} onClose={() => { setAreasOpen(false); setDrawing(null); }} toast={toast} />}
              <div className="dx-map-tools br">
                <button type="button" className="dx-map-btn" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Ico name="plus" /></button>
                <button type="button" className="dx-map-btn" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Ico name="minus" /></button>
                <button type="button" className="dx-map-btn" aria-label="Fit map to stops" title="Fit map to stops" onClick={() => mapRef.current?.fit()}><Ico name="fit" /></button>
              </div>
              <div className="dx-map-tools bl">
                <button type="button" className="dx-colorby" role="combobox" aria-label="Color events by" aria-expanded={menu?.what === "color"} onClick={(e) => setMenu({ what: "color", at: anchorOf(e.currentTarget) })}><Ico name="palette" />{COLOR_MODE_LABELS[prefs.color]}<Ico name="down" size={14} /></button>
                <button type="button" className="dx-icon-btn" aria-label={legend ? "Hide legend" : "Show legend"} onClick={() => setLegend(!legend)}><Ico name="info" /></button>
              </div>
              {legend && prefs.color !== "routing" && legendItems.length > 0 && <div className="dx-legend">{legendItems.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>}
              {unplaced > 0 && !drawing && <div className="dx-map-note">{unplaced} event{unplaced === 1 ? "" : "s"} without a location {unplaced === 1 ? "is" : "are"} not shown</div>}
              {picking && <div className="dx-map-hint">Click the map where the route {picking === "start" ? "starts" : "ends"} <button type="button" className="dx-link" onClick={() => setPicking(null)}>Cancel</button></div>}
              {routing && !picking && <div className="dx-map-hintbar"><Ico name="info" size={14} /><kbd>Click</kbd> add or remove a stop <kbd>Right-click</kbd> stop controls</div>}
            </DispatchMap>
          </div>
        )}
        {waitlist && b && <WaitlistPanel date={range.from} today={today} oneDay={oneDay} onClose={() => setWaitlist(false)} onAdded={(n) => { toast(`Added ${n} event${n === 1 ? "" : "s"} to the schedule.`); reload(); }} toast={toast} />}
        {viewing && byKey.get(viewing) && b && (
          <WorkView e={byKey.get(viewing)!} board={b} today={today} tags={tags} canText={canText} onClose={() => setViewing(null)}
            onStep={(by) => { const keys = shown.map((e) => e.key); const i = keys.indexOf(viewing); const next = keys[i + by]; if (next) setViewing(next); }}
            onStatus={(s) => askStatus([byKey.get(viewing)!], s)} onAction={(a) => (a === "view" ? router.push(eventHref(byKey.get(viewing)!)) : onAction(byKey.get(viewing)!, a))} onNotes={() => reload()} />
        )}
      </div>

      {/* ── Footer: totals, or what to do with the selection ── */}
      {routing ? <RouteFooter r={route} events={byKey} /> : (
        <div className="dx-foot">
          {picked.length ? (
            <div className="dx-foot-sel">
              <span>{picked.length} of {shown.length} selected</span>
              <button type="button" className="dx-icon-btn" aria-label="Clear selection" onClick={clear}><Ico name="x" /></button>
              <button type="button" className="dx-btn" onClick={(e) => setMenu({ what: "status", at: anchorOf(e.currentTarget) })}><Ico name="circleCheck" />Set status<Ico name="up" size={14} /></button>
              {wide && bulk.map((x) => <button key={x.label} type="button" className={`dx-btn${x.danger ? " danger-text" : ""}`} disabled={x.disabled} title={x.hint} onClick={x.onClick}><Ico name={x.icon} />{x.label}</button>)}
              {!wide && <button type="button" className="dx-btn" onClick={(e) => setMenu({ what: "more", at: anchorOf(e.currentTarget) })}>More<Ico name="dots" /></button>}
            </div>
          ) : <span><span className="dx-muted">Events</span> <strong>{shown.length}</strong></span>}
          <span style={{ flex: 1 }} />
          <span><span className="dx-muted">Tracked time</span> <strong>{hoursBoth(foot.tracked)}</strong></span>
          <span><span className="dx-muted">BH</span> <strong>{hoursBoth(foot.hours * 3600)}</strong></span>
          {foot.priced && <span><span className="dx-muted">Total</span> <strong>{dollars(foot.cents)}</strong></span>}
        </div>
      )}

      {/* ── Menus ── */}
      <Pop at={menu?.what === "mode" ? menu.at : null} onClose={() => setMenu(null)} width={150}>
        {(["day", "week", "month", "custom"] as Mode[]).map((m) => <MenuItem key={m} checked={prefs.mode === m} onClick={() => { setPrefs({ mode: m, ...(m === "custom" ? { date: range.from, customTo: range.to } : {}) }); setMenu(null); }}>{m[0].toUpperCase() + m.slice(1)}</MenuItem>)}
      </Pop>
      <Pop at={menu?.what === "date" ? menu.at : null} onClose={() => setMenu(null)} className="pad">
        {prefs.mode === "custom" ? (
          <div className="dx-custom-range">
            <label>From <input type="date" className="dx-input" value={range.from} onChange={(e) => e.target.value && setPrefs({ date: e.target.value, customTo: e.target.value > range.to ? e.target.value : range.to })} /></label>
            <label>To <input type="date" className="dx-input" value={range.to} min={range.from} onChange={(e) => e.target.value && setPrefs({ customTo: e.target.value })} /></label>
            <p className="dx-muted">Up to two months.</p>
          </div>
        ) : <MiniCal value={anchor} today={today} onPick={(d) => { setPrefs({ date: d }); setMenu(null); }} />}
      </Pop>
      {b && <FilterMenu at={menu?.what === "filter" ? menu.at : null} onClose={() => setMenu(null)} events={all} board={b} tags={tags} filters={prefs.filters} onChange={(filters) => setPrefs({ filters })} />}
      <Pop at={menu?.what === "columns" ? menu.at : null} onClose={() => setMenu(null)} width={270} align="right" className="pad">
        <ColumnsMenu order={prefs.order} hidden={prefs.hidden} inline={prefs.inlineNotes} onChange={(order, hiddenCols, inlineNotes) => setPrefs({ order, hidden: hiddenCols, inlineNotes })} />
      </Pop>
      <Pop at={menu?.what === "view" ? menu.at : null} onClose={() => setMenu(null)} width={250} align="right">
        <MenuItem icon="swap" disabled={routing} hint={routing ? "Save or leave the route first" : undefined} onClick={() => router.push("/dispatch")}>Switch to the Dispatch board</MenuItem>
        <MenuItem icon="gear" onClick={() => { setMenu(null); setDialog({ kind: "settings", keys: [] }); }}>Routing and capacity…</MenuItem>
        <div className="dx-pop-label">Map</div>
        <label className="dx-mi"><Check checked={prefs.showTrucks} label="Show trucks" onChange={(v) => setPrefs({ showTrucks: v })} /> Show trucks</label>
        <label className="dx-mi"><Check checked={prefs.showOrder} label="Show route order" onChange={(v) => setPrefs({ showOrder: v })} /> Show route order</label>
        <label className="dx-mi"><Check checked={prefs.satellite} label="Show satellite view" onChange={(v) => setPrefs({ satellite: v })} /> Show satellite view</label>
        <div className="dx-pop-label">Event card details</div>
        <button type="button" className="dx-select" onClick={(e) => setMenu({ what: "card", at: anchorOf(e.currentTarget) })}><span>{CARD_DETAILS.flatMap((g) => g.items).filter(([k]) => prefs.card.includes(k)).map(([, l]) => l).join(", ") || "None"}</span><Ico name="down" size={14} /></button>
        <div className="dx-pop-label">Event color</div>
        <button type="button" className="dx-select" onClick={(e) => setMenu({ what: "color", at: anchorOf(e.currentTarget) })}><span>{COLOR_MODE_LABELS[prefs.color]}</span><Ico name="down" size={14} /></button>
        <hr />
        <MenuItem icon="undo" onClick={() => setPrefs({ color: "routing", showOrder: true, showTrucks: false, satellite: false })}>Reset all</MenuItem>
      </Pop>
      <Pop at={menu?.what === "card" ? menu.at : null} onClose={() => setMenu(null)} width={260} align="right" className="pad">
        <div className="dx-pop-title">Show/hide details</div>
        {CARD_DETAILS.map((g) => (
          <div key={g.group}>
            <div className="dx-pop-label">{g.group}</div>
            {g.items.map(([k, label]) => <button key={k} type="button" className="dx-eye-row" onClick={() => setPrefs({ card: prefs.card.includes(k) ? prefs.card.filter((x) => x !== k) : [...prefs.card, k] })}><span>{label}</span><Ico name={prefs.card.includes(k) ? "eye" : "eyeOff"} className={prefs.card.includes(k) ? "" : "dx-faint"} /></button>)}
          </div>
        ))}
        <hr /><button type="button" className="dx-link" onClick={() => setPrefs({ card: DEFAULT_PREFS.card })}>Reset to default</button>
      </Pop>
      <Pop at={menu?.what === "color" ? menu.at : null} onClose={() => setMenu(null)} width={200}>
        <div className="dx-pop-label">Color events by…</div>
        {COLOR_MODES.map((m) => <MenuItem key={m} checked={prefs.color === m} onClick={() => { setPrefs({ color: m }); setMenu(null); }}>{COLOR_MODE_LABELS[m]}</MenuItem>)}
      </Pop>
      <Pop at={menu?.what === "print" ? menu.at : null} onClose={() => setMenu(null)} width={230} align="right">
        <div className="dx-pop-label">Print routes</div>
        <MenuItem icon="map" disabled={prefs.layout === "list"} hint={prefs.layout === "list" ? "Map hidden: switch to Split or Map" : undefined} onClick={() => { setMenu(null); setDialog({ kind: "print", what: "map" }); }}>Map{prefs.layout === "list" ? " (map hidden)" : ""}</MenuItem>
        <MenuItem icon="route" disabled={!routes.length} onClick={() => { setMenu(null); setDialog({ kind: "print", what: "directions" }); }}>Directions</MenuItem>
        <MenuItem icon="table" disabled={!routes.length} onClick={() => { setMenu(null); setDialog({ kind: "print", what: "stops" }); }}>Stops list</MenuItem>
        {!routes.length && <div className="dx-pop-hint">No saved route for this day</div>}
      </Pop>
      <Pop at={menu?.what === "status" ? menu.at : null} onClose={() => setMenu(null)} width={170}>
        {(["open", "skipped", "completed"] as const).map((s) => <MenuItem key={s} onClick={() => { setMenu(null); askStatus(picked, s); }}>{s === "open" ? "Open" : s === "skipped" ? "Skipped" : "Complete"}</MenuItem>)}
      </Pop>
      <Pop at={menu?.what === "more" ? menu.at : null} onClose={() => setMenu(null)} width={210}>
        {bulk.map((x) => <MenuItem key={x.label} icon={x.icon} danger={x.danger} disabled={x.disabled} hint={x.hint} onClick={() => { setMenu(null); x.onClick(); }}>{x.label}</MenuItem>)}
      </Pop>
      {eventMenu && byKey.get(eventMenu.key) && (routing
        ? <Pop at={eventMenu.at} onClose={() => setEventMenu(null)} width={200}>
            <MenuItem icon="plus" onClick={() => { const i = route.draft!.keys.indexOf(eventMenu.key); route.move(i, i + 1); setEventMenu(null); }}>Later in the route</MenuItem>
            <MenuItem icon="minus" onClick={() => { const i = route.draft!.keys.indexOf(eventMenu.key); route.move(i, i - 1); setEventMenu(null); }}>Earlier in the route</MenuItem>
            <MenuItem icon="eye" onClick={() => { setViewing(eventMenu.key); setEventMenu(null); }}>Details</MenuItem>
            <MenuItem icon="x" onClick={() => { route.remove(eventMenu.key); setEventMenu(null); }}>Remove from route</MenuItem>
          </Pop>
        : <EventMenu e={byKey.get(eventMenu.key)!} at={eventMenu.at} withView={eventMenu.withView} canText={canText} onClose={() => setEventMenu(null)} onAction={(a) => onAction(byKey.get(eventMenu.key)!, a)} />)}

      {/* ── Windows ── */}
      {dialog?.kind === "assign" && b && dialogEvents.length > 0 && <AssignDialog board={b} events={dialogEvents} onClose={() => setDialog(null)} onAssign={async (to) => {
        const r = await dispatchApi.assign(dialog.keys, to);
        toast(!to.crewId && !to.employeeIds.length ? `${r.assigned} event${r.assigned === 1 ? "" : "s"} unassigned` : `${to.crewId ? "Crew" : to.employeeIds.length === 1 ? "Employee" : "Employees"} assigned to ${r.assigned} event${r.assigned === 1 ? "" : "s"}${r.unrouted ? `. ${r.unrouted} came off ${r.unrouted === 1 ? "its route" : "their routes"}.` : ""}`);
        setDialog(null); await reload();
      }} />}
      {dialog?.kind === "assignAll" && b && route.draft && <AssignDialog title={`Assign all (${route.draft.keys.length})`} board={b} events={route.draft.keys.map((k) => byKey.get(k)).filter((e): e is DEvent => !!e)} onClose={() => setDialog(null)} onAssign={async (to) => {
        await dispatchApi.assign(route.draft!.keys.filter((k) => !byKey.get(k)?.route || byKey.get(k)?.route?.id !== route.draft!.id), to).catch(() => null);
        if (route.draft!.id) await dispatchApi.saveRoute({ id: route.draft!.id, date: route.draft!.date, keys: route.draft!.keys, start: route.draft!.start, end: route.draft!.end, startTime: route.draft!.startTime, pinnedFirst: route.draft!.pinnedFirst, assign: to });
        else await dispatchApi.assign(route.draft!.keys, to);
        toast(`Assigned to ${route.draft!.keys.length} stop${route.draft!.keys.length === 1 ? "" : "s"}`); setDialog(null); await reload();
      }} />}
      {dialog?.kind === "reschedule" && dialogEvents.length > 0 && <RescheduleDialog events={dialogEvents} today={today} onClose={() => setDialog(null)} onDone={async (date) => {
        const r = await dispatchApi.reschedule(dialog.keys, date);
        toast(r.rescheduled === 1 ? "Event rescheduled" : `${r.rescheduled} events rescheduled`);
        if (routing) for (const k of dialog.keys) route.remove(k);
        setDialog(null); clear(); await reload();
      }} />}
      {dialog?.kind === "waitlist" && <WaitlistDialog events={dialogEvents} onClose={() => setDialog(null)} onDone={async (dueBy) => { const r = await dispatchApi.toWaitlist(dialog.keys, dueBy); toast(`${r.moved} event${r.moved === 1 ? "" : "s"} moved to the waitlist`); setDialog(null); clear(); await reload(); }} />}
      {dialog?.kind === "delete" && <ConfirmDialog title={dialogEvents.length === 1 ? "Delete event" : "Delete selected events"} action="Delete" danger onClose={() => setDialog(null)} onDone={async () => { const r = await dispatchApi.remove(dialog.keys); toast(`${r.deleted} event${r.deleted === 1 ? "" : "s"} deleted${r.kept ? `. ${r.kept} on an invoice ${r.kept === 1 ? "was" : "were"} kept.` : ""}`); setDialog(null); clear(); setViewing(null); await reload(); }}>
        <p>Are you sure you want to delete {dialogEvents.length === 1 ? `“${dialogEvents[0].title}”` : `${dialogEvents.length} events`}? This cannot be undone.</p>
        {dialogEvents.some((e) => e.seriesId) && <p className="dx-note">{dialogEvents.filter((e) => e.seriesId).length === 1 ? "One of these is" : "Some of these are"} part of a recurring series. Only {dialogEvents.length === 1 ? "this visit is" : "these visits are"} deleted; the rest of the series stays.</p>}
      </ConfirmDialog>}
      {dialog?.kind === "skip" && <SkipDialog count={dialogEvents.length} onClose={() => setDialog(null)} onDone={async (reason) => { await setStatus(dialogEvents, "skipped", reason); setDialog(null); }} />}
      {dialog?.kind === "unroute" && <ConfirmDialog title="Remove from route" action={`Unroute ${dialogEvents.length} stop${dialogEvents.length === 1 ? "" : "s"}`} onClose={() => setDialog(null)} onDone={async () => { await dispatchApi.unroute(dialog.keys); toast(`${dialogEvents.length} stop${dialogEvents.length === 1 ? "" : "s"} taken off the route`); setDialog(null); clear(); await reload(); }}>
        <p>{dialogEvents.length === 1 ? "This stop comes" : `These ${dialogEvents.length} stops come`} off the route and show 00. The stops left on it renumber from 01. Nothing is deleted, and dates, crews and statuses don't change.</p>
        <label className="dx-check-line"><Check checked={prefs.skipUnrouteAsk} label="Don't show again" onChange={(v) => setPrefs({ skipUnrouteAsk: v })} /> Don't show again</label>
      </ConfirmDialog>}
      {dialog?.kind === "discard" && <Dialog title="Discard route changes?" onClose={() => setDialog(null)} footer={<><button type="button" className="dx-btn" onClick={() => setDialog(null)}>Stay on this page</button><button type="button" className="dx-btn danger" onClick={() => { setDialog(null); route.exit(); }}>Discard changes</button></>}>
        <p>You have unsaved changes to this route. Leaving now discards them — use “Save order” first to keep them.</p>
      </Dialog>}
      {dialog?.kind === "future" && b && route.draft && <FutureDialog r={route} board={b} events={byKey} today={today} onClose={() => setDialog(null)} />}
      {dialog?.kind === "settings" && b && <SettingsDialog board={b} isAdmin={isAdmin} onClose={() => setDialog(null)} onSaved={() => { toast("Saved"); reload(); }} />}
      {dialog?.kind === "print" && b && <PrintDialog what={dialog.what} board={b} events={byKey} onClose={() => setDialog(null)} />}
      {(dialog?.kind === "text" || dialog?.kind === "email") && (
        <div className="dx dx-overlay side" onMouseDown={(e) => { if (e.target === e.currentTarget) setDialog(null); }}>
          <div className="dx-drawer" role="dialog" aria-label={dialog.kind === "text" ? "Text customers" : "Email customers"}>
            {dialog.kind === "text"
              ? <BulkText selection={{ ids: dialog.customerIds }} audience={dialog.audience} onClose={() => setDialog(null)} />
              : <EmailComposer selection={{ ids: dialog.customerIds }} audience={dialog.audience} onClose={() => setDialog(null)} onSent={(m) => { setDialog(null); toast(`Sending to ${m.sending} customer${m.sending === 1 ? "" : "s"} now.`); }} />}
          </div>
        </div>
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}

/* ───────────── "+ Filter" ───────────── */

function FilterMenu({ at, onClose, events, board, tags, filters, onChange }: { at: Anchor | null; onClose: () => void; events: DEvent[]; board: Board; tags: { id: string; name: string }[]; filters: Filters; onChange: (f: Filters) => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  useEffect(() => { if (!at) { setKey(null); setEmpty(false); } }, [at]);
  const def = FILTER_DEFS.find((f) => f.key === key);
  const options = key ? filterOptions(key, events, board, tags) : [];
  const withResults = options.filter((o) => o.count > 0 || (filters[key ?? ""] ?? []).includes(o.value));
  const none = options.length - withResults.length;
  const toggle = (value: string) => { const have = filters[key!] ?? []; onChange({ ...filters, [key!]: have.includes(value) ? have.filter((v) => v !== value) : [...have, value] }); };
  return (
    <Pop at={at} onClose={onClose} width={260}>
      {!def ? (
        <>
          <div className="dx-pop-label">Filter by...</div>
          {FILTER_DEFS.map((f) => <MenuItem key={f.key} onClick={() => setKey(f.key)}>{f.label}{filters[f.key]?.length ? ` (${filters[f.key].length})` : ""}</MenuItem>)}
        </>
      ) : (
        <>
          <button type="button" className="dx-mi back" onClick={() => setKey(null)}><Ico name="left" /><span>{def.label}</span></button>
          <div className="dx-filter-options">
            {(empty ? options : withResults).map((o) => (
              <label key={o.value} className="dx-mi"><Check checked={(filters[key!] ?? []).includes(o.value)} label={o.label} onChange={() => toggle(o.value)} /><span>{o.label}</span><span className="dx-mi-count">{o.count}</span></label>
            ))}
            {!options.length && <div className="dx-pop-hint">Nothing to choose from on these days.</div>}
          </div>
          {none > 0 && <button type="button" className="dx-link dx-filter-more" onClick={() => setEmpty(!empty)}>{empty ? "Hide" : "Show"} {none} with no results</button>}
        </>
      )}
    </Pop>
  );
}

/* ───────────── Show/hide columns ───────────── */

function ColumnsMenu({ order, hidden, inline, onChange }: { order: string[]; hidden: string[]; inline: boolean; onChange: (order: string[], hidden: string[], inline: boolean) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const changed = hidden.join() !== DEFAULT_PREFS.hidden.join() || order.join() !== DEFAULT_PREFS.order.join() || !inline;
  return (
    <div className="dx-cols">
      <div className="dx-pop-title">Show/hide columns</div>
      {order.map((k, i) => {
        const c = COLUMNS.find((x) => x.key === k)!;
        const off = hidden.includes(k);
        return (
          <div key={k} className={`dx-eye-row grip${drag === i ? " dragging" : ""}`} draggable onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (drag === null || drag === i) return; const next = order.slice(); const [m] = next.splice(drag, 1); next.splice(i, 0, m); onChange(next, hidden, inline); setDrag(null); }}>
            <Ico name="grip" size={14} className="dx-faint" /><span>{c.label}</span>
            <button type="button" className="dx-icon-btn" aria-label={`${off ? "Show" : "Hide"} ${c.label}`} disabled={k === "name"} onClick={() => onChange(order, off ? hidden.filter((x) => x !== k) : [...hidden, k], inline)}><Ico name={off ? "eyeOff" : "eye"} className={off ? "dx-faint" : ""} /></button>
          </div>
        );
      })}
      <div className="dx-eye-row"><span style={{ width: 14 }} /><span>Dispatch notes inline</span><button type="button" className="dx-icon-btn" aria-label={`${inline ? "Hide" : "Show"} dispatch notes inline`} onClick={() => onChange(order, hidden, !inline)}><Ico name={inline ? "eye" : "eyeOff"} className={inline ? "" : "dx-faint"} /></button></div>
      {changed && <><hr /><button type="button" className="dx-link" onClick={() => onChange(DEFAULT_PREFS.order, DEFAULT_PREFS.hidden, true)}>Reset to default</button></>}
      <p className="dx-pop-hint">Drag a row to reorder the columns.</p>
    </div>
  );
}

export type { DRoute };

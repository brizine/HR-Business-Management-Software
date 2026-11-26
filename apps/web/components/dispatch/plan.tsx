"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BACK_REASONS, BACK_REASON_LABELS, clock12, clockText, laneKeyOf, milesText, routeTimeline, type Leg } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Popover, readLocal, writeLocal } from "@/components/customer-list";
import { Icon } from "@/components/icons";
import type { WaitData, WaitRow } from "@/components/waitlist";
import {
  dateLabel, dispatchApi, eventHours, eventHref, monthDay, plusDays, startOfWeek, time12, trim1, useBoard, workDays,
  type Board, type DCrew, type DEvent, type DPerson, type DPoint, type DRoute, type Preview,
} from "./data";
import { DispatchMap, type MapFlag, type MapHandle, type MapLine, type MapPin } from "./map";
import { NotesButton } from "./beta-dialogs";
import { Ico } from "./beta-parts";

/**
 * The Dispatch board from the Crewdesk plan: the day's (or week's) work with one lane per crew.
 * Work orders sit in route order in each lane: drag to reorder or to give one to another crew, lock
 * stops in place, and let Optimize order the rest from the shop. Each lane adds up stops, square
 * feet, hours on site and driving against the crew's hours, and what to load. The map draws each
 * route in its crew's color, numbered, with waiting-list services as gray pins to add. A rain or
 * wind day moves a crew's or the whole day's open work in one step.
 */

type Prefs = { view: "board" | "split" | "map"; span: "day" | "week"; date: string | null; mapCodes: string[]; waiting: boolean };
const DEFAULTS: Prefs = { view: "split", span: "day", date: null, mapCodes: [], waiting: false };
type LoadSheet = { groups: { stops: { visitId: string; items: { product: string; unit: string; amount: number; method: string | null; sprayGal: number | null }[] }[] }[] };
type PLane = { id: string; kind: "none" | "crew" | "people"; name: string; color: string; crew: DCrew | null; people: DPerson[]; capacity: number | null; sub: string };
type Hover = { lane: string; date: string; before: string | null };
const GRAY = "#94a3b8";
const WAITING_MAX = 40;
const hoursText = (h: number) => `${trim1(h)} h`;
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const statusWord: Record<string, string> = { on_site: "On site", completed: "Done", skipped: "Skipped" };
const pointOf = (p: DPoint) => ({ kind: p.kind, label: p.label, lat: p.lat, lng: p.lng });
const windowText = (e: Pick<DEvent, "windowStart" | "windowEnd" | "startTime">) => (e.windowStart ? (e.windowEnd ? `${time12(e.windowStart)}–${time12(e.windowEnd)}` : `After ${time12(e.windowStart)}`) : time12(e.startTime));

/** A lane's work orders: the routed ones in route order, then the rest by time. */
function laneOrder(events: DEvent[]) {
  return [...events].sort((a, b) => (a.route && b.route ? a.route.id.localeCompare(b.route.id) || a.route.order - b.route.order : a.route ? -1 : b.route ? 1 : (a.startTime ?? "99").localeCompare(b.startTime ?? "99") || (a.number ?? 0) - (b.number ?? 0)));
}

/** When each stop would be reached, and which open ones miss their time window. */
function dayOf(o: { keys: string[]; legs: (Leg | null)[]; endLeg: Leg | null; startTime: string; byKey: Map<string, DEvent> }) {
  const events = o.keys.map((k) => o.byKey.get(k));
  const t = routeTimeline({ startTime: o.startTime, minutes: events.map((e) => (e ? Math.round(eventHours(e) * 60) : 0)), legs: o.legs, endLeg: o.endLeg });
  const eta = new Map<string, { at: number; off: "late" | "early" | null }>();
  events.forEach((e, i) => {
    if (!e) return;
    const at = t.arrive[i];
    const off = e.status !== "open" ? null : e.windowEnd && at > minutesOf(e.windowEnd) ? "late" : e.windowStart && at < minutesOf(e.windowStart) - 1 ? "early" : null;
    eta.set(e.key, { at, off });
  });
  return { t, eta, late: events.filter((e): e is DEvent => !!e && eta.get(e.key)?.off === "late") };
}

export function PlanDispatch() {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setPrefsState({ ...DEFAULTS, ...readLocal<Partial<Prefs>>("dp-prefs", {}), date: null }); setLoaded(true); }, []);
  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => { const next = { ...p, ...patch }; writeLocal("dp-prefs", next); return next; });
  const [todayGuess] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Hover | null>(null);
  const [hint, setHint] = useState<{ id: string; p: Preview } | null>(null);
  const hintWanted = useRef("");
  const [busyLane, setBusyLane] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [rain, setRain] = useState<{ who: string } | null>(null);
  const [mcOpen, setMcOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [adding, setAdding] = useState<{ row: WaitRow; crewId: string | null } | null>(null);
  const mapRef = useRef<MapHandle>(null);

  const anchor = prefs.date ?? todayGuess;
  const board = useBoard(loaded ? (prefs.span === "week" ? startOfWeek(anchor) : anchor) : null, loaded ? (prefs.span === "week" ? plusDays(startOfWeek(anchor), 6) : anchor) : null, !!drag);
  const b = board.data;
  const today = b?.today ?? todayGuess;
  const day = prefs.date ?? todayGuess;
  const from = prefs.span === "week" ? startOfWeek(day) : day;
  const to = prefs.span === "week" ? plusDays(from, 6) : day;
  const waiting = useApi<WaitData>(loaded && prefs.span === "day" ? "/waitlist" : null);
  const load = useApi<LoadSheet>(loaded && prefs.span === "day" ? `/chemical-tracking/load-sheet?date=${day}&by=day` : null);
  const say = (text: string, bad = false) => { setNotice({ text, bad }); if (!bad) setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 7000); };
  const reload = async () => { await board.reload(true); if (prefs.span === "day") { waiting.reload(); load.reload(); } };

  const visits = useMemo(() => (b?.events ?? []).filter((e) => e.kind === "visit"), [b]);
  const todos = (b?.events ?? []).filter((e) => e.kind === "todo" && e.date >= from && e.date <= to).length;
  const byKey = useMemo(() => new Map(visits.map((e) => [e.key, e])), [visits]);
  const mapCodes = useMemo(() => [...new Set([...visits.map((e) => e.location?.mapCode), ...(waiting.data?.rows ?? []).map((w) => w.property.mapCode)].filter((x): x is string => !!x))].sort((a, c) => a.localeCompare(c, undefined, { numeric: true })), [visits, waiting.data]);
  const find = q.trim().toLowerCase();
  const shown = useMemo(() => visits.filter((e) => (!prefs.mapCodes.length || prefs.mapCodes.includes(e.location?.mapCode ?? "")) && (!find || [e.title, e.customer?.name, e.location?.address, e.services[0]?.name].some((t) => t?.toLowerCase().includes(find)))), [visits, prefs.mapCodes, find]);
  const filtered = prefs.mapCodes.length > 0 || !!find;
  const waitRows = useMemo(() => (waiting.data?.rows ?? []).filter((w) => (!prefs.mapCodes.length || prefs.mapCodes.includes(w.property.mapCode ?? "")) && (!find || [w.customer.name, w.property.address, w.service.name].some((t) => t.toLowerCase().includes(find)))), [waiting.data, prefs.mapCodes, find]);

  /* ── Lanes: No crew yet, each crew, then people working without a crew ── */
  const lanes: PLane[] = useMemo(() => {
    if (!b) return [];
    const person = new Map(b.people.map((p) => [p.id, p]));
    const out: PLane[] = [{ id: "unassigned", kind: "none", name: "No crew yet", color: GRAY, crew: null, people: [], capacity: null, sub: "" }];
    for (const c of b.crews) {
      const ps = c.memberIds.map((m) => person.get(m)).filter((p): p is DPerson => !!p);
      out.push({ id: `crew:${c.id}`, kind: "crew", name: c.name, color: c.color, crew: c, people: ps, capacity: c.dailyHours, sub: [c.truck, ps.map((p) => p.firstName).join(", ")].filter(Boolean).join(" · ") || "Nobody on this crew yet" });
    }
    const sets = [...new Set(visits.map(laneKeyOf).filter((k) => k.startsWith("emp:")))].map((k) => {
      const ps = k.slice(4).split(",").map((id) => person.get(id)).filter((p): p is DPerson => !!p);
      const counted = ps.filter((p) => !p.excluded);
      return { id: k, kind: "people" as const, name: ps.map((p) => p.name).join(", ") || "Someone no longer on the team", color: ps.length === 1 ? ps[0].color : "#64748b", crew: null, people: ps, capacity: counted.length ? Math.min(...counted.map((p) => p.dailyHours)) : null, sub: "Working without a crew" };
    }).sort((x, y) => x.name.localeCompare(y.name));
    return [...out, ...sets];
  }, [b, visits]);
  const laneOf = (e: DEvent) => lanes.find((l) => l.id === laneKeyOf(e)) ?? lanes[0];
  const cell = (lane: PLane, date: string) => laneOrder(shown.filter((e) => laneKeyOf(e) === lane.id && e.date === date));
  const all = (lane: PLane, date: string) => laneOrder(visits.filter((e) => laneKeyOf(e) === lane.id && e.date === date));
  const routeOf = (crewId: string, date: string): DRoute | undefined => b?.routes.find((r) => r.crewId === crewId && r.date === date);
  const ends = (r: DRoute | undefined) => (r ? { start: pointOf(r.start), end: pointOf(r.end) } : {});
  /** The lane's order with the dragged work order put where it's hovering. */
  const orderWith = (lane: PLane, date: string, key: string, before: string | null) => {
    const order = all(lane, date).map((x) => x.key).filter((k) => k !== key);
    const i = before ? order.indexOf(before) : -1;
    if (i >= 0) order.splice(i, 0, key); else order.push(key);
    return order;
  };
  const hover = (lane: string, date: string, before: string | null) => setOver((o) => (o && o.lane === lane && o.date === date && o.before === before ? o : { lane, date, before }));

  // Before a drop: work out what it would do to the lane's day (drive, hours, time windows).
  useEffect(() => {
    hintWanted.current = "";
    setHint(null);
    if (!drag || !over || drag.startsWith("w:")) return;
    const lane = lanes.find((l) => l.id === over.lane);
    const e = byKey.get(drag);
    if (!lane?.crew || !e || e.date !== over.date) return;
    const id = `${drag}|${over.lane}|${over.date}|${over.before}`;
    hintWanted.current = id;
    const keys = orderWith(lane, over.date, drag, over.before);
    const t = setTimeout(async () => {
      try { const p = await dispatchApi.preview({ date: over.date, keys, ...ends(routeOf(lane.crew!.id, over.date)) }); if (hintWanted.current === id) setHint({ id, p }); } catch { /* the drop itself says what's wrong */ }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, over]);

  const drop = async (lane: PLane, date: string) => {
    const key = drag, at = over;
    setDrag(null); setOver(null);
    if (!key) return;
    if (key.startsWith("w:")) { const row = waiting.data?.rows.find((r) => r.id === key.slice(2)); if (row) setAdding({ row, crewId: lane.crew?.id ?? "" }); return; }
    const e = byKey.get(key);
    if (!e) return;
    const same = laneKeyOf(e) === lane.id && e.date === date;
    if (same && lane.kind !== "crew") return;
    if (e.status === "completed" && e.date !== date) { say("A completed work order can't move to another day.", true); return; }
    setBusyLane(`${lane.id}|${date}`);
    try {
      if (lane.crew) await dispatchApi.lane(date, lane.crew.id, orderWith(lane, date, key, at?.lane === lane.id && at.date === date ? at.before : null));
      else if (lane.kind === "none") await dispatchApi.lane(date, null, [key]);
      else { await dispatchApi.assign([key], { employeeIds: lane.people.map((p) => p.id) }); if (e.date !== date) await dispatchApi.reschedule([key], date); }
      if (!same) say(`${e.customer?.name ?? e.title} → ${lane.name}${e.date !== date ? `, ${dateLabel(date)}` : ""}`);
    } catch (err) { say((err as Error).message, true); }
    await reload();
    setBusyLane(null);
  };
  const optimizeLane = async (lane: PLane, date: string) => {
    const events = all(lane, date);
    if (!lane.crew || events.length < 2) return null;
    const p = await dispatchApi.preview({ date, keys: events.map((e) => e.key), optimize: true, locked: events.filter((e) => e.route?.locked).map((e) => e.key), ...ends(routeOf(lane.crew.id, date)) });
    await dispatchApi.lane(date, lane.crew.id, p.keys);
    return p;
  };
  const optimize = async (lane: PLane, date: string) => {
    setBusyLane(`${lane.id}|${date}`);
    try {
      const held = all(lane, date).filter((e) => e.route?.locked).length;
      const p = await optimizeLane(lane, date);
      if (p) say(`${lane.name}: ordered to keep driving shortest${held ? `, around ${held} locked stop${held === 1 ? "" : "s"}` : ""}. ${clockText(p.totalDriveSeconds)} of driving, ${milesText(p.totalMeters)} mi${p.measured === "estimate" ? " (estimated)" : ""}.`);
    } catch (err) { say((err as Error).message, true); }
    await reload();
    setBusyLane(null);
  };
  const optimizeAll = async () => {
    setBusyLane("all");
    let n = 0, seconds = 0;
    try {
      for (const l of lanes) { const p = await optimizeLane(l, day); if (p) { n++; seconds += p.totalDriveSeconds; } }
      say(n ? `${n} route${n === 1 ? "" : "s"} ordered from the shop: ${clockText(seconds)} of driving in all.` : "No crew has two or more stops to order.");
    } catch (err) { say((err as Error).message, true); }
    await reload();
    setBusyLane(null);
  };
  const toggleLock = async (e: DEvent) => {
    try { await dispatchApi.lock(e.key, !e.route?.locked); } catch (err) { say((err as Error).message, true); }
    await board.reload(true);
  };
  const picked = shown.filter((e) => selected.has(e.key));
  const bulk = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); say(done); setSelected(new Set()); } catch (err) { say((err as Error).message, true); } await reload(); };
  const toggle = (keys: string[]) => { const s = new Set(selected); const allOn = keys.every((k) => s.has(k)); for (const k of keys) if (allOn) s.delete(k); else s.add(k); setSelected(s); };

  /* ── What each lane needs on the truck (from the load sheet; hidden without Chemical Tracking access) ── */
  const loadOf = (events: DEvent[]) => {
    const stops = load.data?.groups.flatMap((g) => g.stops) ?? [];
    const totals = new Map<string, { product: string; unit: string; amount: number }>();
    const spray = new Map<string, number>();
    for (const e of events) {
      const s = stops.find((x) => x.visitId === e.id);
      if (!s || e.status === "completed" || e.status === "skipped") continue;
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

  /* ── Map ── */
  const pins: MapPin[] = useMemo(() => {
    if (prefs.span !== "day") return [];
    const out: MapPin[] = shown.filter((e) => e.date === day && e.location?.lat != null).map((e) => {
      const lane = laneOf(e);
      return { key: e.key, lat: e.location!.lat!, lng: e.location!.lng!, label: lane.crew && e.route ? String(e.route.order).padStart(2, "0") : "", colors: [lane.color], selected: selected.has(e.key), dim: e.status === "completed" || e.status === "skipped", tip: `${e.customer?.name ?? e.title} · ${e.services[0]?.name ?? e.title} · ${lane.name}${e.status !== "open" ? ` · ${statusWord[e.status]}` : ""}` };
    });
    for (const w of waitRows) {
      if (w.property.lat == null || w.property.lng == null) continue;
      out.push({ key: `w:${w.id}`, lat: w.property.lat, lng: w.property.lng, label: "", colors: [GRAY], selected: false, kind: "waiting", tip: `Waiting list: ${w.customer.name} · ${w.service.name}${w.dueBy ? ` · due ${monthDay(w.dueBy)}` : ""}. Click to add it to a route.` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, day, prefs.span, selected, waitRows, lanes]);
  const lines: MapLine[] = useMemo(() => (b?.routes ?? []).filter((r) => r.date === day && r.crewId && prefs.span === "day").map((r) => {
    const pts: [number, number][] = r.geometry ?? [
      ...(r.start.kind !== "none" && r.start.lat != null && r.start.lng != null ? [[r.start.lat, r.start.lng] as [number, number]] : []),
      ...r.stops.map((s) => byKey.get(s.key)?.location).filter((l): l is NonNullable<DEvent["location"]> => l?.lat != null && l.lng != null).map((l) => [l.lat!, l.lng!] as [number, number]),
      ...(r.end.kind !== "none" && r.end.lat != null && r.end.lng != null ? [[r.end.lat, r.end.lng] as [number, number]] : []),
    ];
    return { id: r.id, color: b?.crews.find((c) => c.id === r.crewId)?.color ?? GRAY, points: pts, dashed: !r.geometry };
  }), [b, day, byKey, prefs.span]);
  const flags: MapFlag[] = b?.start ? [{ key: "shop", lat: b.start.lat, lng: b.start.lng, label: `Shop: ${b.start.address}`, kind: "both" }] : [];

  if (!loaded) return <div className="dp dp-page" />;
  const days = prefs.span === "week" ? Array.from({ length: 7 }, (_, i) => plusDays(from, i)) : [day];
  const inRange = shown.filter((e) => days.includes(e.date));
  const done = inRange.filter((e) => e.status === "completed").length;
  const showWaiting = prefs.span === "day" && (prefs.waiting || prefs.mapCodes.length > 0);

  const card = (e: DEvent, lane: PLane, eta: { at: number; off: "late" | "early" | null } | undefined, leg: Leg | null | undefined, compact = false) => {
    const numbered = !!lane.crew && !!e.route;
    const before = !!drag && drag !== e.key && over?.before === e.key && over.lane === lane.id && over.date === e.date;
    return (
      <div key={e.key} className={`dp-card s-${e.status}${selected.has(e.key) ? " sel" : ""}${before ? " drop-before" : ""}${drag === e.key ? " dragging" : ""}${compact ? " compact" : ""}`} draggable
        onDragStart={(ev) => { setDrag(e.key); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", e.key); }} onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={(ev) => { if (drag) { ev.preventDefault(); ev.stopPropagation(); hover(lane.id, e.date, e.key); } }}
        onDrop={(ev) => { ev.preventDefault(); ev.stopPropagation(); drop(lane, e.date); }}
        onClick={() => toggle([e.key])} title={compact ? [e.customer?.name, e.services[0]?.name ?? e.title, e.location?.address, e.estMinutes != null ? `${e.estMinutes} min` : null].filter(Boolean).join(" · ") : undefined}>
        <span className="dp-num" style={{ background: lane.color }}>{numbered ? e.route!.order : "–"}</span>
        <div className="dp-card-body">
          <div className="dp-card-top">
            <strong>{e.customer?.name ?? e.title}</strong>
            {e.status !== "open" && <span className={`dp-status s-${e.status}`}>{statusWord[e.status]}</span>}
            {!compact && <NotesButton e={e} onAdded={() => board.reload(true)} />}
          </div>
          {compact ? <div className="dp-line muted">{e.services[0]?.name ?? e.title}</div> : (
            <>
              <div className="dp-line">{e.services[0]?.name ?? e.title}{e.services.length > 1 ? ` +${e.services.length - 1}` : ""} · {e.estMinutes != null ? `${e.estSource === "size" || e.estSource === "history" ? "~" : ""}${e.estMinutes} min` : e.budgetedHours ? hoursText(e.budgetedHours) : "no time yet"}{e.sqFt ? ` · ${Math.round(e.sqFt).toLocaleString()} sq ft` : ""}</div>
              <div className="dp-line muted">{e.location?.address ?? "No address"}{e.location?.mapCode ? ` · MC ${e.location.mapCode}` : ""}</div>
              {(numbered || e.windowStart || e.startTime || e.pets || e.notifyBefore !== "none" || e.priority === "high" || e.location?.lat == null) && (
                <div className="dp-badges">
                  {numbered && e.status === "open" && eta && <span className={`dp-badge${eta.off === "late" ? " bad" : ""}`} title={eta.off === "late" ? "Reached after its time window" : eta.off === "early" ? "Reached before its time window opens" : "About when the crew gets here"}>{leg ? `${Math.max(1, Math.round(leg.seconds / 60))} min drive · ` : ""}about {clock12(eta.at)}{eta.off === "late" ? " · late" : eta.off === "early" ? " · early" : ""}</span>}
                  {(e.windowStart || e.startTime) && <span className="dp-badge">{windowText(e)}</span>}
                  {e.priority === "high" && <span className="dp-badge warn">High priority</span>}
                  {e.pets && /\bdogs?\b/i.test(e.pets) && <span className="dp-badge" title={e.pets}>Dog</span>}
                  {e.notifyBefore === "text" && <span className="dp-badge">Text ahead</span>}
                  {e.notifyBefore === "call" && <span className="dp-badge">Call ahead</span>}
                  {e.location?.lat == null && <span className="dp-badge warn" title="This address isn't on the map yet, so it isn't counted in the drive">Not on the map</span>}
                </div>
              )}
            </>
          )}
        </div>
        {!compact && (
          <div className="dp-card-side">
            {numbered && <button type="button" className={`dp-lock${e.route!.locked ? " on" : ""}`} aria-pressed={e.route!.locked} aria-label={e.route!.locked ? "Locked in place" : "Lock in place"} title={e.route!.locked ? "Locked at this place in the route. Click to free it." : "Lock this stop at this place: Optimize orders the others around it."} onClick={(ev) => { ev.stopPropagation(); toggleLock(e); }}><Ico name="lock" size={14} /></button>}
            <Link className="dp-open" href={eventHref(e)} title="Open the work order" aria-label="Open the work order" onClick={(ev) => ev.stopPropagation()}><Icon name="right" size={14} /></Link>
          </div>
        )}
      </div>
    );
  };

  const lane = (l: PLane, date: string, compact = false) => {
    const events = cell(l, date);
    const everything = filtered ? all(l, date) : events;
    const r = l.crew ? routeOf(l.crew.id, date) : undefined;
    const plan = r ? dayOf({ keys: r.stops.map((s) => s.key), legs: r.stops.map((s) => s.leg), endLeg: r.endLeg, startTime: r.startTime, byKey }) : null;
    const onSite = everything.reduce((s, e) => s + eventHours(e), 0);
    const driving = (r?.totalDriveSeconds ?? 0) / 3600;
    const used = onSite + driving;
    const overBy = l.capacity != null ? used - l.capacity : 0;
    const isOver = !!drag && over?.lane === l.id && over.date === date;
    const dragged = drag ? byKey.get(drag) : undefined;
    const joining = isOver && dragged && !(laneKeyOf(dragged) === l.id && dragged.date === date) ? dragged : null;
    const fresh = isOver && hint && hint.id === `${drag}|${over!.lane}|${over!.date}|${over!.before}` ? hint.p : null;
    const after = fresh ? dayOf({ keys: fresh.keys, legs: fresh.stops.map((s) => s.leg), endLeg: fresh.endLeg, startTime: r?.startTime ?? "08:00", byKey }) : null;
    const afterHours = fresh ? fresh.keys.reduce((s, k) => s + (byKey.get(k) ? eventHours(byKey.get(k)!) : 0), 0) + fresh.totalDriveSeconds / 3600 : joining ? used + eventHours(joining) : null;
    const sqFt = events.reduce((s, e) => s + (e.sqFt ?? 0), 0);
    const finished = events.filter((e) => e.status === "completed").length;
    const needs = !compact && l.kind !== "none" ? loadOf(events) : null;
    const isBusy = busyLane === `${l.id}|${date}` || busyLane === "all";
    const unordered = !!l.crew && events.some((e) => !e.route);
    const pct = (h: number) => `${Math.min(100, l.capacity && l.capacity > 0 ? (h / l.capacity) * 100 : 100)}%`;
    return (
      <section key={`${l.id}|${date}`} className={`dp-lane k-${l.kind}${compact ? " compact" : ""}${!compact && !events.length ? " dp-slim" : ""}${isOver ? " over" : ""}${isBusy ? " busy" : ""}`} aria-label={`${l.name}, ${dateLabel(date)}`}
        onDragOver={(ev) => { if (drag) { ev.preventDefault(); hover(l.id, date, null); } }} onDrop={(ev) => { ev.preventDefault(); drop(l, date); }}>
        {!compact && (
          <header className="dp-lane-head" style={{ borderTopColor: l.color }}>
            <div className="dp-lane-title">
              <span className="dp-dot" style={{ background: l.color }} /><strong>{l.name}</strong>
              {l.crew && events.length > 1 && <button type="button" className="linkbtn" disabled={isBusy} title="Order the stops to keep driving shortest, from the shop and back. Locked stops keep their place." onClick={() => optimize(l, date)}>Optimize</button>}
              {l.kind !== "people" && events.some((e) => e.status === "open") && <button type="button" className="linkbtn" title="Rain or wind: move this lane's open work to another day or back to the waiting list" onClick={() => setRain({ who: l.crew?.id ?? "none" })}>Rain day</button>}
            </div>
            {l.sub && <div className="dp-lane-sub">{l.sub}</div>}
            <div className="dp-lane-sub">{events.length} stop{events.length === 1 ? "" : "s"}{sqFt ? ` · ${Math.round(sqFt).toLocaleString()} sq ft` : ""}{finished ? ` · ${finished} done` : ""}{filtered && everything.length !== events.length ? ` · ${everything.length - events.length} hidden by the filters` : ""}</div>
            {l.capacity != null ? (
              <>
                <div className={`dp-meter${(afterHours ?? used) > l.capacity + 0.05 ? " over" : ""}`}><span style={{ width: pct(used) }} />{afterHours != null && afterHours > used && <i style={{ left: pct(used), width: `calc(${pct(afterHours)} - ${pct(used)})` }} />}</div>
                {afterHours != null && (joining || fresh) ? (
                  <div className={`dp-lane-hours${afterHours > l.capacity + 0.05 ? " over" : ""}`}>
                    {joining ? <>Adds {Math.round(eventHours(joining) * 60)} min on site{fresh ? ` and ${Math.max(0, Math.round((fresh.totalDriveSeconds - (r?.totalDriveSeconds ?? 0)) / 60))} min of driving` : ""}: </> : <>In this order: </>}
                    <b>{hoursText(afterHours)}</b> of {hoursText(l.capacity)}{afterHours > l.capacity + 0.05 ? `, over by ${hoursText(afterHours - l.capacity)}` : ""}{!fresh && l.crew ? " (working out the drive…)" : ""}
                    {after && after.late.length > 0 && <div className="dp-late">Past their time window: {after.late.map((e) => `${e.customer?.name ?? e.title} (about ${clock12(after.eta.get(e.key)!.at)}, wanted ${windowText(e)})`).join("; ")}</div>}
                  </div>
                ) : (
                  <div className={`dp-lane-hours${overBy > 0.05 ? " over" : ""}`}>{everything.length ? <>{hoursText(onSite)} on site{r ? ` + ${hoursText(driving)} drive` : ""} = <b>{hoursText(used)}</b> of {hoursText(l.capacity)}{overBy > 0.05 ? ` · over by ${hoursText(overBy)}` : ""}</> : <>{hoursText(l.capacity)} free</>}</div>
                )}
                {plan && r && !joining && <div className="dp-lane-sub">Leaves {clock12(minutesOf(r.startTime))} · back about {clock12(plan.t.endAt)}{r.measured === "estimate" ? " · drive times estimated" : ""}{plan.late.length ? <span className="dp-late"> · {plan.late.length} past {plan.late.length === 1 ? "its" : "their"} time window</span> : null}</div>}
                {unordered && !joining && <div className="dp-lane-sub warn">Some stops aren't in route order yet: drag them into place, or Optimize.</div>}
              </>
            ) : <div className="dp-lane-hours">{l.kind === "none" ? (events.length ? `${hoursText(onSite)} waiting for a crew` : "") : `${hoursText(onSite)} on site`}</div>}
            {b?.holidays[date] && <div className="dp-lane-sub warn">{b.holidays[date]}</div>}
            {needs && (needs.products.length > 0 || needs.spray.length > 0) && (
              <details className="dp-load"><summary>To load: {needs.spray.length ? needs.spray.map(([m, gal]) => `${Math.round(gal).toLocaleString()} gal ${m.toLowerCase()}`).join(", ") : `${needs.products.length} product${needs.products.length === 1 ? "" : "s"}`}</summary>
                <ul>{needs.products.map((p) => <li key={p.product + p.unit}>{p.product} <b>{p.amount >= 10 ? Math.round(p.amount).toLocaleString() : trim1(p.amount)} {p.unit}</b></li>)}</ul>
              </details>
            )}
          </header>
        )}
        {compact && <div className={`dp-cell-sum${overBy > 0.05 ? " over" : ""}`}>{events.length ? `${events.length} stop${events.length === 1 ? "" : "s"} · ${hoursText(used)}${l.capacity != null ? ` of ${hoursText(l.capacity)}` : ""}` : ""}</div>}
        <div className="dp-lane-body">
          {events.map((e) => card(e, l, plan?.eta.get(e.key), r?.stops.find((s) => s.key === e.key)?.leg, compact))}
          {!events.length && !compact && <div className="dp-none">{filtered ? "Nothing here matches the filters." : l.kind === "none" ? "Everything has a crew." : "Nothing yet. Drag work orders here."}</div>}
        </div>
      </section>
    );
  };

  return (
    <div className={`dp dp-page view-${prefs.span === "week" ? "week" : prefs.view}`}>
      <div className="dp-head">
        <div>
          <h1>Dispatch</h1>
          <p className="muted">{prefs.span === "week" ? `${dateLabel(from)} to ${dateLabel(to)}` : dateLabel(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}{b ? ` · ${inRange.length} stop${inRange.length === 1 ? "" : "s"}${done ? `, ${done} done` : ""}${prefs.span === "week" ? ` · ${workDays(from, to, b.holidays)} working days` : ""}` : ""}{prefs.span === "day" && b?.holidays[day] ? ` · ${b.holidays[day]}` : ""}{todos ? <> · <Link href="/calendar">{todos} to-do{todos === 1 ? "" : "s"}</Link></> : null}</p>
        </div>
        <div className="dp-controls">
          <button type="button" className="btn" aria-label={prefs.span === "week" ? "The week before" : "The day before"} onClick={() => setPrefs({ date: plusDays(day, prefs.span === "week" ? -7 : -1) })}><Icon name="left" size={14} /></button>
          <input type="date" className="dp-date" value={day} onChange={(e) => e.target.value && setPrefs({ date: e.target.value })} aria-label="Day" />
          <button type="button" className="btn" aria-label={prefs.span === "week" ? "The week after" : "The day after"} onClick={() => setPrefs({ date: plusDays(day, prefs.span === "week" ? 7 : 1) })}><Icon name="right" size={14} /></button>
          <button type="button" className="btn" disabled={day === today} onClick={() => setPrefs({ date: null })}>Today</button>
          <div className="dp-seg" role="group" aria-label="Days shown">{(["day", "week"] as const).map((s) => <button key={s} type="button" aria-pressed={prefs.span === s} className={prefs.span === s ? "on" : ""} onClick={() => setPrefs({ span: s })}>{s === "day" ? "Day" : "Week"}</button>)}</div>
          {prefs.span === "day" && <div className="dp-seg" role="group" aria-label="View">{(["board", "split", "map"] as const).map((v) => <button key={v} type="button" aria-pressed={prefs.view === v} className={prefs.view === v ? "on" : ""} onClick={() => setPrefs({ view: v })}>{v === "board" ? "Board" : v === "split" ? "Board + map" : "Map"}</button>)}</div>}
        </div>
      </div>
      <div className="dp-tools">
        <Popover open={mcOpen} setOpen={setMcOpen} label={<>Map Code{prefs.mapCodes.length ? `: ${prefs.mapCodes.join(", ")}` : ""} ▾</>}>
          <div className="cl-menu dp-mc">
            {mapCodes.length ? mapCodes.map((mc) => (
              <label key={mc}><input type="checkbox" checked={prefs.mapCodes.includes(mc)} onChange={(e) => setPrefs({ mapCodes: e.target.checked ? [...prefs.mapCodes, mc] : prefs.mapCodes.filter((x) => x !== mc) })} /> MC {mc} <span className="muted">({visits.filter((e) => e.location?.mapCode === mc && days.includes(e.date)).length})</span></label>
            )) : <p className="muted">No Map Codes on these work orders.</p>}
            {prefs.mapCodes.length > 0 && <button type="button" onClick={() => { setPrefs({ mapCodes: [] }); setMcOpen(false); }}>Show every Map Code</button>}
          </div>
        </Popover>
        <input className="dp-search" type="search" placeholder="Find a customer, address or service" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find" />
        <span style={{ flex: 1 }} />
        {prefs.span === "day" && lanes.some((l) => l.crew && all(l, day).length > 1) && <button type="button" className="btn" disabled={busyLane === "all"} title="Order every crew's stops to keep driving shortest, from the shop and back. Locked stops keep their place." onClick={optimizeAll}>{busyLane === "all" ? "Ordering…" : "Optimize every route"}</button>}
        {prefs.span === "day" && visits.some((e) => e.status === "open" && e.date === day) && <button type="button" className="btn" onClick={() => setRain({ who: "all" })}>Rain or wind day…</button>}
        {prefs.span === "day" && <button type="button" className={`btn${showWaiting ? " on" : ""}`} aria-pressed={showWaiting} title="Show the waiting list beside the lanes" onClick={() => setPrefs({ waiting: !prefs.waiting })}>Waiting list{b?.waiting ? ` (${b.waiting})` : ""}</button>}
        <Link className="btn" href="/dispatch-beta" title="The other dispatch board, a copy of Homeworks' New Dispatch">New Dispatch <span className="nav-badge">Beta</span></Link>
      </div>
      {board.error && <div className="alert bad">{board.error}</div>}
      {notice && <div className={`alert ${notice.bad ? "bad" : "ok"} row`} style={{ justifyContent: "space-between" }} role="status"><span>{notice.text}</span><button type="button" className="linkbtn" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {picked.length > 0 && (
        <div className="dp-selbar">
          <strong>{picked.length} selected</strong>
          <span className="muted">{hoursText(picked.reduce((s, e) => s + eventHours(e), 0))} on site · {Math.round(picked.reduce((s, e) => s + (e.sqFt ?? 0), 0)).toLocaleString()} sq ft</span>
          <Popover open={moveOpen} setOpen={setMoveOpen} label="Give to a crew ▾">
            <div className="cl-menu">
              {(b?.crews ?? []).map((c) => <button key={c.id} type="button" onClick={() => { setMoveOpen(false); bulk(() => dispatchApi.assign(picked.map((e) => e.key), { crewId: c.id }), `${picked.length} given to ${c.name}. Drag them into route order, or Optimize.`); }}><span className="dp-dot" style={{ background: c.color }} /> {c.name}</button>)}
              <button type="button" onClick={() => { setMoveOpen(false); bulk(() => dispatchApi.assign(picked.map((e) => e.key), {}), `${picked.length} back to No crew yet.`); }}>No crew yet</button>
            </div>
          </Popover>
          <label className="dp-moveday">Move to <input type="date" min={today} value="" onChange={(e) => { const d = e.target.value; if (d) bulk(() => dispatchApi.reschedule(picked.map((x) => x.key), d), `${picked.length} moved to ${dateLabel(d)}.`); }} /></label>
          <button type="button" className="btn" onClick={() => bulk(() => dispatchApi.toWaitlist(picked.map((e) => e.key), "keep"), `${picked.length} back on the waiting list.`)}>Back to the waiting list</button>
          <button type="button" className="linkbtn" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="dp-body">
        {!b && !board.error ? <p className="muted" style={{ padding: 16 }}>Loading the board…</p> : prefs.span === "week" ? (
          <div className="dp-week" style={{ gridTemplateColumns: "minmax(120px, 160px) repeat(7, minmax(140px, 1fr))" }}>
            <div className="dp-week-corner" />
            {days.map((d) => <button key={d} type="button" className={`dp-week-day${d === today ? " today" : ""}`} title="Open this day" onClick={() => setPrefs({ span: "day", date: d })}>{dateLabel(d)}{b?.holidays[d] ? <small>{b.holidays[d]}</small> : null}</button>)}
            {lanes.map((l) => [
              <div key={`n${l.id}`} className="dp-week-crew"><span><span className="dp-dot" style={{ background: l.color }} /> <strong>{l.name}</strong></span>{l.capacity != null && <small className="muted">{hoursText(l.capacity)} a day</small>}</div>,
              ...days.map((d) => lane(l, d, true)),
            ])}
          </div>
        ) : (
          <>
            {prefs.view !== "map" && (
              <div className="dp-lanes">
                {showWaiting && (
                  <section className="dp-lane k-waiting" aria-label="Waiting list">
                    <header className="dp-lane-head" style={{ borderTopColor: GRAY }}>
                      <div className="dp-lane-title"><span className="dp-dot hollow" /><strong>Waiting list</strong><Link href="/waitlist">Open</Link></div>
                      <div className="dp-lane-sub">{waiting.loading && !waiting.data ? "Loading…" : `${waitRows.length} waiting${prefs.mapCodes.length ? ` in MC ${prefs.mapCodes.join(", ")}` : ""}${find ? " matching" : ""}`}</div>
                      <div className="dp-lane-sub">Drag one onto a crew, or click Add.</div>
                    </header>
                    <div className="dp-lane-body">
                      {waitRows.slice(0, WAITING_MAX).map((w) => (
                        <div key={w.id} className={`dp-card waiting${drag === `w:${w.id}` ? " dragging" : ""}`} draggable={!w.needsCard} onDragStart={(ev) => { setDrag(`w:${w.id}`); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", w.id); }} onDragEnd={() => { setDrag(null); setOver(null); }}>
                          <div className="dp-card-body">
                            <div className="dp-card-top"><strong>{w.customer.name}</strong></div>
                            <div className="dp-line">{w.service.name}{w.estMinutes ? ` · ~${w.estMinutes} min` : ""}{w.property.sqFt ? ` · ${Math.round(w.property.sqFt).toLocaleString()} sq ft` : ""}</div>
                            <div className="dp-line muted">{w.property.address}{w.property.mapCode ? ` · MC ${w.property.mapCode}` : ""}</div>
                            <div className="dp-badges">
                              {w.dueBy && <span className={`dp-badge${w.dueBy < day ? " bad" : ""}`}>Due {monthDay(w.dueBy)}</span>}
                              {w.eligible && w.eligible > day && <span className="dp-badge warn">Not before {monthDay(w.eligible)}</span>}
                              {w.priority === "high" && <span className="dp-badge warn">High priority</span>}
                              {w.needsCard && <span className="dp-badge bad">Needs a card on file</span>}
                            </div>
                          </div>
                          <div className="dp-card-side"><button type="button" className="btn sm" disabled={w.needsCard} onClick={() => setAdding({ row: w, crewId: null })}>Add</button></div>
                        </div>
                      ))}
                      {waitRows.length > WAITING_MAX && <div className="dp-none">And {waitRows.length - WAITING_MAX} more. Filter by Map Code, or open the <Link href="/waitlist">waiting list</Link>.</div>}
                      {!waitRows.length && waiting.data && <div className="dp-none">Nothing waiting{filtered ? " that matches the filters" : ""}.</div>}
                    </div>
                  </section>
                )}
                {lanes.map((l) => lane(l, day))}
              </div>
            )}
            {prefs.view !== "board" && (
              <div className="dp-mapwrap dx">
                <DispatchMap ref={mapRef} pins={pins} lines={lines} flags={flags} areas={[]} trucks={[]} addressPin={null} showNumbers satellite={false} fitKey={`${day}|${prefs.mapCodes.join()}|${prefs.view}|${b ? 1 : 0}`}
                  lasso={false} onLasso={() => {}} drawing={null} onDrawPoint={() => {}} picking={false} onPick={() => {}}
                  onPin={(keys) => {
                    const w = keys.find((k) => k.startsWith("w:"));
                    const row = w ? waiting.data?.rows.find((r) => r.id === w.slice(2)) : undefined;
                    if (row) { if (row.needsCard) say(`${row.customer.name} needs a card on file before this can be scheduled.`, true); else setAdding({ row, crewId: null }); return; }
                    toggle(keys.filter((k) => !k.startsWith("w:")));
                  }}>
                  <div className="dx-map-tools br">
                    <button type="button" className="dx-map-btn" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Ico name="plus" size={16} /></button>
                    <button type="button" className="dx-map-btn" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Ico name="minus" size={16} /></button>
                    <button type="button" className="dx-map-btn" aria-label="Fit the map to the stops" title="Fit the map to the stops" onClick={() => mapRef.current?.fit()}><Ico name="fit" size={16} /></button>
                  </div>
                  <div className="dp-map-key">
                    {lanes.filter((l) => shown.some((e) => e.date === day && laneKeyOf(e) === l.id)).map((l) => <span key={l.id}><i style={{ background: l.color }} />{l.name}</span>)}
                    {waitRows.length > 0 && <span><i className="waiting" />Waiting list ({waitRows.length})</span>}
                  </div>
                </DispatchMap>
              </div>
            )}
          </>
        )}
      </div>

      {rain && b && <RainDay board={b} date={day} who={rain.who} onClose={() => setRain(null)} onDone={(text) => { setRain(null); say(text); reload(); }} />}
      {adding && b && <AddWaiting row={adding.row} crewId={adding.crewId} board={b} date={day} laneKeys={(crewId) => { const l = lanes.find((x) => x.crew?.id === crewId); return l ? all(l, day).map((e) => e.key) : []; }} onClose={() => setAdding(null)} onDone={(text) => { setAdding(null); say(text); reload(); }} />}
    </div>
  );
}

/** Rain or wind day: a crew's, or the whole day's, open work goes to another day or back to the waiting list. */
function RainDay({ board, date, who: first, onClose, onDone }: { board: Board; date: string; who: string; onClose: () => void; onDone: (text: string) => void }) {
  const [who, setWho] = useState(first);
  const [to, setTo] = useState<"waitlist" | "next">("next");
  const [reason, setReason] = useState<(typeof BACK_REASONS)[number]>("rain");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const next = useApi<{ date: string }>(`/dispatch/next-working-day?after=${date}`);
  const [toDate, setToDate] = useState("");
  useEffect(() => { if (next.data && !toDate) setToDate(next.data.date); }, [next.data, toDate]);
  const { busy, error, run } = useAction();
  const open = board.events.filter((e) => e.kind === "visit" && e.date === date && e.status === "open" && (who === "all" || (who === "none" ? !e.crewId : e.crewId === who)));
  const customers = (kind: string) => new Set(open.filter((e) => e.notifyBefore === kind && e.customer).map((e) => e.customer!.id)).size;
  const texts = customers("text"), calls = customers("call");
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cal-modal card stack dp-modal" role="dialog" aria-modal="true" aria-label="Rain or wind day">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Rain or wind day</h2><button type="button" className="btn sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></div>
        <p className="muted" style={{ margin: 0 }}>Moves the open work orders on {dateLabel(date, { weekday: "long", month: "long", day: "numeric" })} in one step. Ones already started, done or skipped stay where they are.</p>
        <label>Whose work
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">The whole day</option>
            {board.crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="none">No crew yet</option>
          </select>
        </label>
        <fieldset className="dp-radio">
          <legend>Where it goes</legend>
          <label><input type="radio" name="dp-rain-to" checked={to === "next"} onChange={() => setTo("next")} /> <span>To another day</span> <input type="date" value={toDate} min={plusDays(date, 1)} disabled={to !== "next"} onChange={(e) => setToDate(e.target.value)} aria-label="The day to move to" />{next.data && toDate === next.data.date && <span className="muted">the next working day</span>}</label>
          <label><input type="radio" name="dp-rain-to" checked={to === "waitlist"} onChange={() => setTo("waitlist")} /> <span>Back to the waiting list</span></label>
        </fieldset>
        <div className="formgrid">
          <label>Why<select value={reason} onChange={(e) => setReason(e.target.value as (typeof BACK_REASONS)[number])}>{BACK_REASONS.map((r) => <option key={r} value={r}>{BACK_REASON_LABELS[r]}</option>)}</select></label>
          <label>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Gusts over 20 mph" /></label>
        </div>
        <label className="dp-check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> <span>Tell the customers who asked to hear ahead ({texts} to text{calls ? `, ${calls} to call, listed for you` : ""})</span></label>
        <p style={{ margin: 0 }}><strong>{open.length}</strong> work order{open.length === 1 ? "" : "s"} will move. Who does them stays the same; they come off their routes.</p>
        {error && <div className="alert bad">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !open.length || (to === "next" && !toDate)} onClick={() => run(async () => {
            const r = await dispatchApi.rain({ date, crewId: who, to, ...(to === "next" ? { toDate } : {}), reason, note, notify });
            onDone(`${r.moved} work order${r.moved === 1 ? "" : "s"} moved ${r.to ? `to ${dateLabel(r.to)}` : "back to the waiting list"}.${notify ? ` ${r.texted} customer${r.texted === 1 ? "" : "s"} texted.${r.notTexted ? ` ${r.notTexted} couldn't be texted${r.texted === 0 ? " (is texting connected?)" : ""}.` : ""}${r.toCall.length ? ` To call: ${r.toCall.join(", ")}.` : ""}` : ""}`);
          })}>{busy ? "Moving…" : `Move ${open.length}`}</button>
        </div>
      </div>
    </div>
  );
}

/** A waiting-list service picked from the map or the waiting lane: put it on the day, at the end of a crew's route. */
function AddWaiting({ row, crewId: first, board, date, laneKeys, onClose, onDone }: { row: WaitRow; crewId: string | null; board: Board; date: string; laneKeys: (crewId: string) => string[]; onClose: () => void; onDone: (text: string) => void }) {
  const [crewId, setCrewId] = useState(first ?? row.preferredCrewId ?? board.crews[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const early = !!row.eligible && date < row.eligible;
  const { busy, error, run } = useAction();
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cal-modal card stack dp-modal" role="dialog" aria-modal="true" aria-label="Add to a route">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Add to {dateLabel(date)}</h2><button type="button" className="btn sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></div>
        <p style={{ margin: 0 }}><strong>{row.customer.name}</strong> · {row.service.name}<br /><span className="muted">{row.property.address}{row.property.mapCode ? ` · MC ${row.property.mapCode}` : ""}{row.estMinutes ? ` · about ${row.estMinutes} min` : ""}{row.dueBy ? ` · due by ${monthDay(row.dueBy)}` : ""}</span></p>
        <label>Crew
          <select value={crewId} onChange={(e) => setCrewId(e.target.value)}>
            {board.crews.map((c) => <option key={c.id} value={c.id}>{c.name}{row.preferredCrewId === c.id ? " (preferred)" : ""}</option>)}
            <option value="">No crew yet</option>
          </select>
        </label>
        {early && <label>It isn't eligible until {monthDay(row.eligible!)} (the minimum days since the last service). Why is it OK to do it early?<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>}
        {error && <div className="alert bad">{error}</div>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || (early && !reason.trim())} onClick={() => run(async () => {
            await api("/waitlist/schedule", { body: { visitIds: [row.id], date, crewId: crewId || null, ...(early ? { earlyReason: reason.trim() } : {}) } });
            if (crewId) await dispatchApi.lane(date, crewId, [...laneKeys(crewId), `v:${row.id}`]);
            onDone(`${row.customer.name} added${crewId ? ` to the end of ${board.crews.find((c) => c.id === crewId)?.name}'s route` : ""}.`);
          })}>{busy ? "Adding…" : "Add to the day"}</button>
        </div>
      </div>
    </div>
  );
}

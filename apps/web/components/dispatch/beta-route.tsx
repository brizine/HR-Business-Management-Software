"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DISPATCH_ROUTE_MAX, ETA_WINDOWS, ETA_WINDOW_LABELS, clockText, etaText, legText, milesText, routeTimeline, type EtaWindow, type Leg } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { assignmentText, dateLabel, dispatchApi, eventHours, hoursBoth, monthDay, plusDays, time12, trim1, type Board, type DEvent, type DRoute, type Preview } from "./data";
import { Check, Dialog, Ico, MenuItem, MiniCal, Pop, anchorOf } from "./beta-parts";
import { pad2 } from "./beta-dialogs";

/* Route ordering on the beta board: pick stops, set where the route starts and ends, order them, save. */

export type PointChoice = { kind: "company" | "crew" | "employee" | "custom" | "none"; label?: string | null; lat?: number | null; lng?: number | null };
export type Draft = { id?: string; date: string; keys: string[]; start: PointChoice; end: PointChoice; startTime: string; pinnedFirst: boolean; dirty: boolean; optimized: boolean };

const asChoice = (p: DRoute["start"]): PointChoice => (p.kind === "none" ? { kind: "none" } : p.kind === "company" ? { kind: "company" } : { kind: p.kind as PointChoice["kind"], label: p.label, lat: p.lat, lng: p.lng });

/** The route being built: its stops in order, its ends, and each drive measured as it changes. */
export function useRouteDraft(o: { board: Board | null; toast: (text: string, bad?: boolean) => void; defaults: { start: PointChoice; end: PointChoice; startTime: string }; onDefaults: (d: { start: PointChoice; end: PointChoice; startTime: string }) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [working, setWorking] = useState(false);
  const shape = draft ? `${draft.date}|${draft.keys.join(",")}|${JSON.stringify(draft.start)}|${JSON.stringify(draft.end)}` : "";
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    if (!draft) { setPreview(null); return; }
    if (!draft.keys.length) { setPreview(null); return; }
    let off = false;
    setMeasuring(true);
    const timer = setTimeout(async () => {
      try {
        const p = await dispatchApi.preview({ date: draft.date, keys: draft.keys, start: draft.start, end: draft.end });
        if (!off) setPreview(p);
      } catch (e) {
        if (!off) latest.current.toast((e as Error).message, true);
      } finally {
        if (!off) setMeasuring(false);
      }
    }, 120);
    return () => { off = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const change = useCallback((patch: Partial<Draft>, keepOptimized = false) => setDraft((d) => (d ? { ...d, ...patch, dirty: true, optimized: keepOptimized ? d.optimized : false } : d)), []);
  const api2 = {
    draft, preview, measuring, working,
    /** A new route from the selection (stops already routed keep their saved order first), or a saved route reopened whole. */
    begin(keys: string[], date: string, route?: DRoute) {
      if (route) setDraft({ id: route.id, date: route.date, keys: route.stops.map((s) => s.key), start: asChoice(route.start), end: asChoice(route.end), startTime: route.startTime, pinnedFirst: route.pinnedFirst, dirty: false, optimized: false });
      else setDraft({ date, keys: keys.slice(0, DISPATCH_ROUTE_MAX), ...latest.current.defaults, pinnedFirst: false, dirty: true, optimized: false });
    },
    exit() { setDraft(null); },
    toggle(key: string) {
      if (!draft) return;
      if (draft.keys.includes(key)) change({ keys: draft.keys.filter((k) => k !== key), pinnedFirst: draft.pinnedFirst && draft.keys[0] !== key });
      else if (draft.keys.length >= DISPATCH_ROUTE_MAX) latest.current.toast(`A route is limited to ${DISPATCH_ROUTE_MAX} stops. Split it into smaller routes.`, true);
      else change({ keys: [...draft.keys, key] });
    },
    remove(key: string) { if (draft) change({ keys: draft.keys.filter((k) => k !== key), pinnedFirst: draft.pinnedFirst && draft.keys[0] !== key }); },
    move(from: number, to: number) {
      if (!draft || from === to) return;
      const lock = draft.pinnedFirst ? 1 : 0;
      if (from < lock || to < lock) return;
      const keys = draft.keys.slice();
      const [k] = keys.splice(from, 1);
      keys.splice(to, 0, k);
      change({ keys });
    },
    reverse() {
      if (!draft) return;
      const lock = draft.pinnedFirst ? 1 : 0;
      change({ keys: [...draft.keys.slice(0, lock), ...draft.keys.slice(lock).reverse()] });
    },
    /** Hold a stop as the first one: it can't be dragged, and Optimize and Reverse leave it there. */
    pin(key: string) {
      if (!draft) return;
      if (draft.pinnedFirst && draft.keys[0] === key) change({ pinnedFirst: false }, true);
      else change({ keys: [key, ...draft.keys.filter((k) => k !== key)], pinnedFirst: true });
    },
    setStart(start: PointChoice) { if (draft) { change({ start }); latest.current.onDefaults({ start, end: draft.end, startTime: draft.startTime }); } },
    setEnd(end: PointChoice) { if (draft) { change({ end }); latest.current.onDefaults({ start: draft.start, end, startTime: draft.startTime }); } },
    setStartTime(startTime: string) { if (draft) { change({ startTime }, true); latest.current.onDefaults({ start: draft.start, end: draft.end, startTime }); } },
    async optimize() {
      if (!draft || draft.keys.length < 2) return;
      setWorking(true);
      try {
        const p = await dispatchApi.preview({ date: draft.date, keys: draft.keys, start: draft.start, end: draft.end, optimize: true, pinnedFirst: draft.pinnedFirst });
        setDraft((d) => (d ? { ...d, keys: p.keys, dirty: true, optimized: true } : d));
        setPreview(p);
        latest.current.toast(`Optimized: ${clockText(p.totalDriveSeconds)} drive, ${milesText(p.totalMeters)} mi, ${p.keys.length} stop${p.keys.length === 1 ? "" : "s"}`);
      } catch { latest.current.toast("Failed to optimize route. Nothing changed; try again.", true); } finally { setWorking(false); }
    },
    async save(extra: { assign?: { crewId: string | null; employeeIds: string[] }; future?: { everyWeeks: number; assignments: "none" | "keep" | "replace" } } = {}) {
      if (!draft) return false;
      setWorking(true);
      try {
        const r = await dispatchApi.saveRoute({ id: draft.id, date: draft.date, keys: draft.keys, start: draft.start, end: draft.end, startTime: draft.startTime, pinnedFirst: draft.pinnedFirst, ...extra });
        latest.current.toast(extra.future ? `Route order saved for future weeks (${r.stops} stops${r.future ? `, ${r.future.days} more day${r.future.days === 1 ? "" : "s"}` : ""})` : `Route order saved (${r.stops} stop${r.stops === 1 ? "" : "s"})`);
        setDraft(null);
        return true;
      } catch (e) { latest.current.toast((e as Error).message || "Failed to save route order.", true); return false; } finally { setWorking(false); }
    },
  };
  return api2;
}
export type RouteDraftApi = ReturnType<typeof useRouteDraft>;

/** The yellow bar across the top while a route is being ordered. */
export function RouteBanner({ r, board, onExit, onAssignAll, onFuture }: { r: RouteDraftApi; board: Board; onExit: () => void; onAssignAll: () => void; onFuture: () => void }) {
  const [save, setSave] = useState<ReturnType<typeof anchorOf> | null>(null);
  const d = r.draft!;
  const n = d.keys.length;
  return (
    <div className="dx-bar dx-routebar">
      <button type="button" className="dx-icon-btn" aria-label="Exit order mode" onClick={onExit}><Ico name="x" /></button>
      <strong>{d.id ? "Edit route" : "Route"} {n} stop{n === 1 ? "" : "s"}</strong>
      {board.settings.routing === "estimate" && <span className="dx-muted dx-routebar-note" title="Turn on road routing under View → Routing and capacity for real road times and the line along the streets.">Drive times are estimates</span>}
      <span style={{ flex: 1 }} />
      <button type="button" className="dx-btn" disabled={!n} onClick={onAssignAll}><Ico name="users" /> Assign all ({n})</button>
      <button type="button" className="dx-btn" disabled={n < 2 || r.working || d.optimized} onClick={() => r.optimize()}><Ico name="sparkles" /> {d.optimized ? "Optimized" : r.working ? "Optimizing…" : "Optimize"}</button>
      <button type="button" className="dx-btn" disabled={n < 2} onClick={() => r.reverse()}><Ico name="updown" /> Reverse</button>
      <button type="button" className="dx-btn save" disabled={!n || r.working} onClick={(e) => setSave(anchorOf(e.currentTarget))}><Ico name="route" /> Save order <Ico name="down" size={14} /></button>
      <Pop at={save} onClose={() => setSave(null)} width={260} align="right">
        <MenuItem icon="check" onClick={() => { setSave(null); r.save(); }}>Save for {monthDay(d.date)}</MenuItem>
        <MenuItem icon="calendar" onClick={() => { setSave(null); onFuture(); }}>Save and apply to future weeks</MenuItem>
      </Pop>
    </div>
  );
}

/** Where the route starts or ends. Choices that can't be used stay visible, greyed out, with the reason. */
function PointPicker({ which, value, board, events, at, onClose, onPick, onMapPick }: { which: "start" | "end"; value: PointChoice; board: Board; events: DEvent[]; at: ReturnType<typeof anchorOf> | null; onClose: () => void; onPick: (p: PointChoice) => void; onMapPick: () => void }) {
  const [custom, setCustom] = useState(value.kind === "custom" ? value.label ?? "" : "");
  const { busy, error, run, setError } = useAction();
  const place = which === "start" ? board.start : board.end;
  const crews = [...new Set(events.map((e) => e.crewId))];
  const people = [...new Set(events.map((e) => (e.crewId ? "" : e.assigneeIds.join(","))))];
  const one = people.length === 1 && people[0] && !people[0].includes(",") ? board.people.find((p) => p.id === people[0]) : undefined;
  const crewWhy = crews.length > 1 ? "The stops belong to more than one crew" : !crews[0] ? "No crew assigned to these stops" : `No ${which} address set for ${board.crews.find((c) => c.id === crews[0])?.name ?? "this crew"}`;
  const empWhy = !one ? "Works when every stop is assigned to the same one employee" : !one.hasAddress ? "No address on file for this employee" : null;
  const Row = ({ kind, title, sub, disabled, onClick }: { kind: PointChoice["kind"]; title: string; sub: string; disabled?: boolean; onClick: () => void }) => (
    <button type="button" className={`dx-point${value.kind === kind ? " on" : ""}`} disabled={disabled || busy} onClick={onClick}>
      <strong>{title}</strong><span>{sub}</span>{value.kind === kind && <Ico name="check" />}
    </button>
  );
  return (
    <Pop at={at} onClose={onClose} width={340} className="pad">
      <div className="dx-pop-title">Route {which} location</div>
      <Row kind="company" title="Business address" sub={place?.address ?? "Add your business address under Settings → Company"} disabled={!place} onClick={() => { onPick({ kind: "company" }); onClose(); }} />
      <Row kind="crew" title="Crew location" sub={crewWhy} disabled onClick={() => {}} />
      <Row kind="employee" title={`Employee location${one ? `: ${one.name}` : ""}`} sub={empWhy ?? "Their home address on file"} disabled={!!empWhy}
        onClick={() => run(async () => { const p = await api<{ label: string; lat: number; lng: number }>(`/dispatch/employee-point/${one!.id}`); onPick({ kind: "employee", ...p }); onClose(); })} />
      <div className={`dx-point col${value.kind === "custom" ? " on" : ""}`}>
        <strong>Custom address</strong><span>Type an address or pick a point on the map</span>
        <form className="dx-point-form" onSubmit={(e) => { e.preventDefault(); if (!custom.trim()) return; run(async () => {
          try { const p = await api<{ label: string; lat: number; lng: number }>(`/dispatch/locate?q=${encodeURIComponent(custom.trim())}`); onPick({ kind: "custom", label: custom.trim(), lat: p.lat, lng: p.lng }); onClose(); } catch { setError("Couldn't find that address."); throw new Error("Couldn't find that address."); }
        }); }}>
          <input className="dx-input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Search an address…" aria-label="Custom address" />
          <button type="submit" className="dx-btn" disabled={busy || !custom.trim()}>Use</button>
          <button type="button" className="dx-btn" onClick={() => { onClose(); onMapPick(); }}>Pick on map</button>
        </form>
      </div>
      <Row kind="none" title={`No ${which} location`} sub={which === "start" ? "Route starts at its first stop" : "Route ends at its last stop"} onClick={() => { onPick({ kind: "none" }); onClose(); }} />
      {error && <p className="dx-error">{error}</p>}
    </Pop>
  );
}

/** The order list: a start row, each stop with the drive into it and when it's reached, and an end row. */
export function RouteList({ r, board, events, etaWindow, onEta, onMapPick, onStopAction }: {
  r: RouteDraftApi; board: Board; events: Map<string, DEvent>; etaWindow: EtaWindow; onEta: (w: EtaWindow) => void;
  onMapPick: (which: "start" | "end") => void; onStopAction: (e: DEvent, a: "view" | "zoom" | "reschedule" | "edit") => void;
}) {
  const d = r.draft!;
  const p = r.preview;
  const [picker, setPicker] = useState<{ which: "start" | "end"; at: ReturnType<typeof anchorOf> } | null>(null);
  const [menu, setMenu] = useState<{ key: string; at: ReturnType<typeof anchorOf> } | null>(null);
  const [eta, setEta] = useState<ReturnType<typeof anchorOf> | null>(null);
  const [timing, setTiming] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const stops = d.keys.map((k) => events.get(k)).filter((e): e is DEvent => !!e);
  const legs: (Leg | null)[] = d.keys.map((k) => p?.stops.find((s) => s.key === k)?.leg ?? null);
  const fresh = !!p && p.keys.join() === d.keys.join();
  const line = useMemo(() => routeTimeline({ startTime: d.startTime, minutes: stops.map((e) => Math.round(eventHours(e) * 60)), legs: fresh ? legs : legs.map(() => null), endLeg: fresh ? p?.endLeg ?? null : null }), [d.startTime, stops, legs, fresh, p]);
  const startText = d.start.kind === "none" ? "No start location" : p?.start?.label ?? board.start?.address ?? "Business address";
  const endText = d.end.kind === "none" ? "No end location" : p?.end?.label ?? board.end?.address ?? "Business address";
  const kindName = (k: PointChoice["kind"]) => ({ company: "Business address", crew: "Crew location", employee: "Employee location", custom: "Custom address", none: "" })[k];
  const open = menu ? events.get(menu.key) : undefined;
  return (
    <div className="dx-order" aria-busy={r.measuring}>
      <div className="dx-order-head"><span>#</span><span>Event Name</span><span>ETA</span><span>Assignment</span><span>Customer</span><span>Location</span><span className="num">BH</span><span /></div>
      <div className="dx-order-body">
        <div className="dx-order-end">
          <span className="dx-order-emoji">📍</span>
          <div>
            <strong>Start location</strong>
            {timing ? <input type="time" className="dx-input time" autoFocus defaultValue={d.startTime} onBlur={(e) => { if (/^\d\d:\d\d$/.test(e.target.value)) r.setStartTime(e.target.value); setTiming(false); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label="Route start time" />
              : <button type="button" className="dx-link plain" aria-label={`Route start time: ${time12(d.startTime)}. Click to edit`} onClick={() => setTiming(true)}>{time12(d.startTime)}</button>}
          </div>
          <button type="button" className="dx-eta-pick" aria-label={`ETA window: ${ETA_WINDOW_LABELS[etaWindow]}`} onClick={(e) => setEta(anchorOf(e.currentTarget))}>{ETA_WINDOW_LABELS[etaWindow]} <Ico name="down" size={12} /></button>
          <div className="dx-order-where"><span className="dx-muted">{kindName(d.start.kind)}</span><span>{startText}</span></div>
          <button type="button" className="dx-btn" aria-label="Change route start location" onClick={(e) => setPicker({ which: "start", at: anchorOf(e.currentTarget) })}>Edit</button>
        </div>
        {stops.map((e, i) => {
          const pinned = d.pinnedFirst && i === 0;
          const arrive = line.arrive[i];
          const due = e.windowStart ?? e.startTime;
          const late = due && fresh ? arrive > Number(due.slice(0, 2)) * 60 + Number(due.slice(3)) + (etaWindow > 0 ? etaWindow : 0) : false;
          return (
            <div key={e.key}>
              <div className="dx-leg"><Ico name="truck" size={14} />{fresh && legs[i] ? legText(legs[i]) : e.location?.lat == null ? "No location: not on the map, no drive time" : i === 0 && d.start.kind === "none" ? "Route starts here" : r.measuring ? "Measuring…" : ""}</div>
              <div className={`dx-order-row${drag === i ? " dragging" : ""}${over === i && drag !== null && drag !== i ? " over" : ""}`}
                draggable={!pinned} onDragStart={(ev) => { setDrag(i); ev.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDrag(null); setOver(null); }}
                onDragOver={(ev) => { if (drag !== null) { ev.preventDefault(); setOver(i); } }} onDrop={(ev) => { ev.preventDefault(); if (drag !== null) r.move(drag, i); setDrag(null); setOver(null); }}>
                <span className="dx-order-num">
                  <button type="button" className="dx-grip" aria-label={`Reorder stop ${i + 1}`} disabled={pinned} tabIndex={-1}><Ico name="grip" size={14} /></button>
                  <span className="dx-stop draft">{pad2(i + 1)}</span>
                </span>
                <span className="dx-order-name" title={e.title}>{e.title}</span>
                <span className="dx-order-eta">{etaText(arrive, etaWindow)}{late && <em title={`Planned for ${time12(due!)}`}>{etaWindow ? "~" : ""}Late</em>}</span>
                <span className="dx-cell-assign"><Ico name="user" size={14} />{assignmentText(e, board) || <span className="dx-muted">Unassigned</span>}</span>
                <span>{e.customer?.name ?? "—"}</span>
                <span title={e.location?.address}>{e.location?.address ?? "—"}</span>
                <span className="num">{trim1(eventHours(e))}</span>
                <span className="dx-order-acts">
                  <button type="button" className={`dx-icon-btn pinbtn${pinned ? " on" : ""}`} aria-label={pinned ? "Unpin as first stop" : "Pin as the route's first visit"} title={pinned ? "Unpin as first stop" : "Pin as the route's first visit"} onClick={() => r.pin(e.key)}><Ico name="pinTop" size={14} /></button>
                  <button type="button" className="dx-icon-btn" aria-label={`Stop ${i + 1} actions`} onClick={(ev) => setMenu({ key: e.key, at: anchorOf(ev.currentTarget) })}><Ico name="dots" /></button>
                </span>
              </div>
            </div>
          );
        })}
        {!stops.length && <div className="dx-order-empty">No stops yet. Click pins on the map to add them.</div>}
        {d.end.kind !== "none" && <div className="dx-leg"><Ico name="truck" size={14} />{fresh && p?.endLeg ? legText(p.endLeg) : ""}</div>}
        <div className="dx-order-end">
          <span className="dx-order-emoji">🏁</span>
          <div><strong>End location</strong><span>{stops.length ? etaText(line.endAt) : "—"}</span></div>
          <span />
          <div className="dx-order-where"><span className="dx-muted">{kindName(d.end.kind)}</span><span>{endText}</span></div>
          <button type="button" className="dx-btn" aria-label="Change route end location" onClick={(e) => setPicker({ which: "end", at: anchorOf(e.currentTarget) })}>Edit</button>
        </div>
      </div>
      <PointPicker key={picker?.which ?? "none"} which={picker?.which ?? "start"} value={picker?.which === "end" ? d.end : d.start} board={board} events={stops} at={picker?.at ?? null} onClose={() => setPicker(null)}
        onPick={(pt) => (picker?.which === "end" ? r.setEnd(pt) : r.setStart(pt))} onMapPick={() => onMapPick(picker?.which ?? "start")} />
      <Pop at={eta} onClose={() => setEta(null)} width={150}>
        {ETA_WINDOWS.map((w) => <MenuItem key={w} checked={w === etaWindow} onClick={() => { onEta(w); setEta(null); }}>{ETA_WINDOW_LABELS[w]}</MenuItem>)}
      </Pop>
      {open && (
        <Pop at={menu!.at} onClose={() => setMenu(null)} width={230} align="right">
          <MenuItem icon="pinTop" onClick={() => { r.pin(open.key); setMenu(null); }}>{d.pinnedFirst && d.keys[0] === open.key ? "Unpin as first stop" : "Pin as first stop"}</MenuItem>
          <MenuItem icon="down" disabled={d.keys.indexOf(open.key) >= d.keys.length - 1} onClick={() => { const i = d.keys.indexOf(open.key); r.move(i, i + 1); setMenu(null); }}>Increase stop order</MenuItem>
          <MenuItem icon="up" disabled={d.keys.indexOf(open.key) <= (d.pinnedFirst ? 1 : 0)} onClick={() => { const i = d.keys.indexOf(open.key); r.move(i, i - 1); setMenu(null); }}>Decrease stop order</MenuItem>
          <MenuItem icon="x" onClick={() => { r.remove(open.key); setMenu(null); }}>Remove from route</MenuItem>
          <hr />
          <MenuItem icon="eye" onClick={() => { setMenu(null); onStopAction(open, "view"); }}>View</MenuItem>
          <MenuItem icon="pin" disabled={open.location?.lat == null} onClick={() => { setMenu(null); onStopAction(open, "zoom"); }}>Zoom to location</MenuItem>
          <MenuItem icon="calendar" disabled={open.status === "completed"} onClick={() => { setMenu(null); onStopAction(open, "reschedule"); }}>Reschedule</MenuItem>
          <MenuItem icon="external" onClick={() => { setMenu(null); onStopAction(open, "edit"); }}>Edit (opens in a new tab)</MenuItem>
        </Pop>
      )}
    </div>
  );
}

/** The footer while ordering: stops, their hours, the drive, and the whole day. */
export function RouteFooter({ r, events }: { r: RouteDraftApi; events: Map<string, DEvent> }) {
  const d = r.draft!;
  const stops = d.keys.map((k) => events.get(k)).filter((e): e is DEvent => !!e);
  const hours = stops.reduce((s, e) => s + eventHours(e), 0);
  const p = r.preview && r.preview.keys.join() === d.keys.join() ? r.preview : null;
  const drive = p?.totalDriveSeconds ?? 0;
  return (
    <div className="dx-foot">
      <span><span className="dx-muted">Events</span> <strong>{stops.length}</strong></span>
      <span style={{ flex: 1 }} />
      <span><span className="dx-muted">BH</span> <strong>{hoursBoth(hours * 3600)}</strong></span>
      <span><span className="dx-muted">Drive time</span> <strong>{p ? `${pad2(Math.floor(drive / 3600))}:${pad2(Math.round((drive % 3600) / 60))} (${milesText(p.totalMeters)} mi)` : "…"}</strong></span>
      <span><span className="dx-muted">Total time</span> <strong>{p ? clockText(hours * 3600 + drive) : "…"}</strong></span>
    </div>
  );
}

/** "Save and apply to future weeks": how often, a calendar of the days that get the order, and whether assignments go too. */
export function FutureDialog({ r, board, events, today, onClose }: { r: RouteDraftApi; board: Board; events: Map<string, DEvent>; today: string; onClose: () => void }) {
  const d = r.draft!;
  const [every, setEvery] = useState("1");
  const [withPeople, setWithPeople] = useState(false);
  const [mode, setMode] = useState<"keep" | "replace">("keep");
  const [plan, setPlan] = useState<{ days: { date: string; stops: number; different: number }[]; repeating: number } | null>(null);
  const n = Number(every);
  const valid = /^\d+$/.test(every.trim()) && n >= 1 && n <= 52;
  useEffect(() => {
    if (!valid) { setPlan(null); return; }
    let off = false;
    dispatchApi.future({ date: d.date, keys: d.keys, everyWeeks: n }).then((p) => { if (!off) setPlan(p); }, () => { if (!off) setPlan(null); });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [every]);
  const marks = useMemo(() => {
    const m: Record<string, "this" | "gets"> = { [d.date]: "this" };
    if (valid) for (let k = 1; k * n <= 52; k++) m[plusDays(d.date, 7 * n * k)] = "gets";
    return m;
  }, [d.date, n, valid]);
  const different = plan?.days.reduce((s, x) => s + x.different, 0) ?? 0;
  const differentDays = plan?.days.filter((x) => x.different).length ?? 0;
  const stops = d.keys.map((k) => events.get(k)).filter((e): e is DEvent => !!e);
  const repeating = stops.filter((e) => e.seriesId).length;
  const lane = stops[0] ? assignmentText(stops[0], board) : "";
  return (
    <Dialog title="Save and apply to future weeks" onClose={onClose} width={420} footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="dx-btn dark" disabled={!valid || r.working} onClick={async () => { if (await r.save({ future: { everyWeeks: n, assignments: withPeople ? mode : "none" } })) onClose(); }}>{r.working ? "Saving…" : "Save and apply"}</button>
    </>}>
      <label className="dx-field">Repeat every <input className="dx-input narrow" inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Weeks between" /> week{n === 1 ? "" : "s"}</label>
      {!valid && <p className="dx-error">Enter a whole number of weeks between 1 and 52</p>}
      <MiniCal value={null} today={today} marks={marks} />
      <div className="dx-cal-key"><span><i className="this" /> This route's day</span><span><i className="gets" /> Receives this order</span></div>
      {valid && <p className="dx-note">Continues every {n === 1 ? "week" : `${n} weeks`} for up to 52 weeks, for as long as these visits stay on the schedule. No new visits are made.</p>}
      {repeating === 0 ? <p className="dx-note warn">None of these stops repeat, so there's nothing to copy forward. The route is still saved for {dateLabel(d.date, { month: "short", day: "numeric" })}.</p>
        : plan && <p className="dx-note">{plan.days.length ? `${repeating} of the ${stops.length} stops repeat. Their order goes to ${plan.days.length} future day${plan.days.length === 1 ? "" : "s"}.` : "The stops that repeat have no visits on those days yet."}</p>}
      <label className="dx-check-line"><Check checked={withPeople} label="Save crew/employee assignments" onChange={setWithPeople} /> Save crew/employee assignments</label>
      {withPeople && (
        <div className="dx-indent">
          {different > 0 && <p className="dx-note warn">{different} upcoming visit{different === 1 ? "" : "s"} on {differentDays} day{differentDays === 1 ? "" : "s"} already {different === 1 ? "has" : "have"} a different assignment.</p>}
          <label className="dx-radio"><input type="radio" checked={mode === "keep"} onChange={() => setMode("keep")} /> Keep their existing assignments (unassigned visits get {lane || "this route's people"})</label>
          <label className="dx-radio"><input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace with this route's assignments</label>
        </div>
      )}
    </Dialog>
  );
}

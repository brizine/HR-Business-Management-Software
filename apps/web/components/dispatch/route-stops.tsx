"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { DISPATCH_ROUTE_MAX, clock12, clockText, milesText, routeTimeline } from "@crewdesk/shared";
import { Grip, useDragOrder } from "@/components/drag-order";
import { Icon } from "@/components/icons";
import { useAction } from "@/lib/hooks";
import { dayLabel } from "@/components/waitlist";
import { dispatchApi, type DPoint, type DRoute, type Preview } from "./data";
import { Ico } from "./beta-parts";

/**
 * Route stops, on the Dispatch board: one crew's day as a list to put in order by hand. Drag a stop
 * (or use the arrow keys), turn the whole day around, or let Crewdesk work out the shortest drive
 * and then adjust it. Curbside arrival plans the drive so the truck pulls up on each stop's own
 * side of the street. Nothing changes until Save order; each drive and arrival time is measured
 * again as the order changes.
 */

export type StopRow = {
  id: string; number: number; status: string; estMinutes: number | null; windowStart: string | null; windowEnd: string | null;
  service: { name: string }; customer: { name: string }; property: { street: string; city: string | null; lat: number | null };
  route: { locked: boolean } | null;
};
export type StopLane = { key: string; date: string; crew: { id: string; name: string; color: string } | null; all: StopRow[]; route: DRoute | undefined };

const key = (id: string) => `v:${id}`;
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
/** A saved route's own start or end (someone's home, a picked spot); otherwise the company's. */
const endOf = (p: DPoint | undefined) => (!p || p.kind === "company" ? { kind: "company" as const } : p.kind === "none" ? { kind: "none" as const } : { kind: p.kind, label: p.label, lat: p.lat, lng: p.lng });

export function RouteStops({ lanes, crewId, picked, routing, curbsideDefault, onClose, onSaved }: {
  /** The day's crews with work on them. */
  lanes: StopLane[];
  /** The crew to open on (the one whose stops are selected, or whose lane the button was in). */
  crewId?: string | null;
  /** The stops ticked on the board, in the order they were ticked. */
  picked: string[];
  routing: "estimate" | "road";
  /** The company's choice for a crew that has no route yet. */
  curbsideDefault: boolean;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const crewLanes = useMemo(() => lanes.filter((l) => l.crew && l.all.length > 0), [lanes]);
  const [laneKey, setLaneKey] = useState(() => (crewLanes.find((l) => l.crew!.id === crewId) ?? crewLanes[0])?.key ?? "");
  const lane = crewLanes.find((l) => l.key === laneKey);
  const [order, setOrder] = useState<string[]>(() => lane?.all.map((r) => r.id) ?? []);
  const [curbside, setCurbside] = useState(() => lane?.route?.curbside ?? curbsideDefault);
  const [dirty, setDirty] = useState(false);
  const [optimized, setOptimized] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();
  const roads = routing === "road";
  const rows = useMemo(() => new Map((lane?.all ?? []).map((r) => [r.id, r])), [lane]);
  const tooMany = order.length > DISPATCH_ROUTE_MAX;
  const ends = useMemo(() => ({ start: endOf(lane?.route?.start), end: endOf(lane?.route?.end) }), [lane]);

  /** Another crew: its day as it stands now. */
  const open = (next: string) => {
    if (next === laneKey) return;
    if (dirty && !confirm("Leave this crew's order unsaved?")) return;
    const l = crewLanes.find((x) => x.key === next);
    setLaneKey(next);
    setOrder(l?.all.map((r) => r.id) ?? []);
    setCurbside(l?.route?.curbside ?? curbsideDefault);
    setDirty(false); setOptimized(false); setPreview(null); setNote(null);
  };
  const change = (next: string[], why: string | null = null) => { setOrder(next); setDirty(true); setOptimized(false); setNote(why); };
  const drag = useDragOrder(order, (next) => change(next), { disabled: act.busy });

  // Each drive and arrival, measured again whenever the order or the curbside choice changes.
  const shape = `${laneKey}|${order.join(",")}|${curbside}`;
  const wanted = useRef("");
  useEffect(() => {
    if (!lane || order.length === 0 || tooMany) { setPreview(null); return; }
    wanted.current = shape;
    setMeasuring(true);
    const timer = setTimeout(async () => {
      try {
        const p = await dispatchApi.preview({ date: lane.date, keys: order.map(key), ...ends, curbside });
        if (wanted.current === shape) setPreview(p);
      } catch { if (wanted.current === shape) setPreview(null); } finally { if (wanted.current === shape) setMeasuring(false); }
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const fits = !!preview && preview.keys.length === order.length && preview.keys.every((k, i) => k === key(order[i]));
  const startTime = lane?.route?.startTime ?? "08:00";
  const timeline = fits ? routeTimeline({ startTime, minutes: order.map((id) => rows.get(id)?.estMinutes ?? 0), legs: preview!.stops.map((s) => s.leg), endLeg: preview!.endLeg }) : null;
  const locked = order.filter((id) => rows.get(id)?.route?.locked);
  const mine = picked.filter((id) => rows.has(id));

  const optimize = () => act.run(async () => {
    if (!lane) return;
    const p = await dispatchApi.preview({ date: lane.date, keys: order.map(key), ...ends, optimize: true, locked: locked.map(key), curbside });
    setOrder(p.keys.map((k) => k.slice(2)));
    setPreview(p);
    setDirty(true); setOptimized(true);
    setNote(`Ordered to keep the drive shortest${locked.length ? `, around the ${locked.length} locked stop${locked.length === 1 ? "" : "s"}` : ""}. Drag any stop to adjust it.`);
  });
  const save = () => act.run(async () => {
    if (!lane) return;
    const r = await dispatchApi.lane(lane.date, lane.crew!.id, order.map(key), curbside);
    const drive = r.totalDriveSeconds ?? 0, meters = r.totalMeters ?? 0;
    onSaved(`${lane.crew!.name}: route saved in the order you set, ${order.length} stop${order.length === 1 ? "" : "s"}, ${clockText(drive)} of driving, ${milesText(meters)} mi${roads ? "" : " (estimated)"}${curbside && roads ? ", arriving curbside" : ""}.`);
  });
  const close = () => { if (!dirty || confirm("Close without saving this order?")) onClose(); };

  if (!lane) {
    return (
      <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="cal-modal card stack" role="dialog" aria-modal="true" aria-label="Route stops">
          <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Route stops</h2><button type="button" className="btn sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button></div>
          <p className="muted" style={{ margin: 0 }}>No crew has work on this day yet. Give work orders a crew first (drag them into a crew&apos;s rows, or use Edit work orders), then route them.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cal-modal card stack rs" role="dialog" aria-modal="true" aria-label="Route stops">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Route stops</h2>
          <button type="button" className="btn sm" onClick={close} aria-label="Close"><Icon name="close" size={14} /></button>
        </div>
        <div className="row rs-head">
          <label className="rs-crew">Crew
            <select value={laneKey} onChange={(e) => open(e.target.value)} disabled={act.busy}>
              {crewLanes.map((l) => <option key={l.key} value={l.key}>{l.crew!.name} ({l.all.length})</option>)}
            </select>
          </label>
          <span className="muted">{dayLabel(lane.date, { weekday: "long", month: "long", day: "numeric" })} · leaves at {clock12(minutesOf(startTime))}</span>
        </div>
        <div className="row rs-tools">
          <button type="button" className="btn" disabled={act.busy || order.length < 2 || optimized || tooMany} onClick={optimize}
            data-tip="Let Crewdesk put the stops in the order with the shortest drive, from the shop and back. Locked stops keep their place. You can still drag stops afterwards.">
            {act.busy ? "Working…" : optimized ? "Optimized" : "Optimize"}
          </button>
          <button type="button" className="btn" disabled={act.busy || order.length < 2} onClick={() => change([...order].reverse(), "Turned around: the last stop is now first.")}
            data-tip="Turn the whole order around: the last stop becomes the first">Reverse</button>
          {mine.length > 0 && (
            <button type="button" className="btn" disabled={act.busy} onClick={() => change([...mine, ...order.filter((id) => !mine.includes(id))], `The ${mine.length} you ticked now come first, in the order you ticked them.`)}
              data-tip="The stops you ticked on the board go first, in the order you ticked them; the rest follow as they were">
              Ticked first ({mine.length})
            </button>
          )}
          <span style={{ marginLeft: "auto" }} />
          <label className={`check rs-curb${roads ? "" : " off"}`}
            data-tip={roads
              ? "Plan the drive so the truck pulls up on each stop's own side of the street, so nobody crosses the road. It can add a little driving."
              : "Curbside arrival needs real-road drive times. An admin can switch them on in New Dispatch: View, then Routing and capacity."}>
            <input type="checkbox" checked={curbside} disabled={!roads || act.busy} onChange={(e) => { setCurbside(e.target.checked); setDirty(true); setOptimized(false); }} /> Curbside arrival
          </label>
        </div>
        {!roads && <p className="muted rs-note">Drive times are estimates, which don&apos;t know which side of the street a stop is on. Curbside arrival needs real-road drive times: an admin can switch them on in <strong>New Dispatch → View → Routing and capacity</strong>.</p>}
        <p className="muted rs-note">Drag a stop by its handle (⠿) to put it where you want it, or click the handle and press the up and down arrow keys. Nothing changes on the board until you save.</p>
        {note && <div className="alert ok" role="status">{note}</div>}
        {tooMany && <div className="alert bad">A route is limited to {DISPATCH_ROUTE_MAX} stops. Split this day between crews before ordering it.</div>}
        <ol className="rs-list" ref={drag.box}>
          {drag.sorted(lane.all, (r) => r.id).map((r, i) => {
            const leg = fits ? preview!.stops[i]?.leg ?? null : null;
            const at = timeline ? timeline.arrive[i] : null;
            const late = at != null && r.status === "open" && !!r.windowEnd && at > minutesOf(r.windowEnd);
            const done = r.status === "completed" || r.status === "skipped";
            return (
              <li key={r.id} {...drag.row(r.id, `rs-stop${done ? " done" : ""}`)}>
                <Grip drag={drag} id={r.id} name={`Stop ${i + 1}, ${r.customer.name}`} />
                <span className="rs-num" style={{ background: lane.crew!.color }}>{i + 1}</span>
                <span className="rs-main">
                  <strong>{r.customer.name}</strong>
                  <span className="muted"> · {r.property.street}{r.property.city ? `, ${r.property.city}` : ""}</span>
                  <span className="rs-sub muted">{r.service.name}{r.estMinutes ? ` · ${r.estMinutes} min on site` : ""}{r.windowStart || r.windowEnd ? ` · window ${r.windowStart ? clock12(minutesOf(r.windowStart)) : "any"} to ${r.windowEnd ? clock12(minutesOf(r.windowEnd)) : "any"}` : ""}{done ? ` · ${r.status}` : ""}{r.property.lat == null ? " · not on the map" : ""}</span>
                </span>
                <span className="rs-when">
                  {at != null && !done && <span className={late ? "bad-text" : undefined}>about {clock12(at)}{late ? " (after its window)" : ""}</span>}
                  {leg && <span className="rs-sub muted">{clockText(leg.seconds)} drive · {milesText(leg.meters)} mi</span>}
                </span>
                {r.route?.locked && <span className="rs-lock" title="Locked in place: Optimize leaves it here. You can still drag it."><Ico name="lock" size={14} /></span>}
              </li>
            );
          })}
        </ol>
        <div className="rs-total muted" aria-live="polite">
          {measuring && !fits ? "Measuring the drive…" : fits && timeline ? (
            <>
              <strong>{clockText(preview!.totalDriveSeconds)}</strong> of driving · <strong>{milesText(preview!.totalMeters)} mi</strong>{preview!.measured === "estimate" ? " (estimated)" : ""}
              {preview!.end ? <> · back about <strong>{clock12(timeline.endAt)}</strong></> : null}
              {curbside && roads && (preview!.curbsideMeasured ? " · arriving curbside" : preview!.measured === "road" ? " · curbside wasn't possible at every stop, so this is the ordinary drive" : "")}
            </>
          ) : ""}
        </div>
        {act.error && <div className="alert bad">{act.error}</div>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn primary" disabled={act.busy || tooMany || (!dirty && !!lane.route)} onClick={save}
            data-tip="Make this the crew's route for the day, in exactly this order">{act.busy ? "Saving…" : "Save order"}</button>
        </div>
      </div>
    </div>
  );
}

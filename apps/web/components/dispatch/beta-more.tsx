"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_ROAD_URL, DISPATCH_PALETTE, MAP_AREAS_MAX, clockText, legText, milesText } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Badges, windowText, type WaitData, type WaitRow } from "@/components/waitlist";
import { assignmentText, dateLabel, eventHours, monthDay, trim1, type Area, type Board, type DEvent, type DRoute, type Preview } from "./data";
import { Check, Dialog, Ico, MenuItem, Pop, anchorOf } from "./beta-parts";
import { pad2 } from "./beta-dialogs";

/* More of the beta board: areas drawn on the map, the waitlist panel, routing and capacity settings, and printing. */

/* ───────────── Custom areas ───────────── */

export function AreasPanel({ areas, shown, onShown, drawing, setDrawing, onChanged, onClose, toast }: {
  areas: Area[]; shown: string[]; onShown: (ids: string[]) => void; drawing: [number, number][] | null; setDrawing: (d: [number, number][] | null) => void;
  onChanged: () => void; onClose: () => void; toast: (text: string, bad?: boolean) => void;
}) {
  const [naming, setNaming] = useState<{ id?: string; name: string; color: string; points?: [number, number][] } | null>(null);
  const [menu, setMenu] = useState<{ id: string; at: ReturnType<typeof anchorOf> } | null>(null);
  const [gone, setGone] = useState<Area | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const { busy, error, run } = useAction();
  const visible = areas.filter((a) => shown.includes(a.id)).length;
  // Backspace takes back the last corner while drawing.
  useEffect(() => {
    if (!drawing) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Backspace" && !(e.target as HTMLElement).closest("input, textarea")) { e.preventDefault(); setDrawing(drawing.slice(0, -1)); } if (e.key === "Escape") setDrawing(null); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [drawing, setDrawing]);
  const open = menu ? areas.find((a) => a.id === menu.id) : undefined;
  return (
    <div className="dx-areas" role="dialog" aria-label="Custom areas">
      <div className="dx-areas-head">
        <strong>Custom areas{areas.length ? ` ${visible}/${areas.length}` : ""}</strong>
        <span style={{ flex: 1 }} />
        {areas.length > 0 && <button type="button" className="dx-icon-btn" aria-label={visible ? "Hide all areas" : "Show all areas"} onClick={() => onShown(visible ? [] : areas.map((a) => a.id))}><Ico name={visible ? "eye" : "eyeOff"} /></button>}
        <button type="button" className="dx-icon-btn" aria-label="Add area" title={areas.length >= MAP_AREAS_MAX ? `A company can have up to ${MAP_AREAS_MAX} areas` : "Add area"} disabled={!!drawing || areas.length >= MAP_AREAS_MAX} onClick={() => setDrawing([])}><Ico name="plus" /></button>
        <button type="button" className="dx-icon-btn" aria-label="Close" onClick={onClose}><Ico name="x" /></button>
      </div>
      {drawing ? (
        <div className="dx-areas-draw">
          <p>Click at least 3 points on the map to outline the area. {drawing.length > 0 && `${drawing.length} so far.`}</p>
          <div className="dx-row">
            <button type="button" className="dx-btn" disabled={!drawing.length} onClick={() => setDrawing(drawing.slice(0, -1))}>Undo point</button>
            <button type="button" className="dx-btn" onClick={() => setDrawing(null)}>Cancel</button>
            <button type="button" className="dx-btn dark" disabled={drawing.length < 3} onClick={() => setNaming({ name: "", color: DISPATCH_PALETTE[areas.length % DISPATCH_PALETTE.length], points: drawing })}>Finish</button>
          </div>
        </div>
      ) : areas.length ? (
        <ul className="dx-areas-list">
          {areas.map((a, i) => (
            <li key={a.id} className={drag === i ? "dragging" : ""} draggable onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (drag === null || drag === i) return; const ids = areas.map((x) => x.id); const [m] = ids.splice(drag, 1); ids.splice(i, 0, m); setDrag(null); run(async () => { await api("/dispatch/areas", { method: "PUT", body: { ids } }); onChanged(); }); }}>
              <Ico name="grip" size={14} className="dx-faint" /><span className="dx-dot" style={{ background: a.color }} /><span className="dx-areas-name">{a.name}</span>
              <button type="button" className="dx-icon-btn" aria-label={`${shown.includes(a.id) ? "Hide" : "Show"} ${a.name}`} onClick={() => onShown(shown.includes(a.id) ? shown.filter((x) => x !== a.id) : [...shown, a.id])}><Ico name={shown.includes(a.id) ? "eye" : "eyeOff"} className={shown.includes(a.id) ? "" : "dx-faint"} /></button>
              <button type="button" className="dx-icon-btn" aria-label={`${a.name} actions`} onClick={(e) => setMenu({ id: a.id, at: anchorOf(e.currentTarget) })}><Ico name="dots" /></button>
            </li>
          ))}
        </ul>
      ) : <p className="dx-areas-none">No custom areas yet. Draw one to mark a territory on the map.</p>}
      {error && <p className="dx-error">{error}</p>}
      <Pop at={menu?.at ?? null} onClose={() => setMenu(null)} width={210} align="right">
        <MenuItem icon="pencil" onClick={() => { if (open) setNaming({ id: open.id, name: open.name, color: open.color }); setMenu(null); }}>Change name or color</MenuItem>
        <MenuItem icon="trash" danger onClick={() => { if (open) setGone(open); setMenu(null); }}>Delete</MenuItem>
      </Pop>
      {naming && (
        <Dialog title={naming.id ? "Change name or color" : "Name this area"} onClose={() => setNaming(null)} width={380} footer={<>
          <button type="button" className="dx-btn" onClick={() => setNaming(null)}>Cancel</button>
          <button type="button" className="dx-btn dark" disabled={busy || !naming.name.trim()} onClick={() => run(async () => {
            if (naming.id) await api(`/dispatch/areas/${naming.id}`, { method: "PUT", body: { name: naming.name.trim(), color: naming.color } });
            else { const a = await api<Area>("/dispatch/areas", { body: { name: naming.name.trim(), color: naming.color, points: naming.points } }); onShown([...shown, a.id]); toast(`Added ${a.name}`); setDrawing(null); }
            setNaming(null); onChanged();
          })}>{naming.id ? "Save" : "Save area"}</button>
        </>}>
          <form onSubmit={(e) => { e.preventDefault(); (e.currentTarget.parentElement?.parentElement?.querySelector(".dx-btn.dark") as HTMLButtonElement | null)?.click(); }}>
            <input className="dx-input" autoFocus maxLength={60} placeholder="Area name" value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} aria-label="Area name" />
          </form>
          <div className="dx-swatches">{DISPATCH_PALETTE.map((c) => <button key={c} type="button" aria-label={`Color ${c}`} className={naming.color === c ? "on" : ""} style={{ background: c }} onClick={() => setNaming({ ...naming, color: c })} />)}</div>
          {error && <p className="dx-error">{error}</p>}
        </Dialog>
      )}
      {gone && (
        <Dialog title="Delete area" onClose={() => setGone(null)} width={380} footer={<>
          <button type="button" className="dx-btn" onClick={() => setGone(null)}>Cancel</button>
          <button type="button" className="dx-btn danger" disabled={busy} onClick={() => run(async () => { await api(`/dispatch/areas/${gone.id}`, { method: "DELETE" }); onShown(shown.filter((x) => x !== gone.id)); setGone(null); onChanged(); })}>Delete area</button>
        </>}><p>Delete “{gone.name}”? It goes away for everyone.</p></Dialog>
      )}
    </div>
  );
}

/* ───────────── Waitlist ───────────── */

/** Work that's waiting for a day: tick some (or use Add on one) to put them on the day being viewed, unrouted. */
export function WaitlistPanel({ date, today, oneDay, onClose, onAdded, toast }: { date: string; today: string; oneDay: boolean; onClose: () => void; onAdded: (n: number) => void; toast: (text: string, bad?: boolean) => void }) {
  const list = useApi<WaitData>("/waitlist");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [day, setDay] = useState(date);
  const [early, setEarly] = useState<{ ids: string[]; reason: string } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { setDay(date); }, [date]);
  const rows = useMemo(() => (list.data?.rows ?? []).filter((r) => !q.trim() || [r.title, r.customer.name, r.property.address, r.service.name, r.property.mapCode ?? ""].some((t) => t.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (a.dueBy ?? "9999").localeCompare(b.dueBy ?? "9999") || b.waitingDays - a.waitingDays), [list.data, q]);
  const add = (ids: string[], reason?: string) => run(async () => {
    try {
      const r = await api<{ scheduled: number }>("/waitlist/schedule", { body: { visitIds: ids, date: day, ...(reason ? { earlyReason: reason } : {}) } });
      setPicked(new Set()); setEarly(null); list.reload(); onAdded(r.scheduled);
    } catch (e) {
      const m = (e as Error).message;
      if (/eligible until later/i.test(m) && !reason) setEarly({ ids, reason: "" }); else toast(m, true);
      throw e;
    }
  });
  const card = (r: WaitRow) => (
    <li key={r.id} className={`dx-wait-card${picked.has(r.id) ? " sel" : ""}`}>
      <Check checked={picked.has(r.id)} label={`Select ${r.title}`} disabled={r.needsCard} onChange={(v) => { const n = new Set(picked); if (v) n.add(r.id); else n.delete(r.id); setPicked(n); }} />
      <div className="dx-wait-body">
        <strong>{r.service.name}</strong>
        <span>{r.customer.name} · {r.property.address}{r.property.mapCode ? ` · MC ${r.property.mapCode}` : ""}</span>
        <span className="dx-muted">{r.eligible ? `From ${monthDay(r.eligible)}` : "Any time"}{r.dueBy ? ` · due ${monthDay(r.dueBy)}` : ""}{r.estMinutes ? ` · ${trim1(r.estMinutes / 60)} h` : ""}{r.windowStart ? ` · ${windowText(r.windowStart, r.windowEnd)}` : ""}</span>
        {r.badges.length > 0 && <span className="dx-wait-badges"><Badges badges={r.badges} /></span>}
      </div>
      <button type="button" className="dx-btn" disabled={busy || r.needsCard} title={r.needsCard ? "Needs a card on file first" : `Add to ${dateLabel(day)}`} onClick={() => add([r.id])}>Add</button>
    </li>
  );
  return (
    <aside className="dx-waitlist" aria-label="Waitlist">
      <div className="dx-waitlist-head">
        <Ico name="hourglass" /><strong>Waitlist ({list.data ? list.data.rows.length : "…"})</strong><span style={{ flex: 1 }} />
        <Link className="dx-icon-btn" href="/waitlist" aria-label="Open the waiting list page" title="Open the waiting list page"><Ico name="external" /></Link>
        <button type="button" className="dx-icon-btn" aria-label="Close" onClick={onClose}><Ico name="x" /></button>
      </div>
      <label className="dx-search-line"><Ico name="search" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the waitlist" aria-label="Search the waitlist" /></label>
      {list.error && <p className="dx-error">{list.error}</p>}
      {rows.length ? <ul className="dx-wait-list">{rows.slice(0, 300).map(card)}</ul> : (
        <div className="dx-empty"><strong>No waitlist events</strong><span>{list.data?.rows.length ? "Nothing matches the search." : "Work orders with no date yet show up here."}</span></div>
      )}
      <div className="dx-waitlist-foot">
        {!oneDay && <label className="dx-muted">Add to <input type="date" className="dx-input" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>}
        <button type="button" className="dx-btn dark" disabled={busy || !picked.size} onClick={() => add([...picked])}>{busy ? "Adding…" : picked.size ? `Add ${picked.size} to ${dateLabel(day, { month: "short", day: "numeric" })}` : `Add to ${dateLabel(day, { month: "short", day: "numeric" })}`}</button>
      </div>
      {early && (
        <Dialog title="Before its earliest date" onClose={() => setEarly(null)} width={420} footer={<>
          <button type="button" className="dx-btn" onClick={() => setEarly(null)}>Cancel</button>
          <button type="button" className="dx-btn dark" disabled={busy || !early.reason.trim()} onClick={() => add(early.ids, early.reason.trim())}>Schedule anyway</button>
        </>}>
          <p>{early.ids.length === 1 ? "This one isn't" : "Some of these aren't"} eligible until after {dateLabel(day, { month: "short", day: "numeric" })} (the minimum days since the last service). Give a reason to schedule {early.ids.length === 1 ? "it" : "them"} early; it's recorded.</p>
          <input className="dx-input" autoFocus value={early.reason} onChange={(e) => setEarly({ ...early, reason: e.target.value })} placeholder="Reason" aria-label="Reason" />
        </Dialog>
      )}
    </aside>
  );
}

/* ───────────── Routing and capacity ───────────── */

export function SettingsDialog({ board, isAdmin, onClose, onSaved }: { board: Board; isAdmin: boolean; onClose: () => void; onSaved: () => void }) {
  const [routing, setRouting] = useState(board.settings.routing);
  const [roadUrl, setRoadUrl] = useState(board.settings.roadUrl ?? "");
  const [start, setStart] = useState(board.settings.startAddress ?? "");
  const [end, setEnd] = useState(board.settings.endAddress ?? "");
  const [people, setPeople] = useState(board.people.map((p) => ({ id: p.id, name: p.name, dailyHours: String(p.dailyHours), weeklyHours: p.weeklyHours == null ? "" : String(p.weeklyHours), excluded: p.excluded })));
  const { busy, error, run } = useAction();
  const set = (id: string, patch: Partial<(typeof people)[number]>) => setPeople(people.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  return (
    <Dialog title="Routing and capacity" onClose={onClose} wide footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>{isAdmin ? "Cancel" : "Close"}</button>
      {isAdmin && <button type="button" className="dx-btn dark" disabled={busy} onClick={() => run(async () => {
        await api("/dispatch/settings", { method: "PUT", body: { routing, roadUrl: roadUrl.trim() || null, startAddress: start.trim(), endAddress: end.trim() } });
        await api("/dispatch/capacity", { method: "PUT", body: { employees: people.map((p) => ({ id: p.id, dailyHours: Number(p.dailyHours) || 0, weeklyHours: p.weeklyHours.trim() === "" ? null : Number(p.weeklyHours), excluded: p.excluded })) } });
        onSaved(); onClose();
      })}>{busy ? "Saving…" : "Save"}</button>}
    </>}>
      {!isAdmin && <p className="dx-note">Only an admin can change these.</p>}
      <fieldset className="dx-set" disabled={!isAdmin}>
        <legend>Drive times</legend>
        <label className="dx-radio"><input type="radio" checked={routing === "estimate"} onChange={() => setRouting("estimate")} /> <span><strong>Estimates</strong>: the straight line stretched to road length, at in-town speeds. Nothing leaves Crewdesk.</span></label>
        <label className="dx-radio"><input type="radio" checked={routing === "road"} onChange={() => setRouting("road")} /> <span><strong>Real roads</strong>: a routing server works out the drive, the line along the streets and turn-by-turn directions. Only map coordinates are sent to it, never names or addresses.</span></label>
        {routing === "road" && <label className="dx-field col">Routing server (OSRM-compatible)<input className="dx-input" value={roadUrl} onChange={(e) => setRoadUrl(e.target.value)} placeholder={DEFAULT_ROAD_URL} /><small className="dx-muted">Left empty, the public OpenStreetMap routing server is used. It's free and meant for light use; if it's down, Crewdesk falls back to estimates.</small></label>}
      </fieldset>
      <fieldset className="dx-set" disabled={!isAdmin}>
        <legend>Where routes start and end</legend>
        <p className="dx-muted">Left empty, routes use the business address{board.depot ? ` (${board.depot.address})` : ""}. Either can still be changed on any one route.</p>
        <div className="dx-two-col">
          <label className="dx-field col">Start address<input className="dx-input" value={start} onChange={(e) => setStart(e.target.value)} placeholder={board.depot?.address ?? "Business address"} /></label>
          <label className="dx-field col">End address<input className="dx-input" value={end} onChange={(e) => setEnd(e.target.value)} placeholder={board.depot?.address ?? "Business address"} /></label>
        </div>
        {!board.depot && <p className="dx-note warn">The business address isn't on the map yet. Check it under Settings → Company.</p>}
      </fieldset>
      <fieldset className="dx-set" disabled={!isAdmin}>
        <legend>Capacity</legend>
        <p className="dx-muted">Budgeted hours each person can take. A crew's lane uses the crew's own hours a day (set on the <Link className="dx-link" href="/crews">Crews</Link> page). An empty weekly cap means none; 0 means no capacity that week.</p>
        <div className="dx-cap-table">
          <div className="dx-cap-head"><span>Employee</span><span>Daily hours</span><span>Weekly cap</span><span>Excluded</span></div>
          {people.map((p) => (
            <div key={p.id} className="dx-cap-row">
              <span>{p.name}</span>
              <input className="dx-input narrow" inputMode="decimal" value={p.dailyHours} onChange={(e) => set(p.id, { dailyHours: e.target.value })} aria-label={`${p.name}: daily hours`} />
              <input className="dx-input narrow" inputMode="decimal" value={p.weeklyHours} onChange={(e) => set(p.id, { weeklyHours: e.target.value })} aria-label={`${p.name}: weekly cap`} placeholder="none" />
              <Check checked={p.excluded} label={`${p.name}: excluded from capacity`} onChange={(v) => set(p.id, { excluded: v })} />
            </div>
          ))}
        </div>
      </fieldset>
      {error && <p className="dx-error">{error}</p>}
    </Dialog>
  );
}

/* ───────────── Printing ───────────── */

export type PrintKind = "map" | "directions" | "stops";
const STOP_INFO: [string, string][] = [["customer", "Customer"], ["phone", "Phone"], ["address", "Address"], ["assignee", "Assignee"], ["items", "Items & services"], ["notes", "Visit notes"], ["drive", "Drive"]];
const routeName = (r: DRoute, board: Board, events: Map<string, DEvent>, n: number) => {
  const first = events.get(r.stops[0]?.key ?? "");
  const who = first ? assignmentText(first, board) : "";
  return `${who || "Unassigned"}${n > 1 ? ` (route ${n})` : ""}`;
};
const totalsLine = (r: { stops: unknown[]; totalMeters: number; totalDriveSeconds: number }) => `${r.stops.length} stop${r.stops.length === 1 ? "" : "s"} · ${milesText(r.totalMeters)} mi · ${clockText(r.totalDriveSeconds)} drive`;

/** A preview of what will print (the map as it is on screen, turn-by-turn directions, or a stops list), then the browser's print window. */
export function PrintDialog({ what, board, events, onClose }: { what: PrintKind; board: Board; events: Map<string, DEvent>; onClose: () => void }) {
  const routes = board.routes;
  const [on, setOn] = useState<Set<string>>(new Set(routes.map((r) => r.id)));
  const [info, setInfo] = useState<Set<string>>(new Set(["customer", "phone", "address", "assignee", "items", "drive"]));
  const [split, setSplit] = useState(true);
  const [header, setHeader] = useState(true);
  const [land, setLand] = useState<"auto" | "landscape" | "portrait">("auto");
  const [dirs, setDirs] = useState<Record<string, Preview>>({});
  const [loading, setLoading] = useState(what === "directions");
  const names = useMemo(() => { const seen = new Map<string, number>(); return new Map(routes.map((r) => { const base = routeName(r, board, events, 1); const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return [r.id, routeName(r, board, events, n)]; })); }, [routes, board, events]);
  useEffect(() => {
    if (what !== "directions") return;
    let off = false;
    Promise.all(routes.map((r) => api<Preview>(`/dispatch/routes/${r.id}/directions`).then((p) => [r.id, p] as const, () => null))).then((rows) => { if (!off) { setDirs(Object.fromEntries(rows.filter((x): x is readonly [string, Preview] => !!x))); setLoading(false); } });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [what]);
  const chosen = routes.filter((r) => on.has(r.id));
  const day = dateLabel(board.from, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const oneCrew = new Set(chosen.map((r) => names.get(r.id))).size <= 1;
  const print = () => {
    const cls = what === "map" ? "dx-printing-map" : "dx-printing";
    const style = document.createElement("style");
    style.textContent = `@page { size: ${what === "map" ? (land === "auto" ? "landscape" : land) : "auto"}; margin: 12mm; }`;
    document.head.appendChild(style);
    document.body.classList.add(cls);
    const done = () => { document.body.classList.remove(cls); style.remove(); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 80);
  };
  const toggle = (set: Set<string>, k: string, to: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); to(n); };
  const sheet = what === "stops" ? (
    <div className="dx-sheet">
      {chosen.map((r) => (
        <section key={r.id} className={split ? "page" : ""}>
          <h2>Route stops</h2>
          <p className="dx-sheet-sub">{day} · {names.get(r.id)}</p>
          <table>
            <thead><tr><th>#</th><th>Event name</th>{info.has("customer") && <th>Customer</th>}{info.has("customer") && info.has("phone") && <th>Phone</th>}{info.has("address") && <th>Address</th>}{info.has("assignee") && !oneCrew && <th>Assignee</th>}{info.has("items") && <th>Items &amp; services</th>}{info.has("notes") && <th>Visit notes</th>}{info.has("drive") && <th>Drive</th>}</tr></thead>
            <tbody>
              {r.stops.map((s) => { const e = events.get(s.key); if (!e) return null; return (
                <tr key={s.key}><td>{pad2(s.order)}</td><td>{e.title}</td>{info.has("customer") && <td>{e.customer?.name ?? ""}</td>}{info.has("customer") && info.has("phone") && <td>{e.customer?.phone ?? ""}</td>}{info.has("address") && <td>{e.location?.address ?? ""}</td>}{info.has("assignee") && !oneCrew && <td>{assignmentText(e, board)}</td>}{info.has("items") && <td>{e.services.map((x) => x.name).join(", ")}</td>}{info.has("notes") && <td>{e.notes ?? ""}</td>}{info.has("drive") && <td>{legText(s.leg)}</td>}</tr>
              ); })}
            </tbody>
          </table>
          <p className="dx-sheet-total">{totalsLine(r)}{r.measured === "estimate" ? " (estimated)" : ""}</p>
        </section>
      ))}
    </div>
  ) : what === "directions" ? (
    <div className="dx-sheet">
      {loading && <p>Working out the directions…</p>}
      {!loading && chosen.map((r) => { const p = dirs[r.id]; return (
        <section key={r.id} className="page">
          <h2>{names.get(r.id)}</h2>
          <p className="dx-sheet-sub">{day} · {totalsLine(r)}</p>
          {p?.start && <p><strong>Start:</strong> {p.start.label}</p>}
          {p?.end && <p><strong>End:</strong> {p.end.label}</p>}
          {p?.measured === "estimate" && <p className="dx-sheet-note">Turn-by-turn steps need road routing (View → Routing and capacity). Each leg's distance and time is listed.</p>}
          {(p?.stops ?? []).map((s, i) => { const e = events.get(s.key); return (
            <div key={s.key} className="dx-leg-block">
              <h3>{pad2(i + 1)} {e?.title ?? ""}{e?.location ? ` · ${e.location.address}` : ""}</h3>
              <p className="dx-sheet-sub">{s.leg ? legText(s.leg) : "No location on the map"}</p>
              {s.steps && <ol>{s.steps.filter((x) => x.text !== "Arrive").map((x, j) => <li key={j}>{x.text}{x.meters > 30 ? ` · ${x.meters < 400 ? `${Math.round(x.meters * 3.281 / 10) * 10} ft` : `${milesText(x.meters)} mi`}` : ""}</li>)}</ol>}
            </div>
          ); })}
          {p?.end && p.endLeg && <div className="dx-leg-block"><h3>Back to {p.end.label}</h3><p className="dx-sheet-sub">{legText(p.endLeg)}</p>{p.endSteps && <ol>{p.endSteps.filter((x) => x.text !== "Arrive").map((x, j) => <li key={j}>{x.text}</li>)}</ol>}</div>}
        </section>
      ); })}
    </div>
  ) : (
    <div className="dx-sheet map">
      {header && <><h2>Route map</h2><p className="dx-sheet-sub">{day}</p></>}
      <div className="dx-sheet-mapnote">The map prints as it is on your screen now: pan and zoom it first if you need to.</div>
      {chosen.map((r) => <p key={r.id} className="dx-sheet-legend"><strong>{names.get(r.id)}</strong> · {totalsLine(r)}</p>)}
    </div>
  );
  return (
    <>
      <Dialog title={what === "map" ? "Print map" : what === "directions" ? "Print directions" : "Print stops list"} onClose={onClose} wide footer={<>
        <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="dx-btn dark" disabled={loading || (what !== "map" && !chosen.length)} onClick={print}><Ico name="print" />Print</button>
      </>}>
        <div className="dx-print">
          <div className="dx-print-opts">
            <div className="dx-pop-label">Routes</div>
            {routes.length > 1 && <div className="dx-row"><button type="button" className="dx-link" onClick={() => setOn(new Set(routes.map((r) => r.id)))}>Select all</button><button type="button" className="dx-link" onClick={() => setOn(new Set())}>Clear all</button></div>}
            {routes.map((r) => <label key={r.id} className="dx-check-line"><Check checked={on.has(r.id)} label={names.get(r.id) ?? ""} onChange={() => toggle(on, r.id, setOn)} /> {names.get(r.id)}</label>)}
            {!routes.length && <p className="dx-muted">No saved route for this day.</p>}
            {what === "stops" && <>
              <div className="dx-pop-label">Event info</div>
              <label className="dx-check-line"><Check checked disabled label="Event name" onChange={() => {}} /> Event name</label>
              {STOP_INFO.map(([k, label]) => <label key={k} className="dx-check-line"><Check checked={info.has(k)} disabled={k === "phone" && !info.has("customer")} label={label} onChange={() => toggle(info, k, setInfo)} /> {label}</label>)}
              <label className="dx-check-line"><Check checked={split} label="Split routes per page" onChange={setSplit} /> Split routes per page</label>
            </>}
            {what === "map" && <>
              <div className="dx-pop-label">Orientation</div>
              {(["auto", "landscape", "portrait"] as const).map((k) => <label key={k} className="dx-radio"><input type="radio" checked={land === k} onChange={() => setLand(k)} /> {k[0].toUpperCase() + k.slice(1)}</label>)}
              <label className="dx-check-line"><Check checked={header} label="Show header" onChange={setHeader} /> Show header</label>
            </>}
          </div>
          <div className="dx-print-preview">{sheet}</div>
        </div>
      </Dialog>
      {typeof document !== "undefined" && createPortal(<div className="dx dx-print-root">{sheet}</div>, document.body)}
    </>
  );
}

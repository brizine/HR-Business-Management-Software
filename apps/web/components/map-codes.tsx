"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MAP_CODE_COLORS, formatOutlineSize, mapCodeColor, mapCodeFinder, outlineHas, outlineSqM, sameMapCode, type LatLng, type MapOutline } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { OK_LEAF_OFF, STREET_MAP, sourceLayer, type ImageryLayer } from "@/lib/imagery";
import { Icon } from "./icons";
import { MapCodesMap, type MapCodeShape, type MapPin } from "./map-codes-map";
import { ErrorBox } from "./ui";

/**
 * Map Codes (Settings → Map Codes): the service area drawn as outlines. Each outline has a code, a name and
 * a colour. With automatic map codes on, a property's Map Code is the code of the outline its pin is in.
 * Admins and owners draw; Customers & billing managers can look.
 */

type State = { auto: boolean; codes: MapCodeShape[] };
type NoPin = { id: string; address: string; mapCode: string | null; tried: boolean };
type Props = { pins: MapPin[]; noPin: NoPin[] };
type Change = "same" | "set" | "moved" | "cleared" | "by_hand" | "no_pin";
type Plan = { rows: { id: string; address: string; from: string | null; to: string | null; change: Change }[]; counts: Record<Change, number>; moves: { from: string | null; to: string | null; count: number }[] };
type Check = { outline: MapOutline | null; trimmedBy: string[]; plan: Plan | null };
type Draft = { id?: string; code: string; name: string; color: string; outline: MapOutline };
type ImageryList = { sources: Parameters<typeof sourceLayer>[0][] };

const GREY = "#8b949e";
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const properties = (n: number) => plural(n, "property", "properties");
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const csvCell = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;

/** What a set of changes comes to, in sentences. */
function PlanSummary({ plan, turningOn }: { plan: Plan; turningOn?: boolean }) {
  const c = plan.counts;
  const changing = c.set + c.moved + c.cleared;
  const download = () => {
    const text = ["Address,Map Code now,Map Code after", ...plan.rows.map((r) => [r.address, r.from, r.to].map(csvCell).join(","))].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = "map-code-changes.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {changing === 0 ? <p style={{ margin: 0 }}>No property&apos;s Map Code changes.</p> : (
        <>
          <p style={{ margin: 0 }}><strong>{properties(changing)}</strong> {changing === 1 ? "changes" : "change"} Map Code:</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {c.moved > 0 && <li>{properties(c.moved)} {c.moved === 1 ? "moves" : "move"} to another code</li>}
            {c.set > 0 && <li>{properties(c.set)} with no code {c.set === 1 ? "gets" : "get"} one</li>}
            {c.cleared > 0 && <li><strong>{properties(c.cleared)}</strong> {c.cleared === 1 ? "is" : "are"} outside every outline and would have <strong>no Map Code</strong></li>}
          </ul>
        </>
      )}
      {c.by_hand > 0 && <p className="muted" style={{ margin: 0 }}>{properties(c.by_hand)} with a code set by hand {c.by_hand === 1 ? "keeps" : "keep"} it.</p>}
      {c.no_pin > 0 && <p className="muted" style={{ margin: 0 }}>{properties(c.no_pin)} {c.no_pin === 1 ? "has" : "have"} no pin on the map, so {c.no_pin === 1 ? "it keeps" : "they keep"} the code {c.no_pin === 1 ? "it has" : "they have"}{turningOn ? ". Find their pins (below the list of map codes) to place them" : ""}.</p>}
      {plan.moves.length > 0 && (
        <div className="tablewrap" style={{ maxHeight: 180, overflowY: "auto" }}>
          <table>
            <thead><tr><th>Map Code now</th><th>After</th><th className="num">Properties</th></tr></thead>
            <tbody>{plan.moves.map((m, i) => <tr key={i}><td>{m.from ?? <span className="muted">None</span>}</td><td>{m.to ?? <span className="warn-text">None (outside every outline)</span>}</td><td className="num">{m.count}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {plan.rows.length > 0 && (
        <details>
          <summary>The {properties(plan.rows.length)}</summary>
          <ul className="plain-list mc-plan-list">
            {plan.rows.slice(0, 500).map((r) => <li key={r.id}><Link href={`/properties/${r.id}`} target="_blank">{r.address}</Link> <span className="muted">{r.from ?? "none"} → {r.to ?? "none"}</span></li>)}
            {plan.rows.length > 500 && <li className="muted">and {plan.rows.length - 500} more: download the list to see them all.</li>}
          </ul>
        </details>
      )}
      {plan.rows.length > 0 && <div><button type="button" className="btn" onClick={download} title="A spreadsheet of every property that changes, with its code now and after. Worth keeping when codes are being cleared.">Download the list</button></div>}
    </div>
  );
}

function Dialog({ title, children, action, danger, busy, error, onYes, onNo }: { title: string; children: React.ReactNode; action: string; danger?: boolean; busy: boolean; error: string | null; onYes: () => void; onNo: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onNo(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onNo]);
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onNo(); }}>
      <div className="cal-modal card stack" role="dialog" aria-modal="true" aria-label={title} style={{ width: "min(620px, 100%)" }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {children}
        <ErrorBox error={error} />
        <div className="row">
          <button type="button" className={`btn ${danger ? "danger" : "primary"}`} disabled={busy} onClick={onYes}>{busy ? "Working…" : action}</button>
          <button type="button" className="btn" onClick={onNo}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function MapCodesEditor() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const state = useApi<State>("/map-codes");
  const props = useApi<Props>("/map-codes/properties");
  const imageryList = useApi<ImageryList>("/measurements/imagery");
  const [photo, setPhoto] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drawing, setDrawing] = useState<"piece" | "hole" | null>(null);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [fitKey, setFitKey] = useState(0);
  const [focus, setFocus] = useState<{ key: number; outline: MapOutline | null }>({ key: 0, outline: null });
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<null | { kind: "save"; check: Check } | { kind: "delete"; code: MapCodeShape; plan: Plan | null } | { kind: "on"; plan: Plan } | { kind: "off" }>(null);
  const [finding, setFinding] = useState<null | { found: number; tried: number; remaining: number; stop: boolean }>(null);
  const stopFinding = useRef(false);
  const act = useAction();
  const ask = useAction();

  const codes = state.data?.codes ?? [];
  const auto = !!state.data?.auto;
  const pins = props.data?.pins ?? [];
  const noPin = props.data?.noPin ?? [];
  const imagery: ImageryLayer = useMemo(() => {
    if (!photo) return STREET_MAP;
    const all = (imageryList.data?.sources ?? []).map(sourceLayer);
    return all.find((l) => l.leafOff) ?? all[0] ?? OK_LEAF_OFF;
  }, [photo, imageryList.data]);

  // Everything in view once, when the outlines and the dots first arrive.
  const loaded = !!state.data && !!props.data;
  useEffect(() => { if (loaded) setFitKey((k) => k + 1); }, [loaded]);

  /** The outlines on the map other than the one being changed. */
  const shown = useMemo(() => codes.filter((c) => c.id !== draft?.id), [codes, draft?.id]);
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of codes) m.set(c.code.trim().toUpperCase(), c.color);
    if (draft?.code.trim()) m.set(draft.code.trim().toUpperCase(), draft.color);
    return m;
  }, [codes, draft?.code, draft?.color]);
  const pinColor = useMemo(() => (q: MapPin) => (q.mapCode ? colorOf.get(q.mapCode.trim().toUpperCase()) ?? mapCodeColor(q.mapCode) : GREY), [colorOf]);

  /** Where every dot falls with the outlines as they are on screen: how many in each, and which are in none. */
  const placed = useMemo(() => {
    const all = [...shown, ...(draft?.outline.length ? [{ id: draft.id ?? "new", code: draft.code || "(new)", outline: draft.outline }] : [])];
    const find = mapCodeFinder(all);
    const inside = new Map<string, number>();
    const outside: MapPin[] = [];
    for (const q of pins) {
      const hit = find(q.lat, q.lng);
      if (hit) inside.set(hit.id, (inside.get(hit.id) ?? 0) + 1); else outside.push(q);
    }
    return { inside, outside };
  }, [shown, draft?.outline, draft?.id, draft?.code, pins]);

  /** Codes typed on properties that have no outline yet: a place to start drawing from. */
  const typed = useMemo(() => {
    const m = new Map<string, { code: string; pins: MapPin[] }>();
    for (const q of pins) {
      if (!q.mapCode || codes.some((c) => sameMapCode(c.code, q.mapCode))) continue;
      const k = q.mapCode.trim().toUpperCase();
      m.set(k, { code: m.get(k)?.code ?? q.mapCode.trim(), pins: [...(m.get(k)?.pins ?? []), q] });
    }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [pins, codes]);

  const stopDrawing = () => { setDrawing(null); setPoints([]); act.setError(null); };
  const close = () => { setDraft(null); stopDrawing(); act.setError(null); };
  const startNew = (code = "", around?: MapPin[]) => {
    const used = new Set(codes.map((c) => c.color.toLowerCase()));
    setDraft({ code, name: "", color: code ? mapCodeColor(code) : MAP_CODE_COLORS.find((c) => !used.has(c)) ?? MAP_CODE_COLORS[codes.length % MAP_CODE_COLORS.length], outline: [] });
    setDrawing("piece"); setPoints([]); setNote(null); act.setError(null);
    // Straight to the properties that carry this code, to draw around them.
    if (around?.length) setFocus((f) => ({ key: f.key + 1, outline: [[around.map((q) => [q.lat, q.lng] as LatLng)]] }));
  };
  const open = (id: string) => {
    // One at a time: with an outline open (perhaps half changed), a click on another one doesn't swap it away.
    if (drawing || draft) return;
    const c = codes.find((x) => x.id === id);
    if (!c) return;
    if (admin) { setDraft({ id: c.id, code: c.code, name: c.name ?? "", color: c.color, outline: c.outline }); setNote(null); act.setError(null); }
    setFocus((f) => ({ key: f.key + 1, outline: c.outline }));
  };
  /** The corners clicked become a piece of the outline, or a hole in the piece they're inside. */
  const finish = () => {
    if (!draft || !drawing) return;
    if (points.length < 3) { act.setError("An outline needs at least 3 corners. Keep clicking, or cancel."); return; }
    if (drawing === "piece") setDraft({ ...draft, outline: [...draft.outline, [points]] });
    else {
      const at = draft.outline.findIndex((piece) => outlineHas([[piece[0]]], points[0][0], points[0][1]));
      if (at < 0) { act.setError("A hole has to be drawn inside the outline. Start it inside, or cancel."); return; }
      setDraft({ ...draft, outline: draft.outline.map((piece, i) => (i === at ? [...piece, points] : piece)) });
    }
    stopDrawing();
  };
  // Enter finishes the outline being drawn; Esc stops drawing; Backspace takes off the last corner.
  useEffect(() => {
    if (!drawing) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "Enter") { e.preventDefault(); finish(); }
      else if (e.key === "Escape") stopDrawing();
      else if (e.key === "Backspace" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")) { e.preventDefault(); setPoints((p) => p.slice(0, -1)); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const body = (d: Draft) => ({ code: d.code.trim(), name: d.name.trim() || null, color: d.color, outline: d.outline });
  const reload = () => { state.reload(); props.reload(); };
  const doSave = async (d: Draft) => {
    const r = await api<MapCodeShape & { trimmedBy: string[]; changed: number }>(d.id ? `/map-codes/${d.id}` : "/map-codes", { method: d.id ? "PUT" : "POST", body: body(d) });
    close(); setAsking(null); reload();
    setNote(`Saved ${r.code}.${r.trimmedBy.length ? ` It was trimmed to fit where it overlapped ${listOf(r.trimmedBy)}.` : ""}${r.changed ? ` ${properties(r.changed)} changed Map Code.` : ""}`);
  };
  const save = () => act.run(async () => {
    if (!draft) return;
    if (drawing) throw new Error("Finish or cancel the outline you're drawing first.");
    if (!draft.code.trim()) throw new Error("Give the map code a code, such as 801.");
    if (!draft.outline.length) throw new Error("Draw the outline on the map first.");
    if (auto) {
      // With automatic map codes on, an outline moves properties: show what would change before it's saved.
      const check = await api<Check>("/map-codes/check", { body: { ...body(draft), ...(draft.id ? { id: draft.id } : {}) } });
      if (check.plan && check.plan.rows.length) { ask.setError(null); setAsking({ kind: "save", check }); return; }
    }
    await doSave(draft);
  });
  const remove = (c: MapCodeShape) => act.run(async () => {
    const check = await api<Check>("/map-codes/check", { body: { removeId: c.id } });
    ask.setError(null);
    setAsking({ kind: "delete", code: c, plan: check.plan });
  });
  const turnOn = () => act.run(async () => { const plan = await api<Plan>("/map-codes/auto/preview"); ask.setError(null); setAsking({ kind: "on", plan }); });

  /** The catch-up: asks the server to look addresses up, a few seconds' worth at a time, until none are left. */
  const findPins = async () => {
    let since: string | undefined;
    let total = { found: 0, tried: 0, remaining: noPin.length, stop: false };
    stopFinding.current = false;
    setFinding(total);
    act.setError(null);
    try {
      for (;;) {
        const r = await api<{ found: number; tried: number; remaining: number; since: string }>("/map-codes/find-pins", { body: since ? { since } : {} });
        since = r.since;
        total = { found: total.found + r.found, tried: total.tried + r.tried, remaining: r.remaining, stop: stopFinding.current };
        setFinding(total);
        if (r.remaining === 0 || stopFinding.current || (r.tried === 0 && r.found === 0)) break;
      }
      setNote(`Looked up ${plural(total.tried, "address", "addresses")}: ${plural(total.found, "pin")} found.${total.tried - total.found > 0 ? ` ${total.tried - total.found} couldn't be found: put ${total.tried - total.found === 1 ? "it" : "them"} on the map from the property's page (Property Pin Location).` : ""}`);
    } catch (e) { act.setError((e as Error).message); }
    setFinding(null);
    reload();
  };

  const draftSize = draft?.outline.length ? formatOutlineSize(outlineSqM(draft.outline)) : null;
  const drawingHint = drawing === "hole"
    ? "Click the corners of the pocket you don't serve, inside the outline. Click the first corner again (or press Enter) to finish."
    : "Click the map to place each corner of the outline. Click the first corner again (or double-click, or press Enter) to finish. You can draw over a neighbouring map code: this one is trimmed to its edge when you save.";

  return (
    <div className="mc-layout" data-lkeep>
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <MapCodesMap codes={shown} editing={draft ? { code: draft.code.trim(), color: draft.color, outline: draft.outline } : null}
          onEdit={(outline) => draft && setDraft({ ...draft, outline })} drawing={drawing} points={points}
          onAddPoint={(pt) => setPoints((p) => [...p, pt])} onFinish={finish} pins={pins} pinColor={pinColor} onSelect={open}
          imagery={imagery} fitKey={fitKey} focusKey={focus.key} focus={focus.outline} />
        <div className="row">
          <button type="button" className="btn sm" onClick={() => setPhoto(!photo)} title="Switch between the street map and the aerial photo">{photo ? "Street map" : "Aerial photo"}</button>
          <button type="button" className="btn sm" onClick={() => setFitKey((k) => k + 1)} title="Show every map code and every property">Show everything</button>
          <span className="muted" style={{ fontSize: 13 }}>
            {drawing ? drawingHint : draft ? "Drag a square to move a corner, drag a round dot to add one, double-click a corner to remove it." : "Each dot is a property, in the colour of the Map Code on it (grey: none). Click an outline to open it."}
          </span>
        </div>
      </div>

      <div className="stack mc-side">
        {note && <p className="notice" role="status" style={{ margin: 0 }}>{note}</p>}
        <ErrorBox error={state.error ?? props.error ?? act.error} />

        {draft ? (
          <div className="card stack" style={{ margin: 0 }}>
            <h2 style={{ margin: 0 }}>{draft.id ? `Map code ${codes.find((c) => c.id === draft.id)?.code ?? ""}` : "New map code"}</h2>
            <div className="formgrid">
              <label>Code *<input required maxLength={20} value={draft.code} autoFocus={!draft.id && !draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="801" /></label>
              <label>Name (optional)<input maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Central Norman" /></label>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <span className="todo-label">Colour</span>
              <div className="todo-colors" role="radiogroup" aria-label="Colour">
                {MAP_CODE_COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={draft.color.toLowerCase() === c} aria-label={c} style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} />)}
              </div>
            </div>
            {drawing ? (
              <>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>{points.length ? `${plural(points.length, "corner")} so far.` : drawing === "hole" ? "Drawing a hole." : "Drawing the outline."}</p>
                <div className="row">
                  <button type="button" className="btn primary" disabled={points.length < 3} onClick={finish} title="Close the outline (Enter)">Finish</button>
                  <button type="button" className="btn" disabled={!points.length} onClick={() => setPoints((p) => p.slice(0, -1))} title="Take off the last corner (Backspace)">Undo corner</button>
                  <button type="button" className="btn" onClick={stopDrawing} title="Stop drawing; the corners clicked so far are dropped (Esc)">Cancel drawing</button>
                </div>
              </>
            ) : (
              <>
                {draft.outline.length > 0 && (
                  <ul className="plain-list mc-parts">
                    {draft.outline.map((piece, i) => (
                      <li key={i}>
                        <span>{draft.outline.length > 1 ? `Piece ${i + 1}` : "Outline"} <span className="muted">· {formatOutlineSize(outlineSqM([piece]))} · {plural(piece[0].length, "corner")}</span></span>
                        <button type="button" className="linkbtn" onClick={() => setDraft({ ...draft, outline: draft.outline.filter((_, k) => k !== i) })}>Remove</button>
                        {piece.slice(1).map((hole, h) => (
                          <div key={h} className="mc-hole">
                            <span>Hole <span className="muted">· {formatOutlineSize(outlineSqM([[hole]]))}</span></span>
                            <button type="button" className="linkbtn" onClick={() => setDraft({ ...draft, outline: draft.outline.map((pc, k) => (k === i ? pc.filter((_, x) => x !== h + 1) : pc)) })}>Remove</button>
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="row">
                  <button type="button" className="btn" onClick={() => { setDrawing("piece"); setPoints([]); act.setError(null); }} title={draft.outline.length ? "Add a separate area under the same code" : "Click the corners of the area on the map"}>{draft.outline.length ? "Draw another piece" : "Draw the outline"}</button>
                  {draft.outline.length > 0 && <button type="button" className="btn" onClick={() => { setDrawing("hole"); setPoints([]); act.setError(null); }} title="Cut out a pocket inside the outline that you don't serve">Cut a hole</button>}
                </div>
                {draftSize && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{draftSize} · {properties(placed.inside.get(draft.id ?? "new") ?? 0)} inside (by their pins).</p>}
              </>
            )}
            <div className="row">
              <button type="button" className="btn primary" disabled={act.busy || !!drawing} onClick={save}>{act.busy ? "Working…" : "Save"}</button>
              <button type="button" className="btn" onClick={close}>Cancel</button>
              {draft.id && <button type="button" className="btn danger" disabled={act.busy} onClick={() => { const c = codes.find((x) => x.id === draft.id); if (c) remove(c); }}>Delete</button>}
            </div>
          </div>
        ) : (
          <>
            <div className="card stack" style={{ margin: 0 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>Map codes{codes.length ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {codes.length}</span> : null}</h2>
                {admin && <button type="button" className="btn primary" onClick={() => startNew()}><Icon name="plus" size={14} /> New map code</button>}
              </div>
              {codes.length ? (
                <ul className="plain-list mc-list">
                  {codes.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="mc-row" onClick={() => open(c.id)} title={admin ? "Open it to rename or redraw it" : "Show it on the map"}>
                        <span className="mc-swatch" style={{ background: c.color }} />
                        <strong>{c.code}</strong>
                        {c.name && <span>{c.name}</span>}
                        <span className="muted">{properties(placed.inside.get(c.id) ?? 0)} · {formatOutlineSize(outlineSqM(c.outline))}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : state.data ? <p className="muted" style={{ margin: 0 }}>No map codes yet.{admin ? " Click New map code and draw the first area on the map." : " An admin or owner draws them."}</p> : null}
              {admin && typed.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="todo-label">Codes typed on properties with no outline yet (click one to draw it)</span>
                  <div className="mc-typed">
                    {typed.map((t) => <button key={t.code} type="button" className="btn sm" onClick={() => startNew(t.code, t.pins)} title={`Start a map code ${t.code} and go to its ${properties(t.pins.length)}`}><span className="mc-swatch" style={{ background: mapCodeColor(t.code) }} /> {t.code} <span className="muted">{t.pins.length}</span></button>)}
                  </div>
                </div>
              )}
            </div>

            <div className="card stack" style={{ margin: 0 }}>
              <h2 style={{ margin: 0 }}>Automatic map codes <span className={`badge ${auto ? "ok" : ""}`}>{auto ? "On" : "Off"}</span></h2>
              {auto ? (
                <p style={{ margin: 0 }}>A property&apos;s Map Code is the code of the outline its pin is in. A new property gets it as it&apos;s added; redrawing an outline moves the properties it changes (you see the list first). A code typed by hand is left alone.</p>
              ) : (
                <p style={{ margin: 0 }}>Properties keep the Map Codes typed on them while you draw. When the outlines are ready, turn this on: every property with a pin takes the code of the outline it&apos;s in, replacing the typed code. You see the list of changes first.</p>
              )}
              {admin && (
                <div className="row">
                  {auto
                    ? <button type="button" className="btn" disabled={act.busy} onClick={() => { ask.setError(null); setAsking({ kind: "off" }); }}>Turn off</button>
                    : <button type="button" className="btn primary" disabled={act.busy || !codes.length} title={codes.length ? "Shows what changes on properties before anything is changed" : "Draw at least one map code first"} onClick={turnOn}>Turn on…</button>}
                </div>
              )}
            </div>

            <div className="card stack" style={{ margin: 0 }}>
              <h2 style={{ margin: 0 }}>Needs attention</h2>
              <details>
                <summary>{properties(placed.outside.length)} outside every outline</summary>
                <p className="muted" style={{ margin: "6px 0", fontSize: 13 }}>{auto ? "They have no Map Code unless one is typed by hand." : "With automatic map codes on they'd have no Map Code."} Draw or stretch an outline over them, or leave them out on purpose.</p>
                <ul className="plain-list mc-plan-list">
                  {placed.outside.slice(0, 300).map((q) => <li key={q.id}><Link href={`/properties/${q.id}`}>{q.address}</Link> <span className="muted">{q.mapCode ?? "no code"}{q.manual && q.mapCode ? " (by hand)" : ""}</span></li>)}
                  {placed.outside.length > 300 && <li className="muted">and {placed.outside.length - 300} more.</li>}
                </ul>
              </details>
              <details>
                <summary>{properties(noPin.length)} with no pin on the map</summary>
                <p className="muted" style={{ margin: "6px 0", fontSize: 13 }}>No outline can place a property without a pin. Find pins looks each address up; one that can&apos;t be found is put on the map from its own page (Property Pin Location).</p>
                <ul className="plain-list mc-plan-list">
                  {noPin.slice(0, 300).map((q) => <li key={q.id}><Link href={`/properties/${q.id}`}>{q.address}</Link> <span className="muted">{q.mapCode ?? "no code"}{q.tried ? " · address not found" : ""}</span></li>)}
                  {noPin.length > 300 && <li className="muted">and {noPin.length - 300} more.</li>}
                </ul>
              </details>
              {admin && noPin.length > 0 && (
                finding ? (
                  <div className="row">
                    <span role="status">Looking up addresses: {finding.found} found, {finding.remaining} to go…</span>
                    <button type="button" className="btn sm" disabled={finding.stop} onClick={() => { stopFinding.current = true; setFinding((f) => (f ? { ...f, stop: true } : f)); }}>{finding.stop ? "Stopping…" : "Stop"}</button>
                  </div>
                ) : <div><button type="button" className="btn" onClick={findPins} title="Looks up each address and sets its pin. Addresses in the counties you work in are quick; others take a few seconds each.">Find pins for {properties(noPin.length)}</button></div>
              )}
            </div>
          </>
        )}
      </div>

      {asking?.kind === "save" && draft && (
        <Dialog title={`Save ${draft.code.trim()}?`} action="Save and apply" busy={ask.busy} error={ask.error} onNo={() => setAsking(null)} onYes={() => ask.run(() => doSave(draft))}>
          {asking.check.trimmedBy.length > 0 && <p style={{ margin: 0 }}>The outline is trimmed to fit where it overlaps {listOf(asking.check.trimmedBy)}.</p>}
          {asking.check.plan && <PlanSummary plan={asking.check.plan} />}
        </Dialog>
      )}
      {asking?.kind === "delete" && (
        <Dialog title={`Delete map code ${asking.code.code}?`} action="Delete" danger busy={ask.busy} error={ask.error} onNo={() => setAsking(null)}
          onYes={() => ask.run(async () => { const r = await api<{ changed: number }>(`/map-codes/${asking.code.id}`, { method: "DELETE" }); close(); setAsking(null); reload(); setNote(`Deleted ${asking.code.code}.${r.changed ? ` ${properties(r.changed)} changed Map Code.` : ""}`); })}>
          <p style={{ margin: 0 }}>Its outline comes off the map. This can&apos;t be undone (it can be drawn again).</p>
          {asking.plan ? <PlanSummary plan={asking.plan} /> : <p className="muted" style={{ margin: 0 }}>Automatic map codes are off, so the codes on properties stay as they are.</p>}
        </Dialog>
      )}
      {asking?.kind === "on" && (
        <Dialog title="Turn on automatic map codes?" action="Turn on and apply" busy={ask.busy} error={ask.error} onNo={() => setAsking(null)}
          onYes={() => ask.run(async () => { const r = await api<{ changed: number }>("/map-codes/auto", { body: { on: true } }); setAsking(null); reload(); setNote(`Automatic map codes are on. ${properties(r.changed)} changed Map Code.`); })}>
          <p style={{ margin: 0 }}>Every property with a pin takes the code of the outline it&apos;s in. Codes typed on properties are replaced.</p>
          <PlanSummary plan={asking.plan} turningOn />
        </Dialog>
      )}
      {asking?.kind === "off" && (
        <Dialog title="Turn off automatic map codes?" action="Turn off" busy={ask.busy} error={ask.error} onNo={() => setAsking(null)}
          onYes={() => ask.run(async () => { await api("/map-codes/auto", { body: { on: false } }); setAsking(null); reload(); setNote("Automatic map codes are off. The codes on properties stay as they are."); })}>
          <p style={{ margin: 0 }}>The codes on properties stay as they are, and new properties stop getting one from the outlines. Outlines can be redrawn without moving any property.</p>
        </Dialog>
      )}
    </div>
  );
}

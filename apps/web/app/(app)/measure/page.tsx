"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MEASURE_KIND_LABELS, formatAcres, formatFeet, formatSqFt, measureTotals, shapeFeet, shapeSqFt,
  type LatLng, type MeasureKind, type MeasureShape,
} from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { OK_LEAF_OFF, OK_NAIP_2025, STREET_MAP, findWaybackVersions, waybackLayer, type ImageryLayer, type WaybackVersion } from "@/lib/imagery";
import { SHAPE_COLORS, type MapView } from "@/components/measure-map";

const MeasureMap = dynamic(() => import("@/components/measure-map").then((m) => m.MeasureMap), { ssr: false, loading: () => <div className="measure-map" /> });

const DEFAULT_VIEW: MapView = { lat: 35.2226, lng: -97.4395, zoom: 12 };
const VIEW_KEY = "measure.view";

const loadView = (): MapView => {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (v && typeof v.lat === "number" && typeof v.lng === "number" && typeof v.zoom === "number") return v;
  } catch { /* storage unavailable */ }
  return DEFAULT_VIEW;
};

const newId = () => Math.random().toString(36).slice(2, 10);
/** Two clicks this close together (about a foot) count as the same point, e.g. the clicks of a double-click. */
const samePoint = (a: LatLng, b: LatLng) => Math.abs(a[0] - b[0]) < 3e-6 && Math.abs(a[1] - b[1]) < 3e-6;

type Saved = { id: string; canEdit: boolean };
type ListRow = { id: string; name: string; address: string | null; netSqFt: number; updatedAt: string; createdByFirst: string | null; createdByLast: string | null; imagery: string | null };

const HINT: Record<MeasureKind, string> = {
  turf: "Click each corner of the turf. Double-click, press Enter, or click the first point to finish.",
  cut: "Trace a bed, driveway, patio or the house inside an area; it's subtracted from the total.",
  line: "Click along the path (e.g. a perimeter barrier). Double-click or press Enter to finish.",
};

export default function MeasurePage() {
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  const [viewKey, setViewKey] = useState(0);
  const center = useRef<MapView>(DEFAULT_VIEW);
  const [imageryKey, setImageryKey] = useState(OK_LEAF_OFF.key);
  const [wayback, setWayback] = useState<{ loading: boolean; versions: WaybackVersion[]; error: string | null; searched: boolean }>({ loading: false, versions: [], error: null, searched: false });
  const waybackAbort = useRef<AbortController | null>(null);
  const wantImagery = useRef<string | null>(null);

  const [shapes, setShapes] = useState<MeasureShape[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<MeasureKind | null>(null);
  const [draft, setDraft] = useState<LatLng[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [listQuery, setListQuery] = useState("");
  const list = useApi<ListRow[]>(`/measurements${listQuery ? `?q=${encodeURIComponent(listQuery)}` : ""}`);
  const mixes = useApi<{ sheets: { id: string; name: string; gallonsPerAcre: number }[] }>("/spray-mixes");
  const [sheetId, setSheetId] = useState("");
  const action = useAction();
  const finder = useAction();

  useEffect(() => {
    const v = loadView();
    setView(v);
    center.current = v;
    setViewKey((k) => k + 1);
  }, []);

  const layers: ImageryLayer[] = useMemo(() => [OK_LEAF_OFF, ...wayback.versions.map(waybackLayer), OK_NAIP_2025, STREET_MAP], [wayback.versions]);
  const imagery = layers.find((l) => l.key === imageryKey) ?? OK_LEAF_OFF;
  const imageryName = (l: ImageryLayer) => `${l.label} (${l.detail})`;

  const findDates = useCallback(async (at: MapView) => {
    waybackAbort.current?.abort();
    const ctrl = new AbortController();
    waybackAbort.current = ctrl;
    setWayback((w) => ({ ...w, loading: true, error: null }));
    try {
      setWayback((w) => ({ ...w, versions: [] }));
      const versions = await findWaybackVersions(at.lat, at.lng, Math.max(at.zoom, 17), ctrl.signal, (soFar) => {
        if (!ctrl.signal.aborted) setWayback((w) => ({ ...w, versions: soFar }));
      });
      if (ctrl.signal.aborted) return;
      setWayback({ loading: false, versions, error: null, searched: true });
      if (wantImagery.current) {
        const match = versions.map(waybackLayer).find((l) => imageryName(l) === wantImagery.current);
        if (match) setImageryKey(match.key);
        wantImagery.current = null;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setWayback((w) => ({ ...w, loading: false, error: "Couldn't load Esri's photo dates. Try again in a moment.", searched: true }));
    }
  }, []);

  const goTo = (v: MapView) => {
    setView(v);
    center.current = v;
    setViewKey((k) => k + 1);
    findDates(v);
  };

  const onMove = useCallback((v: MapView) => {
    center.current = v;
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* ignore */ }
  }, []);

  // Drawing
  const startDrawing = (kind: MeasureKind) => { setDrawing(kind); setDraft([]); setSelectedId(null); setMessage(null); };
  const cancelDrawing = () => { setDrawing(null); setDraft([]); };
  const onAddPoint = useCallback((pt: LatLng) => setDraft((d) => (d.length && samePoint(d[d.length - 1], pt) ? d : [...d, pt])), []);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const finish = useCallback(() => {
    const kind = drawingRef.current;
    const d = draftRef.current;
    if (!kind) return;
    const pts = d.filter((pt, i) => i === 0 || !samePoint(d[i - 1], pt));
    if (pts.length < (kind === "line" ? 2 : 3)) {
      setMessage(kind === "line" ? "A line needs at least 2 points." : "An area needs at least 3 corners.");
      return;
    }
    const shape: MeasureShape = { id: newId(), kind, label: "", points: pts };
    drawingRef.current = null;
    draftRef.current = [];
    setShapes((s) => [...s, shape]);
    setSelectedId(shape.id);
    setDrawing(null);
    setDraft([]);
    setDirty(true);
    setMessage(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (drawingRef.current) {
        if (e.key === "Enter") { e.preventDefault(); finish(); }
        else if (e.key === "Escape") cancelDrawing();
        else if (e.key === "Backspace" || (e.key === "z" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); setDraft((d) => d.slice(0, -1)); }
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        e.preventDefault();
        removeShape(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const updateShape = (id: string, patch: Partial<MeasureShape>) => { setShapes((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x))); setDirty(true); };
  const removeShape = (id: string) => { setShapes((s) => s.filter((x) => x.id !== id)); setSelectedId((sel) => (sel === id ? null : sel)); setDirty(true); };
  const onChangeShape = useCallback((id: string, points: LatLng[]) => { setShapes((s) => s.map((x) => (x.id === id ? { ...x, points } : x))); setDirty(true); }, []);

  const totals = measureTotals(shapes);
  const sheet = mixes.data?.sheets.find((s) => s.id === sheetId) ?? mixes.data?.sheets[0];

  // Address search
  const find = (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    finder.run(async () => {
      const r = await api("/measurements/geocode", { body: { query: q } });
      goTo({ lat: r.lat, lng: r.lng, zoom: 19 });
      if (!address && r.source !== "coordinates" && r.source !== "link") setAddress(r.label ?? q);
    });
  };

  const confirmDiscard = () => !dirty || !shapes.length || window.confirm("Discard the unsaved changes to this measurement?");

  const startNew = () => {
    if (!confirmDiscard()) return;
    setShapes([]); setSelectedId(null); setSaved(null); setName(""); setAddress(""); setNotes(""); setDirty(false); cancelDrawing(); setMessage(null);
  };

  const open = (id: string) => {
    if (!confirmDiscard()) return;
    action.run(async () => {
      const m = await api(`/measurements/${id}`);
      setShapes(m.shapes ?? []); setSelectedId(null); cancelDrawing();
      setSaved({ id: m.id, canEdit: m.canEdit });
      setName(m.name); setAddress(m.address ?? ""); setNotes(m.notes ?? ""); setDirty(false);
      if (m.imagery === imageryName(OK_LEAF_OFF)) setImageryKey(OK_LEAF_OFF.key);
      else if (m.imagery) wantImagery.current = m.imagery;
      goTo({ lat: m.lat, lng: m.lng, zoom: m.zoom });
      setMessage(`Opened “${m.name}”.`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const save = (asNew: boolean) => action.run(async () => {
    if (!name.trim()) throw new Error("Give the measurement a name (customer or property) before saving.");
    if (drawing) throw new Error("Finish or cancel the shape you're drawing first.");
    const v = center.current;
    const body = { name, address: address || null, notes: notes || null, lat: v.lat, lng: v.lng, zoom: Math.round(v.zoom), imagery: imageryName(imagery), shapes };
    const m = saved && saved.canEdit && !asNew
      ? await api(`/measurements/${saved.id}`, { method: "PUT", body })
      : await api("/measurements", { body });
    setSaved({ id: m.id, canEdit: true });
    setDirty(false);
    setMessage(`Saved “${m.name}”: ${formatSqFt(m.netSqFt)}.`);
    list.reload();
  });

  const remove = () => {
    if (!saved || !window.confirm(`Delete “${name}”? This can't be undone.`)) return;
    action.run(async () => {
      await api(`/measurements/${saved.id}`, { method: "DELETE" });
      setSaved(null); setDirty(true);
      setMessage("Deleted. The shapes are still on the map until you start a new measurement.");
      list.reload();
    });
  };

  return (
    <>
      <PageHead title="Property Measure" sub="Trace turf on winter aerial photos to measure square footage.">
        <button className="btn" onClick={startNew}>New Measurement</button>
      </PageHead>

      <form className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={find}>
        <label style={{ flex: "1 1 320px" }}>Find a property
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Street address, Google Maps link, or latitude, longitude" />
        </label>
        <button className="btn primary" disabled={finder.busy}>{finder.busy ? "Finding…" : "Find"}</button>
        <ErrorBox error={finder.error} />
      </form>

      <div className="measure-layout">
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <MeasureMap
            view={view} viewKey={viewKey} imagery={imagery} shapes={shapes} selectedId={selectedId}
            drawing={drawing} draft={draft} onAddPoint={onAddPoint} onFinish={finish} onSelect={setSelectedId}
            onChangeShape={onChangeShape} onMove={onMove}
          />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {drawing ? (
              <>
                <span className="muted" style={{ flex: "1 1 260px", fontSize: 14 }}>{HINT[drawing]}</span>
                <button className="btn sm primary" onClick={finish}>Finish</button>
                <button className="btn sm" onClick={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length}>Undo Point</button>
                <button className="btn sm" onClick={cancelDrawing}>Cancel</button>
              </>
            ) : (
              <>
                {(["turf", "cut", "line"] as const).map((k) => (
                  <button key={k} className="btn sm" onClick={() => startDrawing(k)}>
                    <span className="measure-dot" style={{ background: SHAPE_COLORS[k] }} /> {k === "turf" ? "Add Area" : k === "cut" ? "Add Cut-out" : "Measure Line"}
                  </button>
                ))}
                <span className="muted" style={{ fontSize: 13 }}>
                  {selectedId ? "Drag corners to adjust · drag a small dot to add a corner · right-click a corner to remove it · Delete removes the shape" : "Click a shape to adjust it."}
                </span>
              </>
            )}
          </div>
          {message && <p className="muted" role="status" style={{ margin: 0 }}>{message}</p>}
        </div>

        <div className="stack" style={{ gap: 12 }}>
          <div className="card stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>Total</h2>
            <div className="measure-total">{formatSqFt(totals.netSqFt)}</div>
            <div className="muted">{formatAcres(totals.netSqFt)}{totals.cutSqFt > 0 && ` · areas ${formatSqFt(totals.turfSqFt)} − cut-outs ${formatSqFt(totals.cutSqFt)}`}</div>
            {totals.lineFt > 0 && <div>Lines: <strong>{formatFeet(totals.lineFt)}</strong></div>}
            {!!mixes.data?.sheets.length && totals.netSqFt > 0 && (
              <div className="muted" style={{ fontSize: 14 }}>
                Spray: about <strong>{(totals.acres * (sheet?.gallonsPerAcre ?? 0)).toFixed(1)} gal</strong> at{" "}
                <select value={sheet?.id} onChange={(e) => setSheetId(e.target.value)} style={{ width: "auto", display: "inline-block", padding: "2px 4px" }} aria-label="Spray mix sheet">
                  {mixes.data.sheets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.gallonsPerAcre} gal/acre)</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="card stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0 }}>Shapes</h2>
            {!shapes.length && <span className="muted" style={{ fontSize: 14 }}>None yet. Use Add Area below the map and click around the turf.</span>}
            {shapes.map((s) => (
              <div key={s.id} className={`measure-shape${s.id === selectedId ? " selected" : ""}`} onClick={() => !drawing && setSelectedId(s.id)}>
                <span className="measure-dot" style={{ background: SHAPE_COLORS[s.kind] }} title={MEASURE_KIND_LABELS[s.kind]} />
                <input value={s.label ?? ""} onChange={(e) => updateShape(s.id, { label: e.target.value })} placeholder={MEASURE_KIND_LABELS[s.kind]} aria-label="Shape name" maxLength={80} />
                <span className="measure-size">{s.kind === "line" ? formatFeet(shapeFeet(s)) : `${s.kind === "cut" ? "−" : ""}${formatSqFt(shapeSqFt(s))}`}</span>
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); removeShape(s.id); }} aria-label="Remove shape" title="Remove">✕</button>
              </div>
            ))}
          </div>

          <div className="card stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0 }}>Aerial Photo</h2>
            {layers.map((l) => (
              <label key={l.key} className={`measure-layer${l.key === imagery.key ? " selected" : ""}`}>
                <input type="radio" name="imagery" checked={l.key === imagery.key} onChange={() => setImageryKey(l.key)} />
                <span>
                  <strong>{l.label}</strong>{l.leafOff && <span className="badge ok" style={{ marginLeft: 6 }}>Leaf-off</span>}
                  <span className="muted" style={{ display: "block", fontSize: 12 }}>{l.detail}</span>
                </span>
              </label>
            ))}
            <button className="btn sm" onClick={() => findDates(center.current)} disabled={wayback.loading}>
              {wayback.loading ? "Looking up Esri photo dates…" : wayback.searched ? "Find Esri photo dates here again" : "Find more photo dates here (Esri)"}
            </button>
            {wayback.searched && !wayback.loading && !wayback.versions.length && !wayback.error && <span className="muted" style={{ fontSize: 13 }}>No Esri photos found here.</span>}
            <ErrorBox error={wayback.error} />
            <span className="muted" style={{ fontSize: 12 }}>Photos marked Leaf-off were taken December to March. Your shapes stay put when you switch photos, so you can trace on a winter photo and check on another.</span>
          </div>

          <div className="card stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>{saved ? "Saved Measurement" : "Save"}</h2>
            <label>Name<input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="Customer or property" maxLength={120} /></label>
            <label>Address<input value={address} onChange={(e) => { setAddress(e.target.value); setDirty(true); }} maxLength={300} /></label>
            <label>Notes<textarea value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} rows={2} maxLength={2000} placeholder="e.g. Back yard behind fence; dog" /></label>
            <ErrorBox error={action.error} />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={action.busy} onClick={() => save(false)}>{saved?.canEdit ? "Save Changes" : "Save"}</button>
              {saved && <button className="btn" disabled={action.busy} onClick={() => save(true)}>Save as New</button>}
              {saved?.canEdit && <button className="btn danger" disabled={action.busy} onClick={remove}>Delete</button>}
            </div>
            {saved && !saved.canEdit && <span className="muted" style={{ fontSize: 13 }}>Someone else saved this one; Save keeps your changes as a new measurement.</span>}
            {dirty && saved && <span className="muted" style={{ fontSize: 13 }}>Unsaved changes.</span>}
          </div>
        </div>
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>Saved Measurements</h2>
          <form onSubmit={(e) => { e.preventDefault(); setListQuery((new FormData(e.currentTarget).get("q") as string).trim()); }} className="row" style={{ gap: 6, flex: "1 1 240px", maxWidth: 320 }}>
            <input name="q" placeholder="Search name or address" style={{ flex: 1, minWidth: 0 }} />
            <button className="btn sm">Search</button>
          </form>
        </div>
        <ErrorBox error={list.error} />
        {list.data && !list.data.length && <Empty>{listQuery ? "No measurements match." : "No saved measurements yet."}</Empty>}
        {!!list.data?.length && (
          <div style={{ overflowX: "auto" }}><table>
            <thead><tr><th>Name</th><th>Address</th><th style={{ textAlign: "right" }}>Area</th><th>Saved by</th><th>Updated</th><th /></tr></thead>
            <tbody>{list.data.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="muted">{m.address}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{formatSqFt(m.netSqFt)}</td>
                <td className="muted">{[m.createdByFirst, m.createdByLast].filter(Boolean).join(" ")}</td>
                <td className="muted">{fmtDate(m.updatedAt)}</td>
                <td><button className="btn sm" onClick={() => open(m.id)}>Open</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

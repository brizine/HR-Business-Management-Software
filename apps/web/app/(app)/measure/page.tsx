"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MEASURE_KIND_LABELS, MEASURE_ZONE_LABELS, formatAcres, formatFeet, formatSqFt, measureShapes, shapeSqFt, type MeasureZone,
  type LatLng, type MeasureKind, type MeasureShape,
} from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { OK_LEAF_OFF, OK_NAIP_2025, STREET_MAP, findWaybackVersions, sourceLayer, waybackLayer, type ImageryLayer, type WaybackVersion } from "@/lib/imagery";
import { PhotoSources, type ImageryList } from "@/components/photo-sources";
import { shapeColor, type MapView } from "@/components/measure-map";

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
type ListRow = { id: string; name: string; address: string | null; netSqFt: number; frontSqFt: number | null; backSqFt: number | null; updatedAt: string; createdByFirst: string | null; createdByLast: string | null; imagery: string | null };

/** Google's and Apple's own maps, opened at the current spot (their photos can't be traced inside this map). */
const OUTSIDE_MAPS: { label: string; hint: string; url: (v: MapView) => string }[] = [
  { label: "Google Maps", hint: "Google satellite view", url: (v) => `https://www.google.com/maps/@?api=1&map_action=map&center=${v.lat.toFixed(6)},${v.lng.toFixed(6)}&zoom=${Math.min(21, Math.round(v.zoom))}&basemap=satellite` },
  { label: "Google Earth", hint: "Google Earth on the web, with past photos", url: (v) => `https://earth.google.com/web/@${v.lat.toFixed(6)},${v.lng.toFixed(6)},300a,${Math.round(120 * 2 ** (19 - Math.min(21, v.zoom)))}d,35y,0h,0t,0r` },
  { label: "Apple Maps", hint: "Apple satellite view", url: (v) => `https://maps.apple.com/?ll=${v.lat.toFixed(6)},${v.lng.toFixed(6)}&z=${Math.min(20, Math.round(v.zoom))}&t=k` },
];

/** The drawing buttons under the map: kind of shape, and front/back yard for areas. */
const TOOLS: { label: string; kind: MeasureKind; zone: MeasureZone | null }[] = [
  { label: "Add Area", kind: "turf", zone: null },
  { label: "Add Front Area", kind: "turf", zone: "front" },
  { label: "Add Back Area", kind: "turf", zone: "back" },
  { label: "Add Cut-out", kind: "cut", zone: null },
  { label: "Measure Line", kind: "line", zone: null },
];

const HINT: Record<MeasureKind, string> = {
  turf: "Click each corner of the turf. Double-click, press Enter, or click the first point to finish.",
  cut: "Trace a bed, driveway, patio or the house over an area; the part inside the area is cut out of it.",
  line: "Click along the path (e.g. a perimeter barrier). Double-click or press Enter to finish.",
};

export default function MeasurePage() {
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  const [viewKey, setViewKey] = useState(0);
  const center = useRef<MapView>(DEFAULT_VIEW);
  const [imageryKey, setImageryKey] = useState("");
  const imageryList = useApi<ImageryList>("/measurements/imagery");
  const [wayback, setWayback] = useState<{ loading: boolean; versions: WaybackVersion[]; error: string | null; searched: boolean }>({ loading: false, versions: [], error: null, searched: false });
  const waybackAbort = useRef<AbortController | null>(null);
  const wantImagery = useRef<string | null>(null);

  const [shapes, setShapes] = useState<MeasureShape[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<MeasureKind | null>(null);
  const [drawZone, setDrawZone] = useState<MeasureZone | null>(null);
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

  // Leaf-off and admin-added photos first (the newest Oklahoma leaf-off is the default), then Esri's, then summer and streets.
  const layers: ImageryLayer[] = useMemo(() => {
    const sources = imageryList.data?.sources;
    const main = sources ? sources.filter((s) => s.origin === "custom" || s.leafOff).map(sourceLayer) : [OK_LEAF_OFF];
    const summer = sources ? sources.filter((s) => s.origin === "okmaps" && !s.leafOff).map(sourceLayer) : [OK_NAIP_2025];
    return [...main, ...wayback.versions.map(waybackLayer), ...summer, STREET_MAP];
  }, [imageryList.data, wayback.versions]);
  const imagery = layers.find((l) => l.key === imageryKey) ?? layers[0];
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

  /** Drops the Esri dates from the list (back to the standard photos); keeps the photo shown unless it was an Esri one. */
  const resetPhotos = () => {
    waybackAbort.current?.abort();
    wantImagery.current = null;
    setWayback({ loading: false, versions: [], error: null, searched: false });
    setImageryKey((k) => (k.startsWith("wb-") ? "" : k));
  };

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
  const startDrawing = (kind: MeasureKind, zone: MeasureZone | null = null) => { setDrawing(kind); setDrawZone(zone); drawZoneRef.current = zone; setDraft([]); setSelectedId(null); setMessage(null); };
  const drawZoneRef = useRef<MeasureZone | null>(null);
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
    const zone = kind === "turf" ? drawZoneRef.current : null;
    const shape: MeasureShape = { id: newId(), kind, label: "", points: pts, ...(zone ? { zone } : {}) };
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

  const totals = useMemo(() => measureShapes(shapes), [shapes]);
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
      const usedLayer = layers.find((l) => imageryName(l) === m.imagery);
      if (usedLayer) setImageryKey(usedLayer.key);
      else if (m.imagery) wantImagery.current = m.imagery;
      goTo({ lat: m.lat, lng: m.lng, zoom: m.zoom });
      setMessage(`Opened “${m.name}”.`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const save = (asNew: boolean) => action.run(async () => {
    if (!name.trim()) throw new Error("Give the measurement a name (customer or property) before saving.");
    if (drawing) throw new Error("Finish or cancel the measurement you're drawing first.");
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
      setMessage("Deleted. The measurements are still on the map until you start a new one.");
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
            drawing={drawing} drawZone={drawZone} draft={draft} onAddPoint={onAddPoint} onFinish={finish} onSelect={setSelectedId}
            onChangeShape={onChangeShape} onMove={onMove} result={totals}
          />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {drawing ? (
              <>
                <span className="muted" style={{ flex: "1 1 260px", fontSize: 14 }}>{drawing === "turf" && drawZone ? `${MEASURE_ZONE_LABELS[drawZone]}: ` : ""}{HINT[drawing]}</span>
                <button className="btn sm primary" onClick={finish}>Finish</button>
                <button className="btn sm" onClick={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length}>Undo Point</button>
                <button className="btn sm" onClick={cancelDrawing}>Cancel</button>
              </>
            ) : (
              <>
                {TOOLS.map((t) => (
                  <button key={t.label} className="btn sm" onClick={() => startDrawing(t.kind, t.zone)}>
                    <span className="measure-dot" style={{ background: shapeColor(t.kind, t.zone) }} /> {t.label}
                  </button>
                ))}
                <span className="muted" style={{ fontSize: 13 }}>
                  {selectedId ? "Drag corners to adjust · drag a small dot to add a corner · right-click a corner to remove it · Delete removes it" : "Click a measurement on the map to adjust it."}
                </span>
              </>
            )}
          </div>
          {message && <p className="muted" role="status" style={{ margin: 0 }}>{message}</p>}
          <div className="card stack" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <h2 style={{ margin: 0 }}>Aerial Photo</h2>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <button className="btn sm" onClick={() => findDates(center.current)} disabled={wayback.loading}>
                  {wayback.loading ? "Looking up Esri photo dates…" : wayback.searched ? "Find Esri photo dates here again" : "Find more photo dates here (Esri)"}
                </button>
                {(wayback.searched || wayback.loading) && <button className="btn sm" onClick={resetPhotos}>Back to Default Photos</button>}
              </div>
            </div>
            <div className="measure-layers">
              {layers.map((l) => (
                <label key={l.key} className={`measure-layer${l.key === imagery.key ? " selected" : ""}`}>
                  <input type="radio" name="imagery" checked={l.key === imagery.key} onChange={() => setImageryKey(l.key)} />
                  <span>
                    <strong>{l.label}</strong>{l.leafOff && <span className="badge ok" style={{ marginLeft: 6 }}>Leaf-off</span>}{l.isNew && <span className="badge warn" style={{ marginLeft: 6 }}>New</span>}
                    <span className="muted" style={{ display: "block", fontSize: 12 }}>{l.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            {wayback.searched && !wayback.loading && !wayback.versions.length && !wayback.error && <span className="muted" style={{ fontSize: 13 }}>No Esri photos found here.</span>}
            <ErrorBox error={wayback.error} />
            <span className="muted" style={{ fontSize: 12 }}>Photos marked Leaf-off were taken December to March. Your measurements stay put when you switch photos, so you can trace on a winter photo and check on another.</span>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Look at this spot in</span>
              {OUTSIDE_MAPS.map((m) => (
                <button key={m.label} className="btn sm" onClick={() => window.open(m.url(center.current), "_blank", "noopener")} title={m.hint}>{m.label} ↗</button>
              ))}
              <span className="muted" style={{ fontSize: 12, flexBasis: "100%" }}>Opens in a new tab at the spot shown on this map. Google Earth has past photos (the clock button) for finding a winter view.</span>
            </div>
            {imageryList.data?.canManage && <PhotoSources list={imageryList.data} onChange={(next) => imageryList.setData(next)} />}
          </div>
        </div>

        <div className="stack" style={{ gap: 12 }}>
          <div className="card stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>Total Area</h2>
            <div className="measure-total">{formatSqFt(totals.netSqFt)}</div>
            <div className="muted">{formatAcres(totals.netSqFt)}{totals.cutSqFt > 0 && ` · areas ${formatSqFt(totals.turfSqFt)} − cut-outs ${formatSqFt(totals.cutSqFt)}`}</div>
            <div className="measure-zone-totals">
              {(["front", "back"] as const).map((z) => (
                <div key={z}>
                  <span><span className="measure-dot" style={{ background: shapeColor("turf", z) }} /> Total {z === "front" ? "Front" : "Back"} Area</span>
                  <strong>{formatSqFt(z === "front" ? totals.frontSqFt : totals.backSqFt)}</strong>
                </div>
              ))}
            </div>
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
            <h2 style={{ margin: 0 }}>Measurements</h2>
            {!shapes.length && <span className="muted" style={{ fontSize: 14 }}>None yet. Use Add Area below the map and click around the turf.</span>}
            {shapes.map((s) => (
              <div key={s.id} className={`measure-shape${s.id === selectedId ? " selected" : ""}`} onClick={() => !drawing && setSelectedId(s.id)}>
                <span className="measure-dot" style={{ background: shapeColor(s.kind, s.zone) }} title={s.kind === "turf" && s.zone ? MEASURE_ZONE_LABELS[s.zone] : MEASURE_KIND_LABELS[s.kind]} />
                <input value={s.label ?? ""} onChange={(e) => updateShape(s.id, { label: e.target.value })} placeholder={s.kind === "turf" && s.zone ? MEASURE_ZONE_LABELS[s.zone] : MEASURE_KIND_LABELS[s.kind]} aria-label="Measurement name" maxLength={80} />
                {s.kind === "turf" && (
                  <select className="measure-zone" value={s.zone ?? ""} onClick={(e) => e.stopPropagation()} onChange={(e) => updateShape(s.id, { zone: (e.target.value || null) as MeasureZone | null })} aria-label="Front or back">
                    <option value="">Area</option>
                    <option value="front">Front</option>
                    <option value="back">Back</option>
                  </select>
                )}
                <span className="measure-size" title={s.kind === "turf" && shapeSqFt(s) - (totals.byId[s.id] ?? 0) > 0.5 ? `${formatSqFt(shapeSqFt(s))} before cut-outs` : undefined}>
                  {s.kind === "line" ? formatFeet(totals.byId[s.id] ?? 0) : `${s.kind === "cut" ? "−" : ""}${formatSqFt(totals.byId[s.id] ?? 0)}`}
                </span>
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); removeShape(s.id); }} aria-label="Remove measurement" title="Remove">✕</button>
              </div>
            ))}
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
          <h2 style={{ margin: 0 }}>Saved Measurements{list.data?.length ? <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}> · {list.data.length}{list.data.length >= 200 ? "+" : ""}{listQuery ? " found" : ""}</span> : null}</h2>
          <form onSubmit={(e) => { e.preventDefault(); setListQuery((new FormData(e.currentTarget).get("q") as string).trim()); }} className="row" style={{ gap: 6, flex: "1 1 240px", maxWidth: 320 }}>
            <input name="q" placeholder="Search name or address" style={{ flex: 1, minWidth: 0 }} />
            <button className="btn sm">Search</button>
          </form>
        </div>
        <ErrorBox error={list.error} />
        {list.data && !list.data.length && <Empty>{listQuery ? "No measurements match." : "No saved measurements yet."}</Empty>}
        {!!list.data?.length && (
          <div className="measure-saved"><table>
            <thead><tr><th>Name</th><th>Address</th><th style={{ textAlign: "right" }}>Front</th><th style={{ textAlign: "right" }}>Back</th><th style={{ textAlign: "right" }}>Total Area</th><th>Saved by</th><th>Updated</th><th /></tr></thead>
            <tbody>{list.data.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="muted">{m.address}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{m.frontSqFt ? formatSqFt(m.frontSqFt) : <span className="muted">—</span>}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{m.backSqFt ? formatSqFt(m.backSqFt) : <span className="muted">—</span>}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}><strong>{formatSqFt(m.netSqFt)}</strong></td>
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

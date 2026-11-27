"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import "leaflet/dist/leaflet.css";
import type { MeasureShape, MeasureZone } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { OK_LEAF_OFF, STREET_MAP, sourceLayer, type ImageryLayer } from "@/lib/imagery";
import { ErrorBox } from "./ui";

/**
 * The property's image: its saved Property Measure, drawn over the aerial photo. "Add image" picks
 * one (the ones for this address come first); picking it copies the measured sizes into the
 * property's Front Lawn ft, Back Lawn ft, Other ft and Total ft, which can then be changed by hand.
 */

type Measurement = {
  id: string; name: string; address: string | null; lat: number; lng: number; zoom: number; imagery: string | null;
  pinLat: number | null; pinLng: number | null; shapes: MeasureShape[]; netSqFt: number; frontSqFt: number | null; backSqFt: number | null; updatedAt: string;
};
type ListRow = { id: string; name: string; address: string | null; netSqFt: number; frontSqFt: number | null; backSqFt: number | null; updatedAt: string };
type ImageryList = { sources: Parameters<typeof sourceLayer>[0][] };

/** The same colours as Property Measure: areas green, front blue, back purple, cut-outs red, lines yellow. */
const COLORS = { turf: "#2ea043", cut: "#f85149", line: "#f0b429" } as const;
const ZONES: Record<MeasureZone, string> = { front: "#2f81f7", back: "#a371f7" };
const colorOf = (s: MeasureShape) => (s.kind === "turf" && s.zone ? ZONES[s.zone] : COLORS[s.kind]);
const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** A still picture of a saved measurement: the photo it was traced on, with its outlines. It can't be dragged or zoomed. */
export function MeasurePicture({ m, height = 240 }: { m: Measurement; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const imagery = useApi<ImageryList>("/measurements/imagery");
  // The photo it was traced on when that's still offered, else the newest leaf-off one.
  const layer: ImageryLayer = (() => {
    const all = (imagery.data?.sources ?? []).map(sourceLayer);
    return all.find((l) => `${l.label} (${l.detail})` === m.imagery) ?? (m.imagery?.startsWith(STREET_MAP.label) ? STREET_MAP : all.find((l) => l.leafOff) ?? all[0] ?? OK_LEAF_OFF);
  })();
  useEffect(() => {
    if (!el.current) return;
    let map: import("leaflet").Map | undefined;
    let cancelled = false;
    import("leaflet").then((L) => {
      if (cancelled || !el.current) return;
      map = L.map(el.current, { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.25 });
      (layer.kind === "wms"
        ? L.tileLayer.wms(layer.url, { layers: layer.layers, format: "image/jpeg", transparent: false, maxZoom: 22, attribution: layer.attribution })
        : L.tileLayer(layer.url, { maxZoom: 22, maxNativeZoom: layer.maxNativeZoom, attribution: layer.attribution })).addTo(map);
      const pts: [number, number][] = [];
      for (const s of m.shapes ?? []) {
        const ll = s.points.map((p) => [p[0], p[1]] as [number, number]);
        pts.push(...ll);
        if (s.kind === "line") L.polyline(ll, { color: colorOf(s), weight: 3 }).addTo(map);
        else L.polygon(ll, { color: colorOf(s), weight: 2, fillOpacity: s.kind === "cut" ? 0.35 : 0.25 }).addTo(map);
      }
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [18, 18], maxZoom: 21 });
      else map.setView([m.pinLat ?? m.lat, m.pinLng ?? m.lng], Math.min(m.zoom, 20));
    });
    return () => { cancelled = true; map?.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, m.updatedAt, layer.key]);
  return <div ref={el} className="prop-image-map" style={{ height }} role="img" aria-label={`Aerial photo of ${m.name} with its measured areas`} />;
}

/** What a measurement would put in the property's sizes. */
const sizesOf = (m: { netSqFt: number; frontSqFt: number | null; backSqFt: number | null }) => {
  const front = m.frontSqFt != null ? Math.round(m.frontSqFt) : null, back = m.backSqFt != null ? Math.round(m.backSqFt) : null, total = Math.round(m.netSqFt);
  const rest = front != null || back != null ? total - (front ?? 0) - (back ?? 0) : 0;
  return { front, back, other: rest > 0 ? rest : null, total };
};
const sizesText = (m: { netSqFt: number; frontSqFt: number | null; backSqFt: number | null }) => {
  const s = sizesOf(m);
  return [s.front != null && `front ${n(s.front)}`, s.back != null && `back ${n(s.back)}`, s.other != null && `other ${n(s.other)}`, `total ${n(s.total)} sq ft`].filter(Boolean).join(" · ");
};

/** The list to pick an image from: saved Property Measures, this address first. */
function ImagePicker({ street, onPick, onClose, busy }: { street: string; onPick: (id: string) => void; onClose: () => void; busy: boolean }) {
  const [q, setQ] = useState(street);
  const [rows, setRows] = useState<ListRow[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<ListRow[]>(`/measurements?q=${encodeURIComponent(q.trim())}`).then(setRows, () => setRows([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="stack prop-image-picker" style={{ gap: 6 }}>
      <label>Find a saved Property Measure<input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or address" /></label>
      {rows === null ? <span className="muted">Looking…</span> : rows.length ? (
        <ul className="plain-list" style={{ maxHeight: 220, overflowY: "auto" }}>
          {rows.slice(0, 12).map((r) => (
            <li key={r.id}>
              <button type="button" className="linkbtn" disabled={busy} onClick={() => onPick(r.id)} title="Use this as the property's image and take its sizes"><strong>{r.name}</strong></button>
              <span className="muted"> {r.address ? `· ${r.address} ` : ""}· {sizesText(r)} · {fmtDate(r.updatedAt)}</span>
            </li>
          ))}
        </ul>
      ) : <span className="muted">Nothing saved matches{q.trim() ? ` “${q.trim()}”` : ""}. Clear the box to see them all, or measure this property first.</span>}
      <div className="row">
        <Link className="btn" href="/measure" title="Open Property Measure to trace this property; save it there, then come back and add it">Measure this property</Link>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The Property Image item in the property box. `sizes` are the property's sizes now, so the box can
 * say when they no longer match the image (changed by hand, or the image was redrawn since).
 */
export function PropertyImage({ property, canEdit, onChanged }: {
  property: { id: string; street: string; measurementId: string | null; frontSqFt: number | null; backSqFt: number | null; otherSqFt: number | null; lawnSqFt: number | null };
  canEdit: boolean; onChanged: () => void;
}) {
  const m = useApi<Measurement>(property.measurementId ? `/measurements/${property.measurementId}` : null);
  const [picking, setPicking] = useState(false);
  const act = useAction();
  const link = (id: string) => act.run(async () => { await api(`/properties/${property.id}/measurement`, { body: { measurementId: id } }); setPicking(false); onChanged(); });
  const unlink = () => act.run(async () => { await api(`/properties/${property.id}/measurement`, { method: "DELETE" }); onChanged(); });
  const img = property.measurementId ? m.data : null;
  const s = img ? sizesOf(img) : null;
  const same = (a: number | null, b: number | null) => Math.round(a ?? 0) === Math.round(b ?? 0);
  const differs = !!s && !(same(s.front, property.frontSqFt) && same(s.back, property.backSqFt) && same(s.other, property.otherSqFt) && same(s.total, property.lawnSqFt));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {img ? (
        <>
          <MeasurePicture m={img} />
          <div className="muted" style={{ fontSize: 13 }}>
            <strong style={{ color: "var(--text)" }}>{img.name}</strong> · saved {fmtDate(img.updatedAt)} · {sizesText(img)}
          </div>
          {differs && (
            <div className="muted" style={{ fontSize: 13 }}>
              The sizes on this property differ from the image (changed by hand, or the image was redrawn).{" "}
              {canEdit && <button type="button" className="linkbtn" disabled={act.busy} onClick={() => link(img.id)} title="Replace Front Lawn ft, Back Lawn ft, Other ft and Total ft with the image's sizes">Use the image&apos;s sizes</button>}
            </div>
          )}
        </>
      ) : property.measurementId && m.loading ? <span className="muted">Loading the image…</span>
        : <span className="muted">No image yet. Add this property&apos;s saved Property Measure and its sizes fill in on their own.</span>}
      {picking ? <ImagePicker street={property.street} busy={act.busy} onPick={link} onClose={() => setPicking(false)} /> : canEdit && (
        <div className="row">
          <button type="button" className="btn" onClick={() => setPicking(true)}>{img ? "Change image" : "Add image"}</button>
          {img && <Link className="btn" href={`/measure?open=${img.id}`} title="Open this drawing in Property Measure to look closer or redraw it">Open in Property Measure</Link>}
          {img && <button type="button" className="btn" disabled={act.busy} onClick={unlink} title="Take the image off this property. The sizes stay as they are.">Remove image</button>}
        </div>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

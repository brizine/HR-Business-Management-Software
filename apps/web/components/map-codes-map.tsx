"use client";
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import type { LatLng, MapOutline } from "@crewdesk/shared";
import type { ImageryLayer } from "@/lib/imagery";

/**
 * The Map Codes page's map: every saved outline shaded in its colour with its code on it, the company's
 * properties as dots, and the outline being drawn or changed. Drawing is click, click, click, then back on
 * the first corner (or double-click, or Enter); a changed outline has a square on every corner to drag, a
 * small round dot between corners to drag out a new one, and a corner goes away on a double-click.
 */

export interface MapCodeShape { id: string; code: string; name: string | null; color: string; outline: MapOutline }
export interface MapPin { id: string; address: string; lat: number; lng: number; mapCode: string | null; manual: boolean }

interface Props {
  /** The saved outlines to show (the one being changed is left out: it's `editing`). */
  codes: MapCodeShape[];
  /** The outline being drawn or changed, with handles on its corners. */
  editing: { code: string; color: string; outline: MapOutline } | null;
  onEdit: (outline: MapOutline) => void;
  /** Drawing a new piece of the outline, or a hole in it. */
  drawing: "piece" | "hole" | null;
  points: LatLng[];
  onAddPoint: (p: LatLng) => void;
  onFinish: () => void;
  pins: MapPin[];
  /** The colour of a property's dot (by the code on it). */
  pinColor: (p: MapPin) => string;
  onSelect: (id: string) => void;
  imagery: ImageryLayer;
  /** Bumped to show everything: all the outlines and all the dots. */
  fitKey: number;
  /** Bumped (with `focus`) to go to one outline. */
  focusKey: number;
  focus: MapOutline | null;
}

/** How close (in screen pixels) a click has to be to an existing corner to land exactly on it. */
const SNAP_PX = 10;
const HIT = 24;
const NORMAN = { lat: 35.2226, lng: -97.4395, zoom: 11 };

export function MapCodesMap(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const base = useRef<Leaflet.Layer | null>(null);
  const outlines = useRef<Leaflet.LayerGroup | null>(null);
  const dots = useRef<Leaflet.FeatureGroup | null>(null);
  const edit = useRef<Leaflet.LayerGroup | null>(null);
  const draft = useRef<Leaflet.LayerGroup | null>(null);
  const band = useRef<Leaflet.Polyline | null>(null);
  const tip = useRef<Leaflet.Tooltip | null>(null);
  const props = useRef(p);
  props.current = p;
  const ready = useRef(false);

  /** Every corner on the map (saved outlines and the one being changed), to snap a new corner onto. */
  const corners = () => {
    const cur = props.current;
    const all: LatLng[] = [];
    for (const o of [...cur.codes.map((c) => c.outline), ...(cur.editing ? [cur.editing.outline] : [])]) for (const piece of o) for (const ring of piece) all.push(...ring);
    return all;
  };
  /** Where a click at this spot puts a corner: on an existing corner when it's close enough, else right there. */
  const snapped = (at: Leaflet.LatLng): LatLng => {
    const m = map.current!;
    const px = m.latLngToContainerPoint(at);
    let best: { pt: LatLng; d: number } | null = null;
    for (const c of corners()) {
      const d = m.latLngToContainerPoint(c).distanceTo(px);
      if (d <= SNAP_PX && (!best || d < best.d)) best = { pt: c, d };
    }
    return best ? (best as { pt: LatLng }).pt : [at.lat, at.lng];
  };

  useEffect(() => {
    let gone = false;
    import("leaflet").then((mod) => {
      if (gone || !el.current) return;
      L.current = mod;
      // Dots are drawn on a canvas, so a few thousand properties stay quick.
      const m = mod.map(el.current, { preferCanvas: true, maxZoom: 21, zoomSnap: 0.5 }).setView([NORMAN.lat, NORMAN.lng], NORMAN.zoom);
      map.current = m;
      outlines.current = mod.layerGroup().addTo(m);
      dots.current = mod.featureGroup().addTo(m);
      edit.current = mod.layerGroup().addTo(m);
      draft.current = mod.layerGroup().addTo(m);
      mod.control.scale({ imperial: true, metric: false }).addTo(m);
      tip.current = mod.tooltip({ direction: "top", offset: [0, -6] });
      // One tooltip for all the dots: the address and the code on it.
      dots.current.on("mouseover", (e: Leaflet.LeafletEvent) => {
        const pin = ((e as Leaflet.LeafletMouseEvent).propagatedFrom ?? (e as unknown as { layer: Leaflet.Layer }).layer) as Leaflet.CircleMarker & { options: { pin?: MapPin } };
        const q = pin?.options?.pin;
        if (!q || props.current.drawing) return;
        tip.current!.setLatLng([q.lat, q.lng]).setContent(`${escapeHtml(q.address)}<br><strong>${q.mapCode ? escapeHtml(q.mapCode) : "No map code"}</strong>${q.manual ? " (set by hand)" : ""}`).addTo(m);
      });
      dots.current.on("mouseout", () => tip.current?.remove());
      m.on("click", (e: Leaflet.LeafletMouseEvent) => { if (props.current.drawing) props.current.onAddPoint(snapped(e.latlng)); });
      m.on("dblclick", () => { if (props.current.drawing) props.current.onFinish(); });
      m.on("mousemove", (e: Leaflet.LeafletMouseEvent) => {
        const cur = props.current;
        if (!cur.drawing || !cur.points.length || !band.current) return;
        const at = snapped(e.latlng);
        band.current.setLatLngs([cur.points[cur.points.length - 1], at, ...(cur.points.length >= 2 ? [cur.points[0]] : [])]);
      });
      ready.current = true;
      setBase();
      drawOutlines();
      drawDots();
      drawEdit();
      drawDraft();
      fit();
    });
    return () => { gone = true; map.current?.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setBase() {
    const mod = L.current, m = map.current;
    if (!mod || !m) return;
    const img = props.current.imagery;
    base.current?.remove();
    base.current = (img.kind === "wms"
      ? mod.tileLayer.wms(img.url, { layers: img.layers, format: "image/jpeg", transparent: false, maxZoom: 21, attribution: img.attribution })
      : mod.tileLayer(img.url, { maxZoom: 21, maxNativeZoom: img.maxNativeZoom, attribution: img.attribution })).addTo(m);
    (base.current as Leaflet.TileLayer).bringToBack();
  }

  function drawOutlines() {
    const mod = L.current, layer = outlines.current;
    if (!mod || !layer) return;
    layer.clearLayers();
    for (const c of props.current.codes) {
      if (!c.outline.length) continue;
      const poly = mod.polygon(c.outline, { color: c.color, weight: 2, fillColor: c.color, fillOpacity: 0.18 });
      poly.bindTooltip(escapeHtml(c.code), { permanent: true, direction: "center", className: "measure-label mc-label" });
      poly.on("click", (e: Leaflet.LeafletMouseEvent) => {
        // While drawing, a click on a neighbour is a corner there (the outline is trimmed to fit when it's saved).
        if (props.current.drawing) return;
        mod.DomEvent.stopPropagation(e);
        props.current.onSelect(c.id);
      });
      poly.addTo(layer);
    }
  }

  function drawDots() {
    const mod = L.current, layer = dots.current;
    if (!mod || !layer) return;
    layer.clearLayers();
    const cur = props.current;
    for (const q of cur.pins) {
      const color = cur.pinColor(q);
      mod.circleMarker([q.lat, q.lng], { radius: 4, color: "#fff", weight: 1, fillColor: color, fillOpacity: 0.95, pin: q, bubblingMouseEvents: true } as Leaflet.CircleMarkerOptions).addTo(layer);
    }
  }

  function drawEdit() {
    const mod = L.current, layer = edit.current;
    if (!mod || !layer) return;
    layer.clearLayers();
    const e = props.current.editing;
    if (!e || !e.outline.length) return;
    const shape = mod.polygon(e.outline, { color: e.color, weight: 3, fillColor: e.color, fillOpacity: 0.28, interactive: false }).addTo(layer);
    if (e.code) shape.bindTooltip(escapeHtml(e.code), { permanent: true, direction: "center", className: "measure-label mc-label" });
    // No handles while another piece or a hole is being drawn: clicks there are new corners.
    if (props.current.drawing) return;
    const icon = (cls: string, size: number) => mod.divIcon({ className: "measure-handle-hit", html: `<span class="${cls}" style="width:${size}px;height:${size}px"></span>`, iconSize: [HIT, HIT] });
    // A working copy the handles change while they're dragged; let go, and the page gets the new outline.
    const work: MapOutline = e.outline.map((piece) => piece.map((ring) => ring.map((pt) => [...pt] as LatLng)));
    const commit = (next: MapOutline) => props.current.onEdit(next);
    work.forEach((piece, pi) => piece.forEach((ring, ri) => {
      ring.forEach((pt, i) => {
        const h = mod.marker(pt, { icon: icon("measure-handle", 9), draggable: true, keyboard: false, title: "Drag to move this corner · double-click to remove it" });
        h.on("drag", (ev) => { const ll = (ev.target as Leaflet.Marker).getLatLng(); ring[i] = [ll.lat, ll.lng]; shape.setLatLngs(work); });
        h.on("dragend", (ev) => { ring[i] = snappedExcept((ev.target as Leaflet.Marker).getLatLng(), ring[i]); commit(work); });
        h.on("click", (ev: Leaflet.LeafletMouseEvent) => mod.DomEvent.stop(ev));
        h.on("dblclick", (ev: Leaflet.LeafletMouseEvent) => {
          mod.DomEvent.stop(ev);
          if (ring.length > 3) commit(work.map((pc, a) => pc.map((r, b) => (a === pi && b === ri ? r.filter((_, k) => k !== i) : r))));
        });
        h.addTo(layer);
      });
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const h = mod.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { icon: icon("measure-handle mid", 7), draggable: true, keyboard: false, title: "Drag to add a corner here" });
        h.on("click dblclick", (ev: Leaflet.LeafletEvent) => mod.DomEvent.stop(ev as Leaflet.LeafletMouseEvent));
        h.on("dragend", (ev) => {
          const ll = (ev.target as Leaflet.Marker).getLatLng();
          commit(work.map((pc, x) => pc.map((r, y) => (x === pi && y === ri ? [...r.slice(0, i + 1), [ll.lat, ll.lng] as LatLng, ...r.slice(i + 1)] : r))));
        });
        h.addTo(layer);
      });
    }));
  }
  /** A dragged corner lands on a neighbour's corner when it's let go close to one (not on its own old spot). */
  function snappedExcept(at: Leaflet.LatLng, self: LatLng): LatLng {
    const m = map.current!;
    const px = m.latLngToContainerPoint(at);
    let best: { pt: LatLng; d: number } | null = null;
    for (const c of props.current.codes) for (const piece of c.outline) for (const ring of piece) for (const pt of ring) {
      const d = m.latLngToContainerPoint(pt).distanceTo(px);
      if (d <= SNAP_PX && (!best || d < best.d)) best = { pt, d };
    }
    return best ? (best as { pt: LatLng }).pt : self;
  }

  function drawDraft() {
    const mod = L.current, layer = draft.current, m = map.current;
    if (!mod || !layer || !m) return;
    layer.clearLayers();
    band.current = null;
    const cur = props.current;
    el.current?.classList.toggle("drawing", !!cur.drawing);
    if (cur.drawing) m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
    if (!cur.drawing) return;
    const color = cur.drawing === "hole" ? "#e5534b" : cur.editing?.color ?? "#2f81f7";
    if (cur.points.length) {
      mod.polyline(cur.points, { color, weight: 2.5, interactive: false }).addTo(layer);
      band.current = mod.polyline([], { color, weight: 1.5, dashArray: "5 5", interactive: false }).addTo(layer);
    }
    cur.points.forEach((pt, i) => {
      const first = i === 0 && cur.points.length >= 3;
      const dot = mod.circleMarker(pt, { radius: first ? 7 : 4, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 1, interactive: first });
      if (first) {
        dot.bindTooltip("Click here to finish", { direction: "top" });
        dot.on("click", (e: Leaflet.LeafletMouseEvent) => { mod.DomEvent.stop(e); props.current.onFinish(); });
      }
      dot.addTo(layer);
    });
  }

  function fit(only?: MapOutline | null) {
    const mod = L.current, m = map.current;
    if (!mod || !m) return;
    const cur = props.current;
    const pts: LatLng[] = [];
    const add = (o: MapOutline) => { for (const piece of o) pts.push(...piece[0]); };
    if (only) add(only);
    else {
      for (const c of cur.codes) add(c.outline);
      if (cur.editing) add(cur.editing.outline);
      for (const q of cur.pins) pts.push([q.lat, q.lng]);
    }
    if (pts.length) m.fitBounds(mod.latLngBounds(pts), { padding: [30, 30], maxZoom: 17 });
  }

  useEffect(() => { if (ready.current) setBase(); }, [p.imagery.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) drawOutlines(); }, [p.codes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) drawDots(); }, [p.pins, p.codes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) drawEdit(); }, [p.editing?.outline, p.editing?.color, p.editing?.code, p.drawing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) drawDraft(); }, [p.drawing, p.points, p.editing?.color]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) fit(); }, [p.fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current && p.focus) fit(p.focus); }, [p.focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="measure-map mc-map" role="application" aria-label="Map of the map codes" />;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

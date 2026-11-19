"use client";
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { formatFeet, formatSqFt, type LatLng, type MeasureKind, type MeasureResult, type MeasureShape, type MeasureZone } from "@crewdesk/shared";
import type { ImageryLayer } from "@/lib/imagery";

/** A red map pin with a white dot, tip at the bottom center. */
export const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36"><path d="M13 35s11-12.6 11-21.5A11 11 0 0 0 2 13.5C2 22.4 13 35 13 35z" fill="#e5383b" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13.5" r="4.2" fill="#fff"/></svg>';

export const SHAPE_COLORS: Record<MeasureKind, string> = { turf: "#2ea043", cut: "#f85149", line: "#f0b429" };
export const ZONE_COLORS: Record<MeasureZone, string> = { front: "#2f81f7", back: "#a371f7" };
/** Areas are green, front-yard areas blue, back-yard areas purple; cut-outs red, lines yellow. */
export const shapeColor = (kind: MeasureKind, zone?: MeasureZone | null) => (kind === "turf" && zone ? ZONE_COLORS[zone] : SHAPE_COLORS[kind]);

export interface MapView { lat: number; lng: number; zoom: number }

interface Props {
  view: MapView;
  /** Bumped to move the map to `view` (search, opening a saved measurement); ignored otherwise. */
  viewKey: number;
  imagery: ImageryLayer;
  shapes: MeasureShape[];
  selectedId: string | null;
  drawing: MeasureKind | null;
  /** Front or back yard, for an area being drawn. */
  drawZone?: MeasureZone | null;
  draft: LatLng[];
  onAddPoint: (p: LatLng) => void;
  onFinish: () => void;
  onSelect: (id: string | null) => void;
  onChangeShape: (id: string, points: LatLng[]) => void;
  onMove: (v: MapView) => void;
  /** Sizes after cut-outs, and each area's outline with its cut-outs as holes. */
  result: MeasureResult;
  /** Gives the page the map (for printing and exporting what's on screen). */
  onReady?: (map: Leaflet.Map, L: typeof Leaflet) => void;
  /** Points: the corner squares and midpoint circles for adjusting the selected measurement, and the dots
   *  placed while drawing (default on). */
  showHandles?: boolean;
  /** A pin on the property's house (from the address search); dragging it calls onMovePin. */
  pin?: { lat: number; lng: number; label?: string } | null;
  onMovePin?: (lat: number, lng: number) => void;
}

/**
 * The Measure page's map: aerial photo layer, saved shapes with their sizes, the shape being drawn,
 * and draggable corners on the selected shape (drag a corner to move it, drag a small midpoint dot to add one,
 * right-click a corner to remove it).
 */
export function MeasureMap(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const base = useRef<Leaflet.Layer | null>(null);
  const shapesLayer = useRef<Leaflet.LayerGroup | null>(null);
  const editLayer = useRef<Leaflet.LayerGroup | null>(null);
  const draftLayer = useRef<Leaflet.LayerGroup | null>(null);
  const pinMarker = useRef<Leaflet.Marker | null>(null);
  const props = useRef(p);
  props.current = p;
  const ready = useRef(false);
  const redraw = useRef<() => void>(() => {});

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    import("leaflet").then((mod) => {
      if (cancelled || !el.current) return;
      L.current = mod;
      const m = mod.map(el.current, { zoomControl: true, maxZoom: 22, doubleClickZoom: true }).setView([p.view.lat, p.view.lng], p.view.zoom);
      map.current = m;
      shapesLayer.current = mod.layerGroup().addTo(m);
      editLayer.current = mod.layerGroup().addTo(m);
      draftLayer.current = mod.layerGroup().addTo(m);
      mod.control.scale({ imperial: true, metric: false }).addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const cur = props.current;
        if (cur.drawing) cur.onAddPoint([e.latlng.lat, e.latlng.lng]);
        else cur.onSelect(null);
      });
      m.on("dblclick", () => { if (props.current.drawing) props.current.onFinish(); });
      m.on("moveend", () => { const c = m.getCenter(); props.current.onMove({ lat: c.lat, lng: c.lng, zoom: m.getZoom() }); });
      ready.current = true;
      props.current.onReady?.(m, mod);
      drawPin.current();
      setBase();
      redraw.current();
    });
    return () => { cancelled = true; map.current?.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setBase() {
    const mod = L.current, m = map.current;
    if (!mod || !m) return;
    const img = props.current.imagery;
    if (base.current) m.removeLayer(base.current);
    base.current = img.kind === "wms"
      ? mod.tileLayer.wms(img.url, { layers: img.layers, format: "image/jpeg", transparent: false, maxZoom: 22, attribution: img.attribution })
      : mod.tileLayer(img.url, { maxZoom: 22, maxNativeZoom: img.maxNativeZoom, attribution: img.attribution });
    base.current.addTo(m);
    (base.current as Leaflet.TileLayer).bringToBack();
  }

  useEffect(() => { if (ready.current) setBase(); }, [p.imagery.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ready.current && map.current) map.current.setView([p.view.lat, p.view.lng], p.view.zoom);
  }, [p.viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Double-click finishes a shape while drawing, so it mustn't also zoom.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (p.drawing) m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
    if (el.current) el.current.style.cursor = p.drawing ? "crosshair" : "";
  }, [p.drawing]);

  redraw.current = () => {
    const mod = L.current;
    if (!mod || !shapesLayer.current || !editLayer.current || !draftLayer.current) return;
    const cur = props.current;
    shapesLayer.current.clearLayers();
    editLayer.current.clearLayers();
    draftLayer.current.clearLayers();

    for (const s of cur.shapes) {
      const selected = s.id === cur.selectedId;
      const color = shapeColor(s.kind, s.zone);
      const style = { color, weight: selected ? 2.5 : 1.5, fillColor: color, fillOpacity: s.kind === "cut" ? 0.08 : 0.25, dashArray: s.kind === "cut" ? "5 4" : undefined };
      // An area is drawn with its cut-outs as holes, so the photo shows through where it's been cut.
      const holed = s.kind === "turf" ? cur.result.shapesWithHoles[s.id] : undefined;
      const layer = s.kind === "line" ? mod.polyline(s.points, style) : mod.polygon(holed?.length ? holed : s.points, style);
      const n = cur.result.byId[s.id] ?? 0;
      const size = s.kind === "line" ? formatFeet(n) : `${s.kind === "cut" ? "−" : ""}${formatSqFt(n)}`;
      layer.bindTooltip(`${s.label ? `${escapeHtml(s.label)}: ` : ""}${size}`, { permanent: true, direction: "center", className: "measure-label" });
      layer.on("click", (e: Leaflet.LeafletMouseEvent) => {
        if (props.current.drawing) return;
        mod.DomEvent.stopPropagation(e);
        props.current.onSelect(s.id);
      });
      layer.addTo(shapesLayer.current);
      if (selected && !cur.drawing && cur.showHandles !== false) addHandles(mod, s, layer as Leaflet.Polyline);
    }

    if (cur.drawing && cur.draft.length) {
      const color = shapeColor(cur.drawing, cur.drawZone);
      const closed = cur.drawing !== "line" && cur.draft.length >= 3;
      (closed ? mod.polygon(cur.draft, { color, weight: 1.5, dashArray: "4 4", fillOpacity: 0.15 }) : mod.polyline(cur.draft, { color, weight: 1.5, dashArray: "4 4" })).addTo(draftLayer.current);
      if (cur.showHandles !== false) cur.draft.forEach((pt, i) => {
        const first = i === 0 && cur.drawing !== "line" && cur.draft.length >= 3;
        const dot = mod.circleMarker(pt, { radius: first ? 5.5 : 3.5, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 1 });
        if (first) {
          dot.bindTooltip("Click to finish", { direction: "top" });
          dot.on("click", (e: Leaflet.LeafletMouseEvent) => { mod.DomEvent.stopPropagation(e); props.current.onFinish(); });
        }
        dot.addTo(draftLayer.current!);
      });
    }
  };

  function addHandles(mod: typeof Leaflet, s: MeasureShape, layer: Leaflet.Polyline) {
    const closed = s.kind !== "line";
    const pts = s.points.map((x) => [...x] as LatLng);
    const icon = (cls: string, size: number) => mod.divIcon({ className: cls, iconSize: [size, size] });
    const commit = (next: LatLng[]) => props.current.onChangeShape(s.id, next);

    pts.forEach((pt, i) => {
      const h = mod.marker(pt, { icon: icon("measure-handle", 9), draggable: true, keyboard: false, title: "Drag to move · right-click to remove" });
      h.on("drag", (e) => { const ll = (e.target as Leaflet.Marker).getLatLng(); pts[i] = [ll.lat, ll.lng]; layer.setLatLngs(pts); });
      h.on("dragend", () => commit(pts));
      h.on("contextmenu", (e: Leaflet.LeafletMouseEvent) => {
        mod.DomEvent.preventDefault(e.originalEvent);
        if (pts.length > (closed ? 3 : 2)) commit(pts.filter((_, k) => k !== i));
      });
      h.addTo(editLayer.current!);
    });

    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const mid: LatLng = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const h = mod.marker(mid, { icon: icon("measure-handle mid", 7), draggable: true, keyboard: false, title: "Drag to add a corner" });
      h.on("dragend", (e) => {
        const ll = (e.target as Leaflet.Marker).getLatLng();
        const next = [...pts];
        next.splice(i + 1, 0, [ll.lat, ll.lng]);
        commit(next);
      });
      h.addTo(editLayer.current!);
    }
  }

  useEffect(() => { redraw.current(); }, [p.shapes, p.selectedId, p.drawing, p.draft, p.result, p.showHandles]);

  // The house pin: draggable to fix where the address search put it; clicks go through to the map while drawing.
  const drawPin = useRef<() => void>(() => {});
  drawPin.current = () => {
    const mod = L.current, m = map.current;
    if (!mod || !m) return;
    pinMarker.current?.remove();
    pinMarker.current = null;
    const pin = props.current.pin;
    if (!pin) return;
    const drawing = !!props.current.drawing;
    const marker = mod.marker([pin.lat, pin.lng], {
      icon: mod.divIcon({ className: "measure-pin", html: PIN_SVG, iconSize: [26, 36], iconAnchor: [13, 35], tooltipAnchor: [0, -32] }),
      draggable: !drawing, interactive: !drawing, keyboard: false, zIndexOffset: 1000,
      title: drawing ? undefined : "Drag the pin onto the house",
    });
    if (pin.label && !drawing) marker.bindTooltip(pin.label, { direction: "top" });
    marker.on("dragend", () => { const ll = marker.getLatLng(); props.current.onMovePin?.(ll.lat, ll.lng); });
    marker.addTo(m);
    pinMarker.current = marker;
  };
  useEffect(() => { if (ready.current) drawPin.current(); }, [p.pin?.lat, p.pin?.lng, p.pin?.label, p.drawing]);

  return <div ref={el} className="measure-map" />;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

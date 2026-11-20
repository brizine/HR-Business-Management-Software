"use client";
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { SNAP_LABELS, bearingDeg, formatFeet, formatSqFt, snapDrawPoint, type LatLng, type MeasureKind, type MeasureResult, type MeasureShape, type MeasureZone, type SnapKind } from "@crewdesk/shared";
import type { ImageryLayer } from "@/lib/imagery";

/** How big the invisible grab area around each adjusting point is, in pixels. */
const HIT = 24;

/** The drawing crosshair: long red lines with a gap, a green box with red corner ticks, a green dot in the middle. */
const XH = 124;
const CROSSHAIR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${XH}" height="${XH}" viewBox="0 0 180 180">
  <g stroke="#ff2d2d" stroke-width="1.5" fill="none">
    <line x1="0" y1="90" x2="58" y2="90"/><line x1="122" y1="90" x2="180" y2="90"/>
    <line x1="90" y1="0" x2="90" y2="58"/><line x1="90" y1="122" x2="90" y2="180"/>
    <line x1="56" y1="56" x2="74" y2="74"/><line x1="124" y1="56" x2="106" y2="74"/>
    <line x1="56" y1="124" x2="74" y2="106"/><line x1="124" y1="124" x2="106" y2="106"/>
  </g>
  <rect class="xh-box" x="50" y="50" width="80" height="80" fill="none" stroke="#3fb950" stroke-width="2"/>
  <g stroke="#3fb950" stroke-width="1.5"><line x1="84" y1="90" x2="96" y2="90"/><line x1="90" y1="84" x2="90" y2="96"/></g>
  <circle cx="90" cy="90" r="2" fill="#3fb950"/>
</svg>`;

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
  /** Snap the next point to square corners, straight runs, 45°, north–south/east–west and nearby corners (default on). */
  snap?: boolean;
}

/**
 * The Measure page's map: aerial photo layer, saved shapes with their sizes, the shape being drawn,
 * and draggable corners on the selected shape (drag a corner to move it, drag a small midpoint dot to add one,
 * double-click a corner to remove it). Right-click closes the outline being drawn; right-drag moves a corner of
 * any measurement, even while drawing.
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
  /** While drawing: a line from the last point to the crosshair (and back to the first point for areas), with its length. */
  const previewLayer = useRef<Leaflet.LayerGroup | null>(null);
  const lastMouse = useRef<Leaflet.LatLng | null>(null);
  const lastSnap = useRef<SnapKind | null>(null);
  /** Where the mouse is on the map, in pixels (to re-snap when the map moves under it). */
  const cursorPx = useRef<Leaflet.Point | null>(null);
  const crosshair = useRef<HTMLDivElement | null>(null);
  /** Each measurement's layer on the map, by id (to redraw it live while a corner is right-dragged). */
  const shapeLayers = useRef(new Map<string, Leaflet.Polyline>());
  /**
   * A right-press on a corner is handled here (drag to move it; no drag = close the outline), so the browser's own
   * right-click event for that press is ignored. Browsers send it on press (Mac, Linux) or on release (Windows).
   */
  const rightOnCorner = useRef(false);
  const ignoreContextUntil = useRef(0);
  /**
   * Touchscreens: the crosshair stays put on the map's screen (starting in the middle); pan the map under it,
   * drag the crosshair, or tap to move it there, then press Drop Point. With a mouse it follows the mouse.
   */
  const touchMode = useRef(false);
  const dropButton = useRef<HTMLButtonElement | null>(null);
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
      previewLayer.current = mod.layerGroup().addTo(m);
      // The crosshair that follows the mouse while drawing (CSS hides the normal cursor then).
      const xh = document.createElement("div");
      xh.className = "measure-crosshair";
      xh.innerHTML = `${CROSSHAIR_SVG}<div class="xh-labels"><span class="xh-angle"></span><span class="xh-dist"></span><span class="xh-snap"></span></div>`;
      m.getContainer().appendChild(xh);
      crosshair.current = xh;
      // Touch: drag the crosshair by its box (without moving the map).
      const grab = document.createElement("div");
      grab.className = "xh-grab";
      xh.appendChild(grab);
      mod.DomEvent.disableClickPropagation(grab);
      grab.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        grab.setPointerCapture(ev.pointerId);
        const start = cursorPx.current ?? m.getSize().divideBy(2);
        const from = { x: ev.clientX, y: ev.clientY };
        const move = (e: PointerEvent) => {
          const size = m.getSize();
          cursorPx.current = mod.point(Math.max(0, Math.min(size.x, start.x + e.clientX - from.x)), Math.max(0, Math.min(size.y, start.y + e.clientY - from.y)));
          track.current();
        };
        const up = () => { grab.removeEventListener("pointermove", move); grab.removeEventListener("pointerup", up); grab.removeEventListener("pointercancel", up); };
        grab.addEventListener("pointermove", move);
        grab.addEventListener("pointerup", up);
        grab.addEventListener("pointercancel", up);
      });
      // Touch: the Drop Point button places a point where the crosshair is.
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "measure-drop";
      drop.innerHTML = "<span>+</span> Drop Point";
      mod.DomEvent.disableClickPropagation(drop);
      drop.addEventListener("click", () => { if (cursorPx.current) placeAt(cursorPx.current); });
      m.getContainer().appendChild(drop);
      dropButton.current = drop;
      const setTouch = (on: boolean) => {
        if (touchMode.current === on) return;
        touchMode.current = on;
        el.current?.classList.toggle("touch", on);
        if (on && props.current.drawing) cursorPx.current = m.getSize().divideBy(2);
        track.current();
      };
      if (window.matchMedia?.("(pointer: coarse)").matches) setTouch(true);
      m.getContainer().addEventListener("touchstart", () => setTouch(true), { passive: true });
      m.getContainer().addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") setTouch(false); });
      m.on("mousemove", (e: Leaflet.LeafletMouseEvent) => { if (touchMode.current) return; cursorPx.current = e.containerPoint; track.current(); });
      m.on("move zoom", () => track.current());
      m.on("mouseout", () => { if (touchMode.current) return; cursorPx.current = null; track.current(); });
      mod.control.scale({ imperial: true, metric: false }).addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => {
        const cur = props.current;
        if (!cur.drawing) return cur.onSelect(null);
        // Touch: a tap moves the crosshair there; Drop Point places the point.
        if (touchMode.current) { cursorPx.current = e.containerPoint; return track.current(); }
        placeAt(e.containerPoint);
      });
      m.on("dblclick", () => { if (props.current.drawing) props.current.onFinish(); });
      const container = m.getContainer();
      // Right-click while drawing closes the outline (like Finish); never shows the browser menu over the map.
      container.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        if (rightOnCorner.current || Date.now() < ignoreContextUntil.current) return;
        const cur = props.current;
        if (cur.drawing && cur.draft.length >= (cur.drawing === "line" ? 2 : 3)) cur.onFinish();
      }, true);
      // Right-drag a corner of any measurement to move it (even while drawing).
      container.addEventListener("mousedown", (ev) => {
        if (ev.button !== 2) return;
        const hit = cornerAt(m.mouseEventToContainerPoint(ev));
        if (!hit) return;
        ev.preventDefault();
        ev.stopPropagation();
        rightOnCorner.current = true;
        const shape = props.current.shapes.find((x) => x.id === hit.id);
        const layer = shapeLayers.current.get(hit.id);
        if (!shape || !layer) return;
        const pts = shape.points.map((x) => [...x] as LatLng);
        let moved = false;
        const move = (e: MouseEvent) => {
          let ll = m.mouseEventToLatLng(e);
          // With Snap on, land exactly on another measurement's corner when close.
          if (props.current.snap !== false) {
            const near = cornerAt(m.mouseEventToContainerPoint(e), hit);
            if (near) ll = mod.latLng(near.point[0], near.point[1]);
          }
          pts[hit.index] = [ll.lat, ll.lng];
          layer.setLatLngs(pts);
          moved = true;
        };
        const up = (e: MouseEvent) => {
          if (e.button !== 2) return;
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          rightOnCorner.current = false;
          ignoreContextUntil.current = Date.now() + 400;
          if (moved) return props.current.onChangeShape(hit.id, pts);
          // A right-click on a corner without dragging still closes the outline being drawn.
          const cur = props.current;
          if (cur.drawing && cur.draft.length >= (cur.drawing === "line" ? 2 : 3)) cur.onFinish();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }, true);
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
    el.current?.classList.toggle("drawing", !!p.drawing);
    // Touch: start each shape with the crosshair in the middle of the map.
    if (p.drawing && touchMode.current) cursorPx.current = m.getSize().divideBy(2);
    track.current();
  }, [p.drawing]);

  /** The measurement corner within reach of `pt` (screen pixels), nearest first; `skip` leaves out the corner being moved. */
  function cornerAt(pt: Leaflet.Point, skip?: { id: string; index: number }) {
    const m = map.current!;
    let best: { id: string; index: number; point: LatLng; d: number } | null = null;
    for (const s of props.current.shapes) {
      s.points.forEach((ll, index) => {
        if (skip && skip.id === s.id && skip.index === index) return;
        const d = m.latLngToContainerPoint(ll).distanceTo(pt);
        if (d <= HIT / 2 && (!best || d < best.d)) best = { id: s.id, index, point: ll, d };
      });
    }
    return best as { id: string; index: number; point: LatLng; d: number } | null;
  }

  /** Places the next point for the crosshair at `pt` (snapped); snapping onto the first point closes the shape. */
  function placeAt(pt: Leaflet.Point) {
    const cur = props.current;
    if (!cur.drawing) return;
    const s = snapAt(pt);
    const first = cur.draft[0];
    if (s.kind === "corner" && first && cur.drawing !== "line" && cur.draft.length >= 3 && s.latlng.equals(L.current!.latLng(first[0], first[1]), 1e-9)) return cur.onFinish();
    cur.onAddPoint([s.latlng.lat, s.latlng.lng]);
  }

  /** Where the next point would go for the mouse at `pt`: snapped (if Snap is on) or exactly there. */
  function snapAt(pt: Leaflet.Point): { latlng: Leaflet.LatLng; kind: SnapKind | null } {
    const m = map.current!;
    const cur = props.current;
    if (cur.snap === false || !cur.drawing) return { latlng: m.containerPointToLatLng(pt), kind: null };
    // Exact (unrounded) screen positions: Leaflet's latLngToContainerPoint rounds to whole pixels, which would
    // tilt a snapped line by a fraction of a degree.
    const origin = m.getPixelOrigin();
    const px = (ll: LatLng) => m.layerPointToContainerPoint(m.project(ll).subtract(origin));
    const d = cur.draft;
    const area = cur.drawing !== "line";
    const r = snapDrawPoint({ x: pt.x, y: pt.y }, {
      last: d.length ? px(d[d.length - 1]) : null,
      prev: d.length >= 2 ? px(d[d.length - 2]) : null,
      first: area && d.length >= 3 ? px(d[0]) : null,
      second: area && d.length >= 3 ? px(d[1]) : null,
      vertices: cur.shapes.flatMap((s) => s.points.map(px)),
    });
    // Snapped onto a corner: use that corner's exact spot, not the pixel round-trip.
    if (r.kind === "corner" && r.corner) {
      const all: LatLng[] = [...cur.shapes.flatMap((s) => s.points), ...(d.length ? [d[0]] : [])];
      const hit = all.find((ll) => { const q = px(ll); return Math.abs(q.x - r.corner!.x) < 0.5 && Math.abs(q.y - r.corner!.y) < 0.5; });
      if (hit) return { latlng: L.current!.latLng(hit[0], hit[1]), kind: "corner" };
    }
    return { latlng: m.containerPointToLatLng(L.current!.point(r.point.x, r.point.y)), kind: r.kind };
  }

  // Follow the mouse while drawing: work out the snapped spot, move the crosshair there, redraw the preview line.
  const track = useRef<() => void>(() => {});
  track.current = () => {
    const m = map.current, xh = crosshair.current;
    if (!m || !xh) return;
    const cur = props.current;
    if (dropButton.current) dropButton.current.style.display = cur.drawing && touchMode.current ? "inline-flex" : "none";
    if (!cur.drawing || !cursorPx.current) {
      xh.style.display = "none";
      lastMouse.current = null;
      lastSnap.current = null;
      drawPreview.current();
      return;
    }
    const s = snapAt(cursorPx.current);
    lastMouse.current = s.latlng;
    lastSnap.current = s.kind;
    const at = m.latLngToContainerPoint(s.latlng);
    xh.style.display = "block";
    xh.style.transform = `translate(${Math.round(at.x - XH / 2)}px, ${Math.round(at.y - XH / 2)}px)`;
    xh.classList.toggle("snapped", !!s.kind);
    const last = cur.draft[cur.draft.length - 1];
    const labels = xh.querySelector(".xh-labels") as HTMLElement;
    labels.style.display = last ? "" : "none";
    if (last) {
      const to: LatLng = [s.latlng.lat, s.latlng.lng];
      (xh.querySelector(".xh-angle") as HTMLElement).textContent = `${bearingDeg(last, to).toFixed(1)}°`;
      (xh.querySelector(".xh-dist") as HTMLElement).textContent = formatFeet(s.latlng.distanceTo(L.current!.latLng(last[0], last[1])) * 3.28084);
    }
    const snapTag = xh.querySelector(".xh-snap") as HTMLElement;
    snapTag.textContent = s.kind ? SNAP_LABELS[s.kind] : "";
    snapTag.style.display = s.kind ? "" : "none";
    drawPreview.current();
  };

  // The line that follows the crosshair while drawing, so the next point can be lined up.
  const drawPreview = useRef<() => void>(() => {});
  drawPreview.current = () => {
    const mod = L.current, layer = previewLayer.current, m = map.current;
    if (!mod || !layer || !m) return;
    layer.clearLayers();
    const cur = props.current;
    const at = lastMouse.current;
    if (!cur.drawing || !cur.draft.length || !at) return;
    const color = shapeColor(cur.drawing, cur.drawZone);
    const last = cur.draft[cur.draft.length - 1];
    // Solid while snapped, so it's clear the line has locked.
    const opts = { color, weight: lastSnap.current ? 2 : 1.5, dashArray: lastSnap.current ? undefined : "4 4", interactive: false };
    mod.polyline([last, [at.lat, at.lng]], opts).addTo(layer);
    if (cur.drawing !== "line" && cur.draft.length >= 2) {
      mod.polyline([[at.lat, at.lng], cur.draft[0]], { ...opts, opacity: 0.45 }).addTo(layer);
    }
  };

  redraw.current = () => {
    const mod = L.current;
    if (!mod || !shapesLayer.current || !editLayer.current || !draftLayer.current) return;
    const cur = props.current;
    shapesLayer.current.clearLayers();
    shapeLayers.current.clear();
    editLayer.current.clearLayers();
    draftLayer.current.clearLayers();
    track.current();

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
      shapeLayers.current.set(s.id, layer as Leaflet.Polyline);
      if (cur.showHandles !== false) {
        // The selected measurement (when not drawing) gets draggable handles; every other one shows its corners
        // as small dots (these can be right-dragged, even while drawing).
        if (selected && !cur.drawing) addHandles(mod, s, layer as Leaflet.Polyline);
        else for (const pt of s.points) {
          mod.circleMarker(pt, { radius: 3, color: "#fff", weight: 1.25, fillColor: color, fillOpacity: 1, interactive: false, className: "measure-corner" }).addTo(editLayer.current);
        }
      }
    }

    if (cur.drawing && cur.draft.length) {
      const color = shapeColor(cur.drawing, cur.drawZone);
      // Just the lines between the points so far: nothing is shaded until the outline is closed.
      mod.polyline(cur.draft, { color, weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(draftLayer.current);
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
    // The point looks small, but sits in a larger invisible grab area so it's easy to press and drag.
    const icon = (cls: string, size: number) =>
      mod.divIcon({ className: "measure-handle-hit", html: `<span class="${cls}" style="width:${size}px;height:${size}px"></span>`, iconSize: [HIT, HIT] });
    const commit = (next: LatLng[]) => props.current.onChangeShape(s.id, next);

    pts.forEach((pt, i) => {
      const h = mod.marker(pt, { icon: icon("measure-handle", 9), draggable: true, keyboard: false, title: "Drag (or right-drag) to move · double-click to remove" });
      h.on("drag", (e) => { const ll = (e.target as Leaflet.Marker).getLatLng(); pts[i] = [ll.lat, ll.lng]; layer.setLatLngs(pts); });
      h.on("dragend", () => commit(pts));
      // Clicks on a corner stay on the corner (they used to fall through and deselect the measurement).
      h.on("click", (e: Leaflet.LeafletMouseEvent) => mod.DomEvent.stop(e));
      h.on("dblclick", (e: Leaflet.LeafletMouseEvent) => {
        mod.DomEvent.stop(e);
        if (pts.length > (closed ? 3 : 2)) commit(pts.filter((_, k) => k !== i));
      });
      h.addTo(editLayer.current!);
    });

    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const mid: LatLng = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const h = mod.marker(mid, { icon: icon("measure-handle mid", 7), draggable: true, keyboard: false, title: "Drag to add a corner" });
      h.on("click dblclick", (e: Leaflet.LeafletEvent) => mod.DomEvent.stop(e as Leaflet.LeafletMouseEvent));
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
  useEffect(() => { track.current(); }, [p.snap]);

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

"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import type { Area, Truck } from "./data";

/**
 * The map both dispatch boards use: numbered pins for the day's stops (several at one address
 * stack into one pin with a count), route lines, where routes start and end, areas drawn on the
 * map, where people were last seen, a pin for a looked-up address, a lasso that selects every pin
 * inside a loop, and a mode for drawing a new area.
 */

export type MapPin = {
  key: string; lat: number; lng: number;
  /** What the pin says: "00", a stop number, or nothing. */
  label: string;
  colors: string[]; selected: boolean; tip: string;
  /** "waiting": a waiting-list service (an hourglass pin, left out of the lasso). */
  kind?: "event" | "waiting"; dim?: boolean;
};
export type MapLine = { id: string; color: string; points: [number, number][]; dashed?: boolean };
export type MapFlag = { key: string; lat: number; lng: number; label: string; kind: "start" | "end" | "both" };
export type MapHandle = { zoomIn(): void; zoomOut(): void; fit(): void; flyTo(lat: number, lng: number, zoom?: number): void };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inside = (pt: [number, number], poly: [number, number][]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

export const DispatchMap = forwardRef<MapHandle, {
  pins: MapPin[]; lines: MapLine[]; flags: MapFlag[]; areas: Area[]; trucks: Truck[];
  addressPin: { lat: number; lng: number; label: string } | null;
  showNumbers: boolean; satellite: boolean;
  /** Refit to the pins when this changes (the day, the filters). */
  fitKey: string;
  lasso: boolean; onLasso: (keys: string[]) => void;
  onPin: (keys: string[], e: { additive: boolean }) => void;
  onPinMenu?: (key: string, x: number, y: number) => void;
  /** Drawing a new area: the corners so far; a click adds one. */
  drawing: [number, number][] | null; onDrawPoint: (pt: [number, number]) => void;
  /** Picking a spot (a custom start or end): the next click is it. */
  picking: boolean; onPick: (pt: { lat: number; lng: number }) => void;
  children?: ReactNode;
}>(function DispatchMap(p, handle) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layers = useRef<{ tiles?: Leaflet.TileLayer; areas?: Leaflet.LayerGroup; lines?: Leaflet.LayerGroup; pins?: Leaflet.LayerGroup; extra?: Leaflet.LayerGroup; draw?: Leaflet.LayerGroup }>({});
  const [ready, setReady] = useState(false);
  const latest = useRef(p);
  latest.current = p;

  const bounds = () => {
    const Lf = L.current;
    if (!Lf) return null;
    const pts: [number, number][] = [...latest.current.pins.filter((x) => x.kind !== "waiting").map((x) => [x.lat, x.lng] as [number, number]), ...latest.current.flags.map((f) => [f.lat, f.lng] as [number, number])];
    return pts.length ? Lf.latLngBounds(pts) : null;
  };
  const fit = () => {
    const m = map.current, b = bounds();
    if (!m) return;
    if (!b) { m.setView([35.2226, -97.4395], 11); return; }
    if (b.getNorthEast().equals(b.getSouthWest())) m.setView(b.getCenter(), 15); else m.fitBounds(b, { padding: [48, 48], maxZoom: 16 });
  };
  useImperativeHandle(handle, () => ({
    zoomIn: () => map.current?.zoomIn(), zoomOut: () => map.current?.zoomOut(), fit,
    flyTo: (lat, lng, zoom = 16) => { const m = map.current; if (m) m.flyTo([lat, lng], Math.max(m.getZoom(), zoom), { duration: 0.6 }); },
  }));

  useEffect(() => {
    if (!el.current) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    import("leaflet").then((Lf) => {
      if (cancelled || !el.current) return;
      L.current = Lf;
      const m = Lf.map(el.current, { zoomControl: false, boxZoom: false, attributionControl: true });
      m.setView([35.2226, -97.4395], 11);
      layers.current = { areas: Lf.layerGroup().addTo(m), lines: Lf.layerGroup().addTo(m), pins: Lf.layerGroup().addTo(m), extra: Lf.layerGroup().addTo(m), draw: Lf.layerGroup().addTo(m) };
      m.on("click", (e) => {
        const now = latest.current;
        if (now.drawing) now.onDrawPoint([e.latlng.lat, e.latlng.lng]);
        else if (now.picking) now.onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
      map.current = m;
      // The panel changes size (split, map only, the waitlist opening): keep the map filled in.
      observer = new ResizeObserver(() => m.invalidateSize());
      observer.observe(el.current);
      setReady(true);
    });
    return () => { cancelled = true; observer?.disconnect(); map.current?.remove(); map.current = null; setReady(false); };
  }, []);

  // Streets or satellite.
  useEffect(() => {
    const m = map.current, Lf = L.current;
    if (!ready || !m || !Lf) return;
    layers.current.tiles?.remove();
    layers.current.tiles = (p.satellite
      ? Lf.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri" })
      : Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" })).addTo(m);
    layers.current.tiles.bringToBack();
  }, [ready, p.satellite]);

  useEffect(() => { if (ready) fit(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ready, p.fitKey]);

  // Areas.
  useEffect(() => {
    const Lf = L.current, g = layers.current.areas;
    if (!ready || !Lf || !g) return;
    g.clearLayers();
    for (const a of p.areas) Lf.polygon(a.points, { color: a.color, weight: 2, fillColor: a.color, fillOpacity: 0.12, interactive: false }).bindTooltip(a.name, { permanent: true, direction: "center", className: "dx-area-name" }).addTo(g);
  }, [ready, p.areas]);

  // Route lines.
  useEffect(() => {
    const Lf = L.current, g = layers.current.lines;
    if (!ready || !Lf || !g) return;
    g.clearLayers();
    for (const line of p.lines) {
      if (line.points.length < 2) continue;
      Lf.polyline(line.points, { color: "#ffffff", weight: 7, opacity: 0.9, interactive: false }).addTo(g);
      Lf.polyline(line.points, { color: line.color, weight: 4, opacity: 0.95, dashArray: line.dashed ? "6 8" : undefined, interactive: false }).addTo(g);
    }
  }, [ready, p.lines]);

  // Pins: one per address (several events at one spot stack, with a count), plus where routes start and end.
  useEffect(() => {
    const Lf = L.current, g = layers.current.pins;
    if (!ready || !Lf || !g) return;
    g.clearLayers();
    for (const f of p.flags) {
      Lf.marker([f.lat, f.lng], { icon: Lf.divIcon({ className: "", iconSize: [30, 30], html: `<div class="dx-flag" title="${escapeHtml(f.label)}">${f.kind === "start" ? "📍" : "🏁"}</div>` }), interactive: false, zIndexOffset: -200 }).addTo(g);
    }
    const spots = new Map<string, MapPin[]>();
    for (const pin of p.pins) { const k = `${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}`; spots.set(k, [...(spots.get(k) ?? []), pin]); }
    for (const group of spots.values()) {
      const first = group.find((x) => x.selected) ?? group[0];
      const anySelected = group.some((x) => x.selected);
      const [c1, c2] = [first.colors[0] ?? "#78716c", first.colors[1]];
      const fill = c2 ? `linear-gradient(90deg, ${c1} 50%, ${c2} 50%)` : c1;
      const waiting = first.kind === "waiting";
      const text = waiting ? "⧗" : p.showNumbers ? first.label : "";
      const html = `<div class="dx-pin${anySelected ? " sel" : ""}${waiting ? " waiting" : ""}${first.dim ? " dim" : ""}${first.label === "00" || waiting ? " plain" : ""}" style="--c:${fill}">${escapeHtml(text)}${group.length > 1 ? `<b>${group.length}</b>` : ""}</div>`;
      const marker = Lf.marker([first.lat, first.lng], { icon: Lf.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15], html }), zIndexOffset: anySelected ? 500 : waiting ? -100 : 0 });
      marker.bindTooltip(group.length > 1 ? group.map((x) => escapeHtml(x.tip)).join("<br>") : escapeHtml(first.tip), { direction: "top", offset: [0, -14] });
      marker.on("click", (e) => { const o = e.originalEvent as MouseEvent; latest.current.onPin(group.map((x) => x.key), { additive: o.shiftKey || o.metaKey || o.ctrlKey }); });
      marker.on("contextmenu", (e) => { const o = e.originalEvent as MouseEvent; o.preventDefault(); latest.current.onPinMenu?.(first.key, o.clientX, o.clientY); });
      marker.addTo(g);
    }
  }, [ready, p.pins, p.flags, p.showNumbers]);

  // Trucks and the looked-up address.
  useEffect(() => {
    const Lf = L.current, g = layers.current.extra;
    if (!ready || !Lf || !g) return;
    g.clearLayers();
    for (const t of p.trucks) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(t.at)) / 60_000));
      const initials = t.name.split(" ").map((w) => w[0]).slice(0, 2).join("");
      Lf.marker([t.lat, t.lng], { icon: Lf.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="dx-truck" style="--c:${t.color}">${escapeHtml(initials)}</div>` }), zIndexOffset: 300 })
        .bindTooltip(`${escapeHtml(t.name)} · Last seen ${mins < 1 ? "just now" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"} ago`}`, { direction: "top", offset: [0, -12] }).addTo(g);
    }
    if (p.addressPin) Lf.marker([p.addressPin.lat, p.addressPin.lng], { icon: Lf.divIcon({ className: "", iconSize: [26, 34], iconAnchor: [13, 32], html: `<div class="dx-address-pin"></div>` }), zIndexOffset: 400 }).bindTooltip(escapeHtml(p.addressPin.label), { direction: "top", offset: [0, -30] }).addTo(g);
  }, [ready, p.trucks, p.addressPin]);

  // A new area being drawn.
  useEffect(() => {
    const Lf = L.current, g = layers.current.draw;
    if (!ready || !Lf || !g) return;
    g.clearLayers();
    if (!p.drawing?.length) return;
    if (p.drawing.length > 2) Lf.polygon(p.drawing, { color: "#2563eb", weight: 2, dashArray: "6 6", fillOpacity: 0.1, interactive: false }).addTo(g);
    else Lf.polyline(p.drawing, { color: "#2563eb", weight: 2, dashArray: "6 6", interactive: false }).addTo(g);
    for (const pt of p.drawing) Lf.circleMarker(pt, { radius: 5, color: "#2563eb", fillColor: "#ffffff", fillOpacity: 1, weight: 2, interactive: false }).addTo(g);
  }, [ready, p.drawing]);

  // The lasso: press, drag a loop, release; every plotted stop inside is selected.
  useEffect(() => {
    const m = map.current, Lf = L.current, box = el.current;
    if (!ready || !m || !Lf || !box || !p.lasso) return;
    m.dragging.disable();
    let loop: [number, number][] | null = null;
    let line: Leaflet.Polyline | null = null;
    const at = (e: MouseEvent) => { const r = box.getBoundingClientRect(); const ll = m.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]); return [ll.lat, ll.lng] as [number, number]; };
    const down = (e: MouseEvent) => { if (e.button !== 0 || (e.target as HTMLElement).closest(".dx-map-tools, .leaflet-control")) return; loop = [at(e)]; line = Lf.polyline(loop, { color: "#2563eb", weight: 2, dashArray: "4 6" }).addTo(m); e.preventDefault(); };
    const move = (e: MouseEvent) => { if (!loop || !line) return; loop.push(at(e)); line.setLatLngs(loop); };
    const up = () => {
      if (!loop) return;
      const done = loop; loop = null; line?.remove(); line = null;
      if (done.length > 2) latest.current.onLasso(latest.current.pins.filter((x) => x.kind !== "waiting" && inside([x.lat, x.lng], done)).map((x) => x.key));
    };
    box.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { m.dragging.enable(); line?.remove(); box.removeEventListener("mousedown", down); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [ready, p.lasso]);

  return (
    <div className={`dx-map${p.lasso || p.drawing || p.picking ? " crosshair" : ""}`}>
      <div ref={el} className="dx-map-canvas" />
      {p.children}
    </div>
  );
});

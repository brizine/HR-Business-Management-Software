"use client";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { OK_LEAF_OFF, STREET_MAP, sourceLayer, type ImageryLayer } from "@/lib/imagery";
import { PIN_SVG } from "./measure-map";
import { ErrorBox } from "./ui";

/**
 * The property on the map: a pin where Crewdesk has it (routes, drive times and the weather use that
 * spot). "Update the pin on the map" lets the office drag it, or click the map, to put it on the
 * house or the driveway when the address lookup landed somewhere else; nothing changes until Save.
 */

type At = { lat: number; lng: number };
type ImageryList = { sources: Parameters<typeof sourceLayer>[0][] };
/** Where the map opens when a property has no pin and its address can't be found: the whole country, to zoom in from. */
const NOWHERE = { lat: 39.5, lng: -98.35, zoom: 4 };

export function PropertyMap({ property: p, canEdit, onChanged }: {
  property: { id: string; street: string; lat?: number | null; lng?: number | null };
  canEdit: boolean; onChanged: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const marker = useRef<Leaflet.Marker | null>(null);
  const base = useRef<Leaflet.Layer | null>(null);
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState(false);
  /** Where the pin is while it's being moved (not saved yet). `placed` is false until it's been put somewhere. */
  const [moving, setMoving] = useState<(At & { placed: boolean }) | null>(null);
  const imagery = useApi<ImageryList>("/measurements/imagery");
  const act = useAction();
  const saved: At | null = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
  const shown: At | null = moving ? (moving.placed ? moving : null) : saved;
  const open = !!saved || !!moving;
  // A different property in the same box: forget a half-made move.
  useEffect(() => { setMoving(null); }, [p.id]);

  // The map itself, made once there's something to show.
  useEffect(() => {
    if (!open || !el.current) return;
    let gone = false;
    import("leaflet").then((mod) => {
      if (gone || !el.current || map.current) return;
      L.current = mod;
      const start = saved ?? moving ?? NOWHERE;
      map.current = mod.map(el.current, { scrollWheelZoom: false, zoomSnap: 0.5 }).setView([start.lat, start.lng], saved || moving?.placed ? 18 : NOWHERE.zoom);
      setReady(true);
    });
    return () => { gone = true; map.current?.remove(); map.current = null; marker.current = null; base.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Street map or the aerial photo underneath.
  useEffect(() => {
    const mod = L.current, m = map.current;
    if (!ready || !mod || !m) return;
    const all = (imagery.data?.sources ?? []).map(sourceLayer);
    const layer: ImageryLayer = photo ? all.find((l) => l.leafOff) ?? all[0] ?? OK_LEAF_OFF : STREET_MAP;
    base.current?.remove();
    base.current = (layer.kind === "wms"
      ? mod.tileLayer.wms(layer.url, { layers: layer.layers, format: "image/jpeg", transparent: false, maxZoom: 21, attribution: layer.attribution })
      : mod.tileLayer(layer.url, { maxZoom: 21, maxNativeZoom: layer.maxNativeZoom, attribution: layer.attribution })).addTo(m);
  }, [ready, photo, imagery.data]);

  // The pin: where it's saved, or where it's been dragged to.
  useEffect(() => {
    const mod = L.current, m = map.current;
    if (!ready || !mod || !m) return;
    if (!shown) { marker.current?.remove(); marker.current = null; return; }
    if (!marker.current) {
      marker.current = mod.marker([shown.lat, shown.lng], { icon: mod.divIcon({ className: "measure-pin", html: PIN_SVG, iconSize: [26, 36], iconAnchor: [13, 35] }), keyboard: false, alt: `Pin for ${p.street}` }).addTo(m);
      marker.current.on("dragend", () => { const at = marker.current!.getLatLng(); setMoving({ lat: at.lat, lng: at.lng, placed: true }); });
    } else marker.current.setLatLng([shown.lat, shown.lng]);
    // Not being moved: keep the pin in the middle (after a save, or the address being found).
    if (!moving) m.setView([shown.lat, shown.lng], Math.max(m.getZoom(), 17));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, shown?.lat, shown?.lng, !!moving]);

  // While moving: the pin drags, and a click on the map puts it there.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    const on = !!moving;
    if (marker.current?.dragging) { if (on) marker.current.dragging.enable(); else marker.current.dragging.disable(); }
    if (!on) return;
    const click = (e: Leaflet.LeafletMouseEvent) => setMoving({ lat: e.latlng.lat, lng: e.latlng.lng, placed: true });
    m.on("click", click);
    el.current?.classList.add("moving");
    return () => { m.off("click", click); el.current?.classList.remove("moving"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, !!moving, !!marker.current]);

  /** Starts the pin where the map services find the address (to be checked, moved and saved). */
  const find = () => act.run(async () => {
    try {
      const at = await api<At>(`/properties/${p.id}/pin/find`, { method: "POST" });
      setMoving({ ...at, placed: true });
      map.current?.setView([at.lat, at.lng], 18);
    } catch (e) {
      // Not found: the map opens anyway, to click where it is.
      setMoving((cur) => cur ?? { ...(saved ?? NOWHERE), placed: !!saved });
      throw e;
    }
  });
  const save = () => act.run(async () => {
    if (!moving?.placed) throw new Error("Click the map where the property is first.");
    await api(`/properties/${p.id}/pin`, { method: "PUT", body: { lat: moving.lat, lng: moving.lng } });
    setMoving(null);
    onChanged();
  });

  return (
    <div className="stack" style={{ gap: 6 }}>
      {open ? <div ref={el} className="prop-image-map prop-map" style={{ height: 260 }} role="application" aria-label={`Map of ${p.street}`} />
        : <span className="muted">This property isn&apos;t on the map yet, so routes and drive times can&apos;t use it.</span>}
      {moving ? (
        <>
          <span className="muted" style={{ fontSize: 13 }}>{moving.placed ? "Drag the pin, or click the map, to put it on the house or the driveway. Then save." : "Zoom in and click the map where the property is."}</span>
          <div className="row">
            <button type="button" className="btn primary" disabled={act.busy || !moving.placed} onClick={save}>{act.busy ? "Working…" : "Save pin"}</button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => { setMoving(null); act.setError(null); }}>Cancel</button>
            <button type="button" className="btn" disabled={act.busy} onClick={find} title="Put the pin where the map services find this address">Find from the address</button>
            <button type="button" className="btn" onClick={() => setPhoto(!photo)} title="Switch between the street map and the aerial photo">{photo ? "Street map" : "Aerial photo"}</button>
          </div>
        </>
      ) : (
        <div className="row">
          {canEdit && saved && <button type="button" className="btn" onClick={() => setMoving({ ...saved, placed: true })} title="Move the pin onto the house or the driveway">Update the pin on the map</button>}
          {canEdit && !saved && <button type="button" className="btn" disabled={act.busy} onClick={find} title="Find the address on the map, then check the pin and save it">{act.busy ? "Looking…" : "Put it on the map"}</button>}
          {saved && <button type="button" className="btn" onClick={() => setPhoto(!photo)} title="Switch between the street map and the aerial photo">{photo ? "Street map" : "Aerial photo"}</button>}
          {saved && <a className="btn" href={`https://www.google.com/maps/search/?api=1&query=${saved.lat},${saved.lng}`} target="_blank" rel="noreferrer" title="Open this spot in Google Maps, for directions or street view">Open in Google Maps</a>}
        </div>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

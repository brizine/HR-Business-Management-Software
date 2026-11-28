"use client";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { parseCoordinates } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { OK_LEAF_OFF, STREET_MAP, sourceLayer, type ImageryLayer } from "@/lib/imagery";
import { PIN_SVG } from "./measure-map";
import { ErrorBox } from "./ui";

/**
 * The property's pin location: a pin where Crewdesk has it (routes, drive times and the weather use
 * that spot), over the aerial photo. "Update the pin on the map" lets the office drag it, or click the
 * map, to put it on the house or the driveway when the address lookup landed somewhere else; a
 * latitude and longitude typed (or pasted from Google Maps) puts it exactly there. Nothing changes
 * until Save.
 */

type At = { lat: number; lng: number };
type ImageryList = { sources: Parameters<typeof sourceLayer>[0][] };
/** Where the map opens when a property has no pin and its address can't be found: the whole country, to zoom in from. */
const NOWHERE = { lat: 39.5, lng: -98.35, zoom: 4 };
/** What was typed as a place: "35.2226, -97.4395", the same with only a space, or a pasted Google or Apple Maps link. */
const coordsOf = (text: string): At | null => {
  try { return parseCoordinates(text.trim().replace(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/, "$1, $2")); } catch { return null; }
};
/** Six decimals: about four inches on the ground, and what the pin is saved to. */
const coordsText = (at: At) => `${at.lat.toFixed(6)}, ${at.lng.toFixed(6)}`;

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
  /** The aerial photo is underneath unless someone switched; `null` is "not chosen". */
  const [choice, setChoice] = useState<boolean | null>(null);
  /** The address couldn't be found, so the map is the whole country to zoom in on: streets, as the aerial photos don't reach that far out. */
  const [hunting, setHunting] = useState(false);
  const photo = choice ?? !hunting;
  const [coords, setCoords] = useState("");
  const [copied, setCopied] = useState(false);
  /** Where the pin is while it's being moved (not saved yet). `placed` is false until it's been put somewhere. */
  const [moving, setMoving] = useState<(At & { placed: boolean }) | null>(null);
  const imagery = useApi<ImageryList>("/measurements/imagery");
  const act = useAction();
  const saved: At | null = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
  const shown: At | null = moving ? (moving.placed ? moving : null) : saved;
  const open = !!saved || !!moving;
  // A different property in the same box: forget a half-made move.
  useEffect(() => { setMoving(null); setHunting(false); setChoice(null); setCoords(""); }, [p.id]);

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

  // The aerial photo or the street map underneath.
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
      setHunting(false);
      setMoving({ ...at, placed: true });
      map.current?.setView([at.lat, at.lng], 18);
    } catch (e) {
      // Not found: the map opens anyway, to click where it is.
      if (!saved && !moving) setHunting(true);
      setMoving((cur) => cur ?? { ...(saved ?? NOWHERE), placed: !!saved });
      throw e;
    }
  });
  /** Puts the pin at a typed latitude and longitude (to be checked and saved, like any other move). */
  const lookUp = () => {
    const at = coordsOf(coords);
    if (!at) { act.setError("Type a latitude and longitude like 35.2226, -97.4395, or paste a Google Maps link."); return; }
    act.setError(null);
    setHunting(false);
    setMoving({ ...at, placed: true });
    map.current?.setView([at.lat, at.lng], Math.max(map.current.getZoom(), 18));
  };
  const stop = () => { setMoving(null); setHunting(false); setCoords(""); };
  const copy = () => {
    if (!saved) return;
    navigator.clipboard?.writeText(coordsText(saved)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => act.setError("Couldn't copy. Select the numbers and copy them instead."));
  };
  const save = () => act.run(async () => {
    if (!moving?.placed) throw new Error("Click the map where the property is first.");
    await api(`/properties/${p.id}/pin`, { method: "PUT", body: { lat: moving.lat, lng: moving.lng } });
    stop();
    onChanged();
  });

  const switcher = <button type="button" className="btn" onClick={() => setChoice(!photo)} title="Switch between the aerial photo and the street map">{photo ? "Street map" : "Aerial photo"}</button>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {open ? <div ref={el} className="prop-image-map prop-map" style={{ height: 260 }} role="application" aria-label={`Map of ${p.street}`} />
        : <span className="muted">This property isn&apos;t on the map yet, so routes and drive times can&apos;t use it.</span>}
      {moving ? (
        <>
          <span className="muted" style={{ fontSize: 13 }}>
            {moving.placed ? <>Drag the pin, or click the map, to put it on the house or the driveway. Then save. The pin is at <span className="prop-coords-value">{coordsText(moving)}</span> (not saved yet).</> : "Zoom in and click the map where the property is, or type its latitude and longitude below."}
          </span>
          <div className="row">
            <button type="button" className="btn primary" disabled={act.busy || !moving.placed} onClick={save}>{act.busy ? "Working…" : "Save pin"}</button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => { stop(); act.setError(null); }}>Cancel</button>
            <button type="button" className="btn" disabled={act.busy} onClick={find} title="Put the pin where the map services find this address">Find from the address</button>
            {switcher}
          </div>
        </>
      ) : (
        <>
          {saved && (
            <span className="muted" style={{ fontSize: 13 }}>
              Latitude, longitude: <span className="prop-coords-value">{coordsText(saved)}</span>{" "}
              <button type="button" className="linkbtn" onClick={copy} title="Copy the latitude and longitude, to paste into a map or a message">{copied ? "Copied" : "Copy"}</button>
            </span>
          )}
          <div className="row">
            {canEdit && saved && <button type="button" className="btn" onClick={() => setMoving({ ...saved, placed: true })} title="Move the pin onto the house or the driveway">Update the pin on the map</button>}
            {canEdit && !saved && <button type="button" className="btn" disabled={act.busy} onClick={find} title="Find the address on the map, then check the pin and save it">{act.busy ? "Looking…" : "Put it on the map"}</button>}
            {saved && switcher}
            {saved && <a className="btn" href={`https://www.google.com/maps/search/?api=1&query=${saved.lat},${saved.lng}`} target="_blank" rel="noreferrer" title="Open this spot in Google Maps, for directions or street view">Open in Google Maps</a>}
          </div>
        </>
      )}
      {canEdit && (
        <div className="row prop-coords">
          <label htmlFor={`pin-coords-${p.id}`}>Look up a latitude, longitude</label>
          <input id={`pin-coords-${p.id}`} value={coords} autoComplete="off" spellCheck={false} placeholder="35.2226, -97.4395 or a Google Maps link"
            onChange={(e) => { setCoords(e.target.value); if (act.error) act.setError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); lookUp(); } }} />
          <button type="button" className="btn" disabled={!coords.trim() || act.busy} onClick={lookUp} title="Put the pin at this latitude and longitude, to check on the map and save">Look up</button>
        </div>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

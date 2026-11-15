"use client";
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type Trail = {
  date: string; timeZone: string;
  entries: { id: string; clockIn: string; clockOut: string | null; clockInLat: number | null; clockInLng: number | null; clockOutLat: number | null; clockOutLng: number | null }[];
  points: { lat: number; lng: number; accuracy: number | null; at: string; timeEntryId: string }[];
};
type Stop = { lat: number; lng: number; at: string; kind: "in" | "out" | "point"; accuracy?: number | null };

const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

/** The stops in time order: clock-in, points recorded while clocked in, clock-out. */
function stops(t: Trail): Stop[] {
  const out: Stop[] = [];
  for (const e of t.entries) {
    if (e.clockInLat != null && e.clockInLng != null) out.push({ lat: e.clockInLat, lng: e.clockInLng, at: e.clockIn, kind: "in" });
    for (const p of t.points.filter((p) => p.timeEntryId === e.id)) out.push({ lat: p.lat, lng: p.lng, at: p.at, kind: "point", accuracy: p.accuracy });
    if (e.clockOut && e.clockOutLat != null && e.clockOutLng != null) out.push({ lat: e.clockOutLat, lng: e.clockOutLng, at: e.clockOut, kind: "out" });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Where someone was on a day while clocked in: a map with their route and a list of times. */
export function LocationTrail({ employeeId, name, date: initialDate, timeZone = "America/Chicago", onClose }: { employeeId: string; name: string; date?: string; timeZone?: string; onClose: () => void }) {
  const [date, setDate] = useState(initialDate ?? todayIn(timeZone));
  const trail = useApi<Trail>(`/time/locations?employeeId=${employeeId}&date=${date}`);
  const mapEl = useRef<HTMLDivElement>(null);
  const tz = trail.data?.timeZone ?? timeZone;
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz });
  const list = trail.data ? stops(trail.data) : [];

  useEffect(() => {
    if (!mapEl.current || !list.length) return;
    let map: import("leaflet").Map | undefined;
    let cancelled = false;
    import("leaflet").then((L) => {
      if (cancelled || !mapEl.current) return;
      map = L.map(mapEl.current, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
      const latlngs = list.map((s) => [s.lat, s.lng] as [number, number]);
      L.polyline(latlngs, { color: "#1f6feb", weight: 3, opacity: 0.7 }).addTo(map);
      for (const s of list) {
        const style = s.kind === "in" ? { color: "#1a7f37", radius: 9 } : s.kind === "out" ? { color: "#cf222e", radius: 9 } : { color: "#1f6feb", radius: 5 };
        L.circleMarker([s.lat, s.lng], { ...style, fillOpacity: 0.85, weight: 2 })
          .bindTooltip(`${s.kind === "in" ? "Clocked in" : s.kind === "out" ? "Clocked out" : "At"} ${time(s.at)}`)
          .addTo(map);
      }
      if (latlngs.length === 1) map.setView(latlngs[0], 16);
      else map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30], maxZoom: 17 });
    });
    return () => { cancelled = true; map?.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail.data]);

  return (
    <div className="card stack" data-lkeep="">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Location Trail: {name}</h2>
        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <label style={{ width: 170 }}>Day<input type="date" value={date} max={todayIn(tz)} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
      </div>
      <ErrorBox error={trail.error} />
      {trail.data && !list.length && <Empty>{trail.data.entries.length ? "Clocked in this day, but no locations were recorded (the app wasn't open, or location was off)." : "Not clocked in this day."}</Empty>}
      {list.length > 0 && (
        <>
          <div ref={mapEl} style={{ height: 380, borderRadius: 8, border: "1px solid var(--border)", zIndex: 0 }} />
          <div className="row muted" style={{ gap: 14, fontSize: 13 }}>
            <span><span style={{ color: "#1a7f37" }}>●</span> Clocked in</span>
            <span><span style={{ color: "#1f6feb" }}>●</span> Every few minutes while clocked in (app open)</span>
            <span><span style={{ color: "#cf222e" }}>●</span> Clocked out</span>
          </div>
          <details>
            <summary style={{ cursor: "pointer" }}>{list.length} location{list.length === 1 ? "" : "s"}: list</summary>
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Time</th><th>What</th><th>Location</th><th>Accuracy</th></tr></thead>
              <tbody>{list.map((s, i) => (
                <tr key={i}>
                  <td>{time(s.at)}</td>
                  <td>{s.kind === "in" ? "Clocked in" : s.kind === "out" ? "Clocked out" : "Location"}</td>
                  <td><a href={`https://maps.google.com/?q=${s.lat},${s.lng}`} target="_blank" rel="noreferrer">{s.lat.toFixed(5)}, {s.lng.toFixed(5)}</a></td>
                  <td className="muted">{s.accuracy != null ? `±${Math.round(s.accuracy)} m` : ""}</td>
                </tr>
              ))}</tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import { LOCATION_POLICIES, LOCATION_POLICY_LABELS, parseCoordinates, usesGeofence, type LocationPolicy } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

const HELP: Record<LocationPolicy, string> = {
  optional: "Location is recorded if the phone shares it. Nobody is blocked.",
  required: "Location must be turned on. Any place is fine.",
  geofence_flag: "Location must be on. Punches away from every job site go through but are flagged, and the manager is notified.",
  geofence_block: "Location must be on, and the punch is refused unless the person is at a job site.",
};

function Rules({ siteCount }: { siteCount: number }) {
  const { can } = useAuth();
  const { data, setData } = useApi("/time/location-policy");
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  if (!data) return null;
  const set = (key: "clockIn" | "clockOut", value: string) =>
    run(async () => {
      const next = { clockIn: data.clockIn, clockOut: data.clockOut, [key]: value };
      setData({ ...data, ...(await api("/time/location-policy", { method: "PUT", body: next })) });
      setSaved(true);
    });
  const geofenced = usesGeofence(data.clockIn) || usesGeofence(data.clockOut);

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Location rules</h2>
      <div className="formgrid">
        {(["clockIn", "clockOut"] as const).map((key) => (
          <div key={key} className="stack">
            <label>{key === "clockIn" ? "Clocking in" : "Clocking out"}
              <select value={data[key]} disabled={!can("admin") || busy} onChange={(e) => set(key, e.target.value)} aria-describedby={`${key}-help`}>
                {LOCATION_POLICIES.map((p) => <option key={p} value={p}>{LOCATION_POLICY_LABELS[p]}</option>)}
              </select>
            </label>
            <span id={`${key}-help`} className="muted" style={{ fontSize: 13 }}>{HELP[data[key] as LocationPolicy]}</span>
          </div>
        ))}
      </div>
      {geofenced && siteCount === 0 && (
        <p className="error" style={{ margin: 0 }}>No active job sites yet, so job-site rules currently act like &ldquo;Required&rdquo;. Add a site below.</p>
      )}
      <ErrorBox error={error} />
      {saved && <p className="muted" role="status" style={{ margin: 0 }}>Saved. Applies to the next punch.</p>}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {can("admin") ? "" : "Only admins can change these. "}Location is only recorded at the moment of each punch, never in between.
        Some states require telling employees in writing that you record location; check your state&apos;s rules.
        Managers can always fix or add time on the timesheet for someone who couldn&apos;t punch.
      </p>
    </div>
  );
}

function SiteForm({ onSaved }: { onSaved: () => void }) {
  const [where, setWhere] = useState("");
  const [locating, setLocating] = useState(false);
  const { busy, error, run, setError } = useAction();
  const coords = parseCoordinates(where);

  const useMine = () => {
    if (!navigator.geolocation) return setError("This browser can't share its location.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setWhere(`${p.coords.latitude.toFixed(6)}, ${p.coords.longitude.toFixed(6)}`); setLocating(false); },
      () => { setError("Couldn't get your location. Allow location for this site in the browser, or paste a map link."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const f = new FormData(form);
      if (!coords) return setError("Enter the site's location: paste a Google or Apple Maps link, type \"latitude, longitude\", or use your current location.");
      run(async () => {
        await api("/job-sites", { body: {
          name: f.get("name"), address: (f.get("address") as string) || undefined,
          lat: coords.lat, lng: coords.lng, radiusMeters: Number(f.get("radiusMeters")),
        } });
        form.reset();
        setWhere("");
        onSaved();
      });
    }}>
      <h2 style={{ margin: 0 }}>Add a job site</h2>
      <div className="formgrid">
        <label>Name<input name="name" required placeholder="e.g. North yard, Riverside HOA" /></label>
        <label>Address (for your reference)<input name="address" /></label>
        <label>Location
          <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Paste a Google Maps link, or 30.2672, -97.7431" aria-describedby="where-help" />
        </label>
        <label>Radius
          <select name="radiusMeters" defaultValue="150">
            {[50, 100, 150, 250, 500, 1000, 2000].map((m) => <option key={m} value={m}>{m >= 1000 ? `${m / 1000} km` : `${m} m`} ({Math.round(m * 3.281)} ft)</option>)}
          </select>
        </label>
      </div>
      <div id="where-help" className="row muted" style={{ fontSize: 13 }}>
        <button type="button" className="btn sm" onClick={useMine} disabled={locating}>{locating ? "Locating…" : "📍 Use my current location"}</button>
        {coords ? <span>Found {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} · <a href={`https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=17/${coords.lat}/${coords.lng}`} target="_blank" rel="noreferrer">check on a map</a></span>
          : <span>In Google Maps, right-click the spot and click the coordinates to copy them, or share the place and paste the link.</span>}
      </div>
      <ErrorBox error={error} />
      <div><button className="btn primary" disabled={busy}>Add site</button></div>
    </form>
  );
}

export default function JobSites() {
  const { can } = useAuth();
  const sites = useApi<any[]>("/job-sites");
  const active = (sites.data ?? []).filter((s) => s.active).length;

  return (
    <>
      <PageHead title="Job sites & location rules" sub="Where clocking in and out counts. Set separate rules for clocking in and clocking out." />
      <Rules siteCount={active} />
      <div className="card tablewrap">
        <h2>Job sites</h2>
        {sites.data?.length ? (
          <table>
            <thead><tr><th>Site</th><th>Radius</th><th>Status</th><th /></tr></thead>
            <tbody>{sites.data.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong><div className="muted">{s.address ? `${s.address} · ` : ""}<a href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${s.lat}/${s.lng}`} target="_blank" rel="noreferrer">map</a></div></td>
                <td>
                  {can("manager") ? (
                    <select aria-label={`Radius for ${s.name}`} value={s.radiusMeters} onChange={(e) => api(`/job-sites/${s.id}`, { method: "PATCH", body: { radiusMeters: Number(e.target.value) } }).then(sites.reload)} style={{ width: 120 }}>
                      {[...new Set([50, 100, 150, 250, 500, 1000, 2000, s.radiusMeters])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m >= 1000 ? `${m / 1000} km` : `${m} m`}</option>)}
                    </select>
                  ) : `${s.radiusMeters} m`}
                </td>
                <td>{s.active ? <Badge value="active" /> : <span className="badge">inactive</span>}</td>
                <td className="row">
                  {can("manager") && <button className="btn sm" onClick={() => api(`/job-sites/${s.id}`, { method: "PATCH", body: { active: !s.active } }).then(sites.reload)}>{s.active ? "Deactivate" : "Activate"}</button>}
                  {can("manager") && <button className="btn sm danger" onClick={() => confirm(`Delete ${s.name}?`) && api(`/job-sites/${s.id}`, { method: "DELETE" }).then(sites.reload)}>Delete</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No job sites yet.</Empty>}
        <p className="muted" style={{ fontSize: 13 }}>Deactivate a seasonal client site instead of deleting it. A punch counts as on site within the radius, plus up to 100 m for the phone&apos;s GPS uncertainty.</p>
      </div>
      {can("manager") && <SiteForm onSaved={sites.reload} />}
    </>
  );
}

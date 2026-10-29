"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { entryHours, formatDistance, needsLocation, usesGeofence, type LocationPolicy } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

function weekStart(offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

/** Where a punch happened: the job site, a flagged distance, or just a map link. */
function PunchPlace({ site, flag, distance, lat, lng }: { site: string | null; flag: string | null; distance: number | null; lat: number | null; lng: number | null }) {
  const map = lat != null && lng != null ? <a href={`https://maps.google.com/?q=${lat},${lng}`} target="_blank" rel="noreferrer">map</a> : null;
  if (flag) return <div><span className="badge warn">⚠ {distance != null ? `${formatDistance(distance)} from a job site` : "away from a job site"}</span> {map}</div>;
  if (site) return <div className="muted">📍 {site} {map && <>· {map}</>}</div>;
  return map ? <div className="muted">{map}</div> : null;
}

function ClockCard() {
  const status = useApi("/time/status");
  const { busy, error, run } = useAction();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const open = status.data?.openEntry;
  const rule: LocationPolicy = (open ? status.data?.locationPolicy?.clockOut : status.data?.locationPolicy?.clockIn) ?? "optional";
  const [result, setResult] = useState<string | null>(null);

  const punch = (kind: "clock-in" | "clock-out") =>
    run(async () => {
      setResult(null);
      const strict = needsLocation(rule);
      const pos = await new Promise<GeolocationPosition | null>((res) =>
        navigator.geolocation
          ? navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: strict ? 15000 : 5000, enableHighAccuracy: usesGeofence(rule) })
          : res(null),
      );
      if (strict && !pos) {
        throw new Error("Your company requires your location to clock in or out. Allow location for this site in your browser (the icon left of the address bar), then try again.");
      }
      const row = await api(`/time/${kind}`, {
        body: pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } : {},
      });
      const at = row.siteName ? ` at ${row.siteName}` : "";
      setResult(`${kind === "clock-in" ? "Clocked in" : "Clocked out"}${at}.${row.clockInFlag || row.clockOutFlag ? " This punch was away from a job site, so it's flagged for your manager." : ""}`);
      status.reload();
    });

  return (
    <div className="card">
      <h2>My time clock</h2>
      {open ? (
        <p>On the clock since <strong>{fmtDateTime(open.clockIn)}</strong> ({entryHours(open).toFixed(2)}h)</p>
      ) : <p className="muted">You are clocked out.</p>}
      {rule !== "optional" && (
        <p className="muted" style={{ marginTop: 0 }}>
          📍 {usesGeofence(rule) ? `Clock ${open ? "out" : "in"} at a job site${rule === "geofence_flag" ? " (punches elsewhere are flagged)" : ""}.` : `Location is required to clock ${open ? "out" : "in"}.`}
        </p>
      )}
      {result && <p role="status">{result}</p>}
      <ErrorBox error={error} />
      <button className="btn primary" disabled={busy || status.loading} onClick={() => punch(open ? "clock-out" : "clock-in")}>
        {open ? "Clock out" : "Clock in"}
      </button>
    </div>
  );
}

function ManagerView() {
  const [week, setWeek] = useState(0);
  const from = weekStart(week);
  const to = weekStart(week + 1);
  const range = `from=${from.toISOString()}&to=${to.toISOString()}`;
  const sheets = useApi<any[]>(`/time/timesheets?${range}`);
  const who = useApi<any[]>("/time/who-is-in");
  const [selected, setSelected] = useState<string | null>(null);
  const entries = useApi<any[]>(selected ? `/time/entries?employeeId=${selected}&${range}` : null);
  const [editing, setEditing] = useState<string | null>(null);

  const local = (d: string | null) => (d ? new Date(new Date(d).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

  return (
    <>
      <div className="card">
        <h2>On the clock now ({who.data?.length ?? 0})</h2>
        {who.data?.length ? (
          <div className="row">{who.data.map((w) => (
            <span key={w.entryId} className="badge ok">
              {w.firstName} {w.lastName} · since {new Date(w.clockIn).toLocaleTimeString([], { timeStyle: "short" })}
              {w.site ? ` · ${w.site}` : w.flag ? ` · ⚠ ${formatDistance(w.distance)} from a job site` : ""}
              {w.lat != null && <> · <a href={`https://maps.google.com/?q=${w.lat},${w.lng}`} target="_blank">map</a></>}
            </span>
          ))}</div>
        ) : <Empty>No one is clocked in.</Empty>}
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Timesheets: week of {from.toLocaleDateString()}</h2>
          <div className="row">
            <button className="btn sm" onClick={() => setWeek(week - 1)}>← Prev</button>
            <button className="btn sm" onClick={() => setWeek(0)}>This week</button>
            <button className="btn sm" onClick={() => setWeek(week + 1)}>Next →</button>
          </div>
        </div>
        {sheets.data?.length ? (
          <div className="tablewrap"><table>
            <thead><tr><th>Employee</th><th>Scheduled</th><th>Regular</th><th>Overtime</th><th>Total</th><th>Unapproved</th><th>Flagged</th><th /></tr></thead>
            <tbody>{sheets.data.map((s) => (
              <tr key={s.employeeId}>
                <td>{s.name} {s.clockedIn && <Badge value="active" />}</td>
                <td className="muted">{s.scheduledHours ? s.scheduledHours.toFixed(2) : "—"}</td>
                <td>{s.regularHours.toFixed(2)}</td>
                <td style={{ color: s.overtimeHours ? "var(--warn)" : undefined }}>{s.overtimeHours.toFixed(2)}</td>
                <td><strong>{s.totalHours.toFixed(2)}</strong></td>
                <td>{s.unapproved || "—"}</td>
                <td>{s.flagged ? <span className="badge warn" title="Punches away from a job site">{s.flagged}</span> : "—"}</td>
                <td><button className="btn sm" onClick={() => setSelected(selected === s.employeeId ? null : s.employeeId)}>{selected === s.employeeId ? "Hide" : "Entries"}</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No time recorded this week.</Empty>}
      </div>
      {selected && entries.data && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Entries</h2>
            <button className="btn primary sm" onClick={() => {
              const ids = entries.data!.filter((e) => !e.approvedAt && e.clockOut).map((e) => e.id);
              if (ids.length) api("/time/entries/approve", { body: { ids } }).then(() => { entries.reload(); sheets.reload(); });
            }}>Approve all</button>
          </div>
          <table>
            <thead><tr><th>In</th><th>Out</th><th>Hours</th><th>Status</th><th /></tr></thead>
            <tbody>{entries.data.map((e) => editing === e.id ? (
              <tr key={e.id}><td colSpan={5}>
                <form className="row" onSubmit={(ev) => {
                  ev.preventDefault();
                  const f = new FormData(ev.currentTarget);
                  const clockOut = f.get("clockOut") as string;
                  api(`/time/entries/${e.id}`, { method: "PATCH", body: {
                    clockIn: new Date(f.get("clockIn") as string).toISOString(),
                    clockOut: clockOut ? new Date(clockOut).toISOString() : null,
                    note: (f.get("note") as string) || undefined,
                  } }).then(() => { setEditing(null); entries.reload(); sheets.reload(); }, (err) => alert(err.message));
                }}>
                  <input type="datetime-local" name="clockIn" defaultValue={local(e.clockIn)} style={{ width: 200 }} required />
                  <input type="datetime-local" name="clockOut" defaultValue={local(e.clockOut)} style={{ width: 200 }} />
                  <input name="note" placeholder="Reason for edit" defaultValue={e.note ?? ""} style={{ width: 200 }} />
                  <button className="btn primary sm">Save</button>
                  <button type="button" className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              </td></tr>
            ) : (
              <tr key={e.id}>
                <td>{fmtDateTime(e.clockIn)}<PunchPlace site={e.clockInSite} flag={e.clockInFlag} distance={e.clockInDistance} lat={e.clockInLat} lng={e.clockInLng} /></td>
                <td>{e.clockOut ? fmtDateTime(e.clockOut) : <Badge value="active" />}{e.clockOut && <PunchPlace site={e.clockOutSite} flag={e.clockOutFlag} distance={e.clockOutDistance} lat={e.clockOutLat} lng={e.clockOutLng} />}</td>
                <td>{entryHours(e).toFixed(2)}</td>
                <td>{e.approvedAt ? <Badge value="approved" /> : <Badge value="pending" />}</td>
                <td><button className="btn sm" onClick={() => setEditing(e.id)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MyEntries() {
  const from = weekStart(-1).toISOString();
  const { data } = useApi<any[]>(`/time/entries?from=${from}`);
  return (
    <div className="card">
      <h2>My recent time</h2>
      {data?.length ? (
        <table>
          <thead><tr><th>In</th><th>Out</th><th>Hours</th><th>Status</th></tr></thead>
          <tbody>{data.map((e) => (
            <tr key={e.id}>
              <td>{fmtDateTime(e.clockIn)}</td>
              <td>{e.clockOut ? fmtDateTime(e.clockOut) : "—"}</td>
              <td>{entryHours(e).toFixed(2)}</td>
              <td>{e.approvedAt ? <Badge value="approved" /> : <Badge value="pending" />}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <Empty>No entries in the last two weeks.</Empty>}
    </div>
  );
}

export default function Time() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Time clock" sub="Clock in and out, review timesheets, fix missed punches">
        {can("manager") && <Link className="btn" href="/job-sites">Job sites & location rules</Link>}
      </PageHead>
      <ClockCard />
      {can("manager") ? <ManagerView /> : <MyEntries />}
    </>
  );
}

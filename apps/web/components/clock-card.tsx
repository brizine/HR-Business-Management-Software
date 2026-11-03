"use client";
import { useEffect, useState } from "react";
import { entryHours, needsLocation, usesGeofence, type LocationPolicy } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/** Clock in or out as the signed-in person (Time clock page and their own employee page). */
export function ClockCard({ title = "My time clock" }: { title?: string }) {
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
      <h2>{title}</h2>
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

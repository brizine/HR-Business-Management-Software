"use client";
import Link from "next/link";
import { entryHours } from "@crewdesk/shared";
import { fmtDateTime } from "@/lib/api";
import { useApi } from "@/lib/hooks";

/** For time clock managers on someone else's employee page: are they on the clock right now. */
export function ClockStatusBox({ employeeId, firstName }: { employeeId: string; firstName: string }) {
  const working = useApi<any[]>("/time/who-is-in");
  const entry = working.data?.find((w) => w.employeeId === employeeId);
  return (
    <div className="card">
      <h2>Clock in</h2>
      {working.loading && !working.data ? <p className="muted">Loading…</p> : entry ? (
        <p>{firstName} has been on the clock since <strong>{fmtDateTime(entry.clockIn)}</strong> ({entryHours({ clockIn: entry.clockIn, clockOut: null }).toFixed(2)}h){entry.site ? ` at ${entry.site}` : ""}.</p>
      ) : <p className="muted">{firstName} is clocked out.</p>}
      <p className="muted" style={{ marginBottom: 0 }}>
        Only {firstName} can clock in, from their own phone or computer. To fix or add time, use the <Link href="/time">Time clock</Link> page.
      </p>
    </div>
  );
}

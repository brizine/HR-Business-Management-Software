"use client";
import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { fmtDate } from "@/lib/api";
import { Badge, Empty, ErrorBox, PageHead, Stat } from "@/components/ui";

export default function Dashboard() {
  const { data, error } = useApi("/dashboard");
  const due = useApi<any[]>("/assets/maintenance/due");
  const pto = useApi<any[]>("/pto/requests?status=pending");

  return (
    <>
      <PageHead title="Dashboard" sub="What needs your attention today" />
      <ErrorBox error={error} />
      {data && (
        <>
          <h2>People</h2>
          <div className="stats">
            <Stat label="Active employees" value={data.people.active} />
            <Stat label="Onboarding" value={data.people.onboarding} />
            <Stat label="On the clock now" value={data.people.clockedIn} tone="ok" />
            <Stat label="Pending time off" value={data.people.pendingPto} tone={data.people.pendingPto ? "warn" : undefined} />
          </div>
          <h2>Fleet & equipment</h2>
          <div className="stats">
            <Stat label="Assets in service" value={data.fleet.assets} />
            <Stat label="In shop / out of service" value={data.fleet.outOfService} tone={data.fleet.outOfService ? "warn" : undefined} />
            <Stat label="Open work orders" value={data.fleet.openWorkOrders} />
            <Stat label="Maintenance overdue" value={data.fleet.maintenanceOverdue} tone={data.fleet.maintenanceOverdue ? "bad" : "ok"} />
            <Stat label="Maintenance due soon" value={data.fleet.maintenanceDueSoon} tone={data.fleet.maintenanceDueSoon ? "warn" : undefined} />
          </div>
        </>
      )}
      <div className="grid cols-2">
        <div className="card">
          <h2>Maintenance due</h2>
          {due.data?.length ? (
            <table>
              <tbody>
                {due.data.map((s) => (
                  <tr key={s.id}>
                    <td><Link href={`/fleet/${s.assetId}`}>{s.assetName}</Link><div className="muted">{s.name}</div></td>
                    <td><Badge value={s.due.status} /><div className="muted">{s.due.reasons.join(", ")}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>Nothing due. Nice.</Empty>}
        </div>
        <div className="card">
          <h2>Time-off requests</h2>
          {pto.data?.length ? (
            <table>
              <tbody>
                {pto.data.map(({ request, employee, policyName }) => (
                  <tr key={request.id}>
                    <td>{employee.firstName} {employee.lastName}<div className="muted">{policyName} · {request.hours}h</div></td>
                    <td>{fmtDate(request.startDate)} – {fmtDate(request.endDate)}</td>
                    <td><Link href="/time-off">Review</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No pending requests.</Empty>}
        </div>
        {data?.fleet.expiringDocuments.length > 0 && (
          <div className="card">
            <h2>Registrations & insurance expiring within 30 days</h2>
            <table>
              <tbody>
                {data.fleet.expiringDocuments.map((a: any) => (
                  <tr key={a.id}>
                    <td><Link href={`/fleet/${a.id}`}>{a.name}</Link></td>
                    <td>Registration {fmtDate(a.registrationExpires)}</td>
                    <td>Insurance {fmtDate(a.insuranceExpires)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

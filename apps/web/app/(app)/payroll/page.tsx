"use client";
import { useState } from "react";
import { api, download, fmtDate, fmtDateTime, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

function lastWeek() {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) - 7);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { start: iso(monday), end: iso(sunday) };
}

export default function Payroll() {
  const { can } = useAuth();
  const initial = lastWeek();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const settings = useApi("/payroll/settings");
  const preview = useApi<any[]>(`/payroll/preview?periodStart=${start}&periodEnd=${end}`);
  const runs = useApi<any[]>("/payroll/runs");
  const action = useAction();
  const save = useAction();
  const rows = (preview.data ?? []).filter((l) => l.totalHours > 0 || l.payType === "salary");
  const provider = settings.data?.payrollProvider;

  return (
    <>
      <PageHead title="Payroll" sub="Export approved hours, or send them straight to your payroll provider" />
      <div className="card row">
        <label>Period start<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Period end<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={() => action.run(async () => { await download(`/payroll/export.csv?periodStart=${start}&periodEnd=${end}`, `timesheets-${start}-to-${end}.csv`); runs.reload(); })}>
          Export CSV
        </button>
        <button className="btn primary" disabled={provider !== "check" || action.busy} title={provider !== "check" ? "Connect a payroll provider below" : ""}
          onClick={() => confirm("Send these hours to Check as a draft payroll?") && action.run(async () => { await api("/payroll/submit", { body: { periodStart: start, periodEnd: end } }); runs.reload(); })}>
          Send to payroll provider
        </button>
      </div>
      <ErrorBox error={action.error || preview.error} />
      <div className="card tablewrap">
        <h2>Hours for {fmtDate(start)} – {fmtDate(end)}</h2>
        {rows.length ? (
          <table>
            <thead><tr><th>Employee</th><th>Rate</th><th>Regular</th><th>Overtime</th><th>Total</th><th>Est. gross</th></tr></thead>
            <tbody>{rows.map((l) => (
              <tr key={l.employeeId}>
                <td>{l.firstName} {l.lastName}{l.payType === "salary" && <div className="muted">Salaried</div>}</td>
                <td>{money(l.payRateCents)}{l.payType === "hourly" ? "/hr" : "/yr"}</td>
                <td>{l.regularHours.toFixed(2)}</td>
                <td>{l.overtimeHours.toFixed(2)}</td>
                <td>{l.totalHours.toFixed(2)}</td>
                <td>{l.estimatedGrossCents == null ? <span className="muted">Set by provider</span> : money(l.estimatedGrossCents)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr>
              <th>Total</th><th />
              <th>{rows.reduce((s, l) => s + l.regularHours, 0).toFixed(2)}</th>
              <th>{rows.reduce((s, l) => s + l.overtimeHours, 0).toFixed(2)}</th>
              <th>{rows.reduce((s, l) => s + l.totalHours, 0).toFixed(2)}</th>
              <th>{money(rows.reduce((s, l) => s + (l.estimatedGrossCents ?? 0), 0))}</th>
            </tr></tfoot>
          </table>
        ) : <Empty>No completed time entries in this period.</Empty>}
        <p className="muted">Estimates are gross pay before taxes and deductions. Overtime is paid at 1.5× over {settings.data?.weeklyOvertimeThreshold ?? 40}h per week.</p>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Payroll provider</h2>
          {settings.data && (
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              save.run(async () => {
                await api("/payroll/settings", { method: "PUT", body: {
                  payrollProvider: f.get("payrollProvider"),
                  payrollProviderCompanyId: (f.get("payrollProviderCompanyId") as string) || null,
                  weeklyOvertimeThreshold: Number(f.get("weeklyOvertimeThreshold")),
                } });
                settings.reload();
              });
            }}>
              <label>Provider
                <select name="payrollProvider" defaultValue={settings.data.payrollProvider} disabled={!can("owner")}>
                  <option value="csv">None: export CSV only</option>
                  <option value="check">Check (embedded payroll)</option>
                </select>
              </label>
              <label>Provider company ID<input name="payrollProviderCompanyId" defaultValue={settings.data.payrollProviderCompanyId ?? ""} disabled={!can("owner")} placeholder="com_xxxxx" /></label>
              <label>Weekly overtime threshold (hours)<input name="weeklyOvertimeThreshold" type="number" min="1" defaultValue={settings.data.weeklyOvertimeThreshold} disabled={!can("owner")} /></label>
              <ErrorBox error={save.error} />
              {can("owner") ? <div><button className="btn" disabled={save.busy}>Save</button></div> : <p className="muted">Only the owner can change payroll settings.</p>}
            </form>
          )}
        </div>
        <div className="card">
          <h2>History</h2>
          {runs.data?.length ? (
            <table><tbody>{runs.data.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}<div className="muted">{fmtDateTime(r.createdAt)}</div></td>
                <td>{r.provider}</td>
                <td><Badge value={r.status === "exported" ? "completed" : r.status} /></td>
                <td>{r.totals ? `${(r.totals.regularHours + r.totals.overtimeHours).toFixed(1)}h` : ""}</td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No payroll exports yet.</Empty>}
        </div>
      </div>
    </>
  );
}

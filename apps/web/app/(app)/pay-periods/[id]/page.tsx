"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, fmtDate, fmtDateTime, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

/** Where approvers land from the "ready to approve" notification. */
export default function PayPeriodApproval() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const p = useApi<any>(`/pay-periods/${id}`);
  const [note, setNote] = useState("");
  const { busy, error, run } = useAction();
  const d = p.data;
  if (!d) return <ErrorBox error={p.error} />;
  const sum = (k: string) => d.lines.reduce((t: number, l: any) => t + l[k], 0).toFixed(2);
  const unapproved = d.lines.reduce((n: number, l: any) => n + l.unapprovedEntries, 0);

  return (
    <>
      <PageHead title={`Pay period ${fmtDate(d.periodStart)} – ${fmtDate(d.periodEnd)}`} sub={`Payday ${fmtDate(d.payday)}`}>
        <Badge value={d.status === "approved" ? "approved" : "pending"} />
        {can("admin", "payroll") && <Link className="btn" href="/payroll">Payroll</Link>}
      </PageHead>
      {d.status === "approved" ? (
        <div className="card">
          <strong>Approved</strong> by {d.approvedBy ?? "someone no longer here"} on {fmtDateTime(d.approvedAt)}.
          {d.approvalNote && <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>“{d.approvalNote}”</p>}
          {can("admin", "payroll") && (
            <div style={{ marginTop: 10 }}>
              <button className="btn sm" disabled={busy} onClick={() => confirm("Reopen this pay period so it has to be approved again?") && run(async () => { await api(`/pay-periods/${id}/reopen`, { method: "POST" }); await p.reload(); })}>Reopen for approval</button>
            </div>
          )}
        </div>
      ) : d.canApprove ? (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/pay-periods/${id}/approve`, { body: { note: note || undefined } }); await p.reload(); }); }}>
          <strong>Review everyone&apos;s hours below, then approve.</strong>
          {unapproved > 0 && (
            <div className="row"><Badge value="pending" /> <span>{unapproved} time entr{unapproved === 1 ? "y hasn't" : "ies haven't"} been approved by a manager yet.</span> <Link className="btn sm" href="/time">Review timesheets</Link></div>
          )}
          <label>Note (optional)<textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Checked against the job sheets" /></label>
          <div><button className="btn primary" disabled={busy}>Approve pay period</button></div>
        </form>
      ) : (
        <div className="card muted">Waiting for approval.</div>
      )}
      <ErrorBox error={error} />
      <div className="card tablewrap">
        <h2>Hours</h2>
        {d.lines.length ? (
          <table>
            <thead><tr><th>Employee</th><th>Regular</th><th>Overtime</th><th>Time off</th><th>Est. gross</th></tr></thead>
            <tbody>{d.lines.map((l: any) => (
              <tr key={l.employeeId}>
                <td>{l.firstName} {l.lastName}{l.payType === "salary" && <div className="muted">Salaried</div>}{l.unapprovedEntries > 0 && <div className="muted">{l.unapprovedEntries} unapproved</div>}</td>
                <td>{l.regularHours.toFixed(2)}</td>
                <td>{l.overtimeHours.toFixed(2)}</td>
                <td>{l.ptoHours ? l.ptoHours.toFixed(2) : "—"}</td>
                <td>{l.estimatedGrossCents == null ? <span className="muted">Salary</span> : money(l.estimatedGrossCents)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th>Total</th><th>{sum("regularHours")}</th><th>{sum("overtimeHours")}</th><th>{sum("ptoHours")}</th>
              <th>{money(d.lines.reduce((t: number, l: any) => t + (l.estimatedGrossCents ?? 0), 0))}</th></tr></tfoot>
          </table>
        ) : <Empty>No hours or time off in this period.</Empty>}
        <p className="muted" style={{ fontSize: 13 }}>Estimated gross pay before taxes and deductions.</p>
      </div>
    </>
  );
}

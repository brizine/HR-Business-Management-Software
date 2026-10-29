"use client";
import { useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";

export default function TimeOff() {
  const { can } = useAuth();
  const balances = useApi<any[]>("/pto/balances");
  const policies = useApi<any[]>("/pto/policies");
  const mine = useApi<any[]>("/pto/requests?mine=true");
  const pending = useApi<any[]>(can("manager") ? "/pto/requests?status=pending" : null);
  const employees = useApi<any[]>(can("admin") ? "/employees" : null);
  const [requesting, setRequesting] = useState(false);
  const req = useAction();
  const pol = useAction();
  const adj = useAction();
  const reloadAll = () => { balances.reload(); mine.reload(); pending.reload(); };

  return (
    <>
      <PageHead title="Time off">
        <button className="btn primary" onClick={() => setRequesting(!requesting)}>Request time off</button>
      </PageHead>
      <div className="stats">
        {balances.data?.map((b) => (
          <div className="stat" key={b.policyId}>
            <div className="v">{b.balanceHours}h</div>
            <div className="l">{b.name}{b.pendingHours ? ` · ${b.pendingHours}h pending` : ""}</div>
          </div>
        ))}
      </div>
      {requesting && (
        <div className="card">
          <h2>New request</h2>
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            req.run(async () => { await api("/pto/requests", { body }); setRequesting(false); reloadAll(); });
          }}>
            <div className="formgrid">
              <label>Type<select name="policyId" required>{policies.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label>Start<input type="date" name="startDate" required /></label>
              <label>End<input type="date" name="endDate" required /></label>
              <label>Hours<input type="number" name="hours" step="0.5" min="0.5" required /></label>
            </div>
            <label>Reason<input name="reason" /></label>
            <ErrorBox error={req.error} />
            <div><button className="btn primary" disabled={req.busy}>Submit</button></div>
          </form>
        </div>
      )}
      {can("manager") && (
        <div className="card">
          <h2>Waiting for approval</h2>
          {pending.data?.length ? (
            <table><tbody>{pending.data.map(({ request: r, employee, policyName }) => (
              <tr key={r.id}>
                <td>{employee.firstName} {employee.lastName}<div className="muted">{r.reason}</div></td>
                <td>{policyName}</td>
                <td>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</td>
                <td>{r.hours}h</td>
                <td className="row">
                  <button className="btn sm primary" onClick={() => api(`/pto/requests/${r.id}/decide`, { body: { status: "approved" } }).then(reloadAll, (e) => alert(e.message))}>Approve</button>
                  <button className="btn sm danger" onClick={() => {
                    const note = prompt("Reason for denying (optional)") ?? undefined;
                    api(`/pto/requests/${r.id}/decide`, { body: { status: "denied", note } }).then(reloadAll, (e) => alert(e.message));
                  }}>Deny</button>
                </td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>Nothing waiting.</Empty>}
        </div>
      )}
      <div className="card">
        <h2>My requests</h2>
        {mine.data?.length ? (
          <table><tbody>{mine.data.map(({ request: r, policyName }) => (
            <tr key={r.id}>
              <td>{policyName}</td>
              <td>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</td>
              <td>{r.hours}h</td>
              <td><Badge value={r.status} />{r.decisionNote && <div className="muted">{r.decisionNote}</div>}</td>
              <td>{r.status === "pending" && <button className="btn sm" onClick={() => api(`/pto/requests/${r.id}/cancel`, { method: "POST" }).then(reloadAll)}>Cancel</button>}</td>
            </tr>
          ))}</tbody></table>
        ) : <Empty>No requests yet.</Empty>}
      </div>
      {can("admin") && (
        <div className="grid cols-2">
          <div className="card">
            <h2>Policies</h2>
            <table><tbody>{policies.data?.map((p) => (
              <tr key={p.id}><td>{p.name}</td><td className="muted">
                {p.accrualRate ? `1h per ${Math.round(1 / p.accrualRate)}h worked` : "No accrual"}
                {p.maxBalanceHours ? ` · cap ${p.maxBalanceHours}h` : ""}
              </td></tr>
            ))}</tbody></table>
            <form className="stack" style={{ marginTop: 12 }} onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const { hoursPer, ...v } = formValues(form);
              pol.run(async () => { await api("/pto/policies", { body: { ...v, accrualRate: hoursPer ? 1 / hoursPer : 0 } }); form.reset(); policies.reload(); balances.reload(); });
            }}>
              <div className="formgrid">
                <label>Name<input name="name" required placeholder="e.g. Vacation" /></label>
                <label>Accrue 1h per N hours worked<input name="hoursPer" type="number" min="1" placeholder="e.g. 30" /></label>
                <label>Max balance (h)<input name="maxBalanceHours" type="number" min="0" /></label>
              </div>
              <ErrorBox error={pol.error} />
              <div><button className="btn" disabled={pol.busy}>Add policy</button></div>
            </form>
          </div>
          <div className="card">
            <h2>Adjust a balance</h2>
            <p className="muted">Grant annual hours or correct a balance. Use negative hours to deduct.</p>
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const body = formValues(form);
              adj.run(async () => { await api("/pto/adjustments", { body }); form.reset(); balances.reload(); });
            }}>
              <div className="formgrid">
                <label>Employee<select name="employeeId" required>{employees.data?.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></label>
                <label>Policy<select name="policyId" required>{policies.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <label>Hours<input name="hours" type="number" step="0.5" required /></label>
                <label>Reason<input name="reason" placeholder="annual grant" /></label>
              </div>
              <ErrorBox error={adj.error} />
              <div><button className="btn" disabled={adj.busy}>Apply</button></div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

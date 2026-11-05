"use client";
import Link from "next/link";
import { useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";
import { PtoPolicyForm } from "@/components/pto-policy-form";
import { describePto } from "@crewdesk/shared";

const STATUSES = ["pending", "approved", "denied", "cancelled"];
const NO_FILTERS = { q: "", person: "me", policy: "", status: "", from: "", to: "" };

export default function TimeOff() {
  const { me, can } = useAuth();
  const policies = useApi<any[]>("/pto/policies");
  const manager = can("manager", "timeoff");
  // Managers get everyone's requests so they can search them; others get their own.
  const mine = useApi<any[]>(manager ? "/pto/requests" : "/pto/requests?mine=true");
  const [filters, setFilters] = useState(NO_FILTERS);
  const setFilter = (patch: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...patch }));
  const filtering = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const pending = useApi<any[]>(can("manager", "timeoff") ? "/pto/requests?status=pending" : null);
  const employees = useApi<any[]>(can("admin", "timeoff") ? "/employees" : null);
  const [requesting, setRequesting] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<string | null>(null);
  const req = useAction();
  const adj = useAction();
  const reloadAll = () => { mine.reload(); pending.reload(); };
  const q = filters.q.trim().toLowerCase();
  /** Search, type and dates (overlapping the range) apply to both lists; person and status to the requests list. */
  const matches = ({ request: r, employee, policyName }: any, usePerson: boolean) =>
    (!q || `${employee?.firstName ?? ""} ${employee?.lastName ?? ""} ${policyName ?? ""} ${r.reason ?? ""} ${r.decisionNote ?? ""}`.toLowerCase().includes(q)) &&
    (!filters.policy || r.policyId === filters.policy) &&
    (!filters.from || r.endDate >= filters.from) &&
    (!filters.to || r.startDate <= filters.to) &&
    (!usePerson || !manager || !filters.person || (filters.person === "me" ? r.employeeId === me?.user.id : r.employeeId === filters.person));
  const requests = (mine.data ?? []).filter((x) => matches(x, true) && (!filters.status || x.request.status === filters.status));
  const waiting = (pending.data ?? []).filter((x) => matches(x, false) && (!filters.person || filters.person === "me" || x.request.employeeId === filters.person));
  const people = [...new Map((mine.data ?? []).map(({ employee }) => [employee.id, `${employee.firstName} ${employee.lastName}`])).entries()].filter(([id]) => id !== me?.user.id).sort((a, b) => a[1].localeCompare(b[1]));
  const showingMine = !manager || filters.person === "me";

  return (
    <>
      <PageHead title="Time off">
        {me && <Link className="btn" href={`/people/${me.user.id}`}>My balance</Link>}
        <button className="btn primary" onClick={() => setRequesting(!requesting)}>Request time off</button>
      </PageHead>
      <form className="card filters" role="search" aria-label="Filter time off" onSubmit={(e) => e.preventDefault()}>
        <label>Search
          <input type="search" placeholder={manager ? "Name, type, reason…" : "Type, reason…"} value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} />
        </label>
        {manager && (
          <label>Person
            <select value={filters.person} onChange={(e) => setFilter({ person: e.target.value })}>
              <option value="me">Me</option>
              <option value="">Everyone</option>
              {people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
          </label>
        )}
        <label>Type
          <select value={filters.policy} onChange={(e) => setFilter({ policy: e.target.value })}>
            <option value="">All types</option>
            {policies.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Status
          <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
            <option value="">Any</option>
            {STATUSES.map((st) => <option key={st} value={st}>{st[0].toUpperCase() + st.slice(1)}</option>)}
          </select>
        </label>
        <fieldset className="pay-range date-range">
          <legend>Dates</legend>
          <input type="date" aria-label="Time off on or after" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter({ from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="Time off on or before" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter({ to: e.target.value })} />
        </fieldset>
        {filtering && <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </form>
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
      {can("manager", "timeoff") && (
        <div className="card">
          <h2>Waiting for approval</h2>
          {waiting.length ? (
            <table><tbody>{waiting.map(({ request: r, employee, policyName }) => (
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
          ) : <Empty>{pending.data?.length ? "Nothing waiting matches your filters." : "Nothing waiting."}</Empty>}
        </div>
      )}
      <div className="card">
        <h2>{showingMine ? "My requests" : "Requests"}{filtering && mine.data ? <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {requests.length} shown</span> : null}</h2>
        {requests.length ? (
          <table><tbody>{requests.map(({ request: r, policyName, employee }) => (
            <tr key={r.id}>
              {!showingMine && <td>{employee.firstName} {employee.lastName}{r.reason && <div className="muted">{r.reason}</div>}</td>}
              <td>{policyName}</td>
              <td>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</td>
              <td>{r.hours}h</td>
              <td><Badge value={r.status} />{r.decisionNote && <div className="muted">{r.decisionNote}</div>}</td>
              <td>{r.status === "pending" && r.employeeId === me?.user.id && <button className="btn sm" onClick={() => api(`/pto/requests/${r.id}/cancel`, { method: "POST" }).then(reloadAll)}>Cancel</button>}</td>
            </tr>
          ))}</tbody></table>
        ) : <Empty>{filtering ? "No requests match your filters." : "No requests yet."}</Empty>}
      </div>
      {can("admin", "timeoff") && (
        <div className="grid cols-2">
          <div className="card">
            <h2>Policies</h2>
            <table><tbody>{policies.data?.map((p) => (
              <tr key={p.id}>
                <td style={{ verticalAlign: "top" }}><strong>{p.name}</strong><div className="muted" style={{ fontSize: 13 }}>{describePto(p)}</div></td>
                <td style={{ textAlign: "right", verticalAlign: "top" }}><button className="btn sm" onClick={() => setEditingPolicy(editingPolicy === p.id ? null : p.id)}>{editingPolicy === p.id ? "Close" : "Edit"}</button></td>
              </tr>
            ))}</tbody></table>
            {editingPolicy ? (
              <PtoPolicyForm key={editingPolicy} policy={policies.data?.find((p) => p.id === editingPolicy)} onCancel={() => setEditingPolicy(null)}
                onSaved={() => { setEditingPolicy(null); policies.reload(); }} />
            ) : (
              <PtoPolicyForm key={`new-${policies.data?.length ?? 0}`} onSaved={() => policies.reload()} />
            )}
          </div>
          <div className="card">
            <h2>Adjust a balance</h2>
            <p className="muted">Grant annual hours or correct a balance. Use negative hours to deduct.</p>
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const body = formValues(form);
              adj.run(async () => { await api("/pto/adjustments", { body }); form.reset(); });
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

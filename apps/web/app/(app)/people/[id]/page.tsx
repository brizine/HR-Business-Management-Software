"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { DocumentList } from "@/components/documents";
import { AvailabilityEditor } from "@/components/availability-editor";
import { EmployeeFields, employeeBody } from "@/components/employee-form";

export default function Person({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const emp = useApi(`/employees/${id}`);
  const all = useApi<any[]>(can("admin") ? "/employees" : null);
  const balances = useApi<any[]>(can("manager") ? `/pto/balances?employeeId=${id}` : null);
  const tasks = useApi<any[]>(can("manager") ? `/onboarding/tasks?employeeId=${id}` : null);
  const templates = useApi<any[]>(can("admin") ? "/onboarding/templates" : null);
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const e = emp.data;
  if (!e) return <ErrorBox error={emp.error} />;

  return (
    <>
      <PageHead title={`${e.firstName} ${e.lastName}`} sub={[e.title, e.department].filter(Boolean).join(" · ")}>
        <Badge value={e.status} />
        {can("admin") && <Link className="btn" href={`/settings/notifications?employeeId=${id}`}>Notifications</Link>}
        {can("admin") && <button className="btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>}
      </PageHead>
      {editing ? (
        <div className="card">
          <form
            className="stack"
            onSubmit={(ev) => {
              ev.preventDefault();
              const body = employeeBody(ev.currentTarget);
              run(async () => {
                emp.setData(await api(`/employees/${id}`, { method: "PATCH", body }));
                setEditing(false);
              });
            }}
          >
            <EmployeeFields initial={e} employees={all.data ?? []} />
            <ErrorBox error={error} />
            <div><button className="btn primary" disabled={busy}>Save changes</button></div>
          </form>
        </div>
      ) : (
        <div className="card">
          <div className="formgrid">
            <div><div className="muted">Email</div>{e.email}</div>
            <div><div className="muted">Phone</div>{e.phone ?? "—"}</div>
            <div><div className="muted">Role</div>{e.role}</div>
            <div><div className="muted">Start date</div>{fmtDate(e.startDate)}</div>
            {"payRateCents" in e && <div><div className="muted">Pay</div>{money(e.payRateCents)} {e.payType === "hourly" ? "/hr" : "/yr"}</div>}
            <div><div className="muted">Employment</div>{e.employmentType?.replace("_", " ")}</div>
            <div><div className="muted">App login</div>{e.hasLogin ? "Yes" : "Not set"}</div>
          </div>
        </div>
      )}
      <div className="grid cols-2">
        {balances.data && (
          <div className="card">
            <h2>Time-off balances</h2>
            {balances.data.length ? balances.data.map((b) => (
              <div key={b.policyId} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <span>{b.name}</span><strong>{b.balanceHours}h{b.pendingHours ? <span className="muted"> ({b.pendingHours}h pending)</span> : null}</strong>
              </div>
            )) : <Empty>No policies set up.</Empty>}
          </div>
        )}
        {tasks.data && (
          <div className="card">
            <h2>Onboarding</h2>
            {tasks.data.length ? (
              <table><tbody>
                {tasks.data.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}<div className="muted">{t.assignee} · due {fmtDate(t.dueDate)}</div></td>
                    <td>{t.completedAt ? <Badge value="completed" /> : <button className="btn sm" onClick={() => api(`/onboarding/tasks/${t.id}/complete`, { method: "POST" }).then(tasks.reload)}>Mark done</button>}</td>
                  </tr>
                ))}
              </tbody></table>
            ) : (
              <>
                <Empty>No onboarding checklist.</Empty>
                {templates.data?.length ? (
                  <div className="row">
                    <select id="tpl">{templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                    <button className="btn" onClick={() => {
                      const templateId = (document.getElementById("tpl") as HTMLSelectElement).value;
                      api("/onboarding/assign", { body: { employeeId: id, templateId } }).then(tasks.reload);
                    }}>Assign checklist</button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
      {can("manager") && (
        <div className="card">
          <h2>Availability</h2>
          <p className="muted" style={{ marginTop: 0 }}>Recurring times {e.firstName} can&apos;t work. These show on the schedule and warn you when scheduling.</p>
          <AvailabilityEditor employeeId={id} />
        </div>
      )}
      <DocumentList employeeId={id} />
    </>
  );
}

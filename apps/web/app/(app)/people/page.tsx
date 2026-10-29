"use client";
import Link from "next/link";
import { useState } from "react";
import { api, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, ErrorBox, PageHead } from "@/components/ui";
import { EmployeeFields, employeeBody } from "@/components/employee-form";
import { InviteResult } from "@/components/invite-result";

export default function People() {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>("/employees");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<any>(null);
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const rows = (data ?? []).filter((e) => `${e.firstName} ${e.lastName} ${e.title ?? ""} ${e.department ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead title="Team" sub={`${data?.length ?? 0} people`}>
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        {can("admin") && <button className="btn primary" onClick={() => setAdding(!adding)}>Add employee</button>}
      </PageHead>
      {added && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Added {added.firstName} {added.lastName}</h2>
            <button className="btn sm" onClick={() => setAdded(null)}>Close</button>
          </div>
          {added.hasLogin ? <p className="muted">They can sign in with the password you set.</p> : <InviteResult invite={added.invite} name={added.firstName} email={added.email} />}
        </div>
      )}
      {adding && (
        <div className="card">
          <h2>New employee</h2>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const body = employeeBody(e.currentTarget);
              run(async () => {
                setAdded(await api("/employees", { body }));
                setAdding(false);
                reload();
              });
            }}
          >
            <EmployeeFields employees={data ?? []} />
            <label className="check"><input type="checkbox" name="sendInvite" defaultChecked /> If no password is set, email them an invite to set up their own account</label>
            <ErrorBox error={error} />
            <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Title</th><th>Department</th><th>Contact</th>{can("manager") && <th>Pay</th>}<th>Status</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td><Link href={`/people/${e.id}`}>{e.firstName} {e.lastName}</Link><div className="muted">{e.role}</div></td>
                <td>{e.title ?? "—"}</td>
                <td>{e.department ?? "—"}</td>
                <td>{e.email}<div className="muted">{e.phone}</div></td>
                {can("manager") && <td>{money(e.payRateCents)}{e.payType === "hourly" ? "/hr" : "/yr"}</td>}
                <td><Badge value={e.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

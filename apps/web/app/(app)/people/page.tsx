"use client";
import Link from "next/link";
import { useState } from "react";
import { api, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, ErrorBox, PageHead } from "@/components/ui";
import { EmployeeFields, employeeBody } from "@/components/employee-form";

export default function People() {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>("/employees");
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const rows = (data ?? []).filter((e) => `${e.firstName} ${e.lastName} ${e.title ?? ""} ${e.department ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead title="Team" sub={`${data?.length ?? 0} people`}>
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        {can("admin") && <button className="btn primary" onClick={() => setAdding(!adding)}>Add employee</button>}
      </PageHead>
      {adding && (
        <div className="card">
          <h2>New employee</h2>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const body = employeeBody(e.currentTarget);
              run(async () => {
                await api("/employees", { body });
                setAdding(false);
                reload();
              });
            }}
          >
            <EmployeeFields employees={data ?? []} />
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

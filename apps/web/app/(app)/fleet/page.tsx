"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";
import { AssetFields } from "@/components/asset-form";

export default function Fleet() {
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>("/assets");
  const employees = useApi<any[]>("/employees");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("all");
  const { busy, error, run } = useAction();
  const name = (id: string | null) => {
    const e = employees.data?.find((x) => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : "—";
  };
  const rows = (data ?? []).filter((a) => filter === "all" || a.type === filter || a.maintenanceStatus === filter);

  return (
    <>
      <PageHead title="Vehicles & equipment" sub={`${data?.length ?? 0} assets`}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 190 }}>
          <option value="all">All assets</option>
          <option value="overdue">Maintenance overdue</option>
          <option value="due_soon">Maintenance due soon</option>
          <option value="vehicle">Vehicles</option>
          <option value="trailer">Trailers</option>
          <option value="heavy_equipment">Heavy equipment</option>
          <option value="small_equipment">Small equipment</option>
          <option value="tool">Tools</option>
        </select>
        <Link className="btn" href="/fleet/labels">Print QR labels</Link>
        {can("manager") && <button className="btn primary" onClick={() => setAdding(!adding)}>Add asset</button>}
      </PageHead>
      {adding && (
        <div className="card">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            body.assignedEmployeeId ??= null;
            run(async () => { await api("/assets", { body }); setAdding(false); reload(); });
          }}>
            <AssetFields employees={employees.data ?? []} />
            <ErrorBox error={error} />
            <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Asset</th><th>Type</th><th>Odometer</th><th>Hours</th><th>Assigned</th><th>Status</th><th>Maintenance</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/fleet/${a.id}`}><strong>{a.name}</strong></Link><div className="muted">{[a.year, a.make, a.model].filter(Boolean).join(" ")}</div></td>
                <td>{a.type.replace("_", " ")}</td>
                <td>{a.odometer ? a.odometer.toLocaleString() : "—"}</td>
                <td>{a.engineHours ? a.engineHours.toLocaleString() : "—"}</td>
                <td>{name(a.assignedEmployeeId)}</td>
                <td><Badge value={a.status} /></td>
                <td><Badge value={a.maintenanceStatus} /></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No assets match.</Empty>}
      </div>
    </>
  );
}

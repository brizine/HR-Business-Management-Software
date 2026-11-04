"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";
import { AssetFields } from "@/components/asset-form";
import { useMenus } from "@/components/menu-select";
import { useMenuData } from "@/lib/menus";

const NO_FILTERS = { q: "", type: "", status: "", maintenance: "", assigned: "" };
const NONE = "__none";
const ASSET_STATUSES = ["active", "in_shop", "out_of_service", "retired"];

export default function Fleet() {
  const menus = useMenus();
  const { can } = useAuth();
  const { data, reload } = useApi<any[]>("/assets");
  const employees = useApi<any[]>("/employees");
  const [adding, setAdding] = useState(false);
  const { label } = useMenuData();
  const [filters, setFilters] = useState(NO_FILTERS);
  const setFilter = (patch: Partial<typeof NO_FILTERS>) => setFilters((f) => ({ ...f, ...patch }));
  const filtering = Object.values(filters).some(Boolean);
  const { busy, error, run } = useAction();
  const name = (id: string | null) => {
    const e = employees.data?.find((x) => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : "—";
  };
  const all = data ?? [];
  const q = filters.q.trim().toLowerCase();
  const rows = all.filter((a) =>
    // Search: name, year/make/model, VIN, serial number, plate, or who it's assigned to.
    (!q || `${a.name} ${a.year ?? ""} ${a.make ?? ""} ${a.model ?? ""} ${a.vin ?? ""} ${a.serialNumber ?? ""} ${a.licensePlate ?? ""} ${a.assignedEmployeeId ? name(a.assignedEmployeeId) : ""}`.toLowerCase().includes(q)) &&
    (!filters.type || a.type === filters.type) &&
    (!filters.status || a.status === filters.status) &&
    (!filters.maintenance || a.maintenanceStatus === filters.maintenance) &&
    (!filters.assigned || (filters.assigned === NONE ? !a.assignedEmployeeId : a.assignedEmployeeId === filters.assigned)));
  const types = [...new Set([...menus.assetTypes, ...all.map((a) => a.type)])];
  const assignees = [...new Set(all.map((a) => a.assignedEmployeeId).filter(Boolean))].map((id) => ({ id, name: name(id) })).sort((a, b) => a.name.localeCompare(b.name));
  const count = (pred: (a: any) => boolean) => all.filter(pred).length;
  const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

  return (
    <>
      <PageHead title="Vehicles & equipment" sub={<span role="status">{filtering ? `Showing ${rows.length} of ${all.length} assets` : `${all.length} assets`}</span>}>
        <Link className="btn" href="/fleet/labels">Print QR labels</Link>
        {can("manager", "fleet") && <button className="btn primary" onClick={() => setAdding(!adding)}>Add asset</button>}
      </PageHead>
      <form className="card filters" role="search" aria-label="Filter assets" onSubmit={(e) => e.preventDefault()}>
        <label>Search
          <input type="search" placeholder="Name, make, VIN, plate, person…" value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} />
        </label>
        <label>Type
          <select value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{cap(t.replace(/_/g, " "))} ({count((a) => a.type === t)})</option>)}
          </select>
        </label>
        <label>Status
          <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
            <option value="">All</option>
            {ASSET_STATUSES.map((s) => <option key={s} value={s}>{cap(label("assetStatus", s))} ({count((a) => a.status === s)})</option>)}
          </select>
        </label>
        <label>Maintenance
          <select value={filters.maintenance} onChange={(e) => setFilter({ maintenance: e.target.value })}>
            <option value="">Any</option>
            <option value="overdue">Overdue ({count((a) => a.maintenanceStatus === "overdue")})</option>
            <option value="due_soon">Due soon ({count((a) => a.maintenanceStatus === "due_soon")})</option>
            <option value="ok">Up to date ({count((a) => a.maintenanceStatus === "ok")})</option>
          </select>
        </label>
        <label>Assigned to
          <select value={filters.assigned} onChange={(e) => setFilter({ assigned: e.target.value })}>
            <option value="">Anyone</option>
            {assignees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value={NONE}>Not assigned</option>
          </select>
        </label>
        {filtering && <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </form>
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
                <td>{a.type.replace(/_/g, " ")}</td>
                <td>{a.odometer ? a.odometer.toLocaleString() : "—"}</td>
                <td>{a.engineHours ? a.engineHours.toLocaleString() : "—"}</td>
                <td>{name(a.assignedEmployeeId)}</td>
                <td><Badge value={a.status} menu="assetStatus" /></td>
                <td><Badge value={a.maintenanceStatus} /></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>{filtering ? "No assets match your filters." : "No assets yet."}</Empty>}
      </div>
    </>
  );
}

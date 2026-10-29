"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, fmtDate, fmtDateTime, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";
import { AssetFields } from "@/components/asset-form";
import { DocumentList } from "@/components/documents";
import { QrCode, assetQrUrl, qrSvg } from "@/components/qr";

export default function AssetDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const asset = useApi(`/assets/${id}`);
  const employees = useApi<any[]>("/employees");
  const [editing, setEditing] = useState(false);
  const [addingSchedule, setAddingSchedule] = useState(false);
  const edit = useAction();
  const sched = useAction();
  const meter = useAction();
  const a = asset.data;
  if (!a) return <ErrorBox error={asset.error} />;

  const createWorkOrder = (s: any) =>
    api("/work-orders", { body: { assetId: a.id, scheduleId: s.id, title: s.name, priority: s.due.status === "overdue" ? "high" : "medium" } })
      .then(asset.reload, (e) => alert(e.message));

  return (
    <>
      <PageHead title={a.name} sub={[a.year, a.make, a.model, a.licensePlate, a.vin].filter(Boolean).join(" · ")}>
        <Badge value={a.status} />
        {can("manager") && <button className="btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>}
      </PageHead>
      {editing && (
        <div className="card">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            body.assignedEmployeeId ??= null;
            body.registrationExpires ??= null;
            body.insuranceExpires ??= null;
            edit.run(async () => { await api(`/assets/${id}`, { method: "PATCH", body }); setEditing(false); asset.reload(); });
          }}>
            <AssetFields initial={a} employees={employees.data ?? []} />
            <ErrorBox error={edit.error} />
            <div><button className="btn primary" disabled={edit.busy}>Save</button></div>
          </form>
        </div>
      )}
      <div className="stats">
        <div className="stat"><div className="v">{a.odometer.toLocaleString()}</div><div className="l">Odometer (mi)</div></div>
        <div className="stat"><div className="v">{a.engineHours.toLocaleString()}</div><div className="l">Engine hours</div></div>
        <div className="stat"><div className="v">{money(a.totalMaintenanceCostCents)}</div><div className="l">Lifetime maintenance cost</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 16 }}>{fmtDate(a.registrationExpires)}</div><div className="l">Registration expires</div></div>
        <div className="stat"><div className="v" style={{ fontSize: 16 }}>{fmtDate(a.insuranceExpires)}</div><div className="l">Insurance expires</div></div>
      </div>
      <div className="card">
        <h2>Log meter reading</h2>
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const body = formValues(form);
          meter.run(async () => { await api(`/assets/${id}/meter`, { body }); form.reset(); asset.reload(); });
        }}>
          <input name="odometer" type="number" min="0" placeholder="Odometer" style={{ width: 160 }} />
          <input name="engineHours" type="number" min="0" step="0.1" placeholder="Engine hours" style={{ width: 160 }} />
          <button className="btn" disabled={meter.busy}>Save reading</button>
          <ErrorBox error={meter.error} />
        </form>
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Preventive maintenance schedules</h2>
          {can("manager") && <button className="btn" onClick={() => setAddingSchedule(!addingSchedule)}>Add schedule</button>}
        </div>
        {addingSchedule && (
          <form className="stack card" onSubmit={(e) => {
            e.preventDefault();
            const body = { ...formValues(e.currentTarget), assetId: id };
            sched.run(async () => { await api("/assets/schedules", { body }); setAddingSchedule(false); asset.reload(); });
          }}>
            <p className="muted" style={{ margin: 0 }}>Whichever interval comes first triggers the service. Leave last-service fields blank to count from today.</p>
            <div className="formgrid">
              <label>Service<input name="name" required placeholder="Oil & filter change" /></label>
              <label>Every N miles<input name="intervalMiles" type="number" min="1" /></label>
              <label>Every N engine hours<input name="intervalHours" type="number" min="1" /></label>
              <label>Every N days<input name="intervalDays" type="number" min="1" /></label>
              <label>Last service date<input name="lastServiceDate" type="date" /></label>
              <label>Last service odometer<input name="lastServiceOdometer" type="number" min="0" /></label>
              <label>Last service hours<input name="lastServiceHours" type="number" min="0" /></label>
            </div>
            <ErrorBox error={sched.error} />
            <div><button className="btn primary" disabled={sched.busy}>Save schedule</button></div>
          </form>
        )}
        {a.schedules.length ? (
          <div className="tablewrap"><table>
            <thead><tr><th>Service</th><th>Interval</th><th>Last done</th><th>Next due</th><th>Status</th><th /></tr></thead>
            <tbody>{a.schedules.map((s: any) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="muted">{[s.intervalMiles && `${s.intervalMiles.toLocaleString()} mi`, s.intervalHours && `${s.intervalHours} hrs`, s.intervalDays && `${s.intervalDays} days`].filter(Boolean).join(" / ")}</td>
                <td>{fmtDate(s.lastServiceDate)}<div className="muted">{s.lastServiceOdometer != null && s.intervalMiles ? `${s.lastServiceOdometer.toLocaleString()} mi` : ""}{s.lastServiceHours != null && s.intervalHours ? ` ${s.lastServiceHours} hrs` : ""}</div></td>
                <td>{[s.due.nextDueOdometer && `${s.due.nextDueOdometer.toLocaleString()} mi`, s.due.nextDueHours && `${s.due.nextDueHours} hrs`, s.due.nextDueDate && fmtDate(s.due.nextDueDate)].filter(Boolean).join(" / ")}</td>
                <td><Badge value={s.due.status} /><div className="muted">{s.due.reasons.join(", ")}</div></td>
                <td className="row">
                  {can("manager") && <button className="btn sm" onClick={() => createWorkOrder(s)}>Create work order</button>}
                  {can("manager") && <button className="btn sm danger" onClick={() => confirm("Delete schedule?") && api(`/assets/schedules/${s.id}`, { method: "DELETE" }).then(asset.reload)}>×</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No schedules yet. Add oil changes, inspections, filter swaps and so on.</Empty>}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Work orders</h2>
          {a.workOrders.length ? (
            <table><tbody>{a.workOrders.map((w: any) => (
              <tr key={w.id}>
                <td><Link href={`/work-orders?highlight=${w.id}`}>#{w.number} {w.title}</Link><div className="muted">{fmtDate(w.createdAt)}</div></td>
                <td><Badge value={w.status} /></td>
                <td>{w.status === "completed" ? money(w.partsCostCents + w.laborCostCents) : <Badge value={w.priority} />}</td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No work orders.</Empty>}
        </div>
        <div className="card">
          <h2>Inspections</h2>
          {a.inspections.length ? (
            <table><tbody>{a.inspections.map((i: any) => (
              <tr key={i.id}>
                <td>{fmtDateTime(i.createdAt)}</td>
                <td><Badge value={i.passed ? "passed" : "failed"} /></td>
                <td className="muted">{i.items.filter((x: any) => !x.ok).map((x: any) => x.item).join(", ")}</td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No inspections recorded.</Empty>}
        </div>
      </div>
      <div className="card row" style={{ alignItems: "flex-start", gap: 18 }}>
        <QrCode value={assetQrUrl(a.qrCode)} size={128} />
        <div className="stack" style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ margin: 0 }}>QR label</h2>
          <div className="muted">Scanning opens a page to inspect this {a.type.replace("_", " ")}, log a reading or report an issue. No app needed.</div>
          <div>Code <code style={{ letterSpacing: ".05em" }}>{a.qrCode}</code></div>
          <div className="row">
            <Link className="btn" href={`/fleet/labels?ids=${a.id}`}>Print label</Link>
            <button className="btn" onClick={async () => {
              const url = URL.createObjectURL(new Blob([await qrSvg(assetQrUrl(a.qrCode))], { type: "image/svg+xml" }));
              Object.assign(document.createElement("a"), { href: url, download: `${a.name}-qr.svg` }).click();
              URL.revokeObjectURL(url);
            }}>Download SVG</button>
            {can("manager") && (
              <button className="btn danger" onClick={() => confirm("Issue a new code? The current label will stop working and you'll need to print a new one.")
                && api(`/assets/${id}/regenerate-code`, { method: "POST" }).then(asset.reload)}>New code</button>
            )}
          </div>
        </div>
      </div>
      <DocumentList assetId={id} title="Asset documents (registration, insurance, manuals)" />
    </>
  );
}

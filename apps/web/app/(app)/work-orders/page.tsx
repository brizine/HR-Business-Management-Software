"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { WORK_ORDER_STATUSES } from "@crewdesk/shared";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead, formValues } from "@/components/ui";

function WorkOrderEditor({ wo, employees, canManage, onDone }: { wo: any; employees: any[]; canManage: boolean; onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      const { partsCost, laborCost, ...v } = formValues(e.currentTarget);
      if (partsCost != null) v.partsCostCents = Math.round(partsCost * 100);
      if (laborCost != null) v.laborCostCents = Math.round(laborCost * 100);
      if (canManage) v.assignedToId ??= null;
      run(async () => { await api(`/work-orders/${wo.id}`, { method: "PATCH", body: v }); onDone(); });
    }}>
      {wo.description && <pre style={{ whiteSpace: "pre-wrap", margin: 0, font: "inherit" }} className="muted">{wo.description}</pre>}
      <div className="formgrid">
        <label>Status<select name="status" defaultValue={wo.status}>{WORK_ORDER_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></label>
        {canManage && (
          <label>Assigned to
            <select name="assignedToId" defaultValue={wo.assignedToId ?? ""}>
              <option value="">Unassigned</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </label>
        )}
        <label>Labor hours<input name="laborHours" type="number" step="0.1" min="0" defaultValue={wo.laborHours ?? ""} /></label>
        <label>Parts cost ($)<input name="partsCost" type="number" step="0.01" min="0" defaultValue={wo.partsCostCents ? wo.partsCostCents / 100 : ""} /></label>
        <label>Labor cost ($)<input name="laborCost" type="number" step="0.01" min="0" defaultValue={wo.laborCostCents ? wo.laborCostCents / 100 : ""} /></label>
        <label>Vendor / shop<input name="vendor" defaultValue={wo.vendor ?? ""} /></label>
        <label>Odometer at completion<input name="completedOdometer" type="number" min="0" /></label>
        <label>Hours at completion<input name="completedHours" type="number" min="0" step="0.1" /></label>
      </div>
      <label>Resolution notes<textarea name="resolutionNotes" defaultValue={wo.resolutionNotes ?? ""} /></label>
      <ErrorBox error={error} />
      <div><button className="btn primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function WorkOrders() {
  const { me, can } = useAuth();
  const params = useSearchParams();
  const highlight = params.get("highlight");
  const [status, setStatus] = useState("active");
  const [mine, setMine] = useState(params.get("mine") === "true");
  const list = useApi<any[]>(`/work-orders?status=${status === "all" ? "" : status}${mine ? "&mine=true" : ""}`);
  const assets = useApi<any[]>("/assets");
  const employees = useApi<any[]>("/employees");
  const [open, setOpen] = useState<string | null>(highlight);
  const [creating, setCreating] = useState(false);
  const create = useAction();

  return (
    <>
      <PageHead title="Work orders" sub="Repairs and scheduled service">
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
          <option value="active">Active</option>
          {WORK_ORDER_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          <option value="all">All</option>
        </select>
        <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me</label>
        <button className="btn primary" onClick={() => setCreating(!creating)}>{can("manager") ? "New work order" : "Report an issue"}</button>
      </PageHead>
      {creating && (
        <div className="card">
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const body = formValues(e.currentTarget);
            create.run(async () => { await api("/work-orders", { body }); setCreating(false); list.reload(); });
          }}>
            <div className="formgrid">
              <label>Asset<select name="assetId" required>{assets.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label>Title<input name="title" required placeholder="e.g. Check engine light on" /></label>
              <label>Priority<select name="priority" defaultValue="medium">{["low", "medium", "high", "critical"].map((p) => <option key={p}>{p}</option>)}</select></label>
              {can("manager") && (
                <>
                  <label>Assign to<select name="assignedToId"><option value="">Unassigned</option>{employees.data?.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></label>
                  <label>Due date<input name="dueDate" type="date" /></label>
                </>
              )}
            </div>
            <label>Description<textarea name="description" /></label>
            <p className="muted" style={{ margin: 0 }}>Critical issues take the asset out of service until the work order is completed.</p>
            <ErrorBox error={create.error} />
            <div><button className="btn primary" disabled={create.busy}>Create</button></div>
          </form>
        </div>
      )}
      <div className="card tablewrap">
        {list.data?.length ? (
          <table>
            <thead><tr><th>#</th><th>Work order</th><th>Asset</th><th>Priority</th><th>Assigned</th><th>Due</th><th>Status</th><th>Cost</th></tr></thead>
            <tbody>{list.data.map(({ workOrder: w, assetName, assignee }) => {
              const editable = can("manager") || w.assignedToId === me?.user.id;
              return [
                <tr key={w.id} onClick={() => editable && setOpen(open === w.id ? null : w.id)} style={{ cursor: editable ? "pointer" : undefined, background: open === w.id ? "var(--info-bg)" : undefined }}>
                  <td>{w.number}</td>
                  <td><strong>{w.title}</strong></td>
                  <td>{assetName}</td>
                  <td><Badge value={w.priority} /></td>
                  <td>{assignee?.id ? `${assignee.firstName} ${assignee.lastName}` : "—"}</td>
                  <td>{fmtDate(w.dueDate)}</td>
                  <td><Badge value={w.status} /></td>
                  <td>{w.partsCostCents + w.laborCostCents ? money(w.partsCostCents + w.laborCostCents) : "—"}</td>
                </tr>,
                open === w.id && (
                  <tr key={w.id + "-edit"}><td colSpan={8}>
                    <WorkOrderEditor wo={w} employees={employees.data ?? []} canManage={can("manager")} onDone={() => { setOpen(null); list.reload(); }} />
                  </td></tr>
                ),
              ];
            })}</tbody>
          </table>
        ) : <Empty>No work orders.</Empty>}
      </div>
    </>
  );
}

export default function Page() {
  return <Suspense><WorkOrders /></Suspense>;
}

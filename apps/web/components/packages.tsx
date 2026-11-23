"use client";
import { useState } from "react";
import { describePricing, formatMoney, lineAmount } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Icon } from "./icons";
import { dollars, toCents, useServices } from "./invoices";
import { Empty, ErrorBox } from "./ui";

export interface PackageLine { id?: string; serviceTypeId: string | null; description: string; quantity: number; budgetedHours: number | null; unitPriceCents: number | null }
export interface Package { id: string; name: string; description: string | null; active: boolean; lines: PackageLine[] }

/** Packages (like Homeworks'): saved bundles of line items for work orders. On the Price list page. */
export function PackagesCard() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const list = useApi<Package[]>("/packages?all=1");
  const services = useServices(true);
  const [editing, setEditing] = useState<Package | "new" | null>(null);
  const name = (id: string | null) => services.list.find((s) => s.id === id);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Packages</h2>
          <p className="muted" style={{ margin: "2px 0 0" }}>Bundles of line items you add to a work order in one go (<strong>Add package</strong> on the work order form).</p>
        </div>
        {admin && !editing && <button className="btn" onClick={() => setEditing("new")}><Icon name="plus" size={14} /> Add package</button>}
      </div>
      {editing && <div style={{ marginTop: 12 }}><PackageForm pkg={editing === "new" ? null : editing} onDone={() => { setEditing(null); list.reload(); }} /></div>}
      {list.data?.length ? (
        <ul className="plain-list package-list">
          {list.data.map((p) => {
            const fixed = p.lines.every((l) => l.unitPriceCents != null);
            const total = fixed ? p.lines.reduce((s, l) => s + lineAmount({ quantity: l.quantity, unitPriceCents: l.unitPriceCents! }), 0) : null;
            return (
              <li key={p.id} style={{ opacity: p.active ? 1 : 0.6 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{p.name}{!p.active && <span className="badge" style={{ marginLeft: 6 }}>retired</span>}</strong>
                  <span className="row">
                    <span className="muted">{total != null ? formatMoney(total) : "Priced for each lawn"}</span>
                    {admin && <button className="btn" onClick={() => setEditing(p)}>Edit</button>}
                  </span>
                </div>
                {p.description && <div className="muted">{p.description}</div>}
                <ul className="package-lines">
                  {p.lines.map((l, i) => {
                    const s = name(l.serviceTypeId);
                    return (
                      <li key={i}>
                        {l.description}{l.quantity !== 1 ? ` × ${l.quantity}` : ""}
                        <span className="muted"> · {l.unitPriceCents != null ? formatMoney(l.unitPriceCents) : s ? describePricing(s) : "—"}{l.budgetedHours ? ` · ${l.budgetedHours} h` : ""}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : list.data && !editing ? <Empty>No packages yet.{admin ? " For example a lawn program round with its add-ons." : " An admin adds them."}</Empty> : null}
    </div>
  );
}

type Draft = { serviceTypeId: string | null; description: string; quantity: string; hours: string; price: string };
const draft = (l?: PackageLine): Draft => ({ serviceTypeId: l?.serviceTypeId ?? null, description: l?.description ?? "", quantity: l ? String(l.quantity) : "1", hours: l?.budgetedHours != null ? String(l.budgetedHours) : "", price: l?.unitPriceCents != null ? dollars(l.unitPriceCents) : "" });

function PackageForm({ pkg, onDone }: { pkg: Package | null; onDone: () => void }) {
  const services = useServices(false);
  const [name, setName] = useState(pkg?.name ?? "");
  const [description, setDescription] = useState(pkg?.description ?? "");
  const [active, setActive] = useState(pkg?.active ?? true);
  const [lines, setLines] = useState<Draft[]>(pkg?.lines.length ? pkg.lines.map(draft) : [draft()]);
  const save = useAction();
  const del = useAction();
  const setLine = (i: number, patch: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <form className="stack todo-form" onSubmit={(e) => {
      e.preventDefault();
      save.run(async () => {
        const body = {
          name, description, active,
          lines: lines.filter((l) => l.description.trim()).map((l) => ({
            serviceTypeId: l.serviceTypeId, description: l.description.trim(), quantity: Number(l.quantity) || 1,
            budgetedHours: l.hours.trim() === "" ? null : Number(l.hours), unitPriceCents: l.price.trim() === "" ? null : toCents(l.price),
          })),
        };
        if (pkg) await api(`/packages/${pkg.id}`, { method: "PUT", body }); else await api("/packages", { body });
        onDone();
      });
    }}>
      <div className="formgrid">
        <label>Package name *<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring round" /></label>
        <label>Description (optional)<input maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Fertilizer, pre-emergent and edging" /></label>
      </div>
      <div className="tablewrap">
        <table className="invoice-lines">
          <thead><tr><th style={{ width: "40%" }}>Item / service</th><th style={{ width: 80 }}>Qty</th><th style={{ width: 100 }}>Budgeted hours</th><th style={{ width: 140 }}>Price</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const s = services.list.find((x) => x.id === l.serviceTypeId);
            return (
              <tr key={i}>
                <td>
                  <select aria-label={`Item ${i + 1} service`} value={l.serviceTypeId ?? ""} onChange={(e) => {
                    const svc = services.list.find((x) => x.id === e.target.value);
                    setLine(i, { serviceTypeId: svc?.id ?? null, description: svc ? svc.name : l.description });
                  }}>
                    <option value="">Custom item</option>
                    {services.list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <input aria-label={`Item ${i + 1} description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" style={{ marginTop: 4 }} />
                  {s && <div className="muted" style={{ fontSize: 12 }}>{describePricing(s)}</div>}
                </td>
                <td><input aria-label={`Item ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                <td><input aria-label={`Item ${i + 1} budgeted hours`} inputMode="decimal" placeholder="0" value={l.hours} onChange={(e) => setLine(i, { hours: e.target.value })} /></td>
                <td><input aria-label={`Item ${i + 1} price`} inputMode="decimal" placeholder={l.serviceTypeId ? "For the lawn" : "0.00"} value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></td>
                <td><button type="button" className="btn" aria-label={`Remove item ${i + 1}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [draft()]))}>✕</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div><button type="button" className="btn" onClick={() => setLines((ls) => [...ls, draft()])}><Icon name="plus" size={14} /> Add item</button></div>
      <p className="muted" style={{ margin: 0 }}>Leave a service&apos;s price blank to price it for each property&apos;s lawn when the package is added.</p>
      {pkg && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (retired packages aren&apos;t offered on work orders)</label>}
      <ErrorBox error={save.error || del.error} />
      <div className="row">
        <button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : pkg ? "Save package" : "Add package"}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        {pkg && <button type="button" className="btn danger" style={{ marginLeft: "auto" }} disabled={del.busy}
          onClick={() => confirm(`Delete the ${pkg.name} package? Work orders already made from it keep their items.`) && del.run(async () => { await api(`/packages/${pkg.id}`, { method: "DELETE" }); onDone(); })}>Delete</button>}
      </div>
    </form>
  );
}

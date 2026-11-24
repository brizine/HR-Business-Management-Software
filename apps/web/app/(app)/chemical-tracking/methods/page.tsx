"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import type { Method } from "../products/page";

const blank = { name: "", gal: "", dry: false };

/**
 * How products go down: each truck, backpack or ZSpray setting with its spray volume, and the
 * spreader for dry products. Techs pick one when they complete a chemical work order; each product
 * has its own rate per method (Products tab). Separate from the Spray Mix Calculator on purpose.
 */
export default function Methods() {
  const list = useApi<Method[]>("/chemical-tracking/methods");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [f, setF] = useState(blank);
  const act = useAction();
  const rows = list.data ?? [];

  const start = (m: Method | null) => {
    setEditing(m ? m.id : "new");
    setF(m ? { name: m.name, gal: m.galPer1000 == null ? "" : String(m.galPer1000), dry: m.galPer1000 == null } : blank);
  };
  const body = (active = true) => ({ name: f.name, galPer1000: f.dry ? null : Number(f.gal.replace(/[,\s]/g, "")), active });
  const save = (m: Method | null) => act.run(async () => {
    if (!f.dry && !(Number(f.gal) > 0)) return act.setError("Enter the gallons of spray per 1,000 sq ft, or mark it dry");
    await api(m ? `/chemical-tracking/methods/${m.id}` : "/chemical-tracking/methods", { method: m ? "PUT" : "POST", body: m ? body(m.active) : body() });
    setEditing(null); list.reload();
  });
  const toggle = (m: Method) => act.run(async () => {
    await api(`/chemical-tracking/methods/${m.id}`, { method: "PUT", body: { name: m.name, galPer1000: m.galPer1000, active: !m.active } });
    list.reload();
  });
  const remove = (m: Method) => act.run(async () => { await api(`/chemical-tracking/methods/${m.id}`, { method: "DELETE" }); list.reload(); });
  const move = (i: number, d: number) => act.run(async () => {
    const ids = rows.map((r) => r.id); const j = i + d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api("/chemical-tracking/methods/order", { method: "PUT", body: { ids } });
    list.reload();
  });

  const form = (m: Method | null) => (
    <tr key={m?.id ?? "new"}>
      <td><input aria-label="Method name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Truck 2gal/1000ft" autoFocus /></td>
      <td className="row" style={{ alignItems: "center" }}>
        <input aria-label="Gallons per 1,000 sq ft" inputMode="decimal" style={{ width: 90 }} disabled={f.dry} value={f.dry ? "" : f.gal} onChange={(e) => setF({ ...f, gal: e.target.value })} />
        <label className="check"><input type="checkbox" checked={f.dry} onChange={(e) => setF({ ...f, dry: e.target.checked })} /> Dry (not mixed)</label>
      </td>
      <td />
      <td className="row"><button className="btn primary" disabled={act.busy} onClick={() => save(m)}>Save</button><button className="btn" onClick={() => setEditing(null)}>Cancel</button></td>
    </tr>
  );

  return (
    <>
      <PageHead title="Application methods"
        sub="How products are applied and how much spray each puts down. Techs choose one for each product when they complete a chemical work order, and it goes on the record.">
        <button className="btn primary" onClick={() => start(null)}>Add method</button>
      </PageHead>
      <ErrorBox error={list.error ?? act.error} />
      <div className="card tablewrap">
        {rows.length || editing ? (
          <table>
            <thead><tr><th>Method</th><th>Spray per 1,000 sq ft</th><th>Used on</th><th /></tr></thead>
            <tbody>
              {rows.map((m, i) => editing === m.id ? form(m) : (
                <tr key={m.id} style={{ opacity: m.active ? 1 : 0.6 }}>
                  <td><strong>{m.name}</strong>{!m.active && <> <span className="badge">off</span></>}</td>
                  <td>{m.galPer1000 == null ? "Dry (not mixed)" : `${+m.galPer1000.toFixed(4)} gal`}</td>
                  <td>{m.timesUsed ? `${m.timesUsed} application${m.timesUsed === 1 ? "" : "s"}` : <span className="muted">not yet</span>}</td>
                  <td className="row">
                    <button className="btn" aria-label="Move up" disabled={act.busy || i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button className="btn" aria-label="Move down" disabled={act.busy || i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button className="btn" onClick={() => start(m)}>Edit</button>
                    <button className="btn" disabled={act.busy} onClick={() => toggle(m)}>{m.active ? "Turn off" : "Turn on"}</button>
                    {!m.timesUsed && <button className="btn" disabled={act.busy} onClick={() => confirm(`Remove ${m.name}?`) && remove(m)}>Remove</button>}
                  </td>
                </tr>
              ))}
              {editing === "new" && form(null)}
            </tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>No methods yet.</Empty>}
      </div>
      <p className="muted">Changing a method's spray volume updates the product rates set for it from now on. Records already made keep the method and volume they were made with.</p>
    </>
  );
}

"use client";
import { useState } from "react";
import { formatMoney, formatRateAmount } from "@crewdesk/shared";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { ServiceChemicalsEditor, chemicalsOf, saveServiceChemicals, useChemicalCatalog, type ChemicalService, type ServiceChemicals } from "@/components/service-products";

type Service = ChemicalService;

/**
 * Which products each service applies (at which rate, between which dates) and where it's applied.
 * The price list shows the material cost from here; work orders prefill the tech's step from here.
 */
export default function Services() {
  const list = useApi<Service[]>("/chemical-tracking/services");
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rows = (list.data ?? []).filter((s) => showAll || (s.active && (s.chemical || s.products.length || s.mixes.length)));
  return (
    <>
      <PageHead title="Services" sub="The products and mixes each service applies, and where. Sets the material cost on the price list and what techs see prefilled when they complete it. Changes apply to every work order not yet completed; completed ones keep what was applied." />
      <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show every service <span className="muted">(not only chemical ones)</span></label>
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Service</th><th>Site</th><th>Products and mixes</th><th>Material / 1,000</th><th /></tr></thead>
            <tbody>{rows.map((s) => editing === s.id ? (
              <tr key={s.id}><td colSpan={5}><ServiceForm service={s} onDone={() => { setEditing(null); list.reload(); }} /></td></tr>
            ) : (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                <td><strong>{s.name}</strong>{s.chemical && <> <span className="badge">chemical</span></>}</td>
                <td>{s.applicationSite ?? <span className="muted">{s.chemical ? "not set" : "—"}</span>}</td>
                <td>{s.mixes.map((m) => (
                  <div key={m.id} style={{ opacity: m.applies ? 1 : 0.6 }}><strong>Mix: {m.mixName}</strong> <span className="muted">{m.items.map((i) => i.productName).join(", ")}{m.methodName ? ` · ${m.methodName}` : ""}{m.startDate || m.endDate ? ` · ${m.startDate ?? "…"} to ${m.endDate ?? "…"}` : ""}</span>{!m.mixActive && <> <span className="badge">mix off</span></>}</div>
                ))}{s.products.length ? s.products.map((l) => (
                  <div key={l.id} style={{ opacity: l.applies ? 1 : 0.6 }}>{l.productName} <span className="muted">{formatRateAmount(l.amountPer1000, l.unit)}{l.methodName ? ` · ${l.methodName}` : ""}{l.startDate || l.endDate ? ` · ${l.startDate ?? "…"} to ${l.endDate ?? "…"}` : ""}</span></div>
                )) : s.mixes.length ? null : <span className="muted">none</span>}</td>
                <td>{s.materialPer1000Cents != null ? formatMoney(Math.round(s.materialPer1000Cents)) : ""}{s.materialMissingCost ? <div className="badge warn">{s.materialMissingCost} without a cost</div> : null}</td>
                <td><button className="btn" onClick={() => setEditing(s.id)}>Edit</button></td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>No chemical services yet. Tick “Chemical application” on a service in the price list, or show every service.</Empty>}
      </div>
    </>
  );
}

function ServiceForm({ service, onDone }: { service: Service; onDone: () => void }) {
  const source = useChemicalCatalog();
  const [value, setValue] = useState<ServiceChemicals>(() => chemicalsOf(service));
  const { busy, error, run } = useAction();
  const save = () => run(async () => { await saveServiceChemicals(service.id, value); onDone(); });
  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>{service.name}</h3>
      <ServiceChemicalsEditor value={value} onChange={setValue} source={source} />
      <ErrorBox error={error ?? source.catalog.error} />
      <div className="row"><button className="btn primary" disabled={busy} onClick={save}>Save</button><button className="btn" onClick={onDone}>Cancel</button></div>
    </div>
  );
}

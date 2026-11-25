"use client";
import { useState } from "react";
import { appliesOn, costPerUseUnitCents, formatMoney, formatRateAmount } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Link { id: string; productId: string; productRateId: string; startDate: string | null; endDate: string | null; productName: string; rateName: string; amountPer1000: number; unit: string; costPer1000Cents: number | null; applies: boolean; methodName: string | null }
interface ServiceMix { id: string; mixId: string; mixName: string; methodName: string | null; startDate: string | null; endDate: string | null; applies: boolean; mixActive: boolean; costPer1000Cents: number | null; items: { productId: string; productName: string; amountPer1000: number; unit: string }[] }
interface Service { id: string; name: string; active: boolean; chemical: boolean; applicationSite: string | null; products: Link[]; mixes: ServiceMix[]; materialPer1000Cents: number | null; materialMissingCost: number }
interface MixOption { id: string; name: string; active: boolean; methodName: string | null; items: { productId: string; productName: string; ratePer1000: number; unit: string }[] }
interface Catalog { id: string; name: string; useUnit: string; purchaseUnitSize: number | null; active: boolean; currentCost: { costPerPurchaseUnitCents: number } | null; rates: { id: string; name: string; amountPer1000: number; applicationMethodId: string | null }[] }

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
  const catalog = useApi<Catalog[]>("/products?all=1");
  const [site, setSite] = useState(service.applicationSite ?? (service.chemical ? "Turf" : ""));
  const [links, setLinks] = useState(service.products.map((l) => ({ productId: l.productId, productRateId: l.productRateId, startDate: l.startDate ?? "", endDate: l.endDate ?? "" })));
  const mixOptions = useApi<MixOption[]>("/chemical-tracking/mixes");
  const [mixes, setMixes] = useState(service.mixes.map((m) => ({ mixId: m.mixId, startDate: m.startDate ?? "", endDate: m.endDate ?? "" })));
  const mixCost = (mixId: string) => {
    const m = mixOptions.data?.find((x) => x.id === mixId);
    if (!m) return null;
    let total = 0;
    for (const i of m.items) {
      const p = catalog.data?.find((x) => x.id === i.productId);
      const perUse = p ? costPerUseUnitCents(p.currentCost?.costPerPurchaseUnitCents, p.purchaseUnitSize) : null;
      if (perUse == null) return null;
      total += perUse * i.ratePer1000;
    }
    return total;
  };
  const { busy, error, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const products = (catalog.data ?? []).filter((p) => p.active || links.some((l) => l.productId === p.id));
  const linkCost = (l: { productId: string; productRateId: string }) => {
    const p = catalog.data?.find((x) => x.id === l.productId);
    const r = p?.rates.find((x) => x.id === l.productRateId);
    const perUse = p ? costPerUseUnitCents(p.currentCost?.costPerPurchaseUnitCents, p.purchaseUnitSize) : null;
    return { p, cost: r && perUse != null ? r.amountPer1000 * perUse : null };
  };
  const applying = links.filter((l) => l.productRateId && appliesOn({ startDate: l.startDate || null, endDate: l.endDate || null }, today));
  const mixesApplying = mixes.filter((m) => m.mixId && appliesOn({ startDate: m.startDate || null, endDate: m.endDate || null }, today));
  const material = applying.length || mixesApplying.length
    ? applying.reduce((s, l) => s + (linkCost(l).cost ?? 0), 0) + mixesApplying.reduce((s, m) => s + (mixCost(m.mixId) ?? 0), 0) : null;
  const save = () => run(async () => {
    await api(`/chemical-tracking/services/${service.id}`, { method: "PUT", body: { applicationSite: site } });
    const used = links.filter((l) => l.productId && l.productRateId);
    await api(`/chemical-tracking/services/${service.id}/products`, { method: "PUT", body: { products: used.map((l) => ({ ...l, startDate: l.startDate || null, endDate: l.endDate || null })) } });
    await api(`/chemical-tracking/services/${service.id}/mixes`, { method: "PUT", body: { mixes: mixes.filter((m) => m.mixId).map((m) => ({ mixId: m.mixId, startDate: m.startDate || null, endDate: m.endDate || null })) } });
    onDone();
  });
  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>{service.name}</h3>
      <label style={{ maxWidth: 480 }}>Site where applied <span className="muted">(on chemical records, e.g. Turf – front and back lawn)</span><input value={site} onChange={(e) => setSite(e.target.value)} /></label>
      <h4 style={{ margin: "8px 0 0" }}>Products</h4>
      {links.map((l, i) => {
        const { p, cost } = linkCost(l);
        const upd = (patch: Partial<typeof l>) => setLinks(links.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={i} className="row">
            <label style={{ flex: 1, minWidth: 200 }}>Product
              <select value={l.productId} onChange={(e) => { const np = catalog.data?.find((x) => x.id === e.target.value); upd({ productId: e.target.value, productRateId: np?.rates[0]?.id ?? "" }); }}>
                <option value="">Pick a product…</option>
                {products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label style={{ width: 240 }}>Rate per 1,000 sq ft
              <select value={l.productRateId} onChange={(e) => upd({ productRateId: e.target.value })} disabled={!p}>
                {!p?.rates.length && <option value="">No rates yet</option>}
                {p?.rates.map((r) => <option key={r.id} value={r.id}>{r.name}: {formatRateAmount(r.amountPer1000, p.useUnit)}</option>)}
              </select>
            </label>
            <label style={{ width: 150 }}>From <span className="muted">(optional)</span><input type="date" value={l.startDate} onChange={(e) => upd({ startDate: e.target.value })} /></label>
            <label style={{ width: 150 }}>Until <span className="muted">(optional)</span><input type="date" value={l.endDate} onChange={(e) => upd({ endDate: e.target.value })} /></label>
            <div className="muted" style={{ alignSelf: "flex-end", minWidth: 110 }}>{p && l.productRateId ? (cost == null ? "no cost yet" : `${formatMoney(Math.round(cost))} / 1,000`) : ""}</div>
            <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setLinks(links.filter((_, j) => j !== i))}>Remove</button>
          </div>
        );
      })}
      <h4 style={{ margin: "8px 0 0" }}>Mixes</h4>
      {mixes.map((m, i) => {
        const opt = mixOptions.data?.find((x) => x.id === m.mixId);
        const cost = m.mixId ? mixCost(m.mixId) : null;
        const upd = (patch: Partial<typeof m>) => setMixes(mixes.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={`mix-${i}`} className="row">
            <label style={{ flex: 1, minWidth: 200 }}>Mix
              <select value={m.mixId} onChange={(e) => upd({ mixId: e.target.value })}>
                <option value="">Pick a mix…</option>
                {(mixOptions.data ?? []).filter((x) => x.active || x.id === m.mixId).map((x) => <option key={x.id} value={x.id} disabled={x.id !== m.mixId && mixes.some((y) => y.mixId === x.id)}>{x.name}</option>)}
              </select>
              {opt && <span className="muted" style={{ fontSize: 13 }}>{opt.items.map((x) => `${x.productName} ${formatRateAmount(x.ratePer1000, x.unit)}`).join(" · ")}{opt.methodName ? ` · ${opt.methodName}` : ""}</span>}
            </label>
            <label style={{ width: 150 }}>From <span className="muted">(optional)</span><input type="date" value={m.startDate} onChange={(e) => upd({ startDate: e.target.value })} /></label>
            <label style={{ width: 150 }}>Until <span className="muted">(optional)</span><input type="date" value={m.endDate} onChange={(e) => upd({ endDate: e.target.value })} /></label>
            <div className="muted" style={{ alignSelf: "flex-end", minWidth: 110 }}>{m.mixId ? (cost == null ? "no cost yet" : `${formatMoney(Math.round(cost))} / 1,000`) : ""}</div>
            <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setMixes(mixes.filter((_, j) => j !== i))}>Remove</button>
          </div>
        );
      })}
      <div className="row">
        <button type="button" className="btn" onClick={() => setLinks([...links, { productId: "", productRateId: "", startDate: "", endDate: "" }])}>Add a product</button>
        <button type="button" className="btn" disabled={!mixOptions.data?.some((x) => x.active)} onClick={() => setMixes([...mixes, { mixId: "", startDate: "", endDate: "" }])}>Add a mix</button>
        {material != null && <strong>Material today: {formatMoney(Math.round(material))} per 1,000 sq ft</strong>}
        {catalog.data && !catalog.data.length && <span className="muted">Add products on the Products tab first.</span>}
        {mixOptions.data && !mixOptions.data.some((x) => x.active) && <span className="muted">Mixes are made on the Mixes tab.</span>}
      </div>
      <ErrorBox error={error ?? catalog.error} />
      <div className="row"><button className="btn primary" disabled={busy} onClick={save}>Save</button><button className="btn" onClick={onDone}>Cancel</button></div>
    </div>
  );
}

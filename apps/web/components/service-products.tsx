"use client";
import { appliesOn, costPerUseUnitCents, formatMoney, formatRateAmount } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";

/**
 * The products and mixes a service applies, and where: the same editor on the price list (when a
 * service is ticked as a chemical application) and in Chemical Tracking → Services. Sets the
 * material cost on the price list and what techs see prefilled when they complete the work order.
 * Only people who can open Chemical Tracking can load or save it.
 */

export type ProductDraft = { productId: string; productRateId: string; startDate: string; endDate: string };
export type MixDraft = { mixId: string; startDate: string; endDate: string };
export type ServiceChemicals = { site: string; links: ProductDraft[]; mixes: MixDraft[] };
/** A service as Chemical Tracking lists it. */
export interface ChemicalService {
  id: string; name: string; active: boolean; chemical: boolean; applicationSite: string | null;
  products: { id: string; productId: string; productRateId: string; startDate: string | null; endDate: string | null; productName: string; rateName: string; amountPer1000: number; unit: string; costPer1000Cents: number | null; applies: boolean; methodName: string | null }[];
  mixes: { id: string; mixId: string; mixName: string; methodName: string | null; startDate: string | null; endDate: string | null; applies: boolean; mixActive: boolean; costPer1000Cents: number | null; items: { productId: string; productName: string; amountPer1000: number; unit: string }[] }[];
  materialPer1000Cents: number | null; materialMissingCost: number;
}
interface MixOption { id: string; name: string; active: boolean; methodName: string | null; items: { productId: string; productName: string; ratePer1000: number; unit: string }[] }
interface Catalog { id: string; name: string; useUnit: string; purchaseUnitSize: number | null; active: boolean; currentCost: { costPerPurchaseUnitCents: number } | null; rates: { id: string; name: string; amountPer1000: number; applicationMethodId: string | null }[] }

export const emptyChemicals = (chemical = true): ServiceChemicals => ({ site: chemical ? "Turf" : "", links: [], mixes: [] });
/** What a service applies now, as the editor holds it. */
export const chemicalsOf = (s: Pick<ChemicalService, "applicationSite" | "chemical" | "products" | "mixes">): ServiceChemicals => ({
  site: s.applicationSite ?? (s.chemical ? "Turf" : ""),
  links: s.products.map((l) => ({ productId: l.productId, productRateId: l.productRateId, startDate: l.startDate ?? "", endDate: l.endDate ?? "" })),
  mixes: s.mixes.map((m) => ({ mixId: m.mixId, startDate: m.startDate ?? "", endDate: m.endDate ?? "" })),
});

/** The product list and the mixes, loaded once for the editor (`on` false: not loaded, for people outside Chemical Tracking). */
export function useChemicalCatalog(on = true) {
  const catalog = useApi<Catalog[]>(on ? "/products?all=1" : null);
  const mixes = useApi<MixOption[]>(on ? "/chemical-tracking/mixes" : null);
  return { catalog, mixes };
}

/** Saves where it's applied, its products and its mixes. */
export async function saveServiceChemicals(serviceId: string, v: ServiceChemicals) {
  await api(`/chemical-tracking/services/${serviceId}`, { method: "PUT", body: { applicationSite: v.site } });
  const used = v.links.filter((l) => l.productId && l.productRateId);
  await api(`/chemical-tracking/services/${serviceId}/products`, { method: "PUT", body: { products: used.map((l) => ({ ...l, startDate: l.startDate || null, endDate: l.endDate || null })) } });
  await api(`/chemical-tracking/services/${serviceId}/mixes`, { method: "PUT", body: { mixes: v.mixes.filter((m) => m.mixId).map((m) => ({ mixId: m.mixId, startDate: m.startDate || null, endDate: m.endDate || null })) } });
}

export function ServiceChemicalsEditor({ value, onChange, source }: { value: ServiceChemicals; onChange: (v: ServiceChemicals) => void; source: ReturnType<typeof useChemicalCatalog> }) {
  const { catalog, mixes: mixOptions } = source;
  const { links, mixes } = value;
  const today = new Date().toISOString().slice(0, 10);
  const products = (catalog.data ?? []).filter((p) => p.active || links.some((l) => l.productId === p.id));
  const linkCost = (l: { productId: string; productRateId: string }) => {
    const p = catalog.data?.find((x) => x.id === l.productId);
    const r = p?.rates.find((x) => x.id === l.productRateId);
    const perUse = p ? costPerUseUnitCents(p.currentCost?.costPerPurchaseUnitCents, p.purchaseUnitSize) : null;
    return { p, cost: r && perUse != null ? r.amountPer1000 * perUse : null };
  };
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
  const applying = links.filter((l) => l.productRateId && appliesOn({ startDate: l.startDate || null, endDate: l.endDate || null }, today));
  const mixesApplying = mixes.filter((m) => m.mixId && appliesOn({ startDate: m.startDate || null, endDate: m.endDate || null }, today));
  // What it costs today, from the products and mixes that have a cost; the ones without are counted, not shown as $0.
  const parts = [...applying.map((l) => linkCost(l).cost), ...mixesApplying.map((m) => mixCost(m.mixId))];
  const noCost = parts.filter((c) => c == null).length;
  const material = parts.some((c) => c != null) ? parts.reduce((s: number, c) => s + (c ?? 0), 0) : null;
  const setLinks = (next: ProductDraft[]) => onChange({ ...value, links: next });
  const setMixes = (next: MixDraft[]) => onChange({ ...value, mixes: next });
  return (
    <div className="stack">
      <label style={{ maxWidth: 480 }}>Site where applied <span className="muted">(on chemical records, e.g. Turf – front and back lawn)</span><input value={value.site} onChange={(e) => onChange({ ...value, site: e.target.value })} /></label>
      <h4 style={{ margin: "8px 0 0" }}>Products</h4>
      {!links.length && <span className="muted">None yet.</span>}
      {links.map((l, i) => {
        const { p, cost } = linkCost(l);
        const upd = (patch: Partial<ProductDraft>) => setLinks(links.map((x, j) => (j === i ? { ...x, ...patch } : x)));
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
      {!mixes.length && <span className="muted">None yet.</span>}
      {mixes.map((m, i) => {
        const opt = mixOptions.data?.find((x) => x.id === m.mixId);
        const cost = m.mixId ? mixCost(m.mixId) : null;
        const upd = (patch: Partial<MixDraft>) => setMixes(mixes.map((x, j) => (j === i ? { ...x, ...patch } : x)));
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
        {noCost > 0 && <span className="muted">{material != null ? `(${noCost} without a cost yet, so not counted)` : "Material cost: none yet. Add what you pay for it in Chemical Tracking → Products."}</span>}
        {catalog.data && !catalog.data.length && <span className="muted">Add products in Chemical Tracking → Products first.</span>}
        {mixOptions.data && !mixOptions.data.some((x) => x.active) && <span className="muted">Mixes are made in Chemical Tracking → Mixes.</span>}
      </div>
    </div>
  );
}

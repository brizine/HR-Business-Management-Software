"use client";
import { useState } from "react";
import {
  FORMULATIONS, FORMULATION_LABELS, INCOME_ACCOUNTS, MIX_UNITS, PRODUCT_TYPES, PRODUCT_TYPE_LABELS,
  SIGNAL_WORDS, SIGNAL_WORD_LABELS, costPerUseUnitCents, formatMoney, formatRateAmount, rateCostPer1000Cents,
  type Formulation, type ProductType,
} from "@crewdesk/shared";
import { useAction, useApi, useNewForm } from "@/lib/hooks";
import { API_URL, api, fmtDate } from "@/lib/api";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { toCents } from "@/components/invoices";

interface Rate { id: string; name: string; amountPer1000: number; method: string; carrierGalPer1000: number | null; applicationMethodId: string | null }
export interface Method { id: string; name: string; galPer1000: number | null; active: boolean; sortOrder: number; timesUsed: number }
interface Cost { id: string; costPerPurchaseUnitCents: number; vendor: string | null; effectiveFrom: string }
interface Product {
  id: string; name: string; manufacturer: string | null; productType: string; formulation: string | null;
  activeIngredients: { name: string; percent: number | null }[]; epaRegNo: string | null; restrictedUse: boolean; signalWord: string;
  reiHours: number | null; targets: string | null; useUnit: string; purchaseUnitName: string | null; purchaseUnitSize: number | null;
  labelMaxPer1000: number | null; labelMaxPerYearPer1000: number | null; labelInstructions: string | null; customerNote: string | null;
  incomeAccountCode: string | null; cogsAccountCode: string | null; taxable: boolean; trackRecords: boolean; active: boolean;
  requiredAdjuvant: string | null; requiredDriftAgent: string | null;
  rates: Rate[]; costs: Cost[]; currentCost: Omit<Cost, "id"> | null; costPerUseUnitCents: number | null;
}

/** Fractional cents (a few cents of product per 1,000 sq ft) shown to the cent, or to a tenth of a cent when small. */
const money = (c: number) => (c < 100 && c % 1 ? `$${(c / 100).toFixed(3)}` : formatMoney(Math.round(c)));
const short = (unit: string) => formatRateAmount(1, unit).replace(/^1 /, "");

/** The product list: chemicals and fertilizers, once each, for budgeting and chemical records. */
export default function Products() {
  // Everyone who can open Chemical Tracking keeps the product list.
  const admin = true;
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const list = useApi<Product[]>(`/products?${new URLSearchParams({ ...(all ? { all: "1" } : {}), ...(q.trim() ? { q: q.trim() } : {}) })}`);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  useNewForm(() => { if (admin) setEditing("new"); });
  const rows = list.data ?? [];
  return (
    <>
      <PageHead title="Products"
        sub="Chemicals and fertilizers, listed once each with their rates for each application method and their costs. Budgets, estimates and chemical records use these, never the Spray Mix Calculator.">
        {admin && <button className="btn primary" onClick={() => setEditing("new")}>Add product</button>}
      </PageHead>
      {editing && <ProductForm key={editing === "new" ? "new" : editing.id} product={editing === "new" ? null : editing} onDone={(saved) => { setEditing(saved ?? null); list.reload(); }} onClose={() => { setEditing(null); list.reload(); }} />}
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Search name, maker or EPA #" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show inactive</label>
      </div>
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Product</th><th>Type</th><th>Rates per 1,000 sq ft</th><th>Cost</th><th>Records</th>{admin && <th />}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id} style={{ opacity: p.active ? 1 : 0.6 }}>
                <td>
                  <strong>{p.name}</strong>
                  <div className="muted">{[p.manufacturer, p.epaRegNo && `EPA ${p.epaRegNo}`].filter(Boolean).join(" · ")}</div>
                </td>
                <td>{PRODUCT_TYPE_LABELS[p.productType as ProductType] ?? p.productType}</td>
                <td>{p.rates.length ? p.rates.map((r) => {
                  const c = rateCostPer1000Cents(r.amountPer1000, p.costPerUseUnitCents);
                  return <div key={r.id}>{r.name}: {formatRateAmount(r.amountPer1000, p.useUnit)}{c != null && <span className="muted"> · {money(c)}</span>}</div>;
                }) : <span className="muted">No rates yet</span>}</td>
                <td>{p.currentCost ? (
                  <>
                    {formatMoney(p.currentCost.costPerPurchaseUnitCents)}{p.purchaseUnitName ? ` / ${p.purchaseUnitName}` : ""}
                    {p.costPerUseUnitCents != null && <div className="muted">{money(p.costPerUseUnitCents)} per {short(p.useUnit)}</div>}
                  </>
                ) : <span className="badge warn">no cost</span>}</td>
                <td>
                  {p.trackRecords ? <span className="badge ok">tracked</span> : <span className="muted">not tracked</span>}
                  {p.restrictedUse && <> <span className="badge bad">RUP</span></>}
                  {!p.active && <> <span className="badge">inactive</span></>}
                </td>
                {admin && <td><button className="btn" onClick={() => setEditing(p)}>Edit</button></td>}
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{q ? "No products match." : "No products yet. Add the chemicals and fertilizers you apply."}</Empty>}
      </div>
    </>
  );
}

const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/[,\s]/g, "")));
const str = (n: number | null | undefined) => (n == null ? "" : String(n));

function ProductForm({ product, onDone, onClose }: { product: Product | null; onDone: (saved?: Product) => void; onClose: () => void }) {
  const p = product;
  const [f, setF] = useState({
    name: p?.name ?? "", manufacturer: p?.manufacturer ?? "", productType: (p?.productType ?? "herbicide") as ProductType,
    formulation: (p?.formulation ?? "") as Formulation | "", epaRegNo: p?.epaRegNo ?? "", restrictedUse: p?.restrictedUse ?? false,
    signalWord: p?.signalWord ?? "none", reiHours: str(p?.reiHours), targets: p?.targets ?? "",
    useUnit: p?.useUnit ?? "ounces liquid", purchaseUnitName: p?.purchaseUnitName ?? "", purchaseUnitSize: str(p?.purchaseUnitSize),
    labelMaxPer1000: str(p?.labelMaxPer1000), labelMaxPerYearPer1000: str(p?.labelMaxPerYearPer1000),
    labelInstructions: p?.labelInstructions ?? "", customerNote: p?.customerNote ?? "",
    incomeAccountCode: p?.incomeAccountCode ?? "", cogsAccountCode: p?.cogsAccountCode ?? "",
    taxable: p?.taxable ?? false, trackRecords: p?.trackRecords ?? true, active: p?.active ?? true,
    requiredAdjuvant: p?.requiredAdjuvant ?? "", requiredDriftAgent: p?.requiredDriftAgent ?? "",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [ais, setAis] = useState(p?.activeIngredients.length ? p.activeIngredients.map((a) => ({ name: a.name, percent: str(a.percent) })) : [{ name: "", percent: "" }]);
  const methods = useApi<Method[]>("/chemical-tracking/methods");
  const methodList = (methods.data ?? []).filter((m) => m.active || (p?.rates ?? []).some((r) => r.applicationMethodId === m.id));
  const [rates, setRates] = useState(p?.rates.length
    ? p.rates.map((r) => ({ id: r.id as string | undefined, name: r.name, amount: str(r.amountPer1000), methodId: r.applicationMethodId ?? "" }))
    : [{ id: undefined as string | undefined, name: "", amount: "", methodId: "" }]);
  const [cost, setCost] = useState({ amount: "", vendor: "", from: new Date().toISOString().slice(0, 10) });
  const { busy, error, run, setError } = useAction();
  const unit = short(f.useUnit);
  const perUse = p?.currentCost ? costPerUseUnitCents(p.currentCost.costPerPurchaseUnitCents, num(f.purchaseUnitSize)) : null;

  const save = () => run(async () => {
    if (!f.name.trim()) return setError("Name the product");
    const usedRates = rates.filter((r) => r.name.trim() || r.amount.trim());
    const nameOf = (id: string) => methodList.find((m) => m.id === id)?.name ?? "";
    if (usedRates.some((r) => !r.methodId)) return setError("Pick how each rate is applied");
    const body = {
      ...f,
      formulation: f.formulation || null,
      reiHours: num(f.reiHours), purchaseUnitSize: num(f.purchaseUnitSize),
      labelMaxPer1000: num(f.labelMaxPer1000), labelMaxPerYearPer1000: num(f.labelMaxPerYearPer1000),
      activeIngredients: ais.filter((a) => a.name.trim()).map((a) => ({ name: a.name, percent: num(a.percent) })),
      // The method sets the spray volume; a rate with no name is called by its method.
      rates: usedRates.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim() || nameOf(r.methodId), amountPer1000: num(r.amount) ?? 0, applicationMethodId: r.methodId })),
    };
    const saved = await api<Product>(p ? `/products/${p.id}` : "/products", { method: p ? "PUT" : "POST", body });
    if (!p && cost.amount.trim()) {
      await api(`/products/${saved.id}/costs`, { method: "POST", body: { costPerPurchaseUnitCents: toCents(cost.amount), vendor: cost.vendor, effectiveFrom: cost.from } });
    }
    onDone();
  });
  const addCost = () => run(async () => {
    if (!p || !cost.amount.trim()) return setError("Enter the cost");
    const saved = await api<Product>(`/products/${p.id}/costs`, { method: "POST", body: { costPerPurchaseUnitCents: toCents(cost.amount), vendor: cost.vendor, effectiveFrom: cost.from } });
    setCost({ ...cost, amount: "" });
    onDone(saved);
  });
  const removeCost = (id: string) => run(async () => { if (p) onDone(await api<Product>(`/products/${p.id}/costs/${id}`, { method: "DELETE" })); });

  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <h3 style={{ margin: 0 }}>{p ? `Edit ${p.name}` : "New product"}</h3>
      <div className="formgrid">
        <label>Name<input value={f.name} onChange={(e) => set("name", e.target.value)} required placeholder="e.g. Resolute 4FL" /></label>
        <label>Manufacturer<input value={f.manufacturer} onChange={(e) => set("manufacturer", e.target.value)} /></label>
        <label>Type<select value={f.productType} onChange={(e) => set("productType", e.target.value as ProductType)}>{PRODUCT_TYPES.map((t) => <option key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</option>)}</select></label>
        <label>Formulation<select value={f.formulation} onChange={(e) => set("formulation", e.target.value as Formulation | "")}><option value="">—</option>{FORMULATIONS.map((t) => <option key={t} value={t}>{FORMULATION_LABELS[t]}</option>)}</select></label>
        <label>EPA registration #<input value={f.epaRegNo} onChange={(e) => set("epaRegNo", e.target.value)} placeholder="e.g. 432-1507" /></label>
        <label>Signal word<select value={f.signalWord} onChange={(e) => set("signalWord", e.target.value)}>{SIGNAL_WORDS.map((w) => <option key={w} value={w}>{SIGNAL_WORD_LABELS[w]}</option>)}</select></label>
      </div>
      <fieldset className="contacts">
        <legend>Active ingredients</legend>
        {ais.map((a, i) => (
          <div key={i} className="row">
            <label style={{ flex: 1 }}>Ingredient<input value={a.name} onChange={(e) => setAis(ais.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></label>
            <label style={{ width: 110 }}>%<input inputMode="decimal" value={a.percent} onChange={(e) => setAis(ais.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} /></label>
            {ais.length > 1 && <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setAis(ais.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        <div><button type="button" className="btn" onClick={() => setAis([...ais, { name: "", percent: "" }])}>Add an ingredient</button></div>
      </fieldset>

      <fieldset className="contacts">
        <legend>Buying and cost</legend>
        <div className="formgrid">
          <label>Measured in<select value={f.useUnit} onChange={(e) => set("useUnit", e.target.value)}>{MIX_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
          <label>Bought as<input value={f.purchaseUnitName} onChange={(e) => set("purchaseUnitName", e.target.value)} placeholder="e.g. 2.5 gal jug, 50 lb bag" /></label>
          <label>Which holds ({unit})<input inputMode="decimal" value={f.purchaseUnitSize} onChange={(e) => set("purchaseUnitSize", e.target.value)} placeholder="e.g. 320" /></label>
        </div>
        {p && p.costs.length > 0 && (
          <table>
            <thead><tr><th>From</th><th>Cost</th><th>Per {unit}</th><th>Vendor</th><th /></tr></thead>
            <tbody>{p.costs.map((c) => {
              const per = costPerUseUnitCents(c.costPerPurchaseUnitCents, num(f.purchaseUnitSize));
              const current = p.currentCost?.effectiveFrom === c.effectiveFrom && p.currentCost.costPerPurchaseUnitCents === c.costPerPurchaseUnitCents;
              return (
                <tr key={c.id}>
                  <td>{c.effectiveFrom} {current && <span className="badge ok">current</span>}</td>
                  <td>{formatMoney(c.costPerPurchaseUnitCents)}</td>
                  <td>{per == null ? "" : money(per)}</td>
                  <td>{c.vendor ?? ""}</td>
                  <td><button type="button" className="btn" disabled={busy} onClick={() => removeCost(c.id)}>Remove</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        <div className="row">
          <label style={{ width: 170 }}>{p ? "New cost" : "Cost"} per {f.purchaseUnitName || "purchase unit"} ($)<input inputMode="decimal" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} /></label>
          <label style={{ width: 170 }}>From<input type="date" value={cost.from} onChange={(e) => setCost({ ...cost, from: e.target.value })} /></label>
          <label style={{ flex: 1 }}>Vendor<input value={cost.vendor} onChange={(e) => setCost({ ...cost, vendor: e.target.value })} /></label>
          {p && <button type="button" className="btn" style={{ alignSelf: "flex-end" }} disabled={busy} onClick={addCost}>Add cost</button>}
        </div>
        <p className="muted" style={{ margin: 0 }}>A new cost applies from its date on; earlier jobs keep the cost of their day.</p>
      </fieldset>

      <fieldset className="contacts">
        <legend>Application rates <span className="muted">(per 1,000 sq ft, in {unit}, for each way it's applied)</span></legend>
        {rates.map((r, i) => {
          const c = rateCostPer1000Cents(num(r.amount) ?? 0, perUse);
          const upd = (patch: Partial<typeof r>) => setRates(rates.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={r.id ?? `new-${i}`} className="row">
              <label style={{ width: 210 }}>Applied with<select value={r.methodId} onChange={(e) => upd({ methodId: e.target.value })}>
                <option value="">Pick a method…</option>
                {methodList.map((m) => <option key={m.id} value={m.id}>{m.name}{m.active ? "" : " (off)"}</option>)}
              </select></label>
              <label style={{ width: 130 }}>Amount ({unit})<input inputMode="decimal" value={r.amount} onChange={(e) => upd({ amount: e.target.value })} /></label>
              <label style={{ width: 220 }}>Name <span className="muted">(optional)</span><input value={r.name} onChange={(e) => upd({ name: e.target.value })} placeholder="e.g. High, Round 1" /></label>
              <div style={{ alignSelf: "flex-end", minWidth: 110 }} className="muted">{c != null && num(r.amount) ? `${money(c)} / 1,000` : ""}</div>
              {rates.length > 1 && <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setRates(rates.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          );
        })}
        <div><button type="button" className="btn" onClick={() => setRates([...rates, { id: undefined, name: "", amount: "", methodId: "" }])}>Add a rate</button></div>
        <p className="muted" style={{ margin: 0 }}>Techs pick how they applied it; the rate for that method fills in. Methods and their spray volumes are on the Application methods tab.</p>
      </fieldset>

      <fieldset className="contacts">
        <legend>Label and safety</legend>
        <div className="formgrid">
          <label>Label max per application ({unit} / 1,000)<input inputMode="decimal" value={f.labelMaxPer1000} onChange={(e) => set("labelMaxPer1000", e.target.value)} /></label>
          <label>Label max per year ({unit} / 1,000)<input inputMode="decimal" value={f.labelMaxPerYearPer1000} onChange={(e) => set("labelMaxPerYearPer1000", e.target.value)} /></label>
          <label>Re-entry interval (hours)<input inputMode="decimal" value={f.reiHours} onChange={(e) => set("reiHours", e.target.value)} /></label>
        </div>
        <label>Targets (weeds, pests or diseases)<input value={f.targets} onChange={(e) => set("targets", e.target.value)} /></label>
        <label>Label instructions<textarea rows={3} value={f.labelInstructions} onChange={(e) => set("labelInstructions", e.target.value)} /></label>
        <label>Note for the customer <span className="muted">(route sheet and after-visit message)</span><textarea rows={2} value={f.customerNote} onChange={(e) => set("customerNote", e.target.value)} placeholder="e.g. Water in within 24 hours. Keep pets off until dry." /></label>
        <div className="formgrid">
          <label>Adjuvant the label requires <span className="muted">(if any)</span><input value={f.requiredAdjuvant} onChange={(e) => set("requiredAdjuvant", e.target.value)} placeholder="e.g. a nonionic surfactant product name" /></label>
          <label>Drift agent the label requires <span className="muted">(if any)</span><input value={f.requiredDriftAgent} onChange={(e) => set("requiredDriftAgent", e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.restrictedUse} onChange={(e) => set("restrictedUse", e.target.checked)} /> Restricted use pesticide (RUP)</label>
        {p ? <ProductLabels productId={p.id} /> : <p className="muted" style={{ margin: 0 }}>Save the product, then upload its label here (chemical records link to it).</p>}
      </fieldset>

      <fieldset className="contacts">
        <legend>Accounting and records</legend>
        <div className="formgrid">
          <label>Income account<select value={f.incomeAccountCode} onChange={(e) => set("incomeAccountCode", e.target.value)}><option value="">—</option>{INCOME_ACCOUNTS.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
          <label>Cost of goods account<input value={f.cogsAccountCode} onChange={(e) => set("cogsAccountCode", e.target.value)} placeholder="e.g. 5000" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.trackRecords} onChange={(e) => set("trackRecords", e.target.checked)} /> Record every application (state chemical records)</label>
        <label className="check"><input type="checkbox" checked={f.taxable} onChange={(e) => set("taxable", e.target.checked)} /> Taxable when sold</label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active <span className="muted">(untick to make it inactive)</span></label>
      </fieldset>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" onClick={onClose}>{p ? "Close" : "Cancel"}</button>
      </div>
    </form>
  );
}


/** The product's labels (PDF or photo), newest first; each chemical record links the one in force that day. */
function ProductLabels({ productId }: { productId: string }) {
  const labels = useApi<{ id: string; fileName: string; sizeBytes: number; createdAt: string }[]>(`/chemical-records/labels/${productId}`);
  const act = useAction();
  const upload = (file: File | undefined) => file && act.run(async () => {
    const fd = new FormData();
    fd.append("file", file);
    await api(`/chemical-records/labels/${productId}`, { method: "POST", body: fd });
    labels.reload();
  });
  const list = labels.data ?? [];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong>Product label</strong>
      {list.length ? list.map((l, i) => (
        <div key={l.id}><a href={`${API_URL}/chemical-records/label-files/${l.id}`} target="_blank" rel="noreferrer">{l.fileName}</a> <span className="muted">uploaded {fmtDate(l.createdAt)}{i === 0 ? " · current" : ""}</span></div>
      )) : <span className="badge warn" style={{ alignSelf: "flex-start" }}>no label on file</span>}
      <label style={{ maxWidth: 360 }}>{list.length ? "Upload a newer label" : "Upload the label"} <span className="muted">(PDF or photo; older ones are kept)</span>
        <input type="file" accept="application/pdf,image/*" disabled={act.busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <ErrorBox error={act.error} />
    </div>
  );
}

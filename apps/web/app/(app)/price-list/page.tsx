"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { INCOME_ACCOUNTS, LAWN_AREA_LABELS, PRICING_KINDS, PRICING_LABELS, SERVICE_LAWN_AREAS, describePricing, formatMoney, formatRateAmount, priceFor, sizeMinutes, tieredBreakdown, type PricedService, type PricingKind } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi, useNewForm } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Grip, useDragOrder } from "@/components/drag-order";
import { readLocal, writeLocal } from "@/components/customer-list";
import { ServiceChemicalsEditor, chemicalsOf, emptyChemicals, saveServiceChemicals, useChemicalCatalog, type ChemicalService, type ServiceChemicals } from "@/components/service-products";
import { dollars, toCents, useServices, type ServiceType } from "@/components/invoices";
import { PackagesCard } from "@/components/packages";

/** The services price list. Everyone in Customers & billing sees it; admins change it. */
export default function PriceList() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const services = useServices(true);
  // A service being changed, a new one, or a new one started as a copy of another.
  const [editing, setEditing] = useState<ServiceType | "new" | { copy: ServiceType } | null>(null);
  const formKey = editing == null ? "" : editing === "new" ? "new" : "copy" in editing ? `copy-${editing.copy.id}` : editing.id;
  useNewForm(() => { if (admin) setEditing("new"); });
  const action = useAction();
  const list = services.list;
  const drag = useDragOrder(list.map((s) => s.id), (ids) => action.run(async () => { await api("/service-types/order", { method: "PUT", body: { ids } }); await services.reload(); }), { disabled: !admin, busy: action.busy });
  const account = (code: string) => INCOME_ACCOUNTS.find((a) => a.code === code);
  return (
    <>
      <PageHead title="Products & services"
        sub="Your price list: the services you sell and how each is priced. Invoices, work orders and estimates fill in the price from the property's lawn size.">
        {admin && <button className="btn primary" onClick={() => setEditing("new")}>Add service</button>}
      </PageHead>
      {editing && <ServiceForm key={formKey} service={editing === "new" || "copy" in editing ? null : editing} copyFrom={editing !== "new" && "copy" in editing ? editing.copy : null} onDone={() => { setEditing(null); services.reload(); }} />}
      <ErrorBox error={action.error} />
      <div className="card tablewrap">
        {list.length ? (
          <table>
            <thead><tr>{admin && <th className="drag-col" aria-label="Order" />}<th>Service</th><th>Priced</th><th>Income account</th><th>Taxable</th><th>Status</th>{admin && <th />}</tr></thead>
            <tbody ref={drag.box}>{drag.sorted(list, (s) => s.id).map((s) => (
              <tr key={s.id} {...drag.row(s.id)} style={{ opacity: s.active ? 1 : 0.6 }}>
                {admin && <td className="drag-col"><Grip drag={drag} id={s.id} name={s.name} /></td>}
                <td><strong>{s.name}</strong>{s.chemical && <span className="badge" style={{ marginLeft: 6 }} title="Keeps chemical application records">chemical</span>}{s.description && <div className="muted">{s.description}</div>}</td>
                <td title={describePricing(s)}>{PRICING_LABELS[s.pricing as PricingKind] ?? s.pricing}</td>
                <td>{s.incomeAccountCode} {account(s.incomeAccountCode)?.name ?? ""}</td>
                <td>{s.taxable ? "Yes" : <span className="muted">No</span>}</td>
                <td>{s.active ? <span className="badge ok">active</span> : <span className="badge">retired</span>}</td>
                {admin && (
                  <td className="row">
                    <button className="btn" onClick={() => setEditing(s)}>Edit</button>
                    <button className="btn" title="Start a new service with everything this one has: pricing, time estimate, products and mixes" onClick={() => { setEditing({ copy: s }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Copy</button>
                  </td>
                )}
              </tr>
            ))}</tbody>
          </table>
        ) : services.loading ? <Empty>Loading…</Empty> : <Empty>No services yet.{admin ? " Add your lawn programs, pest control and one-time services." : " An admin adds them."}</Empty>}
      </div>
      <PackagesCard />
    </>
  );
}

/** What each way of pricing does, in a sentence (under the Priced box). */
const PRICING_HELP: Record<PricingKind, string> = {
  flat: "One price for every lawn, whatever its size.",
  per_thousand: "The lawn's size times one rate per 1,000 sq ft, never less than the minimum. The price rises smoothly with every square foot.",
  bracket: "A fixed price for each size range, typed in by you (up to 5,000 sq ft $60, up to 8,000 sq ft $75, anything bigger $95). A lawn pays the price of the first range it fits in. No rate is worked out, so every lawn in a range pays the same and the price jumps from one range to the next.",
  tiered: "A minimum for small lawns, then a rate per 1,000 sq ft that changes at the sizes you set. Each rate is charged only on the square feet inside its own tier, so a bigger lawn never costs less.",
};

function ServiceForm({ service, copyFrom, onDone }: { service: ServiceType | null; copyFrom?: ServiceType | null; onDone: () => void }) {
  const { me } = useAuth();
  const chemAccess = !!me?.access?.chemicalTracking;
  // A copy starts from everything the other service has, under a new name.
  const from = service ?? copyFrom ?? null;
  const [name, setName] = useState(service?.name ?? (copyFrom ? `${copyFrom.name} (copy)` : ""));
  const [description, setDescription] = useState(from?.description ?? "");
  const [invoiceDescription, setInvoiceDescription] = useState(from?.invoiceDescription ?? "");
  const [pricing, setPricing] = useState<PricingKind>((from?.pricing as PricingKind) ?? "flat");
  const [price, setPrice] = useState(from ? dollars(from.priceCents) : "");
  const [minimum, setMinimum] = useState(from?.minimumCents ? dollars(from.minimumCents) : "");
  const [brackets, setBrackets] = useState<{ upTo: string; price: string }[]>(
    from?.brackets.length ? from.brackets.map((b) => ({ upTo: b.upToSqFt == null ? "" : String(b.upToSqFt), price: dollars(b.priceCents) })) : [{ upTo: "5000", price: "" }, { upTo: "", price: "" }],
  );
  const [incomeAccountCode, setIncome] = useState(from?.incomeAccountCode ?? "4000");
  const [active, setActive] = useState(service?.active ?? true);
  const [taxable, setTaxable] = useState(from?.taxable ?? false);
  const [chemical, setChemical] = useState(from?.chemical ?? false);
  const [lawnArea, setLawnArea] = useState(from?.defaultLawnArea ?? "whole");
  const [tiers, setTiers] = useState<{ from: string; rate: string }[]>(
    from?.tiers?.length ? from.tiers.map((t) => ({ from: String(t.fromSqFt), rate: dollars(t.ratePer1000Cents) })) : [{ from: "3000", rate: "" }, { from: "6000", rate: "" }, { from: "10000", rate: "" }],
  );
  // A new service prices each lawn at its exact size, so the chart matches a sum done by hand. Steps are a choice.
  const [bandSize, setBandSize] = useState(from?.bandSizeSqFt != null ? String(from.bandSizeSqFt) : "");
  const [pricePoint, setPricePoint] = useState(String(from?.bandPricePoint ?? 0.5));
  const [roundTo, setRoundTo] = useState(String(from?.roundToCents ?? 50));
  const [maxAuto, setMaxAuto] = useState(from?.maxAutoSqFt != null ? String(from.maxAutoSqFt) : "");
  const [target, setTarget] = useState(from?.targetCentsPerHour != null ? dollars(from.targetCentsPerHour) : "");
  const [setupMin, setSetupMin] = useState(from?.setupMinutes != null ? String(from.setupMinutes) : "");
  const [per1000, setPer1000] = useState(from?.minutesPer1000 != null ? String(from.minutesPer1000) : "");
  const { busy, error, run, setError } = useAction();

  // The products and mixes it applies (Chemical Tracking's, for the people who can open it).
  const source = useChemicalCatalog(chemAccess);
  const chemList = useApi<ChemicalService[]>(chemAccess ? "/chemical-tracking/services" : null);
  const [chem, setChem] = useState<ServiceChemicals | null>(null);
  // An edited service's products are only written back when they were changed here.
  const [chemTouched, setChemTouched] = useState(false);
  useEffect(() => {
    if (chem || !chemList.data) return;
    const mine = from ? chemList.data.find((x) => x.id === from.id) : undefined;
    setChem(mine ? chemicalsOf(mine) : emptyChemicals(chemical));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chemList.data]);
  const hasChemicals = !!chem && (chem.links.some((l) => l.productId) || chem.mixes.some((m) => m.mixId));
  const changeChem = (v: ServiceChemicals) => { setChem(v); setChemTouched(true); };
  /** Ticking it starts the site at "Turf", as Chemical Tracking does. */
  const tickChemical = (on: boolean) => {
    setChemical(on);
    if (on && chem && !chem.site.trim()) changeChem({ ...chem, site: "Turf" });
  };
  // A new service that saved but whose products didn't: the next Save updates it instead of adding it twice.
  const createdId = useRef<string | null>(null);

  // Material comes from Chemical Tracking (the service's products and today's costs).
  const materialPer1000 = from?.materialPer1000Cents ?? null;
  const num = (v: string) => Number(v.replace(/[,\s]/g, ""));
  /** The volume-discount fields as the API takes them, from what's typed so far. */
  const tieredDraft = () => {
    const list = tiers.filter((t) => t.from.trim() && t.rate.trim());
    return {
      minimumCents: minimum.trim() ? toCents(minimum) : null,
      tiers: list.map((t) => ({ fromSqFt: num(t.from), ratePer1000Cents: toCents(t.rate) })),
      bandSizeSqFt: bandSize.trim() ? num(bandSize) : null,
      bandPricePoint: Number(pricePoint),
      roundToCents: Number(roundTo),
      maxAutoSqFt: maxAuto.trim() ? num(maxAuto) : null,
    };
  };
  const timing = { setupMinutes: setupMin.trim() === "" ? null : Number(setupMin), minutesPer1000: per1000.trim() === "" ? null : Number(per1000), targetCents: target.trim() ? toCents(target) : null, materialPer1000Cents: materialPer1000 };
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const body: Record<string, unknown> = {
        name, description: description.trim() || null, invoiceDescription: invoiceDescription.trim() || null, pricing, incomeAccountCode, active, taxable, chemical, defaultLawnArea: lawnArea, priceCents: 0, minimumCents: 0, brackets: [],
        setupMinutes: setupMin.trim() === "" ? null : Number(setupMin), minutesPer1000: per1000.trim() === "" ? null : Number(per1000),
        targetCentsPerHour: target.trim() ? toCents(target) : null,
      };
      if (pricing === "tiered") {
        const t = tieredDraft();
        if (t.minimumCents == null) return setError("Enter the minimum charge");
        Object.assign(body, t);
      } else if (pricing !== "bracket") {
        const p = toCents(price);
        if (!Number.isFinite(p) || p < 0) return setError("Enter the price");
        body.priceCents = p;
        if (pricing === "per_thousand") body.minimumCents = minimum ? toCents(minimum) : 0;
      } else {
        const list = brackets.filter((b) => b.price.trim());
        body.brackets = list.map((b, i) => ({ upToSqFt: i === list.length - 1 && !b.upTo.trim() ? null : Number(b.upTo.replace(/,/g, "")), priceCents: toCents(b.price) }));
      }
      run(async () => {
        const id = service?.id ?? createdId.current;
        const saved = await api<{ id: string }>(id ? `/service-types/${id}` : "/service-types", { method: id ? "PUT" : "POST", body });
        if (!service) createdId.current = saved.id;
        // Its products and mixes: a new or copied service takes what's here; an edited one only what was changed here.
        if (chemAccess && chem && (service ? chemical && chemTouched : chemical || hasChemicals)) await saveServiceChemicals(saved.id, chem);
        onDone();
      });
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>{service ? "Edit service" : copyFrom ? `New service, copied from ${copyFrom.name}` : "New service"}</h2>
      {copyFrom && <p className="muted" style={{ margin: 0 }}>Everything is copied: the pricing, the time estimate{chemAccess ? ", the invoice description and its products and mixes" : " and the invoice description"}. Change what differs, give it its own name, and save. {copyFrom.name} stays as it is.</p>}
      <div className="formgrid">
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Fertilizer & weed control round" /></label>
        <label>Income account
          <select value={incomeAccountCode} onChange={(e) => setIncome(e.target.value)}>{INCOME_ACCOUNTS.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select>
        </label>
      </div>
      <label>Invoice description <span className="muted">(what customers read on the invoice and estimate line; the name is used when this is empty)</span>
        <textarea rows={2} maxLength={500} value={invoiceDescription} onChange={(e) => setInvoiceDescription(e.target.value)} placeholder="Granular fertilizer with pre-emergent and broadleaf weed control" />
      </label>
      <div className="formgrid">
        <label>Priced
          <select value={pricing} onChange={(e) => setPricing(e.target.value as PricingKind)}>{PRICING_KINDS.map((k) => <option key={k} value={k}>{PRICING_LABELS[k]}</option>)}</select>
        </label>
        {pricing === "flat" && <label>Price ($)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>}
        {pricing === "tiered" && <label>Minimum charge ($)<input inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} required /></label>}
        {pricing === "per_thousand" && <>
          <label>Per 1,000 sq ft ($)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>
          <label>Minimum charge ($)<input inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} placeholder="optional" /></label>
        </>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}><strong>{PRICING_LABELS[pricing]}:</strong> {PRICING_HELP[pricing]}</p>
      {pricing === "per_thousand" && (
        <RateChart service={{ pricing: "per_thousand", priceCents: Number.isFinite(toCents(price)) ? toCents(price) : 0, minimumCents: minimum.trim() ? toCents(minimum) : 0, brackets: [] }} {...timing} />
      )}
      {pricing === "bracket" && (
        <fieldset className="contacts">
          <legend>Price by lawn size <span className="muted">(leave the last size empty for "anything bigger")</span></legend>
          {brackets.map((b, i) => (
            <div key={i} className="row">
              <label style={{ width: 170 }}>Up to (sq ft)<input inputMode="numeric" value={b.upTo} onChange={(e) => setBrackets(brackets.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))} placeholder={i === brackets.length - 1 ? "anything bigger" : ""} /></label>
              <label style={{ width: 130 }}>Price ($)<input inputMode="decimal" value={b.price} onChange={(e) => setBrackets(brackets.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></label>
              {brackets.length > 1 && <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setBrackets(brackets.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          ))}
          <div><button type="button" className="btn" onClick={() => setBrackets([...brackets, { upTo: "", price: "" }])}>Add a size</button></div>
        </fieldset>
      )}
      {pricing === "tiered" && (() => {
        const draft = tieredDraft();
        return (
          <fieldset className="contacts">
            <legend>Volume discount <span className="muted">(each rate applies only to the sq ft inside its tier, so a bigger lawn never costs less)</span></legend>
            {tiers.map((t, i) => (
              <div key={i} className="row">
                <label style={{ width: 210 }}>{i === 0 ? "Minimum covers up to (sq ft)" : "Next tier from (sq ft)"}<input inputMode="numeric" value={t.from} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} /></label>
                <label style={{ width: 170 }}>{i === 0 ? "Then per 1,000 sq ft ($)" : "Per 1,000 sq ft ($)"}<input inputMode="decimal" value={t.rate} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} /></label>
                {tiers.length > 1 && <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove</button>}
              </div>
            ))}
            <div><button type="button" className="btn" onClick={() => setTiers([...tiers, { from: "", rate: "" }])}>Add a tier</button></div>
            {draft.tiers.some((t, i) => i > 0 && t.ratePer1000Cents > draft.tiers[i - 1].ratePer1000Cents) && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {draft.tiers.map((t, i) => (i > 0 && t.ratePer1000Cents > draft.tiers[i - 1].ratePer1000Cents ? `From ${t.fromSqFt.toLocaleString("en-US")} sq ft the rate goes up (${formatMoney(draft.tiers[i - 1].ratePer1000Cents)} to ${formatMoney(t.ratePer1000Cents)}). ` : "")).join("")}
                That&apos;s allowed: a bigger lawn still never costs less. Check it&apos;s what you meant.
              </p>
            )}
            <div className="formgrid">
              <label>Price in steps of (sq ft)<input inputMode="numeric" value={bandSize} onChange={(e) => setBandSize(e.target.value)} placeholder="empty = each lawn's exact size" /></label>
              {bandSize.trim() && <label>Price each step at
                <select value={pricePoint} onChange={(e) => setPricePoint(e.target.value)}><option value="0">Its smallest size</option><option value="0.5">Its middle (fairest)</option><option value="1">Its largest size</option></select>
              </label>}
              <label>Round prices to
                <select value={roundTo} onChange={(e) => setRoundTo(e.target.value)}><option value="1">the cent</option><option value="25">$0.25</option><option value="50">$0.50</option><option value="100">$1.00</option></select>
              </label>
              <label>Price by hand above (sq ft)<input inputMode="numeric" value={maxAuto} onChange={(e) => setMaxAuto(e.target.value)} placeholder="optional" /></label>
            </div>
            <RateChart service={{ pricing: "tiered", priceCents: 0, brackets: [], ...draft, minimumCents: draft.minimumCents ?? 0 }} {...timing} />
          </fieldset>
        );
      })()}
      <label style={{ maxWidth: 520 }}>Lawn area it covers <span className="muted">(where its square feet come from for the price, the time and the product amounts; any line can be switched to another part, or to a typed size, for one customer)</span>
        <select value={lawnArea} onChange={(e) => setLawnArea(e.target.value)}>{SERVICE_LAWN_AREAS.map((k) => <option key={k} value={k}>{LAWN_AREA_LABELS[k]}</option>)}</select>
      </label>
      <label className="check"><input type="checkbox" checked={chemical} onChange={(e) => tickChemical(e.target.checked)} /> Chemical application <span className="muted">(this service keeps chemical application records; see {chemAccess ? <Link href="/chemical-tracking">Chemical Tracking</Link> : "Chemical Tracking"})</span></label>
      {chemical && chemAccess ? (
        <fieldset className="contacts">
          <legend>Products applied <span className="muted">(the chemicals this service puts down; sets its material cost and what the tech sees prefilled)</span></legend>
          {chem ? <ServiceChemicalsEditor value={chem} onChange={changeChem} source={source} /> : <span className="muted">{chemList.error ?? "Loading…"}</span>}
        </fieldset>
      ) : <MaterialSummary service={from} note={chemical && !chemAccess ? "Its products are set in Chemical Tracking by the people allowed in there." : undefined} />}
      <fieldset className="contacts">
        <legend>Time estimate <span className="muted">(for the waiting list until a property has its own history)</span></legend>
        <div className="formgrid">
          <label>Setup minutes<input inputMode="numeric" value={setupMin} onChange={(e) => setSetupMin(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="e.g. 5" /></label>
          <label>Minutes per 1,000 sq ft<input inputMode="decimal" value={per1000} onChange={(e) => setPer1000(e.target.value)} placeholder="e.g. 3" /></label>
        </div>
        <div className="formgrid">
          <label>Target $ per man-hour<input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="optional, e.g. 180" /></label>
        </div>
        {(setupMin || per1000) && <p className="muted" style={{ margin: 0 }}>A 10,000 sq ft lawn ≈ {Math.round((Number(setupMin) || 0) + (Number(per1000) || 0) * 10)} min.</p>}
      </fieldset>
      <label>Notes for your team <span className="muted">(optional; shown under the name on this list, never to customers)</span><input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} /> This is taxable <span className="muted">(gets the sales tax rate on work orders and invoices once sales tax is on)</span></label>
      {service && <label className="check"><input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} /> Retired (kept on past invoices, not offered for new ones)</label>}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** The most rows the chart draws; a finer rate card is shown at a coarser step and says so. */
const CHART_ROWS_MAX = 240;
/** About an acre: where the chart stops when the service has no "price by hand above". */
const CHART_TOP = 44000;
type ChartRow = { label: string; sqFt: number; from?: number; to?: number };

/** Every size the rate card prices, in order: one row per step (or per 500 sq ft at exact size, per 1,000 for a single rate). */
function chartRows(s: PricedService): { rows: ChartRow[]; step: number; coarser: boolean; top: number } {
  const n = (v: number) => v.toLocaleString("en-US");
  if (s.pricing === "per_thousand") {
    const rows: ChartRow[] = [];
    for (let size = 1000; size <= CHART_TOP; size += 1000) rows.push({ label: n(size), sqFt: size });
    return { rows, step: 1000, coarser: false, top: CHART_TOP };
  }
  const tiers = s.tiers ?? [];
  if (!tiers.length) return { rows: [], step: 0, coarser: false, top: 0 };
  const covers = tiers[0].fromSqFt;
  const top = s.maxAutoSqFt ?? Math.max(tiers[tiers.length - 1].fromSqFt + 10000, CHART_TOP);
  const own = s.bandSizeSqFt ?? null;
  let step = own ?? 500;
  const coarser = (top - covers) / step > CHART_ROWS_MAX;
  if (coarser) step *= Math.ceil((top - covers) / step / CHART_ROWS_MAX);
  const rows: ChartRow[] = [{ label: `Up to ${n(covers)}`, sqFt: covers }];
  for (let from = covers; from < top; from += step) {
    const to = Math.min(from + step, top);
    // In steps, every lawn in the row pays the same; at exact size the row is the lawn of that size.
    rows.push(own && !coarser ? { label: `${n(from + 1)} to ${n(to)}`, sqFt: to, from: from + 1, to } : { label: n(to), sqFt: to });
  }
  return { rows, step, coarser, top };
}

/**
 * The rate chart: what the service charges at every size it prices, with how each price is worked
 * out. It folds away to save room (and remembers that); the heading still says what it covers.
 */
function RateChart({ service, setupMinutes, minutesPer1000, targetCents, materialPer1000Cents }: { service: PricedService; setupMinutes: number | null; minutesPer1000: number | null; targetCents: number | null; materialPer1000Cents: number | null }) {
  const [open, setOpen] = useState<boolean>(() => readLocal("price-chart-open", true));
  const { rows, step: shownStep, coarser, top } = chartRows(service);
  if (!rows.length || (service.pricing === "per_thousand" && !service.priceCents)) return null;
  const timed = setupMinutes != null || minutesPer1000 != null;
  const tiered = service.pricing === "tiered";
  const step = tiered ? service.bandSizeSqFt ?? null : null;
  // A step's middle can fall on a half foot (3,750.5): shown as 3,750.
  const n = (v: number) => Math.floor(v + 1e-9).toLocaleString("en-US");
  const first = priceFor(service, rows[0].sqFt), last = priceFor(service, rows[rows.length - 1].sqFt);
  const covers = tiered ? service.tiers![0].fromSqFt : 0;
  // One lawn worked through, so the chart's numbers can be checked by hand.
  const sampleSize = tiered ? covers + (service.tiers![1] ? service.tiers![1].fromSqFt - covers : 2000) + 2000 : 0;
  const sample = tiered ? tieredBreakdown(service, sampleSize) : null;
  const where = service.bandPricePoint === 0 ? "its smallest size" : service.bandPricePoint === 1 ? "its largest size" : "its middle";
  const minimumUpTo = !tiered && service.minimumCents && service.priceCents ? Math.floor((service.minimumCents * 1000) / service.priceCents) : 0;
  return (
    <details className="rate-chart" open={open} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== open) { setOpen(o); writeLocal("price-chart-open", o); } }}>
      <summary>
        <strong>Rate chart</strong>
        <span className="muted"> {rows.length} sizes up to {n(top)} sq ft{first != null && last != null ? `, ${formatMoney(first)} to ${formatMoney(last)}` : ""} · {open ? "click to fold away" : "click to show"}</span>
      </summary>
      <div className="muted" style={{ fontSize: 13, margin: "6px 0 8px" }}>
        {tiered ? (
          <>
            <p style={{ margin: "0 0 4px" }}>
              <strong>How a price is worked out:</strong> lawns up to {n(covers)} sq ft pay the minimum. A bigger lawn pays the minimum, plus each tier&apos;s rate for only the square feet that fall inside that tier (a tier runs from its own size up to the next tier&apos;s).
              {sample && sample.parts.length > 0 && <> For example, a lawn of {n(sampleSize)} sq ft{Math.floor(sample.pricedAtSqFt) !== sampleSize ? ` (priced as ${n(sample.pricedAtSqFt)} sq ft, see below)` : ""}: {formatMoney(sample.minimumCents)} minimum{sample.parts.map((p, i) => <span key={i}> + {n(p.sqFt)} sq ft at {formatMoney(p.ratePer1000Cents)} per 1,000 ({formatMoney(Math.round(p.cents))})</span>)} = {formatMoney(Math.round(sample.exactCents))}{sample.priceCents !== Math.round(sample.exactCents) ? `, rounded to ${formatMoney(sample.priceCents)}` : ""}.</>}
            </p>
            {step ? (
              <p style={{ margin: 0 }}>
                <strong>Steps of {n(step)} sq ft, each priced at {where}:</strong> every lawn in a step pays the same. {service.bandPricePoint === 1 ? "" : <>So a lawn at the top of a step pays a little less than its exact size would: the <strong>Priced as</strong> column shows the size each price was worked out at. </>}
                To price every lawn at its exact size, leave <strong>Price in steps of</strong> empty.
              </p>
            ) : <p style={{ margin: 0 }}>Each lawn is priced at its exact size; the chart shows every {n(shownStep)} sq ft.</p>}
            {coarser && <p style={{ margin: "4px 0 0" }}>The chart shows every {n(shownStep)} sq ft to stay readable; sizes in between are priced the same way.</p>}
            {service.maxAutoSqFt != null && <p style={{ margin: "4px 0 0" }}>Lawns over {n(service.maxAutoSqFt)} sq ft are priced by hand.</p>}
          </>
        ) : (
          <p style={{ margin: 0 }}>
            <strong>How a price is worked out:</strong> the lawn&apos;s size times {formatMoney(service.priceCents)} per 1,000 sq ft{service.minimumCents ? <>, never less than the {formatMoney(service.minimumCents)} minimum (lawns up to {n(minimumUpTo)} sq ft pay the minimum)</> : ""}. For example, 8,000 sq ft: 8 × {formatMoney(service.priceCents)} = {formatMoney(Math.max(service.priceCents * 8, service.minimumCents))}. The chart shows every 1,000 sq ft; sizes in between are priced the same way.
          </p>
        )}
      </div>
      <div className="tablewrap rate-chart-table">
        <table>
          <thead><tr><th>Lawn (sq ft)</th>{step ? <th>Priced as</th> : null}<th>Price</th><th title="The price divided by the lawn's size. With a minimum it is higher than the rate, because the minimum is spread across the lawn.">Average per 1,000</th>{materialPer1000Cents != null && <th>Material</th>}{materialPer1000Cents != null && <th>After material</th>}{timed && <th>Minutes</th>}{timed && <th>Per man-hour</th>}</tr></thead>
          <tbody>{rows.map((row) => {
            const sqFt = row.sqFt;
            const price = priceFor(service, sqFt);
            const min = timed ? sizeMinutes({ setupMinutes, minutesPer1000 }, sqFt) : null;
            const perHour = price != null && min ? Math.round((price * 60) / min) : null;
            const low = perHour != null && targetCents != null && perHour < targetCents;
            const b = step && price != null ? tieredBreakdown(service, sqFt) : null;
            return (
              <tr key={row.label}>
                <td>{row.label}</td>
                {step ? <td className="muted">{b ? n(b.pricedAtSqFt) : ""}</td> : null}
                <td>{price == null ? <span className="muted">priced by hand</span> : formatMoney(price)}</td>
                <td>{price == null ? "" : formatMoney(Math.round((price * 1000) / sqFt))}</td>
                {materialPer1000Cents != null && <td>{formatMoney(Math.round((materialPer1000Cents * sqFt) / 1000))}</td>}
                {materialPer1000Cents != null && <td>{price == null ? "" : `${formatMoney(price - Math.round((materialPer1000Cents * sqFt) / 1000))} (${Math.round(((price - (materialPer1000Cents * sqFt) / 1000) / price) * 100)}%)`}</td>}
                {timed && <td>{min ?? ""}</td>}
                {timed && <td>{perHour == null ? "" : low ? <span className="badge warn">{formatMoney(perHour)} below target</span> : formatMoney(perHour)}</td>}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </details>
  );
}

/** The service's products and material cost, kept in Chemical Tracking (restricted); shown here read-only. */
function MaterialSummary({ service, note }: { service: ServiceType | null; note?: string }) {
  const { me } = useAuth();
  const lines = (service?.products ?? []).filter((l) => l.applies);
  const link = me?.access?.chemicalTracking ? <> Change them in <Link href="/chemical-tracking/services">Chemical Tracking → Services</Link>.</> : " Set in Chemical Tracking.";
  return (
    <fieldset className="contacts">
      <legend>Products applied <span className="muted">(budgets material cost)</span></legend>
      {lines.length ? (
        <>
          {lines.map((l) => <div key={l.id}>{l.productName} <span className="muted">{l.rateName}: {formatRateAmount(l.amountPer1000, l.unit)} / 1,000 sq ft</span></div>)}
          {service?.materialPer1000Cents != null && <div><strong>Material today: {formatMoney(Math.round(service.materialPer1000Cents))} per 1,000 sq ft</strong>{service.materialMissingCost ? <span className="muted"> ({service.materialMissingCost} without a cost yet)</span> : null}</div>}
        </>
      ) : <span className="muted">No products on this service.</span>}
      <p className="muted" style={{ margin: 0 }}>{note ?? link}</p>
    </fieldset>
  );
}

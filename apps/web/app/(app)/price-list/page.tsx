"use client";
import { useState } from "react";
import { INCOME_ACCOUNTS, PRICING_KINDS, PRICING_LABELS, describePricing, formatMoney, priceFor, sizeMinutes, type PricedService, type PricingKind } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useNewForm } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { dollars, toCents, useServices, type ServiceType } from "@/components/invoices";
import { PackagesCard } from "@/components/packages";

/** The services price list. Everyone in Customers & billing sees it; admins change it. */
export default function PriceList() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const services = useServices(true);
  const [editing, setEditing] = useState<ServiceType | "new" | null>(null);
  useNewForm(() => { if (admin) setEditing("new"); });
  const action = useAction();
  const list = services.list;
  const move = (i: number, d: number) => {
    const ids = list.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    action.run(async () => { await api("/service-types/order", { method: "PUT", body: { ids } }); services.reload(); });
  };
  const account = (code: string) => INCOME_ACCOUNTS.find((a) => a.code === code);
  return (
    <>
      <PageHead title="Items & services"
        sub="Your price list: the services you sell and how each is priced. Invoices, work orders and estimates fill in the price from the property's lawn size.">
        {admin && <button className="btn primary" onClick={() => setEditing("new")}>Add service</button>}
      </PageHead>
      {editing && <ServiceForm service={editing === "new" ? null : editing} onDone={() => { setEditing(null); services.reload(); }} />}
      <ErrorBox error={action.error} />
      <div className="card tablewrap">
        {list.length ? (
          <table>
            <thead><tr><th>Service</th><th>Price</th><th>Income account</th><th>Taxable</th><th>Status</th>{admin && <th />}</tr></thead>
            <tbody>{list.map((s, i) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                <td><strong>{s.name}</strong>{s.chemical && <span className="badge" style={{ marginLeft: 6 }} title="Weather is recorded when it's completed">chemical</span>}{s.description && <div className="muted">{s.description}</div>}</td>
                <td>{describePricing(s)}</td>
                <td>{s.incomeAccountCode} {account(s.incomeAccountCode)?.name ?? ""}</td>
                <td>{s.taxable ? "Yes" : <span className="muted">No</span>}</td>
                <td>{s.active ? <span className="badge ok">active</span> : <span className="badge">retired</span>}</td>
                {admin && (
                  <td className="row">
                    <button className="btn" aria-label={`Move ${s.name} up`} disabled={i === 0 || action.busy} onClick={() => move(i, -1)}>↑</button>
                    <button className="btn" aria-label={`Move ${s.name} down`} disabled={i === list.length - 1 || action.busy} onClick={() => move(i, 1)}>↓</button>
                    <button className="btn" onClick={() => setEditing(s)}>Edit</button>
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

function ServiceForm({ service, onDone }: { service: ServiceType | null; onDone: () => void }) {
  const [name, setName] = useState(service?.name ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [pricing, setPricing] = useState<PricingKind>((service?.pricing as PricingKind) ?? "flat");
  const [price, setPrice] = useState(service ? dollars(service.priceCents) : "");
  const [minimum, setMinimum] = useState(service?.minimumCents ? dollars(service.minimumCents) : "");
  const [brackets, setBrackets] = useState<{ upTo: string; price: string }[]>(
    service?.brackets.length ? service.brackets.map((b) => ({ upTo: b.upToSqFt == null ? "" : String(b.upToSqFt), price: dollars(b.priceCents) })) : [{ upTo: "5000", price: "" }, { upTo: "", price: "" }],
  );
  const [incomeAccountCode, setIncome] = useState(service?.incomeAccountCode ?? "4000");
  const [active, setActive] = useState(service?.active ?? true);
  const [taxable, setTaxable] = useState(service?.taxable ?? false);
  const [chemical, setChemical] = useState(service?.chemical ?? false);
  const [tiers, setTiers] = useState<{ from: string; rate: string }[]>(
    service?.tiers?.length ? service.tiers.map((t) => ({ from: String(t.fromSqFt), rate: dollars(t.ratePer1000Cents) })) : [{ from: "3000", rate: "" }, { from: "6000", rate: "" }, { from: "10000", rate: "" }],
  );
  const [bandSize, setBandSize] = useState(service?.bandSizeSqFt != null ? String(service.bandSizeSqFt) : service?.pricing === "tiered" ? "" : "500");
  const [pricePoint, setPricePoint] = useState(String(service?.bandPricePoint ?? 0.5));
  const [roundTo, setRoundTo] = useState(String(service?.roundToCents ?? 50));
  const [maxAuto, setMaxAuto] = useState(service?.maxAutoSqFt != null ? String(service.maxAutoSqFt) : "");
  const [target, setTarget] = useState(service?.targetCentsPerHour != null ? dollars(service.targetCentsPerHour) : "");
  const [setupMin, setSetupMin] = useState(service?.setupMinutes != null ? String(service.setupMinutes) : "");
  const [per1000, setPer1000] = useState(service?.minutesPer1000 != null ? String(service.minutesPer1000) : "");
  const { busy, error, run, setError } = useAction();
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
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const body: Record<string, unknown> = {
        name, description: description || undefined, pricing, incomeAccountCode, active, taxable, chemical, priceCents: 0, minimumCents: 0, brackets: [],
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
      run(async () => { await api(service ? `/service-types/${service.id}` : "/service-types", { method: service ? "PUT" : "POST", body }); onDone(); });
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>{service ? "Edit service" : "New service"}</h2>
      <div className="formgrid">
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Fertilizer & weed control round" /></label>
        <label>Income account
          <select value={incomeAccountCode} onChange={(e) => setIncome(e.target.value)}>{INCOME_ACCOUNTS.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select>
        </label>
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
            <div className="formgrid">
              <label>Price in steps of (sq ft)<input inputMode="numeric" value={bandSize} onChange={(e) => setBandSize(e.target.value)} placeholder="blank = exact price" /></label>
              {bandSize.trim() && <label>Price each step at
                <select value={pricePoint} onChange={(e) => setPricePoint(e.target.value)}><option value="0">Its smallest size</option><option value="0.5">Its middle (fairest)</option><option value="1">Its largest size</option></select>
              </label>}
              <label>Round prices to
                <select value={roundTo} onChange={(e) => setRoundTo(e.target.value)}><option value="1">the cent</option><option value="25">$0.25</option><option value="50">$0.50</option><option value="100">$1.00</option></select>
              </label>
              <label>Price by hand above (sq ft)<input inputMode="numeric" value={maxAuto} onChange={(e) => setMaxAuto(e.target.value)} placeholder="optional" /></label>
            </div>
            <RatePreview service={{ pricing: "tiered", priceCents: 0, brackets: [], ...draft, minimumCents: draft.minimumCents ?? 0 }}
              setupMinutes={setupMin.trim() === "" ? null : Number(setupMin)} minutesPer1000={per1000.trim() === "" ? null : Number(per1000)}
              targetCents={target.trim() ? toCents(target) : null} />
          </fieldset>
        );
      })()}
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
      <label>Description (optional)<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={chemical} onChange={(e) => setChemical(e.target.checked)} /> Chemical application <span className="muted">(record the weather when it&apos;s completed; see Field → Weather)</span></label>
      <label className="check"><input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} /> This is taxable <span className="muted">(gets the sales tax rate on work orders and invoices once sales tax is on)</span></label>
      {service && <label className="check"><input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} /> Retired (kept on past invoices, not offered for new ones)</label>}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

const PREVIEW_SIZES = [2000, 3000, 4000, 5000, 6000, 7500, 10000, 12500, 15000, 20000, 25000];

/** What the rate card charges at a range of lawn sizes, and how each compares with the hourly target. */
function RatePreview({ service, setupMinutes, minutesPer1000, targetCents }: { service: PricedService; setupMinutes: number | null; minutesPer1000: number | null; targetCents: number | null }) {
  if (!service.tiers?.length) return null;
  const timed = setupMinutes != null || minutesPer1000 != null;
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>Lawn (sq ft)</th><th>Price</th><th>Per 1,000</th>{timed && <th>Minutes</th>}{timed && <th>Per man-hour</th>}</tr></thead>
        <tbody>{PREVIEW_SIZES.map((sqFt) => {
          const price = priceFor(service, sqFt);
          const min = timed ? sizeMinutes({ setupMinutes, minutesPer1000 }, sqFt) : null;
          const perHour = price != null && min ? Math.round((price * 60) / min) : null;
          const low = perHour != null && targetCents != null && perHour < targetCents;
          return (
            <tr key={sqFt}>
              <td>{sqFt.toLocaleString("en-US")}</td>
              <td>{price == null ? <span className="muted">priced by hand</span> : formatMoney(price)}</td>
              <td>{price == null ? "" : formatMoney(Math.round((price * 1000) / sqFt))}</td>
              {timed && <td>{min ?? ""}</td>}
              {timed && <td>{perHour == null ? "" : low ? <span className="badge warn">{formatMoney(perHour)} below target</span> : formatMoney(perHour)}</td>}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

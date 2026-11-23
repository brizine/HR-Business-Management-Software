"use client";
import Link from "next/link";
import { useState } from "react";
import { INCOME_ACCOUNTS, PRICING_KINDS, PRICING_LABELS, describePricing, type PricingKind } from "@crewdesk/shared";
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
      <PageHead title="Price list" before={<Link className="btn" href="/invoices" aria-label="Back to invoices">←</Link>}
        sub="The services you sell and how each is priced. Invoices fill in the price from the property's lawn size.">
        {admin && <button className="btn primary" onClick={() => setEditing("new")}>Add service</button>}
      </PageHead>
      {editing && <ServiceForm service={editing === "new" ? null : editing} onDone={() => { setEditing(null); services.reload(); }} />}
      <ErrorBox error={action.error} />
      <div className="card tablewrap">
        {list.length ? (
          <table>
            <thead><tr><th>Service</th><th>Price</th><th>Income account</th><th>Status</th>{admin && <th />}</tr></thead>
            <tbody>{list.map((s, i) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                <td><strong>{s.name}</strong>{s.description && <div className="muted">{s.description}</div>}</td>
                <td>{describePricing(s)}</td>
                <td>{s.incomeAccountCode} {account(s.incomeAccountCode)?.name ?? ""}</td>
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
  const { busy, error, run, setError } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const body: Record<string, unknown> = { name, description: description || undefined, pricing, incomeAccountCode, active, priceCents: 0, minimumCents: 0, brackets: [] };
      if (pricing !== "bracket") {
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
      <label>Description (optional)<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      {service && <label className="check"><input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} /> Retired (kept on past invoices, not offered for new ones)</label>}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

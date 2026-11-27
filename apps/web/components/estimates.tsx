"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ESTIMATE_STATUS_LABELS, INCOME_ACCOUNTS, depositCents, describeDepositRule, describePricing, estimateLineAmount, estimateTotals, formatMoney, lineMaterialCents, lineTaxRate, priceFor, taxRateFor, type EstimateStatus as Status, lineTextFor, rewordForArea, withAreaNote,
} from "@crewdesk/shared";
import { api, fmtDate, today } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "@/components/ui";
import { CustomerPicker } from "@/components/customers";
import { dollars, toCents, useBillingSettings, type ServiceType } from "@/components/invoices";
import { LineAreaPicker, areaDraft, areaValue, draftSqFt, serviceArea, useSizes, usesLawnArea, wholeLawn, type AreaDraft } from "@/components/line-area";

/** Draft, Pending, Accepted, Declined, Changes requested (and Expired), colored. */
export function EstimateStatus({ status, expired }: { status: string; expired?: boolean }) {
  if (expired) return <span className="badge bad">Expired</span>;
  const tone = status === "accepted" ? "ok" : status === "declined" ? "bad" : status === "draft" ? "" : "warn";
  return <span className={`badge ${tone}`}>{ESTIMATE_STATUS_LABELS[status as Status] ?? status}</span>;
}

type Line = {
  id?: string; serviceTypeId: string | null; propertyId: string; description: string; quantity: string; price: string; visits: string; tax: string;
  incomeAccountCode: string; cost: string; hours: string; optional: boolean; selected: boolean; recommended: boolean; more: boolean;
  /** "Our cost" from the service's products (kept up to date while open) rather than typed in. */
  costAuto: boolean;
  /** The part of the lawn the line is for (its price and cost come from that size). */
  area: AreaDraft;
};
const blankLine = (): Line => ({ serviceTypeId: null, propertyId: "", description: "", quantity: "1", price: "", visits: "1", tax: "", incomeAccountCode: "4000", cost: "", hours: "", optional: false, selected: true, recommended: false, more: false, costAuto: false, area: wholeLawn() });
const taxText = (r: number | null | undefined) => (r ? String(Number(r.toFixed(3))) : "");
const fromLine = (l: any): Line => ({
  id: l.id, serviceTypeId: l.serviceTypeId, propertyId: l.propertyId ?? "", description: l.description, quantity: String(l.quantity), price: dollars(l.unitPriceCents), visits: String(l.visits ?? 1),
  tax: taxText(l.taxRate), incomeAccountCode: l.incomeAccountCode ?? "4000", cost: l.costCents != null ? dollars(l.costCents) : "", hours: l.budgetedHours != null ? String(l.budgetedHours) : "",
  area: areaDraft(l), costAuto: !!l.costAuto, optional: l.optional, selected: l.selected, recommended: l.recommended, more: l.costCents != null || l.budgetedHours != null || l.optional || l.recommended || !!l.propertyId,
});

/** New or changed estimate, laid out like Homeworks': details, lines (with visits, optional and recommended lines, cost and hours), totals with profit, terms and notes. */
/** The company's deposit rule in words, for the form's "Company default (…)". */
function companyDeposit(settings: any) {
  const d = settings?.estimateDeposit;
  if (!d || d.requireFor === "none") return "none";
  return `${describeDepositRule(d)}${d.requireFor === "new" ? ", new customers" : ""}`;
}
function companyRule(settings: any) {
  const d = settings?.estimateDeposit;
  return d && d.requireFor !== "none" && d.value > 0 ? { kind: d.kind, value: d.value, minTotalCents: d.minTotalCents } : null;
}

export function EstimateForm({ estimate, preset, onSaved, onCancel }: { estimate?: any; preset?: { customer?: { id: string; name: string }; internalNotes?: string }; onSaved: (e: any) => void; onCancel: () => void }) {
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(estimate ? { id: estimate.customer.id, name: estimate.customer.name } : preset?.customer ?? null);
  const [propertyId, setPropertyId] = useState<string>(estimate?.propertyId ?? "");
  const [title, setTitle] = useState(estimate?.title ?? "");
  const [issueDate, setIssueDate] = useState(estimate?.issueDate ?? today());
  const [validUntil, setValidUntil] = useState(estimate?.validUntil ?? "");
  const [poNumber, setPoNumber] = useState(estimate?.poNumber ?? "");
  const [discount, setDiscount] = useState(estimate?.discountPercent ? String(estimate.discountPercent) : "");
  const [requested, setRequested] = useState<string>(estimate?.requestedAt ? new Date(estimate.requestedAt).toISOString().slice(0, 16) : "");
  const [lines, setLines] = useState<Line[]>(estimate?.lines?.length ? estimate.lines.map(fromLine) : [blankLine()]);
  const [terms, setTerms] = useState(estimate?.terms ?? "");
  const [customerNotes, setCustomerNotes] = useState(estimate?.customerNotes ?? "");
  const [internalNotes, setInternalNotes] = useState(estimate?.internalNotes ?? preset?.internalNotes ?? "");
  const [depositMode, setDepositMode] = useState<string>(estimate?.depositMode ?? "default");
  const [depositKind, setDepositKind] = useState<"amount" | "percent">(estimate?.depositKind ?? "percent");
  const [depositValue, setDepositValue] = useState<string>(estimate?.depositValue != null ? (estimate.depositKind === "amount" ? (estimate.depositValue / 100).toFixed(2) : String(estimate.depositValue)) : "");
  const save = useAction();
  const services = useApi<ServiceType[]>("/service-types");
  const pkgs = useApi<{ id: string; name: string; active: boolean; lines: any[] }[]>("/packages");
  const detail = useApi<any>(customer ? `/customers/${customer.id}` : null);
  const properties: any[] = (detail.data?.properties ?? []).filter((p: any) => !p.endDate);
  const property = properties.find((p) => p.id === propertyId);
  useEffect(() => {
    if (!detail.data) return;
    if (!propertyId && properties.length === 1) setPropertyId(properties[0].id);
    // A new estimate starts with the customer's own discount.
    if (!estimate && !discount && detail.data.discountPercent > 0) setDiscount(String(detail.data.discountPercent));
  }, [detail.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const billing = useBillingSettings();
  const settings = billing.data ?? { taxEnabled: false, taxName: "Sales tax", defaultTaxRate: 0 };
  const rate = taxRateFor({ settings, customer: detail.data, property });
  const showTax = settings.taxEnabled || lines.some((l) => Number(l.tax) > 0);
  const lastRate = useRef<number | null>(null);
  useEffect(() => {
    if (!billing.data || !detail.data) return;
    if (lastRate.current !== null && lastRate.current !== rate) setLines((ls) => ls.map((l) => (services.data?.find((x) => x.id === l.serviceTypeId)?.taxable ? { ...l, tax: taxText(rate) } : l)));
    lastRate.current = rate;
  }, [rate, billing.data, detail.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // The property sizes a line can be priced from (the company's number fields on properties).
  const sizes = useSizes();
  const propFor = (l: Line) => properties.find((p) => p.id === (l.propertyId || propertyId)) ?? null;
  /** The square feet a line is for: its part of the lawn at its address. */
  const lawnFor = (l: Line, area: AreaDraft = l.area) => draftSqFt(area, propFor(l));
  const pickService = (i: number, id: string) => {
    if (!id) return setLine(i, { serviceTypeId: null });
    const s = services.data?.find((x) => x.id === id);
    if (!s) return;
    // The service's own part of the lawn (whole, front or back) to start with.
    const area = serviceArea(s);
    const price = priceFor(s, lawnFor(lines[i], area));
    // Our cost (each): the service's products for this lawn, at today's prices.
    const material = lineMaterialCents(s, lawnFor(lines[i], area));
    setLine(i, {
      serviceTypeId: s.id, area, description: lines[i].description || withAreaNote(lineTextFor(s, "estimate"), areaValue(area), sizes.names), price: price != null ? dollars(price) : lines[i].price, incomeAccountCode: s.incomeAccountCode, tax: taxText(lineTaxRate(s.taxable, rate)),
      cost: material != null ? dollars(material) : lines[i].cost, costAuto: material != null || (lines[i].costAuto && !lines[i].cost.trim()),
    });
  };
  /** A line for another part of the lawn: priced and costed from that size, and its wording says so (unless somebody reworded it). */
  const setArea = (i: number, area: AreaDraft) => {
    const l = lines[i];
    const s = services.data?.find((x) => x.id === l.serviceTypeId);
    if (!s) return setLine(i, { area });
    const price = priceFor(s, lawnFor(l, area));
    const material = lineMaterialCents(s, lawnFor(l, area));
    setLine(i, {
      area, description: rewordForArea(l.description, [lineTextFor(s, "estimate"), s.name], areaValue(l.area), areaValue(area), sizes.names),
      ...(s.pricing !== "flat" && price != null ? { price: dollars(price) } : {}),
      ...(l.costAuto || !l.cost.trim() ? { cost: material != null ? dollars(material) : "", costAuto: material != null } : {}),
    });
  };
  const addPackage = (id: string) => {
    const p = pkgs.data?.find((x) => x.id === id);
    if (!p) return;
    const added = p.lines.map((l: any) => {
      const s = services.data?.find((x) => x.id === l.serviceTypeId);
      // Each line is priced from the part of the lawn its service covers, and says so.
      const area = serviceArea(s);
      const price = l.unitPriceCents ?? (s ? priceFor(s, draftSqFt(area, property)) : null);
      const material = s ? lineMaterialCents(s, draftSqFt(area, property)) : null;
      return { ...blankLine(), area, serviceTypeId: l.serviceTypeId ?? null, description: withAreaNote(l.description ?? s?.name ?? "", areaValue(area), sizes.names), quantity: String(l.quantity ?? 1), price: price != null ? dollars(price) : "", incomeAccountCode: s?.incomeAccountCode ?? "4000", tax: taxText(lineTaxRate(s?.taxable, rate)), hours: l.budgetedHours != null ? String(l.budgetedHours) : "", cost: material != null ? dollars(material) : "", costAuto: material != null };
    });
    setLines((ls) => [...ls.filter((l) => l.description.trim() || l.price), ...added]);
  };
  const parsed = lines.map((l) => ({
    id: l.id, quantity: Number(l.quantity) || 0, unitPriceCents: toCents(l.price) || 0, visits: Math.max(1, Math.round(Number(l.visits) || 1)), taxRate: Number(l.tax) || 0,
    costCents: l.cost.trim() ? toCents(l.cost) : null, budgetedHours: l.hours.trim() ? Number(l.hours) : null, optional: l.optional, selected: l.selected,
  }));
  const totals = estimateTotals(parsed, Number(discount) || 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.run(async () => {
      if (!customer) throw new Error("Pick the customer");
      const out = [];
      for (const [i, l] of lines.entries()) {
        if (!l.description.trim() && !l.price) continue;
        const p = parsed[i];
        if (!l.description.trim()) throw new Error(`Line ${i + 1} needs a description`);
        if (!(p.quantity > 0)) throw new Error(`Line ${i + 1}: enter a quantity`);
        if (!Number.isFinite(toCents(l.price || "0"))) throw new Error(`Line ${i + 1}: check the price`);
        out.push({ ...p, quantity: Math.round(p.quantity * 100) / 100, serviceTypeId: l.serviceTypeId, propertyId: l.propertyId || null, description: l.description.trim(), incomeAccountCode: l.incomeAccountCode, recommended: l.recommended, costAuto: l.costAuto && !!l.serviceTypeId, ...areaValue(l.area) });
      }
      if (!out.length) throw new Error("Add at least one line");
      const body = {
        customerId: customer.id, propertyId: propertyId || null, title, issueDate, validUntil: validUntil || null, poNumber, discountPercent: Number(discount) || 0,
        requestedAt: requested ? new Date(requested).toISOString() : null, lines: out, terms, customerNotes, internalNotes,
        depositMode, depositKind: depositMode === "custom" ? depositKind : null,
        depositValue: depositMode === "custom" ? (depositKind === "amount" ? toCents(depositValue || "0") : Number(depositValue) || 0) : null,
      };
      onSaved(estimate ? await api(`/estimates/${estimate.id}`, { method: "PUT", body }) : await api("/estimates", { body }));
    });
  };

  return (
    <form className="card stack est-form" onSubmit={submit}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{estimate ? `Edit estimate ${estimate.number}` : "New estimate"}</h2>
      <label>Estimate title or description (optional)<input maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="2027 lawn care program" /></label>
      <div className="formgrid">
        {customer ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="todo-label">Customer *</span>
            <div className="row"><strong>{customer.name}</strong>{!estimate && <button type="button" className="linkbtn" onClick={() => { setCustomer(null); setPropertyId(""); }}>Change</button>}</div>
          </div>
        ) : <CustomerPicker label="Customer *" onPick={(c) => { setCustomer({ id: c.id, name: c.name }); setPropertyId(""); }} />}
        {customer && (
          <label>Service address
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">None (not for one property)</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.street}{p.name ? ` (${p.name})` : ""}{p.lawnSqFt ? ` · ${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : ""}</option>)}
            </select>
          </label>
        )}
        <label>Estimate date<input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
        <label>Good until<input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /><span className="muted" style={{ fontSize: 12 }}>Blank: no end date</span></label>
        <label>P.O. number<input maxLength={60} value={poNumber} onChange={(e) => setPoNumber(e.target.value)} /></label>
        <label>Discount %<input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" /></label>
        <label>When they asked for it<input type="datetime-local" value={requested} onChange={(e) => setRequested(e.target.value)} /></label>
      </div>

      <div className="est-lines">
        {lines.map((l, i) => {
          const s = services.data?.find((x) => x.id === l.serviceTypeId);
          return (
            <div key={i} className={`est-line${l.optional ? " optional" : ""}`}>
              <div className="est-line-main">
                <div className="stack" style={{ gap: 4 }}>
                  <select aria-label={`Line ${i + 1} service`} value={l.serviceTypeId ?? ""} onChange={(e) => pickService(i, e.target.value)}>
                    <option value="">Custom line</option>
                    {(services.data ?? []).filter((x) => x.active || x.id === l.serviceTypeId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" />
                  {usesLawnArea(s) && <LineAreaPicker label={`Line ${i + 1} lawn area`} value={l.area} onChange={(a) => setArea(i, a)} property={propFor(l)} sizes={sizes} />}
                  {s && <span className="muted" style={{ fontSize: 12 }}>{describePricing(s)}</span>}
                </div>
                <label>Qty<input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></label>
                <label>Rate<input aria-label={`Line ${i + 1} price`} inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></label>
                <label>Visits<input aria-label={`Line ${i + 1} visits`} inputMode="numeric" value={l.visits} onChange={(e) => setLine(i, { visits: e.target.value })} /></label>
                {showTax && <label>Tax %<input aria-label={`Line ${i + 1} tax rate`} inputMode="decimal" placeholder="0" value={l.tax} onChange={(e) => setLine(i, { tax: e.target.value })} /></label>}
                <div className="est-amount"><span className="todo-label">Total</span><strong>{formatMoney(estimateLineAmount(parsed[i]))}</strong></div>
                <div className="row" style={{ gap: 4, alignSelf: "end" }}>
                  <button type="button" className="btn" aria-expanded={l.more} title="Optional, recommended, cost, hours, address" onClick={() => setLine(i, { more: !l.more })}>{l.more ? "Less" : "More"}</button>
                  {lines.length > 1 && <button type="button" className="btn" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}
                </div>
              </div>
              {l.more && (
                <div className="est-line-more">
                  <label className="check"><input type="checkbox" checked={l.optional} onChange={(e) => setLine(i, { optional: e.target.checked })} /> Optional (the customer chooses)</label>
                  {l.optional && <label className="check"><input type="checkbox" checked={l.selected} onChange={(e) => setLine(i, { selected: e.target.checked })} /> Starts ticked</label>}
                  <label className="check"><input type="checkbox" checked={l.recommended} onChange={(e) => setLine(i, { recommended: e.target.checked })} /> Recommended</label>
                  {properties.length > 1 && (
                    <label>Address
                      <select value={l.propertyId} onChange={(e) => setLine(i, { propertyId: e.target.value })}>
                        <option value="">The estimate&apos;s</option>
                        {properties.map((p) => <option key={p.id} value={p.id}>{p.street}</option>)}
                      </select>
                    </label>
                  )}
                  <label>Our cost (each)<input inputMode="decimal" placeholder="0.00" value={l.cost} onChange={(e) => setLine(i, { cost: e.target.value, costAuto: false })} />
                    {l.costAuto && <span className="muted" style={{ fontSize: 12 }}>From the service&apos;s products; stays up to date while the estimate is open</span>}</label>
                  <label>Hours per visit<input inputMode="decimal" value={l.hours} onChange={(e) => setLine(i, { hours: e.target.value })} /></label>
                  {!s && (
                    <label>Income account
                      <select value={l.incomeAccountCode} onChange={(e) => setLine(i, { incomeAccountCode: e.target.value })}>
                        {INCOME_ACCOUNTS.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={() => setLines([...lines, blankLine()])}>Add line</button>
        {(pkgs.data ?? []).some((p) => p.active) && (
          <select aria-label="Add a package" value="" onChange={(e) => addPackage(e.target.value)} style={{ width: "auto" }}>
            <option value="">Add package…</option>
            {(pkgs.data ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      <div className="est-totals">
        <dl className="facts totals">
          <dt>Subtotal</dt><dd>{formatMoney(totals.subtotalCents)}</dd>
          {totals.discountCents > 0 && <><dt>Discount</dt><dd>-{formatMoney(totals.discountCents)}</dd></>}
          {(showTax || totals.taxCents > 0) && <><dt>{settings.taxName || "Sales tax"}</dt><dd>{formatMoney(totals.taxCents)}</dd></>}
          <dt><strong>Total</strong></dt><dd><strong>{formatMoney(totals.totalCents)}</strong></dd>
        </dl>
        <dl className="facts totals est-internal" aria-label="For the office only">
          <dt>Per visit</dt><dd>{formatMoney(totals.visitsRevenueCents)}</dd>
          <dt>Budgeted hours</dt><dd>{totals.hours}</dd>
          <dt>Our cost</dt><dd>{formatMoney(totals.costCents)}</dd>
          <dt><strong>Estimated profit</strong></dt><dd><strong>{formatMoney(totals.profitCents)}</strong>{totals.costCents > 0 ? ` (${totals.marginPercent}%)` : ""}</dd>
        </dl>
      </div>
      {totals.optionalCount > 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Totals include the optional lines that start ticked; the customer can change them when they accept.</p>}

      <div className="grid cols-2">
        <label>Terms<textarea rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Good for 30 days. Price includes all materials." /></label>
        <label>Notes for the customer<textarea rows={4} value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} /></label>
      </div>
      <div className="row est-deposit" style={{ alignItems: "flex-end" }}>
        <label>Deposit to accept
          <select value={depositMode} onChange={(e) => setDepositMode(e.target.value)} style={{ width: "auto" }}>
            <option value="default">Company default ({companyDeposit(billing.data)})</option>
            <option value="none">No deposit</option>
            <option value="custom">Its own deposit</option>
          </select>
        </label>
        {depositMode === "custom" && (
          <>
            <label>Type<select value={depositKind} onChange={(e) => setDepositKind(e.target.value as "amount" | "percent")} style={{ width: "auto" }}><option value="percent">% of the accepted total</option><option value="amount">$ amount</option></select></label>
            <label>{depositKind === "amount" ? "Amount ($)" : "Percent"}<input inputMode="decimal" value={depositValue} onChange={(e) => setDepositValue(e.target.value)} style={{ width: 110 }} aria-label="Deposit" /></label>
          </>
        )}
        {(() => {
          const rule = depositMode === "custom" ? (Number(depositValue) > 0 ? { kind: depositKind, value: depositKind === "amount" ? toCents(depositValue) : Number(depositValue), minTotalCents: 0 } : null)
            : depositMode === "none" ? null : companyRule(billing.data);
          const cents = depositCents(rule, totals.totalCents);
          return cents > 0 ? <span className="muted" style={{ paddingBottom: 8 }}>{formatMoney(cents)} at this total{depositMode === "default" && billing.data?.estimateDeposit?.requireFor === "new" ? " (if they're a new customer)" : ""}</span> : null;
        })()}
      </div>
      <label>Internal notes (only the office sees these)<textarea rows={3} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} /></label>
      <ErrorBox error={save.error} />
      <div className="row">
        <button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : "Save estimate"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** On a customer's page: their estimates. */
export function LinkedEstimates({ customerId }: { customerId: string }) {
  const list = useApi<{ rows: any[] }>(`/estimates?customerId=${customerId}&limit=20`);
  const rows = list.data?.rows ?? [];
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Estimates</h2>
        <Link className="btn" href={`/estimates/new?customerId=${customerId}`}>New estimate</Link>
      </div>
      {rows.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Title</th><th className="num">Total</th><th>Status</th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}>
                <td><Link href={`/estimates/${e.id}`}>{e.number}</Link></td>
                <td className="nowrap">{fmtDate(e.issueDate)}</td>
                <td>{e.title ?? <span className="muted">—</span>}</td>
                <td className="num">{formatMoney(e.totalCents)}</td>
                <td><EstimateStatus status={e.status} expired={e.expired} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No estimates yet.</Empty>}
    </div>
  );
}

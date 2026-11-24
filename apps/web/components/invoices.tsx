"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  INCOME_ACCOUNTS, INVOICE_STATUS_LABELS, describePricing, formatMoney, invoiceTotals, lineAmount, lineTaxRate, priceFor, taxRateFor, type EstimateDepositSettings, type InvoiceStatus,
} from "@crewdesk/shared";
import Link from "next/link";
import { api, fmtDate, today } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { CustomerPicker } from "@/components/customers";

export interface ServiceType { id: string; name: string; description: string | null; pricing: string; priceCents: number; minimumCents: number; brackets: { upToSqFt: number | null; priceCents: number }[]; incomeAccountCode: string; active: boolean; taxable?: boolean; setupMinutes?: number | null; minutesPer1000?: number | null; tiers?: { fromSqFt: number; ratePer1000Cents: number }[]; bandSizeSqFt?: number | null; bandPricePoint?: number; roundToCents?: number; maxAutoSqFt?: number | null; targetCentsPerHour?: number | null; chemical?: boolean; applicationSite?: string | null;
  /** Products it applies, and their cost per 1,000 sq ft today (null: no products). */
  products?: ServiceProductLink[]; materialPer1000Cents?: number | null; materialMissingCost?: number }
export interface ServiceProductLink { id: string; productId: string; productRateId: string; startDate: string | null; endDate: string | null; productName: string; rateName: string; amountPer1000: number; unit: string; costPer1000Cents: number | null; applies: boolean }

/** Unpaid, Overdue, Partly paid, Paid, Draft or Void, colored. */
export function InvoiceStatus({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) return <span className="badge bad">Overdue</span>;
  const tone = status === "paid" ? "ok" : status === "void" ? "bad" : status === "draft" ? "" : "warn";
  return <span className={`badge ${tone}`}>{INVOICE_STATUS_LABELS[status as InvoiceStatus] ?? status}</span>;
}

/** Dollars typed by a person → cents ("45", "45.5", "$1,250.00"). */
export const toCents = (s: string) => {
  const n = Number(String(s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
export const dollars = (c: number) => (c / 100).toFixed(2);

type Line = { serviceTypeId: string | null; description: string; quantity: string; price: string; incomeAccountCode: string; tax: string };
const blankLine = (): Line => ({ serviceTypeId: null, description: "", quantity: "1", price: "", incomeAccountCode: "4000", tax: "" });
const taxText = (r: number | null | undefined) => (r ? String(Number(r.toFixed(3))) : "");

/** The company's billing settings (sales tax on or off, its name and default rate). */
export function useBillingSettings() {
  return useApi<{ taxEnabled: boolean; taxName: string; defaultTaxRate: number; estimateDeposit?: EstimateDepositSettings }>("/invoices/settings");
}

export interface InvoiceFormValue {
  customer: { id: string; name: string } | null; propertyId: string; issueDate: string; dueDate: string; poNumber: string; notes: string;
  discountKind: "none" | "amount" | "percent"; discount: string; lines: Line[];
  /** Late fees already on the invoice: shown, but only "Waive" on the invoice page takes one off. */
  lateFees?: { description: string; cents: number }[];
}

export function invoiceFormValue(inv?: any, customer?: { id: string; name: string } | null): InvoiceFormValue {
  if (!inv) return { customer: customer ?? null, propertyId: "", issueDate: today(), dueDate: "", poNumber: "", notes: "", discountKind: "none", discount: "", lines: [blankLine()] };
  return {
    customer: { id: inv.customer.id, name: inv.customer.name }, propertyId: inv.propertyId ?? "", issueDate: inv.issueDate, dueDate: inv.dueDate,
    poNumber: inv.poNumber ?? "", notes: inv.notes ?? "", discountKind: inv.discountKind,
    discount: inv.discountKind === "amount" ? dollars(inv.discountValue) : inv.discountKind === "percent" ? String(inv.discountValue) : "",
    lateFees: inv.lines.filter((l: any) => l.isLateFee).map((l: any) => ({ description: l.description, cents: l.amountCents })),
    lines: inv.lines.filter((l: any) => !l.isLateFee).map((l: any) => ({ serviceTypeId: l.serviceTypeId, description: l.description, quantity: String(l.quantity), price: dollars(l.unitPriceCents), incomeAccountCode: l.incomeAccountCode, tax: taxText(l.taxRate) })),
  };
}

/** The value as the API wants it, or an error message. */
export function invoiceBody(v: InvoiceFormValue): { body?: Record<string, unknown>; error?: string } {
  if (!v.customer) return { error: "Choose the customer" };
  const lines = [];
  for (const [i, l] of v.lines.entries()) {
    if (!l.description.trim() && !l.price) continue;
    const quantity = Number(l.quantity), unitPriceCents = toCents(l.price);
    if (!l.description.trim()) return { error: `Line ${i + 1} needs a description` };
    if (!(quantity > 0)) return { error: `Line ${i + 1}: enter a quantity` };
    if (!Number.isFinite(unitPriceCents)) return { error: `Line ${i + 1}: enter a price` };
    const taxRate = l.tax.trim() ? Number(l.tax) : 0;
    if (!(taxRate >= 0 && taxRate <= 30)) return { error: `Line ${i + 1}: the tax rate must be 0 to 30%` };
    lines.push({ serviceTypeId: l.serviceTypeId, description: l.description.trim(), quantity: Math.round(quantity * 100) / 100, unitPriceCents, incomeAccountCode: l.incomeAccountCode, taxRate });
  }
  if (!lines.length) return { error: "Add at least one line" };
  const discountValue = v.discountKind === "amount" ? toCents(v.discount || "0") : v.discountKind === "percent" ? Number(v.discount || 0) : 0;
  if (!Number.isFinite(discountValue)) return { error: "Check the discount" };
  return {
    body: {
      customerId: v.customer.id, propertyId: v.propertyId || null, issueDate: v.issueDate || undefined, dueDate: v.dueDate || undefined,
      poNumber: v.poNumber || undefined, notes: v.notes || undefined, discountKind: v.discountKind, discountValue, lines,
    },
  };
}

/** Customer, service address, dates, PO number, lines from the price list (priced from the lawn size), discount and notes. */
export function InvoiceFields({ value, onChange, lockCustomer, fresh }: { value: InvoiceFormValue; onChange: (v: InvoiceFormValue) => void; lockCustomer?: boolean; fresh?: boolean }) {
  const set = (patch: Partial<InvoiceFormValue>) => onChange({ ...value, ...patch });
  const services = useApi<ServiceType[]>("/service-types");
  const customer = useApi<any>(value.customer ? `/customers/${value.customer.id}` : null);
  const properties: any[] = (customer.data?.properties ?? []).filter((p: any) => !p.endDate);
  const property = properties.find((p) => p.id === value.propertyId);
  // A customer with one property gets it picked automatically; a new invoice starts with their discount.
  const discounted = useRef<string | null>(null);
  useEffect(() => {
    if (!customer.data) return;
    const patch: Partial<InvoiceFormValue> = {};
    if (!value.propertyId && properties.length === 1) patch.propertyId = properties[0].id;
    if (fresh && discounted.current !== customer.data.id && value.discountKind === "none" && customer.data.discountPercent > 0) {
      patch.discountKind = "percent"; patch.discount = String(customer.data.discountPercent);
    }
    discounted.current = customer.data.id;
    if (Object.keys(patch).length) set(patch);
  }, [customer.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const setLine = (i: number, patch: Partial<Line>) => set({ lines: value.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  // Sales tax: the rate for this customer and property (property, then customer, then the default; exempt: none).
  const billing = useBillingSettings();
  const settings = billing.data ?? { taxEnabled: false, taxName: "Sales tax", defaultTaxRate: 0 };
  const rate = taxRateFor({ settings, customer: customer.data, property });
  const showTax = settings.taxEnabled || value.lines.some((l) => Number(l.tax) > 0);
  // A different customer or property: taxable lines take its rate.
  const lastRate = useRef<number | null>(null);
  useEffect(() => {
    if (!billing.data || !customer.data) return;
    if (lastRate.current !== null && lastRate.current !== rate) {
      set({ lines: value.lines.map((l) => (services.data?.find((x) => x.id === l.serviceTypeId)?.taxable ? { ...l, tax: taxText(rate) } : l)) });
    }
    lastRate.current = rate;
  }, [rate, billing.data, customer.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickService = (i: number, id: string) => {
    if (!id) return setLine(i, { serviceTypeId: null });
    const s = services.data?.find((x) => x.id === id);
    if (!s) return;
    const price = priceFor(s, property?.lawnSqFt ?? null);
    setLine(i, { serviceTypeId: s.id, description: value.lines[i].description || s.name, price: price != null ? dollars(price) : value.lines[i].price, incomeAccountCode: s.incomeAccountCode, tax: taxText(lineTaxRate(s.taxable, rate)) });
  };
  const parsed = value.lines.map((l) => ({ quantity: Number(l.quantity) || 0, unitPriceCents: toCents(l.price) || 0, taxRate: Number(l.tax) || 0 }));
  const lateFees = value.lateFees ?? [];
  const totals = invoiceTotals([...parsed, ...lateFees.map((f) => ({ quantity: 1, unitPriceCents: f.cents, isLateFee: true }))], value.discountKind, value.discountKind === "amount" ? toCents(value.discount || "0") || 0 : Number(value.discount) || 0);
  const needsPo = !!customer.data?.poRequired;

  return (
    <div className="stack">
      <div className="formgrid">
        {value.customer ? (
          <label>Customer
            <div className="row" style={{ minHeight: 36 }}><strong>{value.customer.name}</strong>{!lockCustomer && <button type="button" className="btn" onClick={() => set({ customer: null, propertyId: "" })}>Change</button>}</div>
          </label>
        ) : <CustomerPicker onPick={(c) => set({ customer: c, propertyId: "" })} label="Customer (bill-to)" />}
        {value.customer && (
          <label>Service address
            <select value={value.propertyId} onChange={(e) => set({ propertyId: e.target.value })}>
              <option value="">None (not for one property)</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.street}{p.name ? ` (${p.name})` : ""}{p.lawnSqFt ? ` · ${Math.round(p.lawnSqFt).toLocaleString()} sq ft` : ""}</option>)}
            </select>
          </label>
        )}
        <label>Invoice date<input type="date" value={value.issueDate} onChange={(e) => set({ issueDate: e.target.value })} /></label>
        <label>Due date<input type="date" value={value.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /><span className="muted" style={{ fontSize: 12 }}>Blank: your usual terms</span></label>
        <label>PO number{needsPo ? " (required)" : ""}<input value={value.poNumber} onChange={(e) => set({ poNumber: e.target.value })} required={needsPo} /></label>
      </div>

      <div className="tablewrap">
        <table className="invoice-lines">
          <thead><tr><th style={{ width: "26%" }}>Service</th><th>Description</th><th style={{ width: 80 }}>Qty</th><th style={{ width: 110 }}>Price</th>{showTax && <th style={{ width: 90 }}>Tax %</th>}<th style={{ width: 110, textAlign: "right" }}>Amount</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>{value.lines.map((l, i) => {
            const s = services.data?.find((x) => x.id === l.serviceTypeId);
            const unpriced = s && priceFor(s, property?.lawnSqFt ?? null) == null;
            return (
              <tr key={i}>
                <td>
                  <select aria-label={`Line ${i + 1} service`} value={l.serviceTypeId ?? ""} onChange={(e) => pickService(i, e.target.value)}>
                    <option value="">Custom line</option>
                    {(services.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  {s && <div className="muted" style={{ fontSize: 12 }}>{describePricing(s)}{unpriced ? " · add the lawn size to price it" : ""}</div>}
                  {!s && (
                    <select aria-label={`Line ${i + 1} income account`} value={l.incomeAccountCode} onChange={(e) => setLine(i, { incomeAccountCode: e.target.value })} style={{ marginTop: 4 }}>
                      {INCOME_ACCOUNTS.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                    </select>
                  )}
                </td>
                <td><input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                <td><input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                <td><input aria-label={`Line ${i + 1} price`} inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} /></td>
                {showTax && <td><input aria-label={`Line ${i + 1} tax rate`} inputMode="decimal" placeholder="0" value={l.tax} onChange={(e) => setLine(i, { tax: e.target.value })} /></td>}
                <td style={{ textAlign: "right" }}>{formatMoney(lineAmount(parsed[i]))}</td>
                <td>{value.lines.length > 1 && <button type="button" className="btn" aria-label={`Remove line ${i + 1}`} onClick={() => set({ lines: value.lines.filter((_, j) => j !== i) })}>✕</button>}</td>
              </tr>
            );
          })}
          {lateFees.map((f, i) => (
            <tr key={`fee-${i}`} className="muted">
              <td>Late fee</td><td colSpan={showTax ? 4 : 3}>{f.description} <span style={{ fontSize: 12 }}>(not discounted; waive it on the invoice page)</span></td>
              <td style={{ textAlign: "right" }}>{formatMoney(f.cents)}</td><td />
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div><button type="button" className="btn" onClick={() => set({ lines: [...value.lines, blankLine()] })}>Add a line</button></div>

      <div className="invoice-foot">
        <label>Notes on the invoice<textarea rows={3} value={value.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Thank you! Round 2 is coming in April." /></label>
        <div className="invoice-totals">
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <label style={{ width: 130 }}>Discount
              <select value={value.discountKind} onChange={(e) => set({ discountKind: e.target.value as InvoiceFormValue["discountKind"] })}>
                <option value="none">None</option><option value="amount">Amount ($)</option><option value="percent">Percent (%)</option>
              </select>
            </label>
            {value.discountKind !== "none" && <label style={{ width: 100 }}>{value.discountKind === "amount" ? "$" : "%"}<input inputMode="decimal" value={value.discount} onChange={(e) => set({ discount: e.target.value })} /></label>}
          </div>
          <dl className="facts totals">
            <dt>Subtotal</dt><dd>{formatMoney(totals.subtotalCents)}</dd>
            {totals.discountCents > 0 && <><dt>Discount</dt><dd>-{formatMoney(totals.discountCents)}</dd></>}
            {(showTax || totals.taxCents > 0) && <><dt>{settings.taxName || "Sales tax"}</dt><dd>{formatMoney(totals.taxCents)}</dd></>}
            <dt><strong>Total</strong></dt><dd><strong>{formatMoney(totals.totalCents)}</strong></dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

/** Choose how to send: email (to the customer, or another address) and/or paper (print queue). */
export function SendPanel({ invoice, onDone, onClose }: { invoice: any; onDone: () => void; onClose: () => void }) {
  const pref: string[] = invoice.customer.delivery ?? ["email"];
  const [email, setEmail] = useState(pref.includes("email") && !!invoice.customer.email);
  const [paper, setPaper] = useState(pref.includes("paper") || !invoice.customer.email);
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resend = !!invoice.number;
  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      const via = [email && "email", paper && "paper"].filter(Boolean);
      if (!via.length) return setError("Choose email, paper or both");
      setBusy(true); setError(null);
      try { await api(`/invoices/${invoice.id}/send`, { body: { via, emailTo: to || undefined, message: message || undefined } }); onDone(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>{resend ? "Send again" : "Send invoice"}</h2>
      {!resend && <p className="muted" style={{ margin: 0 }}>Sending gives the invoice its number.</p>}
      <label className="check"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the PDF to {invoice.customer.email ?? <em>no email on file</em>}{invoice.customer.copies?.length ? `, copying ${invoice.customer.copies.map((c: any) => c.email).join(", ")}` : ""}</label>
      {email && (
        <div className="formgrid">
          <label>Send to a different address instead (optional)<input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={invoice.customer.email ?? ""} /></label>
          <label>Message (optional)<textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={paper} onChange={(e) => setPaper(e.target.checked)} /> Paper: add it to the print queue to mail</label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Text messages arrive in Phase 2.</p>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>{resend ? "Send again" : "Send"}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

/** Record a cash, check or other payment (defaults to what's still owed). */
export function PaymentForm({ invoice, onDone, onClose }: { invoice: any; onDone: () => void; onClose: () => void }) {
  const [amount, setAmount] = useState(dollars(invoice.balanceCents));
  const [method, setMethod] = useState("check");
  const [receivedOn, setReceivedOn] = useState(today());
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      const amountCents = toCents(amount);
      if (!(amountCents > 0)) return setError("Enter the amount");
      setBusy(true); setError(null);
      try { await api(`/invoices/${invoice.id}/payments`, { body: { amountCents, method, receivedOn, reference: reference || undefined, note: note || undefined } }); onDone(); }
      catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Record a payment</h2>
      <div className="formgrid">
        <label>Amount ($)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label>Method
          <select value={method} onChange={(e) => setMethod(e.target.value)}><option value="check">Check</option><option value="cash">Cash</option><option value="other">Other</option></select>
        </label>
        <label>Received<input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} /></label>
        {method === "check" && <label>Check number<input value={reference} onChange={(e) => setReference(e.target.value)} /></label>}
        <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Card and bank payments come in through the customer portal (next).</p>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Record payment</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

export function useServices(all = false) {
  const r = useApi<ServiceType[]>(`/service-types${all ? "?all=1" : ""}`);
  return useMemo(() => ({ ...r, list: r.data ?? [] }), [r]);
}

/** Customer page: what they owe, and their invoices. */
export function CustomerBilling({ customerId, hideSummary }: { customerId: string; hideSummary?: boolean }) {
  const summary = useApi<{ outstandingCents: number; pastDueCents: number; draftCount: number; paidThisYearCents: number; creditCents: number; prepaidCents: number }>(`/invoices/customer-summary/${customerId}`);
  const list = useApi<{ rows: any[] }>(`/invoices?status=all&customerId=${customerId}&limit=50`);
  const s = summary.data;
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{hideSummary ? "Invoices" : "Billing"}</h2>
        <Link className="btn" href={`/invoices/new?customerId=${customerId}`}>New invoice</Link>
      </div>
      {s && !hideSummary && (
        <div className="money-box">
          <div><div className="v" style={{ color: s.pastDueCents ? "var(--bad)" : undefined }}>{formatMoney(s.pastDueCents)}</div><div className="l">Past due</div></div>
          <div><div className="v">{formatMoney(s.outstandingCents)}</div><div className="l">Outstanding</div></div>
          <div><div className="v">{formatMoney(s.paidThisYearCents)}</div><div className="l">Paid this year</div></div>
          {s.prepaidCents > 0 || s.creditCents > 0
            ? <div><div className="v ok-text">{formatMoney(s.prepaidCents + s.creditCents)}</div><div className="l">{s.prepaidCents && s.creditCents ? "Prepaid + credit" : s.prepaidCents ? "Prepaid" : "Credit on account"}</div></div>
            : <div><div className="v">{s.draftCount}</div><div className="l">Draft invoices</div></div>}
        </div>
      )}
      {list.data?.rows.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Due</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Balance</th><th>Status</th></tr></thead>
            <tbody>{list.data.rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/invoices/${r.id}`}><strong>{r.number ?? "Draft"}</strong></Link></td>
                <td>{fmtDate(r.issueDate)}</td><td>{fmtDate(r.dueDate)}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(r.totalCents)}</td>
                <td style={{ textAlign: "right" }}>{r.status === "void" ? "—" : formatMoney(r.balanceCents)}</td>
                <td><InvoiceStatus status={r.status} overdue={r.overdue} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : list.loading ? null : <p className="muted" style={{ margin: 0 }}>No invoices yet.</p>}
    </div>
  );
}

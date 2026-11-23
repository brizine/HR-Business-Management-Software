"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { PAYMENT_METHOD_LABELS, formatMoney, formatTaxRate, type PaymentMethod } from "@crewdesk/shared";
import { API_URL, api, fmtDate, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { CreditForm, InvoiceCredits } from "@/components/credits";
import { ErrorBox, PageHead } from "@/components/ui";
import { ChargeOnFile } from "@/components/payment-methods";
import { InvoiceFields, InvoiceStatus, PaymentForm, SendPanel, invoiceBody, invoiceFormValue, useBillingSettings } from "@/components/invoices";
import { CustomFieldsCard } from "@/components/custom-fields";

export default function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const invoice = useApi<any>(`/invoices/${id}`);
  const [panel, setPanel] = useState<"send" | "pay" | "edit" | "void" | null>(null);
  const [charged, setCharged] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [addingCredit, setAddingCredit] = useState(false);
  const { can } = useAuth();
  const taxSettings = useBillingSettings();
  const action = useAction();
  // "Save and send" on the new-invoice page lands here with the send panel open.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("send") === "1") { setPanel("send"); url.searchParams.delete("send"); window.history.replaceState(window.history.state, "", url.pathname); }
  }, []);
  const inv = invoice.data;
  if (invoice.error) return <><PageHead title="Invoice" /><ErrorBox error={invoice.error} /></>;
  if (!inv) return <PageHead title="Invoice" sub="Loading…" />;
  const done = () => { setPanel(null); invoice.reload(); };
  const editable = inv.status !== "void" && inv.paidCents === 0 && !(inv.creditedCents > 0);
  const title = inv.number ? `Invoice ${inv.number}` : "Draft invoice";

  return (
    <>
      <PageHead title={title} before={<Link className="btn" href="/invoices" aria-label="Back to invoices">←</Link>}
        sub={<><Link href={`/customers/${inv.customer.id}`}>{inv.customer.name}</Link> · <InvoiceStatus status={inv.status} overdue={inv.overdue} />{inv.needsMailing && <> · <span className="badge">to mail</span></>}</>}>
        {inv.status !== "void" && <button className="btn primary" onClick={() => setPanel(panel === "send" ? null : "send")}>{inv.number ? "Send again" : "Send"}</button>}
        {(inv.status === "sent" || inv.status === "partial") && <button className="btn" onClick={() => setPanel(panel === "pay" ? null : "pay")}>Record payment</button>}
        {(inv.status === "sent" || inv.status === "partial") && <button className="btn" onClick={() => setAddingCredit(!addingCredit)}>Add credit</button>}
        <a className="btn" href={`${API_URL}/invoices/${id}/pdf`} target="_blank" rel="noopener noreferrer">PDF</a>
        {editable && <button className="btn" onClick={() => setPanel(panel === "edit" ? null : "edit")}>Edit</button>}
        {inv.status === "draft" && <button className="btn danger" disabled={action.busy} onClick={() => confirm("Delete this draft?") && action.run(async () => { await api(`/invoices/${id}`, { method: "DELETE" }); router.push("/invoices"); })}>Delete</button>}
        {(inv.status === "sent" || inv.status === "partial") && inv.paidCents === 0 && <button className="btn danger" onClick={() => setPanel(panel === "void" ? null : "void")}>Void</button>}
      </PageHead>
      <ErrorBox error={action.error} />
      {panel === "send" && <SendPanel invoice={inv} onDone={done} onClose={() => setPanel(null)} />}
      {panel === "pay" && <PaymentForm invoice={inv} onDone={done} onClose={() => setPanel(null)} />}
      {panel === "void" && <VoidForm id={id} onDone={done} onClose={() => setPanel(null)} />}
      {charged && <div className="notice" role="status">{charged} <button type="button" className="linkbtn" onClick={() => setCharged(null)}>OK</button></div>}
      {!panel && <ChargeOnFile key={`${inv.paidCents}-${inv.status}`} invoice={{ ...inv, customerId: inv.customer.id }} onDone={(msg) => { setCharged(msg); invoice.reload(); }} />}
      {panel === "edit" ? <EditInvoice invoice={inv} onDone={done} /> : (
        <>
          <div className="card">
            <div className="money-box">
              <div><div className="v">{formatMoney(inv.totalCents)}</div><div className="l">Total</div></div>
              <div><div className="v">{formatMoney(inv.paidCents)}</div><div className="l">Paid{inv.creditedCents > 0 ? <> · credit <span className="ok-text">{formatMoney(inv.creditedCents)}</span></> : ""}</div></div>
              <div><div className="v" style={{ color: inv.overdue ? "var(--bad)" : undefined }}>{inv.status === "void" ? "—" : formatMoney(inv.balanceCents)}</div><div className="l">Balance{inv.overdue ? " (overdue)" : ""}</div></div>
              <div><div className="v" style={{ fontSize: 16 }}>{fmtDate(inv.dueDate)}</div><div className="l">Due</div></div>
            </div>
          </div>
          <div className="grid cols-2">
            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Details</h2>
              <dl className="facts">
                <dt>Bill to</dt><dd><strong>{inv.customer.name}</strong> <span className="muted">#{inv.customer.number}</span>{inv.customer.billTo.map((l: string) => <div key={l}>{l}</div>)}</dd>
                <dt>Service address</dt><dd>{inv.property ? <Link href={`/properties/${inv.property.id}`}>{inv.property.address}</Link> : "—"}</dd>
                <dt>Invoice date</dt><dd>{fmtDate(inv.issueDate)}</dd>
                {inv.poNumber && <><dt>PO number</dt><dd>{inv.poNumber}</dd></>}
                {inv.voidReason && <><dt>Voided</dt><dd>{fmtDateTime(inv.voidedAt)}: {inv.voidReason}</dd></>}
              </dl>
            </div>
            <div className="card">
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Delivery</h2>
              <ul className="plain-list">
                {!inv.number && <li className="muted">Not sent yet. Sending numbers it.</li>}
                {inv.emailedAt && <li>Emailed {fmtDateTime(inv.emailedAt)} to {inv.emailedTo}</li>}
                {inv.needsMailing && <li>Waiting to be printed and mailed (<Link href="/invoices?status=mail">To mail</Link>)</li>}
                {inv.mailedAt && <li>Mailed {fmtDate(inv.mailedAt)}</li>}
                {inv.number && !inv.emailedAt && !inv.needsMailing && !inv.mailedAt && <li className="muted">{inv.payments.some((p: any) => p.status === "completed") ? "Not mailed: it was paid before it went out." : "Numbered, not delivered."}</li>}
                {inv.onlinePayments && inv.number && inv.status !== "void" && inv.status !== "paid" && (
                  inv.payLink
                    ? <li className="row" style={{ gap: 8 }}>Pay link works until {fmtDate(inv.payLink.expiresAt)} <CopyButton text={inv.payLink.url} label="Copy pay link" /></li>
                    : <li className="muted">Pay link expired. Send again to give the customer a new one (or they can sign in to the portal).</li>
                )}
              </ul>
              <BooksStatus inv={inv} onChange={invoice.reload} />
            </div>
          </div>
          <div className="card tablewrap">
            <table>
              <thead><tr><th>Description</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Price</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {inv.lines.map((l: any) => (
                  <tr key={l.id}><td>{l.description}<div className="muted" style={{ fontSize: 12 }}>Income {l.incomeAccountCode}{l.taxRate > 0 ? ` · taxed ${formatTaxRate(l.taxRate)}` : ""}</div></td><td style={{ textAlign: "right" }}>{l.quantity}</td><td style={{ textAlign: "right" }}>{formatMoney(l.unitPriceCents)}</td><td style={{ textAlign: "right" }}>{formatMoney(l.amountCents)}</td></tr>
                ))}
                <tr><td colSpan={3} style={{ textAlign: "right" }}>Subtotal</td><td style={{ textAlign: "right" }}>{formatMoney(inv.subtotalCents)}</td></tr>
                {inv.discountCents > 0 && <tr><td colSpan={3} style={{ textAlign: "right" }}>Discount</td><td style={{ textAlign: "right" }}>-{formatMoney(inv.discountCents)}</td></tr>}
                {inv.taxCents > 0 && <tr><td colSpan={3} style={{ textAlign: "right" }}>{taxSettings.data?.taxName || "Sales tax"}</td><td style={{ textAlign: "right" }}>{formatMoney(inv.taxCents)}</td></tr>}
                <tr><td colSpan={3} style={{ textAlign: "right" }}><strong>Total</strong></td><td style={{ textAlign: "right" }}><strong>{formatMoney(inv.totalCents)}</strong></td></tr>
              </tbody>
            </table>
            {inv.notes && <p style={{ whiteSpace: "pre-wrap" }}>{inv.notes}</p>}
          </div>
          <InvoiceCredits invoice={inv} onChange={invoice.reload} />
          {addingCredit && <CreditForm customerId={inv.customer.id} properties={inv.property ? [{ id: inv.property.id, address: inv.property.address }] : []} invoiceId={id}
            onDone={() => { setAddingCredit(false); invoice.reload(); }} onClose={() => setAddingCredit(false)} />}
          <div className="card">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>Payments</h2>
            {inv.payments.length ? (
              <ul className="plain-list">
                {inv.payments.map((p: any) => (
                  <li key={p.id} className="stack" style={{ gap: 6 }}>
                  <div className="row" style={{ justifyContent: "space-between", opacity: p.status === "void" || p.status === "failed" || (p.refundedCents > 0 && p.refundedCents >= p.amountCents) ? 0.55 : 1 }}>
                    <span><strong>{formatMoney(p.amountCents)}</strong> {PAYMENT_METHOD_LABELS[p.method as PaymentMethod]}{p.prepaymentNumber ? ` (PP-${p.prepaymentNumber})` : ""}{p.methodDetail ? ` (${p.methodDetail})` : ""}{p.reference ? ` #${p.reference}` : ""}
                      {p.status === "pending" && <> <span className="badge warn" title="Bank payments take about 4 business days to clear">clearing</span></>}
                      {p.status === "failed" && <> <span className="badge bad" title="The bank returned it; the invoice still owes this">failed</span></>}
                      {p.refundedCents > 0 && <> <span className="badge warn">{p.refundedCents >= p.amountCents ? "refunded" : `${formatMoney(p.refundedCents)} refunded`}</span></>}
                      {" "}<span className="muted">· {fmtDate(p.receivedOn)}{p.note ? ` · ${p.note}` : ""}{p.feeCents ? ` · Stripe fee ${formatMoney(p.feeCents)}` : ""}{p.status === "void" ? " · void" : ""}</span>
                      {inv.sync?.connected && p.status === "completed" && <PaymentBooks s={inv.sync.payments?.[p.id]} />}</span>
                    {p.status === "completed" && (p.method === "cash" || p.method === "check" || p.method === "other" || p.method === "prepaid") && (
                      <button className="btn" disabled={action.busy} onClick={() => confirm(p.method === "prepaid" ? "Void this payment? The money (and its discount) goes back to the prepayment, and the invoice owes it again." : "Void this payment? The invoice goes back to owing it.") && action.run(async () => { await api(`/invoices/${id}/payments/${p.id}/void`, { method: "POST" }); invoice.reload(); })}>Void payment</button>
                    )}
                    {p.status === "completed" && p.stripePaymentId && p.amountCents > p.refundedCents && can("admin", "customers") && (
                      <button className="btn" onClick={() => setRefunding(refunding === p.id ? null : p.id)}>Refund</button>
                    )}
                  </div>
                  {p.refunds?.length > 0 && (
                    <ul className="plain-list refund-list">
                      {p.refunds.map((r: any) => (
                        <li key={r.id} style={{ opacity: r.status === "failed" || r.status === "canceled" ? 0.6 : 1 }}>
                          ↩ Refunded <strong>{formatMoney(r.amountCents)}</strong> <span className="muted">· {fmtDate(r.refundedOn)}</span>
                          {r.status === "pending" && <> <span className="badge warn">on its way</span></>}
                          {(r.status === "failed" || r.status === "canceled") && <> <span className="badge bad">{r.status}: not refunded</span></>}
                          <span className="muted"> · {r.createdById ? "in Crewdesk" : "in Stripe"}{r.reason ? ` · ${REFUND_REASON_LABELS[r.reason] ?? r.reason}` : ""}{r.note ? ` · ${r.note}` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {refunding === p.id && <RefundForm invoiceId={id} payment={p} onDone={() => { setRefunding(null); invoice.reload(); }} onClose={() => setRefunding(null)} />}
                  </li>
                ))}
              </ul>
            ) : <p className="muted" style={{ margin: 0 }}>No payments yet.</p>}
          </div>
          <CustomFieldsCard target="invoice" id={inv.id} canEdit={inv.status !== "void"} values={inv.custom ?? {}} onSaved={() => invoice.reload()} />
        </>
      )}
    </>
  );
}

function EditInvoice({ invoice, onDone }: { invoice: any; onDone: () => void }) {
  const [value, setValue] = useState(invoiceFormValue(invoice));
  const { busy, error, run, setError } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const { body, error: problem } = invoiceBody(value);
      if (!body) return setError(problem ?? "Check the invoice");
      run(async () => { await api(`/invoices/${invoice.id}`, { method: "PUT", body }); onDone(); });
    }}>
      {invoice.number && <p className="muted" style={{ margin: 0 }}>This invoice was already sent. After saving, use Send again so the customer gets the corrected copy.</p>}
      <InvoiceFields value={value} onChange={setValue} lockCustomer={!!invoice.number} />
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

const REFUND_REASON_LABELS: Record<string, string> = { requested_by_customer: "Requested by customer", duplicate: "Duplicate payment", fraudulent: "Fraudulent" };

/** Sends part or all of a card or bank payment back through Stripe. */
function RefundForm({ invoiceId, payment, onDone, onClose }: { invoiceId: string; payment: any; onDone: () => void; onClose: () => void }) {
  const left = payment.amountCents - payment.refundedCents;
  const [amount, setAmount] = useState((left / 100).toFixed(2));
  const [reason, setReason] = useState("requested_by_customer");
  const [note, setNote] = useState("");
  const [writeOff, setWriteOff] = useState(false);
  const { busy, error, run } = useAction();
  const cents = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && cents <= left;
  return (
    <form className="card stack refund-form" onSubmit={(e) => {
      e.preventDefault();
      if (!confirm(`Refund ${formatMoney(cents)} to ${payment.methodDetail ?? "the customer"}? This sends the money back and can't be undone.`)) return;
      run(async () => { await api(`/invoices/${invoiceId}/payments/${payment.id}/refund`, { body: { amountCents: cents, reason, note: note || null, writeOff } }); onDone(); });
    }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Refund {payment.methodDetail ? `to ${payment.methodDetail}` : "this payment"}</h3>
      <p className="muted" style={{ margin: 0 }}>
        The money goes back through Stripe ({payment.method === "ach" ? "bank refunds take up to 5 business days" : "cards show it in 5–10 business days"}) and the customer gets an email.
        Stripe keeps its original fee.
      </p>
      <div className="formgrid">
        <label>Amount ($)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /><span className="muted" style={{ fontSize: 12 }}>Up to {formatMoney(left)}</span></label>
        <label>Reason<select value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(REFUND_REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label>Note (for your records)<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={450} placeholder="Missed the back yard, double payment…" /></label>
      <label className="check"><input type="checkbox" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} /> Write it off: the customer won&apos;t owe this again (adds a credit for the refund to this invoice)</label>
      {!writeOff && <p className="muted" style={{ margin: 0 }}>Without writing it off, the invoice owes the refunded amount again (for example, a payment made with the wrong card).</p>}
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn danger" disabled={busy || !valid}>{busy ? "Refunding…" : `Refund ${valid ? formatMoney(cents) : ""}`}</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function VoidForm({ id, onDone, onClose }: { id: string; onDone: () => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/invoices/${id}/void`, { body: { reason } }); onDone(); }); }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Void this invoice</h2>
      <p className="muted" style={{ margin: 0 }}>It stays on record, marked void, and no longer counts as owed.</p>
      <label>Reason<input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate, wrong customer…" /></label>
      <ErrorBox error={error} />
      <div className="row"><button className="btn danger" disabled={busy}>Void invoice</button><button type="button" className="btn" onClick={onClose}>Keep it</button></div>
    </form>
  );
}

/** Where this invoice stands in Bigcapital, with a retry when it didn't get there. */
function BooksStatus({ inv, onChange }: { inv: any; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const s = inv.sync;
  if (!s?.connected || !inv.number) return null;
  const st = s.invoice?.status;
  return (
    <div className="books-status">
      <strong>Bigcapital: </strong>
      {st === "posted" ? <span className="ok-text">{inv.status === "void" ? "removed (void)" : "in the books"}</span>
        : st === "skipped" ? <span className="muted">{s.invoice.error ?? "not sent"}</span>
        : st === "failed" ? <span className="bad-text">not sent yet: {s.invoice.error}</span>
        : <span className="muted">sending…</span>}
      {(st === "failed" || !st) && <button className="btn" style={{ marginLeft: 8 }} disabled={busy} onClick={() => run(async () => { await api(`/invoices/${inv.id}/sync`, { method: "POST" }); onChange(); })}>Send to Bigcapital now</button>}
      <ErrorBox error={error} />
    </div>
  );
}

function PaymentBooks({ s }: { s: { status: string; error: string | null } | null | undefined }) {
  if (!s) return <span className="muted"> · sending to Bigcapital…</span>;
  if (s.status === "posted") return <span className="ok-text"> · in Bigcapital</span>;
  if (s.status === "skipped") return <span className="muted"> · not sent ({s.error})</span>;
  return <span className="bad-text" title={s.error ?? ""}> · not in Bigcapital yet</span>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn" onClick={async () => {
      try { await navigator.clipboard.writeText(text); } catch { window.prompt("Copy this link:", text); }
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    }}>{copied ? "Copied" : label}</button>
  );
}

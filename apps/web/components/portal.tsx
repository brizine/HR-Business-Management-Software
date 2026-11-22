"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadStripe, type PaymentIntentResult, type Stripe, type StripeElements } from "@stripe/stripe-js";
import { formatMoney } from "@crewdesk/shared";
import { API_URL, api } from "@/lib/api";

/* Customer-facing pages: the portal (/portal) and invoice pay links (/pay/<token>). */

export type PortalCompany = { id: string; name: string; phone: string | null; email: string | null; website: string | null; hasLogo: boolean; isTest: boolean };
export type PortalPayments = { enabled: false } | { enabled: true; publishableKey: string; testMode: boolean };
export type PortalPayment = { id: string; amountCents: number; refundedCents?: number; method: string; methodDetail: string | null; receivedOn: string; status: string; invoiceId?: string; invoiceNumber?: number | null };
export type PortalInvoice = {
  id: string; number: number; status: string; issueDate: string; dueDate: string; poNumber: string | null; notes: string | null;
  subtotalCents: number; discountCents: number; totalCents: number; paidCents: number; balanceCents: number; pendingCents: number; overdue: boolean;
  customer: { id: string; number: number; name: string }; serviceAddress: string | null;
  lines: { description: string; quantity: number; unitPriceCents: number; amountCents: number }[];
  payments: PortalPayment[];
  refunds?: { id: string; paymentId: string; amountCents: number; refundedOn: string; status: string }[];
  creditedCents?: number;
  credits?: { id: string; number: number; description: string; amountCents: number }[];
};

export const longDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const METHOD: Record<string, string> = { card: "Card", ach: "Bank account", cash: "Cash", check: "Check", other: "Payment" };
export const methodText = (p: PortalPayment) => p.methodDetail ?? METHOD[p.method] ?? "Payment";

/** The page frame: the company's logo and name, and how to reach them. */
export function PortalFrame({ company, right, children }: { company: PortalCompany | null; right?: ReactNode; children: ReactNode }) {
  useEffect(() => { if (company) document.title = `${company.name}: your account`; }, [company]);
  return (
    <div className="pt-page">
      <header className="pt-head">
        <div className="pt-brand">
          {company?.hasLogo && <img src={`${API_URL}/public/company/${company.id}/logo`} alt="" className="pt-logo" />}
          <span className="pt-name">{company?.name ?? ""}</span>
        </div>
        {right}
      </header>
      {company?.isTest && <div className="pt-test">Test company: sample customers and test payments only.</div>}
      <main className="pt-main">{children}</main>
      {company && (company.phone || company.email) && (
        <footer className="pt-foot">
          Questions about a bill? {company.phone && <>Call <a href={`tel:${company.phone.replace(/[^\d+]/g, "")}`}>{company.phone}</a></>}
          {company.phone && company.email && " or "}{company.email && <>email <a href={`mailto:${company.email}`}>{company.email}</a></>}.
        </footer>
      )}
    </div>
  );
}

export function StatusPill({ inv }: { inv: { status: string; overdue: boolean; pendingCents: number; balanceCents: number } }) {
  if (inv.status === "void") return <span className="pt-pill gray">Cancelled</span>;
  if (inv.status === "paid") return <span className="pt-pill ok">Paid</span>;
  if (inv.pendingCents > 0 && inv.pendingCents >= inv.balanceCents) return <span className="pt-pill info">Payment clearing</span>;
  if (inv.overdue) return <span className="pt-pill bad">Past due</span>;
  if (inv.status === "partial") return <span className="pt-pill warn">Partly paid</span>;
  return <span className="pt-pill warn">Due</span>;
}

/** One invoice: lines, totals, payments, PDF, and the pay box. */
export function InvoiceView({ inv, pdfHref, pay }: { inv: PortalInvoice; pdfHref: string; pay?: ReactNode }) {
  return (
    <div className="pt-invoice">
      <div className="pt-card pt-summary">
        <div>
          <div className="pt-label">Invoice {inv.number}</div>
          <div className="pt-amount">{formatMoney(inv.status === "void" ? 0 : inv.balanceCents)}</div>
          <div className="pt-sub">
            {inv.status === "paid" ? "Paid in full. Thank you!" : inv.status === "void" ? "This invoice was cancelled." : <>Due {longDate(inv.dueDate)}{inv.overdue ? " (past due)" : ""}</>}
          </div>
        </div>
        <StatusPill inv={inv} />
      </div>
      {inv.pendingCents > 0 && <p className="pt-note info">A bank payment of {formatMoney(inv.pendingCents)} is on its way. Bank payments take about 4 business days to clear; we&apos;ll email a receipt when it does.</p>}
      {pay}
      <div className="pt-card">
        <dl className="pt-facts">
          <dt>Customer</dt><dd>{inv.customer.name} <span className="pt-muted">· account #{inv.customer.number}</span></dd>
          {inv.serviceAddress && <><dt>Service address</dt><dd>{inv.serviceAddress}</dd></>}
          <dt>Invoice date</dt><dd>{longDate(inv.issueDate)}</dd>
          {inv.poNumber && <><dt>PO number</dt><dd>{inv.poNumber}</dd></>}
        </dl>
        <table className="pt-lines">
          <thead><tr><th>Service</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i}><td>{l.description}{l.quantity !== 1 && <div className="pt-muted">{l.quantity} × {formatMoney(l.unitPriceCents)}</div>}</td><td className="num">{formatMoney(l.amountCents)}</td></tr>
            ))}
          </tbody>
          <tfoot>
            {inv.discountCents > 0 && <><tr><td>Subtotal</td><td className="num">{formatMoney(inv.subtotalCents)}</td></tr><tr><td>Discount</td><td className="num">−{formatMoney(inv.discountCents)}</td></tr></>}
            <tr className="total"><td>Total</td><td className="num">{formatMoney(inv.totalCents)}</td></tr>
            {(inv.credits ?? []).map((c) => <tr key={c.id}><td>Credit: {c.description}</td><td className="num">−{formatMoney(c.amountCents)}</td></tr>)}
            {inv.payments.filter((p) => p.status === "completed").map((p) => (
              <tr key={p.id}><td>Paid {longDate(p.receivedOn)} · {methodText(p)}</td><td className="num">−{formatMoney(p.amountCents)}</td></tr>
            ))}
            {(inv.refunds ?? []).map((r) => {
              const p = inv.payments.find((x) => x.id === r.paymentId);
              return <tr key={r.id}><td>Refunded {longDate(r.refundedOn)}{p ? ` to ${methodText(p)}` : ""}{r.status === "pending" ? " (on its way)" : ""}</td><td className="num">+{formatMoney(r.amountCents)}</td></tr>;
            })}
            {(inv.paidCents > 0 || (inv.refunds?.length ?? 0) > 0 || (inv.credits?.length ?? 0) > 0) && inv.status !== "void" && <tr className="total"><td>Balance</td><td className="num">{formatMoney(inv.balanceCents)}</td></tr>}
          </tfoot>
        </table>
        {inv.notes && <p className="pt-muted" style={{ whiteSpace: "pre-wrap" }}>{inv.notes}</p>}
        <a className="pt-btn" href={pdfHref} target="_blank" rel="noopener noreferrer">Download PDF</a>
      </div>
    </div>
  );
}

type Started = { clientSecret: string; publishableKey: string; amountCents: number; paymentIntentId: string };
type Confirmed = { status?: string; ignored?: boolean; invoice: PortalInvoice };

const RESULT: Record<string, string> = {
  succeeded: "Thank you! Your payment went through. A receipt is on its way to your email.",
  processing: "Thank you! Your bank payment is on its way. It takes about 4 business days to clear; we'll email a receipt when it does.",
  requires_action: "Almost done: Stripe will make a small deposit to your bank account in 1–2 business days and email you how to confirm it. Your payment goes through after that.",
};

/**
 * Pay the balance by card or bank account, in Stripe's own form (card and bank details go straight
 * to Stripe). `start` makes the payment; `confirm` tells Crewdesk how it went.
 */
export function PayBox({ inv, payments, start, confirm, onPaid }: {
  inv: PortalInvoice; payments: PortalPayments;
  start: () => Promise<Started>; confirm: (paymentIntentId: string) => Promise<Confirmed>; onPaid: (inv: PortalInvoice) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "loading" | "form" | "paying" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [amount, setAmount] = useState(inv.balanceCents);
  const box = useRef<HTMLDivElement>(null);
  const s = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null);
  const pending = useRef<{ stripe: Stripe; elements: StripeElements } | null>(null);

  // Coming back from a bank or card check that needed a new page.
  useEffect(() => {
    const url = new URL(window.location.href);
    const pi = url.searchParams.get("payment_intent");
    if (!pi) return;
    url.searchParams.delete("payment_intent"); url.searchParams.delete("payment_intent_client_secret"); url.searchParams.delete("redirect_status");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    confirm(pi).then((r) => { onPaid(r.invoice); setMessage(RESULT[r.status === "completed" ? "succeeded" : r.status === "pending" ? "processing" : ""] ?? null); setPhase("done"); }, (e) => setError((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show Stripe's form once its box is on the page.
  useEffect(() => {
    if (phase !== "form" || !box.current || !pending.current) return;
    const { elements } = pending.current;
    elements.create("payment", { layout: "tabs" }).mount(box.current);
    s.current = pending.current;
    pending.current = null;
  }, [phase]);

  // Nothing to pay (but keep the thank-you message showing once they've paid).
  if (phase !== "done" && !message && (!payments.enabled || inv.status === "paid" || inv.status === "void" || inv.balanceCents <= 0 || inv.pendingCents >= inv.balanceCents)) return null;

  const begin = async () => {
    setError(null); setPhase("loading");
    try {
      const r = await start();
      setAmount(r.amountCents);
      const stripe = await loadStripe(r.publishableKey);
      if (!stripe) throw new Error("Couldn't load the payment form. Check your connection and try again.");
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      const elements = stripe.elements({ clientSecret: r.clientSecret, appearance: { theme: dark ? "night" : "stripe", variables: { colorPrimary: "#1f7a3a", borderRadius: "8px" } } });
      pending.current = { stripe, elements };
      setPhase("form");
    } catch (e) {
      setError((e as Error).message); setPhase("idle");
    }
  };

  const submit = async () => {
    if (!s.current) return;
    setError(null); setPhase("paying");
    const { stripe, elements } = s.current;
    let result: PaymentIntentResult;
    try {
      result = await stripe.confirmPayment({ elements, redirect: "if_required", confirmParams: { return_url: window.location.href.split("#")[0] } });
    } catch (e) {
      setError(`The payment didn't go through: ${(e as Error).message}. Check your connection and try again.`); setPhase("form"); return;
    }
    const { error: err, paymentIntent } = result;
    if (err) { setError(err.message ?? "The payment didn't go through."); setPhase("form"); return; }
    try {
      const r = await confirm(paymentIntent!.id);
      onPaid(r.invoice);
    } catch { /* the webhook records it */ }
    setMessage(RESULT[paymentIntent!.status] ?? "Thank you! We're processing your payment.");
    setPhase("done");
  };

  return (
    <div className="pt-card pt-pay">
      {payments.enabled && payments.testMode && phase !== "done" && <p className="pt-note warn">Test mode: no real money moves. Card <strong>4242 4242 4242 4242</strong>, any future date, any CVC and ZIP. For a bank account, choose <strong>Test Institution</strong>.</p>}
      {phase === "done" ? <p className="pt-note ok" role="status">{message}</p> : (
        <>
          {phase === "idle" || phase === "loading" ? (
            <button className="pt-btn primary big" disabled={phase === "loading"} onClick={begin}>{phase === "loading" ? "Loading…" : `Pay ${formatMoney(inv.balanceCents - inv.pendingCents)}`}</button>
          ) : (
            <>
              <h2 className="pt-h2">Pay {formatMoney(amount)}</h2>
              <div ref={box} className="pt-stripe" />
              <button className="pt-btn primary big" disabled={phase === "paying"} onClick={submit}>{phase === "paying" ? "Paying…" : `Pay ${formatMoney(amount)}`}</button>
              <p className="pt-muted small">Card or US bank account. Your card or bank details go straight to Stripe, our payment processor; we never see or keep them.</p>
            </>
          )}
        </>
      )}
      {error && <p className="pt-note bad" role="alert">{error}</p>}
    </div>
  );
}

/** Calls for the portal (cookie sign-in). */
export const portalApi = {
  me: () => api<any>("/portal/me"),
  company: (c: string | null) => api<{ company: PortalCompany; payments: PortalPayments }>(`/portal/company${c ? `?c=${encodeURIComponent(c)}` : ""}`),
  invoice: (id: string) => api<{ company: PortalCompany; payments: PortalPayments; viewer: { email: string; staff: boolean }; invoice: PortalInvoice }>(`/portal/invoices/${id}`),
};

export function SignOut({ staff }: { staff: boolean }) {
  return (
    <button className="pt-link" onClick={async () => { await api("/portal/sign-out", { method: "POST" }).catch(() => {}); if (staff) window.close(); window.location.href = "/portal"; }}>
      {staff ? "Close" : "Sign out"}
    </button>
  );
}

export function StaffBanner({ name }: { name: string }) {
  return <div className="pt-staff">You&apos;re viewing <strong>{name}</strong>&apos;s portal as staff. It&apos;s read-only: paying and changing details are turned off.</div>;
}

export function BackHome() {
  return <Link href="/portal" className="pt-link">← All invoices</Link>;
}

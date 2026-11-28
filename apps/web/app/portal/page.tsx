"use client";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatMoney } from "@crewdesk/shared";
import { ApiError, api } from "@/lib/api";
import { PortalPaymentMethods, type SavedMethod } from "@/components/payment-methods";
import { PortalFrame, SignOut, StaffBanner, StatusPill, StripePay, longDate, methodText, portalApi, type PortalCompany, type PortalPayment, type PortalPayments } from "@/components/portal";

type Me = {
  company: PortalCompany; payments: { enabled: boolean; testMode?: boolean };
  viewer: { email: string; staff: boolean };
  customers: { id: string; number: number; name: string; email: string | null; phone: string | null; billing: { street: string | null; city: string | null; state: string | null; zip: string | null }; balanceCents: number; overdueCents: number; creditCents: number; prepaidCents: number; properties: { id: string; address: string }[]; autopay: boolean; paymentMethods: SavedMethod[] }[];
  invoices: { id: string; number: number; customerId: string; status: string; issueDate: string; dueDate: string; totalCents: number; paidCents: number; balanceCents: number; pendingCents: number; overdue: boolean; serviceAddress: string | null }[];
  paymentHistory: PortalPayment[];
  estimates: { id: string; number: number; title: string | null; status: string; issueDate: string; totalCents: number; customerId: string; link: string | null }[];
  prepayments: { id: string; number: number; description: string; amountCents: number; discountCents: number; status: string; receivedOn: string | null; methodDetail: string | null; cashLeftCents: number; customer: { id: string } }[];
};

/** The customer portal: sign in with an emailed code, then see invoices, balance and payments. */
function Portal() {
  const c = useSearchParams().get("c");
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState<{ company: PortalCompany } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await portalApi.me());
      setSignedOut(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) { setError((e as Error).message); return; }
      try { setSignedOut(await portalApi.company(c)); } catch (e2) { setError((e2 as Error).message); }
    }
  }, [c]);
  useEffect(() => { load(); }, [load]);

  if (error) return <PortalFrame company={null}><div className="pt-card"><p className="pt-note bad">{error}</p></div></PortalFrame>;
  if (signedOut) return <PortalFrame company={signedOut.company}><SignIn company={signedOut.company} onIn={load} /></PortalFrame>;
  if (!me) return <PortalFrame company={null}><p className="pt-muted">Loading…</p></PortalFrame>;
  return <Home me={me} reload={load} />;
}

function SignIn({ company, onIn }: { company: PortalCompany; onIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  return (
    <div className="pt-card pt-signin">
      <h1 className="pt-h1">See and pay your bills</h1>
      {step === "email" ? (
        <form onSubmit={(e) => { e.preventDefault(); go(async () => { await api("/portal/start", { body: { email, companyId: company.id } }); setStep("code"); }); }}>
          <p className="pt-muted">Enter the email address {company.name} sends your invoices to. We&apos;ll email you a code; there&apos;s no password to remember.</p>
          <label className="pt-field">Email<input type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
          <button className="pt-btn primary big" disabled={busy}>{busy ? "Sending…" : "Email me a code"}</button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); go(async () => { await api("/portal/verify", { body: { email, code, companyId: company.id } }); onIn(); }); }}>
          <p className="pt-muted">If <strong>{email}</strong> is on an account with us, a 6-digit code is on its way. It works for 15 minutes. (You can also just click the link in that email.)</p>
          <label className="pt-field">Code<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus className="pt-code" /></label>
          <button className="pt-btn primary big" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
          <p className="pt-muted small">No email after a minute? Check your spam folder, or <button type="button" className="pt-link" onClick={() => { setStep("email"); setCode(""); }}>try another address</button>. If none of yours work, call us and we&apos;ll add it to your account.</p>
        </form>
      )}
      {error && <p className="pt-note bad" role="alert">{error}</p>}
    </div>
  );
}

function Home({ me, reload }: { me: Me; reload: () => void }) {
  const [showPaid, setShowPaid] = useState(false);
  const staff = me.viewer.staff;
  return (
    <PortalFrame company={me.company} right={<div className="pt-who">{!staff && <span className="pt-muted">{me.viewer.email}</span>}<SignOut staff={staff} /></div>}>
      {staff && <StaffBanner name={me.customers[0]?.name ?? "this customer"} />}
      {me.customers.map((cust) => {
        const open = me.invoices.filter((i) => i.customerId === cust.id && i.status !== "paid");
        const paid = me.invoices.filter((i) => i.customerId === cust.id && i.status === "paid");
        return (
          <section key={cust.id} className="pt-section">
            <div className="pt-card pt-summary">
              <div>
                <div className="pt-label">{cust.name} · account #{cust.number}</div>
                <div className="pt-amount">{formatMoney(cust.balanceCents)}</div>
                <div className="pt-sub">{cust.balanceCents <= 0 ? "You're all paid up. Thank you!" : cust.overdueCents > 0 ? <span className="pt-bad">{formatMoney(cust.overdueCents)} is past due</span> : "Current balance"}</div>
                {cust.creditCents > 0 && <div className="pt-sub pt-credit">{formatMoney(cust.creditCents)} credit on your account, used on your next invoice</div>}
                {cust.prepaidCents > 0 && <div className="pt-sub pt-credit">{formatMoney(cust.prepaidCents)} prepaid, used on your next invoices</div>}
              </div>
            </div>
            <h2 className="pt-h2">{open.length ? "Invoices to pay" : "No open invoices"}</h2>
            <OpenInvoices open={open} payments={me.payments as PortalPayments} canPay={me.payments.enabled && !staff} onPaid={reload} />
            {paid.length > 0 && (
              <>
                <button className="pt-link" onClick={() => setShowPaid(!showPaid)}>{showPaid ? "Hide" : "Show"} paid invoices ({paid.length})</button>
                {showPaid && (
                  <ul className="pt-list">
                    {paid.map((i) => (
                      <li key={i.id}><Link href={`/portal/invoices/${i.id}`} className="pt-row"><span><strong>Invoice {i.number}</strong> <span className="pt-muted">· {longDate(i.issueDate)}</span></span><span className="pt-right">{formatMoney(i.totalCents)} <StatusPill inv={i} /></span></Link></li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {me.estimates.some((x) => x.customerId === cust.id) && (
              <>
                <h2 className="pt-h2">Estimates</h2>
                <ul className="pt-list">
                  {me.estimates.filter((x) => x.customerId === cust.id).map((x) => (
                    <li key={x.id}>
                      <a href={x.link ?? "#"} className="pt-row">
                        <span><strong>{x.title || `Estimate ${x.number}`}</strong> <span className={`pt-pill ${x.status === "accepted" ? "ok" : x.status === "declined" ? "" : "warn"}`}>{x.status === "sent" ? "Waiting for you" : x.status === "changes" ? "Changes asked for" : x.status === "accepted" ? "Accepted" : "Declined"}</span>
                          <span className="pt-muted block">Estimate {x.number} · {longDate(x.issueDate)}</span></span>
                        <span className="pt-right"><strong>{formatMoney(x.totalCents)}</strong>{(x.status === "sent" || x.status === "changes") && !staff && <span className="pt-btn primary small">View</span>}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Prepayments me={me} customerId={cust.id} staff={staff} onPaid={reload} />
            {me.payments.enabled && <PortalPaymentMethods customerId={cust.id} methods={cust.paymentMethods} autopay={cust.autopay} staff={staff} testMode={me.payments.testMode} onChange={reload} />}
            <Details cust={cust} staff={staff} onSaved={reload} />
          </section>
        );
      })}
      {me.paymentHistory.length > 0 && (
        <section className="pt-section">
          <h2 className="pt-h2">Payments</h2>
          <ul className="pt-list">
            {me.paymentHistory.map((p) => (
              <li key={p.id} className="pt-row static">
                <span>{longDate(p.receivedOn)} · {methodText(p)}{p.invoiceNumber ? <span className="pt-muted"> · invoice {p.invoiceNumber}</span> : null}</span>
                <span className="pt-right"><strong>{formatMoney(p.amountCents)}</strong>{p.status === "pending" && <span className="pt-muted block">clearing</span>}{(p.refundedCents ?? 0) > 0 && <span className="pt-muted block">{(p.refundedCents ?? 0) >= p.amountCents ? "refunded" : `${formatMoney(p.refundedCents!)} refunded`}</span>}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PortalFrame>
  );
}

/**
 * The invoices a customer still owes on. With more than one that can be paid, each has a tick box
 * (all ticked to start) and one Pay button pays the ticked ones together, in one payment; a single
 * invoice keeps its own Pay button, which opens it.
 */
function OpenInvoices({ open, payments, canPay, onPaid }: { open: Me["invoices"]; payments: PortalPayments; canPay: boolean; onPaid: () => void }) {
  /** The invoices left unticked. */
  const [skipped, setSkipped] = useState<string[]>([]);
  const payable = open.filter((i) => i.pendingCents < i.balanceCents);
  const together = canPay && payable.length > 1;
  // Once the combined Pay box has been on the page it stays, so its thank-you isn't lost when everything is paid.
  const [shown, setShown] = useState(false);
  useEffect(() => { if (together) setShown(true); }, [together]);
  const picked = payable.filter((i) => !skipped.includes(i.id));
  const pickedCents = picked.reduce((s, i) => s + i.balanceCents - i.pendingCents, 0);
  return (
    <>
      {together && <p className="pt-muted" style={{ margin: "0 0 8px" }}>Tick the invoices you want to pay. They&apos;re paid together, in one payment.</p>}
      {open.length > 0 && (
        <ul className="pt-list">
          {open.map((i) => (
            <li key={i.id} className={together ? "pt-picked" : undefined}>
              {together && <input type="checkbox" className="pt-tick" checked={picked.some((x) => x.id === i.id)} disabled={i.pendingCents >= i.balanceCents}
                onChange={(e) => setSkipped(e.target.checked ? skipped.filter((x) => x !== i.id) : [...skipped, i.id])} aria-label={`Pay invoice ${i.number}`} />}
              <Link href={`/portal/invoices/${i.id}`} className="pt-row">
                <span>
                  <strong>Invoice {i.number}</strong> <StatusPill inv={i} />
                  <span className="pt-muted block">{longDate(i.issueDate)}{i.serviceAddress ? ` · ${i.serviceAddress}` : ""}</span>
                </span>
                <span className="pt-right">
                  <strong>{formatMoney(i.balanceCents)}</strong>
                  <span className={`block ${i.overdue ? "pt-bad" : "pt-muted"}`}>due {longDate(i.dueDate)}</span>
                  {canPay && !together && i.pendingCents < i.balanceCents && <span className="pt-btn primary small">Pay</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(together || shown) && (
        <StripePay key={picked.map((i) => i.id).join(",")} payable={together && pickedCents > 0} dueCents={pickedCents} payments={payments} canSave
          start={(o) => api("/portal/pay", { body: { invoiceIds: picked.map((i) => i.id), save: o.save } })}
          confirm={(paymentIntentId) => api("/portal/pay/confirm", { body: { paymentIntentId } })}
          onConfirmed={() => onPaid()} />
      )}
    </>
  );
}

/** Prepayments: what's prepaid, offers from the office to pay, and prepaying any amount. */
function Prepayments({ me, customerId, staff, onPaid }: { me: Me; customerId: string; staff: boolean; onPaid: () => void }) {
  const mine = me.prepayments.filter((p) => p.customer.id === customerId);
  const [paying, setPaying] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const [amount, setAmount] = useState("");
  const created = useRef<string | null>(null);
  const online = me.payments.enabled;
  if (!mine.length && !online) return null;
  const pays = me.payments as PortalPayments;
  const cents = Math.round(Number(amount) * 100);
  return (
    <>
      <h2 className="pt-h2">Prepayments</h2>
      {mine.length > 0 && (
        <ul className="pt-list">
          {mine.map((p) => (
            <li key={p.id}>
              <div className="pt-row static">
                <span>
                  <strong>{p.description}</strong> <span className="pt-muted">· PP-{p.number}</span>
                  <span className="pt-muted block">
                    {p.status === "requested" ? <>Offer: {formatMoney(p.amountCents)}{p.discountCents ? ` (you save ${formatMoney(p.discountCents)})` : ""}</>
                      : p.status === "pending" ? "Bank payment clearing"
                      : <>Paid {p.receivedOn ? longDate(p.receivedOn) : ""}{p.methodDetail ? ` · ${p.methodDetail}` : ""}</>}
                  </span>
                </span>
                <span className="pt-right">
                  {p.status === "open" ? <><strong>{formatMoney(p.cashLeftCents)}</strong><span className="pt-muted block">left of {formatMoney(p.amountCents)}</span></>
                    : p.status === "closed" ? <span className="pt-pill gray">Closed</span>
                    : <strong>{formatMoney(p.amountCents)}</strong>}
                  {p.status === "requested" && online && !staff && paying !== p.id && <button className="pt-btn primary small" onClick={() => setPaying(p.id)}>Pay</button>}
                </span>
              </div>
              {paying === p.id && (
                <div style={{ padding: "0 14px 12px" }}>
                  <StripePay payable dueCents={p.amountCents} payments={pays}
                    start={() => api(`/portal/prepayments/${p.id}/pay`, { method: "POST" })}
                    confirm={(paymentIntentId) => api(`/portal/prepayments/${p.id}/pay/confirm`, { body: { paymentIntentId } })}
                    onConfirmed={() => onPaid()} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {online && !staff && (
        <div className="pt-card">
          {!own ? (
            <button className="pt-link" style={{ margin: 0 }} onClick={() => setOwn(true)}>Prepay toward future services</button>
          ) : (
            <>
              <p className="pt-muted" style={{ marginTop: 0 }}>Pay ahead any amount; it pays your next invoices as the work is done.</p>
              <label className="pt-field">Amount ($)<input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); created.current = null; }} placeholder="100.00" /></label>
              {cents >= 500 && (
                <StripePay key={cents} payable dueCents={cents} payments={pays}
                  start={async () => { const r = await api<any>("/portal/prepay", { body: { customerId, amountCents: cents } }); created.current = r.prepaymentId; return r; }}
                  confirm={(paymentIntentId) => api(`/portal/prepayments/${created.current}/pay/confirm`, { body: { paymentIntentId } })}
                  onConfirmed={() => onPaid()} />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Details({ cust, staff, onSaved }: { cust: Me["customers"][number]; staff: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ phone: cust.phone ?? "", billingStreet: cust.billing.street ?? "", billingCity: cust.billing.city ?? "", billingState: cust.billing.state ?? "OK", billingZip: cust.billing.zip ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addr = [cust.billing.street, [cust.billing.city, [cust.billing.state, cust.billing.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  return (
    <div className="pt-card">
      <div className="pt-row static" style={{ padding: 0 }}>
        <h2 className="pt-h2" style={{ margin: 0 }}>Your details</h2>
        {!staff && !editing && <button className="pt-link" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {editing ? (
        <form onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null);
          try { await api(`/portal/customers/${cust.id}`, { method: "PUT", body: f }); setEditing(false); onSaved(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>
          <label className="pt-field">Phone<input type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="pt-field">Billing address<input autoComplete="address-line1" value={f.billingStreet} onChange={(e) => setF({ ...f, billingStreet: e.target.value })} placeholder="Street" /></label>
          <div className="pt-three">
            <label className="pt-field">City<input autoComplete="address-level2" value={f.billingCity} onChange={(e) => setF({ ...f, billingCity: e.target.value })} /></label>
            <label className="pt-field">State<input autoComplete="address-level1" maxLength={2} value={f.billingState} onChange={(e) => setF({ ...f, billingState: e.target.value.toUpperCase() })} /></label>
            <label className="pt-field">ZIP<input autoComplete="postal-code" inputMode="numeric" value={f.billingZip} onChange={(e) => setF({ ...f, billingZip: e.target.value })} /></label>
          </div>
          <div className="pt-actions"><button className="pt-btn primary" disabled={busy}>Save</button><button type="button" className="pt-btn" onClick={() => setEditing(false)}>Cancel</button></div>
          {error && <p className="pt-note bad" role="alert">{error}</p>}
          <p className="pt-muted small">To change your email address or service, call or email us.</p>
        </form>
      ) : (
        <dl className="pt-facts">
          <dt>Email</dt><dd>{cust.email ?? "—"}</dd>
          <dt>Phone</dt><dd>{cust.phone ?? "—"}</dd>
          <dt>Billing address</dt><dd>{addr || "Same as your service address"}</dd>
          {cust.properties.length > 0 && <><dt>{cust.properties.length === 1 ? "Service address" : "Service addresses"}</dt><dd>{cust.properties.map((p) => <div key={p.id}>{p.address}</div>)}</dd></>}
        </dl>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><Portal /></Suspense>;
}

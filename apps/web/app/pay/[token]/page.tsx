"use client";
import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { formatMoney } from "@crewdesk/shared";
import { ApiError, API_URL, api } from "@/lib/api";
import { InvoiceView, PayBox, PortalFrame, StripePay, longDate, type PortalCompany, type PortalInvoice, type PortalPayments } from "@/components/portal";

/** Everything the customer still owes, as far as the link shows it. */
type AccountInvoice = { id: string; number: number | null; issueDate: string; dueDate: string; balanceCents: number; payableCents: number; overdue: boolean; linked: boolean };
type Account = { totalDueCents: number; invoices: AccountInvoice[] };
type Data = { company: PortalCompany; payments: PortalPayments; invoice: PortalInvoice; account: Account };
type Confirmed = { status?: string; ignored?: boolean; invoice: PortalInvoice; account: Account };

/**
 * The "Pay online" link in an invoice email, for 30 days after it was sent, with no sign-in. It
 * opens that invoice. When the customer owes on others too, it starts with the total due on the
 * account: they tick the invoices to pay and pay them in one payment (View shows any of them).
 */
export default function PayLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ message: string; expired: boolean } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** The invoices left unticked (everything with a balance is ticked to start). */
  const [skipped, setSkipped] = useState<string[]>([]);
  // Once the account box has been on the page it stays, so its thank-you isn't lost when everything is paid.
  const hadAccount = useRef(false);
  useEffect(() => {
    api<Data>(`/pay/${token}`).then(setData, (e) => setError({ message: (e as Error).message, expired: e instanceof ApiError && e.status === 410 }));
  }, [token]);
  if (error) return (
    <PortalFrame company={null}>
      <div className="pt-card pt-signin">
        <h1 className="pt-h1">{error.expired ? "This link has expired" : "Link not found"}</h1>
        <p className="pt-note bad">{error.message}</p>
        <Link className="pt-btn primary big" href="/portal">Sign in to see your invoices</Link>
      </div>
    </PortalFrame>
  );
  if (!data) return <PortalFrame company={null}><p className="pt-muted">Loading…</p></PortalFrame>;
  const inv = data.invoice, account = data.account;
  const here = `/pay/${token}/invoices/${inv.id}`;
  const owing = account.invoices.filter((i) => i.balanceCents > 0);
  if (owing.length > 1 || owing.some((i) => i.id !== inv.id)) hadAccount.current = true;
  const picked = owing.filter((i) => i.payableCents > 0 && !skipped.includes(i.id));
  const pickedCents = picked.reduce((s, i) => s + i.payableCents, 0);
  /** Shows another of their invoices in place of the one on screen. */
  const open = (id: string) => {
    setOpening(id); setOpenError(null);
    api<{ invoice: PortalInvoice; account: Account }>(`/pay/${token}/invoices/${id}`)
      .then((next) => setData({ ...data, ...next }), (e) => setOpenError((e as Error).message))
      .finally(() => setOpening(null));
  };
  return (
    <PortalFrame company={data.company} right={<Link href={`/portal?c=${data.company.id}`} className="pt-link">My invoices</Link>}>
      {hadAccount.current && (
        <div className="pt-card pt-account" aria-label="Your account">
          <div className="pt-summary">
            <div>
              <div className="pt-label">Total amount due</div>
              <div className="pt-amount">{formatMoney(account.totalDueCents)}</div>
              <div className="pt-sub">
                {owing.length === 0 ? "Everything is paid. Thank you!"
                  : data.payments.enabled ? "Tick the invoices you want to pay. They're paid together, in one payment."
                  : `${owing.length} invoice${owing.length === 1 ? "" : "s"} with a balance.`}
              </div>
            </div>
          </div>
          {owing.length > 0 && (
            <ul className="pt-list">
              {owing.map((i) => (
                <li key={i.id}>
                  <div className="pt-row">
                    <label className="pt-pick">
                      {data.payments.enabled && <input type="checkbox" checked={picked.some((x) => x.id === i.id)} disabled={i.payableCents <= 0}
                        onChange={(e) => setSkipped(e.target.checked ? skipped.filter((x) => x !== i.id) : [...skipped, i.id])} aria-label={`Pay invoice ${i.number}`} />}
                      <span><strong>Invoice {i.number}</strong> <span className="pt-muted">· due {longDate(i.dueDate)}{i.overdue ? " (past due)" : ""}{i.payableCents < i.balanceCents ? " · a bank payment is on its way" : ""}</span></span>
                    </label>
                    <span className="pt-row-end">
                      <strong>{formatMoney(i.balanceCents)}</strong>
                      {i.id === inv.id ? <span className="pt-muted">shown below</span>
                        : <button type="button" className="pt-btn" disabled={!!opening} onClick={() => open(i.id)}>{opening === i.id ? "Opening…" : "View"}</button>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {openError && <p className="pt-note bad">{openError}</p>}
          {/* One payment for the ticked invoices. Changing the ticks starts the payment box over. */}
          <StripePay key={picked.map((i) => i.id).join(",")} payable={data.payments.enabled && pickedCents > 0} dueCents={pickedCents} payments={data.payments} canSave
            start={(o) => api(`/pay/${token}/account/pay`, { body: { invoiceIds: picked.map((i) => i.id), save: o.save } })}
            confirm={(paymentIntentId) => api<Confirmed>(`/pay/${token}/account/confirm`, { body: { paymentIntentId } })}
            onConfirmed={(r: Confirmed | undefined) => { if (r?.invoice) setData((cur) => (cur ? { ...cur, invoice: r.invoice, account: r.account } : cur)); }} />
        </div>
      )}
      {/* With the account box above, paying is done there (one ticked invoice is an ordinary payment for it), so there's one Pay button on the page. */}
      <InvoiceView key={inv.id} inv={inv} pdfHref={`${API_URL}${here}/pdf`}
        pay={hadAccount.current ? null : <PayBox inv={inv} payments={data.payments}
          start={(o) => api(`${here}/pay`, { body: { save: o.save } })}
          confirm={async (paymentIntentId) => {
            const done = await api<Confirmed>(`${here}/confirm`, { body: { paymentIntentId } });
            setData((cur) => (cur ? { ...cur, account: done.account } : cur));
            return done;
          }}
          onPaid={(invoice) => setData((cur) => (cur ? { ...cur, invoice } : cur))} />} />
    </PortalFrame>
  );
}

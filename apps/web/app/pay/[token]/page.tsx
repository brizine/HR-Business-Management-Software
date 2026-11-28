"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { formatMoney } from "@crewdesk/shared";
import { ApiError, API_URL, api } from "@/lib/api";
import { InvoiceView, PayBox, PortalFrame, longDate, type PortalCompany, type PortalInvoice, type PortalPayments } from "@/components/portal";

/** Everything the customer still owes, as far as the link shows it. */
type Account = { totalDueCents: number; invoices: { id: string; number: number | null; issueDate: string; dueDate: string; balanceCents: number; overdue: boolean; linked: boolean }[] };
type Data = { company: PortalCompany; payments: PortalPayments; invoice: PortalInvoice; account: Account };

/**
 * The "Pay online" link in an invoice email, for 30 days after it was sent, with no sign-in. It
 * opens that invoice, and when the customer owes on others too it shows the total due on the
 * account and lets each one be opened and paid from here.
 */
export default function PayLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ message: string; expired: boolean } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
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
  const others = account.invoices.filter((i) => i.balanceCents > 0);
  /** Shows another of their invoices in place of the one on screen. */
  const open = (id: string) => {
    setOpening(id); setOpenError(null);
    api<{ invoice: PortalInvoice; account: Account }>(`/pay/${token}/invoices/${id}`)
      .then((next) => { setData({ ...data, ...next }); window.scrollTo({ top: 0 }); }, (e) => setOpenError((e as Error).message))
      .finally(() => setOpening(null));
  };
  return (
    <PortalFrame company={data.company} right={<Link href={`/portal?c=${data.company.id}`} className="pt-link">My invoices</Link>}>
      {(others.length > 1 || others.some((i) => i.id !== inv.id)) && (
        <div className="pt-card pt-account" aria-label="Your account">
          <div className="pt-summary">
            <div>
              <div className="pt-label">Total amount due</div>
              <div className="pt-amount">{formatMoney(account.totalDueCents)}</div>
              <div className="pt-sub">{others.length} invoice{others.length === 1 ? "" : "s"} with a balance. Each is paid on its own: open one, pay it, then the next.</div>
            </div>
          </div>
          <ul className="pt-list">
            {others.map((i) => (
              <li key={i.id}>
                <div className="pt-row">
                  <span><strong>Invoice {i.number}</strong> <span className="pt-muted">· due {longDate(i.dueDate)}{i.overdue ? " (past due)" : ""}</span></span>
                  <span className="pt-row-end">
                    <strong>{formatMoney(i.balanceCents)}</strong>
                    {i.id === inv.id ? <span className="pt-muted">shown below</span>
                      : <button type="button" className="pt-btn" disabled={!!opening} onClick={() => open(i.id)}>{opening === i.id ? "Opening…" : "View and pay"}</button>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {openError && <p className="pt-note bad">{openError}</p>}
        </div>
      )}
      <InvoiceView key={inv.id} inv={inv} pdfHref={`${API_URL}${here}/pdf`}
        pay={<PayBox inv={inv} payments={data.payments}
          start={(o) => api(`${here}/pay`, { body: { save: o.save } })}
          confirm={async (paymentIntentId) => {
            const done = await api<{ status?: string; ignored?: boolean; invoice: PortalInvoice; account: Account }>(`${here}/confirm`, { body: { paymentIntentId } });
            setData((cur) => (cur ? { ...cur, account: done.account } : cur));
            return done;
          }}
          onPaid={(invoice) => setData((cur) => (cur ? { ...cur, invoice } : cur))} />} />
    </PortalFrame>
  );
}

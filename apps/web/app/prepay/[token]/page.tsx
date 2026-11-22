"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { formatMoney } from "@crewdesk/shared";
import { ApiError, api } from "@/lib/api";
import { PortalFrame, StripePay, longDate, type PortalCompany, type PortalPayments } from "@/components/portal";

type Prepay = {
  id: string; number: number; description: string; lines: { description: string; quantity: number; unitPriceCents: number }[];
  coversCents: number; discountCents: number; amountCents: number; status: string; receivedOn: string | null; methodDetail: string | null; cashLeftCents: number;
  customer: { id: string; number: number; name: string }; serviceAddress: string | null;
};
type Data = { company: PortalCompany; payments: PortalPayments; prepayment: Prepay };

/** The prepay link from the office: what it covers, the discount, and paying it by card or bank account. */
export default function PrepayLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ message: string; expired: boolean } | null>(null);
  useEffect(() => {
    api<Data>(`/prepay/${token}`).then(setData, (e) => setError({ message: (e as Error).message, expired: e instanceof ApiError && e.status === 410 }));
  }, [token]);
  if (error) return (
    <PortalFrame company={null}>
      <div className="pt-card pt-signin">
        <h1 className="pt-h1">{error.expired ? "This link has expired" : "Link not found"}</h1>
        <p className="pt-note bad">{error.message}</p>
        <Link className="pt-btn primary big" href="/portal">Sign in to see your account</Link>
      </div>
    </PortalFrame>
  );
  if (!data) return <PortalFrame company={null}><p className="pt-muted">Loading…</p></PortalFrame>;
  const p = data.prepayment;
  const paid = p.status === "open" || p.status === "closed";
  return (
    <PortalFrame company={data.company} right={<Link href={`/portal?c=${data.company.id}`} className="pt-link">My account</Link>}>
      <div className="pt-card pt-summary">
        <div>
          <div className="pt-label">Prepay · {p.customer.name}</div>
          <div className="pt-amount">{formatMoney(p.amountCents)}</div>
          <div className="pt-sub">{paid ? `Paid ${p.receivedOn ? longDate(p.receivedOn) : ""}. Thank you!` : p.status === "pending" ? "Your bank payment is on its way." : p.description}</div>
          {p.discountCents > 0 && !paid && <div className="pt-sub pt-credit">You save {formatMoney(p.discountCents)} by paying ahead</div>}
        </div>
        <span className={`pt-pill ${paid ? "ok" : p.status === "pending" ? "info" : "warn"}`}>{paid ? "Paid" : p.status === "pending" ? "Clearing" : "Prepay offer"}</span>
      </div>
      {/* Kept on the page after paying, so its thank-you stays. */}
      {(
        <StripePay payable={!paid && p.status !== "pending"} dueCents={p.amountCents} payments={data.payments}
          start={() => api(`/prepay/${token}/pay`, { method: "POST" })}
          confirm={(paymentIntentId) => api(`/prepay/${token}/confirm`, { body: { paymentIntentId } })}
          onConfirmed={(r) => r?.prepayment && setData({ ...data, prepayment: r.prepayment })} />
      )}
      <div className="pt-card">
        <dl className="pt-facts">
          <dt>What it covers</dt><dd>{p.description}</dd>
          <dt>Customer</dt><dd>{p.customer.name} <span className="pt-muted">· account #{p.customer.number}</span></dd>
          {p.serviceAddress && <><dt>Service address</dt><dd>{p.serviceAddress}</dd></>}
        </dl>
        {p.lines.length > 0 && (
          <table className="pt-lines">
            <thead><tr><th>Service</th><th className="num">Amount</th></tr></thead>
            <tbody>{p.lines.map((l, i) => <tr key={i}><td>{l.description}{l.quantity !== 1 && <div className="pt-muted">{l.quantity} × {formatMoney(l.unitPriceCents)}</div>}</td><td className="num">{formatMoney(Math.round(l.quantity * l.unitPriceCents))}</td></tr>)}</tbody>
            <tfoot>
              {p.discountCents > 0 && <><tr><td>Total</td><td className="num">{formatMoney(p.coversCents)}</td></tr><tr><td>Prepay discount</td><td className="num">−{formatMoney(p.discountCents)}</td></tr></>}
              <tr className="total"><td>You pay</td><td className="num">{formatMoney(p.amountCents)}</td></tr>
            </tfoot>
          </table>
        )}
        <p className="pt-muted small">Your prepayment pays your invoices as the work is done; you can see what&apos;s left any time when you sign in.</p>
      </div>
    </PortalFrame>
  );
}

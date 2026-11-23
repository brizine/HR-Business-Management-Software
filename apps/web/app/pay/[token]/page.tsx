"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { ApiError, API_URL, api } from "@/lib/api";
import { InvoiceView, PayBox, PortalFrame, type PortalCompany, type PortalInvoice, type PortalPayments } from "@/components/portal";

type Data = { company: PortalCompany; payments: PortalPayments; invoice: PortalInvoice };

/** The "Pay online" link in an invoice email: one invoice, no sign-in, for 30 days after it was sent. */
export default function PayLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<{ message: string; expired: boolean } | null>(null);
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
  return (
    <PortalFrame company={data.company} right={<Link href={`/portal?c=${data.company.id}`} className="pt-link">My invoices</Link>}>
      <InvoiceView inv={data.invoice} pdfHref={`${API_URL}/pay/${token}/pdf`}
        pay={<PayBox inv={data.invoice} payments={data.payments}
          start={(o) => api(`/pay/${token}/pay`, { body: { save: o.save } })}
          confirm={(paymentIntentId) => api(`/pay/${token}/confirm`, { body: { paymentIntentId } })}
          onPaid={(invoice) => setData({ ...data, invoice })} />} />
    </PortalFrame>
  );
}

"use client";
import { use, useEffect, useState } from "react";
import { ApiError, API_URL, api } from "@/lib/api";
import { BackHome, InvoiceView, PayBox, PortalFrame, SignOut, StaffBanner, portalApi } from "@/components/portal";

/** One invoice in the portal, with the Pay button. */
export default function PortalInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Awaited<ReturnType<typeof portalApi.invoice>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    portalApi.invoice(id).then(setData, (e) => {
      if (e instanceof ApiError && e.status === 401) window.location.href = "/portal";
      else setError((e as Error).message);
    });
  }, [id]);
  if (error) return <PortalFrame company={null}><BackHome /><div className="pt-card"><p className="pt-note bad">{error}</p></div></PortalFrame>;
  if (!data) return <PortalFrame company={null}><p className="pt-muted">Loading…</p></PortalFrame>;
  const staff = data.viewer.staff;
  return (
    <PortalFrame company={data.company} right={<div className="pt-who"><SignOut staff={staff} /></div>}>
      {staff && <StaffBanner name={data.invoice.customer.name} />}
      <BackHome />
      <InvoiceView inv={data.invoice} pdfHref={`${API_URL}/portal/invoices/${id}/pdf`}
        pay={staff ? null : (
          <PayBox inv={data.invoice} payments={data.payments}
            start={() => api(`/portal/invoices/${id}/pay`, { method: "POST" })}
            confirm={(paymentIntentId) => api(`/portal/invoices/${id}/pay/confirm`, { body: { paymentIntentId } })}
            onPaid={(invoice) => setData({ ...data, invoice })} />
        )} />
    </PortalFrame>
  );
}

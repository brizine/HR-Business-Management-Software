"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { InvoiceFields, invoiceBody, invoiceFormValue } from "@/components/invoices";

/** A new invoice; from a customer's page it starts with that customer (?customerId=…). */
export default function NewInvoice() {
  const router = useRouter();
  const [value, setValue] = useState(invoiceFormValue());
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("customerId");
    if (id) api<any>(`/customers/${id}`).then((c) => setValue((v) => ({ ...v, customer: { id: c.id, name: c.name } })), () => {});
  }, []);
  const save = (thenSend: boolean) => {
    const { body, error: problem } = invoiceBody(value);
    if (!body) return setError(problem ?? "Check the invoice");
    run(async () => {
      const inv = await api<{ id: string }>("/invoices", { body });
      router.push(`/invoices/${inv.id}${thenSend ? "?send=1" : ""}`);
    });
  };
  return (
    <>
      <PageHead title="New invoice" crumbs={[{ label: "Invoices", href: "/invoices" }, { label: "New invoice" }]} />
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        <InvoiceFields value={value} onChange={setValue} />
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy}>Save and send…</button>
          <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>Save as draft</button>
          <Link className="btn" href="/invoices">Cancel</Link>
        </div>
      </form>
    </>
  );
}

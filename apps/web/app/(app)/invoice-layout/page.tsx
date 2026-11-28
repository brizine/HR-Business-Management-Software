"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { InvoiceLayoutEditor } from "@/components/invoice-layout-editor";
import { SettingsTabs } from "@/components/settings-tabs";
import { PageHead } from "@/components/ui";

/** The invoice layout editor (admins in Customers & billing): what the invoice shows, what it's called and how it looks. */
export default function InvoiceLayoutPage() {
  const { can } = useAuth();
  return (
    <>
      <SettingsTabs />
      <PageHead title="Invoice layout" sub="What your invoices show, what each part is called, the order of the page and how it looks. The same layout is used for emailed invoices, the ones you print to mail, and the copies customers download.">
        <Link className="btn" href="/invoices" title="Back to the invoices">Invoices</Link>
      </PageHead>
      {can("admin", "customers") ? <InvoiceLayoutEditor /> : <p className="muted">Only admins in Customers &amp; billing can change the invoice layout.</p>}
    </>
  );
}

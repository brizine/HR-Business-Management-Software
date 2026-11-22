"use client";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { AccountingCard } from "@/components/accounting";
import { StripeCard } from "@/components/stripe-settings";

/** Integrations: connections to other systems: Bigcapital (accounting) and Stripe (online payments). */
export default function Integrations() {
  const { can } = useAuth();
  return (
    <>
      <SettingsTabs />
      <PageHead title="Integrations" sub="Connections to the other systems Crewdesk works with." />
      <h2 style={{ fontSize: 16, margin: "4px 0 8px" }}>Accounting (Bigcapital)</h2>
      <p className="muted" style={{ marginTop: 0 }}>Your books are kept in Bigcapital. Crewdesk sends it customers, invoices and payments as they happen, plus approved payroll and repair order costs.</p>
      {can("admin", "payroll") ? <AccountingCard /> : <p className="muted">Only payroll admins can see accounting.</p>}
      <h2 style={{ fontSize: 16, margin: "20px 0 8px" }}>Online payments (Stripe)</h2>
      {can("admin", "customers") ? <StripeCard /> : <p className="muted">Only Customers &amp; billing admins can see payment settings.</p>}
    </>
  );
}

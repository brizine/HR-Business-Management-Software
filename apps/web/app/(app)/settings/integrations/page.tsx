"use client";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { AccountingCard } from "@/components/accounting";

/** Integrations: connections to other systems. Today that's Bigcapital (accounting). */
export default function Integrations() {
  const { can } = useAuth();
  return (
    <>
      <SettingsTabs />
      <PageHead title="Integrations" sub="Connections to the other systems Crewdesk works with." />
      <h2 style={{ fontSize: 16, margin: "4px 0 8px" }}>Accounting (Bigcapital)</h2>
      <p className="muted" style={{ marginTop: 0 }}>Your books are kept in Bigcapital. Crewdesk sends it approved payroll and work order costs.</p>
      {can("admin", "payroll") ? <AccountingCard /> : <p className="muted">Only payroll admins can see accounting.</p>}
    </>
  );
}

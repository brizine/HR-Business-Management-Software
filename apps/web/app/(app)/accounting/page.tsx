"use client";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { AccountingCard } from "@/components/accounting";

/** Accounting: the Bigcapital connection, and what's been sent to it. */
export default function Accounting() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Accounting" sub="Your books are kept in Bigcapital. Crewdesk sends it approved payroll and work order costs." />
      {can("admin", "payroll") ? <AccountingCard /> : <p className="muted">Only payroll admins can see accounting.</p>}
    </>
  );
}

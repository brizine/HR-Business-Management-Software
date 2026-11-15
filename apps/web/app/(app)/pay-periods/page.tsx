"use client";
import Link from "next/link";
import { PayPeriodList } from "@/components/pay-schedule";
import { useAuth } from "@/lib/auth";
import { PageHead } from "@/components/ui";

/** Approvers' list of pay periods (admins also see it on the Payroll page). */
export default function PayPeriods() {
  const { can } = useAuth();
  return (
    <>
      <PageHead title="Payroll Approval" sub="When a pay period ends, review everyone's hours and approve them before payday.">
        {can("admin", "payroll") && <Link href="/payroll" className="btn">← Back to Payroll</Link>}
      </PageHead>
      <PayPeriodList />
    </>
  );
}

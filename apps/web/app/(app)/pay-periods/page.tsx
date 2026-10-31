"use client";
import { PayPeriodList } from "@/components/pay-schedule";
import { PageHead } from "@/components/ui";

/** Approvers' list of pay periods (admins also see it on the Payroll page). */
export default function PayPeriods() {
  return (
    <>
      <PageHead title="Pay approvals" sub="When a pay period ends, review everyone's hours and approve them before payday." />
      <PayPeriodList />
    </>
  );
}

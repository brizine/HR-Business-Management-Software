"use client";
import { ReportsHub, type ReportLink } from "@/components/reports-hub";

const REPORTS: ReportLink[] = [
  { title: "Fuel & Costs", about: "Fuel, maintenance and cost per mile for every asset, plus lifetime cost of ownership.", href: "/fleet/costs", min: "manager", area: "fleet" },
  { title: "Work Orders", about: "Open and completed repairs, parts and labor, by asset.", href: "/work-orders", min: "manager", area: "fleet" },
  { title: "Inspections", about: "Vehicle and equipment inspections and the problems found.", href: "/inspections", min: "manager", area: "fleet" },
];

/** Operations reports. Revenue, receivables, customer and chemical reports join here with the customer features. */
export default function OperationsReports() {
  return (
    <ReportsHub
      title="Operations Reports"
      sub="Fleet and equipment reports"
      reports={REPORTS}
      note="Revenue, money owed, customer, sales and chemical reports will appear here as the customer features are added."
    />
  );
}

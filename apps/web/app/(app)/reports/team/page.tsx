"use client";
import { ReportsHub, type ReportLink } from "@/components/reports-hub";

const REPORTS: ReportLink[] = [
  { title: "Attendance", about: "Tardies, absences and points for each person, with the rules they're scored on.", href: "/attendance?tab=report", min: "manager", area: "time" },
  { title: "Timesheets", about: "Hours worked, overtime and missed punches; approve timesheets.", href: "/time", min: "manager", area: "time" },
  { title: "Time Off", about: "Requests and balances for everyone.", href: "/time-off", min: "manager", area: "timeoff" },
  { title: "Training Progress", about: "Who has finished, started or is overdue on each course.", href: "/training", min: "manager", area: "training" },
  { title: "Payroll", about: "Hours by pay period, ready to export or send for payroll.", href: "/payroll", min: "admin", area: "payroll" },
];

/** Team reports: links to the people, time and pay reports already in Crewdesk. */
export default function TeamReports() {
  return <ReportsHub title="Team Reports" sub="People, time and pay reports" reports={REPORTS} />;
}

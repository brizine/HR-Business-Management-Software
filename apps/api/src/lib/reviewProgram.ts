import { and, eq, inArray, notInArray } from "drizzle-orm";
import { DEFAULT_REVIEW_PROGRAM, INACTIVE_STATUSES, nextReviewDue, type ReviewDue, type ReviewProgram } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employeeRecords, employees } from "../db/schema";
import { localParts } from "./tz";

export async function reviewProgramFor(companyId: string): Promise<ReviewProgram> {
  const [c] = await db.select({ p: companies.reviewProgram }).from(companies).where(eq(companies.id, companyId));
  return c?.p ?? DEFAULT_REVIEW_PROGRAM;
}

export interface ScheduledReview extends ReviewDue {
  employeeId: string;
  firstName: string;
  lastName: string;
  title: string | null;
  managerId: string | null;
}

/** Everyone active and the next review each rule says they're due (soonest first). */
export async function reviewSchedule(companyId: string, now = new Date()): Promise<{ program: ReviewProgram; today: string; due: ScheduledReview[]; noHireDate: { id: string; name: string }[] }> {
  const program = await reviewProgramFor(companyId);
  const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const today = localParts(now, c?.tz ?? "America/Chicago").date;
  const startedOn = program.startedOn ?? today;
  const staff = await db.select().from(employees).where(and(eq(employees.companyId, companyId), notInArray(employees.status, INACTIVE_STATUSES)));
  const ids = staff.map((e) => e.id);
  const reviews = ids.length
    ? await db.select({ employeeId: employeeRecords.employeeId, type: employeeRecords.type, date: employeeRecords.date }).from(employeeRecords)
        .where(and(eq(employeeRecords.companyId, companyId), eq(employeeRecords.kind, "review"), inArray(employeeRecords.employeeId, ids)))
    : [];
  const due: ScheduledReview[] = [];
  for (const e of staff) {
    const mine = reviews.filter((r) => r.employeeId === e.id);
    for (const rule of program.rules) {
      const next = nextReviewDue(rule, e, mine, startedOn, today);
      if (next) due.push({ ...next, employeeId: e.id, firstName: e.firstName, lastName: e.lastName, title: e.title, managerId: e.managerId });
    }
  }
  due.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.lastName.localeCompare(b.lastName));
  // Reviews counted from the hire date can't be scheduled without one.
  const needsHire = program.rules.some((r) => r.active && (r.schedule === "after_hire" || (r.anchor ?? "hire") !== "date"));
  const noHireDate = needsHire
    ? staff.filter((e) => !e.startDate && program.rules.some((r) => r.active && (!r.employmentTypes.length || r.employmentTypes.includes(e.employmentType as never))))
        .map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}` })).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return { program, today, due, noHireDate };
}

import { and, eq, gt, isNotNull, isNull, lt, lte, ne } from "drizzle-orm";
import { computeDue } from "@crewdesk/shared";
import { db } from "../db";
import { assets, companies, employees, maintenanceSchedules, notificationLog, onboardingTasks, shifts, timeEntries } from "../db/schema";
import { taskOwners } from "../routes/onboarding";
import { fmtTime, localParts } from "./tz";
import { notify, staffWithRole } from "./notify";

/** Hours on the clock after which we assume someone forgot to clock out. */
export const FORGOT_CLOCK_OUT_HOURS = 12;
const EXPIRY_WARNING_DAYS = 30;
/** Onboarding reminders go out from this local hour, so nobody is pinged at midnight. */
export const REMINDER_HOUR = 7;

/** How far ahead of a shift the reminder goes out. */
export const SHIFT_REMINDER_MINUTES = 60;

/** Records `key` and returns true the first time only; safe across multiple API instances. */
async function firstTime(companyId: string, key: string) {
  const rows = await db.insert(notificationLog).values({ key, companyId }).onConflictDoNothing().returning();
  return rows.length > 0;
}

/**
 * Time-based alerts nothing in a request would trigger. Idempotent: each
 * condition is announced once (per service interval, expiry date or entry).
 */
export async function runScheduledChecks(now = new Date()) {
  let sent = 0;

  // Preventive maintenance coming due or overdue: tell fleet managers and the assigned driver.
  const scheduleRows = await db
    .select({ schedule: maintenanceSchedules, asset: assets })
    .from(maintenanceSchedules)
    .innerJoin(assets, eq(assets.id, maintenanceSchedules.assetId));
  for (const { schedule: s, asset } of scheduleRows) {
    if (asset.status === "retired") continue;
    const due = computeDue(s, asset, now);
    if (due.status === "ok") continue;
    // Keyed on the last service so the alert re-arms after the next service.
    const key = `maint:${s.id}:${due.status}:${s.lastServiceDate}:${s.lastServiceOdometer}:${s.lastServiceHours}`;
    if (!(await firstTime(s.companyId, key))) continue;
    const managers = await staffWithRole(s.companyId, "manager");
    notify(s.companyId, [...managers, asset.assignedEmployeeId], {
      category: "fleet",
      title: `${asset.name}: ${s.name} ${due.status === "overdue" ? "overdue" : "due soon"}`,
      body: due.reasons.join(", "),
      link: { screen: "asset", id: asset.id },
    });
    sent++;
  }

  // Registration and insurance expiring soon.
  const cutoff = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const asset of await db.select().from(assets)) {
    if (asset.status === "retired") continue;
    for (const [label, date] of [
      ["Registration", asset.registrationExpires],
      ["Insurance", asset.insuranceExpires],
    ] as const) {
      if (!date || date > cutoff) continue;
      if (!(await firstTime(asset.companyId, `expiry:${asset.id}:${label}:${date}`))) continue;
      const expired = date < now.toISOString().slice(0, 10);
      notify(asset.companyId, await staffWithRole(asset.companyId, "manager"), {
        category: "fleet",
        title: `${asset.name}: ${label.toLowerCase()} ${expired ? "expired" : "expiring"}`,
        body: `${label} ${expired ? "expired" : "expires"} on ${date}.`,
        link: { screen: "asset", id: asset.id },
      });
      sent++;
    }
  }

  // Forgotten clock-outs: remind the employee and let their manager know.
  const stale = await db
    .select({ entry: timeEntries, employee: employees })
    .from(timeEntries)
    .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
    .where(and(isNull(timeEntries.clockOut), lt(timeEntries.clockIn, new Date(now.getTime() - FORGOT_CLOCK_OUT_HOURS * 3_600_000))));
  for (const { entry, employee } of stale) {
    if (!(await firstTime(entry.companyId, `clock:${entry.id}`))) continue;
    notify(entry.companyId, [employee.id], {
      category: "time",
      title: "Still clocked in?",
      body: `You've been on the clock for over ${FORGOT_CLOCK_OUT_HOURS} hours. Clock out, or ask your manager to fix your time.`,
      link: { screen: "time" },
    });
    notify(entry.companyId, [employee.managerId], {
      category: "time",
      title: `${employee.firstName} ${employee.lastName} may have forgotten to clock out`,
      body: `Clocked in for over ${FORGOT_CLOCK_OUT_HOURS} hours.`,
      link: { screen: "time" },
    });
    sent++;
  }

  // Shift reminders. Keyed on the start time so a rescheduled shift gets a fresh reminder.
  const upcoming = await db
    .select({ shift: shifts, tz: companies.timezone })
    .from(shifts)
    .innerJoin(companies, eq(companies.id, shifts.companyId))
    .where(
      and(
        eq(shifts.status, "published"),
        isNotNull(shifts.employeeId),
        gt(shifts.startsAt, now),
        lte(shifts.startsAt, new Date(now.getTime() + SHIFT_REMINDER_MINUTES * 60_000)),
      ),
    );
  for (const { shift, tz } of upcoming) {
    if (!(await firstTime(shift.companyId, `shift:${shift.id}:${shift.employeeId}:${shift.startsAt.toISOString()}`))) continue;
    notify(shift.companyId, [shift.employeeId], {
      category: "schedule",
      title: `Your shift starts at ${fmtTime(shift.startsAt, tz)}`,
      body: [shift.position, shift.location].filter(Boolean).join(" · ") || "Don't forget to clock in.",
      link: { screen: "time" },
    });
    sent++;
  }

  // Onboarding tasks due today or overdue: one message per person listing theirs.
  const open = await db
    .select({ task: onboardingTasks, employee: employees, tz: companies.timezone })
    .from(onboardingTasks)
    .innerJoin(employees, eq(employees.id, onboardingTasks.employeeId))
    .innerJoin(companies, eq(companies.id, onboardingTasks.companyId))
    .where(and(isNull(onboardingTasks.completedAt), isNotNull(onboardingTasks.dueDate), ne(employees.status, "inactive")));
  const digests = new Map<string, { companyId: string; due: string[]; overdue: string[] }>();
  for (const { task, employee, tz } of open) {
    const local = localParts(now, tz);
    if (task.dueDate! > local.date || local.minutes < REMINDER_HOUR * 60) continue;
    const state = task.dueDate === local.date ? "due" : "overdue";
    if (!(await firstTime(task.companyId, `onboarding:${task.id}:${state}:${task.dueDate}`))) continue;
    const label = task.assignee === "employee" ? task.title : `${task.title} (${employee.firstName} ${employee.lastName})`;
    for (const owner of await taskOwners(task, employee)) {
      const d = digests.get(owner) ?? { companyId: task.companyId, due: [], overdue: [] };
      d[state].push(label);
      digests.set(owner, d);
    }
  }
  for (const [personId, d] of digests) {
    const count = d.due.length + d.overdue.length;
    notify(d.companyId, [personId], {
      category: "onboarding",
      title: d.overdue.length
        ? `${count} onboarding task${count > 1 ? "s" : ""} need${count > 1 ? "" : "s"} attention`
        : `Onboarding task${count > 1 ? "s" : ""} due today`,
      body: [...d.overdue.map((t) => `Overdue: ${t}`), ...d.due.map((t) => `Due today: ${t}`)].join("\n"),
      link: { screen: "onboarding" },
    });
    sent++;
  }

  return { sent };
}

/** Runs the checks on an interval inside the API process. */
export function startScheduler(intervalMs = 15 * 60_000) {
  const tick = () => runScheduledChecks().catch((err) => console.error("scheduled checks failed", err));
  tick();
  return setInterval(tick, intervalMs);
}

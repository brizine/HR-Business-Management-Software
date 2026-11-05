import { and, asc, desc, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { INACTIVE_STATUSES, completionExpiry, enrollmentStatus } from "@crewdesk/shared";
import { db } from "../db";
import { companies, courseEnrollments, courseLessons, courses, employees, lessonProgress } from "../db/schema";
import { notify } from "./notify";
import { localParts } from "./tz";

type Enrollment = typeof courseEnrollments.$inferSelect;
type Course = typeof courses.$inferSelect;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function companyToday(companyId: string, now = new Date()) {
  const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  return localParts(now, c?.tz ?? "America/Chicago").date;
}

export async function lessonsOf(courseId: string) {
  return db.select().from(courseLessons).where(eq(courseLessons.courseId, courseId)).orderBy(asc(courseLessons.position), asc(courseLessons.title));
}

/** Each person's latest enrollment per course (older ones are history, e.g. last year's). */
export async function latestEnrollments(where: SQL | undefined) {
  const rows = await db.select().from(courseEnrollments).where(where).orderBy(desc(courseEnrollments.enrolledAt));
  const seen = new Set<string>();
  return rows.filter((r) => { const k = `${r.courseId}:${r.employeeId}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Progress, status and percent for enrollments, with per-lesson detail. */
export async function describeEnrollments(list: Enrollment[], today: string) {
  if (!list.length) return [];
  const courseIds = [...new Set(list.map((e) => e.courseId))];
  const lessons = await db.select({ id: courseLessons.id, courseId: courseLessons.courseId }).from(courseLessons).where(inArray(courseLessons.courseId, courseIds));
  const progress = await db.select().from(lessonProgress).where(inArray(lessonProgress.enrollmentId, list.map((e) => e.id)));
  return list.map((e) => {
    const mine = lessons.filter((l) => l.courseId === e.courseId);
    const done = progress.filter((p) => p.enrollmentId === e.id && p.completedAt && mine.some((l) => l.id === p.lessonId));
    return {
      ...e,
      lessonsDone: done.length,
      lessonsTotal: mine.length,
      percent: e.completedAt ? 100 : mine.length ? Math.round((done.length / mine.length) * 100) : 0,
      status: enrollmentStatus({ completedAt: e.completedAt, expiresAt: e.expiresAt, dueDate: e.dueDate, lessonsDone: done.length }, today),
      progress: progress.filter((p) => p.enrollmentId === e.id).map((p) => ({ lessonId: p.lessonId, completedAt: p.completedAt, quizScore: p.quizScore, attempts: p.attempts })),
    };
  });
}

/** Does this person need (another) enrollment: none yet, or their last completion has expired? */
function needsEnrollment(latest: Enrollment | undefined, today: string) {
  return !latest || (!!latest.completedAt && !!latest.expiresAt && latest.expiresAt <= today);
}

/**
 * Assigns a course to people (skipping anyone who's already working on it or has a current
 * completion), and tells them. Returns who was newly assigned.
 */
export async function assignCourse(course: Course, employeeIds: string[], by: { id: string | null; source: "manager" | "auto" | "self" }, dueDate?: string | null, now = new Date()) {
  if (!employeeIds.length) return [];
  const today = await companyToday(course.companyId, now);
  const existing = await latestEnrollments(and(eq(courseEnrollments.courseId, course.id), inArray(courseEnrollments.employeeId, employeeIds)));
  const fresh = employeeIds.filter((id) => needsEnrollment(existing.find((e) => e.employeeId === id), today));
  if (!fresh.length) return [];
  const due = dueDate !== undefined ? dueDate : course.dueDays ? addDays(today, course.dueDays) : null;
  const rows = await db.insert(courseEnrollments).values(fresh.map((employeeId) => ({ companyId: course.companyId, courseId: course.id, employeeId, assignedById: by.id, source: by.source, dueDate: due }))).returning();
  if (by.source !== "self") {
    const again = existing.filter((e) => fresh.includes(e.employeeId)).map((e) => e.employeeId);
    notify(course.companyId, fresh.filter((id) => !again.includes(id)), {
      category: "training",
      title: `New training: ${course.title}`,
      body: due ? `Please finish it by ${due}.` : "Open it when you're ready.",
      link: { screen: "training", courseId: course.id },
    });
    notify(course.companyId, again, {
      category: "training",
      title: `Time to retake: ${course.title}`,
      body: `Your last completion has expired.${due ? ` Please finish it by ${due}.` : ""}`,
      link: { screen: "training", courseId: course.id },
    });
  }
  return rows;
}

/** Marks the enrollment complete once every lesson is done; tells whoever assigned it. */
export async function maybeComplete(enrollment: Enrollment, now = new Date()) {
  if (enrollment.completedAt) return enrollment;
  const lessons = await lessonsOf(enrollment.courseId);
  const progress = await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, enrollment.id));
  if (!lessons.length || !lessons.every((l) => progress.some((p) => p.lessonId === l.id && p.completedAt))) return enrollment;
  const [course] = await db.select().from(courses).where(eq(courses.id, enrollment.courseId));
  const today = await companyToday(enrollment.companyId, now);
  const [done] = await db.update(courseEnrollments).set({ completedAt: now, expiresAt: completionExpiry(today, course.validityMonths) }).where(eq(courseEnrollments.id, enrollment.id)).returning();
  const [who] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, enrollment.employeeId));
  if (enrollment.assignedById && enrollment.assignedById !== enrollment.employeeId) {
    notify(enrollment.companyId, [enrollment.assignedById], {
      category: "training",
      title: `${who.f} ${who.l} finished ${course.title}`,
      body: done.expiresAt ? `Good until ${done.expiresAt}.` : "Completed.",
      link: { screen: "training", courseId: course.id },
    });
  }
  return done;
}

/** People a course is automatically assigned to. */
export async function autoAssignees(course: Course) {
  if (course.autoAssign === "none" || !course.published) return [];
  const staff = await db.select().from(employees).where(and(eq(employees.companyId, course.companyId), notInArray(employees.status, INACTIVE_STATUSES)));
  const to = new Set(course.autoAssignTo.map((t) => t.toLowerCase()));
  return staff.filter((e) =>
    course.autoAssign === "everyone" ||
    (course.autoAssign === "titles" && !!e.title && to.has(e.title.toLowerCase())) ||
    (course.autoAssign === "departments" && !!e.department && to.has(e.department.toLowerCase())),
  ).map((e) => e.id);
}

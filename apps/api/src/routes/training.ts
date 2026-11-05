import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assignSchema, courseSchema, gradeQuiz, hasRole, lessonSchema, quizForLearner, quizSubmitSchema } from "@crewdesk/shared";
import { db } from "../db";
import { courseEnrollments, courseLessons, courses, employees, lessonProgress } from "../db/schema";
import { authenticate, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { assignCourse, autoAssignees, companyToday, describeEnrollments, latestEnrollments, lessonsOf, maybeComplete } from "../lib/training";

/** Which area of the Permissions page controls access here. */
const AREA = "training" as const;
const canManage = (req: FastifyRequest) => hasRole(roleIn(req, AREA), "manager");
const canEdit = (req: FastifyRequest) => hasRole(roleIn(req, AREA), "admin");

async function loadCourse(req: FastifyRequest, id: string) {
  const [c] = await db.select().from(courses).where(and(eq(courses.id, id), eq(courses.companyId, req.user.companyId)));
  if (!c) notFound("Course");
  return c;
}

/** My current enrollment in a course (the latest), if any. */
async function myEnrollment(req: FastifyRequest, courseId: string) {
  const [e] = await db.select().from(courseEnrollments).where(and(eq(courseEnrollments.courseId, courseId), eq(courseEnrollments.employeeId, req.user.sub))).orderBy(desc(courseEnrollments.enrolledAt)).limit(1);
  return e ?? null;
}

/** Drafts are for people who edit training; anyone enrolled can still see a course that was unpublished. */
async function visibleCourse(req: FastifyRequest, id: string) {
  const c = await loadCourse(req, id);
  if (!c.published && !canEdit(req) && !(await myEnrollment(req, id))) notFound("Course");
  return c;
}

const lessonOutline = (l: typeof courseLessons.$inferSelect) => ({ id: l.id, chapter: l.chapter, title: l.title, position: l.position, hasVideo: !!l.videoUrl, questions: l.quiz.length });

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** The catalog: published courses (and drafts for editors), with my enrollment and, for managers, counts. */
  app.get("/courses", async (req) => {
    const list = await db.select().from(courses).where(eq(courses.companyId, req.user.companyId)).orderBy(asc(courses.title));
    const today = await companyToday(req.user.companyId);
    const mine = await describeEnrollments(await latestEnrollments(and(eq(courseEnrollments.companyId, req.user.companyId), eq(courseEnrollments.employeeId, req.user.sub))), today);
    const lessons = list.length ? await db.select({ courseId: courseLessons.courseId }).from(courseLessons).where(inArray(courseLessons.courseId, list.map((c) => c.id))) : [];
    const everyone = canManage(req) ? await describeEnrollments(await latestEnrollments(eq(courseEnrollments.companyId, req.user.companyId)), today) : [];
    return {
      canManage: canManage(req),
      canEdit: canEdit(req),
      today,
      courses: list
        .filter((c) => c.published || canEdit(req) || mine.some((m) => m.courseId === c.id))
        .map((c) => {
          const all = everyone.filter((e) => e.courseId === c.id);
          return {
            ...c,
            lessons: lessons.filter((l) => l.courseId === c.id).length,
            enrollment: mine.find((m) => m.courseId === c.id) ?? null,
            ...(canManage(req) ? { stats: { assigned: all.length, completed: all.filter((e) => e.status === "completed").length, overdue: all.filter((e) => e.status === "overdue").length, expired: all.filter((e) => e.status === "expired").length } } : {}),
          };
        }),
    };
  });

  app.post("/courses", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to create courses");
    const body = parse(courseSchema, req.body);
    const [c] = await db.insert(courses).values({ ...body, companyId: req.user.companyId, createdById: req.user.sub }).returning();
    await assignCourse(c, await autoAssignees(c), { id: req.user.sub, source: "auto" });
    return c;
  });

  app.put<{ Params: { id: string } }>("/courses/:id", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to edit courses");
    await loadCourse(req, req.params.id);
    const body = parse(courseSchema, req.body);
    const [c] = await db.update(courses).set({ ...body, updatedAt: new Date() }).where(eq(courses.id, req.params.id)).returning();
    // Publishing (or changing who it's for) assigns it right away.
    await assignCourse(c, await autoAssignees(c), { id: req.user.sub, source: "auto" });
    return c;
  });

  app.delete<{ Params: { id: string } }>("/courses/:id", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to delete courses");
    await loadCourse(req, req.params.id);
    await db.delete(courses).where(eq(courses.id, req.params.id));
    return { ok: true };
  });

  /** A course with its lesson outline and my progress. */
  app.get<{ Params: { id: string } }>("/courses/:id", async (req) => {
    const c = await visibleCourse(req, req.params.id);
    const lessons = await lessonsOf(c.id);
    const e = await myEnrollment(req, c.id);
    const [mine] = e ? await describeEnrollments([e], await companyToday(req.user.companyId)) : [null];
    return { ...c, lessons: lessons.map(lessonOutline), enrollment: mine, canManage: canManage(req), canEdit: canEdit(req) };
  });

  /** One lesson to read (learners get the quiz without its answers; editors can ask for the full lesson). */
  app.get<{ Params: { lessonId: string }; Querystring: { edit?: string } }>("/lessons/:lessonId", async (req) => {
    const [l] = await db.select().from(courseLessons).where(and(eq(courseLessons.id, req.params.lessonId), eq(courseLessons.companyId, req.user.companyId)));
    if (!l) notFound("Lesson");
    const c = await visibleCourse(req, l.courseId);
    if (req.query.edit === "1" && canEdit(req)) return l;
    const e = await myEnrollment(req, c.id);
    if (!e && !canEdit(req)) throw new HttpError(403, "Enrol in the course to open its lessons");
    const [p] = e ? await db.select().from(lessonProgress).where(and(eq(lessonProgress.enrollmentId, e.id), eq(lessonProgress.lessonId, l.id))) : [];
    return { ...l, quiz: quizForLearner(l.quiz), passingScore: c.passingScore, progress: p ?? null, preview: !e };
  });

  app.post<{ Params: { id: string } }>("/courses/:id/lessons", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to edit courses");
    const c = await loadCourse(req, req.params.id);
    const body = parse(lessonSchema, req.body);
    const last = (await lessonsOf(c.id)).at(-1);
    const [l] = await db.insert(courseLessons).values({ ...body, courseId: c.id, companyId: req.user.companyId, position: (last?.position ?? -1) + 1 }).returning();
    return l;
  });

  app.put<{ Params: { lessonId: string } }>("/lessons/:lessonId", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to edit courses");
    const body = parse(lessonSchema, req.body);
    const [l] = await db.update(courseLessons).set({ ...body, updatedAt: new Date() }).where(and(eq(courseLessons.id, req.params.lessonId), eq(courseLessons.companyId, req.user.companyId))).returning();
    if (!l) notFound("Lesson");
    return l;
  });

  app.delete<{ Params: { lessonId: string } }>("/lessons/:lessonId", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to edit courses");
    const [l] = await db.delete(courseLessons).where(and(eq(courseLessons.id, req.params.lessonId), eq(courseLessons.companyId, req.user.companyId))).returning();
    if (!l) notFound("Lesson");
    return { ok: true };
  });

  /** New lesson order (all of the course's lesson ids). */
  app.put<{ Params: { id: string } }>("/courses/:id/lesson-order", async (req) => {
    if (!canEdit(req)) throw new HttpError(403, "You don't have access to edit courses");
    const c = await loadCourse(req, req.params.id);
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()) }), req.body);
    const lessons = await lessonsOf(c.id);
    if (ids.length !== lessons.length || !lessons.every((l) => ids.includes(l.id))) throw new HttpError(400, "Send every lesson in the course once");
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(courseLessons).set({ position: i }).where(eq(courseLessons.id, id));
    });
    return (await lessonsOf(c.id)).map(lessonOutline);
  });

  /** Enrol myself in a published course that allows it. */
  app.post<{ Params: { id: string } }>("/courses/:id/enroll", async (req) => {
    const c = await visibleCourse(req, req.params.id);
    if (!c.published || (!c.selfEnroll && !canManage(req))) throw new HttpError(403, "Ask your manager to assign you this course");
    await assignCourse(c, [req.user.sub], { id: req.user.sub, source: "self" }, null);
    const e = await myEnrollment(req, c.id);
    return (await describeEnrollments([e!], await companyToday(req.user.companyId)))[0];
  });

  /** Managers assign a course to people. */
  app.post<{ Params: { id: string } }>("/courses/:id/assign", async (req) => {
    if (!canManage(req)) throw new HttpError(403, "You don't have access to assign training");
    const c = await loadCourse(req, req.params.id);
    if (!c.published) throw new HttpError(400, "Publish the course before assigning it");
    const body = parse(assignSchema, req.body);
    const valid = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, req.user.companyId), inArray(employees.id, body.employeeIds)));
    if (valid.length !== new Set(body.employeeIds).size) notFound("Employee");
    const added = await assignCourse(c, body.employeeIds, { id: req.user.sub, source: "manager" }, body.dueDate);
    return { assigned: added.length, skipped: body.employeeIds.length - added.length };
  });

  /** Managers remove an assignment (e.g. assigned by mistake). */
  app.delete<{ Params: { enrollmentId: string } }>("/enrollments/:enrollmentId", async (req) => {
    if (!canManage(req)) throw new HttpError(403, "You don't have access to change assignments");
    const [e] = await db.delete(courseEnrollments).where(and(eq(courseEnrollments.id, req.params.enrollmentId), eq(courseEnrollments.companyId, req.user.companyId))).returning();
    if (!e) notFound("Assignment");
    return { ok: true };
  });

  /** Marks a lesson without a quiz as done. */
  app.post<{ Params: { lessonId: string } }>("/lessons/:lessonId/complete", async (req) => {
    const { lesson, enrollment } = await learnerLesson(req, req.params.lessonId);
    if (lesson.quiz.length) throw new HttpError(400, "Pass the quiz to finish this lesson");
    await db.insert(lessonProgress).values({ enrollmentId: enrollment.id, lessonId: lesson.id, completedAt: new Date() })
      .onConflictDoUpdate({ target: [lessonProgress.enrollmentId, lessonProgress.lessonId], set: { completedAt: new Date(), updatedAt: new Date() } });
    const done = await maybeComplete(enrollment);
    return (await describeEnrollments([done], await companyToday(req.user.companyId)))[0];
  });

  /** Submits a quiz: graded here; passing finishes the lesson. Right answers are shown once passed. */
  app.post<{ Params: { lessonId: string } }>("/lessons/:lessonId/quiz", async (req) => {
    const { lesson, enrollment, course } = await learnerLesson(req, req.params.lessonId);
    if (!lesson.quiz.length) throw new HttpError(400, "This lesson has no quiz");
    const { answers } = parse(quizSubmitSchema, req.body);
    const grade = gradeQuiz(lesson.quiz, answers);
    const passed = grade.score >= course.passingScore;
    const [prev] = await db.select().from(lessonProgress).where(and(eq(lessonProgress.enrollmentId, enrollment.id), eq(lessonProgress.lessonId, lesson.id)));
    const best = Math.max(prev?.quizScore ?? 0, grade.score);
    const values = { quizScore: best, attempts: (prev?.attempts ?? 0) + 1, completedAt: prev?.completedAt ?? (passed ? new Date() : null), updatedAt: new Date() };
    await db.insert(lessonProgress).values({ enrollmentId: enrollment.id, lessonId: lesson.id, ...values })
      .onConflictDoUpdate({ target: [lessonProgress.enrollmentId, lessonProgress.lessonId], set: values });
    const done = await maybeComplete(enrollment);
    return {
      ...grade,
      passed,
      passingScore: course.passingScore,
      attempts: values.attempts,
      explanations: lesson.quiz.map((q) => q.explanation ?? null),
      correctAnswers: passed ? lesson.quiz.map((q) => q.correct) : null,
      enrollment: (await describeEnrollments([done], await companyToday(req.user.companyId)))[0],
    };
  });

  /** Managers: everyone's progress (latest assignment per person and course). */
  app.get<{ Querystring: { courseId?: string; employeeId?: string } }>("/report", async (req) => {
    const self = req.query.employeeId === req.user.sub;
    if (!canManage(req) && !self) throw new HttpError(403, "You don't have access to training progress");
    const where = [eq(courseEnrollments.companyId, req.user.companyId)];
    if (req.query.courseId) where.push(eq(courseEnrollments.courseId, req.query.courseId));
    if (req.query.employeeId) where.push(eq(courseEnrollments.employeeId, req.query.employeeId));
    const rows = await describeEnrollments(await latestEnrollments(and(...where)), await companyToday(req.user.companyId));
    const people = rows.length ? await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, title: employees.title, department: employees.department }).from(employees).where(inArray(employees.id, [...new Set(rows.map((r) => r.employeeId))])) : [];
    const list = rows.length ? await db.select({ id: courses.id, title: courses.title, category: courses.category }).from(courses).where(inArray(courses.id, [...new Set(rows.map((r) => r.courseId))])) : [];
    return rows.map(({ progress, ...r }) => ({ ...r, employee: people.find((p) => p.id === r.employeeId), course: list.find((c) => c.id === r.courseId) }));
  });
};

/** The lesson, its course and my current enrollment (must be enrolled and not yet finished). */
async function learnerLesson(req: FastifyRequest, lessonId: string) {
  const [lesson] = await db.select().from(courseLessons).where(and(eq(courseLessons.id, lessonId), eq(courseLessons.companyId, req.user.companyId)));
  if (!lesson) notFound("Lesson");
  const [course] = await db.select().from(courses).where(eq(courses.id, lesson.courseId));
  const [enrollment] = await db.select().from(courseEnrollments).where(and(eq(courseEnrollments.courseId, course.id), eq(courseEnrollments.employeeId, req.user.sub))).orderBy(desc(courseEnrollments.enrolledAt)).limit(1);
  if (!enrollment) throw new HttpError(403, "Enrol in the course first");
  return { lesson, course, enrollment };
}

export default routes;

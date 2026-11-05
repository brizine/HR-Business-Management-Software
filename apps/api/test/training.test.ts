/** Training: courses, lessons, quizzes, assignment, progress, expiry and reminders. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { runScheduledChecks } from "../src/lib/jobs";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@train.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inbox = async (who: string) => (await call("GET", "/notifications", who)).body.items as any[];

const course = { title: "Spray safety", description: "PPE and labels", category: "Safety", published: false, passingScore: 80, validityMonths: 12, dueDays: 14, autoAssign: "titles", autoAssignTo: ["Driver"], selfEnroll: true };
const quiz = [
  { kind: "single", question: "What do you wear when mixing?", options: ["Nothing", "Gloves and goggles"], correct: [1], explanation: "Always PPE." },
  { kind: "true_false", question: "Read the label before mixing.", options: ["True", "False"], correct: [0] },
];

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Train Co", firstName: "Tom", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  for (const [who, role, title] of [["lead", "manager", "Crew Lead"], ["driver", "employee", "Driver"], ["tech", "employee", "Mechanic"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role, title });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("training", () => {
  it("admins build a draft course; others can't see or edit it", async () => {
    expect((await call("POST", "/training/courses", "lead", course)).status).toBe(403);
    const c = await call("POST", "/training/courses", "owner", course);
    expect(c.status).toBe(200);
    ID.course = c.body.id;
    const l1 = await call("POST", `/training/courses/${ID.course}/lessons`, "owner", { chapter: "Basics", title: "Reading labels", content: "# Labels\nAlways read them.", videoUrl: "https://youtu.be/abc", quiz: [] });
    const l2 = await call("POST", `/training/courses/${ID.course}/lessons`, "owner", { chapter: "Basics", title: "PPE check", content: "Gear up.", quiz });
    expect(l2.body.position).toBe(1);
    ID.l1 = l1.body.id;
    ID.l2 = l2.body.id;
    expect((await call("POST", `/training/courses/${ID.course}/lessons`, "owner", { title: "Bad", content: "", quiz: [{ ...quiz[0], correct: [7] }] })).status).toBe(400);
    expect((await call("GET", "/training/courses", "driver")).body.courses).toEqual([]);
    expect((await call("GET", `/training/courses/${ID.course}`, "driver")).status).toBe(404);
    // Reordering.
    const order = await call("PUT", `/training/courses/${ID.course}/lesson-order`, "owner", { ids: [ID.l2, ID.l1] });
    expect(order.body.map((l: any) => l.id)).toEqual([ID.l2, ID.l1]);
    await call("PUT", `/training/courses/${ID.course}/lesson-order`, "owner", { ids: [ID.l1, ID.l2] });
  });

  it("publishing assigns it to matching job titles, who are notified", async () => {
    await call("PUT", `/training/courses/${ID.course}`, "owner", { ...course, published: true });
    await flushNotifications();
    expect((await inbox("driver")).some((n) => n.title === "New training: Spray safety" && n.link.courseId === ID.course)).toBe(true);
    expect((await inbox("tech")).some((n) => n.title.startsWith("New training"))).toBe(false);
    const mine = (await call("GET", "/training/courses", "driver")).body.courses[0];
    expect(mine.enrollment).toMatchObject({ status: "not_started", lessonsTotal: 2, percent: 0, source: "auto" });
    expect(mine.enrollment.dueDate).toBeTruthy();
  });

  it("learners read lessons (quiz answers hidden), finish lessons and pass quizzes", async () => {
    const l2 = (await call("GET", `/training/lessons/${ID.l2}`, "driver")).body;
    expect(l2.quiz[0]).toEqual({ kind: "single", question: "What do you wear when mixing?", options: ["Nothing", "Gloves and goggles"] });
    expect((await call("POST", `/training/lessons/${ID.l2}/complete`, "driver")).status).toBe(400);
    expect((await call("POST", `/training/lessons/${ID.l1}/complete`, "tech")).status).toBe(403);
    const done1 = await call("POST", `/training/lessons/${ID.l1}/complete`, "driver");
    expect(done1.body).toMatchObject({ status: "in_progress", lessonsDone: 1, percent: 50 });
    const fail = await call("POST", `/training/lessons/${ID.l2}/quiz`, "driver", { answers: [[0], [0]] });
    expect(fail.body).toMatchObject({ score: 50, passed: false, correctAnswers: null, results: [false, true], attempts: 1 });
    expect(fail.body.explanations[0]).toBe("Always PPE.");
    const pass = await call("POST", `/training/lessons/${ID.l2}/quiz`, "driver", { answers: [[1], [0]] });
    expect(pass.body).toMatchObject({ score: 100, passed: true, correctAnswers: [[1], [0]], attempts: 2 });
    expect(pass.body.enrollment).toMatchObject({ status: "completed", percent: 100 });
    expect(pass.body.enrollment.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await flushNotifications();
    expect((await inbox("owner")).some((n) => n.title === "driver Person finished Spray safety")).toBe(true);
  });

  it("self-enrolment, manager assignment, and the progress report", async () => {
    const self = await call("POST", `/training/courses/${ID.course}/enroll`, "tech");
    expect(self.body).toMatchObject({ source: "self", status: "not_started", dueDate: null });
    expect((await call("POST", `/training/courses/${ID.course}/assign`, "tech", { employeeIds: [ID.lead] })).status).toBe(403);
    const a = await call("POST", `/training/courses/${ID.course}/assign`, "lead", { employeeIds: [ID.tech, ID.owner], dueDate: "2030-01-31" });
    expect(a.body).toEqual({ assigned: 1, skipped: 1 }); // tech is already enrolled
    const report = (await call("GET", `/training/report?courseId=${ID.course}`, "lead")).body;
    expect(report.map((r: any) => [r.employee.firstName, r.status]).sort()).toEqual([["Tom", "not_started"], ["driver", "completed"], ["tech", "not_started"]]);
    expect((await call("GET", "/training/report", "tech")).status).toBe(403);
    expect((await call("GET", `/training/report?employeeId=${ID.tech}`, "tech")).status).toBe(200);
    const stats = (await call("GET", "/training/courses", "lead")).body.courses[0].stats;
    expect(stats).toMatchObject({ assigned: 3, completed: 1 });
  });

  it("expired completions are assigned again; reminders before due dates", async () => {
    // A year and a month later: the driver's completion has expired.
    const later = new Date(Date.now() + 400 * 86_400_000);
    await runScheduledChecks(later);
    await flushNotifications();
    expect((await inbox("driver")).some((n) => n.title === "Time to retake: Spray safety")).toBe(true);
    const again = (await call("GET", "/training/courses", "driver")).body.courses[0].enrollment;
    expect(again.completedAt).toBeNull();
    // Owner's assignment is due 2030-01-31: a reminder goes out 3 days before.
    await runScheduledChecks(new Date("2030-01-29T18:00:00Z"));
    await flushNotifications();
    expect((await inbox("owner")).some((n) => n.title === "Training due 2030-01-31: Spray safety")).toBe(true);
  });
});

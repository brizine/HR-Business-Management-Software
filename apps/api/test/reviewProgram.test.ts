/** Review program: rules for when reviews are due, the due list, and reminders to managers/admins. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_REVIEW_PROGRAM } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@revprog.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inbox = async (who: string) => (await call("GET", "/notifications", who)).body.items as any[];

// Noon in the company's time zone (Chicago) on today's UTC date, so reminders are past REMINDER_HOUR.
const base = new Date();
const today = base.toISOString().slice(0, 10);
const noon = (plusDays = 0) => new Date(Date.parse(`${today}T18:00:00Z`) + plusDays * 86_400_000);
const daysAgo = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Program Co", firstName: "Pat", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["lead", "manager"], ["crew", "employee"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // Hired 85 days ago, reports to lead: the 90-day review is due in 5 days.
  await call("PATCH", `/employees/${ID.crew}`, "owner", { startDate: daysAgo(85), managerId: ID.lead });
});

beforeEach(async () => {
  await flushNotifications();
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("review program", () => {
  it("starts with the standard program (off); only admins change it", async () => {
    const r = await call("GET", "/reviews/program", "lead");
    expect(r.status).toBe(200);
    expect(r.body.program).toMatchObject({ enabled: false, rules: DEFAULT_REVIEW_PROGRAM.rules });
    expect((await call("GET", "/reviews/program", "crew")).status).toBe(403);
    expect((await call("PUT", "/reviews/program", "lead", { ...DEFAULT_REVIEW_PROGRAM, enabled: true })).status).toBe(403);
    const bad = await call("PUT", "/reviews/program", "owner", { ...DEFAULT_REVIEW_PROGRAM, rules: [{ ...DEFAULT_REVIEW_PROGRAM.rules[0], days: undefined }] });
    expect(bad.status).toBe(400);
  });

  it("turning it on lists who's due and keeps the start date when edited", async () => {
    const { startedOn: _s, ...program } = DEFAULT_REVIEW_PROGRAM;
    const on = await call("PUT", "/reviews/program", "owner", { ...program, enabled: true });
    expect(on.status).toBe(200);
    const started = on.body.program.startedOn;
    expect(started).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const crew = on.body.due.filter((d: any) => d.employeeId === ID.crew);
    expect(crew.map((d: any) => d.ruleId).sort()).toEqual(["annual", "ninety-day"]);
    expect(crew.find((d: any) => d.ruleId === "ninety-day")).toMatchObject({ status: "due_soon", managerId: ID.lead, firstName: "crew" });
    // Editing (e.g. a longer reminder window) doesn't move the start date.
    const edited = await call("PUT", "/reviews/program", "owner", { ...program, enabled: true, rules: [{ ...program.rules[0], remindDaysBefore: 21 }, program.rules[1]] });
    expect(edited.body.program).toMatchObject({ startedOn: started, rules: [{ remindDaysBefore: 21 }, { id: "annual" }] });
    // Duplicate ids are refused.
    expect((await call("PUT", "/reviews/program", "owner", { ...program, enabled: true, rules: [program.rules[0], program.rules[0]] })).status).toBe(400);
  });

  it("reminds the manager and admins once when due soon, again when overdue, and stops once reviewed", async () => {
    await runScheduledChecks(noon());
    await flushNotifications();
    const lead = (await inbox("lead")).filter((n) => n.category === "reviews");
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({ title: "90-day review due soon: crew Person", link: { screen: "review-due", employeeId: ID.crew, reviewType: "probation" } });
    expect((await inbox("owner")).filter((n) => n.category === "reviews")).toHaveLength(1);
    expect((await inbox("crew")).filter((n) => n.category === "reviews")).toHaveLength(0);

    // Same day again: nothing new.
    await runScheduledChecks(noon());
    await flushNotifications();
    expect((await inbox("lead")).filter((n) => n.category === "reviews")).toHaveLength(1);

    // Ten days later it's overdue.
    await runScheduledChecks(noon(10));
    await flushNotifications();
    const after = (await inbox("lead")).filter((n) => n.category === "reviews");
    expect(after).toHaveLength(2);
    expect(after[0].title).toBe("90-day review overdue: crew Person");

    // Writing the probation review completes it: it leaves the list.
    const r = await call("POST", "/reviews", "lead", { kind: "review", employeeId: ID.crew, type: "probation", date: daysAgo(0), rating: 4, summary: "Good start." });
    expect(r.status).toBe(200);
    const list = (await call("GET", "/reviews/program", "lead")).body.due.filter((d: any) => d.employeeId === ID.crew);
    expect(list.map((d: any) => d.ruleId)).toEqual(["annual"]);
  }, 120_000);
});

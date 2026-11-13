/** Attendance: report from shifts vs punches, calendar changes, rules, alerts and points. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { runScheduledChecks } from "../src/lib/jobs";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@attend.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inbox = async (who: string) => (await call("GET", "/notifications", who)).body.items as any[];

/** 8am–4pm Central on a day in October 2026 (CDT, UTC-5). */
const at = (day: string, hour: number, min = 0) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour + 5, min)).toISOString();

async function shift(day: string) {
  const s = await call("POST", "/shifts", "owner", { employeeId: ID.crew, startsAt: at(day, 8), endsAt: at(day, 16) });
  expect(s.status).toBe(200);
}
async function punch(day: string, inH: number, inM: number, outH: number, outM: number) {
  await call("POST", "/time/clock-in", "crew", {});
  await call("POST", "/time/clock-out", "crew", {});
  const e = ((await call("GET", "/time/entries", "crew")).body as any[]).find((x: any) => !x.clockIn.startsWith("2026-10"));
  await call("PATCH", `/time/entries/${e.id}`, "owner", { clockIn: at(day, inH, inM), clockOut: at(day, outH, outM) });
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Attend Co", firstName: "Ann", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  for (const [who, role] of [["lead", "manager"], ["crew", "employee"], ["other", "employee"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // Mon–Fri Oct 12–16: on time, late, no-show, sick (approved sick time), left early.
  for (const d of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) await shift(d);
  await call("POST", "/shifts/publish", "owner", { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" });
  await punch("2026-10-12", 7, 58, 16, 2);
  await punch("2026-10-13", 8, 20, 16, 0);
  await punch("2026-10-16", 8, 0, 14, 0);
  const sick = await call("POST", "/pto/policies", "owner", { name: "Sick Leave" });
  await call("POST", "/pto/adjustments", "owner", { employeeId: ID.crew, policyId: sick.body.id, hours: 40, reason: "grant" });
  const req = await call("POST", "/pto/requests", "crew", { policyId: sick.body.id, startDate: "2026-10-15", endDate: "2026-10-15", hours: 8 });
  await call("POST", `/pto/requests/${req.body.id}/decide`, "owner", { status: "approved" });
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("attendance", () => {
  it("compares the schedule with punches and time off", async () => {
    const r = await call("GET", "/attendance?from=2026-10-12&to=2026-10-16", "lead");
    expect(r.status).toBe(200);
    const crew = r.body.people.find((p: any) => p.employee.id === ID.crew);
    expect(crew.days.map((d: any) => [d.date, d.status, d.points])).toEqual([
      ["2026-10-12", "on_time", 0],
      ["2026-10-13", "tardy", 0.5],
      ["2026-10-14", "no_show", 1],
      ["2026-10-15", "sick", 0],
      ["2026-10-16", "early_leave", 0.5],
    ]);
    expect(crew.days[1].shifts[0].minutesLate).toBe(20);
    expect(crew.summary).toMatchObject({ scheduledDays: 5, onTime: 1, tardy: 1, noShow: 1, sick: 1, earlyLeave: 1, onTimeRate: 25, minutesLate: 20 });
    expect(crew.points.total).toBe(2);
    expect(r.body.canEdit).toBe(false); // managers see it; owners/admins edit
  });

  it("employees see only their own; only owners/admins change days and rules", async () => {
    const mine = await call("GET", "/attendance?from=2026-10-12&to=2026-10-16", "other");
    expect(mine.body.people.map((p: any) => p.employee.id)).toEqual([ID.other]);
    expect((await call("GET", `/attendance?from=2026-10-12&to=2026-10-16&employeeId=${ID.crew}`, "other")).body.people.map((p: any) => p.employee.id)).toEqual([ID.other]);
    expect((await call("PUT", "/attendance/override", "lead", { employeeId: ID.crew, date: "2026-10-14", status: "sick" })).status).toBe(403);
    expect((await call("PUT", "/attendance/rules", "lead", {})).status).toBe(403);
  });

  it("owners and admins change a day (e.g. called in sick), with a note, and can put it back", async () => {
    const set = await call("PUT", "/attendance/override", "owner", { employeeId: ID.crew, date: "2026-10-14", status: "sick", note: "Called at 6:45am" });
    expect(set.body.day).toMatchObject({ status: "sick", auto: "no_show", overridden: true, note: "Called at 6:45am", points: 0 });
    expect(set.body.points.total).toBe(1);
    // A custom points amount for one day.
    const custom = await call("PUT", "/attendance/override", "owner", { employeeId: ID.crew, date: "2026-10-13", status: "tardy", points: 0 });
    expect(custom.body.day.points).toBe(0);
    // Back to automatic.
    expect((await call("PUT", "/attendance/override", "owner", { employeeId: ID.crew, date: "2026-10-13", status: null })).body.day).toMatchObject({ status: "tardy", overridden: false, points: 0.5 });
    // A day with no shift can be marked too.
    expect((await call("PUT", "/attendance/override", "owner", { employeeId: ID.crew, date: "2026-10-17", status: "excused" })).body.day.status).toBe("excused");
  });

  it("the grace period and points are set in the software", async () => {
    const rules = (await call("GET", "/attendance/rules", "crew")).body;
    expect(rules).toMatchObject({ graceMinutes: 5, noShowMinutes: 30, pointsExpireDays: 90 });
    const saved = await call("PUT", "/attendance/rules", "owner", { ...rules, graceMinutes: 25, tardyPoints: 1, thresholds: [{ points: 5, label: "Written" }, { points: 2, label: "Talk" }] });
    expect(saved.body.thresholds.map((t: any) => t.points)).toEqual([2, 5]);
    const crew = (await call("GET", "/attendance?from=2026-10-12&to=2026-10-16", "owner")).body.people.find((p: any) => p.employee.id === ID.crew);
    expect(crew.days.find((d: any) => d.date === "2026-10-13").status).toBe("on_time"); // 20 minutes late is within 25
    expect((await call("PUT", "/attendance/rules", "owner", { ...rules, graceMinutes: -1 })).status).toBe(400);
    await call("PUT", "/attendance/rules", "owner", rules);
  });

  it("alerts managers and the employee once when someone hasn't clocked in", async () => {
    await call("POST", "/shifts", "owner", { employeeId: ID.other, startsAt: at("2026-10-19", 8), endsAt: at("2026-10-19", 16) });
    await call("POST", "/shifts/publish", "owner", { from: "2026-10-19T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" });
    // 20 minutes in: not yet (alert at 30).
    await runScheduledChecks(new Date(at("2026-10-19", 8, 20)));
    await flushNotifications();
    expect((await inbox("lead")).some((n) => n.title.includes("hasn't clocked in"))).toBe(false);
    await runScheduledChecks(new Date(at("2026-10-19", 8, 35)));
    await runScheduledChecks(new Date(at("2026-10-19", 8, 50)));
    await flushNotifications();
    const lead = (await inbox("lead")).filter((n) => n.title === "other Person hasn't clocked in");
    expect(lead).toHaveLength(1);
    expect(lead[0].link).toEqual({ screen: "attendance", employeeId: ID.other });
    expect((await inbox("other")).filter((n) => n.title === "You haven't clocked in")).toHaveLength(1);
    // Someone who clocked in isn't flagged.
    await shift("2026-10-20");
    await call("POST", "/shifts/publish", "owner", { from: "2026-10-20T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z" });
    await punch("2026-10-20", 8, 1, 16, 0);
    await runScheduledChecks(new Date(at("2026-10-20", 8, 45)));
    await flushNotifications();
    expect((await inbox("lead")).some((n) => n.title === "crew Person hasn't clocked in" && n.body.includes("8:00"))).toBe(false);
  });

  it("alerts managers when someone reaches a point level", async () => {
    await call("PUT", "/attendance/rules", "owner", { ...(await call("GET", "/attendance/rules", "owner")).body, thresholds: [{ points: 2, label: "Verbal warning" }] });
    // crew: late (0.5) + early (0.5) + another no-show below = 2.
    await shift("2026-10-21");
    await call("POST", "/shifts/publish", "owner", { from: "2026-10-21T00:00:00.000Z", to: "2026-10-22T00:00:00.000Z" });
    await runScheduledChecks(new Date(at("2026-10-22", 9)));
    await runScheduledChecks(new Date(at("2026-10-22", 11)));
    await flushNotifications();
    const n = (await inbox("lead")).filter((x) => x.title === "crew Person reached 2 attendance points");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("Verbal warning");
  });
});

describe("fixing attendance and flexible rules", () => {
  const week = "/attendance?from=2026-10-12&to=2026-10-16";
  const crewDays = async () => (await call("GET", week, "owner")).body.people.find((p: any) => p.employee.id === ID.crew).days as any[];

  it("each day lists its punches, and managers add or remove one to fix the day", async () => {
    const days = await crewDays();
    expect(days.find((d) => d.date === "2026-10-13").punches).toHaveLength(1);
    expect(days.find((d) => d.date === "2026-10-14").punches).toEqual([]);
    // The no-show actually worked: a manager adds the missed punch.
    expect((await call("POST", "/time/entries", "crew", { employeeId: ID.crew, clockIn: at("2026-10-14", 8), clockOut: at("2026-10-14", 16) })).status).toBe(403);
    const added = await call("POST", "/time/entries", "lead", { employeeId: ID.crew, clockIn: at("2026-10-14", 8), clockOut: at("2026-10-14", 16) });
    expect(added.status).toBe(200);
    // (An owner marked that day sick earlier, so look at what the punches now show.)
    expect((await crewDays()).find((d) => d.date === "2026-10-14").auto).toBe("on_time");
    // Overlapping an existing punch is refused.
    expect((await call("POST", "/time/entries", "lead", { employeeId: ID.crew, clockIn: at("2026-10-14", 9), clockOut: at("2026-10-14", 10) })).status).toBe(409);
    // Removing it puts the day back.
    expect((await call("DELETE", `/time/entries/${added.body.id}`, "lead")).status).toBe(200);
    expect((await crewDays()).find((d) => d.date === "2026-10-14").auto).toBe("no_show");
  });

  it("very late and left very early earn their own points; both can count on one day", async () => {
    const rules = (await call("GET", "/attendance/rules", "owner")).body;
    expect(rules).toMatchObject({ lateTierMinutes: 0, earlyTierMinutes: 0, countLateAndEarly: false });
    // Tue 10/13 was 20 minutes late; Fri 10/16 left 2 hours early.
    await call("PUT", "/attendance/rules", "owner", { ...rules, graceMinutes: 5, tardyPoints: 0.5, earlyLeavePoints: 0.5, lateTierMinutes: 15, lateTierPoints: 1, earlyTierMinutes: 60, earlyTierPoints: 2 });
    let days = await crewDays();
    expect(days.find((d) => d.date === "2026-10-13").points).toBe(1);
    expect(days.find((d) => d.date === "2026-10-16").points).toBe(2);
    // Mon 10/12: make it late (8:30, very late) and early (3:30 pm, not very early); with both counting it earns 1 + 0.5.
    const mon = days.find((d) => d.date === "2026-10-12").punches[0];
    await call("PATCH", `/time/entries/${mon.id}`, "lead", { clockIn: at("2026-10-12", 8, 30), clockOut: at("2026-10-12", 15, 30) });
    expect((await crewDays()).find((d) => d.date === "2026-10-12").points).toBe(1);
    await call("PUT", "/attendance/rules", "owner", { ...(await call("GET", "/attendance/rules", "owner")).body, countLateAndEarly: true });
    days = await crewDays();
    expect(days.find((d) => d.date === "2026-10-12")).toMatchObject({ status: "tardy", points: 1.5 });
    await call("PUT", "/attendance/rules", "owner", rules);
  });
});

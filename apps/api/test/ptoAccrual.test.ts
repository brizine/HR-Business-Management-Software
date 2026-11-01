/** Time off awarded by date, with higher amounts after years of service. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { ptoPolicies, timeEntries } from "../src/db/schema";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@ptoaccrual.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const balance = async (who: string, policyId: string) => (await call("GET", "/pto/balances", who)).body.find((b: any) => b.policyId === policyId).balanceHours;

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Accrue Co", firstName: "Al", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  for (const [who, hired] of [["veteran", "2021-11-02"], ["newbie", "2026-06-01"], ["nodate", null]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Worker", email: email(who), password: "password123", ...(hired ? { startDate: hired } : {}) });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("time-off awards and service steps", () => {
  it("validates and saves award schedules and steps; only admins edit", async () => {
    expect((await call("POST", "/pto/policies", "owner", { name: "Bad", grantSchedule: "yearly_date", annualGrantHours: 8 })).status).toBe(400);
    expect((await call("POST", "/pto/policies", "owner", { name: "Bad", tiers: [{ afterYears: 1, accrualRate: null, grantHours: 1 }, { afterYears: 1, accrualRate: null, grantHours: 2 }] })).status).toBe(400);
    const p = await call("POST", "/pto/policies", "owner", {
      name: "Vacation", accrualRate: 0, annualGrantHours: 40, grantSchedule: "anniversary", grantDate: "03-01", maxBalanceHours: 100,
      tiers: [{ afterYears: 5, accrualRate: null, grantHours: 80 }, { afterYears: 1, accrualRate: 1 / 25, grantHours: null }],
    });
    expect(p.status).toBe(200);
    expect(p.body.grantDate).toBeNull(); // only kept for "every year on a date"
    expect(p.body.tiers.map((t: any) => t.afterYears)).toEqual([1, 5]);
    ID.vacation = p.body.id;
    expect((await call("PUT", `/pto/policies/${ID.vacation}`, "veteran", { name: "Mine" })).status).toBe(403);
    // Pretend the award settings have been in place for years, so this year's anniversaries count.
    await db.update(ptoPolicies).set({ grantRulesSince: new Date("2020-01-01T00:00:00Z") }).where(eq(ptoPolicies.id, ID.vacation));
  });

  it("awards on the hire anniversary at the right step, once, up to the cap", async () => {
    // Nov 2, 2026 noon Chicago: the veteran's 5-year anniversary.
    await runScheduledChecks(new Date("2026-11-02T18:00:00Z"));
    await runScheduledChecks(new Date("2026-11-02T20:00:00Z"));
    await flushNotifications();
    expect(await balance("veteran", ID.vacation)).toBe(80);
    expect(await balance("newbie", ID.vacation)).toBe(0); // first anniversary not reached
    expect(await balance("nodate", ID.vacation)).toBe(0); // no hire date
    const inbox = (await call("GET", "/notifications", "veteran")).body.items;
    expect(inbox.some((n: any) => n.title === "You received 80h of Vacation")).toBe(true);
    // Next year's award is capped at 100h total.
    await runScheduledChecks(new Date("2027-11-02T18:00:00Z"));
    expect(await balance("veteran", ID.vacation)).toBe(100);
  });

  it("awards every year on a set date, but not for dates before the policy existed", async () => {
    const p = await call("POST", "/pto/policies", "owner", { name: "Floating holiday", annualGrantHours: 8, grantSchedule: "yearly_date", grantDate: "01-01" });
    ID.float = p.body.id;
    await runScheduledChecks(new Date("2026-11-02T18:00:00Z")); // Jan 1, 2026 was before it was created
    expect(await balance("newbie", ID.float)).toBe(0);
    await runScheduledChecks(new Date("2027-01-01T18:00:00Z"));
    expect(await balance("newbie", ID.float)).toBe(8);
    expect(await balance("nodate", ID.float)).toBe(8);
  });

  it("hourly earning uses the rate for their years of service", async () => {
    const p = await call("POST", "/pto/policies", "owner", { name: "Earned", accrualRate: 1 / 40, tiers: [{ afterYears: 3, accrualRate: 1 / 20, grantHours: null }] });
    ID.earned = p.body.id;
    for (const who of ["newbie", "veteran"]) {
      const inn = await call("POST", "/time/clock-in", who, {});
      expect(inn.status).toBe(200);
      // Clocked in 10 hours ago.
      await db.update(timeEntries).set({ clockIn: new Date(Date.now() - 10 * 3_600_000) }).where(eq(timeEntries.id, inn.body.id));
      expect((await call("POST", "/time/clock-out", who, {})).status).toBe(200);
    }
    expect(await balance("newbie", ID.earned)).toBeCloseTo(10 / 40, 2);
    expect(await balance("veteran", ID.earned)).toBeCloseTo(10 / 20, 2);
  });

  it("adding an award to an existing policy doesn't give out past dates", async () => {
    const p = await call("POST", "/pto/policies", "owner", { name: "Bonus days" });
    await db.update(ptoPolicies).set({ createdAt: new Date("2020-01-01T00:00:00Z"), grantRulesSince: new Date("2020-01-01T00:00:00Z") }).where(eq(ptoPolicies.id, p.body.id));
    expect((await call("PUT", `/pto/policies/${p.body.id}`, "owner", { name: "Bonus days", annualGrantHours: 8, grantSchedule: "yearly_date", grantDate: "01-01" })).status).toBe(200);
    await runScheduledChecks(new Date());
    expect(await balance("newbie", p.body.id)).toBe(0);
  });

  it("removes hours above the carryover limit when the year resets, keeping pending requests", async () => {
    const p = await call("POST", "/pto/policies", "owner", { name: "Carry PTO", carryoverLimitHours: 40, carryoverReset: "yearly_date", carryoverDate: "01-01" });
    expect(p.body.carryoverLimitHours).toBe(40);
    ID.carry = p.body.id;
    await call("POST", "/pto/adjustments", "owner", { employeeId: ID.nodate, policyId: ID.carry, hours: 100, reason: "starting balance" });
    expect((await call("POST", "/pto/requests", "nodate", { policyId: ID.carry, startDate: "2027-02-01", endDate: "2027-02-01", hours: 10 })).status).toBe(200);
    // Nothing happens for the Jan 1 that came before the limit was set.
    await runScheduledChecks(new Date("2026-11-02T18:00:00Z"));
    expect(await balance("nodate", ID.carry)).toBe(100);
    await runScheduledChecks(new Date("2027-01-01T18:00:00Z"));
    await runScheduledChecks(new Date("2027-01-01T20:00:00Z"));
    await flushNotifications();
    expect(await balance("nodate", ID.carry)).toBe(50);
    // Removed quietly: no notification.
    const inbox = (await call("GET", "/notifications", "nodate")).body.items;
    expect(inbox.some((n: any) => n.title.includes("carry over"))).toBe(false);
  });

  it("managers can request time off for someone else; employees can't", async () => {
    // The newbie has 8h of Floating holiday from the Jan 1 award above.
    const req = { policyId: ID.float, startDate: "2027-03-01", endDate: "2027-03-01", hours: 4 };
    expect((await call("POST", "/pto/requests", "veteran", { ...req, employeeId: ID.newbie })).status).toBe(403);
    const made = await call("POST", "/pto/requests", "owner", { ...req, employeeId: ID.newbie, reason: "Called in sick" });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ employeeId: ID.newbie, status: "pending" });
    expect((await call("POST", "/pto/requests", "owner", { ...req, hours: 6, employeeId: ID.newbie })).status).toBe(400); // only 4h left
    await flushNotifications();
    const inbox = (await call("GET", "/notifications", "newbie")).body.items;
    expect(inbox.some((n: any) => n.title === "Al Owner requested time off for you")).toBe(true);
    const listed = (await call("GET", `/pto/requests?employeeId=${ID.newbie}`, "owner")).body;
    expect(listed.every((r: any) => r.request.employeeId === ID.newbie)).toBe(true);
    expect(listed).toHaveLength(1);
  });
});

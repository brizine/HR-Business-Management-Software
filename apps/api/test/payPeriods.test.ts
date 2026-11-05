/** Pay schedules: the owner sets frequency, payday and approvers; ended periods go to approvers. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@pay.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inbox = async (who: string) => (await call("GET", "/notifications", who)).body.items as any[];

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Pay Co", firstName: "Pat", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  // Let the admin sign in without setting up two-factor (this test isn't about sign-in).
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["lead", "manager"], ["crew", "employee"], ["book", "admin"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("pay periods", () => {
  it("only the owner sets the schedule; weekly needs a start date", async () => {
    expect((await call("PUT", "/pay-periods/schedule", "lead", { frequency: "weekly", anchorDate: "2026-01-05", paydayOffsetDays: 5, approverIds: [] })).status).toBe(403);
    expect((await call("PUT", "/pay-periods/schedule", "owner", { frequency: "weekly", paydayOffsetDays: 5, approverIds: [] })).status).toBe(400);
    // Only owners and admins can approve payroll.
    const notAdmin = await call("PUT", "/pay-periods/schedule", "owner", { frequency: "weekly", anchorDate: "2026-01-05", paydayOffsetDays: 5, approverIds: [ID.lead, ID.book] });
    expect(notAdmin.status).toBe(400);
    expect(notAdmin.body.error ?? notAdmin.body.message).toMatch(/owners and admins/i);
    const set = await call("PUT", "/pay-periods/schedule", "owner", { frequency: "weekly", anchorDate: "2026-01-05", paydayOffsetDays: 5, approverIds: [ID.owner, ID.book] });
    expect(set.status).toBe(200);
    expect(set.body.approverIds.sort()).toEqual([ID.owner, ID.book].sort());
    expect(set.body.approverChoices.map((c: any) => c.id).sort()).toEqual([ID.owner, ID.book].sort());
    expect(set.body.upcoming).toHaveLength(4);
    expect((await call("GET", "/pay-periods/me", "book")).body.isApprover).toBe(true);
    expect((await call("GET", "/pay-periods/me", "crew")).body.isApprover).toBe(false);
  });

  it("when a period ends, approvers are asked once; others can't see it", async () => {
    // Monday Nov 9, noon in Chicago: the week of Nov 2–8 has ended.
    await runScheduledChecks(new Date("2026-11-09T18:00:00Z"));
    await runScheduledChecks(new Date("2026-11-09T19:00:00Z"));
    await flushNotifications();
    const list = (await call("GET", "/pay-periods", "book")).body;
    const p = list.periods.find((x: any) => x.periodStart === "2026-11-02");
    expect(p).toMatchObject({ periodEnd: "2026-11-08", payday: "2026-11-13", status: "pending" });
    ID.period = p.id;
    const asked = (await inbox("book")).filter((n: any) => n.title.includes("2026-11-02"));
    expect(asked).toHaveLength(1);
    expect(asked[0].link).toEqual({ screen: "pay-period", id: p.id });
    expect((await inbox("crew")).some((n: any) => n.title.includes("2026-11-02"))).toBe(false);
    expect((await call("GET", "/pay-periods", "crew")).status).toBe(403);
    expect((await call("GET", `/pay-periods/${p.id}`, "crew")).status).toBe(403);
    expect((await call("GET", `/pay-periods/${p.id}`, "book")).body.lines).toBeInstanceOf(Array);
  });

  it("an approver approves (once) and admins hear about it; admins can reopen", async () => {
    expect((await call("POST", `/pay-periods/${ID.period}/approve`, "crew", {})).status).toBe(403);
    const ok = await call("POST", `/pay-periods/${ID.period}/approve`, "book", { note: "Looks right" });
    expect(ok.body).toMatchObject({ status: "approved", approvedById: ID.book, approvalNote: "Looks right" });
    expect((await call("POST", `/pay-periods/${ID.period}/approve`, "lead", {})).status).toBe(403);
    expect((await call("POST", `/pay-periods/${ID.period}/approve`, "owner", {})).status).toBe(409);
    await flushNotifications();
    expect((await inbox("owner")).some((n: any) => n.title.includes("approved"))).toBe(true);
    expect((await call("POST", `/pay-periods/${ID.period}/reopen`, "lead")).status).toBe(403);
    expect((await call("POST", `/pay-periods/${ID.period}/reopen`, "owner")).body.status).toBe("pending");
  });
});

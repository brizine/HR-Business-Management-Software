/** Extra pay: bonuses, commissions, reimbursements and other pay, in the pay period their date falls in. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { payrollJournalLines } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { runScheduledChecks } from "../src/lib/jobs";
import { setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@extra.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const line = async (who: string, from = "2026-03-02", to = "2026-03-08") =>
  ((await call("GET", `/payroll/preview?periodStart=${from}&periodEnd=${to}`, "owner")).body as any[]).find((l) => l.employeeId === ID[who]);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Extra Co", firstName: "Ed", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role, payType, rate] of [["crew", "employee", "hourly", 2000], ["boss", "manager", "salary", 6_000_000], ["admin", "admin", "hourly", 2500]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role, payType, payRateCents: rate });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  // crew works 8 hours on Monday Mar 2 ($160).
  await call("POST", "/time/entries", "owner", { employeeId: ID.crew, clockIn: "2026-03-02T14:00:00.000Z", clockOut: "2026-03-02T22:00:00.000Z" });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("extra pay", () => {
  it("only owners and admins add it; managers can see it", async () => {
    const body = { employeeIds: [ID.crew], date: "2026-03-04", kind: "bonus", amountCents: 25_000, note: "Safety award" };
    expect((await call("POST", "/extra-pay", "boss", body)).status).toBe(403);
    expect((await call("POST", "/extra-pay", "crew", body)).status).toBe(403);
    const added = await call("POST", "/extra-pay", "admin", body);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ added: 1, warning: null });
    const seen = await call("GET", `/extra-pay?employeeId=${ID.crew}`, "boss");
    expect(seen.body).toHaveLength(1);
    expect(seen.body[0]).toMatchObject({ kind: "bonus", amountCents: 25_000, note: "Safety award", employeeName: "crew Person", createdBy: "admin Person" });
    expect((await call("GET", "/extra-pay", "crew")).status).toBe(403);
    expect((await call("POST", "/extra-pay", "owner", { ...body, amountCents: 0 })).status).toBe(400);
  });

  it("lands in its pay period: wages in the estimated gross, reimbursements listed separately", async () => {
    await call("POST", "/extra-pay", "owner", { employeeIds: [ID.crew], date: "2026-03-05", kind: "reimbursement", amountCents: 4_210, note: "Fuel" });
    await call("POST", "/extra-pay", "owner", { employeeIds: [ID.crew], date: "2026-03-06", kind: "commission", amountCents: 5_000 });
    const l = await line("crew");
    expect(l).toMatchObject({ bonusCents: 25_000, commissionCents: 5_000, otherPayCents: 0, reimbursementCents: 4_210 });
    expect(l.estimatedGrossCents).toBe(8 * 2000 + 25_000 + 5_000);
    expect(l.extraPay.map((x: any) => x.kind)).toEqual(["bonus", "reimbursement", "commission"]);
    // Not in the next week's period.
    expect((await line("crew", "2026-03-09", "2026-03-15")).bonusCents).toBe(0);
    // CSV columns.
    const csv = await app.inject({ method: "GET", url: "/payroll/export.csv?periodStart=2026-03-02&periodEnd=2026-03-08", headers: { authorization: `Bearer ${T.owner}` } });
    expect(csv.body.split("\n")[0]).toContain("Bonus,Commission,Other Pay,Estimated Gross,Reimbursements");
    expect(csv.body).toContain("bonus 250.00 (Safety award)");
  });

  it("a bonus for several people at once; salaried people show it too", async () => {
    const res = await call("POST", "/extra-pay", "owner", { employeeIds: [ID.boss, ID.admin], date: "2026-03-03", kind: "bonus", amountCents: 10_000, note: "Season wrap-up" });
    expect(res.body.added).toBe(2);
    expect(await line("boss")).toMatchObject({ bonusCents: 10_000, estimatedGrossCents: null }); // salary isn't estimated
    expect((await line("admin")).estimatedGrossCents).toBe(10_000);
  });

  it("the accounting entry includes bonuses (salaried too) and reimbursements when an account is chosen", async () => {
    const lines = ((await call("GET", "/payroll/preview?periodStart=2026-03-02&periodEnd=2026-03-08", "owner")).body as any[]);
    const without = payrollJournalLines(lines, { wagesAccountId: 1, timeOffAccountId: null, payrollLiabilityAccountId: 2 });
    expect(without.lines.find((x) => x.accountId === 1)!.debitCents).toBe(16_000 + 30_000 + 10_000 + 10_000);
    expect(without.reimbursementsLeftOut).toBe(4_210);
    const withAcct = payrollJournalLines(lines, { wagesAccountId: 1, timeOffAccountId: null, payrollLiabilityAccountId: 2, reimbursementAccountId: 3 });
    expect(withAcct.lines.find((x) => x.accountId === 3)!.debitCents).toBe(4_210);
    expect(withAcct.lines.find((x) => x.accountId === 2)!.creditCents).toBe(66_000 + 4_210);
  });

  it("an approved period keeps its figures; extra pay dated in it says so", async () => {
    await call("PUT", "/pay-periods/schedule", "owner", { frequency: "weekly", anchorDate: "2026-03-02", paydayOffsetDays: 5, approverIds: [ID.owner] });
    await runScheduledChecks(new Date("2026-03-09T18:00:00Z"));
    const period = (await call("GET", "/pay-periods", "owner")).body.periods.find((p: any) => p.periodStart === "2026-03-02");
    await call("POST", `/pay-periods/${period.id}/approve`, "owner", {});
    const late = await call("POST", "/extra-pay", "owner", { employeeIds: [ID.crew], date: "2026-03-07", kind: "other", amountCents: 1_000 });
    expect(late.body.warning).toMatch(/already approved/);
    const crewLine = async () => (await call("GET", `/pay-periods/${period.id}`, "owner")).body.lines.find((l: any) => l.employeeId === ID.crew);
    expect((await crewLine()).otherPayCents).toBe(0);
    await call("POST", `/pay-periods/${period.id}/reopen`, "owner", {});
    expect((await crewLine()).otherPayCents).toBe(1_000);
    // Removing it (admins).
    expect((await call("DELETE", `/extra-pay/${late.body.items[0].id}`, "boss")).status).toBe(403);
    expect((await call("DELETE", `/extra-pay/${late.body.items[0].id}`, "admin")).status).toBe(200);
    expect((await crewLine()).otherPayCents).toBe(0);
  });
});

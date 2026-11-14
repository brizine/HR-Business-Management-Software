/** Pay rate history: raises from a date, payroll at the rate in effect each day, approved periods kept as approved. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { runScheduledChecks } from "../src/lib/jobs";
import { setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@rates.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
/** 8am-4pm Chicago (CST, UTC-6) on a winter day. */
const shift = (day: string) => ({ employeeId: ID.crew, clockIn: `${day}T14:00:00.000Z`, clockOut: `${day}T22:00:00.000Z` });
const preview = async (from: string, to: string) => ((await call("GET", `/payroll/preview?periodStart=${from}&periodEnd=${to}`, "owner")).body as any[]).find((l) => l.employeeId === ID.crew);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Rates Co", firstName: "Rae", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["crew", "employee"], ["lead", "manager"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role, payType: "hourly", payRateCents: 1800, startDate: "2026-01-05" });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  for (const d of ["2026-02-02", "2026-03-02", "2026-03-04"]) expect((await call("POST", "/time/entries", "owner", shift(d))).status).toBe(200);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("pay rate history", () => {
  it("starts with the current pay; managers see it, only admins add to it", async () => {
    const hist = await call("GET", `/employees/${ID.crew}/pay-rates`, "lead");
    expect(hist.body).toHaveLength(1);
    expect(hist.body[0]).toMatchObject({ payRateCents: 1800, current: true });
    expect((await call("GET", `/employees/${ID.crew}/pay-rates`, "crew")).status).toBe(403);
    expect((await call("POST", `/employees/${ID.crew}/pay-rates`, "lead", { effectiveDate: "2026-03-04", payType: "hourly", payRateCents: 2000 })).status).toBe(403);
  });

  it("a raise applies from its date: earlier pay periods keep the old rate", async () => {
    const raise = await call("POST", `/employees/${ID.crew}/pay-rates`, "owner", { effectiveDate: "2026-03-04", payType: "hourly", payRateCents: 2000, note: "Annual raise" });
    expect(raise.status).toBe(200);
    expect((await call("GET", `/employees/${ID.crew}`, "owner")).body.payRateCents).toBe(2000); // today's pay

    const feb = await preview("2026-02-01", "2026-02-14");
    expect(feb).toMatchObject({ payRateCents: 1800, estimatedGrossCents: 8 * 1800, payNote: null });
    // Mid-period raise: Monday at $18, Wednesday at $20.
    const mar = await preview("2026-03-01", "2026-03-14");
    expect(mar).toMatchObject({ payRateCents: 2000, estimatedGrossCents: 8 * 1800 + 8 * 2000 });
    expect(mar.payNote).toBe("$18.00/hr, then $20.00/hr from Mar 4");
    const csv = await app.inject({ method: "GET", url: "/payroll/export.csv?periodStart=2026-03-01&periodEnd=2026-03-14", headers: { authorization: `Bearer ${T.owner}` } });
    expect(csv.body.split("\n")[0]).toContain("Pay Changes In Period");
    expect(csv.body).toContain("$18.00/hr, then $20.00/hr from Mar 4");
  });

  it("editing pay on the profile records a dated change; a future date waits for its day", async () => {
    const res = await call("PATCH", `/employees/${ID.crew}`, "owner", { payRateCents: 2200, payEffectiveDate: "2027-01-04" });
    expect(res.status).toBe(200);
    expect(res.body.payRateCents).toBe(2000); // not yet
    const hist = (await call("GET", `/employees/${ID.crew}/pay-rates`, "owner")).body;
    expect(hist.map((r: any) => [r.effectiveDate, r.payRateCents, r.upcoming])).toEqual([["2027-01-04", 2200, true], ["2026-03-04", 2000, false], ["2026-01-05", 1800, false]]);
    // On the day, the scheduled checks make it the current pay.
    await runScheduledChecks(new Date("2027-01-04T18:00:00Z"));
    expect((await call("GET", `/employees/${ID.crew}`, "owner")).body.payRateCents).toBe(2200);
  });

  it("an approved pay period keeps its figures until it's reopened", async () => {
    await call("PUT", "/pay-periods/schedule", "owner", { frequency: "weekly", anchorDate: "2026-03-02", paydayOffsetDays: 5, approverIds: [ID.owner] });
    await runScheduledChecks(new Date("2026-03-09T18:00:00Z"));
    const period = (await call("GET", "/pay-periods", "owner")).body.periods.find((p: any) => p.periodStart === "2026-03-02");
    expect((await call("POST", `/pay-periods/${period.id}/approve`, "owner", {})).body).toMatchObject({ status: "approved", locked: true });
    const gross = async () => (await call("GET", `/pay-periods/${period.id}`, "owner")).body.lines.find((l: any) => l.employeeId === ID.crew).estimatedGrossCents;
    expect(await gross()).toBe(8 * 1800 + 8 * 2000);

    // A correction reaching back into it: the approved figures stay, with a heads-up.
    const fix = await call("POST", `/employees/${ID.crew}/pay-rates`, "owner", { effectiveDate: "2026-03-02", payType: "hourly", payRateCents: 2500 });
    expect(fix.body.warning).toMatch(/keep the figures they were approved with/);
    expect(await gross()).toBe(8 * 1800 + 8 * 2000);
    expect((await call("GET", "/pay-periods", "owner")).body.periods.find((p: any) => p.id === period.id)).toMatchObject({ locked: true });
    expect((await call("GET", "/pay-periods", "owner")).body.periods[0].approvedLines).toBeUndefined();

    // Reopened, it's worked out again: Monday at $25, Wednesday at $20.
    await call("POST", `/pay-periods/${period.id}/reopen`, "owner", {});
    expect(await gross()).toBe(8 * 2500 + 8 * 2000);
  });

  it("a rate entered by mistake can be removed, but not the last one", async () => {
    const hist = (await call("GET", `/employees/${ID.lead}/pay-rates`, "owner")).body;
    expect(hist).toHaveLength(1);
    // The only rate isn't even stored yet (no changes so far): nothing to remove.
    const added = await call("POST", `/employees/${ID.lead}/pay-rates`, "owner", { effectiveDate: "2026-06-01", payType: "hourly", payRateCents: 2100 });
    expect(added.status).toBe(200);
    const rows = (await call("GET", `/employees/${ID.lead}/pay-rates`, "owner")).body;
    expect(rows).toHaveLength(2);
    expect((await call("DELETE", `/employees/${ID.lead}/pay-rates/${rows[0].id}`, "owner")).status).toBe(200);
    const left = (await call("GET", `/employees/${ID.lead}/pay-rates`, "owner")).body;
    expect(left).toHaveLength(1);
    expect((await call("DELETE", `/employees/${ID.lead}/pay-rates/${left[0].id}`, "owner")).status).toBe(400);
    expect((await call("GET", `/employees/${ID.lead}`, "owner")).body.payRateCents).toBe(1800);
  });
});

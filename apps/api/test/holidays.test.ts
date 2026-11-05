/** Paid holidays: the list and rules, who sees and edits them, and holiday pay in payroll. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@holiday.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.body };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Holiday Co", firstName: "Hal", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  const people: [string, string, string][] = [
    ["full", "full_time", "2026-01-05"],
    ["part", "part_time", "2026-01-05"],
    ["newbie", "full_time", "2026-06-20"], // still in the 30-day waiting period on July 3
    ["temp", "seasonal", "2026-01-05"],
  ];
  for (const [who, employmentType, startDate] of people) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role: "employee", employmentType, startDate, payType: "hourly", payRateCents: 2000 });
    expect(e.status).toBe(200);
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("paid holidays", () => {
  it("admins add holidays (by rule or from the common list); everyone sees them", async () => {
    const added = await call("POST", "/holidays/presets", "owner", { keys: ["independence", "thanksgiving", "black_friday"], hours: 8 });
    expect(added.body).toEqual({ added: 3 });
    // Adding again skips ones already on the list.
    expect((await call("POST", "/holidays/presets", "owner", { keys: ["independence"] })).body).toEqual({ added: 0 });
    const custom = await call("POST", "/holidays", "owner", { name: "Company picnic", rule: { kind: "once", date: "2026-08-14" }, hours: 4, observe: "none" });
    expect(custom.status).toBe(200);
    expect((await call("POST", "/holidays", "full", { name: "My birthday", rule: { kind: "fixed", month: 3, day: 3 }, hours: 8 })).status).toBe(403);
    expect((await call("POST", "/holidays", "owner", { name: "Bad", rule: { kind: "nth", month: 13, weekday: 1, nth: 1 }, hours: 8 })).status).toBe(400);

    const seen = await call("GET", "/holidays?from=2026-07-01&to=2026-12-31", "full");
    expect(seen.status).toBe(200);
    // July 4, 2026 is a Saturday: observed Friday July 3.
    expect(seen.body.upcoming.map((u: any) => [u.name, u.observed])).toEqual([
      ["Independence Day", "2026-07-03"],
      ["Company picnic", "2026-08-14"],
      ["Thanksgiving Day", "2026-11-26"],
      ["Day after Thanksgiving", "2026-11-27"],
    ]);
    expect(seen.body.rules).toMatchObject({ eligibleTypes: ["full_time"], waitingDays: 0 });

    // Editing and turning one off.
    await call("PUT", `/holidays/${custom.body.id}`, "owner", { name: "Company picnic", rule: { kind: "once", date: "2026-08-14" }, hours: 4, observe: "none", active: false });
    expect((await call("GET", "/holidays?from=2026-08-01&to=2026-08-31", "full")).body.upcoming).toEqual([]);
    expect((await call("DELETE", `/holidays/${custom.body.id}`, "full")).status).toBe(403);
    expect((await call("DELETE", `/holidays/${custom.body.id}`, "owner")).status).toBe(200);
  });

  it("pays eligible people holiday hours, and a premium for working the holiday", async () => {
    const rules = await call("PUT", "/holidays/rules", "owner", { eligibleTypes: ["full_time", "part_time"], waitingDays: 30, partTimeShare: 0.5, workedMultiplier: 1.5 });
    expect(rules.status).toBe(200);
    expect((await call("PUT", "/holidays/rules", "full", rules.body)).status).toBe(403);

    // "full" works 4 hours on the observed holiday (Friday July 3, 9am–1pm Central).
    await call("POST", "/time/clock-in", "full", {});
    await call("POST", "/time/clock-out", "full", {});
    const entry = ((await call("GET", "/time/entries", "full")).body as any[])[0];
    await call("PATCH", `/time/entries/${entry.id}`, "owner", { clockIn: "2026-07-03T14:00:00.000Z", clockOut: "2026-07-03T18:00:00.000Z" });

    const preview = (await call("GET", "/payroll/preview?periodStart=2026-06-29&periodEnd=2026-07-05", "owner")).body as any[];
    const line = (who: string) => preview.find((l) => l.employeeId === ID[who]);
    expect(line("full")).toMatchObject({ totalHours: 4, holidayHours: 8, holidayWorkedHours: 4 });
    // (4 worked + 8 holiday + 4 × 0.5 premium) × $20
    expect(line("full").estimatedGrossCents).toBe(28000);
    expect(line("part")).toMatchObject({ holidayHours: 4, estimatedGrossCents: 8000 });
    expect(line("newbie").holidayHours).toBe(0);
    expect(line("temp").holidayHours).toBe(0);

    // No holiday in the next week.
    const next = (await call("GET", "/payroll/preview?periodStart=2026-07-06&periodEnd=2026-07-12", "owner")).body as any[];
    expect(next.find((l) => l.employeeId === ID.full).holidayHours).toBe(0);

    const csv = await call("GET", "/payroll/export.csv?periodStart=2026-06-29&periodEnd=2026-07-05", "owner");
    expect(csv.body).toContain("Holiday Hours");
  });

  it("with the rule on: pays only if they worked (or had approved time off) the scheduled day before and after", async () => {
    await call("PUT", "/holidays/rules", "owner", { eligibleTypes: ["full_time", "part_time"], waitingDays: 30, partTimeShare: 0.5, workedMultiplier: 1.5, requireWorkAround: true });
    // Both are scheduled Thursday July 2 and Monday July 6, around the Friday July 3 holiday.
    for (const who of ["full", "part"]) {
      for (const [s, e] of [["2026-07-02T13:00:00.000Z", "2026-07-02T21:00:00.000Z"], ["2026-07-06T13:00:00.000Z", "2026-07-06T21:00:00.000Z"]]) {
        expect((await call("POST", "/shifts", "owner", { employeeId: ID[who], startsAt: s, endsAt: e })).status).toBe(200);
      }
    }
    await call("POST", "/shifts/publish", "owner", { from: "2026-06-29T00:00:00.000Z", to: "2026-07-13T00:00:00.000Z" });

    // "part" works both days.
    for (const [s, e] of [["2026-07-02T13:00:00.000Z", "2026-07-02T17:00:00.000Z"], ["2026-07-06T13:00:00.000Z", "2026-07-06T17:00:00.000Z"]]) {
      await call("POST", "/time/clock-in", "part", {});
      await call("POST", "/time/clock-out", "part", {});
      const entry = ((await call("GET", "/time/entries", "part")).body as any[]).find((x: any) => !x.clockIn.startsWith("2026-07"));
      await call("PATCH", `/time/entries/${entry.id}`, "owner", { clockIn: s, clockOut: e });
    }
    const period = "/payroll/preview?periodStart=2026-06-29&periodEnd=2026-07-05";
    let preview = (await call("GET", period, "owner")).body as any[];
    const line = (who: string) => preview.find((l) => l.employeeId === ID[who]);
    expect(line("part")).toMatchObject({ holidayHours: 4, holidayNotes: [] });
    // "full" worked the holiday itself but neither scheduled day around it.
    expect(line("full").holidayHours).toBe(0);
    expect(line("full").holidayNotes[0]).toMatch(/No holiday pay for Independence Day: didn't work the scheduled day before \(Thu, Jul 2\) and the scheduled day after \(Mon, Jul 6\)/);

    // Approved time off on those days counts.
    const policy = await call("POST", "/pto/policies", "owner", { name: "PTO" });
    await call("POST", "/pto/adjustments", "owner", { employeeId: ID.full, policyId: policy.body.id, hours: 40, reason: "grant" });
    for (const d of ["2026-07-02", "2026-07-06"]) {
      const r = await call("POST", "/pto/requests", "full", { policyId: policy.body.id, startDate: d, endDate: d, hours: 8 });
      expect(r.status).toBe(200);
      await call("POST", `/pto/requests/${r.body.id}/decide`, "owner", { status: "approved" });
    }
    preview = (await call("GET", period, "owner")).body as any[];
    expect(line("full")).toMatchObject({ holidayHours: 8, holidayNotes: [] });
  });
});

/**
 * End-to-end API tests against a real Postgres database (DATABASE_URL).
 * Each run signs up a fresh company, so tests do not interfere with each other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
let ownerToken: string;
let employeeToken: string;
let employeeId: string;
const suffix = Date.now();

async function call(method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.body };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport(null);
  setSmsTransport(null);
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Test Co",
    firstName: "Owen",
    lastName: "Owner",
    email: `owner-${suffix}@test.dev`,
    password: "password123",
  });
  expect(signup.status).toBe(200);
  ownerToken = signup.body.token;

  const emp = await call("POST", "/employees", ownerToken, {
    firstName: "Eve",
    lastName: "Employee",
    email: `eve-${suffix}@test.dev`,
    payRateCents: 2000,
    password: "password123",
  });
  expect(emp.status).toBe(200);
  employeeId = emp.body.id;
  const login = await call("POST", "/auth/login", undefined, { email: `eve-${suffix}@test.dev`, password: "password123" });
  employeeToken = login.body.token;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("CORS", () => {
  it("lets the web app send every method it uses", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/employees/x",
        headers: { origin: "http://localhost:3000", "access-control-request-method": method },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-methods"]).toContain(method);
    }
  });
});

describe("auth & permissions", () => {
  it("rejects bad passwords and unauthenticated calls", async () => {
    expect((await call("POST", "/auth/login", undefined, { email: `eve-${suffix}@test.dev`, password: "nope" })).status).toBe(401);
    expect((await call("GET", "/employees")).status).toBe(401);
  });

  it("hides pay from employees and blocks admin actions", async () => {
    const list = await call("GET", "/employees", employeeToken);
    expect(list.body[0]).not.toHaveProperty("payRateCents");
    expect(list.body[0]).not.toHaveProperty("passwordHash");
    const create = await call("POST", "/employees", employeeToken, { firstName: "X", lastName: "Y", email: `x-${suffix}@t.dev` });
    expect(create.status).toBe(403);
  });

  it("validates input", async () => {
    const res = await call("POST", "/employees", ownerToken, { firstName: "" });
    expect(res.status).toBe(400);
  });
});

describe("time clock", () => {
  it("clocks in and out once at a time", async () => {
    expect((await call("POST", "/time/clock-in", employeeToken, { lat: 30.27, lng: -97.74 })).status).toBe(200);
    expect((await call("POST", "/time/clock-in", employeeToken, {})).status).toBe(409);
    const who = await call("GET", "/time/who-is-in", ownerToken);
    expect(who.body.map((w: { employeeId: string }) => w.employeeId)).toContain(employeeId);
    const out = await call("POST", "/time/clock-out", employeeToken, {});
    expect(out.status).toBe(200);
    expect(out.body.clockOut).toBeTruthy();
  });

  it("lets managers fix punches and builds timesheets with overtime", async () => {
    const entries = await call("GET", "/time/entries", employeeToken);
    const id = entries.body[0].id;
    // 45 hours in one entry -> 5 hours overtime.
    const fixed = await call("PATCH", `/time/entries/${id}`, ownerToken, {
      clockIn: "2026-06-01T08:00:00.000Z",
      clockOut: "2026-06-03T05:00:00.000Z",
    });
    expect(fixed.status).toBe(200);
    const sheets = await call("GET", "/time/timesheets?from=2026-06-01&to=2026-06-08", ownerToken);
    const mine = sheets.body.find((s: { employeeId: string }) => s.employeeId === employeeId);
    expect(mine).toMatchObject({ regularHours: 40, overtimeHours: 5 });
  });
});

describe("payroll", () => {
  it("previews and exports CSV", async () => {
    const preview = await call("GET", "/payroll/preview?periodStart=2026-06-01&periodEnd=2026-06-07", ownerToken);
    const line = preview.body.find((l: { employeeId: string }) => l.employeeId === employeeId);
    // 40h * $20 + 5h * $30
    expect(line.estimatedGrossCents).toBe(95000);
    const csv = await call("GET", "/payroll/export.csv?periodStart=2026-06-01&periodEnd=2026-06-07", ownerToken);
    expect(csv.status).toBe(200);
    expect(csv.body).toContain("Eve,Employee");
    expect(csv.body).toContain("950.00");
  });

  it("requires a connected provider to submit", async () => {
    const res = await call("POST", "/payroll/submit", ownerToken, { periodStart: "2026-06-01", periodEnd: "2026-06-07" });
    expect(res.status).toBe(400);
    expect((await call("GET", "/payroll/preview?periodStart=2026-06-01&periodEnd=2026-06-07", employeeToken)).status).toBe(403);
  });
});

describe("PTO", () => {
  it("requests, approves and deducts from balance", async () => {
    const policy = await call("POST", "/pto/policies", ownerToken, { name: "PTO" });
    await call("POST", "/pto/adjustments", ownerToken, { employeeId, policyId: policy.body.id, hours: 16 });
    const tooMuch = await call("POST", "/pto/requests", employeeToken, {
      policyId: policy.body.id, startDate: "2026-07-01", endDate: "2026-07-03", hours: 24,
    });
    expect(tooMuch.status).toBe(400);
    const req = await call("POST", "/pto/requests", employeeToken, {
      policyId: policy.body.id, startDate: "2026-07-01", endDate: "2026-07-01", hours: 8,
    });
    expect(req.status).toBe(200);
    expect((await call("POST", `/pto/requests/${req.body.id}/decide`, employeeToken, { status: "approved" })).status).toBe(403);
    const ok = await call("POST", `/pto/requests/${req.body.id}/decide`, ownerToken, { status: "approved" });
    expect(ok.body.status).toBe("approved");
    const bal = await call("GET", "/pto/balances", employeeToken);
    expect(bal.body.find((b: { policyId: string }) => b.policyId === policy.body.id).balanceHours).toBe(8);
  });
});

describe("hiring & onboarding", () => {
  it("moves an applicant from public application to onboarding employee", async () => {
    const job = await call("POST", "/jobs", ownerToken, { title: "Driver" });
    const me = await call("GET", "/auth/me", ownerToken);
    const board = await call("GET", `/public/${me.body.company.id}/jobs`);
    expect(board.body.jobs.map((j: { id: string }) => j.id)).toContain(job.body.id);

    await call("POST", `/public/jobs/${job.body.id}/apply`, undefined, {
      firstName: "Hank", lastName: "Hire", email: `hank-${suffix}@test.dev`,
    });
    const applicants = await call("GET", `/applicants?jobId=${job.body.id}`, ownerToken);
    expect(applicants.body).toHaveLength(1);

    const tpl = await call("POST", "/onboarding/templates", ownerToken, {
      name: "Basic", tasks: [{ title: "W-4" }, { title: "Safety walkthrough", assignee: "manager" }],
    });
    const hired = await call("POST", `/applicants/${applicants.body[0].id}/hire`, ownerToken, {
      onboardingTemplateId: tpl.body.id, startDate: "2026-11-02",
    });
    expect(hired.body.status).toBe("onboarding");

    const tasks = await call("GET", `/onboarding/tasks?employeeId=${hired.body.id}`, ownerToken);
    expect(tasks.body).toHaveLength(2);
    for (const t of tasks.body) await call("POST", `/onboarding/tasks/${t.id}/complete`, ownerToken);
    const emp = await call("GET", `/employees/${hired.body.id}`, ownerToken);
    expect(emp.body.status).toBe("active");
  });
});

describe("fleet maintenance", () => {
  it("tracks schedules, inspections and work orders end to end", async () => {
    const asset = await call("POST", "/assets", ownerToken, { name: "Truck 1", type: "vehicle", odometer: 10000 });
    expect(asset.status).toBe(200);
    const sched = await call("POST", "/assets/schedules", ownerToken, {
      assetId: asset.body.id, name: "Oil change", intervalMiles: 5000,
    });
    expect(sched.body.due.nextDueOdometer).toBe(15000);

    // Employee logs mileage past the interval -> overdue.
    await call("POST", `/assets/${asset.body.id}/meter`, employeeToken, { odometer: 15200 });
    const due = await call("GET", "/assets/maintenance/due", ownerToken);
    expect(due.body.find((d: { id: string }) => d.id === sched.body.id).due.status).toBe("overdue");

    // Failed inspection auto-creates a work order.
    const insp = await call("POST", "/inspections", employeeToken, {
      assetId: asset.body.id,
      items: [{ item: "Brakes", ok: false, note: "Squealing" }, { item: "Lights", ok: true }],
    });
    expect(insp.body.inspection.passed).toBe(false);
    expect(insp.body.workOrder.priority).toBe("high");

    // Scheduled service work order: complete it and the schedule resets.
    const wo = await call("POST", "/work-orders", ownerToken, {
      assetId: asset.body.id, scheduleId: sched.body.id, title: "Oil change", assignedToId: employeeId,
    });
    expect(wo.body.number).toBeGreaterThan(1000);
    const done = await call("PATCH", `/work-orders/${wo.body.id}`, employeeToken, {
      status: "completed", partsCostCents: 4500, laborCostCents: 6000, completedOdometer: 15250,
    });
    expect(done.status).toBe(200);
    const detail = await call("GET", `/assets/${asset.body.id}`, ownerToken);
    const s = detail.body.schedules.find((x: { id: string }) => x.id === sched.body.id);
    expect(s.lastServiceOdometer).toBe(15250);
    expect(s.due.status).toBe("ok");
    expect(detail.body.totalMaintenanceCostCents).toBe(10500);

    const dash = await call("GET", "/dashboard", ownerToken);
    expect(dash.body.fleet.openWorkOrders).toBe(1);
  });
});

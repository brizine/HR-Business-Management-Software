/**
 * Notifications: inbox, device registration, event-triggered pushes and
 * scheduled alerts. Push delivery goes to an in-memory fake transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { db, pool } from "../src/db";
import { maintenanceSchedules, pushTokens, timeEntries } from "../src/db/schema";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport, type PushMessage, type PushTicket } from "../src/lib/notify";

let app: FastifyInstance;
let sent: PushMessage[] = [];
let deadTokens = new Set<string>();
const suffix = Date.now();
const tokens = { owner: `ExponentPushToken[owner-${suffix}]`, tech: `ExponentPushToken[tech-${suffix}]` };
let owner: { token: string; id: string };
let tech: { token: string; id: string };

async function call(method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.json() };
}

/** Lets background notifications finish, then returns pushes sent to `token`. */
async function pushesTo(token: string) {
  await flushNotifications();
  return sent.filter((m) => m.to === token);
}

beforeAll(async () => {
  setPushTransport({
    send: async (messages) => {
      sent.push(...messages);
      return messages.map<PushTicket>((m) =>
        deadTokens.has(m.to)
          ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
          : { status: "ok", id: "ticket" },
      );
    },
  });
  setEmailTransport(null);
  setSmsTransport(null);
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Notify Co", firstName: "Olga", lastName: "Owner", email: `olga-${suffix}@test.dev`, password: "password123",
  });
  owner = { token: signup.body.token, id: signup.body.user.id };
  const emp = await call("POST", "/employees", owner.token, {
    firstName: "Ted", lastName: "Tech", email: `ted-${suffix}@test.dev`, password: "password123", managerId: owner.id,
  });
  const login = await call("POST", "/auth/login", undefined, { email: `ted-${suffix}@test.dev`, password: "password123" });
  tech = { token: login.body.token, id: emp.body.id };

  expect((await call("POST", "/notifications/devices", owner.token, { token: tokens.owner, platform: "ios" })).status).toBe(200);
  expect((await call("POST", "/notifications/devices", tech.token, { token: tokens.tech, platform: "android" })).status).toBe(200);
});

beforeEach(async () => {
  // Let notifications from the previous test land before resetting.
  await flushNotifications();
  sent = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("devices", () => {
  it("rejects tokens that are not Expo push tokens", async () => {
    expect((await call("POST", "/notifications/devices", tech.token, { token: "abc", platform: "ios" })).status).toBe(400);
  });

  it("moves a device to whoever signs in on it", async () => {
    const shared = `ExponentPushToken[shared-${suffix}]`;
    await call("POST", "/notifications/devices", owner.token, { token: shared, platform: "ios" });
    await call("POST", "/notifications/devices", tech.token, { token: shared, platform: "ios" });
    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, shared));
    expect(row.employeeId).toBe(tech.id);
    await call("POST", "/notifications/devices/remove", tech.token, { token: shared });
    expect(await db.select().from(pushTokens).where(eq(pushTokens.token, shared))).toHaveLength(0);
  });
});

describe("event notifications", () => {
  it("time-off request notifies the manager; the decision notifies the employee", async () => {
    const policy = await call("POST", "/pto/policies", owner.token, { name: "PTO" });
    await call("POST", "/pto/adjustments", owner.token, { employeeId: tech.id, policyId: policy.body.id, hours: 40 });
    const req = await call("POST", "/pto/requests", tech.token, {
      policyId: policy.body.id, startDate: "2026-12-24", endDate: "2026-12-24", hours: 8,
    });

    const toOwner = await pushesTo(tokens.owner);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0].title).toBe("Time-off request from Ted Tech");
    expect(toOwner[0].data.link).toEqual({ screen: "pto" });
    expect(await pushesTo(tokens.tech)).toHaveLength(0);

    await call("POST", `/pto/requests/${req.body.id}/decide`, owner.token, { status: "approved" });
    const toTech = await pushesTo(tokens.tech);
    expect(toTech.map((m) => m.title)).toEqual(["Time off approved"]);
  });

  it("failed inspection alerts managers and assignment alerts the technician", async () => {
    const asset = await call("POST", "/assets", owner.token, { name: "Truck 9", type: "vehicle" });
    await call("POST", "/inspections", tech.token, { assetId: asset.body.id, items: [{ item: "Brakes", ok: false }] });
    const alert = (await pushesTo(tokens.owner)).find((m) => m.title === "Truck 9 failed inspection");
    expect(alert?.data.link).toMatchObject({ screen: "work-order", assetId: asset.body.id });

    sent = [];
    const wo = await call("POST", "/work-orders", owner.token, { assetId: asset.body.id, title: "Fix brakes", assignedToId: tech.id });
    expect((await pushesTo(tokens.tech))[0].title).toBe(`Work order #${wo.body.number} assigned to you`);

    // The technician finishing their own job doesn't notify themselves; the reporter (owner) hears about it.
    sent = [];
    await call("PATCH", `/work-orders/${wo.body.id}`, tech.token, { status: "completed" });
    expect(await pushesTo(tokens.tech)).toHaveLength(0);
    expect((await pushesTo(tokens.owner))[0].title).toBe(`Work order #${wo.body.number} completed`);
  });

  it("stores every notification in the inbox", async () => {
    const inbox = await call("GET", "/notifications", tech.token);
    expect(inbox.body.unread).toBeGreaterThanOrEqual(2);
    await call("POST", `/notifications/${inbox.body.items[0].id}/read`, tech.token);
    expect((await call("GET", "/notifications/unread-count", tech.token)).body.unread).toBe(inbox.body.unread - 1);
    // Someone else's notification can't be marked read.
    expect((await call("POST", `/notifications/${inbox.body.items[1].id}/read`, owner.token)).status).toBe(404);
    await call("POST", "/notifications/read-all", tech.token);
    expect((await call("GET", "/notifications/unread-count", tech.token)).body.unread).toBe(0);
  });

  it("drops tokens the push service reports as unregistered", async () => {
    deadTokens.add(tokens.tech);
    const asset = await call("POST", "/assets", owner.token, { name: "Mower", type: "small_equipment" });
    await call("POST", "/work-orders", owner.token, { assetId: asset.body.id, title: "Sharpen", assignedToId: tech.id });
    await flushNotifications();
    expect(await db.select().from(pushTokens).where(eq(pushTokens.token, tokens.tech))).toHaveLength(0);
    deadTokens.delete(tokens.tech);
    await call("POST", "/notifications/devices", tech.token, { token: tokens.tech, platform: "android" });
  });
});

describe("scheduled checks", () => {
  it("announces overdue maintenance once per service interval", async () => {
    const asset = await call("POST", "/assets", owner.token, {
      name: "Loader", type: "heavy_equipment", engineHours: 1000, assignedEmployeeId: tech.id,
    });
    const sched = await call("POST", "/assets/schedules", owner.token, { assetId: asset.body.id, name: "Grease", intervalHours: 50 });
    await call("POST", `/assets/${asset.body.id}/meter`, tech.token, { engineHours: 1060 });

    await runScheduledChecks();
    const first = (await pushesTo(tokens.owner)).filter((m) => m.title.startsWith("Loader"));
    expect(first.map((m) => m.title)).toEqual(["Loader: Grease overdue"]);
    expect((await pushesTo(tokens.tech)).some((m) => m.title === "Loader: Grease overdue")).toBe(true);

    sent = [];
    await runScheduledChecks();
    expect((await pushesTo(tokens.owner)).filter((m) => m.title.startsWith("Loader"))).toHaveLength(0);

    // After the next service the alert re-arms.
    await db.update(maintenanceSchedules).set({ lastServiceHours: 1060 }).where(eq(maintenanceSchedules.id, sched.body.id));
    await call("POST", `/assets/${asset.body.id}/meter`, tech.token, { engineHours: 1120 });
    await runScheduledChecks();
    expect((await pushesTo(tokens.owner)).filter((m) => m.title.startsWith("Loader"))).toHaveLength(1);
  });

  it("reminds people who forgot to clock out, and their manager", async () => {
    await call("POST", "/time/clock-in", tech.token, {});
    await db
      .update(timeEntries)
      .set({ clockIn: new Date(Date.now() - 13 * 3_600_000) })
      .where(eq(timeEntries.employeeId, tech.id));
    await runScheduledChecks();
    expect((await pushesTo(tokens.tech)).map((m) => m.title)).toContain("Still clocked in?");
    expect((await pushesTo(tokens.owner)).map((m) => m.title)).toContain("Ted Tech may have forgotten to clock out");
  });

  it("warns about registrations expiring within 30 days", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await call("POST", "/assets", owner.token, { name: "Trailer 4", type: "trailer", registrationExpires: soon });
    await runScheduledChecks();
    expect((await pushesTo(tokens.owner)).map((m) => m.title)).toContain("Trailer 4: registration expiring");
  });
});

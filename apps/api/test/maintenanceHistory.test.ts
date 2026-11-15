/** Maintenance history: completed work orders with meters at completion, and past services added by hand. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@history.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "History Co", firstName: "Hal", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["mech", "employee"]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: "Mo", lastName: "Mechanic", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("maintenance history", () => {
  it("lists completed work orders, newest first, with the meters at completion", async () => {
    const truck = await call("POST", "/assets", "owner", { name: "F-250", type: "truck", odometer: 42000 });
    ID.truck = truck.body.id;
    const oil = await call("POST", "/assets/schedules", "owner", { assetId: ID.truck, name: "Oil change", intervalMiles: 5000 });
    ID.oil = oil.body.id;
    const wo = await call("POST", "/work-orders", "owner", { assetId: ID.truck, scheduleId: ID.oil, title: "Oil change", assignedToId: ID.mech });
    await call("POST", "/work-orders", "owner", { assetId: ID.truck, title: "Still open" });
    const done = await call("PATCH", `/work-orders/${wo.body.id}`, "mech", { status: "completed", completedOdometer: 42150, partsCostCents: 4500, laborCostCents: 6000, vendor: "Main St. Auto", resolutionNotes: "5W-30" });
    expect(done.body).toMatchObject({ completedOdometer: 42150, completedHours: null });

    const h = await call("GET", `/assets/${ID.truck}/history`, "mech");
    expect(h.status).toBe(200);
    expect(h.body).toHaveLength(1);
    expect(h.body[0]).toMatchObject({ title: "Oil change", odometer: 42150, vendor: "Main St. Auto", doneBy: "Mo Mechanic", partsCostCents: 4500, laborCostCents: 6000, notes: "5W-30", kind: "scheduled", scheduleName: "Oil change" });
  });

  it("adds past services (managers only), dated then, and resets the schedule when newer", async () => {
    const past = { assetId: ID.truck, title: "Brake pads (front)", date: "2025-06-10", odometer: 31000, vendor: "Brake Shop", partsCostCents: 12000, laborCostCents: 8000, notes: "Rotors OK" };
    expect((await call("POST", "/work-orders/past", "mech", past)).status).toBe(403);
    expect((await call("POST", "/work-orders/past", "owner", { ...past, date: "2099-01-01" })).status).toBe(400);
    const added = await call("POST", "/work-orders/past", "owner", past);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ status: "completed", completedOdometer: 31000, priority: "low" });

    // An older oil change doesn't move the schedule back; history is newest first.
    await call("POST", "/work-orders/past", "owner", { assetId: ID.truck, scheduleId: ID.oil, title: "Oil change", date: "2025-01-05", odometer: 27000 });
    const h = (await call("GET", `/assets/${ID.truck}/history`, "owner")).body;
    expect(h.map((x: any) => x.title)).toEqual(["Oil change", "Brake pads (front)", "Oil change"]);
    expect(h[1]).toMatchObject({ odometer: 31000, kind: "repair", completedAt: "2025-06-10T12:00:00.000Z" });
    const asset = (await call("GET", `/assets/${ID.truck}`, "owner")).body;
    expect(asset.schedules[0].lastServiceOdometer).toBe(42150);
    expect(asset.odometer).toBe(42150);
    expect(asset.totalMaintenanceCostCents).toBe(4500 + 6000 + 12000 + 8000);

    // A schedule from another asset is refused.
    const mower = await call("POST", "/assets", "owner", { name: "Mower", type: "equipment" });
    expect((await call("POST", "/work-orders/past", "owner", { assetId: mower.body.id, scheduleId: ID.oil, title: "x", date: "2025-01-01" })).status).toBe(404);
  });
});

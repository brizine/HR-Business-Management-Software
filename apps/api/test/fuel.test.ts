/** Fuel log: fill-ups, receipts, who can change them, the fleet cost report and total cost of ownership. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@fuel.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Fuel Co", firstName: "Fay", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["driver", "employee"], ["other", "employee"]] as const) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  const truck = await call("POST", "/assets", "owner", { name: "CNG Truck", type: "truck", odometer: 10000, purchasePriceCents: 3_000_000, purchaseDate: "2024-01-01", purchaseOdometer: 5000 });
  ID.truck = truck.body.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("fuel log", () => {
  it("drivers log fill-ups (CNG in GGE); the odometer updates the asset", async () => {
    const fill = (who: string, d: number, qty: number, cost: number, odometer: number, more = {}) =>
      call("POST", "/fuel", who, { assetId: ID.truck, date: daysAgo(d), fuelType: "cng", quantity: qty, totalCostCents: cost, odometer, ...more });
    expect((await fill("driver", 20, 15, 4500, 10000)).status).toBe(200);
    const second = await fill("driver", 10, 20, 6000, 10300, { vendor: "Clean Energy", notes: "Station 4" });
    expect(second.body).toMatchObject({ fuelType: "cng", quantity: 20, fullTank: true, vendor: "Clean Energy", hasReceipt: false });
    expect(second.body.receiptKey).toBeUndefined();
    ID.second = second.body.id;
    await fill("driver", 2, 25, 7500, 10700);
    await call("POST", "/fuel", "driver", { assetId: ID.truck, date: daysAgo(2), fuelType: "def", quantity: 2.5, totalCostCents: 1000 });
    expect((await call("GET", `/assets/${ID.truck}`, "owner")).body).toMatchObject({ odometer: 10700, totalFuelCostCents: 19000 });

    const list = await call("GET", `/fuel?assetId=${ID.truck}`, "other");
    expect(list.body).toHaveLength(4);
    expect(list.body[0]).toMatchObject({ createdBy: "driver Person" });
    expect((await call("POST", "/fuel", "driver", { assetId: ID.truck, date: "2099-01-01", fuelType: "gasoline", quantity: 1, totalCostCents: 1 })).status).toBe(400);
    expect((await call("POST", "/fuel", "driver", { assetId: ID.truck, date: today, fuelType: "kerosene", quantity: 1, totalCostCents: 1 })).status).toBe(400);
  });

  it("the logger (for a day) or a fleet manager can change or remove a fill-up; receipts", async () => {
    expect((await call("PUT", `/fuel/${ID.second}`, "other", { date: daysAgo(10), fuelType: "cng", quantity: 21, totalCostCents: 6000, odometer: 10300 })).status).toBe(403);
    const fixed = await call("PUT", `/fuel/${ID.second}`, "driver", { date: daysAgo(10), fuelType: "cng", quantity: 21, totalCostCents: 6300, odometer: 10300 });
    expect(fixed.body).toMatchObject({ quantity: 21, totalCostCents: 6300 });

    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const boundary = "----fuel";
    const multipart = (type: string) => Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.png"\r\nContent-Type: ${type}\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = (who: string, type = "image/png") => app.inject({ method: "POST", url: `/fuel/${ID.second}/receipt`, payload: multipart(type),
      headers: { authorization: `Bearer ${T[who]}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect((await upload("driver", "text/html")).statusCode).toBe(400);
    expect((await upload("other")).statusCode).toBe(403);
    expect((await upload("driver")).statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: `/fuel/${ID.second}/receipt`, headers: { authorization: `Bearer ${T.owner}` } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.rawPayload.equals(png)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/fuel/${ID.second}/receipt`, headers: { authorization: `Bearer ${T.other}` } })).statusCode).toBe(404);
    expect((await call("GET", `/fuel?assetId=${ID.truck}`, "owner")).body.find((f: any) => f.id === ID.second).hasReceipt).toBe(true);

    const extra = await call("POST", "/fuel", "other", { assetId: ID.truck, date: today, fuelType: "gasoline", quantity: 1, totalCostCents: 100 });
    expect((await call("DELETE", `/fuel/${extra.body.id}`, "driver")).status).toBe(403);
    expect((await call("DELETE", `/fuel/${extra.body.id}`, "owner")).status).toBe(200);
  });

  it("fleet cost report: fuel, economy, cost per mile and total cost of ownership (managers)", async () => {
    expect((await call("GET", `/fuel/report?from=${daysAgo(30)}&to=${today}`, "driver")).status).toBe(403);
    expect((await call("GET", `/fuel/report?from=${today}&to=${daysAgo(30)}`, "owner")).status).toBe(400);
    const r = await call("GET", `/fuel/report?from=${daysAgo(30)}&to=${today}`, "owner");
    expect(r.status).toBe(200);
    const truck = r.body.rows.find((x: any) => x.assetId === ID.truck);
    // 10000 → 10300 on 21 GGE, 10300 → 10700 on 25: 700 mi / 46 GGE.
    expect(truck).toMatchObject({ meter: "odometer", fills: 4, quantity: 61, defQuantity: 2.5, fuelCents: 19300, maintenanceCents: 0 });
    expect(truck.economy).toBeCloseTo(700 / 46);
    expect(truck.tco).toMatchObject({ totalCents: 3_000_000 + 19300, miles: 5700 });
    expect(truck.tco.perMileCents).toBeCloseTo(3_019_300 / 5700);
    expect(r.body.totals.fuelCents).toBe(19300);
  });
});

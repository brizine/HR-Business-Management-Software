/** A property's pin on the map: finding it from the address, moving it by hand, and who may. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setDispatchLocator } from "../src/lib/dispatch";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@pin.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
/** What the address lookup is asked, and what it answers. */
const asked: string[] = [];
let found: { lat: number; lng: number } | null = { lat: 35.2225668, lng: -97.4394777 };

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setDispatchLocator(async (address) => { asked.push(address); return found; });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Pin Co", firstName: "Pia", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Elsewhere Co", firstName: "Eli", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
  ID.cust = (await call("POST", "/customers", "office", { firstName: "Ann", lastName: "Lee", email: email("ann"), property: { street: "1 Oak St", city: "Norman", zip: "73069" } })).body.id;
  ID.prop = (await call("GET", `/customers/${ID.cust}`, "office")).body.properties[0].id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("the property's pin on the map", () => {
  it("is found from the address to start with, without saving anything", async () => {
    asked.length = 0;
    const r = await call("POST", `/properties/${ID.prop}/pin/find`, "office");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ lat: 35.2225668, lng: -97.4394777 });
    expect(asked).toEqual(["1 Oak St, Norman, OK 73069"]);
    expect((await call("GET", `/properties/${ID.prop}`, "office")).body).toMatchObject({ lat: null, lng: null });
    // An address the map services can't find says so, so the office can click the spot instead.
    found = null;
    const none = await call("POST", `/properties/${ID.prop}/pin/find`, "office");
    expect(none.status).toBe(404);
    expect(none.body.error).toMatch(/couldn't be found on the map/);
    found = { lat: 35.2225668, lng: -97.4394777 };
  });

  it("is saved where the office puts it, and stays there when the property's other details change", async () => {
    const r = await call("PUT", `/properties/${ID.prop}/pin`, "office", { lat: 35.22263412345, lng: -97.43951298765 });
    expect(r.status).toBe(200);
    // Kept to about four inches (six decimal places).
    expect(r.body).toEqual({ lat: 35.222634, lng: -97.439513 });
    const p = (await call("GET", `/properties/${ID.prop}`, "office")).body;
    expect(p).toMatchObject({ lat: 35.222634, lng: -97.439513 });
    const edited = await call("PUT", `/properties/${ID.prop}`, "office", { street: "1 Oak St", city: "Norman", state: "OK", zip: "73069", gateCode: "1234", tagIds: [] });
    expect(edited.status).toBe(200);
    expect((await call("GET", `/properties/${ID.prop}`, "office")).body).toMatchObject({ gateCode: "1234", lat: 35.222634, lng: -97.439513 });
    // Moved again.
    expect((await call("PUT", `/properties/${ID.prop}/pin`, "office", { lat: 35.2227, lng: -97.4396 })).body).toEqual({ lat: 35.2227, lng: -97.4396 });
  });

  it("has to be a real place, set by the office, on the company's own property", async () => {
    for (const bad of [{ lat: 91, lng: 0 }, { lat: 35, lng: -181 }, { lat: "35", lng: "-97" }, { lat: 35 }, {}]) expect((await call("PUT", `/properties/${ID.prop}/pin`, "office", bad)).status).toBe(400);
    expect((await call("PUT", `/properties/${ID.prop}/pin`, "tech", { lat: 35, lng: -97 })).status).toBe(403);
    expect((await call("POST", `/properties/${ID.prop}/pin/find`, "tech")).status).toBe(403);
    expect((await call("PUT", `/properties/${ID.prop}/pin`, "other", { lat: 35, lng: -97 })).status).toBe(404);
    expect((await call("POST", `/properties/${ID.prop}/pin/find`, "other")).status).toBe(404);
    expect((await call("GET", `/properties/${ID.prop}`, "office")).body).toMatchObject({ lat: 35.2227, lng: -97.4396 });
  });
});

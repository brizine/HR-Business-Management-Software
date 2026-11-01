/** Permissions: access by area, granted or limited per person; owners always have full access. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@perm.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const allDefault = { people: null, time: null, schedule: null, timeoff: null, documents: null, hiring: null, onboarding: null, payroll: null, fleet: null, wiki: null, spray: null, dashboard: null, company: null };

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Perm Co", firstName: "Pam", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  for (const [who, role] of [["lead", "manager"], ["crew", "employee"], ["clerk", "employee"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("permissions", () => {
  it("only owners (and people given Permissions access) see the page", async () => {
    const list = await call("GET", "/permissions", "owner");
    expect(list.status).toBe(200);
    expect(list.body.areas.map((a: any) => a.key)).toContain("payroll");
    expect(list.body.people.find((p: any) => p.id === ID.owner).managesPermissions).toBe(true);
    expect((await call("GET", "/permissions", "lead")).status).toBe(403);
    expect((await call("GET", "/permissions", "crew")).status).toBe(403);
  });

  it("giving an employee payroll access lets them run payroll, right away", async () => {
    expect((await call("GET", "/payroll/preview?periodStart=2026-10-01&periodEnd=2026-10-07", "crew")).status).toBe(403);
    const saved = await call("PUT", `/permissions/${ID.crew}`, "owner", { areas: { ...allDefault, payroll: "admin" } });
    expect(saved.body.areas).toEqual({ payroll: "admin" });
    expect((await call("GET", "/payroll/preview?periodStart=2026-10-01&periodEnd=2026-10-07", "crew")).status).toBe(200);
    expect((await call("GET", "/auth/me", "crew")).body.access).toEqual({ areas: { payroll: "admin" }, managesPermissions: false });
    // Still basic everywhere else.
    expect((await call("GET", "/dashboard", "crew")).status).toBe(403);
    // Payroll settings stay owner-level.
    expect((await call("PUT", "/payroll/settings", "crew", { weeklyOvertimeThreshold: 40 })).status).toBe(403);
  });

  it("can limit a manager in an area", async () => {
    expect((await call("GET", "/dashboard", "lead")).status).toBe(200);
    await call("PUT", `/permissions/${ID.lead}`, "owner", { areas: { ...allDefault, dashboard: "employee" } });
    expect((await call("GET", "/dashboard", "lead")).status).toBe(403);
    await call("PUT", `/permissions/${ID.lead}`, "owner", { areas: allDefault });
    expect((await call("GET", "/dashboard", "lead")).status).toBe(200);
  });

  it("refuses unsafe changes", async () => {
    expect((await call("PUT", `/permissions/${ID.owner}`, "owner", { areas: { ...allDefault, payroll: "employee" } })).status).toBe(400); // owners can't be limited
    expect((await call("PUT", `/permissions/${ID.crew}`, "owner", { areas: { ...allDefault, people: "owner" } })).status).toBe(400); // Team stops at admin
  });

  it("a permissions manager can manage others, but not owner-level, Permissions access or themselves", async () => {
    await call("PUT", `/permissions/${ID.lead}`, "owner", { areas: allDefault, managesPermissions: true });
    expect((await call("GET", "/permissions", "lead")).status).toBe(200);
    expect((await call("PUT", `/permissions/${ID.clerk}`, "lead", { areas: { ...allDefault, fleet: "manager" } })).status).toBe(200);
    expect((await call("POST", "/assets", "clerk", { name: "Mower 3", type: "equipment" })).status).not.toBe(403);
    expect((await call("PUT", `/permissions/${ID.clerk}`, "lead", { areas: { ...allDefault, company: "owner" } })).status).toBe(403);
    expect((await call("PUT", `/permissions/${ID.clerk}`, "lead", { areas: allDefault, managesPermissions: true })).status).toBe(403);
    expect((await call("PUT", `/permissions/${ID.lead}`, "lead", { areas: { ...allDefault, payroll: "admin" } })).status).toBe(403);
    // Taking Permissions access away works immediately.
    await call("PUT", `/permissions/${ID.lead}`, "owner", { areas: allDefault, managesPermissions: false });
    expect((await call("GET", "/permissions", "lead")).status).toBe(403);
  });
});

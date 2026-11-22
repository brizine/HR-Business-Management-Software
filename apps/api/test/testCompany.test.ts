/** The test company: the owner makes it, people with access switch in and back, and its data stays apart from the real company. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { isUndeliverable } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@testco.test`;
const T: Record<string, string> = {};

async function call(method: string, url: string, token: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Real Co", firstName: "Owen", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", T.owner, { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["admin", "admin"], ["manager", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", T.owner, { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("test company", () => {
  it("only the owner creates it, once", async () => {
    expect((await call("GET", "/auth/test-company", T.admin)).body).toMatchObject({ isTest: false, exists: false, canCreate: false, canOpen: true });
    expect((await call("GET", "/auth/test-company", T.tech)).body).toMatchObject({ canOpen: false });
    expect((await call("POST", "/auth/test-company", T.admin)).status).toBe(403);
    const made = await call("POST", "/auth/test-company", T.owner);
    expect(made.body.name).toBe("Real Co (Test)");
    expect((await call("POST", "/auth/test-company", T.owner)).status).toBe(409);
  });

  it("owners, admins and managers switch in (no password); techs can't", async () => {
    expect((await call("POST", "/auth/test-company/open", T.tech)).status).toBe(403);
    expect((await call("POST", "/auth/test-company/open", T.manager)).status).toBe(200);
    const ownerIn = await call("POST", "/auth/test-company/open", T.owner);
    expect(ownerIn.status).toBe(200);
    expect(ownerIn.body.company).toMatchObject({ name: "Real Co (Test)", isTest: true });
    expect(ownerIn.body.user).toMatchObject({ role: "owner", firstName: "Owen" });
    T.testOwner = ownerIn.body.token;
    const adminIn = await call("POST", "/auth/test-company/open", T.admin);
    expect(adminIn.body.user.role).toBe("admin");
    T.testAdmin = adminIn.body.token;
    // Switching in again reuses the same test sign-in.
    expect((await call("POST", "/auth/test-company/open", T.owner)).body.user.id).toBe(ownerIn.body.user.id);
    expect((await call("GET", "/auth/test-company", T.testOwner)).body).toEqual({ isTest: true, realCompanyName: "Real Co" });
    // The test sign-in can't be used with a password, and its address never gets mail.
    const me = await call("GET", "/auth/me", T.testOwner);
    expect(isUndeliverable(me.body.user.email)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: me.body.user.email, password: "password123" } })).statusCode).toBe(401);
  });

  it("an employee given Customers & billing access can switch in too", async () => {
    const people = await call("GET", "/employees", T.owner);
    const tech = people.body.find((e: { email: string }) => e.email === email("tech"));
    const grant = await call("PUT", `/permissions/${tech.id}`, T.owner, { areas: { customers: "manager" } });
    expect(grant.status).toBe(200);
    expect((await call("POST", "/auth/test-company/open", T.tech)).status).toBe(200);
  });

  it("the sample customers are waiting on the first visit, and stay in the test company", async () => {
    expect((await call("GET", "/crm/sample-customers", T.testOwner)).body.count).toBe(12);
    expect((await call("GET", "/customers", T.testAdmin)).body.total).toBe(12);
    expect((await call("GET", "/customers", T.owner)).body.total).toBe(0);
  });

  it("switching back returns the real sign-in; from the real company it's refused", async () => {
    const back = await call("POST", "/auth/test-company/back", T.testOwner);
    expect(back.body.company).toMatchObject({ name: "Real Co", isTest: false });
    expect(back.body.user.email).toBe(email("owner"));
    expect((await call("POST", "/auth/test-company/back", T.owner)).status).toBe(400);
  });

  it("setting up test books is refused in the real company (and needs Bigcapital connected in the test one)", async () => {
    const real = await call("POST", "/accounting/test-books", T.owner);
    expect(real.status).toBe(400);
    expect(real.body.error).toMatch(/only runs in the test company/);
    const test = await call("POST", "/accounting/test-books", T.testOwner);
    expect(test.status).toBe(400);
    expect(test.body.error).toMatch(/Connect Bigcapital first/);
  });

  it("the owner can delete the test company and everything in it", async () => {
    expect((await call("DELETE", "/auth/test-company", T.admin)).status).toBe(403);
    expect((await call("DELETE", "/auth/test-company", T.owner)).status).toBe(200);
    expect((await call("GET", "/auth/me", T.testOwner)).status).toBe(401);
    expect((await call("GET", "/auth/test-company", T.owner)).body.exists).toBe(false);
  });
});

/** Top bar search: customers and properties only for people with Customers & billing access; people and assets for everyone. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@search.test`;
const T: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Search Co", firstName: "Sue", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("POST", "/employees", "owner", { firstName: "Terry", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" });
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  await call("POST", "/crm/sample-customers", "owner");
  await call("POST", "/assets", "owner", { name: "Prairie Truck", type: "truck" });
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("search", () => {
  it("finds customers, properties, people and assets", async () => {
    const r = await call("GET", "/search?q=prairie", "owner");
    const kinds = r.body.results.map((h: { kind: string; title: string }) => `${h.kind}:${h.title}`);
    expect(kinds).toEqual(expect.arrayContaining(["customer:Prairie Property Management", "asset:Prairie Truck"]));
    const elm = await call("GET", "/search?q=elm%20st", "owner");
    expect(elm.body.results.filter((h: { kind: string }) => h.kind === "property").map((h: { title: string }) => h.title)).toEqual(["215 Elm St", "217 Elm St"]);
    expect((await call("GET", "/search?q=terry", "owner")).body.results[0]).toMatchObject({ kind: "employee", title: "Terry Tech" });
    expect((await call("GET", "/search?q=1006", "owner")).body.results[0]).toMatchObject({ kind: "customer", title: "Prairie Property Management" });
    expect((await call("GET", "/search?q=p", "owner")).body.results).toEqual([]);
  });

  it("techs don't see customers or properties", async () => {
    const r = await call("GET", "/search?q=prairie", "tech");
    expect(r.body.results.map((h: { kind: string }) => h.kind)).toEqual(["asset"]);
  });
});

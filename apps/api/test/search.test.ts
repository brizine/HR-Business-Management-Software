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

  it("finds invoices by number or PO, payments by check number, services and repair orders", async () => {
    const pm = (await call("GET", "/search?q=prairie", "owner")).body.results.find((h: { kind: string }) => h.kind === "customer");
    const inv = await call("POST", "/invoices", "owner", { customerId: pm.id, poNumber: "PO-55321", lines: [{ description: "Spring cleanup", quantity: 1, unitPriceCents: 25000 }] });
    expect(inv.status).toBe(200);
    // A draft has no number yet, but its PO finds it.
    expect((await call("GET", "/search?q=55321", "owner")).body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invoice", title: "Draft invoice", sub: expect.stringContaining("PO PO-55321"), href: `/invoices/${inv.body.id}` }),
    ]));
    const sent = await call("POST", `/invoices/${inv.body.id}/send`, "owner", { via: ["paper"] });
    const n = sent.body.number as number;
    for (const q of [String(n), `%23${n}`, `inv%20${n}`, `Invoice%20%23${n}`]) {
      const hit = (await call("GET", `/search?q=${q}`, "owner")).body.results.find((h: { kind: string }) => h.kind === "invoice");
      expect(hit, q).toMatchObject({ title: `Invoice ${n}`, sub: "Prairie Property Management · $250.00 · sent · PO PO-55321" });
    }
    expect((await call("POST", `/invoices/${inv.body.id}/payments`, "owner", { amountCents: 10000, method: "check", reference: "88417" })).status).toBe(200);
    expect((await call("GET", "/search?q=8841", "owner")).body.results.find((h: { kind: string }) => h.kind === "payment"))
      .toMatchObject({ title: "Check 88417", sub: `$100.00 · Invoice ${n} · Prairie Property Management`, href: `/invoices/${inv.body.id}` });

    await call("POST", "/service-types", "owner", { name: "Grub control round", pricing: "flat", priceCents: 6500 });
    expect((await call("GET", "/search?q=grub", "owner")).body.results.find((h: { kind: string }) => h.kind === "service")).toMatchObject({ title: "Grub control round", href: "/price-list" });

    const truck = (await call("GET", "/search?q=prairie%20truck", "owner")).body.results.find((h: { kind: string }) => h.kind === "asset");
    const wo = await call("POST", "/work-orders", "owner", { assetId: truck.id, title: "Replace hydraulic hose", priority: "high" });
    const woHit = { kind: "workOrder", title: `#${wo.body.number} Replace hydraulic hose`, sub: "Prairie Truck · open", href: `/work-orders?highlight=${wo.body.id}` };
    expect((await call("GET", "/search?q=hydraulic", "owner")).body.results).toContainEqual(expect.objectContaining(woHit));
    // Techs find repair orders too, but no billing records.
    const tech = (await call("GET", "/search?q=hydraulic", "tech")).body.results;
    expect(tech).toContainEqual(expect.objectContaining(woHit));
    expect((await call("GET", `/search?q=${n}`, "tech")).body.results.filter((h: { kind: string }) => ["invoice", "payment", "service", "customer"].includes(h.kind))).toEqual([]);
    expect((await call("GET", "/search?q=8841", "tech")).body.results).toEqual([]);
  });
});

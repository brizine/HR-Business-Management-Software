/** Spray Mix Calculator sheets: everyone views; admins + chosen employees edit; every change is logged. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { computeMix } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@mix.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { companyName: "Mix Co", firstName: "Mia", lastName: "Owner", email: email("owner"), password: "password123" },
  });
  T.owner = signup.json().token;
  for (const who of ["lead", "crew"]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Sprayer", email: email(who), password: "password123" });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  const other = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { companyName: "Other Co", firstName: "O", lastName: "O", email: email("other"), password: "password123" },
  });
  T.other = other.json().token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("spray mixes", () => {
  it("starts from the original spreadsheet (editors only)", async () => {
    expect((await call("POST", "/spray-mixes/template", "crew")).status).toBe(403);
    expect((await call("POST", "/spray-mixes/template", "owner")).status).toBe(200);
    expect((await call("POST", "/spray-mixes/template", "owner")).status).toBe(409);
    const { body } = await call("GET", "/spray-mixes", "crew");
    expect(body.canEdit).toBe(false);
    expect(body.sheets.map((s: any) => [s.name, s.gallonsPerAcre, s.defaultTankGallons, s.products.length])).toEqual([
      ["Truck Mix", 87.12, 75, 16],
      ["Truck 1.5 gal/1000", 65.34, 75, 16],
      ["Backpack 1 gal/1000", 43.56, 4, 16],
      ["Z spray Mix", 11.1, 12, 14],
    ]);
    ID.truck = body.sheets[0].id;
    ID.aquacap = body.sheets[0].products.find((p: any) => p.name === "Aquacap").id;
    // Anyone can calculate a tank from what they're given.
    const tank = computeMix(body.sheets[0], 50).rows.find((r) => r.product.name === "Aquacap")!;
    expect(tank.needed).toBeCloseTo((47.9 * 50) / 87.12, 10);
  });

  it("only admins and chosen employees can change rates", async () => {
    expect((await call("PATCH", `/spray-mixes/products/${ID.aquacap}`, "lead", { ratePerAcre: 50 })).status).toBe(403);
    expect((await call("PUT", "/spray-mixes/editors", "lead", { employeeIds: [ID.lead] })).status).toBe(403);

    expect((await call("PUT", "/spray-mixes/editors", "owner", { employeeIds: [ID.lead] })).body).toEqual([ID.lead]);
    expect((await call("GET", "/spray-mixes", "lead")).body.canEdit).toBe(true);
    expect((await call("GET", "/spray-mixes", "crew")).body.canEdit).toBe(false);

    expect((await call("PATCH", `/spray-mixes/products/${ID.aquacap}`, "lead", { ratePerAcre: 50 })).body.ratePerAcre).toBe(50);
    expect((await call("PATCH", `/spray-mixes/products/${ID.aquacap}`, "crew", { ratePerAcre: 99 })).status).toBe(403);
    expect((await call("PATCH", `/spray-mixes/${ID.truck}`, "lead", { defaultTankGallons: 100 })).body.defaultTankGallons).toBe(100);
    expect((await call("PATCH", `/spray-mixes/${ID.truck}`, "lead", { gallonsPerAcre: 0 })).status).toBe(400);
    expect((await call("PATCH", `/spray-mixes/products/${ID.aquacap}`, "lead", { ratePerAcre: -1 })).status).toBe(400);

    const added = await call("POST", `/spray-mixes/${ID.truck}/products`, "lead", { name: "Iron", ratePerAcre: 32, unit: "ounces liquid" });
    expect(added.status).toBe(200);
    expect((await call("DELETE", `/spray-mixes/products/${added.body.id}`, "crew")).status).toBe(403);
    expect((await call("DELETE", `/spray-mixes/products/${added.body.id}`, "lead")).status).toBe(200);

    // Taking someone off the list takes away editing.
    await call("PUT", "/spray-mixes/editors", "owner", { employeeIds: [] });
    expect((await call("PATCH", `/spray-mixes/products/${ID.aquacap}`, "lead", { ratePerAcre: 51 })).status).toBe(403);
  });

  it("logs every change with who made it and the old and new values", async () => {
    const changes = (await call("GET", `/spray-mixes/${ID.truck}/changes`, "crew")).body as any[];
    expect(changes.map((c) => c.summary)).toEqual([
      "Removed Iron (was 32 ounces liquid/acre)",
      "Added Iron: 32 ounces liquid/acre",
      "Truck Mix: default tank 75 → 100 gal",
      "Aquacap: rate 47.9 → 50 per acre",
      "Truck Mix: created from the original spreadsheet",
    ]);
    expect(changes[0].by).toBe("lead Sprayer");
  });

  it("keeps each company's sheets separate", async () => {
    expect((await call("GET", "/spray-mixes", "other")).body.sheets).toEqual([]);
    expect((await call("PATCH", `/spray-mixes/products/${ID.aquacap}`, "other", { ratePerAcre: 1 })).status).toBe(404);
    expect((await call("PUT", "/spray-mixes/editors", "owner", { employeeIds: ["00000000-0000-0000-0000-000000000000"] })).status).toBe(404);
  });
});

/** Editable drop-down menus: plain lists (add/rename/remove) and new wording for fixed choices. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@menus.test`;
const T: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Menu Co", firstName: "Mo", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("POST", "/employees", "owner", { firstName: "lead", lastName: "X", email: email("lead"), password: "password123", role: "manager" });
  T.lead = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("lead"), password: "password123" } })).json().token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("drop-down menus", () => {
  it("starts with the default lists and wording", async () => {
    const m = (await call("GET", "/employees/menus", "lead")).body;
    expect(m.mixUnits).toContain("ounces liquid");
    expect(m.documentCategories).toContain("insurance");
    expect(m.assetTypes).toContain("heavy_equipment");
    expect(m.labels).toEqual({});
  });

  it("only the owner edits; renaming a list entry renames what uses it", async () => {
    expect((await call("PUT", "/employees/menus/lists/mixUnits", "lead", { values: ["cups"] })).status).toBe(403);
    expect((await call("PUT", "/employees/menus/lists/nope", "owner", { values: ["x"] })).status).toBe(404);
    const types = await call("PUT", "/employees/menus/lists/assetTypes", "owner", { values: ["vehicle", "mower", "trailer"] });
    expect(types.body.assetTypes).toEqual(["vehicle", "mower", "trailer"]);
    const asset = await call("POST", "/assets", "owner", { name: "Mower 1", type: "mower" });
    expect(asset.status).toBe(200);
    const renamed = await call("POST", "/employees/menus/lists/assetTypes/rename", "owner", { from: "mower", to: "zero-turn mower" });
    expect(renamed.body.assetTypes).toEqual(["vehicle", "zero-turn mower", "trailer"]);
    expect(renamed.body.usage.assetTypes["zero-turn mower"]).toBe(1);
    expect((await call("GET", "/assets", "owner")).body.find((a: any) => a.id === asset.body.id).type).toBe("zero-turn mower");
    expect((await call("POST", "/employees/menus/lists/assetTypes/rename", "owner", { from: "vehicle", to: "trailer" })).status).toBe(409);
  });

  it("rewords fixed choices without changing them", async () => {
    expect((await call("PUT", "/employees/menus/labels/employeeStatus", "lead", { labels: { terminated: "Separated" } })).status).toBe(403);
    const saved = await call("PUT", "/employees/menus/labels/employeeStatus", "owner", { labels: { terminated: "Separated", active: "", bogus: "x", inactive: "inactive" } });
    expect(saved.body.labels.employeeStatus).toEqual({ terminated: "Separated" });
    expect((await call("PUT", "/employees/menus/labels/jobTitles", "owner", { labels: {} })).status).toBe(404);
    expect((await call("GET", "/employees/menus", "lead")).body.labels.employeeStatus.terminated).toBe("Separated");
  });

  it("company info: everyone views (EIN for admins only); only the owner edits", async () => {
    const saved = await call("PUT", "/company", "owner", { name: "Menu Co Inc", legalName: "Menu Co LLC", ein: "123456789", address: "1 Main St", phone: "555-0100", email: "office@menu.test", website: "menu.test", timezone: "America/Denver" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: "Menu Co Inc", ein: "12-3456789", timezone: "America/Denver", canEdit: true });
    const asLead = (await call("GET", "/company", "lead")).body;
    expect(asLead).toMatchObject({ name: "Menu Co Inc", phone: "555-0100", ein: null, canEdit: false });
    expect((await call("PUT", "/company", "lead", { name: "Hacked", timezone: "America/Denver" })).status).toBe(403);
    expect((await call("PUT", "/company", "owner", { name: "X", timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await call("GET", "/auth/me", "owner")).body.company.name).toBe("Menu Co Inc");
  });
});

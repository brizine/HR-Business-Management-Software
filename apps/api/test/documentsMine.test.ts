/** The phone app's Me tab lists only your own documents and company-wide ones, even for managers. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { documents } from "../src/db/schema";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@docsmine.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
async function call(method: string, url: string, who: string) {
  const res = await app.inject({ method: method as never, url, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Docs Co", firstName: "Dee", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  ID.company = (await call("GET", "/auth/me", "owner")).body.company.id;
  await app.inject({ method: "PUT", url: "/auth/policy", payload: { twoFactorRequiredFor: "none" }, headers: { authorization: `Bearer ${T.owner}` } });
  const e = await app.inject({ method: "POST", url: "/employees", payload: { firstName: "Cam", lastName: "Crew", email: email("crew"), password: "password123", role: "employee" }, headers: { authorization: `Bearer ${T.owner}` } });
  ID.crew = e.json().id;
  T.crew = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("crew"), password: "password123" } })).json().token;
  const asset = await app.inject({ method: "POST", url: "/assets", payload: { name: "Truck", type: "truck" }, headers: { authorization: `Bearer ${T.owner}` } });
  const base = { companyId: ID.company, storageKey: "x", mimeType: "application/pdf", sizeBytes: 1, category: "general" };
  await db.insert(documents).values([
    { ...base, name: "Handbook" },
    { ...base, name: "Owner offer letter", employeeId: ID.owner },
    { ...base, name: "Crew offer letter", employeeId: ID.crew },
    { ...base, name: "Truck insurance card", assetId: asset.json().id },
  ]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("my documents", () => {
  it("managers: everything normally, only theirs + company-wide with mine=true", async () => {
    const names = async (who: string, q = "") => ((await call("GET", `/documents${q}`, who)).body as any[]).map((d) => d.name).sort();
    expect(await names("owner")).toEqual(["Crew offer letter", "Handbook", "Owner offer letter", "Truck insurance card"]);
    expect(await names("owner", "?mine=true")).toEqual(["Handbook", "Owner offer letter"]);
    expect(await names("crew", "?mine=true")).toEqual(["Crew offer letter", "Handbook"]);
  });
});

/** Saved property measurements: anyone can save; only the author or a manager can change or delete one. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@measure.test`;
const T: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

const yard = (name: string) => ({
  name, address: "123 Main St, Norman, OK", lat: 35.2226, lng: -97.4395, zoom: 20, imagery: "Oklahoma 2025 leaf-off",
  shapes: [
    { id: "a", kind: "turf", label: "Front", points: [[35.2226, -97.4395], [35.2235, -97.4395], [35.2235, -97.4384], [35.2226, -97.4384]] },
    { id: "b", kind: "cut", points: [[35.2227, -97.4394], [35.2228, -97.4394], [35.2228, -97.4393]] },
  ],
});

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Measure Co", firstName: "Mo", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const n of ["crew", "crew2"]) {
    await call("POST", "/employees", "owner", { firstName: n, lastName: "Tech", email: email(n), password: "password123", role: "employee" });
    T[n] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(n), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("measurements", () => {
  it("saves, totals, searches, and limits editing to the author or a manager", async () => {
    const saved = await call("POST", "/measurements", "crew", yard("Smith residence"));
    expect(saved.status).toBe(200);
    expect(saved.body.netSqFt).toBeGreaterThan(100_000);
    expect(saved.body.netSqFt).toBeLessThan(120_000);
    const id = saved.body.id;

    const list = await call("GET", "/measurements?q=smith", "crew2");
    expect(list.body.map((m: any) => m.name)).toEqual(["Smith residence"]);
    expect(list.body[0].createdByFirst).toBe("crew");
    expect((await call("GET", "/measurements?q=nobody", "crew2")).body).toEqual([]);

    expect((await call("GET", `/measurements/${id}`, "crew2")).body.canEdit).toBe(false);
    expect((await call("PUT", `/measurements/${id}`, "crew2", yard("Hijacked"))).status).toBe(403);
    expect((await call("DELETE", `/measurements/${id}`, "crew2")).status).toBe(403);

    const renamed = await call("PUT", `/measurements/${id}`, "crew", { ...yard("Smith residence (back)"), shapes: [] });
    expect(renamed.body.name).toBe("Smith residence (back)");
    expect(renamed.body.netSqFt).toBe(0);

    expect((await call("GET", `/measurements/${id}`, "owner")).body.canEdit).toBe(true);
    expect((await call("DELETE", `/measurements/${id}`, "owner")).status).toBe(200);
    expect((await call("GET", `/measurements/${id}`, "crew")).status).toBe(404);
  });

  it("rejects an area with fewer than 3 points", async () => {
    const bad = { ...yard("Bad"), shapes: [{ id: "x", kind: "turf", points: [[35, -97], [35.001, -97]] }] };
    expect((await call("POST", "/measurements", "crew", bad)).status).toBe(400);
  });
});

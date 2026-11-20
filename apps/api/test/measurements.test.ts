/** Saved property measurements: anyone can save; only the author or a manager can change or delete one. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { resetImageryCache } from "../src/lib/imagery";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@measure.test`;
const T: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}

const yard = (name: string) => ({
  name, address: "123 Main St, Norman, OK", lat: 35.2226, lng: -97.4395, zoom: 20, imagery: "Oklahoma 2025 leaf-off", pinLat: 35.2229, pinLng: -97.4391,
  shapes: [
    { id: "a", kind: "turf", zone: "front", label: "Front", points: [[35.2226, -97.4395], [35.2235, -97.4395], [35.2235, -97.4384], [35.2226, -97.4384]] },
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
    expect(list.body[0].frontSqFt).toBeCloseTo(saved.body.netSqFt, 0);
    expect(list.body[0].backSqFt).toBe(0);
    expect((await call("GET", "/measurements?q=nobody", "crew2")).body).toEqual([]);

    expect((await call("GET", `/measurements/${id}`, "crew2")).body).toMatchObject({ canEdit: false, pinLat: 35.2229, pinLng: -97.4391 });
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

describe("shop location", () => {
  it("admins set it (address suggestions start nearest it); others can't", async () => {
    expect((await call("PUT", "/measurements/shop", "crew", { query: "35.26028745, -97.46507469" })).status).toBe(403);
    const set = await call("PUT", "/measurements/shop", "owner", { query: "35.26028745, -97.46507469" });
    expect(set.body.shop).toMatchObject({ lat: 35.26028745, lng: -97.46507469, source: "admin" });
    expect((await call("GET", "/measurements/addresses", "crew")).body.shop).toMatchObject({ source: "admin" });
    // Cleared: back to the business address (none here), so no shop.
    expect((await call("PUT", "/measurements/shop", "owner", { query: "" })).body.shop).toBeNull();
  });
});

describe("aerial photo sources", () => {
  const found = (leafOffYears: number[]) => ({
    at: Date.now(), error: null,
    found: { leafOff: leafOffYears.map((year) => ({ year, layer: `ogi:Aerial${year}_Composite` })), naip: [{ year: 2025, layer: "ogi:NAIP2025_Statewide_Composite" }] },
  });

  it("lists OKMaps years newest first and marks a newly released year New", async () => {
    resetImageryCache(found([2025]));
    const first = (await call("GET", "/measurements/imagery", "crew")).body;
    expect(first.sources.map((s: any) => s.key)).toEqual(["ok-2025", "naip-2025"]);
    expect(first.sources.every((s: any) => !s.isNew)).toBe(true);
    expect(first.canManage).toBe(false);

    resetImageryCache(found([2027, 2025]));
    const next = (await call("GET", "/measurements/imagery", "crew")).body;
    expect(next.sources[0]).toMatchObject({ key: "ok-2027", label: "Oklahoma 2027 leaf-off", leafOff: true, isNew: true, layers: "ogi:Aerial2027_Composite" });
    expect(next.sources[1]).toMatchObject({ key: "ok-2025", isNew: false, detail: "Feb–Mar 2025 · 6-inch · Oklahoma only" });
  });

  it("lets admins add their own sources", async () => {
    const county = { key: "county-2026", kind: "wms", label: "County 2026", detail: "Mar 2026", url: "https://gis.example.com/wms", layers: "aerial2026", leafOff: true };
    expect((await call("PUT", "/measurements/imagery/custom", "crew", { custom: [county] })).status).toBe(403);
    expect((await call("PUT", "/measurements/imagery/custom", "owner", { custom: [{ ...county, layers: "" }] })).status).toBe(400);
    expect((await call("PUT", "/measurements/imagery/custom", "owner", { custom: [county] })).status).toBe(200);
    const list = (await call("GET", "/measurements/imagery", "crew")).body;
    expect(list.sources.map((s: any) => s.key)).toEqual(["ok-2027", "ok-2025", "county-2026", "naip-2025"]);
    expect((await call("GET", "/measurements/imagery", "owner")).body.canManage).toBe(true);
    // The export image endpoint only serves known WMS sources, with a sane area and size.
    expect((await call("GET", "/measurements/imagery/not-a-source/wms?bbox=0,0,10,10&width=100&height=100", "crew")).status).toBe(404);
    expect((await call("GET", "/measurements/imagery/ok-2025/wms?bbox=10,10,0,0&width=100&height=100", "crew")).status).toBe(400);
    expect((await call("GET", "/measurements/imagery/ok-2025/wms?bbox=0,0,10,10&width=99999&height=100", "crew")).status).toBe(400);
    resetImageryCache();
  });
});

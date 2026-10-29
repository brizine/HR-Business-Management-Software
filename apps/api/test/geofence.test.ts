/** Location rules for clocking in/out, set separately, with job-site geofences. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let pushes: PushMessage[] = [];
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@geo.test`;
const T: Record<string, string> = {};

// North yard in Austin, and spots near and far from it.
const YARD = { lat: 30.2672, lng: -97.7431 };
const ON_SITE = { lat: 30.2675, lng: -97.7433, accuracy: 10 };
const EDGE = { lat: 30.269, lng: -97.7431 }; // ~200 m away: outside a 150 m radius
const FAR = { lat: 30.29, lng: -97.7431, accuracy: 15 }; // ~2.5 km away

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const policy = (clockIn: string, clockOut: string) => call("PUT", "/time/location-policy", "owner", { clockIn, clockOut });
const punch = (kind: "in" | "out", loc: object = {}) => call("POST", `/time/clock-${kind}`, "crew", loc);

beforeAll(async () => {
  setEmailTransport(null);
  setSmsTransport(null);
  setPushTransport({ send: async (m) => (pushes.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { companyName: "Geo Co", firstName: "Gia", lastName: "Owner", email: email("owner"), password: "password123" },
  });
  T.owner = signup.json().token;
  const owner = signup.json().user.id;
  await call("POST", "/employees", "owner", { firstName: "Cal", lastName: "Crew", email: email("crew"), password: "password123", managerId: owner });
  T.crew = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("crew"), password: "password123" } })).json().token;
  await call("POST", "/notifications/devices", "owner", { token: `ExponentPushToken[owner-${suffix}]`, platform: "ios" });
});

beforeEach(async () => {
  await flushNotifications();
  pushes = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("job sites", () => {
  it("managers add sites; employees can see them but not change them", async () => {
    expect((await call("POST", "/job-sites", "crew", { name: "Nope", ...YARD })).status).toBe(403);
    expect((await call("POST", "/job-sites", "owner", { name: "Bad", lat: 91, lng: 0 })).status).toBe(400);
    expect((await call("POST", "/job-sites", "owner", { name: "Tiny", ...YARD, radiusMeters: 5 })).status).toBe(400);
    const site = await call("POST", "/job-sites", "owner", { name: "North yard", ...YARD });
    expect(site.body.radiusMeters).toBe(150);
    expect((await call("GET", "/job-sites", "crew")).body.map((s: any) => s.name)).toEqual(["North yard"]);
  });
});

describe("location rules", () => {
  it("optional (default): punches work with or without location, and record the site", async () => {
    expect((await call("GET", "/time/location-policy", "crew")).body).toEqual({ clockIn: "optional", clockOut: "optional", activeSites: 1 });
    expect((await punch("in")).status).toBe(200);
    const out = await punch("out", ON_SITE);
    expect(out.body.siteName).toBe("North yard");
    expect(out.body.clockOutFlag).toBeNull();
  });

  it("required: no location, no punch (with a code the app can act on)", async () => {
    await policy("required", "optional");
    const res = await punch("in");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("location_required");
    // Anywhere is fine as long as location is on.
    expect((await punch("in", FAR)).status).toBe(200);
    expect((await punch("out")).status).toBe(200); // clock-out is still optional
  });

  it("only admins change the rules", async () => {
    expect((await call("PUT", "/time/location-policy", "crew", { clockIn: "optional", clockOut: "optional" })).status).toBe(403);
    expect((await call("GET", "/time/status", "crew")).body.locationPolicy).toEqual({ clockIn: "required", clockOut: "optional" });
  });

  it("job site, block: refuses punches away from every site, says how far", async () => {
    await policy("geofence_block", "optional");
    const far = await punch("in", FAR);
    expect(far.status).toBe(403);
    expect(far.body.code).toBe("outside_job_site");
    expect(far.body.error).toMatch(/You're 2\.5 km from the nearest job site \(North yard\)/);
    expect((await punch("in")).body.code).toBe("location_required");

    // ~200 m out is refused with a precise fix, accepted when the phone reports 60 m uncertainty.
    expect((await punch("in", { ...EDGE, accuracy: 5 })).status).toBe(403);
    const edge = await punch("in", { ...EDGE, accuracy: 60 });
    expect(edge.status).toBe(200);
    expect(edge.body.siteName).toBe("North yard");
    // Clock-out has its own (optional) rule, so leaving from anywhere works.
    expect((await punch("out", FAR)).status).toBe(200);
  });

  it("job site, flag: allows punches away from a site but flags them and tells the manager", async () => {
    await policy("optional", "geofence_flag");
    await punch("in", ON_SITE);
    const out = await punch("out", FAR);
    expect(out.status).toBe(200);
    expect(out.body.clockOutFlag).toBe("off_site");
    expect(out.body.clockOutDistance).toBeGreaterThan(2000);
    await flushNotifications();
    expect(pushes.map((p) => p.title)).toEqual(["Cal Crew clocked out away from a job site"]);
    expect(pushes[0].body).toMatch(/^2\.5 km from the nearest job site/);

    pushes = [];
    await punch("in", ON_SITE);
    expect((await punch("out", ON_SITE)).body.clockOutFlag).toBeNull();
    await flushNotifications();
    expect(pushes).toHaveLength(0);
  });

  it("timesheets and entries show flags and site names", async () => {
    const sheets = (await call("GET", "/time/timesheets", "owner")).body as any[];
    expect(sheets.find((s) => s.name === "Cal Crew").flagged).toBe(1);
    const entries = (await call("GET", "/time/entries", "crew")).body as any[];
    expect(entries.some((e) => e.clockInSite === "North yard")).toBe(true);
  });

  it("with no active sites, job-site rules fall back to 'location required' instead of locking everyone out", async () => {
    await policy("geofence_block", "geofence_block");
    const [site] = (await call("GET", "/job-sites", "owner")).body;
    await call("PATCH", `/job-sites/${site.id}`, "owner", { active: false });
    expect((await call("GET", "/time/location-policy", "owner")).body.activeSites).toBe(0);
    expect((await punch("in")).body.code).toBe("location_required");
    expect((await punch("in", FAR)).status).toBe(200);
    expect((await punch("out", FAR)).status).toBe(200);
  });

  it("rejects half a location", async () => {
    await policy("optional", "optional");
    expect((await punch("in", { lat: 30.2 })).status).toBe(400);
  });
});

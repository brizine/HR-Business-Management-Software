/** Location while clocked in: the phone app's points, the day's trail, who can see it, and clean-up. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { locationPings } from "../src/db/schema";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@loc.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
// Just after midnight (Central), "20 minutes ago" is yesterday: then everything moves back a little
// further so the shift and its points all fall on one day, and that's the day the trail is read for.
const chicagoNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
const minutesIntoDay = Number(chicagoNow.find((x) => x.type === "hour")!.value) * 60 + Number(chicagoNow.find((x) => x.type === "minute")!.value);
const shift = minutesIntoDay < 45 ? minutesIntoDay + 5 : 0;
const ago = (min: number) => new Date(Date.now() - (min + (min > 0 ? shift : 0)) * 60_000).toISOString();
const trailDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.now() - (shift + 15) * 60_000));
const pt = (min: number, lat = 41.6, lng = -93.6) => ({ lat, lng, accuracy: 12, at: ago(min) });

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Loc Co", firstName: "Lou", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const who of ["crew", "other"]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role: "employee" });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("location while clocked in", () => {
  it("records nothing off the clock", async () => {
    expect((await call("POST", "/time/locations", "crew", { points: [pt(0)] })).body).toEqual({ recorded: 0, clockedIn: false });
  });

  it("records points while clocked in, skipping ones too close together or before the shift", async () => {
    await call("POST", "/time/clock-in", "crew", { lat: 41.59, lng: -93.62, accuracy: 8 });
    // Pretend the shift started 20 minutes ago.
    const status = (await call("GET", "/time/status", "crew")).body;
    await call("PATCH", `/time/entries/${status.openEntry.id}`, "owner", { clockIn: ago(20), clockOut: null });
    // Before clocking in (skipped), then every 4-5 minutes; 14 is only a minute after 15 (skipped).
    const batch = await call("POST", "/time/locations", "crew", { points: [pt(30), pt(15), pt(14), pt(10, 41.61), pt(5, 41.62)] });
    expect(batch.body).toEqual({ recorded: 3, clockedIn: true });
    expect((await call("POST", "/time/locations", "crew", { points: [pt(4)] })).body.recorded).toBe(0);
    expect((await call("POST", "/time/locations", "crew", { points: [{ ...pt(0), at: new Date(Date.now() + 10 * 60_000).toISOString() }] })).body.recorded).toBe(0);
    expect((await call("POST", "/time/locations", "crew", { points: [{ lat: 200, lng: 0, at: ago(0) }] })).status).toBe(400);
  });

  it("shows the day's trail to managers and the person, not coworkers", async () => {
    const today = trailDay;
    const trail = await call("GET", `/time/locations?employeeId=${ID.crew}&date=${today}`, "owner");
    expect(trail.status).toBe(200);
    expect(trail.body.entries).toHaveLength(1);
    expect(trail.body.entries[0]).toMatchObject({ clockInLat: 41.59, clockInLng: -93.62, clockOut: null });
    expect(trail.body.points.map((p: any) => p.lat)).toEqual([41.6, 41.61, 41.62]);
    expect((await call("GET", `/time/locations?date=${today}`, "crew")).body.points).toHaveLength(3);
    expect((await call("GET", `/time/locations?employeeId=${ID.crew}&date=${today}`, "other")).status).toBe(403);
    expect((await call("GET", `/time/locations?employeeId=${ID.crew}`, "owner")).status).toBe(400);
  });

  it("tells the app the current pay period (none until a schedule is set)", async () => {
    expect((await call("GET", "/time/pay-period", "crew")).body).toEqual({ period: null });
    await call("PUT", "/pay-periods/schedule", "owner", { frequency: "semimonthly", paydayOffsetDays: 5, approverIds: [] });
    const p = (await call("GET", "/time/pay-period", "crew")).body.period;
    const today = trailDay;
    expect(p.start <= today && today <= p.end).toBe(true);
    expect(p.start.endsWith("-01") || p.start.endsWith("-16")).toBe(true);
    expect(new Date(p.startsAt).getTime()).toBeLessThan(Date.now());
    expect(new Date(p.endsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("deletes points older than the keep period", async () => {
    await db.update(locationPings).set({ recordedAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(locationPings.employeeId, ID.crew));
    await runScheduledChecks();
    expect(await db.select().from(locationPings).where(eq(locationPings.employeeId, ID.crew))).toHaveLength(0);
  }, 120_000);
});

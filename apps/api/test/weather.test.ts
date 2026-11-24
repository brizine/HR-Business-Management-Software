/** Weather on chemical applications: automatic lookups, retries, the day's entry, office edits, the wind limit. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Observation } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { visitWeather, visits } from "../src/db/schema";
import { setPushTransport } from "../src/lib/notify";
import { setEmailTransport } from "../src/lib/channels";
import { flushWeather, nwsObservations, runWeather, setWeatherFetcher } from "../src/lib/weather";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@weather.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}

// The fake weather service: observations every hour around "now", with the wind set per test.
let wind = 16.09; // km/h, 10 mph
let reporting = true;
const calls: { lat: number; lng: number }[] = [];
const hourly = (): Observation[] => Array.from({ length: 30 }, (_, i) => {
  const at = new Date(Date.now() - (26 - i) * 3_600_000);
  return { at: at.toISOString(), tempC: 25, windKmh: wind, windDeg: 200, gustKmh: wind * 2, precipLastHourMm: i === 10 ? 2.54 : 0 };
}).filter((o) => Date.parse(o.at) <= Date.now());

const record = async (visitId: string) => (await call("GET", `/weather/records/${visitId}`, "owner")).body.record;

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async () => {} });
  setWeatherFetcher({
    async observations(lat, lng) {
      calls.push({ lat, lng });
      return { station: "Norman, Max Westheimer Airport (KOUN)", observations: reporting ? hourly() : [] };
    },
  });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Weather Co", firstName: "Wes", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Weather Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@weather.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Mo", lastName: "Manager", email: email("mgr"), password: "password123", role: "manager" });
  T.mgr = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("mgr"), password: "password123" } })).json().token;
  await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" });
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  ID.weed = (await call("POST", "/service-types", "owner", { name: "Weed control", priceCents: 5000, chemical: true })).body.id;
  ID.mow = (await call("POST", "/service-types", "owner", { name: "Mowing", priceCents: 4000 })).body.id;
  ID.cust = (await call("POST", "/customers", "owner", { firstName: "Ann", lastName: "Lee", email: email("ann"), property: { street: "1 Oak St", city: "Norman", zip: "73069", lat: 35.2226, lng: -97.4395 } })).body.id;
  ID.prop = (await call("GET", `/customers/${ID.cust}`, "owner")).body.properties[0].id;
  ID.cust2 = (await call("POST", "/customers", "owner", { firstName: "Bo", lastName: "Nolat", email: email("bo"), property: { street: "2 Elm St", city: "Norman", zip: "73069" } })).body.id;
  ID.prop2 = (await call("GET", `/customers/${ID.cust2}`, "owner")).body.properties[0].id;
});

afterAll(async () => {
  setWeatherFetcher(null);
  await app.close();
  await pool.end();
});

const workOrder = async (service: "weed" | "mow", where: "prop" | "prop2" = "prop") => (await call("POST", "/visits", "owner", {
  title: service === "weed" ? "Round 3" : "Mow", customerId: where === "prop" ? ID.cust : ID.cust2, propertyId: ID[where], date: today,
  lines: [{ serviceTypeId: ID[service], description: service === "weed" ? "Weed control" : "Mowing", quantity: 1, unitPriceCents: 5000 }],
})).body.id as string;
const complete = async (id: string, gps?: { lat: number; lng: number; accuracy?: number }) => {
  const r = await call("POST", `/visits/${id}/complete`, "owner", { notes: "Done", ...gps });
  expect(r.status).toBe(200);
  await flushWeather();
};

describe("weather", () => {
  it("settings: automatic with a 10 mph limit to start; admins change them", async () => {
    expect((await call("GET", "/weather/settings", "mgr")).body).toEqual({ mode: "auto", windLimitMph: 10 });
    expect((await call("PUT", "/weather/settings", "mgr", { mode: "manual", windLimitMph: 12 })).status).toBe(403);
    expect((await call("PUT", "/weather/settings", "owner", { mode: "auto", windLimitMph: 0 })).status).toBe(400);
    expect((await call("PUT", "/weather/settings", "owner", { mode: "auto", windLimitMph: 12 })).status).toBe(200);
    expect((await call("GET", "/weather/records", "tech")).status).toBe(403);
  });

  it("completing a chemical application looks up the weather for the property, with the phone's GPS stamped", async () => {
    ID.a = await workOrder("weed");
    await complete(ID.a, { lat: 35.2229, lng: -97.44, accuracy: 12 });
    expect(calls.at(-1)).toEqual({ lat: 35.2226, lng: -97.4395 });
    const r = await record(ID.a);
    expect(r).toMatchObject({
      services: ["Weed control"], needsWeather: false, overLimit: false, gps: { lat: 35.2229, lng: -97.44, accuracy: 12 },
      weather: { source: "auto", windMph: 10, windDeg: 200, gustMph: 20, tempF: 77, rainIn: 0.1, station: "Norman, Max Westheimer Airport (KOUN)", lastError: null },
    });
    // A non-chemical work order gets none, and isn't on the list.
    ID.mow1 = await workOrder("mow");
    const before = calls.length;
    await complete(ID.mow1);
    expect(calls.length).toBe(before);
    const list = (await call("GET", "/weather/records", "mgr")).body;
    expect(list.records.map((x: any) => x.visitId)).toEqual([ID.a]);
    expect(list.settings.windLimitMph).toBe(12);
  });

  it("waits for the station to report, then tries again", async () => {
    reporting = false;
    ID.b = await workOrder("weed");
    await complete(ID.b);
    expect(await record(ID.b)).toMatchObject({ needsWeather: true, weather: { source: null, tries: 1, lastError: expect.stringMatching(/hasn't reported/) } });
    reporting = true;
    // Not again until 15 minutes have passed.
    expect(await runWeather(new Date())).toBe(0);
    expect(await runWeather(new Date(Date.now() + 16 * 60_000))).toBe(1);
    expect(await record(ID.b)).toMatchObject({ needsWeather: false, weather: { source: "auto", tries: 2, lastError: null } });
  });

  it("uses the phone's location when the property has none; without either, says so", async () => {
    ID.c = await workOrder("weed", "prop2");
    await complete(ID.c);
    expect(await record(ID.c)).toMatchObject({ needsWeather: true, weather: { lastError: expect.stringMatching(/no map location/) } });
    ID.d = await workOrder("weed", "prop2");
    await complete(ID.d, { lat: 35.3, lng: -97.5 });
    expect(calls.at(-1)).toEqual({ lat: 35.3, lng: -97.5 });
    expect((await record(ID.d)).weather.source).toBe("auto");
  });

  it("flags readings over the wind limit for review, with a note", async () => {
    wind = 30; // 18.6 mph
    ID.e = await workOrder("weed");
    await complete(ID.e);
    expect(await record(ID.e)).toMatchObject({ overLimit: true, weather: { windMph: 18.6, reviewedAt: null } });
    expect((await call("POST", `/weather/records/${ID.e}/review`, "mgr", { note: "" })).status).toBe(400);
    expect((await call("POST", `/weather/records/${ID.a}/review`, "mgr", { note: "ok" })).status).toBe(400);
    const r = await call("POST", `/weather/records/${ID.e}/review`, "mgr", { note: "Gusts were brief; used low-drift nozzles" });
    expect(r.body).toMatchObject({ overLimit: true, weather: { reviewedBy: "Mo Manager", reviewNote: "Gusts were brief; used low-drift nozzles" } });
    wind = 16.09;
  });

  it("the office can type it in, or look it up again", async () => {
    expect((await call("PUT", `/weather/records/${ID.c}`, "mgr", { windMph: "", tempF: 70 })).status).toBe(400);
    const r = await call("PUT", `/weather/records/${ID.c}`, "mgr", { windMph: 6, windDeg: 180, tempF: 70, rainIn: 0, note: "From the truck's gauge" });
    expect(r.body).toMatchObject({ needsWeather: false, weather: { source: "office", windMph: 6, enteredBy: "Mo Manager", note: "From the truck's gauge" } });
    // The job leaves it alone.
    await runWeather(new Date(Date.now() + 60 * 60_000));
    expect((await record(ID.c)).weather.source).toBe("office");
    // Fetch now replaces it (here: no location, so it says why).
    expect((await call("POST", `/weather/records/${ID.c}/fetch`, "mgr")).body.error).toMatch(/no map location/);
    expect((await call("POST", `/weather/records/${ID.a}/fetch`, "mgr")).body.weather.source).toBe("auto");
    // Not before it's completed.
    const open = await workOrder("weed");
    expect((await call("PUT", `/weather/records/${open}`, "mgr", { windMph: 5 })).status).toBe(400);
  });

  it("manual: the day's entry goes on that day's applications without their own reading", async () => {
    await call("PUT", "/weather/settings", "owner", { mode: "manual", windLimitMph: 12 });
    const before = calls.length;
    ID.f = await workOrder("weed");
    await complete(ID.f);
    expect(calls.length).toBe(before);
    expect((await record(ID.f)).needsWeather).toBe(true);
    expect((await call("PUT", "/weather/days/2999-01-01", "mgr", { windMph: 5 })).status).toBe(400);
    const d = await call("PUT", `/weather/days/${today}`, "mgr", { windMph: 7, windDeg: 0, tempF: 65, rainIn: 0.2, note: "Calm morning" });
    // Only f was waiting: the automatic and office readings that day are kept.
    expect(d.body.applied).toBe(1);
    expect(await record(ID.f)).toMatchObject({ needsWeather: false, weather: { source: "day", windMph: 7, tempF: 65, rainIn: 0.2, note: "Calm morning" } });
    expect((await record(ID.c)).weather.source).toBe("office");
    expect((await record(ID.a)).weather.source).toBe("auto");
    // Completed later the same day: gets the day's entry.
    ID.g = await workOrder("weed");
    await complete(ID.g);
    expect((await record(ID.g)).weather).toMatchObject({ source: "day", windMph: 7 });
    expect((await call("GET", "/weather/records", "mgr")).body.days).toMatchObject([{ date: today, windMph: 7 }]);
    // Deleting the entry takes it back off.
    expect((await call("DELETE", `/weather/days/${today}`, "mgr")).body.cleared).toBe(2);
    expect((await record(ID.g)).needsWeather).toBe(true);
  });

  it("undoing the completion clears its weather; off means nothing is recorded", async () => {
    expect((await db.select().from(visitWeather).where(eq(visitWeather.visitId, ID.a))).length).toBe(1);
    await call("POST", `/visits/${ID.a}/reopen`, "owner");
    expect(await db.select().from(visitWeather).where(eq(visitWeather.visitId, ID.a))).toEqual([]);
    const [v] = await db.select().from(visits).where(eq(visits.id, ID.a));
    expect(v.completedLat).toBeNull();
    await call("PUT", "/weather/settings", "owner", { mode: "off", windLimitMph: 12 });
    const before = calls.length;
    ID.h = await workOrder("weed");
    await complete(ID.h);
    expect(calls.length).toBe(before);
    expect((await record(ID.h)).weather).toBeNull();
  });

  it("reads the National Weather Service's observations in any unit it labels", () => {
    const json = { features: [{ properties: {
      timestamp: "2026-05-01T13:53:00+00:00",
      temperature: { unitCode: "wmoUnit:degC", value: 22 }, windSpeed: { unitCode: "wmoUnit:km_h-1", value: 24.1 },
      windDirection: { unitCode: "wmoUnit:degree_(angle)", value: 200 }, windGust: { unitCode: "wmoUnit:m_s-1", value: 10 },
      precipitationLastHour: { unitCode: "wmoUnit:m", value: 0.00254 },
    } }, { properties: { timestamp: "2026-05-01T12:53:00+00:00", temperature: { value: null }, windSpeed: { value: null } } }] };
    expect(nwsObservations(json)[0]).toEqual({ at: "2026-05-01T13:53:00+00:00", tempC: 22, windKmh: 24.1, windDeg: 200, gustKmh: 36, precipLastHourMm: 2.54 });
    expect(nwsObservations(json)[1]).toMatchObject({ tempC: null, windKmh: null });
  });
});

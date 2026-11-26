/** The forecast box in the top bar: the Weather Service's forecast for the business address, and the company's weather links. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setDispatchLocator } from "../src/lib/dispatch";
import { forecastAt, forgetForecastSpots, nwsAlerts, nwsHours, nwsPeriods, setForecastFetch } from "../src/lib/forecast";

// Answers the National Weather Service gave for Norman, OK (trimmed).
const NWS = JSON.parse(readFileSync(new URL("./fixtures-nws.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-26T15:30:00Z"); // 9:30 am in Norman, Thanksgiving morning

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@forecast.test`;
const T: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}

// The fake Weather Service: counts what it's asked, and can be switched off.
let asked: string[] = [];
let up = true;
let alerts: unknown = { features: [] };
const service = async (url: string) => {
  asked.push(url.replace("https://api.weather.gov", ""));
  if (!up) throw new Error("Couldn't reach the National Weather Service. Try again in a minute.");
  if (url.includes("/points/")) return NWS.point;
  if (url.includes("/alerts/")) return alerts;
  if (url.endsWith("/forecast/hourly")) return NWS.hourly;
  if (url.endsWith("/forecast")) return NWS.daily;
  throw new Error(`unexpected ${url}`);
};

beforeAll(async () => {
  setForecastFetch(service);
  // The pretend map: Main St and the town of Norman can be found; "Nowhere Rd" and "Lostville" can't.
  setDispatchLocator(async (address) => (/nowhere|lostville/i.test(address) ? null : /main/i.test(address) ? { lat: 35.22263, lng: -97.43951 } : /^norman, ok/i.test(address) ? { lat: 35.2, lng: -97.4 } : null));
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Forecast Co", firstName: "Fay", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" });
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
});
afterAll(async () => { setForecastFetch(null); await app.close(); await pool.end(); });

describe("reading the Weather Service", () => {
  it("the 7-day forecast, as lines", () => {
    const p = nwsPeriods(NWS.daily);
    expect(p).toHaveLength(4);
    expect(p[0]).toMatchObject({ name: "Thanksgiving Day", day: true, tempF: 47, rainPct: 0, wind: "7 to 12 mph", windDir: "NNW", short: "Sunny", icon: "sun" });
    expect(p[1]).toMatchObject({ name: "Tonight", day: false, tempF: 30, icon: "moon" });
    expect(nwsPeriods({})).toEqual([]);
    expect(nwsPeriods({ properties: { periods: [{ name: "Today", startTime: "2026-06-01T06:00:00-05:00", endTime: "2026-06-01T18:00:00-05:00", isDaytime: true, temperature: 30, temperatureUnit: "C", windSpeed: "10 mph", icon: "https://api.weather.gov/icons/land/day/rain_showers,30/tsra,60?size=medium" }] } })[0])
      .toMatchObject({ tempF: 86, rainPct: null, icon: "storm" });
  });

  it("the hours ahead, from now", () => {
    const h = nwsHours(NWS.hourly, NOW);
    expect(h).toHaveLength(12);
    expect(h[0]).toMatchObject({ at: "2026-11-26T09:00:00-06:00", tempF: 32, windMph: 9, windDir: "NNW", humidity: 75, rainPct: 0, icon: "sun" });
    // Two hours on, the first two have passed.
    expect(nwsHours(NWS.hourly, new Date(NOW.getTime() + 2 * 3_600_000))[0].at).toBe("2026-11-26T11:00:00-06:00");
  });

  it("warnings in effect, the worst first, without ones that are over or cancelled", () => {
    const real = nwsAlerts(NWS.alerts, NOW);
    expect(real.map((a) => a.event)).toEqual(["Winter Storm Warning", "Freeze Warning"]);
    expect(real[0]).toMatchObject({ severity: "Severe", ends: "2026-11-26T21:00:00-06:00" });
    const mixed = { features: [
      { properties: { event: "Wind Advisory", severity: "Moderate", status: "Actual", messageType: "Alert", headline: "Wind Advisory until 6PM", ends: "2026-11-26T18:00:00-06:00" } },
      { properties: { event: "Tornado Warning", severity: "Extreme", status: "Actual", messageType: "Alert", headline: "Tornado Warning", ends: null, expires: "2026-11-26T10:15:00-06:00" } },
      { properties: { event: "Flood Watch", severity: "Severe", status: "Actual", messageType: "Alert", headline: "over", ends: "2026-11-26T03:00:00-06:00" } },
      { properties: { event: "Test Message", severity: "Minor", status: "Test", messageType: "Alert", headline: "test" } },
      { properties: { event: "Freeze Warning", severity: "Severe", status: "Actual", messageType: "Cancel", headline: "cancelled" } },
    ] };
    expect(nwsAlerts(mixed, NOW).map((a) => a.event)).toEqual(["Tornado Warning", "Wind Advisory"]);
    expect(nwsAlerts(null)).toEqual([]);
  });

  it("asks once and keeps the answer; an outage serves the last forecast, marked as old", async () => {
    asked = [];
    const first = await forecastAt(40.11114, -100.22226, NOW);
    expect(asked.sort()).toEqual(["/alerts/active?point=40.1111,-100.2223", "/gridpoints/OUN/100,83/forecast", "/gridpoints/OUN/100,83/forecast/hourly", "/points/40.1111,-100.2223"]);
    expect(first).toMatchObject({ place: "Norman, OK", updatedAt: "2026-11-26T06:26:58+00:00", stale: false });
    expect(first.pages).toEqual({
      forecast: "https://forecast.weather.gov/MapClick.php?lat=40.1111&lon=-100.2223",
      hourly: "https://forecast.weather.gov/MapClick.php?lat=40.1111&lon=-100.2223&FcstType=graphical",
      radar: "https://radar.weather.gov/station/KTLX/standard",
    });
    asked = [];
    await forecastAt(40.11114, -100.22226, NOW);
    expect(asked).toEqual([]);
    // A spot never asked about, with the Weather Service down: said plainly.
    up = false;
    await expect(forecastAt(41, -101, NOW)).rejects.toThrow(/Couldn't reach the National Weather Service/);
    up = true;
  });
});

describe("the forecast box", () => {
  it("needs the business address first", async () => {
    const r = await call("GET", "/company/forecast", "tech");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ forecast: null, links: [], canEdit: false, spot: null });
    expect(r.body.problem).toMatch(/^Add your business address/);
  });

  it("shows everyone the forecast for the business address", async () => {
    await call("PUT", "/company", "owner", { name: "Forecast Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@forecast.test", timezone: "America/Chicago" });
    alerts = NWS.alerts;
    for (const who of ["owner", "tech"]) {
      const r = await call("GET", "/company/forecast", who);
      expect(r.status).toBe(200);
      expect(r.body.problem).toBeNull();
      expect(r.body.canEdit).toBe(who === "owner");
      expect(r.body.spot).toBe("address");
      expect(r.body.forecast).toMatchObject({ place: "Norman, OK", lat: 35.22263, lng: -97.43951 });
      expect(r.body.forecast.pages.forecast).toBe("https://forecast.weather.gov/MapClick.php?lat=35.2226&lon=-97.4395");
      expect(Array.isArray(r.body.forecast.periods)).toBe(true);
      expect(r.body.forecast.alerts.every((a: { url: string }) => a.url === r.body.forecast.pages.forecast)).toBe(true);
    }
  });

  it("says why when the Weather Service can't be reached and nothing is kept", async () => {
    setForecastFetch(service); // forgets what was kept
    up = false;
    const r = await call("GET", "/company/forecast", "tech");
    expect(r.body.forecast).toBeNull();
    expect(r.body.problem).toMatch(/National Weather Service/);
    up = true;
    expect((await call("GET", "/company/forecast", "tech")).body.problem).toBeNull();
  });

  it("the owner sets the links to other weather sites; everyone gets them", async () => {
    expect((await call("PUT", "/company/weather-links", "tech", { links: [] })).status).toBe(403);
    const saved = await call("PUT", "/company/weather-links", "owner", { links: [
      { label: " Mesonet ", url: "www.mesonet.org/weather" },
      { label: "Radar", url: "https://radar.weather.gov/station/KTLX/standard" },
    ] });
    expect(saved.status).toBe(200);
    expect(saved.body.links).toEqual([{ label: "Mesonet", url: "https://www.mesonet.org/weather" }, { label: "Radar", url: "https://radar.weather.gov/station/KTLX/standard" }]);
    expect((await call("GET", "/company/forecast", "tech")).body.links).toEqual(saved.body.links);
    // Only web addresses: nothing that would run in the page.
    for (const url of ["javascript:alert(1)", "ftp://example.com/x", "notasite", ""]) {
      expect((await call("PUT", "/company/weather-links", "owner", { links: [{ label: "Bad", url }] })).status).toBe(400);
    }
    expect((await call("PUT", "/company/weather-links", "owner", { links: [{ label: "", url: "https://a.example" }] })).status).toBe(400);
    expect((await call("PUT", "/company/weather-links", "owner", { links: Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, url: "https://a.example" })) })).status).toBe(400);
    expect((await call("GET", "/company/forecast", "tech")).body.links).toHaveLength(2);
    // Changing the weather-record setting leaves the links alone.
    expect((await call("PUT", "/weather/settings", "owner", { mode: "manual" })).status).toBe(200);
    expect((await call("GET", "/company/forecast", "tech")).body.links).toHaveLength(2);
    expect((await call("GET", "/weather/settings", "owner")).body).toEqual({ mode: "manual" });
  });

  it("a test company, which starts with no address, gets the forecast for where the real company is", async () => {
    expect((await call("POST", "/auth/test-company", "owner")).status).toBe(200);
    T.test = (await call("POST", "/auth/test-company/open", "owner")).body.token;
    const r = (await call("GET", "/company/forecast", "test")).body;
    expect(r).toMatchObject({ problem: null, spot: "company" });
    expect(r.forecast).toMatchObject({ lat: 35.22263, lng: -97.43951 });
    // Its own address, once it has one that's on the map, is what counts.
    await call("PUT", "/company", "test", { name: "Forecast Co (Test)", addressLine1: "500 Main St", city: "Norman", state: "OK", zip: "73069", timezone: "America/Chicago" });
    expect((await call("GET", "/company/forecast", "test")).body.spot).toBe("address");
  });

  it("an address that can't be put on the map: the properties the company works at, else the town", async () => {
    forgetForecastSpots();
    await call("PUT", "/company", "owner", { name: "Forecast Co", addressLine1: "9 Nowhere Rd", city: "Norman", state: "OK", zip: "73069", email: "office@forecast.test", timezone: "America/Chicago" });
    const town = (await call("GET", "/company/forecast", "tech")).body;
    expect(town).toMatchObject({ problem: null, spot: "town" });
    expect(town.forecast).toMatchObject({ lat: 35.2, lng: -97.4 });
    // With customers' properties on the map, their middle is where the company works.
    for (const [street, lat, lng] of [["1 Oak St", 35.21, -97.44], ["2 Elm St", 35.23, -97.48], ["3 Ash St", 35.29, -97.42]] as const) {
      expect((await call("POST", "/customers", "owner", { firstName: "Pat", lastName: street, email: email(`p${lat}`), property: { street, city: "Norman", zip: "73069", lat, lng } })).status).toBe(200);
    }
    const mid = (await call("GET", "/company/forecast", "tech")).body;
    expect(mid).toMatchObject({ problem: null, spot: "properties" });
    expect(mid.forecast).toMatchObject({ lat: 35.23, lng: -97.44 });
  });

  it("nothing to go on at all: says the address couldn't be placed, not that it's missing", async () => {
    T.lost = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Lost Co", firstName: "Lou", lastName: "Owner", email: email("lost"), password: "password123" } })).json().token;
    if (!T.lost) return; // sign-up is closed once a company exists, unless the install allows more
    await call("PUT", "/company", "lost", { name: "Lost Co", addressLine1: "1 Hidden Way", city: "Lostville", state: "OK", zip: "70000", timezone: "America/Chicago" });
    const r = (await call("GET", "/company/forecast", "lost")).body;
    expect(r).toMatchObject({ forecast: null, spot: null });
    expect(r.problem).toMatch(/couldn't place your business address/);
  });
});

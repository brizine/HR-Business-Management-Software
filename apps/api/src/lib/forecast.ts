import { eq } from "drizzle-orm";
import { forecastIcon, windTopMph, type Forecast, type ForecastAlert, type ForecastHour, type ForecastPeriod, type WeatherLink } from "@crewdesk/shared";
import { db } from "../db";
import { companies } from "../db/schema";
import { dispatchSettings } from "./dispatch";

/**
 * The forecast box in the top bar: the National Weather Service's forecast for the company's
 * business address (7 days, the hours ahead, and any warnings in effect), with links to the Weather
 * Service's own pages. Read from api.weather.gov and kept for a few minutes, so a busy office asks
 * the Weather Service a handful of times an hour, not once a click.
 */

const NWS = "https://api.weather.gov";
const userAgent = () => process.env.WEATHER_USER_AGENT || "Crewdesk (forecast for the office)";

export type ForecastFetch = (url: string) => Promise<any>;
const nws: ForecastFetch = async (url) => {
  let r: Response;
  try {
    r = await fetch(url, { headers: { "user-agent": userAgent(), accept: "application/geo+json" }, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new Error("Couldn't reach the National Weather Service. Try again in a minute.");
  }
  if (r.status === 404) throw new Error("The National Weather Service has no forecast for this location.");
  if (!r.ok) throw new Error(`The National Weather Service answered ${r.status}. Try again in a minute.`);
  return r.json();
};
let get: ForecastFetch = nws;
/** Tests swap in their own Weather Service. */
export function setForecastFetch(f: ForecastFetch | null) { get = f ?? nws; kept.clear(); }

/* ───────────── Kept answers ───────────── */

const MIN = 60_000;
const kept = new Map<string, { at: number; value?: unknown; pending?: Promise<unknown> }>();
/**
 * An answer kept for `ms`. When the Weather Service can't be reached, the last answer still serves
 * (a forecast an hour old beats none); `stale` says so.
 */
async function keep<T>(key: string, ms: number, load: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
  const now = Date.now();
  const hit = kept.get(key);
  if (hit?.value !== undefined && now - hit.at < ms) return { value: hit.value as T, stale: false };
  if (hit?.pending) return { value: (await hit.pending) as T, stale: false };
  const pending = load();
  kept.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
  try {
    const value = await pending;
    kept.set(key, { at: Date.now(), value });
    if (kept.size > 500) for (const [k, v] of kept) if (Date.now() - v.at > 24 * 60 * MIN) kept.delete(k);
    return { value, stale: false };
  } catch (e) {
    kept.set(key, { at: hit?.at ?? 0, value: hit?.value });
    // Up to six hours old is still worth showing.
    if (hit?.value !== undefined && now - hit.at < 6 * 60 * MIN) return { value: hit.value as T, stale: true };
    throw e;
  }
}

/* ───────────── Reading the Weather Service's answers ───────────── */

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const toF = (temp: unknown, unit: unknown) => { const t = num(temp); return t == null ? null : unit === "C" ? Math.round((t * 9) / 5 + 32) : Math.round(t); };

export function nwsPeriods(json: any): ForecastPeriod[] {
  const list: any[] = Array.isArray(json?.properties?.periods) ? json.properties.periods : [];
  return list.filter((p) => p?.startTime && p?.endTime).map((p) => ({
    name: String(p.name ?? ""), start: p.startTime, end: p.endTime, day: !!p.isDaytime,
    tempF: toF(p.temperature, p.temperatureUnit), rainPct: num(p.probabilityOfPrecipitation?.value),
    wind: String(p.windSpeed ?? ""), windDir: String(p.windDirection ?? ""), short: String(p.shortForecast ?? ""), detail: String(p.detailedForecast ?? ""),
    icon: forecastIcon(p.icon, !!p.isDaytime),
  }));
}

export function nwsHours(json: any, now = new Date(), count = 12): ForecastHour[] {
  const list: any[] = Array.isArray(json?.properties?.periods) ? json.properties.periods : [];
  return list.filter((p) => p?.startTime && Date.parse(p.endTime ?? p.startTime) > now.getTime()).slice(0, count).map((p) => ({
    at: p.startTime, day: !!p.isDaytime, tempF: toF(p.temperature, p.temperatureUnit), rainPct: num(p.probabilityOfPrecipitation?.value),
    windMph: windTopMph(p.windSpeed), windDir: String(p.windDirection ?? ""), humidity: num(p.relativeHumidity?.value),
    short: String(p.shortForecast ?? ""), icon: forecastIcon(p.icon, !!p.isDaytime),
  }));
}

const SEVERITY = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];
export function nwsAlerts(json: any, now = new Date()): ForecastAlert[] {
  const list: any[] = Array.isArray(json?.features) ? json.features : [];
  return list.map((f) => f?.properties).filter((p) => p?.event && p.status !== "Test" && p.messageType !== "Cancel")
    .filter((p) => { const end = Date.parse(p.ends ?? p.expires ?? ""); return Number.isNaN(end) || end > now.getTime(); })
    .map((p) => ({
      event: String(p.event), severity: SEVERITY.includes(p.severity) ? String(p.severity) : "Unknown", headline: String(p.headline ?? p.event).slice(0, 300),
      ends: p.ends ?? p.expires ?? null,
      url: null as string | null,
    }))
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
}

/** The forecast for a spot. Throws (in plain words) when the Weather Service has nothing or can't be reached. */
export async function forecastAt(lat: number, lng: number, now = new Date()): Promise<Forecast & { stale: boolean }> {
  // The Weather Service wants no more than four decimals.
  const at = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const point = await keep(`point:${at}`, 24 * 60 * MIN, async () => {
    const p = (await get(`${NWS}/points/${at}`))?.properties;
    if (!p?.forecast || !p?.forecastHourly) throw new Error("The National Weather Service has no forecast for this location.");
    const where = p.relativeLocation?.properties;
    return { forecast: String(p.forecast), hourly: String(p.forecastHourly), radar: typeof p.radarStation === "string" ? p.radarStation : null, place: where?.city ? `${where.city}${where.state ? `, ${where.state}` : ""}` : "" };
  });
  const [daily, hourly, alerts] = await Promise.all([
    keep(`daily:${at}`, 15 * MIN, () => get(point.value.forecast)),
    keep(`hourly:${at}`, 15 * MIN, () => get(point.value.hourly)),
    // Warnings matter by the minute, and their absence shouldn't sink the forecast.
    keep(`alerts:${at}`, 4 * MIN, () => get(`${NWS}/alerts/active?point=${at}`)).catch(() => ({ value: null, stale: true })),
  ]);
  const page = `https://forecast.weather.gov/MapClick.php?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`;
  return {
    place: point.value.place, lat, lng,
    updatedAt: daily.value?.properties?.updateTime ?? daily.value?.properties?.generatedAt ?? null,
    // Periods already over drop off (a kept answer can be a few minutes behind the clock).
    periods: nwsPeriods(daily.value).filter((p) => Date.parse(p.end) > now.getTime()),
    hours: nwsHours(hourly.value, now),
    // The Weather Service's page for the spot lists what's in effect, with the full wording.
    alerts: nwsAlerts(alerts.value, now).map((a) => ({ ...a, url: page })),
    pages: { forecast: page, hourly: `${page}&FcstType=graphical`, radar: point.value.radar ? `https://radar.weather.gov/station/${encodeURIComponent(point.value.radar)}/standard` : "https://radar.weather.gov/" },
    stale: daily.stale || hourly.stale,
  };
}

/* ───────────── For a company ───────────── */

export async function weatherLinks(companyId: string): Promise<WeatherLink[]> {
  const [c] = await db.select({ weather: companies.weather }).from(companies).where(eq(companies.id, companyId));
  return Array.isArray(c?.weather?.links) ? c!.weather!.links! : [];
}
export async function saveWeatherLinks(companyId: string, links: WeatherLink[]) {
  const [c] = await db.select({ weather: companies.weather }).from(companies).where(eq(companies.id, companyId));
  await db.update(companies).set({ weather: { ...(c?.weather ?? {}), links } }).where(eq(companies.id, companyId));
  return links;
}

/**
 * What the forecast box shows: the forecast for the business address, the company's own weather
 * links, and (when there is no forecast) why not, in words for the person looking.
 */
export async function companyForecast(companyId: string, now = new Date()) {
  const links = await weatherLinks(companyId);
  const depot = (await dispatchSettings(companyId)).depot;
  if (!depot) return { forecast: null, stale: false, links, problem: "Add your business address (Settings → Company Info) to see the forecast for where you work." };
  try {
    const { stale, ...forecast } = await forecastAt(depot.lat, depot.lng, now);
    return { forecast, stale, links, problem: null };
  } catch (e) {
    return { forecast: null, stale: false, links, problem: (e as Error).message };
  }
}

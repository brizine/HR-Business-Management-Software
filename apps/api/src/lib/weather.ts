import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  DEFAULT_WEATHER_SETTINGS, customerName, formatAddress, readingAt,
  type Observation, type WeatherReadingInput, type WeatherSettings, type WeatherSource,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, customers, employees, properties, serviceTypes, visitLines, visitWeather, visits, weatherDays } from "../db/schema";
import { localParts } from "./tz";

/**
 * Weather on chemical applications (Crewdesk plan, "Weather, handled by the office"). Work orders
 * with a chemical service get the weather when they're completed: automatically from the National
 * Weather Service for the property's location and the completion time, or from the office's entry
 * for the day. Techs never see or enter it.
 */

export async function weatherSettings(companyId: string): Promise<WeatherSettings> {
  const [c] = await db.select({ weather: companies.weather }).from(companies).where(eq(companies.id, companyId));
  return { mode: c?.weather?.mode ?? DEFAULT_WEATHER_SETTINGS.mode };
}

/* ───────────── The weather service ───────────── */

export type StationData = { station: string; observations: Observation[] };
export interface WeatherFetcher { observations(lat: number, lng: number, from: Date, to: Date): Promise<StationData> }

const NWS = "https://api.weather.gov";
// The Weather Service asks for a User-Agent; set WEATHER_USER_AGENT to add a contact (e.g. a website).
const userAgent = () => process.env.WEATHER_USER_AGENT || "Crewdesk (weather on application records)";
const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function nwsGet(url: string): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { "user-agent": userAgent(), accept: "application/geo+json" }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error("Couldn't reach the National Weather Service; trying again later");
  }
  if (r.status === 404) throw new Error("The National Weather Service has no data for this location");
  if (!r.ok) throw new Error(`The National Weather Service answered ${r.status}; trying again later`);
  return r.json();
}

/** A value from the Weather Service in the unit we want (it labels each value's unit). */
function inUnit(q: { value?: number | null; unitCode?: string } | undefined, want: "kmh" | "c" | "mm" | "deg"): number | null {
  if (!q || q.value == null || !Number.isFinite(q.value)) return null;
  const u = (q.unitCode ?? "").split(":").pop() ?? "";
  switch (want) {
    case "kmh": return u === "m_s-1" ? q.value * 3.6 : u === "kn" ? q.value * 1.852 : q.value;
    case "c": return u === "degF" ? ((q.value - 32) * 5) / 9 : q.value;
    case "mm": return u === "m" ? q.value * 1000 : q.value;
    default: return q.value;
  }
}

/** Observations from a Weather Service response (/stations/{id}/observations). */
export function nwsObservations(json: any): Observation[] {
  return (json?.features ?? []).map((f: any) => {
    const p = f.properties ?? {};
    return {
      at: p.timestamp,
      tempC: inUnit(p.temperature, "c"),
      windKmh: inUnit(p.windSpeed, "kmh"),
      windDeg: inUnit(p.windDirection, "deg"),
      gustKmh: inUnit(p.windGust, "kmh"),
      precipLastHourMm: inUnit(p.precipitationLastHour, "mm"),
    } satisfies Observation;
  }).filter((o: Observation) => !!o.at);
}

const stations = new Map<string, { at: number; id: string; name: string }>();
const nationalWeatherService: WeatherFetcher = {
  async observations(lat, lng, from, to) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    let st = stations.get(key);
    if (!st || Date.now() - st.at > 86_400_000) {
      const point = await nwsGet(`${NWS}/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
      const list = await nwsGet(point?.properties?.observationStations);
      const f = list?.features?.[0];
      if (!f) throw new Error("No weather station near this property");
      st = { at: Date.now(), id: f.properties.stationIdentifier, name: f.properties.name };
      stations.set(key, st);
    }
    const obs = await nwsGet(`${NWS}/stations/${st.id}/observations?start=${isoSeconds(from)}&end=${isoSeconds(to)}`);
    return { station: `${st.name} (${st.id})`, observations: nwsObservations(obs) };
  },
};

let fetcher: WeatherFetcher = nationalWeatherService;
/** Tests swap in a fake weather service. */
export function setWeatherFetcher(f: WeatherFetcher | null) { fetcher = f ?? nationalWeatherService; stations.clear(); }

/* ───────────── Which work orders get weather ───────────── */

/** The work order has a chemical service (from the price list). */
const chemicalVisit = sql`exists (select 1 from visit_lines l join service_types st on st.id = l.service_type_id where l.visit_id = "visits"."id" and st.chemical)`;
/** The weather station keeps about a week of observations. */
const AUTO_DAYS = 7;
const MAX_TRIES = 12;
const RETRY_MS = 15 * 60_000;

async function companyTz(companyId: string) {
  const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  return c?.tz ?? "America/Chicago";
}

async function upsert(visitId: string, companyId: string, set: Partial<typeof visitWeather.$inferInsert>) {
  await db.insert(visitWeather).values({ visitId, companyId, ...set }).onConflictDoUpdate({ target: visitWeather.visitId, set: { ...set, updatedAt: new Date() } });
}

/**
 * Looks up the weather for one completed work order. Office and day entries are kept unless
 * `force` (the office's "Fetch now"). Returns why not when there's no reading yet.
 */
export async function fetchAutoWeather(visitId: string, opts: { force?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db.select({ v: visits, lat: properties.lat, lng: properties.lng, w: visitWeather })
    .from(visits).leftJoin(properties, eq(properties.id, visits.propertyId)).leftJoin(visitWeather, eq(visitWeather.visitId, visits.id))
    .where(eq(visits.id, visitId));
  if (!row || row.v.status !== "completed" || !row.v.completedAt) return { ok: false, error: "The work order isn't completed" };
  if (row.w?.source && row.w.source !== "auto" && !opts.force) return { ok: true };
  const { v } = row;
  const tries = (row.w?.tries ?? 0) + 1;
  const fail = async (error: string, giveUp = false) => {
    await upsert(v.id, v.companyId, { tries: giveUp ? MAX_TRIES : tries, lastTryAt: new Date(), lastError: error });
    return { ok: false as const, error };
  };
  const lat = row.lat ?? v.completedLat;
  const lng = row.lng ?? v.completedLng;
  if (lat == null || lng == null) return fail("The property has no map location (and the phone sent none)", true);
  const at = v.completedAt!;
  if (Date.now() - at.getTime() > AUTO_DAYS * 86_400_000) return fail("Older than the week the weather station keeps; enter it by hand", true);
  let data: StationData;
  try {
    data = await fetcher.observations(lat, lng, new Date(at.getTime() - 25 * 3_600_000), new Date(at.getTime() + 2 * 3_600_000));
  } catch (e) {
    return fail((e as Error).message || "The weather service didn't answer");
  }
  const r = readingAt(data.observations, at);
  if (!r) return fail(`${data.station} hasn't reported for that time yet`);
  await upsert(v.id, v.companyId, {
    source: "auto", observedAt: new Date(r.observedAt), windMph: r.windMph, windDeg: r.windDeg, gustMph: r.gustMph, tempF: r.tempF, rainIn: r.rainIn,
    station: data.station, note: null, enteredById: null, tries, lastTryAt: new Date(), lastError: null,
  });
  return { ok: true };
}

/**
 * Puts the office's entry for a day on that day's completed chemical work orders that don't have
 * automatic or office weather (and takes it back off when the entry is deleted). Returns how many.
 */
export async function applyDayWeather(companyId: string, date: string, byId?: string | null) {
  const tz = await companyTz(companyId);
  const [day] = await db.select().from(weatherDays).where(and(eq(weatherDays.companyId, companyId), eq(weatherDays.date, date)));
  const rows = await db.select({ id: visits.id, completedAt: visits.completedAt, source: visitWeather.source })
    .from(visits).leftJoin(visitWeather, eq(visitWeather.visitId, visits.id))
    .where(and(eq(visits.companyId, companyId), eq(visits.status, "completed"), sql`(${visits.completedAt} at time zone ${tz})::date = ${date}::date`, chemicalVisit));
  const targets = rows.filter((r) => !r.source || r.source === "day");
  for (const r of targets) {
    if (day) {
      await upsert(r.id, companyId, {
        source: "day", observedAt: r.completedAt, windMph: day.windMph, windDeg: day.windDeg, gustMph: day.gustMph, tempF: day.tempF, rainIn: day.rainIn,
        station: null, note: day.note, enteredById: byId ?? day.enteredById, lastError: null,
      });
    } else if (r.source === "day") {
      await upsert(r.id, companyId, { source: null, observedAt: null, windMph: null, windDeg: null, gustMph: null, tempF: null, rainIn: null, note: null, enteredById: null });
    }
  }
  return targets.length;
}

/** The office types the weather for one work order. */
export async function setOfficeWeather(visitId: string, companyId: string, input: WeatherReadingInput, byId: string) {
  const [v] = await db.select({ completedAt: visits.completedAt }).from(visits).where(eq(visits.id, visitId));
  await upsert(visitId, companyId, {
    source: "office", observedAt: v?.completedAt ?? new Date(), windMph: input.windMph, windDeg: input.windDeg ?? null, gustMph: input.gustMph ?? null,
    tempF: input.tempF ?? null, rainIn: input.rainIn ?? null, station: null, note: input.note ?? null, enteredById: byId, lastError: null,
  });
}

/* ───────────── After completing, and the background job ───────────── */

const pending = new Set<Promise<unknown>>();
/** Tests wait for the weather lookups started by completing a work order. */
export async function flushWeather() { while (pending.size) await Promise.all([...pending]); }

/** Called when a work order is completed: gets its weather in the background (never slows the tech down). */
export function weatherAfterComplete(visitId: string, companyId: string) {
  const p = (async () => {
    const s = await weatherSettings(companyId);
    if (s.mode === "off") return;
    const [v] = await db.select({ id: visits.id, completedAt: visits.completedAt }).from(visits).where(and(eq(visits.id, visitId), chemicalVisit));
    if (!v?.completedAt) return;
    const date = localParts(v.completedAt, await companyTz(companyId)).date;
    if (s.mode === "auto") {
      const r = await fetchAutoWeather(visitId);
      if (r.ok) return;
      // Not reported yet: the job tries again; a day entry already made covers it meanwhile.
    }
    const [day] = await db.select({ id: weatherDays.id }).from(weatherDays).where(and(eq(weatherDays.companyId, companyId), eq(weatherDays.date, date)));
    if (day) await applyDayWeather(companyId, date);
  })().catch((err) => console.error("weather lookup failed", err)).finally(() => pending.delete(p));
  pending.add(p);
}

/** Every few minutes: tries again for completed chemical work orders still waiting on automatic weather. */
export async function runWeather(now = new Date()) {
  const autoCompanies = (await db.select({ id: companies.id }).from(companies).where(sql`coalesce(${companies.weather}->>'mode', 'auto') = 'auto'`)).map((c) => c.id);
  if (!autoCompanies.length) return 0;
  const since = new Date(now.getTime() - AUTO_DAYS * 86_400_000);
  const due = await db.select({ id: visits.id }).from(visits).leftJoin(visitWeather, eq(visitWeather.visitId, visits.id))
    .where(and(
      inArray(visits.companyId, autoCompanies), eq(visits.status, "completed"), gte(visits.completedAt, since), chemicalVisit,
      isNull(visitWeather.source),
      or(isNull(visitWeather.visitId), and(lt(visitWeather.tries, MAX_TRIES), or(isNull(visitWeather.lastTryAt), lt(visitWeather.lastTryAt, new Date(now.getTime() - RETRY_MS))))),
    ))
    .orderBy(asc(visits.completedAt)).limit(40);
  for (const d of due) await fetchAutoWeather(d.id);
  return due.length;
}

/* ───────────── The office's list ───────────── */

export type WeatherRecord = {
  visitId: string; number: number; title: string; completedAt: string; date: string; services: string[];
  customer: { id: string; name: string }; property: { id: string; address: string; hasLocation: boolean } | null; finishedBy: string | null;
  gps: { lat: number; lng: number; accuracy: number | null } | null;
  weather: null | {
    source: WeatherSource | null; observedAt: string | null; windMph: number | null; windDeg: number | null; gustMph: number | null; tempF: number | null; rainIn: number | null;
    station: string | null; note: string | null; enteredBy: string | null; tries: number; lastError: string | null;
  };
  needsWeather: boolean;
};

/** Completed chemical work orders (completed between `from` and `to`, local dates) and their weather. */
export async function weatherRecords(companyId: string, o: { from?: string; to?: string; visitIds?: string[] }) {
  const settings = await weatherSettings(companyId);
  const tz = await companyTz(companyId);
  const where = [eq(visits.companyId, companyId), eq(visits.status, "completed"), chemicalVisit];
  if (o.visitIds) where.push(inArray(visits.id, o.visitIds));
  if (o.from) where.push(sql`(${visits.completedAt} at time zone ${tz})::date >= ${o.from}::date`);
  if (o.to) where.push(sql`(${visits.completedAt} at time zone ${tz})::date <= ${o.to}::date`);
  const rows = await db.select({ v: visits, w: visitWeather, c: customers, p: properties })
    .from(visits).innerJoin(customers, eq(customers.id, visits.customerId)).leftJoin(properties, eq(properties.id, visits.propertyId))
    .leftJoin(visitWeather, eq(visitWeather.visitId, visits.id))
    .where(and(...where)).orderBy(desc(visits.completedAt)).limit(2000);
  const ids = rows.map((r) => r.v.id);
  const lines = ids.length ? await db.select({ visitId: visitLines.visitId, name: serviceTypes.name }).from(visitLines)
    .innerJoin(serviceTypes, eq(serviceTypes.id, visitLines.serviceTypeId)).where(and(inArray(visitLines.visitId, ids), eq(serviceTypes.chemical, true))) : [];
  const people = [...new Set(rows.flatMap((r) => [r.v.finishedById, r.w?.enteredById]).filter((x): x is string => !!x))];
  const names = new Map((people.length ? await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName }).from(employees).where(inArray(employees.id, people)) : [])
    .map((e) => [e.id, `${e.first} ${e.last}`]));
  const records: WeatherRecord[] = rows.map(({ v, w, c, p }) => {
    const has = !!w?.source;
    return {
      visitId: v.id, number: v.number, title: v.title, completedAt: v.completedAt!.toISOString(), date: localParts(v.completedAt!, tz).date,
      services: [...new Set(lines.filter((l) => l.visitId === v.id).map((l) => l.name))],
      customer: { id: c.id, name: customerName(c) }, property: p ? { id: p.id, address: formatAddress(p), hasLocation: p.lat != null } : null,
      finishedBy: v.finishedById ? names.get(v.finishedById) ?? null : null,
      gps: v.completedLat != null && v.completedLng != null ? { lat: v.completedLat, lng: v.completedLng, accuracy: v.completedAccuracy } : null,
      weather: w ? {
        source: (w.source as WeatherSource | null) ?? null, observedAt: w.observedAt?.toISOString() ?? null, windMph: w.windMph, windDeg: w.windDeg, gustMph: w.gustMph, tempF: w.tempF, rainIn: w.rainIn,
        station: w.station, note: w.note, enteredBy: w.enteredById ? names.get(w.enteredById) ?? null : null, tries: w.tries, lastError: w.lastError,
      } : null,
      needsWeather: !has,
    };
  });
  return { settings, records };
}

/** The office's day entries between two dates. */
export async function weatherDayList(companyId: string, from: string, to: string) {
  return db.select().from(weatherDays).where(and(eq(weatherDays.companyId, companyId), gte(weatherDays.date, from), lte(weatherDays.date, to))).orderBy(desc(weatherDays.date));
}

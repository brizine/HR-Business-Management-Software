import { z } from "zod";

/**
 * Weather on chemical applications (from the Crewdesk plan): the office handles it, techs never
 * enter it. Automatic pulls wind, temperature and recent rain for each stop's location and time as
 * it's completed; manual applies the office's entry for the day to every application that day.
 * Readings above the company's wind (drift) limit are flagged for review.
 */

export const WEATHER_MODES = ["auto", "manual", "off"] as const;
export type WeatherMode = (typeof WEATHER_MODES)[number];
export const WEATHER_MODE_LABELS: Record<WeatherMode, string> = {
  auto: "Automatic (National Weather Service)",
  manual: "Manual (the office enters each day's weather)",
  off: "Off",
};

/** Where a reading came from. */
export const WEATHER_SOURCES = ["auto", "day", "office"] as const;
export type WeatherSource = (typeof WEATHER_SOURCES)[number];
export const WEATHER_SOURCE_LABELS: Record<WeatherSource, string> = { auto: "Automatic", day: "Day's entry", office: "Entered by the office" };

export const weatherSettingsSchema = z.object({
  mode: z.enum(WEATHER_MODES),
  /** Wind (drift) limit: readings above it are flagged for review. */
  windLimitMph: z.coerce.number().min(1, "At least 1 mph").max(40, "At most 40 mph"),
});
export type WeatherSettings = z.infer<typeof weatherSettingsSchema>;
export const DEFAULT_WEATHER_SETTINGS: WeatherSettings = { mode: "auto", windLimitMph: 10 };

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const num = (min: number, max: number, msg: string) => z.preprocess(blankToNull, z.coerce.number().min(min, msg).max(max, msg).nullable()).optional();

/** A reading the office types in (for one work order, or for the whole day). */
export const weatherReadingSchema = z.object({
  windMph: z.preprocess((v) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v), z.coerce.number({ invalid_type_error: "Enter the wind speed" }).min(0, "Wind can't be negative").max(100, "Check the wind speed")),
  /** Where the wind comes from, in degrees (0 = from the north). */
  windDeg: z.preprocess(blankToNull, z.coerce.number().int().min(0).max(359).nullable()).optional(),
  gustMph: num(0, 150, "Check the gusts"),
  tempF: num(-40, 130, "Check the temperature"),
  /** Rain in the last 24 hours, in inches. */
  rainIn: num(0, 20, "Check the rain"),
  note: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
});
export type WeatherReadingInput = z.infer<typeof weatherReadingSchema>;

/** Compass points, clockwise from north. */
export const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;
export const compass = (deg: number | null | undefined) => (deg == null ? null : COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);
export const compassDeg = (point: string) => { const i = COMPASS.indexOf(point as (typeof COMPASS)[number]); return i < 0 ? null : i * 22.5; };

const round1 = (n: number) => Math.round(n * 10) / 10;
export const kmhToMph = (v: number) => round1(v / 1.609344);
export const cToF = (v: number) => round1((v * 9) / 5 + 32);
export const mmToIn = (v: number) => Math.round((v / 25.4) * 100) / 100;

/** One station observation, in the station's own units (km/h, °C, mm), as weather services report them. */
export type Observation = { at: string; tempC: number | null; windKmh: number | null; windDeg: number | null; gustKmh: number | null; precipLastHourMm: number | null };
export type WeatherReading = { observedAt: string; windMph: number | null; windDeg: number | null; gustMph: number | null; tempF: number | null; rainIn: number | null };

/**
 * The reading for a moment: the observation nearest `at` (within 90 minutes) that has wind or
 * temperature, plus the rain over the 24 hours before it. Null when nothing close was reported yet.
 */
export function readingAt(obs: Observation[], at: Date): WeatherReading | null {
  const t = at.getTime();
  const near = obs
    .filter((o) => o.windKmh != null || o.tempC != null)
    .map((o) => ({ o, d: Math.abs(Date.parse(o.at) - t) }))
    .filter((x) => x.d <= 90 * 60_000)
    .sort((a, b) => a.d - b.d)[0]?.o;
  if (!near) return null;
  const day = obs.filter((o) => { const x = Date.parse(o.at); return x > t - 24 * 3_600_000 && x <= t && o.precipLastHourMm != null; });
  // Hourly reports each cover the hour before them; specials in between repeat part of an hour, so take one per hour.
  const byHour = new Map<number, number>();
  for (const o of day) { const h = Math.floor(Date.parse(o.at) / 3_600_000); byHour.set(h, Math.max(byHour.get(h) ?? 0, o.precipLastHourMm!)); }
  const rainMm = day.length ? [...byHour.values()].reduce((a, b) => a + b, 0) : null;
  return {
    observedAt: near.at,
    windMph: near.windKmh != null ? kmhToMph(near.windKmh) : null,
    windDeg: near.windDeg != null ? Math.round(near.windDeg) : null,
    gustMph: near.gustKmh != null ? kmhToMph(near.gustKmh) : null,
    tempF: near.tempC != null ? cToF(near.tempC) : null,
    rainIn: rainMm != null ? mmToIn(rainMm) : null,
  };
}

/** Over the company's wind (drift) limit. */
export const overWindLimit = (r: { windMph: number | null } | null | undefined, limitMph: number) => !!r && r.windMph != null && r.windMph > limitMph;

/** "8 mph SSW, gusts 15" */
export function windText(r: { windMph: number | null; windDeg?: number | null; gustMph?: number | null }) {
  if (r.windMph == null) return "";
  const dir = compass(r.windDeg);
  return `${r.windMph} mph${dir ? ` ${dir}` : ""}${r.gustMph ? `, gusts ${r.gustMph}` : ""}`;
}

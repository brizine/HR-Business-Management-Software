import { z } from "zod";

/**
 * Weather on chemical applications (from the Crewdesk plan): the office handles it, techs never
 * enter it. Automatic pulls wind, temperature and recent rain for each stop's location and time as
 * it's completed; manual applies the office's entry for the day to every application that day.
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
});
export type WeatherSettings = z.infer<typeof weatherSettingsSchema>;
export const DEFAULT_WEATHER_SETTINGS: WeatherSettings = { mode: "auto" };

/* ───────────── The forecast box (the weather icon in the top bar) ───────────── */

/** A weather site the company likes to check (radar, a wind map…): opened in a new window from the forecast box. */
export const weatherLinkSchema = z.object({
  label: z.string().trim().min(1, "Give the link a name").max(40),
  url: z.string().trim().max(300).transform((v) => (/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`))
    .refine((v) => { try { const u = new URL(v); return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes("."); } catch { return false; } }, "Enter a web address, like www.weather.gov"),
});
export type WeatherLink = z.infer<typeof weatherLinkSchema>;
export const MAX_WEATHER_LINKS = 12;
export const weatherLinksSchema = z.object({ links: z.array(weatherLinkSchema).max(MAX_WEATHER_LINKS, `Up to ${MAX_WEATHER_LINKS} links`) });

/** The pictures the forecast is drawn with. */
export const FORECAST_ICONS = ["sun", "moon", "partly", "partly-night", "cloud", "rain", "storm", "snow", "fog", "wind"] as const;
export type ForecastIcon = (typeof FORECAST_ICONS)[number];

/** One line of the 7-day forecast ("Tonight", "Friday"). */
export type ForecastPeriod = {
  name: string; start: string; end: string; day: boolean; tempF: number | null; rainPct: number | null;
  /** As the Weather Service words it: "7 to 12 mph". */
  wind: string; windDir: string; short: string; detail: string; icon: ForecastIcon;
};
/** One hour ahead. */
export type ForecastHour = { at: string; day: boolean; tempF: number | null; rainPct: number | null; windMph: number | null; windDir: string; humidity: number | null; short: string; icon: ForecastIcon };
/** A warning, watch or advisory in effect for the spot. */
export type ForecastAlert = { event: string; severity: string; headline: string; ends: string | null; url: string | null };
export type Forecast = {
  /** "Norman, OK" */
  place: string; lat: number; lng: number;
  /** When the Weather Service last wrote the forecast. */
  updatedAt: string | null;
  periods: ForecastPeriod[]; hours: ForecastHour[]; alerts: ForecastAlert[];
  /** The Weather Service's own pages for this spot. */
  pages: { forecast: string; hourly: string; radar: string };
};

/**
 * The picture for one of the Weather Service's forecast icons. Its address names the weather
 * ("…/icons/land/day/tsra_hi,40?size=medium"; two when it changes during the period), and the
 * worst of what it names is what the picture shows.
 */
export function forecastIcon(iconUrl: string | null | undefined, day: boolean): ForecastIcon {
  const codes = (iconUrl ?? "").split("?")[0].split("/").slice(-2).map((part) => part.split(",")[0].toLowerCase()).filter((c) => c && c !== "day" && c !== "night" && c !== "land");
  const kind = (c: string): [number, ForecastIcon] => {
    if (/tsra|tornado|hurricane|tropical/.test(c)) return [6, "storm"];
    if (/snow|sleet|blizzard|fzra/.test(c)) return [5, "snow"];
    if (/rain|shower/.test(c)) return [4, "rain"];
    if (/fog|haze|smoke|dust/.test(c)) return [3, "fog"];
    if (/ovc|bkn/.test(c)) return [2, "cloud"];
    if (/sct/.test(c)) return [1, day ? "partly" : "partly-night"];
    if (/^wind/.test(c)) return [1, "wind"];
    return [0, day ? "sun" : "moon"];
  };
  return codes.map(kind).sort((a, b) => b[0] - a[0])[0]?.[1] ?? (day ? "sun" : "moon");
}

/** "7 to 12 mph" → 12; "5 mph" → 5. The top of the range, which is what matters before spraying. */
export function windTopMph(text: string | null | undefined): number | null {
  const nums = (text ?? "").match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : null;
}

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

/** "8 mph SSW, gusts 15" */
export function windText(r: { windMph: number | null; windDeg?: number | null; gustMph?: number | null }) {
  if (r.windMph == null) return "";
  const dir = compass(r.windDeg);
  return `${r.windMph} mph${dir ? ` ${dir}` : ""}${r.gustMph ? `, gusts ${r.gustMph}` : ""}`;
}

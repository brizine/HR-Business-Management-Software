import { eq } from "drizzle-orm";
import { pickOkMapsLayers, type ImagerySource, type MeasureImagerySettings } from "@crewdesk/shared";
import { db } from "../db";
import { companies } from "../db/schema";

/**
 * Aerial photo sources for the Measure page. Oklahoma's statewide photos are found automatically by reading
 * the layer list on OKMaps (the State of Oklahoma's map server) when the Measure page asks, at most twice a day, so a newly released
 * year shows up without a code change. Admins can add other sources (Settings on the Measure page).
 */
const OKMAPS = "https://okmaps.org/geoserver";
const OKMAPS_WMS = `${OKMAPS}/ogi/wms`;
const OKMAPS_ATTR = 'Aerial photos: <a href="https://okmaps.org/" target="_blank" rel="noreferrer">OKMaps</a> (Oklahoma Office of Geographic Information)';
const CHECK_EVERY_MS = 12 * 3_600_000;
/** A newly found photo is marked New for this long. */
const NEW_FOR_MS = 60 * 86_400_000;

/** What's known about particular years (flight dates and detail), for nicer labels. */
const KNOWN_LEAF_OFF: Record<number, string> = { 2025: "Feb–Mar 2025 · 6-inch · Oklahoma only" };
const KNOWN_NAIP: Record<number, string> = { 2025: "Summer 2025 · leaves on · 2-foot" };

/** Used when OKMaps can't be reached and nothing was found earlier. */
const FALLBACK = { leafOff: [{ year: 2025, layer: "ogi:Aerial2025_Composite" }], naip: [{ year: 2025, layer: "ogi:NAIP2025_Statewide_Composite" }] };

type Found = ReturnType<typeof pickOkMapsLayers>;
let cache: { at: number; found: Found; error: string | null } | null = null;

/** Every layer name in OKMaps' WMS capabilities. */
async function okMapsLayerNames(): Promise<string[]> {
  const res = await fetch(`${OKMAPS}/ows?service=WMS&version=1.3.0&request=GetCapabilities`, {
    headers: { "User-Agent": "Crewdesk/1.0 (self-hosted HR and fleet software)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OKMaps answered ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1].trim());
}

/** The statewide layers on OKMaps, re-checked every 12 hours (or now, with `refresh`). */
export async function okMapsLayers(refresh = false) {
  if (cache && !refresh && Date.now() - cache.at < CHECK_EVERY_MS) return cache;
  try {
    const found = pickOkMapsLayers(await okMapsLayerNames());
    if (!found.leafOff.length && !found.naip.length) throw new Error("No statewide photo layers were recognized in OKMaps' list");
    cache = { at: Date.now(), found, error: null };
  } catch (e) {
    // Keep what was found before; try again in an hour.
    const error = `Couldn't check OKMaps for new photos: ${(e as Error).message}`;
    cache = { at: Date.now() - CHECK_EVERY_MS + 3_600_000, found: cache?.found ?? FALLBACK, error };
  }
  return cache;
}

/** Test hook. */
export function resetImageryCache(value: typeof cache = null) {
  cache = value;
}

/**
 * The photo sources for a company: OKMaps leaf-off years (newest first; the newest is the default), the
 * company's own sources, then the newest NAIP (summer) photo. Records when each OKMaps photo first appeared,
 * so a newly released one is marked New for a while.
 */
export async function imageryFor(companyId: string, refresh = false) {
  const ok = await okMapsLayers(refresh);
  const [company] = await db.select({ measureImagery: companies.measureImagery }).from(companies).where(eq(companies.id, companyId));
  const settings: MeasureImagerySettings = company?.measureImagery ?? {};

  const auto: ImagerySource[] = [
    ...ok.found.leafOff.map(({ year, layer }) => ({
      key: `ok-${year}`, origin: "okmaps" as const, year, kind: "wms" as const, url: OKMAPS_WMS, layers: layer, attribution: OKMAPS_ATTR,
      label: `Oklahoma ${year} leaf-off`, detail: KNOWN_LEAF_OFF[year] ?? `Winter ${year} · statewide · Oklahoma only`, leafOff: true,
    })),
  ];
  const naip = ok.found.naip[0];
  const summer: ImagerySource[] = naip
    ? [{
        key: `naip-${naip.year}`, origin: "okmaps", year: naip.year, kind: "wms", url: OKMAPS_WMS, layers: naip.layer, attribution: OKMAPS_ATTR,
        label: `USDA NAIP ${naip.year}`, detail: KNOWN_NAIP[naip.year] ?? `Summer ${naip.year} · leaves on`, leafOff: false,
      }]
    : [];

  // First-seen dates. The first time this runs for a company, everything counts as already known.
  const seen = { ...(settings.seen ?? {}) };
  const firstRun = !settings.seen;
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const s of [...auto, ...summer]) {
    if (!seen[s.key]) { seen[s.key] = firstRun ? "2000-01-01" : today; changed = true; }
    s.isNew = Date.now() - new Date(`${seen[s.key]}T00:00:00Z`).getTime() < NEW_FOR_MS;
  }
  if (changed) await db.update(companies).set({ measureImagery: { ...settings, seen } }).where(eq(companies.id, companyId));

  const custom: ImagerySource[] = (settings.custom ?? []).map((c) => ({ ...c, origin: "custom" }));
  return { sources: [...auto, ...custom, ...summer], checkedAt: new Date(ok.at).toISOString(), error: ok.error };
}

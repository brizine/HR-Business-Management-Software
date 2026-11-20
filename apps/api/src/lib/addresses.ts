import { asc, eq, inArray, like, sql } from "drizzle-orm";
import { DEFAULT_ADDRESS_COUNTIES, OK_COUNTIES, addressKey, titleCaseAddress, typedAddressKeys, typedStreetWords, type MeasureImagerySettings } from "@crewdesk/shared";
import { db } from "../db";
import { addressCounties, addressPoints, companies } from "../db/schema";

/**
 * Oklahoma 911 address points from OKMaps (the State of Oklahoma's map server), the most complete list of
 * addresses, including new streets the Census and OpenStreetMap don't have yet. The counties companies work in
 * are downloaded into address_points (about 12 minutes for Cleveland + Oklahoma + McClain) and refreshed every
 * 30 days, so searching them is instant. Elsewhere in Oklahoma, `lookUpOk911` asks OKMaps directly (5–15 s).
 */
const WFS = "https://okmaps.org/geoserver/wfs";
const UA = "Crewdesk/1.0 (self-hosted HR and fleet software)";
const PAGE = 5000;
const REFRESH_MS = 30 * 86_400_000;
/** Both versions of the state's address layer: the counties have moved to v2 at different speeds. */
const LAYERS = [
  { name: "ng911:address_point", number: "address" },
  { name: "ng911:address_point_v2", number: "addnumber" },
] as const;

export interface AddressMatch { label: string; lat: number; lng: number; county: string }

interface Feature {
  geometry: { coordinates: [number, number] } | null;
  properties: Record<string, string | number | null>;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

/** A 911 record as a row (null if it lacks a number, street or location). */
export function toAddressRow(f: Feature, county: string, numberField: string) {
  const p = f.properties;
  const number = clean(p[numberField]);
  const street = clean(p.street);
  if (!f.geometry || !/^\d+$/.test(number) || !street) return null;
  const [lng, lat] = f.geometry.coordinates;
  const city = clean(p.postcomm) || (clean(p.city) === "UNINCORPORATED" ? "" : clean(p.city));
  return {
    county,
    key: addressKey({ number, street, streetType: clean(p.streettype), sufDir: clean(p.sufdir) }),
    fullAddress: clean(p.fulladdr) || [number, clean(p.predir), street, clean(p.streettype), clean(p.sufdir)].filter(Boolean).join(" "),
    city: city || null,
    zip: clean(p.zipcode) || null,
    lat, lng,
  };
}

async function wfs(params: Record<string, string>, timeout = 120_000) {
  const q = new URLSearchParams({ service: "WFS", version: "1.1.0", request: "GetFeature", outputFormat: "application/json", srsName: "EPSG:4326", ...params });
  const res = await fetch(`${WFS}?${q}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`OKMaps answered ${res.status}`);
  return (await res.json()) as { features?: Feature[] };
}

const fields = (numberField: string) => `fulladdr,${numberField},predir,street,streettype,sufdir,city,postcomm,zipcode,the_geom`;

/** Downloads one county's addresses (both layer versions, duplicates dropped) and replaces what's stored. */
export async function refreshCounty(county: string) {
  if (!(OK_COUNTIES as readonly string[]).includes(county)) throw new Error(`Unknown county ${county}`);
  await db.insert(addressCounties).values({ county, status: "loading", error: null })
    .onConflictDoUpdate({ target: addressCounties.county, set: { status: "loading", error: null } });
  try {
    const rows = new Map<string, NonNullable<ReturnType<typeof toAddressRow>>>();
    for (const layer of LAYERS) {
      for (let start = 0; ; start += PAGE) {
        const page = await wfs({
          typeName: layer.name, maxFeatures: String(PAGE), startIndex: String(start),
          propertyName: fields(layer.number), CQL_FILTER: `county = '${county.replace(/'/g, "''")} COUNTY'`,
        });
        const features = page.features ?? [];
        for (const f of features) {
          const row = toAddressRow(f, county, layer.number);
          if (row) rows.set(`${row.key}|${row.city ?? ""}`, row);
        }
        if (features.length < PAGE) break;
      }
    }
    if (!rows.size) throw new Error("OKMaps sent no addresses for this county");
    const all = [...rows.values()];
    await db.transaction(async (tx) => {
      await tx.delete(addressPoints).where(eq(addressPoints.county, county));
      for (let i = 0; i < all.length; i += 2000) await tx.insert(addressPoints).values(all.slice(i, i + 2000));
      await tx.update(addressCounties).set({ count: all.length, loadedAt: new Date(), status: null, error: null }).where(eq(addressCounties.county, county));
    });
    return all.length;
  } catch (e) {
    await db.update(addressCounties).set({ status: null, error: (e as Error).message.slice(0, 300) }).where(eq(addressCounties.county, county));
    throw e;
  }
}

/** The counties any company wants (each company's setting, or the default). */
export async function wantedCounties() {
  const rows = await db.select({ s: companies.measureImagery }).from(companies);
  const set = new Set<string>();
  for (const r of rows) for (const c of (r.s as MeasureImagerySettings | null)?.addressCounties ?? DEFAULT_ADDRESS_COUNTIES) set.add(c);
  return [...set].filter((c) => (OK_COUNTIES as readonly string[]).includes(c)).sort();
}

export const countiesFor = (settings: MeasureImagerySettings | null | undefined) => settings?.addressCounties ?? DEFAULT_ADDRESS_COUNTIES;

let refreshing: Promise<void> | null = null;
/** Asked for while a download was running: run again afterwards (with these counties forced). */
let again: string[] | null = null;

/**
 * Downloads any wanted county that's missing or over 30 days old (one at a time, in the background; a failed
 * county is tried again at the next call). Called hourly by the scheduler, and by admins' "Update now"
 * (`force` re-downloads those counties now).
 */
export function refreshAddresses(force: string[] = []): Promise<void> {
  if (refreshing) {
    again = [...new Set([...(again ?? []), ...force])];
    return refreshing;
  }
  refreshing = (async () => {
    try {
      const wanted = await wantedCounties();
      const state = new Map((await db.select().from(addressCounties)).map((r) => [r.county, r]));
      for (const county of [...new Set([...force, ...wanted])]) {
        const s = state.get(county);
        const stale = !s?.loadedAt || Date.now() - s.loadedAt.getTime() > REFRESH_MS;
        if (!force.includes(county) && !stale) continue;
        try {
          const n = await refreshCounty(county);
          console.log(`Address points: ${county} county, ${n} addresses`);
        } catch (e) {
          console.error(`Address points: couldn't download ${county} county`, (e as Error).message);
        }
      }
    } finally {
      refreshing = null;
      if (again) { const next = again; again = null; void refreshAddresses(next); }
    }
  })();
  return refreshing;
}

export const isRefreshing = () => refreshing != null;

const label = (r: { fullAddress: string; city: string | null; zip: string | null }) =>
  `${titleCaseAddress(r.fullAddress)}${r.city ? `, ${titleCaseAddress(r.city)}` : ""}, OK${r.zip ? ` ${r.zip}` : ""}`;

/**
 * Stored 911 addresses matching what was typed (it must start with a house number), nearest the map first.
 * Words after the street (a city or ZIP) prefer matches in that city or ZIP.
 */
export async function searchAddresses(typed: string, near?: { lat: number; lng: number }, limit = 6, opts: { strict?: boolean } = {}): Promise<AddressMatch[]> {
  const t = typedAddressKeys(typed);
  if (!t || t.otherState) return [];
  for (const key of t.keys) {
    const exactNumber = key.split(" ").length === 1;
    const rows = await db
      .select({ fullAddress: addressPoints.fullAddress, city: addressPoints.city, zip: addressPoints.zip, lat: addressPoints.lat, lng: addressPoints.lng, county: addressPoints.county, key: addressPoints.key })
      .from(addressPoints)
      // Just a house number ("1601"): every address with that number; otherwise keys starting with what was typed.
      .where(exactNumber ? like(addressPoints.key, `${key} %`) : like(addressPoints.key, `${key}%`))
      .orderBy(near ? sql`(${addressPoints.lat} - ${near.lat}) ^ 2 + (${addressPoints.lng} - ${near.lng}) ^ 2` : asc(addressPoints.key))
      .limit(limit * 4);
    if (!rows.length) continue;
    const extra = new Set(t.extra);
    const score = (r: (typeof rows)[number]) => (r.city && r.city.split(" ").every((w) => extra.has(w)) ? 1 : 0) + (r.zip && extra.has(r.zip) ? 1 : 0);
    // Words typed after the part that matched (a city, "OK", a ZIP). For Find, a match must agree with them.
    const place = t.words.slice(key.split(" ").length - 1).filter((w) => w !== "OK" && w !== "OKLAHOMA");
    const seen = new Set<string>();
    return rows
      .map((r, i) => ({ r, i, s: score(r) }))
      .filter(({ s }) => !opts.strict || !place.length || s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map(({ r }) => ({ label: label(r), lat: r.lat, lng: r.lng, county: r.county }))
      .filter((m) => (seen.has(m.label) ? false : (seen.add(m.label), true)))
      .slice(0, limit);
  }
  return [];
}

export interface StreetMatch { label: string; lat: number; lng: number; addresses: number }

/**
 * Streets in the stored 911 addresses matching a street name typed without a house number ("Desk", "Deskin Dr"),
 * one per street and city, nearest first; each with its address nearest `near` and how many addresses it has.
 */
export async function searchStreets(typed: string, near: { lat: number; lng: number }, limit = 6): Promise<StreetMatch[]> {
  const w = typedStreetWords(typed);
  if (!w) return [];
  // Keys are "NUMBER STREET TYPE"; the typed words must start a word of the street part.
  const pattern = `% ${w.join(" ").replace(/[%_\\]/g, "")}%`;
  const dist = sql`(${addressPoints.lat} - ${near.lat}) ^ 2 + (${addressPoints.lng} - ${near.lng}) ^ 2`;
  const street = sql`regexp_replace(${addressPoints.key}, '^[0-9]+[A-Z]? ', '')`;
  const rows = await db.execute(sql`
    select street, city, zip, lat, lng, n from (
      select ${street} as street, ${addressPoints.city} as city, ${addressPoints.zip} as zip, ${addressPoints.lat} as lat, ${addressPoints.lng} as lng,
        row_number() over (partition by ${street}, ${addressPoints.city} order by ${dist}) as rn,
        count(*) over (partition by ${street}, ${addressPoints.city}) as n,
        ${dist} as d
      from ${addressPoints}
      where ${addressPoints.key} like ${pattern}
    ) t where rn = 1 order by d limit ${limit}`);
  return (rows.rows as { street: string; city: string | null; zip: string | null; lat: number; lng: number; n: string | number }[]).map((r) => ({
    label: `${titleCaseAddress(r.street)}${r.city ? `, ${titleCaseAddress(r.city)}` : ""}, OK${r.zip ? ` ${r.zip}` : ""}`,
    lat: Number(r.lat), lng: Number(r.lng), addresses: Number(r.n),
  }));
}

/** Asks OKMaps directly (any county; slow, so only for Find, not while typing). */
export async function lookUpOk911(typed: string): Promise<AddressMatch | null> {
  const t = typedAddressKeys(typed);
  if (!t || t.otherState) return null;
  const parts = t.keys[t.keys.length - 1].split(" ");
  const streetWord = (t.keys.find((k) => k.split(" ").length >= 2) ?? "").split(" ")[1];
  if (!streetWord) return null;
  for (const layer of LAYERS) {
    try {
      const page = await wfs({
        typeName: layer.name, maxFeatures: "20", propertyName: fields(layer.number),
        CQL_FILTER: `${layer.number} = ${t.number} AND street LIKE '${streetWord.replace(/'/g, "''")}%'`,
      }, 25_000);
      const rows = (page.features ?? []).map((f) => toAddressRow(f, "", layer.number)).filter((r): r is NonNullable<typeof r> => !!r);
      if (!rows.length) continue;
      const extra = new Set(t.extra);
      const best = rows.find((r) => t.keys.some((k) => r.key.startsWith(k)) && (r.city ? r.city.split(" ").every((w) => extra.has(w)) : false))
        ?? rows.find((r) => t.keys.some((k) => r.key.startsWith(k)))
        ?? (parts.length === 1 ? rows[0] : null);
      if (best) return { label: label(best), lat: best.lat, lng: best.lng, county: best.county };
    } catch { /* try the other layer */ }
  }
  return null;
}

/** For the admin panel: each wanted county's status. */
export async function addressStatus(counties: string[]) {
  const rows = counties.length ? await db.select().from(addressCounties).where(inArray(addressCounties.county, counties)) : [];
  const by = new Map(rows.map((r) => [r.county, r]));
  return counties.map((c) => {
    const r = by.get(c);
    return { county: c, count: r?.count ?? 0, loadedAt: r?.loadedAt?.toISOString() ?? null, loading: r?.status === "loading" && isRefreshing(), error: r?.error ?? null };
  });
}


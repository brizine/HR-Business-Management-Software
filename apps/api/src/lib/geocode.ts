import { parseCoordinates } from "@crewdesk/shared";

/**
 * Finds map coordinates for what someone typed when adding a job site:
 *   - "lat, lng" or a full Google / Apple Maps link: read directly;
 *   - a short share link (maps.app.goo.gl, goo.gl/maps, maps.apple.com): followed to the full link;
 *   - a street address or place name: looked up with the US Census geocoder (street addresses),
 *     then OpenStreetMap (anything else). Neither needs an account or key.
 */
export interface GeocodeResult { lat: number; lng: number; label: string; source: "coordinates" | "link" | "census" | "openstreetmap" }

const UA = "Crewdesk/1.0 (self-hosted HR and fleet software)";
const TIMEOUT = 8000;

async function get(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json, text/html", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) });
}

const SHORT_LINK = /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.apple\.com|maps\.google\.com|www\.google\.com\/maps|google\.com\/maps)/i;

const MAP_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co|apple\.com)$/i;

/** Follows redirects by hand (up to 6), returning every address seen along the way. */
async function followLink(url: string) {
  const seen = [url];
  let current = url;
  for (let i = 0; i < 6; i++) {
    const res = await get(current, { redirect: "manual" });
    const next = res.headers.get("location");
    if (!next) break;
    current = new URL(next, current).toString();
    seen.push(current);
    // Only ever fetch Google's and Apple's own map addresses.
    if (!MAP_HOSTS.test(new URL(current).hostname)) break;
  }
  return seen;
}

/** A place name or address written inside a maps link (…/maps/place/NAME/… or ?q=NAME). */
function placeText(url: string) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get("q") ?? u.searchParams.get("query") ?? u.searchParams.get("address") ?? u.searchParams.get("daddr");
    if (q && !parseCoordinates(q)) return q;
    const m = u.pathname.match(/\/maps\/place\/([^/]+)/);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, " "));
  } catch { /* not a URL */ }
  return null;
}

async function census(address: string): Promise<GeocodeResult | null> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
  const res = await get(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number } }[] } };
  const m = body.result?.addressMatches?.[0];
  return m ? { lat: m.coordinates.y, lng: m.coordinates.x, label: m.matchedAddress, source: "census" } : null;
}

async function openStreetMap(text: string): Promise<GeocodeResult | null> {
  const res = await get(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text)}`);
  if (!res.ok) return null;
  const [m] = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  return m ? { lat: Number(m.lat), lng: Number(m.lon), label: m.display_name, source: "openstreetmap" } : null;
}

async function lookUp(text: string) {
  for (const find of [census, openStreetMap]) {
    try {
      const r = await find(text);
      if (r) return r;
    } catch { /* try the next one */ }
  }
  return null;
}

export async function geocode(input: string): Promise<GeocodeResult | null> {
  const text = input.trim();
  if (!text) return null;
  const direct = parseCoordinates(text);
  if (direct) return { ...direct, label: `${direct.lat.toFixed(5)}, ${direct.lng.toFixed(5)}`, source: "coordinates" };
  if (/^https?:\/\//i.test(text)) {
    if (!SHORT_LINK.test(text)) return null;
    const urls = await followLink(text).catch(() => [text]);
    for (const u of urls) {
      const c = parseCoordinates(u);
      if (c) return { ...c, label: placeText(u) ?? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`, source: "link" };
    }
    for (const u of urls) {
      const place = placeText(u);
      if (place) return lookUp(place);
    }
    return null;
  }
  return lookUp(text);
}

/**
 * Address suggestions while typing (Measure page "Find a property"), from Photon (photon.komoot.io), a free
 * OpenStreetMap search with no key. Results are limited to about 150 miles around the map. OpenStreetMap is
 * missing many house numbers, so a street result gets the house number that was typed, and is marked to be
 * looked up exactly (US Census geocoder) when picked.
 */
export interface AddressSuggestion {
  label: string;
  lat: number;
  lng: number;
  kind: "address" | "street" | "place";
  /** Look the label up for the exact spot when picked (a typed house number on a street result). */
  lookUp: boolean;
  /** A short note shown with it (e.g. "35 addresses" for a street). */
  detail?: string;
}

const STATES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { type?: string; name?: string; housenumber?: string; street?: string; city?: string; county?: string; state?: string; postcode?: string; countrycode?: string };
}

const cache = new Map<string, { at: number; value: AddressSuggestion[] }>();
const TTL = 10 * 60_000;

/** "123", "123A" or "123-B" at the start of what was typed. */
const typedNumber = (q: string) => q.match(/^\s*(\d+[A-Za-z]?(?:-[A-Za-z0-9]+)?)\s+\S/)?.[1] ?? null;

export function toSuggestions(q: string, features: PhotonFeature[]): AddressSuggestion[] {
  const num = typedNumber(q);
  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const p = f.properties;
    if (p.countrycode && p.countrycode !== "US") continue;
    const [lng, lat] = f.geometry.coordinates;
    const state = p.state ? STATES[p.state] ?? p.state : "";
    const tail = [p.city ?? p.county, [state, p.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    let s: AddressSuggestion | null = null;
    if (p.type === "house" && p.housenumber && (p.street || p.name)) {
      s = { label: `${p.housenumber} ${p.street ?? p.name}, ${tail}`, lat, lng, kind: "address", lookUp: false };
    } else if ((p.type === "street" || (p.type === "house" && !p.housenumber)) && (p.street || p.name)) {
      const street = p.street ?? p.name!;
      s = num
        ? { label: `${num} ${street}, ${tail}`, lat, lng, kind: "address", lookUp: true }
        : { label: `${street}, ${tail}`, lat, lng, kind: "street", lookUp: false };
    } else if (p.name && ["city", "town", "village", "locality", "district", "county"].includes(p.type ?? "")) {
      s = { label: p.type === "locality" && p.street ? `${p.housenumber ? `${p.housenumber} ` : ""}${p.street}, ${tail}` : `${p.name}${state ? `, ${state}` : ""}`, lat, lng, kind: "place", lookUp: false };
    } else if (p.name) {
      // A named place (a school, park, business): name and where it is.
      s = { label: `${p.name}, ${tail}`, lat, lng, kind: "place", lookUp: false };
    }
    if (!s || !tail && s.kind !== "place") continue;
    const key = s.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

export async function suggestAddresses(q: string, near: { lat: number; lng: number }): Promise<AddressSuggestion[]> {
  const lat = Math.max(-85, Math.min(85, near.lat)), lng = Math.max(-180, Math.min(180, near.lng));
  const key = `${q.toLowerCase()}|${lat.toFixed(1)}|${lng.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const params = new URLSearchParams({
    q, limit: "12", lang: "en", lat: String(lat), lon: String(lng),
    // About 150 miles around the map.
    bbox: [lng - 2.6, lat - 2.2, lng + 2.6, lat + 2.2].map((n) => n.toFixed(3)).join(","),
  });
  try {
    const res = await fetch(`https://photon.komoot.io/api/?${params}`, {
      headers: { "User-Agent": "Crewdesk/1.0 (self-hosted HR and fleet software)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { features?: PhotonFeature[] };
    const value = toSuggestions(q, body.features ?? []);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return []; // Suggestions are a convenience; typing and Find still work without them.
  }
}

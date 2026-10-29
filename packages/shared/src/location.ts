import { z } from "zod";

/**
 * Location rules for clocking in and out, set separately for each:
 * - optional: record location if the phone shares it
 * - required: location must be on
 * - geofence_flag: location required; punches away from every job site are flagged and the manager is told
 * - geofence_block: location required; punches away from every job site are refused
 */
export const LOCATION_POLICIES = ["optional", "required", "geofence_flag", "geofence_block"] as const;
export type LocationPolicy = (typeof LOCATION_POLICIES)[number];

export const LOCATION_POLICY_LABELS: Record<LocationPolicy, string> = {
  optional: "Optional",
  required: "Required",
  geofence_flag: "Required; flag if away from a job site",
  geofence_block: "Required at a job site (block elsewhere)",
};

export const needsLocation = (p: LocationPolicy) => p !== "optional";
export const usesGeofence = (p: LocationPolicy) => p === "geofence_flag" || p === "geofence_block";

/** How much of the phone's reported GPS inaccuracy we forgive, at most. */
export const MAX_ACCURACY_ALLOWANCE_M = 100;

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface SiteLike {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusMeters: number;
}

/**
 * The nearest job site and whether the point counts as on site. A punch is
 * on site if it's within the site's radius plus the phone's reported
 * accuracy (capped), so a weak GPS fix at the edge of a yard isn't refused.
 */
export function nearestSite<S extends SiteLike>(point: { lat: number; lng: number; accuracy?: number | null }, sites: S[]) {
  let best: { site: S; distance: number; onSite: boolean } | null = null;
  const allowance = Math.min(Math.max(point.accuracy ?? 0, 0), MAX_ACCURACY_ALLOWANCE_M);
  for (const site of sites) {
    const distance = distanceMeters(point, site);
    const onSite = distance <= site.radiusMeters + allowance;
    if (!best || (onSite && !best.onSite) || (onSite === best.onSite && distance < best.distance)) best = { site, distance, onSite };
  }
  return best;
}

/** "120 m" / "2.3 km" */
export const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * Pulls coordinates out of a pasted Google/Apple Maps link or a "lat, lng" pair.
 * Returns null if it can't find any.
 */
export function parseCoordinates(input: string): { lat: number; lng: number } | null {
  const s = decodeURIComponent(input.trim());
  const patterns = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|ll|query|sll|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

export const jobSiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(300).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** 25 m (a single building) to 5 km (a large property). */
  radiusMeters: z.number().int().min(25).max(5000).default(150),
  active: z.boolean().default(true),
});

export const locationPolicySchema = z.object({
  clockIn: z.enum(LOCATION_POLICIES),
  clockOut: z.enum(LOCATION_POLICIES),
});

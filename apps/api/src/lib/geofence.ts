import { and, eq } from "drizzle-orm";
import { formatDistance, nearestSite, needsLocation, usesGeofence, type LocationPolicy } from "@crewdesk/shared";
import { db } from "../db";
import { companies, jobSites } from "../db/schema";
import { HttpError } from "./errors";

export interface PunchLocation {
  lat?: number;
  lng?: number;
  accuracy?: number;
}

export interface PunchCheck {
  siteId: string | null;
  siteName: string | null;
  distance: number | null;
  /** "off_site" when allowed but away from every job site (geofence_flag). */
  flag: string | null;
}

export async function locationPolicies(companyId: string) {
  const [c] = await db
    .select({ clockIn: companies.clockInLocation, clockOut: companies.clockOutLocation })
    .from(companies)
    .where(eq(companies.id, companyId));
  return { clockIn: c.clockIn as LocationPolicy, clockOut: c.clockOut as LocationPolicy };
}

export async function activeSites(companyId: string) {
  return db
    .select()
    .from(jobSites)
    .where(and(eq(jobSites.companyId, companyId), eq(jobSites.active, true)));
}

/**
 * Applies the company's rule for this punch. Throws if the punch isn't
 * allowed; otherwise returns the nearest job site and any flag. With no
 * active job sites, geofence rules fall back to "location required" (so
 * nobody is locked out before sites are set up).
 */
export async function checkPunch(companyId: string, policy: LocationPolicy, loc: PunchLocation, action: "in" | "out"): Promise<PunchCheck> {
  const hasLocation = loc.lat !== undefined && loc.lng !== undefined;
  if (needsLocation(policy) && !hasLocation) {
    throw new HttpError(
      400,
      `Your company requires location to clock ${action}. Turn on location for Biz Management Software in your phone's settings and try again.`,
      "location_required",
    );
  }
  if (!hasLocation) return { siteId: null, siteName: null, distance: null, flag: null };

  const sites = await activeSites(companyId);
  const nearest = nearestSite({ lat: loc.lat!, lng: loc.lng!, accuracy: loc.accuracy }, sites);
  const result: PunchCheck = {
    siteId: nearest?.onSite ? nearest.site.id : null,
    siteName: nearest?.onSite ? nearest.site.name : null,
    distance: nearest ? Math.round(nearest.distance) : null,
    flag: null,
  };
  if (!usesGeofence(policy) || !nearest || nearest.onSite) return result;

  if (policy === "geofence_block") {
    throw new HttpError(
      403,
      `You're ${formatDistance(nearest.distance)} from the nearest job site (${nearest.site.name}). Clock ${action} when you're on site, or ask your manager to add the time for you.`,
      "outside_job_site",
    );
  }
  return { ...result, flag: "off_site" };
}

import { DEFAULT_ROAD_URL, estimateLeg, type DispatchSettings, type Leg, type Pt } from "@crewdesk/shared";

/**
 * Drive times and distances for dispatch routes. Two ways to measure:
 *   - "estimate" (the default): the straight line stretched to road length, at in-town speeds.
 *     Needs nothing outside Crewdesk.
 *   - "road": an OSRM-compatible routing server works out the real roads, the line to draw and
 *     turn-by-turn steps. Only coordinates are sent to it, never names or addresses.
 * Anything that goes wrong with the routing server falls back to the estimate, so a route can
 * always be built.
 */

const TIMEOUT = 9000;
type How = Pick<DispatchSettings, "routing" | "roadUrl">;
export type Step = { text: string; meters: number };
export type Measured = { legs: Leg[]; geometry: [number, number][] | null; measured: "road" | "estimate"; steps: Step[][] | null };

const coords = (pts: Pt[]) => pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
const base = (how: How) => (how.roadUrl || DEFAULT_ROAD_URL).replace(/\/+$/, "");

async function ask(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": "Crewdesk/1.0 (dispatch routing)", Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`Routing server answered ${res.status}`);
  const body = (await res.json()) as { code?: string };
  if (body.code !== "Ok") throw new Error(`Routing server said ${body.code ?? "nothing"}`);
  return body as any;
}

/** "Turn left onto W Gray St" from a routing server's maneuver. */
function stepText(s: { name?: string; maneuver?: { type?: string; modifier?: string } }): string {
  const type = s.maneuver?.type ?? "";
  const how = s.maneuver?.modifier ?? "";
  const onto = s.name ? ` onto ${s.name}` : "";
  if (type === "depart") return `Head out${s.name ? ` on ${s.name}` : ""}`;
  if (type === "arrive") return "Arrive";
  if (type === "roundabout" || type === "rotary") return `Take the roundabout${onto}`;
  if (type === "merge") return `Merge${onto}`;
  if (type === "on ramp") return `Take the ramp${onto}`;
  if (type === "off ramp") return `Take the exit${onto}`;
  if (type === "fork") return `Keep ${how.includes("left") ? "left" : "right"}${onto}`;
  if (type === "new name" || how === "straight") return `Continue${onto}`;
  if (how === "uturn") return `Make a U-turn${onto}`;
  if (how) return `Turn ${how}${onto}`;
  return `Continue${onto}`;
}

const byEstimate = (pts: Pt[]): Measured => ({ legs: pts.slice(1).map((p, i) => estimateLeg(pts[i], p)), geometry: null, measured: "estimate", steps: null });

/** The drives along `pts` in order: n points give n-1 legs. */
export async function measureLegs(how: How, pts: Pt[], o: { steps?: boolean } = {}): Promise<Measured> {
  if (pts.length < 2) return { legs: [], geometry: null, measured: how.routing === "road" ? "road" : "estimate", steps: null };
  if (how.routing !== "road") return byEstimate(pts);
  try {
    const r = await ask(`${base(how)}/route/v1/driving/${coords(pts)}?overview=full&geometries=geojson&steps=${o.steps ? "true" : "false"}`);
    const route = r.routes?.[0];
    if (!route || route.legs?.length !== pts.length - 1) throw new Error("The routing server's answer didn't match the stops");
    return {
      legs: route.legs.map((l: { distance: number; duration: number }) => ({ meters: Math.round(l.distance), seconds: Math.round(l.duration) })),
      geometry: (route.geometry?.coordinates ?? []).map(([lng, lat]: [number, number]) => [lat, lng] as [number, number]),
      measured: "road",
      steps: o.steps ? route.legs.map((l: { steps?: { name?: string; distance?: number; maneuver?: { type?: string; modifier?: string } }[] }) => (l.steps ?? []).map((s) => ({ text: stepText(s), meters: Math.round(s.distance ?? 0) }))) : null,
    };
  } catch {
    return byEstimate(pts);
  }
}

/** Seconds from every point to every other (for ordering stops). */
export async function driveMatrix(how: How, pts: Pt[]): Promise<number[][]> {
  const estimate = () => pts.map((a) => pts.map((b) => (a === b ? 0 : estimateLeg(a, b).seconds)));
  if (how.routing !== "road" || pts.length < 2 || pts.length > 100) return estimate();
  try {
    const r = await ask(`${base(how)}/table/v1/driving/${coords(pts)}?annotations=duration`);
    const d = r.durations as (number | null)[][] | undefined;
    if (!d || d.length !== pts.length) throw new Error("The routing server's table didn't match the stops");
    const fallback = estimate();
    return d.map((row, i) => row.map((s, j) => (s == null ? fallback[i][j] : s)));
  } catch {
    return estimate();
  }
}

import { z } from "zod";
import { distanceMeters } from "./location";
import { BACK_REASONS } from "./waitlist";

/**
 * Dispatch: who does each stop, and in what order. Both dispatch boards (the one from the Crewdesk
 * plan and the Homeworks-style beta) sit on the same rules:
 *   - an "event" is a work order or a to-do on a day, named by a key ("v:<id>" or "t:<id>");
 *   - a route is an ordered set of stops one crew (or set of people) does in a day;
 *   - changing who does a stop, or its day, takes it off its route, and the rest close the gap.
 */

export type Pt = { lat: number; lng: number };
/** The drive into a stop: meters and seconds. */
export type Leg = { meters: number; seconds: number };

export const DISPATCH_ROUTE_MAX = 100;
export const METERS_PER_MILE = 1609.344;

export type EventKind = "visit" | "todo";
export const eventKey = (kind: EventKind, id: string) => `${kind === "visit" ? "v" : "t"}:${id}`;
export function parseEventKey(key: string): { kind: EventKind; id: string } {
  return { kind: key.startsWith("t:") ? "todo" : "visit", id: key.slice(2) };
}

/** Which lane an event sits in: a crew's, a set of people's, or Unassigned. */
export function laneKeyOf(e: { crewId?: string | null; assigneeIds: string[] }): string {
  if (e.crewId) return `crew:${e.crewId}`;
  if (e.assigneeIds.length) return `emp:${[...e.assigneeIds].sort().join(",")}`;
  return "unassigned";
}

/* ───────────── Drive estimates ───────────── */

/**
 * The drive between two points when no road-routing service is switched on: the straight line
 * stretched to road length, at in-town speeds (short hops are slow streets, longer ones faster roads).
 */
export function estimateLeg(a: Pt, b: Pt): Leg {
  const meters = distanceMeters(a, b) * 1.35;
  const miles = meters / METERS_PER_MILE;
  const mph = miles < 1 ? 18 : miles < 5 ? 26 : miles < 15 ? 36 : 48;
  return { meters: Math.round(meters), seconds: miles < 0.01 ? 0 : Math.round((miles / mph) * 3600) };
}

/** "4 mi · 8 min" for a leg; short drives keep one decimal. */
export function legText(leg: Leg | null | undefined): string {
  if (!leg) return "";
  const miles = leg.meters / METERS_PER_MILE;
  return `${miles < 10 ? (Math.round(miles * 10) / 10).toString() : Math.round(miles).toString()} mi · ${Math.max(leg.seconds > 0 ? 1 : 0, Math.round(leg.seconds / 60))} min`;
}
export const milesText = (meters: number) => (Math.round((meters / METERS_PER_MILE) * 10) / 10).toFixed(1);
/** 5400 → "1:30"; hours can pass 24. */
export function clockText(seconds: number): string {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/* ───────────── Ordering stops ───────────── */

/** Where a route starts or ends in the cost function. */
export const START = -1;
export const END = -2;

/**
 * Orders `n` stops (numbered 0…n-1) so the drive is shortest: nearest neighbour, then swaps that
 * shorten it (2-opt and single-stop moves). `cost(from, to)` is seconds; START and END stand for
 * the route's ends when it has them. `first` keeps one stop first (a pinned stop); `last` holds
 * stops that go at the end in the order given (ones with no location).
 */
export function optimizeOrder(n: number, cost: (from: number, to: number) => number, o: { hasStart?: boolean; hasEnd?: boolean; first?: number | null; last?: number[]; fixed?: number[] } = {}): number[] {
  const locked = new Set((o.fixed ?? []).filter((i) => i >= 0 && i < n));
  if (o.first === 0) locked.add(0);
  if (o.fixed?.length && locked.size) return optimizeAround(n, cost, o, locked);
  const tail = (o.last ?? []).filter((i) => i >= 0 && i < n && i !== o.first);
  const held = new Set(tail);
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!held.has(i) && i !== o.first) free.push(i);
  const order: number[] = [];
  if (o.first != null && o.first >= 0 && o.first < n) order.push(o.first);
  // Nearest neighbour from the start (or the pinned stop, or the stop farthest from the end when open-ended).
  const left = new Set(free);
  let at: number | null = order.length ? order[0] : o.hasStart ? START : null;
  if (at === null && left.size) {
    let best = free[0];
    if (o.hasEnd) { let far = -1; for (const i of left) { const c = cost(i, END); if (c > far) { far = c; best = i; } } }
    order.push(best); left.delete(best); at = best;
  }
  while (left.size) {
    let best = -1, bestCost = Infinity;
    for (const i of left) { const c = cost(at as number, i); if (c < bestCost) { bestCost = c; best = i; } }
    order.push(best); left.delete(best); at = best;
  }
  const fixed = o.first != null && order[0] === o.first ? 1 : 0;
  const total = (seq: number[]) => {
    if (!seq.length) return 0;
    let t = o.hasStart ? cost(START, seq[0]) : 0;
    for (let i = 1; i < seq.length; i++) t += cost(seq[i - 1], seq[i]);
    if (o.hasEnd) t += cost(seq[seq.length - 1], END);
    return t;
  };
  let best = order.slice();
  let bestTotal = total(best);
  // Improve until nothing helps (capped so a big route still answers quickly).
  for (let pass = 0; pass < 30; pass++) {
    let improved = false;
    for (let i = fixed; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const next = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const t = total(next);
        if (t < bestTotal - 0.5) { best = next; bestTotal = t; improved = true; }
      }
    }
    for (let i = fixed; i < best.length; i++) {
      for (let j = fixed; j < best.length; j++) {
        if (i === j) continue;
        const next = best.slice();
        const [moved] = next.splice(i, 1);
        next.splice(j, 0, moved);
        const t = total(next);
        if (t < bestTotal - 0.5) { best = next; bestTotal = t; improved = true; }
      }
    }
    if (!improved) break;
  }
  return [...best, ...tail];
}

/**
 * The same, with locked stops: each stop in `locked` keeps the place it has (its number is its place),
 * and the others are ordered through the places left. Stops in `last` (no location) take the last
 * free places and are skipped when the drive is added up.
 */
function optimizeAround(n: number, cost: (from: number, to: number) => number, o: { hasStart?: boolean; hasEnd?: boolean; last?: number[] }, locked: Set<number>): number[] {
  const nowhere = new Set((o.last ?? []).filter((i) => i >= 0 && i < n));
  const tail = [...nowhere].filter((i) => !locked.has(i));
  const places: number[] = [];
  for (let i = 0; i < n; i++) if (!locked.has(i)) places.push(i);
  const open = places.slice(0, places.length - tail.length);
  const tailPlaces = places.slice(places.length - tail.length);
  /** The whole order, given the free stops in the order they fill the open places. */
  const build = (seq: number[]) => {
    const out: number[] = Array.from({ length: n }, (_, i) => i);
    open.forEach((place, k) => { out[place] = seq[k]; });
    tailPlaces.forEach((place, k) => { out[place] = tail[k]; });
    return out;
  };
  const total = (seq: number[]) => {
    const path = build(seq).filter((i) => !nowhere.has(i));
    if (!path.length) return 0;
    let t = o.hasStart ? cost(START, path[0]) : 0;
    for (let i = 1; i < path.length; i++) t += cost(path[i - 1], path[i]);
    if (o.hasEnd) t += cost(path[path.length - 1], END);
    return t;
  };
  // Nearest neighbour through the places, from whatever comes before each one.
  const left = new Set<number>();
  for (let i = 0; i < n; i++) if (!locked.has(i) && !nowhere.has(i)) left.add(i);
  const seq: number[] = [];
  let at: number | null = o.hasStart ? START : null;
  let k = 0;
  for (let place = 0; place < n && left.size; place++) {
    if (place !== open[k]) { if (locked.has(place) && !nowhere.has(place)) at = place; continue; }
    let pick = -1, pickCost = Infinity;
    for (const i of left) { const c = at === null ? 0 : cost(at, i); if (c < pickCost) { pickCost = c; pick = i; } }
    seq.push(pick); left.delete(pick); at = pick; k++;
  }
  let best = seq;
  let bestTotal = total(best);
  for (let pass = 0; pass < 30; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const next = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const t = total(next);
        if (t < bestTotal - 0.5) { best = next; bestTotal = t; improved = true; }
      }
    }
    for (let i = 0; i < best.length; i++) {
      for (let j = 0; j < best.length; j++) {
        if (i === j) continue;
        const next = best.slice();
        const [moved] = next.splice(i, 1);
        next.splice(j, 0, moved);
        const t = total(next);
        if (t < bestTotal - 0.5) { best = next; bestTotal = t; improved = true; }
      }
    }
    if (!improved) break;
  }
  return build(best);
}

/* ───────────── A route's day ───────────── */

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export type RouteTimeline = {
  /** Minutes from midnight (can pass 1440: the next day). */
  arrive: number[]; depart: number[]; endAt: number;
  driveSeconds: number; driveMeters: number; onSiteMinutes: number; totalMinutes: number;
};
/** When each stop is reached: the start time, plus each drive, plus each stop's own time. */
export function routeTimeline(o: { startTime: string; minutes: (number | null)[]; legs: (Leg | null)[]; endLeg: Leg | null }): RouteTimeline {
  let clock = toMinutes(o.startTime);
  let driveSeconds = 0, driveMeters = 0, onSite = 0;
  const arrive: number[] = [], depart: number[] = [];
  o.minutes.forEach((min, i) => {
    const leg = o.legs[i];
    if (leg) { clock += leg.seconds / 60; driveSeconds += leg.seconds; driveMeters += leg.meters; }
    arrive.push(clock);
    clock += min ?? 0;
    onSite += min ?? 0;
    depart.push(clock);
  });
  if (o.endLeg) { clock += o.endLeg.seconds / 60; driveSeconds += o.endLeg.seconds; driveMeters += o.endLeg.meters; }
  return { arrive, depart, endAt: clock, driveSeconds, driveMeters, onSiteMinutes: onSite, totalMinutes: clock - toMinutes(o.startTime) };
}

/** How arrival times are shown: to the minute, in a window, or just morning / afternoon. */
export const ETA_WINDOWS = [0, 15, 30, 60, 120, 240, -1] as const;
export type EtaWindow = (typeof ETA_WINDOWS)[number];
export const ETA_WINDOW_LABELS: Record<number, string> = { 0: "Minute", 15: "15 min", 30: "30 min", 60: "1 hr", 120: "2 hr", 240: "4 hr", [-1]: "AM/PM" };

export function clock12(minutes: number, withPeriod = true): string {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, "0")}${withPeriod ? ` ${h < 12 ? "am" : "pm"}` : ""}`;
}
/** "8:07 am", "8:00 – 8:15 am", "AM"; a time past midnight adds "+1d". */
export function etaText(minutes: number, window: EtaWindow = 0): string {
  const next = minutes >= 1440 ? " +1d" : "";
  if (window === -1) return `${Math.floor(minutes) % 1440 < 720 ? "AM" : "PM"}${next}`;
  if (!window) return clock12(minutes) + next;
  const from = Math.floor(minutes / window) * window;
  const samePeriod = (Math.floor(from / 720) % 2) === (Math.floor((from + window) / 720) % 2);
  return `${clock12(from, !samePeriod)} – ${clock12(from + window)}${next}`;
}

/* ───────────── Capacity ───────────── */

/** "7 / 14" with "Available 7", or Over when booked passes capacity (a capacity of 0 is a real limit). */
export function capacityText(bookedHours: number, capacityHours: number | null) {
  const r = (n: number) => (Math.round(n * 10) / 10).toString();
  if (capacityHours == null) return { label: `${r(bookedHours)}BH`, rest: "", over: false, share: 0 };
  const left = capacityHours - bookedHours;
  return {
    label: `${r(bookedHours)} / ${r(capacityHours)}`,
    rest: left >= 0 ? `Available ${r(left)}` : `Over ${r(-left)}`,
    over: left < 0,
    share: capacityHours > 0 ? Math.min(1, bookedHours / capacityHours) : bookedHours > 0 ? 1 : 0,
  };
}

/** Colors for people who have none of their own (crews carry theirs). */
export const DISPATCH_PALETTE = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#65a30d", "#0d9488", "#7c3aed", "#b45309"];
export function personColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DISPATCH_PALETTE[h % DISPATCH_PALETTE.length];
}
/** One color per weekday (Sunday first), for coloring a week. */
export const WEEKDAY_COLORS = ["#64748b", "#2563eb", "#16a34a", "#ca8a04", "#9333ea", "#ea580c", "#0891b2"];
/** Work orders blue, to-dos purple. */
export const EVENT_TYPE_COLORS: Record<EventKind, string> = { visit: "#2563eb", todo: "#9333ea" };
export const EVENT_TYPE_LABELS: Record<EventKind, string> = { visit: "Work order", todo: "To-do" };

/* ───────────── What the server accepts ───────────── */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-04-15");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:00");
const uuid = z.string().uuid();
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const key = z.string().regex(/^[vt]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Not an event");
const keys = z.array(key).min(1, "Select at least one").max(500);

/** A crew (its members come along), or people (which clears the crew), or neither (unassigned). */
export const dispatchAssignSchema = z.object({
  keys,
  crewId: z.preprocess(blankToNull, uuid.nullable()).optional(),
  employeeIds: z.array(uuid).max(30).default([]),
}).refine((v) => !(v.crewId && v.employeeIds.length), { message: "Pick one crew or a set of employees, not both", path: ["employeeIds"] });
export type DispatchAssignInput = z.infer<typeof dispatchAssignSchema>;

export const dispatchRescheduleSchema = z.object({ keys, date: isoDate });
export const dispatchKeysSchema = z.object({ keys });
/** To the waiting list: the scheduled day becomes the earliest date; the latest is kept, set or left empty. */
export const dispatchToWaitlistSchema = z.object({ keys, dueBy: z.union([z.literal("keep"), isoDate, z.null()]).default("keep") });

/** Where a route starts or ends. */
export const ROUTE_POINT_KINDS = ["company", "crew", "employee", "custom", "none"] as const;
export type RoutePointKind = (typeof ROUTE_POINT_KINDS)[number];
export const routePointSchema = z.object({
  kind: z.enum(ROUTE_POINT_KINDS).default("company"),
  label: z.preprocess(blankToNull, z.string().trim().max(200).nullable()).optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});
export type RoutePointInput = z.infer<typeof routePointSchema>;

const routeKeys = z.array(key).min(1, "Add at least one stop").max(DISPATCH_ROUTE_MAX, `A route is limited to ${DISPATCH_ROUTE_MAX} stops. Split it into smaller routes.`);
export const routePreviewSchema = z.object({
  date: isoDate,
  keys: routeKeys,
  start: routePointSchema.default({ kind: "company" }),
  end: routePointSchema.default({ kind: "company" }),
  /** Let Crewdesk order the stops (a pinned first stop stays first; stops with no location go last). */
  optimize: z.boolean().default(false),
  pinnedFirst: z.boolean().default(false),
  /** Stops that keep the place they have in `keys` while the rest are ordered around them. */
  locked: z.array(key).max(DISPATCH_ROUTE_MAX).default([]),
  /** Turn-by-turn steps too (for printed directions). */
  steps: z.boolean().default(false),
});
export const routeSaveSchema = z.object({
  /** The saved route being changed; without it a new route is made. */
  id: uuid.optional(),
  date: isoDate,
  keys: routeKeys,
  start: routePointSchema.default({ kind: "company" }),
  end: routePointSchema.default({ kind: "company" }),
  startTime: hhmm.default("08:00"),
  pinnedFirst: z.boolean().default(false),
  /** "Assign all": give every stop this crew or these people as it saves. */
  assign: z.object({ crewId: z.preprocess(blankToNull, uuid.nullable()).optional(), employeeIds: z.array(uuid).max(30).default([]) }).optional(),
  /** Copy the order to the same weekday in future weeks, for the stops that repeat. */
  future: z.object({
    everyWeeks: z.coerce.number().int("Enter a whole number of weeks between 1 and 52").min(1, "Enter a whole number of weeks between 1 and 52").max(52, "Enter a whole number of weeks between 1 and 52"),
    /** "none": order only. "keep": give this route's crew only to visits with nobody. "replace": to every one. */
    assignments: z.enum(["none", "keep", "replace"]).default("none"),
  }).optional(),
});
export type RouteSaveInput = z.infer<typeof routeSaveSchema>;

/** The plan's board: a lane (a crew's day, or No crew yet) in the order given. */
export const laneOrderSchema = z.object({ date: isoDate, crewId: z.preprocess(blankToNull, uuid.nullable()), keys: z.array(key).max(200) });

/** Rain or wind day: a crew's or the whole day's open services go back to the waiting list or to the next working day. */
export const rainDaySchema = z.object({
  date: isoDate,
  /** A crew, "none" (no crew yet) or "all". */
  crewId: z.union([uuid, z.literal("all"), z.literal("none")]).default("all"),
  to: z.enum(["waitlist", "next"]),
  reason: z.enum(BACK_REASONS).default("rain"),
  note: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  /** Text the customers who asked for a text ahead (when texting is connected). */
  notify: z.boolean().default(false),
});

/** Lock a routed stop in place, or free it. */
export const dispatchLockSchema = z.object({ key, locked: z.boolean() });

export const dispatchNoteSchema = z.object({ key, body: z.string().trim().min(1, "Write the note").max(2000) });

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Pick a color");
export const MAP_AREAS_MAX = 100;
/** A shape drawn on the map (a territory or neighbourhood), shared by everyone. */
export const mapAreaSchema = z.object({
  name: z.string().trim().min(1, "Name the area").max(60),
  color: hex.default("#2563eb"),
  points: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])).min(3, "An area needs at least 3 corners").max(500),
});

export const DISPATCH_ROUTING = ["estimate", "road"] as const;
export type DispatchRouting = (typeof DISPATCH_ROUTING)[number];
export const DEFAULT_ROAD_URL = "https://router.project-osrm.org";
export const dispatchSettingsSchema = z.object({
  /** "estimate": straight-line estimates. "road": ask a routing server for real roads. */
  routing: z.enum(DISPATCH_ROUTING).default("estimate"),
  /** An OSRM-compatible routing server. */
  roadUrl: z.preprocess(blankToNull, z.string().trim().url("Enter the server's address, starting with https://").max(300).nullable()).optional(),
  /** Where routes start and end when it isn't the business address. */
  startAddress: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  endAddress: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
});
export type DispatchSettingsInput = z.infer<typeof dispatchSettingsSchema>;
export type DispatchSettings = {
  routing: DispatchRouting; roadUrl: string | null;
  start: { address: string; lat: number; lng: number } | null;
  end: { address: string; lat: number; lng: number } | null;
  /** The business address, located once and remembered. */
  depot: { address: string; lat: number; lng: number } | null;
};

export const capacitySchema = z.object({
  employees: z.array(z.object({
    id: uuid,
    dailyHours: z.coerce.number().min(0).max(24),
    /** Empty: no weekly cap. 0 means no capacity that week. */
    weeklyHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(168).nullable()).optional(),
    excluded: z.boolean().default(false),
  })).max(500),
});

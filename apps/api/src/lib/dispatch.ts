import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  BACK_REASON_LABELS, DISPATCH_ROUTE_MAX, END, START, customerName, eventKey, formatAddress, holidaysBetween, laneKeyOf, optimizeOrder, parseEventKey, personColor,
  type DispatchSettings, type DispatchSettingsInput, type EventKind, type Leg, type Pt, type RoutePointInput, type RouteSaveInput,
} from "@crewdesk/shared";
import { db } from "../db";
import {
  companies, crewMembers, crews, customers, dispatchRoutes, dispatchStops, employees, holidays, invoices, properties, todoAssignees, todoFiles, todoNotes, todos,
  visitAssignees, visitDispatchNotes, visitFiles, visitLines, visits,
} from "../db/schema";
import type { Tx } from "./crm";
import { HttpError } from "./errors";
import { geocode } from "./geocode";
import { driveMatrix, measureLegs, type Step } from "./routing";
import { sendCustomerText, textingConfig } from "./texting";
import { estimateMinutes } from "./waitlist";

/**
 * Dispatch, for both boards: the day's (or week's) work orders and to-dos as "events", the routes
 * they're on, and everything that moves them: who does them, which day, what order.
 *
 * The rules that keep routes honest (as in Homeworks' beta board): a route belongs to one lane, so
 * a stop whose crew or people change, or whose day changes, comes off its route; the stops left
 * behind close the gap; a route left with no stops is removed.
 */

type Visit = typeof visits.$inferSelect;
type Todo = typeof todos.$inferSelect;
type Route = typeof dispatchRoutes.$inferSelect;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

/* ───────────── Settings: how to measure, and where routes start ───────────── */

type Locator = (address: string) => Promise<{ lat: number; lng: number } | null>;
let locator: Locator = async (address) => geocode(address).catch(() => null);
/** Tests swap in their own address lookup. */
export function setDispatchLocator(fn: Locator) { locator = fn; }
export const locateAddress = (address: string) => locator(address);

/** The company's dispatch settings. The business address is located once and remembered. */
export async function dispatchSettings(companyId: string): Promise<DispatchSettings> {
  const [co] = await db.select({ s: companies.dispatchSettings, line1: companies.addressLine1, city: companies.city, state: companies.state, zip: companies.zip }).from(companies).where(eq(companies.id, companyId));
  const s = (co?.s ?? {}) as Partial<DispatchSettings> & { depotTried?: string };
  const address = [co?.line1, co?.city, [co?.state, co?.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  let depot = s.depot && s.depot.address === address ? s.depot : null;
  if (address && co?.line1 && !depot && s.depotTried !== address) {
    const at = await locator(address);
    depot = at ? { address, lat: at.lat, lng: at.lng } : null;
    await db.update(companies).set({ dispatchSettings: { ...s, depot, depotTried: address } as Partial<DispatchSettings> }).where(eq(companies.id, companyId));
  }
  return { routing: s.routing === "road" ? "road" : "estimate", roadUrl: s.roadUrl ?? null, start: s.start ?? null, end: s.end ?? null, depot };
}

export async function saveDispatchSettings(companyId: string, b: DispatchSettingsInput) {
  const [co] = await db.select({ s: companies.dispatchSettings }).from(companies).where(eq(companies.id, companyId));
  const s = (co?.s ?? {}) as Partial<DispatchSettings>;
  const place = async (address: string | null | undefined, current: DispatchSettings["start"], what: string) => {
    if (address === undefined) return current ?? null;
    if (!address) return null;
    if (current?.address === address) return current;
    const at = await locator(address);
    if (!at) throw new HttpError(400, `Couldn't find the ${what} address on the map. Check it, or leave it empty to use the business address.`);
    return { address, lat: at.lat, lng: at.lng };
  };
  const next = { ...s, routing: b.routing, roadUrl: b.roadUrl ?? null, start: await place(b.startAddress, s.start ?? null, "start"), end: await place(b.endAddress, s.end ?? null, "end") };
  await db.update(companies).set({ dispatchSettings: next }).where(eq(companies.id, companyId));
  return dispatchSettings(companyId);
}

/* ───────────── Events ───────────── */

export type DispatchEvent = {
  key: string; kind: EventKind; id: string; number: number | null; title: string;
  status: "open" | "on_site" | "completed" | "skipped";
  date: string; endDate: string | null; startTime: string | null; endTime: string | null; color: string;
  crewId: string | null; assigneeIds: string[];
  customer: { id: string; name: string; phone: string | null } | null;
  propertyId: string | null;
  location: { address: string; lat: number | null; lng: number | null; mapCode: string | null } | null;
  sqFt: number | null; lastServiceOn: string | null; pets: string | null; notifyBefore: string;
  budgetedHours: number | null; estMinutes: number | null; estSource: string;
  /** Null for people who can't see prices. */
  totalCents: number | null;
  invoiceable: boolean; invoice: { id: string; number: number | null; status: string } | null;
  trackedSeconds: number; runningSince: string | null; onSite: boolean;
  finishedAt: string | null; skipReason: string | null;
  /** "Every 6 weeks…" for a repeating one; null for a single visit. */
  frequency: string | null; seriesId: string | null;
  services: { id: string | null; name: string; quantity: number }[];
  notes: string | null; propertyNotes: string | null;
  dispatchNotes: { id: string; body: string; by: string | null; at: string }[];
  fileCount: number; tagIds: string[]; priority: string; windowStart: string | null; windowEnd: string | null;
  custom: Record<string, unknown>;
  route: { id: string; order: number; locked: boolean } | null;
};

const within = (from: string, to: string, date: typeof visits.date | typeof todos.date, endDate: typeof visits.endDate | typeof todos.endDate) =>
  and(isNotNull(date), lte(date, to), gte(sql`coalesce(${endDate}, ${date})`, from));

/** Which route each event is on and where in it: stops are numbered 1…n in their saved order. */
/** Where an event sits on a route: which one, its stop number, and whether it's locked in place. */
type RouteSpot = { id: string; order: number; locked: boolean };
async function routeLookup(companyId: string, o: { visitIds?: string[]; todoIds?: string[]; from?: string; to?: string }) {
  const where = [eq(dispatchRoutes.companyId, companyId)];
  if (o.from && o.to) where.push(gte(dispatchRoutes.date, o.from), lte(dispatchRoutes.date, o.to));
  else {
    const ors = [];
    if (o.visitIds?.length) ors.push(inArray(dispatchStops.visitId, o.visitIds));
    if (o.todoIds?.length) ors.push(inArray(dispatchStops.todoId, o.todoIds));
    if (!ors.length) return { routes: [] as (Route & { stops: { key: string; order: number; leg: Leg | null; locked: boolean }[] })[], byKey: new Map<string, RouteSpot>() };
    where.push(inArray(dispatchRoutes.id, db.select({ id: dispatchStops.routeId }).from(dispatchStops).where(or(...ors))));
  }
  const routes = await db.select().from(dispatchRoutes).where(and(...where)).orderBy(asc(dispatchRoutes.date), asc(dispatchRoutes.createdAt));
  const ids = routes.map((r) => r.id);
  const stops = ids.length ? await db.select().from(dispatchStops).where(inArray(dispatchStops.routeId, ids)).orderBy(asc(dispatchStops.stopOrder)) : [];
  const byKey = new Map<string, RouteSpot>();
  const out = routes.map((r) => {
    const mine = stops.filter((s) => s.routeId === r.id).map((s, i) => {
      const key = s.visitId ? eventKey("visit", s.visitId) : eventKey("todo", s.todoId!);
      byKey.set(key, { id: r.id, order: i + 1, locked: s.locked });
      return { key, order: i + 1, leg: s.driveSeconds != null && s.driveMeters != null ? { meters: s.driveMeters, seconds: s.driveSeconds } : null, locked: s.locked };
    });
    return { ...r, stops: mine };
  });
  return { routes: out, byKey };
}

/** The saved routes for the days given, each with its numbered stops. */
export async function routesBetween(companyId: string, from: string, to: string) {
  const { routes } = await routeLookup(companyId, { from, to });
  return routes.map((r) => ({
    id: r.id, date: r.date, crewId: r.crewId, startTime: r.startTime, pinnedFirst: r.pinnedFirst,
    start: { kind: r.startKind, label: r.startLabel, lat: r.startLat, lng: r.startLng },
    end: { kind: r.endKind, label: r.endLabel, lat: r.endLat, lng: r.endLng },
    totalMeters: r.totalMeters ?? 0, totalDriveSeconds: r.totalDriveSeconds ?? 0,
    endLeg: r.endSeconds != null && r.endMeters != null ? { meters: r.endMeters, seconds: r.endSeconds } : null,
    measured: r.measured ?? "estimate", geometry: r.geometry ?? null, stops: r.stops,
  }));
}

/** Work orders and to-dos, by row, as events. */
async function asEvents(o: { visitRows: Visit[]; todoRows: Todo[]; showPrices: boolean; routeOf: Map<string, RouteSpot> }): Promise<DispatchEvent[]> {
  const { visitRows, todoRows } = o;
  const visitIds = visitRows.map((v) => v.id);
  const todoIds = todoRows.map((t) => t.id);
  const out: DispatchEvent[] = [];
  const propIds = [...new Set([...visitRows.map((v) => v.propertyId), ...todoRows.map((t) => t.propertyId)].filter((x): x is string => !!x))];
  const custIds = [...new Set([...visitRows.map((v) => v.customerId), ...todoRows.map((t) => t.customerId)].filter((x): x is string => !!x))];
  const props = new Map((propIds.length ? await db.select().from(properties).where(inArray(properties.id, propIds)) : []).map((p) => [p.id, p]));
  const custs = new Map((custIds.length ? await db.select({ id: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, phone: customers.phone, notifyBefore: customers.notifyBefore }).from(customers).where(inArray(customers.id, custIds)) : []).map((c) => [c.id, c]));

  if (visitRows.length) {
    const lines = await db.select().from(visitLines).where(inArray(visitLines.visitId, visitIds)).orderBy(asc(visitLines.sortOrder));
    const people = await db.select().from(visitAssignees).where(inArray(visitAssignees.visitId, visitIds));
    const invIds = [...new Set(visitRows.map((v) => v.invoiceId).filter((x): x is string => !!x))];
    const invs = new Map((invIds.length ? await db.select({ id: invoices.id, number: invoices.number, status: invoices.status }).from(invoices).where(inArray(invoices.id, invIds)) : []).map((i) => [i.id, i]));
    const est = await estimateMinutes(visitRows.map((v) => ({ id: v.id, propertyId: v.propertyId, budgetedHours: v.budgetedHours })));
    const last = new Map((propIds.length ? await db.select({ propertyId: visits.propertyId, on: sql<string>`max(coalesce(${visits.date}, (${visits.completedAt} at time zone 'UTC')::date))::text` })
      .from(visits).where(and(inArray(visits.propertyId, propIds), eq(visits.status, "completed"))).groupBy(visits.propertyId) : []).map((r) => [r.propertyId, r.on]));
    const notes = await db.select({ n: visitDispatchNotes, firstName: employees.firstName, lastName: employees.lastName }).from(visitDispatchNotes).leftJoin(employees, eq(employees.id, visitDispatchNotes.authorId))
      .where(inArray(visitDispatchNotes.visitId, visitIds)).orderBy(asc(visitDispatchNotes.createdAt));
    const files = new Map((await db.select({ id: visitFiles.visitId, n: sql<number>`count(*)::int` }).from(visitFiles).where(inArray(visitFiles.visitId, visitIds)).groupBy(visitFiles.visitId)).map((r) => [r.id, r.n]));
    for (const v of visitRows) {
      const p = v.propertyId ? props.get(v.propertyId) : undefined;
      const c = custs.get(v.customerId);
      const inv = v.invoiceId ? invs.get(v.invoiceId) : undefined;
      const e = est.get(v.id);
      const key = eventKey("visit", v.id);
      const tracked = v.startedAt && v.completedAt ? Math.max(0, Math.round((v.completedAt.getTime() - v.startedAt.getTime()) / 1000)) : 0;
      out.push({
        key, kind: "visit", id: v.id, number: v.number, title: v.title, status: v.status as DispatchEvent["status"],
        date: v.date!, endDate: v.endDate, startTime: v.startTime, endTime: v.endTime, color: v.color,
        crewId: v.crewId, assigneeIds: people.filter((x) => x.visitId === v.id).map((x) => x.employeeId),
        customer: c ? { id: c.id, name: customerName(c), phone: c.phone } : null,
        propertyId: v.propertyId,
        location: p ? { address: formatAddress(p), lat: p.lat, lng: p.lng, mapCode: p.mapCode } : v.location ? { address: v.location, lat: null, lng: null, mapCode: null } : null,
        sqFt: p?.lawnSqFt ?? null, lastServiceOn: (p && last.get(p.id)) || null, pets: p?.pets ?? null, notifyBefore: (p?.notifyBefore ?? c?.notifyBefore) || "none",
        budgetedHours: v.budgetedHours, estMinutes: e?.minutes ?? null, estSource: e?.source ?? "none",
        totalCents: o.showPrices ? v.totalCents : null,
        invoiceable: v.billing === "invoice", invoice: inv && inv.status !== "void" ? inv : null,
        trackedSeconds: tracked, runningSince: v.status === "on_site" && v.startedAt ? v.startedAt.toISOString() : null, onSite: v.status === "on_site",
        finishedAt: (v.completedAt ?? v.skippedAt)?.toISOString() ?? null, skipReason: v.skipReason,
        frequency: v.seriesId ? v.repeatLabel ?? "Repeats" : null, seriesId: v.seriesId,
        services: lines.filter((l) => l.visitId === v.id).map((l) => ({ id: l.serviceTypeId, name: l.description, quantity: l.quantity })),
        notes: v.notes, propertyNotes: [p?.gateCode ? `Gate code: ${p.gateCode}` : null, p?.accessNotes, p?.notes].filter(Boolean).join("\n") || null,
        dispatchNotes: notes.filter((n) => n.n.visitId === v.id).map((n) => ({ id: n.n.id, body: n.n.body, by: n.firstName ? `${n.firstName} ${n.lastName}` : null, at: n.n.createdAt.toISOString() })),
        fileCount: files.get(v.id) ?? 0, tagIds: v.tagIds ?? [], priority: v.priority, windowStart: v.windowStart, windowEnd: v.windowEnd,
        custom: (v.custom ?? {}) as Record<string, unknown>,
        route: o.routeOf.get(key) ?? null,
      });
    }
  }

  if (todoRows.length) {
    const people = await db.select().from(todoAssignees).where(inArray(todoAssignees.todoId, todoIds));
    const notes = await db.select({ n: todoNotes, firstName: employees.firstName, lastName: employees.lastName }).from(todoNotes).leftJoin(employees, eq(employees.id, todoNotes.authorId))
      .where(inArray(todoNotes.todoId, todoIds)).orderBy(asc(todoNotes.createdAt));
    const files = new Map((await db.select({ id: todoFiles.todoId, n: sql<number>`count(*)::int` }).from(todoFiles).where(inArray(todoFiles.todoId, todoIds)).groupBy(todoFiles.todoId)).map((r) => [r.id, r.n]));
    const now = Date.now();
    for (const t of todoRows) {
      const p = t.propertyId ? props.get(t.propertyId) : undefined;
      const c = t.customerId ? custs.get(t.customerId) : undefined;
      const key = eventKey("todo", t.id);
      out.push({
        key, kind: "todo", id: t.id, number: null, title: t.title, status: t.doneAt ? "completed" : t.startedAt ? "on_site" : "open",
        date: t.date, endDate: t.endDate, startTime: t.startTime, endTime: t.endTime, color: t.color,
        crewId: t.crewId, assigneeIds: people.filter((x) => x.todoId === t.id).map((x) => x.employeeId),
        customer: c ? { id: c.id, name: customerName(c), phone: c.phone } : null,
        propertyId: t.propertyId,
        location: p ? { address: formatAddress(p), lat: p.lat, lng: p.lng, mapCode: p.mapCode } : t.location ? { address: t.location, lat: null, lng: null, mapCode: null } : null,
        sqFt: p?.lawnSqFt ?? null, lastServiceOn: null, pets: p?.pets ?? null, notifyBefore: "none",
        budgetedHours: t.budgetedHours, estMinutes: t.budgetedHours != null ? Math.round(t.budgetedHours * 60) : null, estSource: t.budgetedHours != null ? "set" : "none",
        totalCents: o.showPrices ? 0 : null, invoiceable: false, invoice: null,
        trackedSeconds: t.trackedSeconds + (t.startedAt ? Math.max(0, Math.round((now - t.startedAt.getTime()) / 1000)) : 0),
        runningSince: t.startedAt?.toISOString() ?? null, onSite: !!t.startedAt && !t.doneAt,
        finishedAt: t.doneAt?.toISOString() ?? null, skipReason: null,
        frequency: t.seriesId ? "Repeats" : null, seriesId: t.seriesId,
        services: [], notes: t.notes, propertyNotes: [p?.gateCode ? `Gate code: ${p.gateCode}` : null, p?.accessNotes, p?.notes].filter(Boolean).join("\n") || null,
        dispatchNotes: notes.filter((n) => n.n.todoId === t.id).map((n) => ({ id: n.n.id, body: n.n.body, by: n.firstName ? `${n.firstName} ${n.lastName}` : null, at: n.n.createdAt.toISOString() })),
        fileCount: files.get(t.id) ?? 0, tagIds: [], priority: "normal", windowStart: null, windowEnd: null,
        custom: (t.custom ?? {}) as Record<string, unknown>,
        route: o.routeOf.get(key) ?? null,
      });
    }
  }
  return out;
}

/** Every work order and to-do on the days given. */
export async function eventsBetween(companyId: string, from: string, to: string, showPrices: boolean) {
  const visitRows = await db.select().from(visits).where(and(eq(visits.companyId, companyId), within(from, to, visits.date, visits.endDate))).orderBy(asc(visits.date), sql`${visits.startTime} nulls last`, asc(visits.number)).limit(5000);
  const todoRows = await db.select().from(todos).where(and(eq(todos.companyId, companyId), within(from, to, todos.date, todos.endDate))).orderBy(asc(todos.date), sql`${todos.startTime} nulls last`, asc(todos.createdAt)).limit(5000);
  const { byKey } = await routeLookup(companyId, { visitIds: visitRows.map((v) => v.id), todoIds: todoRows.map((t) => t.id) });
  return asEvents({ visitRows, todoRows, showPrices, routeOf: byKey });
}

/** The rows behind a set of event keys, all in this company (or it's an error). */
async function rowsFor(companyId: string, keys: string[]) {
  const parsed = [...new Set(keys)].map(parseEventKey);
  const visitIds = parsed.filter((k) => k.kind === "visit").map((k) => k.id);
  const todoIds = parsed.filter((k) => k.kind === "todo").map((k) => k.id);
  const visitRows = visitIds.length ? await db.select().from(visits).where(and(eq(visits.companyId, companyId), inArray(visits.id, visitIds))) : [];
  const todoRows = todoIds.length ? await db.select().from(todos).where(and(eq(todos.companyId, companyId), inArray(todos.id, todoIds))) : [];
  if (visitRows.length !== visitIds.length || todoRows.length !== todoIds.length) throw new HttpError(404, "Some of those weren't found. They may have been deleted; reload the board.");
  return { visitIds, todoIds, visitRows, todoRows };
}

export async function eventsFor(companyId: string, keys: string[], showPrices = true) {
  const r = await rowsFor(companyId, keys);
  const { byKey } = await routeLookup(companyId, { visitIds: r.visitIds, todoIds: r.todoIds });
  const events = await asEvents({ visitRows: r.visitRows, todoRows: r.todoRows, showPrices, routeOf: byKey });
  const by = new Map(events.map((e) => [e.key, e]));
  return keys.map((k) => by.get(k)!).filter(Boolean);
}

/* ───────────── Measuring a route ───────────── */

type Point = { kind: string; label: string | null; lat: number; lng: number };

/** Where a route starts or ends: the company's place (or the business address), someone's home, a picked spot, or nowhere (open-ended). */
async function resolvePoint(settings: DispatchSettings, p: RoutePointInput, which: "start" | "end"): Promise<Point | null> {
  if (p.kind === "none") return null;
  if (p.kind === "company") {
    const at = (which === "start" ? settings.start : settings.end) ?? settings.depot;
    return at ? { kind: "company", label: at.address, lat: at.lat, lng: at.lng } : null;
  }
  if (p.lat == null || p.lng == null) {
    if (p.kind === "custom" && p.label) {
      const at = await locator(p.label);
      if (!at) throw new HttpError(400, "Couldn't find that address.");
      return { kind: "custom", label: p.label, lat: at.lat, lng: at.lng };
    }
    throw new HttpError(400, p.kind === "crew" ? "This crew has no address set for where its routes begin and end." : p.kind === "employee" ? "No address on file for this employee." : `Pick the ${which} location.`);
  }
  return { kind: p.kind, label: p.label ?? null, lat: p.lat, lng: p.lng };
}

/** The drive into each stop, back to the end, and the totals. Stops with no location add no drive. */
async function measure(settings: Pick<DispatchSettings, "routing" | "roadUrl">, start: Pt | null, stops: (Pt | null)[], end: Pt | null, o: { steps?: boolean } = {}) {
  const located = stops.map((p, i) => ({ p, i })).filter((x): x is { p: Pt; i: number } => !!x.p);
  const chain: Pt[] = [...(start ? [start] : []), ...located.map((x) => x.p), ...(end && located.length ? [end] : [])];
  const m = await measureLegs(settings, chain, o);
  const legs: (Leg | null)[] = stops.map(() => null);
  const steps: (Step[] | null)[] = stops.map(() => null);
  located.forEach((x, n) => {
    const at = n + (start ? 1 : 0);
    if (at > 0) { legs[x.i] = m.legs[at - 1] ?? null; steps[x.i] = m.steps?.[at - 1] ?? null; }
  });
  const endLeg = end && located.length ? m.legs[m.legs.length - 1] ?? null : null;
  const all = [...legs.filter((l): l is Leg => !!l), ...(endLeg ? [endLeg] : [])];
  return {
    legs, endLeg, steps, endSteps: end && located.length ? m.steps?.[m.legs.length - 1] ?? null : null,
    totalMeters: all.reduce((s, l) => s + l.meters, 0), totalDriveSeconds: all.reduce((s, l) => s + l.seconds, 0),
    geometry: m.geometry, measured: m.measured,
  };
}

const onDay = (e: { date: string; endDate: string | null }, date: string) => e.date <= date && (e.endDate ?? e.date) >= date;

/** A route before it's saved: the order (optimized when asked), each drive, the totals and the line to draw. */
export async function previewRoute(companyId: string, b: { date: string; keys: string[]; start: RoutePointInput; end: RoutePointInput; optimize?: boolean; pinnedFirst?: boolean; locked?: string[]; steps?: boolean }, o: { estimateOnly?: boolean } = {}) {
  const settings = await dispatchSettings(companyId);
  const how = o.estimateOnly ? { routing: "estimate" as const, roadUrl: null } : settings;
  const events = await eventsFor(companyId, b.keys);
  const missing = events.find((e) => !onDay(e, b.date));
  if (missing) throw new HttpError(409, `“${missing.title}” isn't scheduled on ${longDay(b.date)} any more. Take it off the route, then save again.`);
  const start = await resolvePoint(settings, b.start, "start");
  const end = await resolvePoint(settings, b.end, "end");
  const at = (e: (typeof events)[number]): Pt | null => (e.location?.lat != null && e.location.lng != null ? { lat: e.location.lat, lng: e.location.lng } : null);
  let order = events;
  if (b.optimize && events.length > 1) {
    const pts = events.map(at);
    const located = pts.map((p, i) => ({ p, i })).filter((x): x is { p: Pt; i: number } => !!x.p);
    const all: Pt[] = [...(start ? [start] : []), ...located.map((x) => x.p), ...(end ? [end] : [])];
    const matrix = await driveMatrix(how, all);
    const col = new Map(located.map((x, n) => [x.i, n + (start ? 1 : 0)]));
    const idx = (i: number) => (i === START ? 0 : i === END ? all.length - 1 : col.get(i)!);
    const held = new Set(b.locked ?? []);
    const seq = optimizeOrder(events.length, (a, c) => matrix[idx(a)][idx(c)], {
      hasStart: !!start, hasEnd: !!end,
      first: b.pinnedFirst && pts[0] ? 0 : null,
      last: pts.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0),
      // Locked stops keep the place they have in the list; the rest are ordered around them.
      fixed: events.map((e, i) => (held.has(e.key) ? i : -1)).filter((i) => i >= 0),
    });
    order = seq.map((i) => events[i]);
  }
  const m = await measure(how, start, order.map(at), end, { steps: b.steps });
  return {
    date: b.date, keys: order.map((e) => e.key), start, end,
    stops: order.map((e, i) => ({ key: e.key, leg: m.legs[i], minutes: e.estMinutes, located: !!at(e), steps: m.steps[i] })),
    endLeg: m.endLeg, endSteps: m.endSteps, totalMeters: m.totalMeters, totalDriveSeconds: m.totalDriveSeconds, geometry: m.geometry, measured: m.measured,
    optimized: !!b.optimize, events: order,
  };
}

/* ───────────── Keeping routes in step ───────────── */

/** Takes events off whatever routes they're on. Returns the routes that still have stops (to re-measure); empty ones are removed. */
async function unrouteIn(tx: Tx, o: { visitIds?: string[]; todoIds?: string[] }) {
  const ors = [];
  if (o.visitIds?.length) ors.push(inArray(dispatchStops.visitId, o.visitIds));
  if (o.todoIds?.length) ors.push(inArray(dispatchStops.todoId, o.todoIds));
  if (!ors.length) return { removed: 0, routeIds: [] as string[] };
  const gone = await tx.delete(dispatchStops).where(or(...ors)).returning({ routeId: dispatchStops.routeId });
  const routeIds = [...new Set(gone.map((g) => g.routeId))];
  if (!routeIds.length) return { removed: 0, routeIds };
  const left = await tx.select({ routeId: dispatchStops.routeId }).from(dispatchStops).where(inArray(dispatchStops.routeId, routeIds));
  const alive = new Set(left.map((l) => l.routeId));
  const empty = routeIds.filter((id) => !alive.has(id));
  if (empty.length) await tx.delete(dispatchRoutes).where(inArray(dispatchRoutes.id, empty));
  return { removed: gone.length, routeIds: routeIds.filter((id) => alive.has(id)) };
}

/** Renumbers a route's stops from 1 and measures its drives again (after stops left it, or its order changed). */
export async function refreshRoutes(companyId: string, routeIds: string[], o: { estimateOnly?: boolean } = {}) {
  if (!routeIds.length) return;
  const settings = await dispatchSettings(companyId);
  const how = o.estimateOnly ? { routing: "estimate" as const, roadUrl: null } : settings;
  const routes = await db.select().from(dispatchRoutes).where(and(eq(dispatchRoutes.companyId, companyId), inArray(dispatchRoutes.id, routeIds)));
  for (const r of routes) {
    const stops = await db.select().from(dispatchStops).where(eq(dispatchStops.routeId, r.id)).orderBy(asc(dispatchStops.stopOrder));
    if (!stops.length) { await db.delete(dispatchRoutes).where(eq(dispatchRoutes.id, r.id)); continue; }
    const vIds = stops.map((s) => s.visitId).filter((x): x is string => !!x);
    const tIds = stops.map((s) => s.todoId).filter((x): x is string => !!x);
    const where = new Map<string, Pt | null>();
    if (vIds.length) for (const x of await db.select({ id: visits.id, lat: properties.lat, lng: properties.lng }).from(visits).leftJoin(properties, eq(properties.id, visits.propertyId)).where(inArray(visits.id, vIds))) where.set(x.id, x.lat != null && x.lng != null ? { lat: x.lat, lng: x.lng } : null);
    if (tIds.length) for (const x of await db.select({ id: todos.id, lat: properties.lat, lng: properties.lng }).from(todos).leftJoin(properties, eq(properties.id, todos.propertyId)).where(inArray(todos.id, tIds))) where.set(x.id, x.lat != null && x.lng != null ? { lat: x.lat, lng: x.lng } : null);
    const start = r.startKind !== "none" && r.startLat != null && r.startLng != null ? { lat: r.startLat, lng: r.startLng } : null;
    const end = r.endKind !== "none" && r.endLat != null && r.endLng != null ? { lat: r.endLat, lng: r.endLng } : null;
    const m = await measure(how, start, stops.map((s) => where.get((s.visitId ?? s.todoId)!) ?? null), end);
    await db.transaction(async (tx) => {
      for (const [i, s] of stops.entries()) await tx.update(dispatchStops).set({ stopOrder: i + 1, driveSeconds: m.legs[i]?.seconds ?? null, driveMeters: m.legs[i]?.meters ?? null }).where(eq(dispatchStops.id, s.id));
      await tx.update(dispatchRoutes).set({ totalMeters: m.totalMeters, totalDriveSeconds: m.totalDriveSeconds, endMeters: m.endLeg?.meters ?? null, endSeconds: m.endLeg?.seconds ?? null, geometry: m.geometry, measured: m.measured, updatedAt: new Date() }).where(eq(dispatchRoutes.id, r.id));
    });
  }
}

/** Locks a routed stop in place (or frees it): Optimize orders the other stops around the locked ones. */
export async function lockStop(companyId: string, b: { key: string; locked: boolean }) {
  const k = parseEventKey(b.key);
  await rowsFor(companyId, [b.key]);
  const done = await db.update(dispatchStops).set({ locked: b.locked }).where(k.kind === "visit" ? eq(dispatchStops.visitId, k.id) : eq(dispatchStops.todoId, k.id)).returning({ id: dispatchStops.id });
  if (!done.length) throw new HttpError(400, "Put it on a route first: only a stop with a place in the order can be locked there.");
  return { key: b.key, locked: b.locked };
}

export async function unroute(companyId: string, keys: string[]) {
  const r = await rowsFor(companyId, keys);
  const done = await db.transaction((tx) => unrouteIn(tx, r));
  await refreshRoutes(companyId, done.routeIds);
  return { unrouted: done.removed };
}

/* ───────────── Who does it ───────────── */

async function checkAssignment(companyId: string, a: { crewId?: string | null; employeeIds: string[] }) {
  if (a.crewId) {
    const [c] = await db.select({ id: crews.id }).from(crews).where(and(eq(crews.id, a.crewId), eq(crews.companyId, companyId)));
    if (!c) throw new HttpError(400, "That crew isn't in your company");
    return { crewId: a.crewId, people: (await db.select({ id: crewMembers.employeeId }).from(crewMembers).where(eq(crewMembers.crewId, a.crewId))).map((m) => m.id) };
  }
  const people = [...new Set(a.employeeIds)];
  if (people.length) {
    const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, people)));
    if (found.length !== people.length) throw new HttpError(400, "One of the people picked isn't on the team");
  }
  return { crewId: null, people };
}

async function assignIn(tx: Tx, r: { visitIds: string[]; todoIds: string[] }, to: { crewId: string | null; people: string[] }) {
  if (r.visitIds.length) {
    await tx.update(visits).set({ crewId: to.crewId, updatedAt: new Date() }).where(inArray(visits.id, r.visitIds));
    await tx.delete(visitAssignees).where(inArray(visitAssignees.visitId, r.visitIds));
    if (to.people.length) await tx.insert(visitAssignees).values(r.visitIds.flatMap((visitId) => to.people.map((employeeId) => ({ visitId, employeeId }))));
  }
  if (r.todoIds.length) {
    await tx.update(todos).set({ crewId: to.crewId, updatedAt: new Date() }).where(inArray(todos.id, r.todoIds));
    await tx.delete(todoAssignees).where(inArray(todoAssignees.todoId, r.todoIds));
    if (to.people.length) await tx.insert(todoAssignees).values(r.todoIds.flatMap((todoId) => to.people.map((employeeId) => ({ todoId, employeeId }))));
  }
}

/**
 * Gives events to one crew (its members come along) or to people (which clears the crew), or to
 * nobody. A stop that moves to a different lane comes off its route; one that stays put stays on.
 */
export async function assignEvents(companyId: string, b: { keys: string[]; crewId?: string | null; employeeIds: string[] }) {
  const to = await checkAssignment(companyId, b);
  const r = await rowsFor(companyId, b.keys);
  const before = await eventsFor(companyId, b.keys, false);
  const lane = laneKeyOf({ crewId: to.crewId, assigneeIds: to.people });
  const moved = before.filter((e) => laneKeyOf(e) !== lane);
  const movedVisits = moved.filter((e) => e.kind === "visit").map((e) => e.id);
  const movedTodos = moved.filter((e) => e.kind === "todo").map((e) => e.id);
  const done = await db.transaction(async (tx) => {
    await assignIn(tx, r, to);
    return unrouteIn(tx, { visitIds: movedVisits, todoIds: movedTodos });
  });
  await refreshRoutes(companyId, done.routeIds);
  return { assigned: b.keys.length, unrouted: done.removed, crewId: to.crewId, people: to.people.length };
}

/* ───────────── Which day ───────────── */

/** Moves events to another day, keeping who does them (and a multi-day one's length). Skipped ones re-open; completed ones can't move. */
export async function rescheduleEvents(companyId: string, b: { keys: string[]; date: string }) {
  const r = await rowsFor(companyId, b.keys);
  if (r.visitRows.some((v) => v.status === "completed") || r.todoRows.some((t) => t.doneAt)) throw new HttpError(400, "Completed ones can't be rescheduled. Take them out of the selection.");
  if (r.visitRows.some((v) => !v.date)) throw new HttpError(400, "One of those is on the waiting list; schedule it from there.");
  let reopened = 0;
  const done = await db.transaction(async (tx) => {
    for (const v of r.visitRows) {
      if (v.status === "skipped") reopened++;
      const length = v.endDate && v.date ? Math.round((Date.parse(v.endDate) - Date.parse(v.date)) / 86_400_000) : 0;
      await tx.update(visits).set({
        date: b.date, endDate: length > 0 ? addDays(b.date, length) : null,
        ...(v.status === "skipped" ? { status: "open", skippedAt: null, skipReason: null, finishedById: null } : {}),
        ...(v.status === "on_site" ? { status: "open", startedAt: null } : {}),
        updatedAt: new Date(),
      }).where(eq(visits.id, v.id));
    }
    for (const t of r.todoRows) {
      const length = t.endDate ? Math.round((Date.parse(t.endDate) - Date.parse(t.date)) / 86_400_000) : 0;
      await tx.update(todos).set({ date: b.date, endDate: length > 0 ? addDays(b.date, length) : null, updatedAt: new Date() }).where(eq(todos.id, t.id));
    }
    return unrouteIn(tx, r);
  });
  await refreshRoutes(companyId, done.routeIds);
  return { rescheduled: b.keys.length, reopened, unrouted: done.removed };
}

/** Back to the waiting list: the scheduled day becomes the earliest date; the latest is kept, set, or left empty. */
export async function toWaitlist(companyId: string, b: { keys: string[]; dueBy: "keep" | string | null }, reason = "Moved from dispatch") {
  const r = await rowsFor(companyId, b.keys);
  if (r.todoRows.length) throw new HttpError(400, "To-dos can't go on the waiting list; only work orders can. Take the to-dos out of the selection.");
  if (r.visitRows.some((v) => v.status === "completed")) throw new HttpError(400, "Completed work orders can't go back to the waiting list");
  const done = await db.transaction(async (tx) => {
    for (const v of r.visitRows) {
      const dueBy = b.dueBy === "keep" ? v.dueBy : b.dueBy;
      await tx.update(visits).set({
        date: null, endDate: null, startTime: null, endTime: null, status: "open", startedAt: null, skippedAt: null, skipReason: null,
        releaseOn: v.date ?? v.releaseOn, dueBy: dueBy && v.date && dueBy < v.date ? null : dueBy,
        waitingSince: new Date(), backReason: reason, updatedAt: new Date(),
      }).where(eq(visits.id, v.id));
    }
    return unrouteIn(tx, r);
  });
  await refreshRoutes(companyId, done.routeIds);
  return { moved: r.visitRows.length, unrouted: done.removed };
}

/** A copy of each (same day, people and services), open and not on a route or an invoice. */
export async function duplicateEvents(companyId: string, by: string, keys: string[]) {
  const r = await rowsFor(companyId, keys);
  const made: string[] = [];
  await db.transaction(async (tx) => {
    let [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${visits.number}), 1000)` }).from(visits).where(eq(visits.companyId, companyId));
    for (const v of r.visitRows) {
      const { id: _id, number: _n, createdAt: _c, updatedAt: _u, status: _s, startedAt: _st, completedAt: _co, completedLat: _la, completedLng: _ln, completedAccuracy: _ac, skippedAt: _sk, finishedById: _f, skipReason: _sr, completionNotes: _cn, invoiceId: _i, seriesId: _se, repeatLabel: _r, earlyReason: _er, earlyById: _eb, earlyAt: _ea, waitingSince: _w, backReason: _b, ...copy } = v;
      const [row] = await tx.insert(visits).values({ ...copy, number: ++n, createdById: by }).returning({ id: visits.id });
      const lines = await tx.select().from(visitLines).where(eq(visitLines.visitId, v.id));
      if (lines.length) await tx.insert(visitLines).values(lines.map(({ id: _l, ...l }) => ({ ...l, visitId: row.id })));
      const people = await tx.select().from(visitAssignees).where(eq(visitAssignees.visitId, v.id));
      if (people.length) await tx.insert(visitAssignees).values(people.map((p) => ({ visitId: row.id, employeeId: p.employeeId })));
      made.push(eventKey("visit", row.id));
    }
    for (const t of r.todoRows) {
      const { id: _id, createdAt: _c, updatedAt: _u, doneAt: _d, doneById: _db, startedAt: _s, trackedSeconds: _t, seriesId: _se, repeat: _r, ...copy } = t;
      const [row] = await tx.insert(todos).values({ ...copy, createdById: by }).returning({ id: todos.id });
      const people = await tx.select().from(todoAssignees).where(eq(todoAssignees.todoId, t.id));
      if (people.length) await tx.insert(todoAssignees).values(people.map((p) => ({ todoId: row.id, employeeId: p.employeeId })));
      made.push(eventKey("todo", row.id));
    }
  });
  return { duplicated: made.length, keys: made };
}

/** Deletes events (a work order on a live invoice stays). Their stops go with them and the routes close up. */
export async function deleteEvents(companyId: string, keys: string[]) {
  const r = await rowsFor(companyId, keys);
  const invIds = r.visitRows.map((v) => v.invoiceId).filter((x): x is string => !!x);
  const live = new Set((invIds.length ? await db.select({ id: invoices.id }).from(invoices).where(and(inArray(invoices.id, invIds), sql`${invoices.status} <> 'void'`)) : []).map((i) => i.id));
  const visitIds = r.visitRows.filter((v) => !v.invoiceId || !live.has(v.invoiceId)).map((v) => v.id);
  const done = await db.transaction(async (tx) => {
    const res = await unrouteIn(tx, { visitIds, todoIds: r.todoIds });
    if (visitIds.length) await tx.delete(visits).where(inArray(visits.id, visitIds));
    if (r.todoIds.length) await tx.delete(todos).where(inArray(todos.id, r.todoIds));
    return res;
  });
  await refreshRoutes(companyId, done.routeIds);
  return { deleted: visitIds.length + r.todoIds.length, kept: r.visitRows.length - visitIds.length };
}

/* ───────────── Saving a route ───────────── */

async function writeRoute(tx: Tx, o: {
  companyId: string; by: string | null; id?: string; date: string; crewId: string | null; start: Point | null; end: Point | null; startKind: string; endKind: string;
  startTime: string; pinnedFirst: boolean; keys: string[]; legs: (Leg | null)[]; endLeg: Leg | null; totalMeters: number; totalDriveSeconds: number; geometry: [number, number][] | null; measured: string;
}) {
  const parsed = o.keys.map(parseEventKey);
  // Stops that were on other routes leave them.
  const elsewhere = await unrouteOthers(tx, parsed, o.id);
  const values = {
    date: o.date, crewId: o.crewId, startKind: o.startKind, startLabel: o.start?.label ?? null, startLat: o.start?.lat ?? null, startLng: o.start?.lng ?? null,
    endKind: o.endKind, endLabel: o.end?.label ?? null, endLat: o.end?.lat ?? null, endLng: o.end?.lng ?? null, startTime: o.startTime, pinnedFirst: o.pinnedFirst,
    totalMeters: o.totalMeters, totalDriveSeconds: o.totalDriveSeconds, endMeters: o.endLeg?.meters ?? null, endSeconds: o.endLeg?.seconds ?? null, geometry: o.geometry, measured: o.measured, updatedAt: new Date(),
  };
  let id = o.id;
  // Stops that were locked on this route stay locked through a reorder.
  const locked = new Set<string>();
  if (id) {
    await tx.update(dispatchRoutes).set(values).where(eq(dispatchRoutes.id, id));
    const gone = await tx.delete(dispatchStops).where(eq(dispatchStops.routeId, id)).returning({ visitId: dispatchStops.visitId, todoId: dispatchStops.todoId, locked: dispatchStops.locked });
    for (const g of gone) if (g.locked) locked.add((g.visitId ?? g.todoId)!);
  } else {
    [{ id }] = await tx.insert(dispatchRoutes).values({ ...values, companyId: o.companyId, createdById: o.by }).returning({ id: dispatchRoutes.id });
  }
  await tx.insert(dispatchStops).values(parsed.map((k, i) => ({
    routeId: id!, visitId: k.kind === "visit" ? k.id : null, todoId: k.kind === "todo" ? k.id : null, stopOrder: i + 1,
    driveSeconds: o.legs[i]?.seconds ?? null, driveMeters: o.legs[i]?.meters ?? null, locked: locked.has(k.id),
  })));
  return { id: id!, elsewhere };
}

async function unrouteOthers(tx: Tx, parsed: { kind: EventKind; id: string }[], keepRouteId?: string) {
  const visitIds = parsed.filter((k) => k.kind === "visit").map((k) => k.id);
  const todoIds = parsed.filter((k) => k.kind === "todo").map((k) => k.id);
  const ors = [];
  if (visitIds.length) ors.push(inArray(dispatchStops.visitId, visitIds));
  if (todoIds.length) ors.push(inArray(dispatchStops.todoId, todoIds));
  if (!ors.length) return [] as string[];
  const gone = await tx.delete(dispatchStops).where(and(or(...ors), keepRouteId ? sql`${dispatchStops.routeId} <> ${keepRouteId}` : undefined)).returning({ routeId: dispatchStops.routeId });
  const routeIds = [...new Set(gone.map((g) => g.routeId))];
  if (!routeIds.length) return routeIds;
  const alive = new Set((await tx.select({ routeId: dispatchStops.routeId }).from(dispatchStops).where(inArray(dispatchStops.routeId, routeIds))).map((l) => l.routeId));
  const empty = routeIds.filter((id) => !alive.has(id));
  if (empty.length) await tx.delete(dispatchRoutes).where(inArray(dispatchRoutes.id, empty));
  return routeIds.filter((id) => alive.has(id));
}

/** The one crew every stop shares, if there is one (a route belongs to one lane). */
const commonCrew = (events: { crewId: string | null }[]) => (events.length && events.every((e) => e.crewId && e.crewId === events[0].crewId) ? events[0].crewId : null);

/**
 * Saves a route for a day: a new one, or (with `id`) the same one again with its changes. "Assign
 * all" gives every stop a crew or people as it saves; `future` copies the order to the same weekday
 * in later weeks for the stops that repeat.
 */
export async function saveRoute(companyId: string, by: string, b: RouteSaveInput) {
  if (b.keys.length > DISPATCH_ROUTE_MAX) throw new HttpError(400, `A route is limited to ${DISPATCH_ROUTE_MAX} stops. Split it into smaller routes.`);
  if (new Set(b.keys).size !== b.keys.length) throw new HttpError(400, "A stop is on the route twice");
  if (b.id) {
    const [r] = await db.select({ id: dispatchRoutes.id, date: dispatchRoutes.date }).from(dispatchRoutes).where(and(eq(dispatchRoutes.id, b.id), eq(dispatchRoutes.companyId, companyId)));
    if (!r) throw new HttpError(404, "That route isn't there any more. Someone may have changed it; reload the board.");
  }
  const to = b.assign ? await checkAssignment(companyId, { crewId: b.assign.crewId, employeeIds: b.assign.employeeIds }) : null;
  const p = await previewRoute(companyId, { date: b.date, keys: b.keys, start: b.start, end: b.end });
  const rows = await rowsFor(companyId, b.keys);
  const saved = await db.transaction(async (tx) => {
    if (to) await assignIn(tx, rows, to);
    return writeRoute(tx, {
      companyId, by, id: b.id, date: b.date, crewId: to ? to.crewId : commonCrew(p.events), start: p.start, end: p.end, startKind: b.start.kind, endKind: b.end.kind,
      startTime: b.startTime, pinnedFirst: b.pinnedFirst, keys: p.keys, legs: p.stops.map((s) => s.leg), endLeg: p.endLeg,
      totalMeters: p.totalMeters, totalDriveSeconds: p.totalDriveSeconds, geometry: p.geometry, measured: p.measured,
    });
  });
  await refreshRoutes(companyId, saved.elsewhere);
  const future = b.future ? await applyToFutureWeeks(companyId, by, { routeId: saved.id, everyWeeks: b.future.everyWeeks, assignments: b.future.assignments }) : null;
  return { id: saved.id, stops: p.keys.length, future };
}

/** The future days a route's order would be copied to, and how many visits there already have someone else on them. */
export async function futureWeeks(companyId: string, b: { date: string; keys: string[]; everyWeeks: number }) {
  const events = await eventsFor(companyId, b.keys, false);
  const days: { date: string; keys: string[]; different: number }[] = [];
  const vSeries = [...new Set(events.filter((e) => e.kind === "visit" && e.seriesId).map((e) => e.seriesId!))];
  const tSeries = [...new Set(events.filter((e) => e.kind === "todo" && e.seriesId).map((e) => e.seriesId!))];
  if (!vSeries.length && !tSeries.length) return { days, repeating: 0 };
  const laneOf = new Map(events.filter((e) => e.seriesId).map((e) => [`${e.kind}:${e.seriesId}`, laneKeyOf(e)]));
  const rank = new Map(events.filter((e) => e.seriesId).map((e, i) => [`${e.kind}:${e.seriesId}`, i]));
  for (let k = 1; k * b.everyWeeks <= 52; k++) {
    const d = addDays(b.date, 7 * b.everyWeeks * k);
    const vs = vSeries.length ? await db.select().from(visits).where(and(eq(visits.companyId, companyId), inArray(visits.seriesId, vSeries), eq(visits.date, d), inArray(visits.status, ["open", "on_site"]))) : [];
    const ts = tSeries.length ? await db.select().from(todos).where(and(eq(todos.companyId, companyId), inArray(todos.seriesId, tSeries), eq(todos.date, d), isNull(todos.doneAt))) : [];
    if (!vs.length && !ts.length) continue;
    const found = await asEvents({ visitRows: vs, todoRows: ts, showPrices: false, routeOf: new Map() });
    found.sort((a, c) => (rank.get(`${a.kind}:${a.seriesId}`) ?? 0) - (rank.get(`${c.kind}:${c.seriesId}`) ?? 0));
    days.push({
      date: d, keys: found.map((e) => e.key),
      different: found.filter((e) => laneKeyOf(e) !== "unassigned" && laneKeyOf(e) !== laneOf.get(`${e.kind}:${e.seriesId}`)).length,
    });
  }
  return { days, repeating: vSeries.length + tSeries.length };
}

/** Copies a saved route's order to the same weekday in later weeks, for the stops that repeat. No visits are made. */
async function applyToFutureWeeks(companyId: string, by: string, o: { routeId: string; everyWeeks: number; assignments: "none" | "keep" | "replace" }) {
  const [route] = await db.select().from(dispatchRoutes).where(eq(dispatchRoutes.id, o.routeId));
  const stops = await db.select().from(dispatchStops).where(eq(dispatchStops.routeId, o.routeId)).orderBy(asc(dispatchStops.stopOrder));
  const keys = stops.map((s) => (s.visitId ? eventKey("visit", s.visitId) : eventKey("todo", s.todoId!)));
  const base = await eventsFor(companyId, keys, false);
  const source = new Map(base.filter((e) => e.seriesId).map((e) => [`${e.kind}:${e.seriesId}`, e]));
  const plan = await futureWeeks(companyId, { date: route.date, keys, everyWeeks: o.everyWeeks });
  let stopsSaved = 0;
  for (const day of plan.days) {
    const events = await eventsFor(companyId, day.keys, false);
    if (o.assignments !== "none") {
      await db.transaction(async (tx) => {
        for (const e of events) {
          const from = source.get(`${e.kind}:${e.seriesId}`);
          if (!from) continue;
          const has = laneKeyOf(e) !== "unassigned";
          if (o.assignments === "keep" && has) continue;
          await assignIn(tx, { visitIds: e.kind === "visit" ? [e.id] : [], todoIds: e.kind === "todo" ? [e.id] : [] }, { crewId: from.crewId, people: from.assigneeIds });
        }
      });
    }
    const start = route.startKind !== "none" && route.startLat != null && route.startLng != null ? { kind: route.startKind as "custom", label: route.startLabel, lat: route.startLat, lng: route.startLng } : { kind: route.startKind === "none" ? "none" as const : "company" as const };
    const end = route.endKind !== "none" && route.endLat != null && route.endLng != null ? { kind: route.endKind as "custom", label: route.endLabel, lat: route.endLat, lng: route.endLng } : { kind: route.endKind === "none" ? "none" as const : "company" as const };
    const p = await previewRoute(companyId, { date: day.date, keys: day.keys, start, end }, { estimateOnly: true });
    const again = await eventsFor(companyId, day.keys, false);
    const res = await db.transaction((tx) => writeRoute(tx, {
      companyId, by, date: day.date, crewId: commonCrew(again), start: p.start, end: p.end, startKind: route.startKind, endKind: route.endKind, startTime: route.startTime, pinnedFirst: route.pinnedFirst,
      keys: p.keys, legs: p.stops.map((s) => s.leg), endLeg: p.endLeg, totalMeters: p.totalMeters, totalDriveSeconds: p.totalDriveSeconds, geometry: p.geometry, measured: p.measured,
    }));
    await refreshRoutes(companyId, res.elsewhere, { estimateOnly: true });
    stopsSaved += p.keys.length;
  }
  return { days: plan.days.length, stops: stopsSaved };
}

/* ───────────── The plan's board: a lane is a crew's day, in order ───────────── */

/**
 * Sets a lane to exactly these work orders in this order: each joins the crew (and the day), and
 * the crew's route for the day becomes this order. With no crew, they lose their crew and come off
 * their routes ("No crew yet").
 */
export async function setLane(companyId: string, by: string, b: { date: string; crewId: string | null; keys: string[] }) {
  if (!b.keys.length && !b.crewId) return { stops: 0 };
  const r = b.keys.length ? await rowsFor(companyId, b.keys) : { visitIds: [], todoIds: [], visitRows: [] as Visit[], todoRows: [] as Todo[] };
  if (r.todoRows.length) throw new HttpError(400, "Only work orders go in a crew's lane");
  if (r.visitRows.some((v) => !v.date)) throw new HttpError(400, "One of those is still on the waiting list; schedule it first.");
  if (r.visitRows.some((v) => v.status === "completed" && v.date !== b.date)) throw new HttpError(400, "Completed work orders can't move to another day");
  const to = b.crewId ? await checkAssignment(companyId, { crewId: b.crewId, employeeIds: [] }) : { crewId: null, people: [] as string[] };
  const before = b.keys.length ? await eventsFor(companyId, b.keys, false) : [];
  const moved = await db.transaction(async (tx) => {
    for (const e of before) {
      const changed = e.crewId !== to.crewId || e.date !== b.date;
      if (!changed) continue;
      await tx.update(visits).set({ crewId: to.crewId, date: b.date, endDate: null, waitingSince: null, backReason: null, updatedAt: new Date() }).where(eq(visits.id, e.id));
      // The new crew's people do it now.
      if (e.crewId !== to.crewId) {
        await tx.delete(visitAssignees).where(eq(visitAssignees.visitId, e.id));
        if (to.people.length) await tx.insert(visitAssignees).values(to.people.map((employeeId) => ({ visitId: e.id, employeeId })));
      }
    }
    if (!b.crewId) return unrouteIn(tx, r);
    return { removed: 0, routeIds: [] as string[] };
  });
  if (!b.crewId) { await refreshRoutes(companyId, moved.routeIds); return { stops: 0 }; }
  // One route per crew per day: this order replaces whatever it had.
  const existing = await db.select().from(dispatchRoutes).where(and(eq(dispatchRoutes.companyId, companyId), eq(dispatchRoutes.date, b.date), eq(dispatchRoutes.crewId, b.crewId))).orderBy(asc(dispatchRoutes.createdAt));
  const keep = existing[0];
  if (!b.keys.length) {
    if (existing.length) await db.delete(dispatchRoutes).where(inArray(dispatchRoutes.id, existing.map((x) => x.id)));
    return { stops: 0 };
  }
  const start = keep && keep.startKind !== "company" ? { kind: keep.startKind as "custom", label: keep.startLabel, lat: keep.startLat, lng: keep.startLng } : { kind: "company" as const };
  const end = keep && keep.endKind !== "company" ? { kind: keep.endKind as "custom", label: keep.endLabel, lat: keep.endLat, lng: keep.endLng } : { kind: "company" as const };
  const p = await previewRoute(companyId, { date: b.date, keys: b.keys, start, end });
  const saved = await db.transaction(async (tx) => {
    if (existing.length > 1) await tx.delete(dispatchRoutes).where(inArray(dispatchRoutes.id, existing.slice(1).map((x) => x.id)));
    return writeRoute(tx, {
      companyId, by, id: keep?.id, date: b.date, crewId: b.crewId, start: p.start, end: p.end, startKind: start.kind, endKind: end.kind, startTime: keep?.startTime ?? "08:00", pinnedFirst: keep?.pinnedFirst ?? false,
      keys: p.keys, legs: p.stops.map((s) => s.leg), endLeg: p.endLeg, totalMeters: p.totalMeters, totalDriveSeconds: p.totalDriveSeconds, geometry: p.geometry, measured: p.measured,
    });
  });
  await refreshRoutes(companyId, saved.elsewhere);
  return { stops: p.keys.length, routeId: saved.id, totalDriveSeconds: p.totalDriveSeconds, totalMeters: p.totalMeters };
}

/** The next day that's a weekday and not one of the company's holidays. */
export async function nextWorkingDay(companyId: string, after: string) {
  const hol = new Set(holidaysBetween((await db.select().from(holidays).where(eq(holidays.companyId, companyId))).map((h) => ({ ...h, observe: h.observe as "none" | "nearest" })), after, addDays(after, 21)).map((h) => h.date));
  for (let i = 1; i <= 21; i++) {
    const d = addDays(after, i);
    if (weekday(d) !== 0 && weekday(d) !== 6 && !hol.has(d)) return d;
  }
  return addDays(after, 1);
}

/**
 * Rain or wind day: a crew's, or the whole day's, open work orders go back to the waiting list or to
 * the next working day in one step. Customers who asked for a text ahead can be told.
 */
export async function rainDay(companyId: string, by: string, b: { date: string; crewId: string; to: "waitlist" | "next"; toDate?: string; reason: keyof typeof BACK_REASON_LABELS; note?: string | null; notify: boolean }) {
  const rows = await db.select().from(visits).where(and(
    eq(visits.companyId, companyId), eq(visits.date, b.date), eq(visits.status, "open"),
    b.crewId === "all" ? undefined : b.crewId === "none" ? isNull(visits.crewId) : eq(visits.crewId, b.crewId),
  ));
  if (!rows.length) return { moved: 0, to: null as string | null, texted: 0, notTexted: 0, toCall: [] as string[] };
  const keys = rows.map((v) => eventKey("visit", v.id));
  const why = `${BACK_REASON_LABELS[b.reason]}${b.note ? `: ${b.note}` : ""}`;
  const toDate = b.to === "next" ? b.toDate ?? (await nextWorkingDay(companyId, b.date)) : null;
  if (toDate && toDate <= b.date) throw new HttpError(400, "Pick a later day to move them to");
  if (toDate) await rescheduleEvents(companyId, { keys, date: toDate });
  else await toWaitlist(companyId, { keys, dueBy: "keep" }, why);
  let texted = 0, notTexted = 0;
  const toCall: string[] = [];
  if (b.notify) {
    const [co] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    const texting = !!(await textingConfig(companyId));
    const events = await eventsFor(companyId, keys, false);
    const told = new Set<string>();
    for (const e of events) {
      if (!e.customer || told.has(e.customer.id)) continue;
      if (e.notifyBefore === "call") { toCall.push(e.customer.name); told.add(e.customer.id); continue; }
      if (e.notifyBefore !== "text") continue;
      told.add(e.customer.id);
      if (!texting) { notTexted++; continue; }
      const what = (e.services[0]?.name ?? e.title).toLowerCase();
      const body = toDate
        ? `${co.name}: because of ${BACK_REASON_LABELS[b.reason].toLowerCase()}, your ${what} is moving to ${longDay(toDate)}. Reply STOP to opt out.`
        : `${co.name}: because of ${BACK_REASON_LABELS[b.reason].toLowerCase()}, we couldn't get to your ${what} on ${longDay(b.date)}. We'll be in touch with a new day. Reply STOP to opt out.`;
      const s = await sendCustomerText(companyId, e.customer.id, body, { by, source: "office" });
      if (s.text && s.text.status !== "failed") texted++; else notTexted++;
    }
  }
  return { moved: rows.length, to: toDate, texted, notTexted, toCall: [...new Set(toCall)] };
}

/* ───────────── Notes, trucks, people ───────────── */

/** A dispatch note: a short message on an event between the office and the field. Notes are never edited or deleted. */
export async function addDispatchNote(companyId: string, by: string, b: { key: string; body: string }) {
  const k = parseEventKey(b.key);
  await rowsFor(companyId, [b.key]);
  if (k.kind === "visit") await db.insert(visitDispatchNotes).values({ companyId, visitId: k.id, body: b.body, authorId: by });
  else await db.insert(todoNotes).values({ companyId, todoId: k.id, body: b.body, authorId: by });
  const [e] = await eventsFor(companyId, [b.key], false);
  return { key: b.key, dispatchNotes: e.dispatchNotes };
}

/** Where each person was last seen in the past 6 hours (from the phone app's location while clocked in). */
export async function trucks(companyId: string) {
  const since = new Date(Date.now() - 6 * 3600_000);
  const rows = await db.execute<{ employee_id: string; lat: number; lng: number; recorded_at: Date; first_name: string; last_name: string }>(sql`
    select distinct on (p.employee_id) p.employee_id, p.lat, p.lng, p.recorded_at, e.first_name, e.last_name
    from location_pings p join employees e on e.id = p.employee_id
    where p.company_id = ${companyId} and p.recorded_at > ${since.toISOString()}::timestamptz
    order by p.employee_id, p.recorded_at desc`);
  return rows.rows.map((r) => ({ employeeId: r.employee_id, name: `${r.first_name} ${r.last_name}`, color: personColor(r.employee_id), lat: Number(r.lat), lng: Number(r.lng), at: new Date(r.recorded_at).toISOString() }));
}

/** Everyone who can be given work, with their dispatch capacity. */
export async function dispatchPeople(companyId: string) {
  const rows = await db.select({
    id: employees.id, firstName: employees.firstName, lastName: employees.lastName, status: employees.status,
    dailyHours: employees.dailyCapacityHours, weeklyHours: employees.weeklyCapacityHours, excluded: employees.capacityExcluded,
    address: sql<string | null>`nullif(concat_ws(', ', ${employees.addressLine1}, ${employees.city}, nullif(concat_ws(' ', ${employees.state}, ${employees.zip}), '')), '')`,
  }).from(employees).where(and(eq(employees.companyId, companyId), sql`${employees.status} not in ('inactive', 'terminated')`)).orderBy(asc(employees.firstName), asc(employees.lastName));
  return rows.map((e) => ({ ...e, name: `${e.firstName} ${e.lastName}`, color: personColor(e.id), hasAddress: !!e.address, address: undefined }));
}

/** Where someone starts from (their home address on file), for a route that begins or ends there. */
export async function employeePoint(companyId: string, employeeId: string) {
  const [e] = await db.select({ line1: employees.addressLine1, city: employees.city, state: employees.state, zip: employees.zip }).from(employees).where(and(eq(employees.id, employeeId), eq(employees.companyId, companyId)));
  const address = e?.line1 ? [e.line1, e.city, [e.state, e.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  if (!address) throw new HttpError(400, "No address on file for this employee.");
  const at = await locator(address);
  if (!at) throw new HttpError(400, "This employee's address couldn't be found on the map.");
  return { label: address, lat: at.lat, lng: at.lng };
}

/** Holidays on the days given, by date. */
export async function holidaysOn(companyId: string, from: string, to: string) {
  const hol = holidaysBetween((await db.select().from(holidays).where(eq(holidays.companyId, companyId))).map((h) => ({ ...h, observe: h.observe as "none" | "nearest" })), from, to);
  return Object.fromEntries(hol.map((h) => [h.date, h.holiday.name]));
}

/** How many work orders are waiting with no date (and released). */
export async function waitingCount(companyId: string, today: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(visits).where(and(eq(visits.companyId, companyId), isNull(visits.date), eq(visits.status, "open"), sql`(${visits.releaseOn} is null or ${visits.releaseOn} <= ${today})`));
  return n;
}

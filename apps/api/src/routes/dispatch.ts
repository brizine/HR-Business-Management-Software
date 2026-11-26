import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  MAP_AREAS_MAX, capacitySchema, dispatchAssignSchema, dispatchKeysSchema, dispatchNoteSchema, dispatchRescheduleSchema, dispatchSettingsSchema, dispatchToWaitlistSchema,
  laneOrderSchema, mapAreaSchema, rainDaySchema, routePreviewSchema, routeSaveSchema,
} from "@crewdesk/shared";
import { db } from "../db";
import { dispatchRoutes, dispatchStops, employees, mapAreas } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import {
  addDispatchNote, assignEvents, deleteEvents, dispatchPeople, dispatchSettings, duplicateEvents, employeePoint, eventsBetween, futureWeeks, holidaysOn, locateAddress,
  nextWorkingDay, previewRoute, rainDay, rescheduleEvents, routesBetween, saveDispatchSettings, saveRoute, setLane, toWaitlist, trucks, unroute, waitingCount,
} from "../lib/dispatch";
import { HttpError, notFound, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { crewList } from "./crews";

const AREA = "customers" as const;
const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const daysApart = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const uuidParam = (id: string) => { if (!/^[0-9a-f-]{36}$/i.test(id)) notFound(); return id; };

/**
 * Dispatch (both boards): the work orders and to-dos on a day or a range of days, their routes, and
 * the moves a dispatcher makes. For Customers & billing managers.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  app.get<{ Querystring: { from?: string; to?: string } }>("/", async (req) => {
    const { companyId } = req.user;
    const today = await companyToday(companyId);
    const from = isDay(req.query.from) ? req.query.from! : today;
    const to = isDay(req.query.to) && req.query.to! >= from ? req.query.to! : from;
    if (daysApart(from, to) > 62) throw new HttpError(400, "Pick a range of two months or less");
    const settings = await dispatchSettings(companyId);
    const [events, routeRows, crews, people, holidays, waiting] = await Promise.all([
      eventsBetween(companyId, from, to, true), routesBetween(companyId, from, to), crewList(companyId, true), dispatchPeople(companyId), holidaysOn(companyId, from, to), waitingCount(companyId, today),
    ]);
    return {
      today, from, to, events, routes: routeRows, holidays, waiting,
      crews: crews.map((c) => ({ id: c.id, name: c.name, color: c.color, dailyHours: c.dailyHours, memberIds: c.memberIds, truck: c.assetName })),
      people,
      settings: { routing: settings.routing, roadUrl: settings.roadUrl, startAddress: settings.start?.address ?? null, endAddress: settings.end?.address ?? null },
      start: settings.start ?? settings.depot, end: settings.end ?? settings.depot, depot: settings.depot,
    };
  });

  /* ── Moves ── */

  app.post("/assign", async (req) => assignEvents(req.user.companyId, parse(dispatchAssignSchema, req.body)));
  app.post("/reschedule", async (req) => rescheduleEvents(req.user.companyId, parse(dispatchRescheduleSchema, req.body)));
  app.post("/waitlist", async (req) => toWaitlist(req.user.companyId, parse(dispatchToWaitlistSchema, req.body)));
  app.post("/duplicate", async (req) => duplicateEvents(req.user.companyId, req.user.sub, parse(dispatchKeysSchema, req.body).keys));
  app.post("/delete", async (req) => deleteEvents(req.user.companyId, parse(dispatchKeysSchema, req.body).keys));
  app.post("/unroute", async (req) => unroute(req.user.companyId, parse(dispatchKeysSchema, req.body).keys));

  /* ── Routes ── */

  /** A route before it's saved: each drive, the totals and the line (and the best order, when asked). */
  app.post("/routes/preview", async (req) => {
    const { events: _events, ...p } = await previewRoute(req.user.companyId, parse(routePreviewSchema, req.body));
    return p;
  });
  app.post("/routes", async (req) => saveRoute(req.user.companyId, req.user.sub, parse(routeSaveSchema, req.body)));
  /** Which future days would take this order, and how many visits there already have someone else on them. */
  app.post("/routes/future", async (req) => {
    const b = parse(routePreviewSchema.pick({ date: true, keys: true }).extend({ everyWeeks: z.coerce.number().int().min(1).max(52) }), req.body);
    const plan = await futureWeeks(req.user.companyId, b);
    return { days: plan.days.map((d) => ({ date: d.date, stops: d.keys.length, different: d.different })), repeating: plan.repeating };
  });
  /** A saved route with turn-by-turn steps, for printing. */
  app.get<{ Params: { id: string } }>("/routes/:id/directions", async (req) => {
    const [r] = await db.select().from(dispatchRoutes).where(and(eq(dispatchRoutes.id, uuidParam(req.params.id)), eq(dispatchRoutes.companyId, req.user.companyId)));
    if (!r) notFound("Route");
    const stops = await db.select().from(dispatchStops).where(eq(dispatchStops.routeId, r.id)).orderBy(asc(dispatchStops.stopOrder));
    const point = (kind: string, label: string | null, lat: number | null, lng: number | null) => (kind === "none" ? { kind: "none" as const } : lat != null && lng != null ? { kind: "custom" as const, label, lat, lng } : { kind: "company" as const });
    const { events: _events, ...p } = await previewRoute(req.user.companyId, {
      date: r.date, keys: stops.map((s) => (s.visitId ? `v:${s.visitId}` : `t:${s.todoId}`)), start: point(r.startKind, r.startLabel, r.startLat, r.startLng), end: point(r.endKind, r.endLabel, r.endLat, r.endLng), steps: true,
    });
    return p;
  });

  /* ── The plan's board ── */

  app.post("/lane", async (req) => setLane(req.user.companyId, req.user.sub, parse(laneOrderSchema, req.body)));
  app.post("/rain", async (req) => {
    const b = parse(rainDaySchema.extend({ toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body);
    return rainDay(req.user.companyId, req.user.sub, b);
  });
  app.get<{ Querystring: { after?: string } }>("/next-working-day", async (req) => {
    const after = isDay(req.query.after) ? req.query.after! : await companyToday(req.user.companyId);
    return { date: await nextWorkingDay(req.user.companyId, after) };
  });

  /* ── Notes, trucks, map lookups ── */

  app.post("/notes", async (req) => addDispatchNote(req.user.companyId, req.user.sub, parse(dispatchNoteSchema, req.body)));
  app.get("/trucks", async (req) => ({ trucks: await trucks(req.user.companyId) }));
  app.get<{ Querystring: { q?: string } }>("/locate", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 3) throw new HttpError(400, "Type more of the address");
    const at = await locateAddress(q);
    if (!at) throw new HttpError(404, "Couldn't find that address.");
    return { label: q, ...at };
  });
  app.get<{ Params: { id: string } }>("/employee-point/:id", async (req) => employeePoint(req.user.companyId, uuidParam(req.params.id)));

  /* ── Custom areas: shapes on the map, shared by everyone ── */

  const areaRows = (companyId: string) => db.select().from(mapAreas).where(eq(mapAreas.companyId, companyId)).orderBy(asc(mapAreas.sortOrder), asc(mapAreas.createdAt));
  app.get("/areas", async (req) => ({ areas: (await areaRows(req.user.companyId)).map(({ id, name, color, points }) => ({ id, name, color, points })) }));
  app.post("/areas", async (req) => {
    const b = parse(mapAreaSchema, req.body);
    const have = await areaRows(req.user.companyId);
    if (have.length >= MAP_AREAS_MAX) throw new HttpError(400, `A company can have up to ${MAP_AREAS_MAX} areas`);
    const [a] = await db.insert(mapAreas).values({ companyId: req.user.companyId, name: b.name, color: b.color, points: b.points, sortOrder: have.length, createdById: req.user.sub }).returning();
    return { id: a.id, name: a.name, color: a.color, points: a.points };
  });
  app.put<{ Params: { id: string } }>("/areas/:id", async (req) => {
    const b = parse(mapAreaSchema.partial(), req.body);
    const [a] = await db.update(mapAreas).set({ ...(b.name !== undefined ? { name: b.name } : {}), ...(b.color !== undefined ? { color: b.color } : {}), ...(b.points !== undefined ? { points: b.points } : {}) })
      .where(and(eq(mapAreas.id, uuidParam(req.params.id)), eq(mapAreas.companyId, req.user.companyId))).returning();
    if (!a) notFound("Area");
    return { id: a.id, name: a.name, color: a.color, points: a.points };
  });
  app.delete<{ Params: { id: string } }>("/areas/:id", async (req) => {
    const gone = await db.delete(mapAreas).where(and(eq(mapAreas.id, uuidParam(req.params.id)), eq(mapAreas.companyId, req.user.companyId))).returning({ id: mapAreas.id });
    if (!gone.length) notFound("Area");
    return { ok: true };
  });
  /** The order areas are listed in, for everyone. */
  app.put("/areas", async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(MAP_AREAS_MAX) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(mapAreas).set({ sortOrder: i }).where(and(eq(mapAreas.id, id), eq(mapAreas.companyId, req.user.companyId)));
    });
    return { ok: true };
  });

  /* ── Settings ── */

  app.put("/settings", admin, async (req) => {
    const s = await saveDispatchSettings(req.user.companyId, parse(dispatchSettingsSchema, req.body));
    return { routing: s.routing, roadUrl: s.roadUrl, startAddress: s.start?.address ?? null, endAddress: s.end?.address ?? null };
  });
  /** Each person's daily (and weekly) budgeted-hour capacity, and who doesn't count toward a crew's. */
  app.put("/capacity", admin, async (req) => {
    const b = parse(capacitySchema, req.body);
    const ids = b.employees.map((e) => e.id);
    const found = ids.length ? await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, req.user.companyId), inArray(employees.id, ids))) : [];
    if (found.length !== new Set(ids).size) throw new HttpError(400, "One of those people isn't on the team");
    await db.transaction(async (tx) => {
      for (const e of b.employees) await tx.update(employees).set({ dailyCapacityHours: e.dailyHours, weeklyCapacityHours: e.weeklyHours ?? null, capacityExcluded: e.excluded }).where(eq(employees.id, e.id));
    });
    return { people: await dispatchPeople(req.user.companyId) };
  });
};

export default routes;

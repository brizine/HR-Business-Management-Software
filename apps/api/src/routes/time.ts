import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { clockInSchema, entryHours, formatDistance, locationPolicySchema, summarizeHours, timeEntryEditSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { companies, employees, jobSites, ptoLedger, ptoPolicies, shifts, timeEntries } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { activeSites, checkPunch, locationPolicies, type PunchCheck } from "../lib/geofence";
import { approversFor, except, notify } from "../lib/notify";

const rangeQuery = z.object({
  employeeId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  async function openEntry(employeeId: string) {
    const [row] = await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.employeeId, employeeId), isNull(timeEntries.clockOut)));
    return row;
  }

  /** Current punch plus the company's location rules, so the app knows whether to insist on location. */
  app.get("/status", async (req) => ({
    openEntry: (await openEntry(req.user.sub)) ?? null,
    locationPolicy: await locationPolicies(req.user.companyId),
  }));

  app.get("/location-policy", async (req) => {
    const sites = await activeSites(req.user.companyId);
    return { ...(await locationPolicies(req.user.companyId)), activeSites: sites.length };
  });

  app.put("/location-policy", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(locationPolicySchema, req.body);
    await db
      .update(companies)
      .set({ clockInLocation: body.clockIn, clockOutLocation: body.clockOut })
      .where(eq(companies.id, req.user.companyId));
    return body;
  });

  /** Tells the employee's manager about a punch flagged as away from every job site. */
  async function reportOffSite(req: FastifyRequest, action: "in" | "out", check: PunchCheck) {
    if (!check.flag) return;
    const [me] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    notify(req.user.companyId, except(await approversFor(req.user.companyId, req.user.sub), req.user.sub), {
      category: "time",
      title: `${me.firstName} ${me.lastName} clocked ${action} away from a job site`,
      body: check.distance !== null ? `${formatDistance(check.distance)} from the nearest job site. Review it on the timesheet.` : "Review it on the timesheet.",
      link: { screen: "time" },
    });
  }

  app.post("/clock-in", async (req) => {
    const body = parse(clockInSchema, req.body ?? {});
    if (await openEntry(req.user.sub)) throw new HttpError(409, "Already clocked in");
    const check = await checkPunch(req.user.companyId, (await locationPolicies(req.user.companyId)).clockIn, body, "in");
    const [row] = await db
      .insert(timeEntries)
      .values({
        companyId: req.user.companyId,
        employeeId: req.user.sub,
        clockIn: new Date(),
        clockInLat: body.lat,
        clockInLng: body.lng,
        clockInAccuracy: body.accuracy,
        clockInSiteId: check.siteId,
        clockInDistance: check.distance,
        clockInFlag: check.flag,
        note: body.note,
      })
      .returning();
    await reportOffSite(req, "in", check);
    return { ...row, siteName: check.siteName };
  });

  app.post("/clock-out", async (req) => {
    const body = parse(clockInSchema, req.body ?? {});
    const open = await openEntry(req.user.sub);
    if (!open) throw new HttpError(409, "Not clocked in");
    const check = await checkPunch(req.user.companyId, (await locationPolicies(req.user.companyId)).clockOut, body, "out");
    const [row] = await db
      .update(timeEntries)
      .set({
        clockOut: new Date(),
        clockOutLat: body.lat,
        clockOutLng: body.lng,
        clockOutAccuracy: body.accuracy,
        clockOutSiteId: check.siteId,
        clockOutDistance: check.distance,
        clockOutFlag: check.flag,
        note: body.note ?? open.note,
      })
      .where(eq(timeEntries.id, open.id))
      .returning();
    await accruePto(req.user.companyId, req.user.sub, entryHours(row));
    await reportOffSite(req, "out", check);
    return { ...row, siteName: check.siteName };
  });

  /** Adds hours-worked based accrual for every accruing policy, respecting caps. */
  async function accruePto(companyId: string, employeeId: string, hoursWorked: number) {
    const policies = await db.select().from(ptoPolicies).where(eq(ptoPolicies.companyId, companyId));
    for (const p of policies.filter((p) => p.accrualRate > 0)) {
      let hours = hoursWorked * p.accrualRate;
      if (p.maxBalanceHours != null) {
        const rows = await db
          .select()
          .from(ptoLedger)
          .where(and(eq(ptoLedger.employeeId, employeeId), eq(ptoLedger.policyId, p.id)));
        const balance = rows.reduce((s, r) => s + r.hours, 0);
        hours = Math.min(hours, Math.max(0, p.maxBalanceHours - balance));
      }
      if (hours > 0) {
        await db.insert(ptoLedger).values({ companyId, employeeId, policyId: p.id, hours, reason: "accrual" });
      }
    }
  }

  /** Entries in a date range. Employees only ever see their own. */
  app.get("/entries", async (req) => {
    const q = parse(rangeQuery, req.query);
    const filters = [eq(timeEntries.companyId, req.user.companyId)];
    const employeeId = isManager(req) ? q.employeeId : req.user.sub;
    if (employeeId) filters.push(eq(timeEntries.employeeId, employeeId));
    if (q.from) filters.push(gte(timeEntries.clockIn, new Date(q.from)));
    if (q.to) filters.push(lt(timeEntries.clockIn, new Date(q.to)));
    const rows = await db
      .select()
      .from(timeEntries)
      .where(and(...filters))
      .orderBy(desc(timeEntries.clockIn))
      .limit(500);
    return withSiteNames(req.user.companyId, rows);
  });

  /** Adds the job site names for each punch. */
  async function withSiteNames<T extends { clockInSiteId: string | null; clockOutSiteId: string | null }>(companyId: string, rows: T[]) {
    const sites = await db.select({ id: jobSites.id, name: jobSites.name }).from(jobSites).where(eq(jobSites.companyId, companyId));
    const name = (id: string | null) => (id ? sites.find((x) => x.id === id)?.name ?? null : null);
    return rows.map((r) => ({ ...r, clockInSite: name(r.clockInSiteId), clockOutSite: name(r.clockOutSiteId) }));
  }

  /** Per-employee regular/overtime totals for a range (timesheet view). */
  app.get("/timesheets", { preHandler: requireRole("manager") }, async (req) => {
    const q = parse(rangeQuery, req.query);
    const filters = [eq(timeEntries.companyId, req.user.companyId)];
    if (q.from) filters.push(gte(timeEntries.clockIn, new Date(q.from)));
    if (q.to) filters.push(lt(timeEntries.clockIn, new Date(q.to)));
    const entries = await db
      .select()
      .from(timeEntries)
      .where(and(...filters));
    const staff = await db.select().from(employees).where(eq(employees.companyId, req.user.companyId));
    const shiftFilters = [eq(shifts.companyId, req.user.companyId), eq(shifts.status, "published")];
    if (q.from) shiftFilters.push(gte(shifts.startsAt, new Date(q.from)));
    if (q.to) shiftFilters.push(lt(shifts.startsAt, new Date(q.to)));
    const scheduled = await db.select().from(shifts).where(and(...shiftFilters));
    return staff
      .map((e) => {
        const mine = entries.filter((t) => t.employeeId === e.id);
        const myShifts = scheduled.filter((s) => s.employeeId === e.id);
        return {
          employeeId: e.id,
          name: `${e.firstName} ${e.lastName}`,
          entries: mine.length,
          unapproved: mine.filter((t) => !t.approvedAt).length,
          flagged: mine.filter((t) => t.clockInFlag || t.clockOutFlag).length,
          clockedIn: mine.some((t) => !t.clockOut),
          ...summarizeHours(mine),
          scheduledHours: Math.round(myShifts.reduce((h, s) => h + entryHours({ clockIn: s.startsAt, clockOut: s.endsAt }), 0) * 100) / 100,
        };
      })
      .filter((r) => r.entries > 0 || r.scheduledHours > 0);
  });

  /** Managers correct missed punches. Editing clears prior approval. */
  app.patch<{ Params: { id: string } }>("/entries/:id", { preHandler: requireRole("manager") }, async (req) => {
    const body = parse(timeEntryEditSchema, req.body);
    if (body.clockOut && new Date(body.clockOut) <= new Date(body.clockIn)) {
      throw new HttpError(400, "Clock-out must be after clock-in");
    }
    const [row] = await db
      .update(timeEntries)
      .set({
        clockIn: new Date(body.clockIn),
        clockOut: body.clockOut ? new Date(body.clockOut) : null,
        note: body.note,
        approvedAt: null,
        approvedById: null,
      })
      .where(and(eq(timeEntries.id, req.params.id), eq(timeEntries.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Time entry");
    return row;
  });

  app.post("/entries/approve", { preHandler: requireRole("manager") }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1) }), req.body);
    const rows = await db
      .update(timeEntries)
      .set({ approvedAt: new Date(), approvedById: req.user.sub })
      .where(and(inArray(timeEntries.id, ids), eq(timeEntries.companyId, req.user.companyId)))
      .returning();
    return { approved: rows.length };
  });

  /** Who is on the clock right now. */
  app.get("/who-is-in", { preHandler: requireRole("manager") }, async (req) => {
    return db
      .select({
        entryId: timeEntries.id,
        employeeId: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        clockIn: timeEntries.clockIn,
        lat: timeEntries.clockInLat,
        lng: timeEntries.clockInLng,
        site: jobSites.name,
        flag: timeEntries.clockInFlag,
        distance: timeEntries.clockInDistance,
      })
      .from(timeEntries)
      .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
      .leftJoin(jobSites, eq(jobSites.id, timeEntries.clockInSiteId))
      .where(and(eq(timeEntries.companyId, req.user.companyId), isNull(timeEntries.clockOut)));
  });
};

export default routes;

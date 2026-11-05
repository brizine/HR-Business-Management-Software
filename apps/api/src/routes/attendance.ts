import type { FastifyPluginAsync } from "fastify";
import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { INACTIVE_STATUSES, attendanceOverrideSchema, attendanceRulesSchema, hasRole } from "@crewdesk/shared";
import { db } from "../db";
import { attendanceOverrides, companies, employees } from "../db/schema";
import { authenticate, isManager, requireRole, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { attendanceRulesFor, computeAttendance } from "../lib/attendance";

/** Attendance comes from the time clock, so the Time clock area controls access. */
const AREA = "time" as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/rules", async (req) => attendanceRulesFor(req.user.companyId));

  /** Owners and admins set the grace periods, alerts and points. */
  app.put("/rules", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const rules = parse(attendanceRulesSchema, req.body);
    rules.thresholds.sort((a, b) => a.points - b.points);
    await db.update(companies).set({ attendanceRules: rules }).where(eq(companies.id, req.user.companyId));
    return rules;
  });

  /** Day-by-day attendance and a summary for each person. Managers: everyone (or one person); others: themselves. */
  app.get<{ Querystring: { from?: string; to?: string; employeeId?: string } }>("/", async (req) => {
    const q = parse(z.object({ from: isoDate, to: isoDate, employeeId: z.string().uuid().optional() }), req.query);
    if (q.to < q.from) throw new HttpError(400, "The end date is before the start date");
    if (Date.parse(q.to) - Date.parse(q.from) > 400 * 86_400_000) throw new HttpError(400, "Pick a range of up to about a year");
    let ids: string[] | null;
    if (!isManager(req, AREA)) ids = [req.user.sub];
    else if (q.employeeId) ids = [q.employeeId];
    else {
      // Everyone active (former staff only if asked for by id).
      const rows = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, req.user.companyId), notInArray(employees.status, INACTIVE_STATUSES)));
      ids = rows.map((r) => r.id);
    }
    const data = await computeAttendance(req.user.companyId, q.from, q.to, ids);
    return { ...data, canEdit: hasRole(roleIn(req, AREA), "admin") };
  });

  /** Owners and admins change a day on the calendar (or put it back to automatic). */
  app.put("/override", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(attendanceOverrideSchema, req.body);
    const [who] = await db.select().from(employees).where(and(eq(employees.id, body.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!who) notFound("Employee");
    if (body.status === null) {
      await db.delete(attendanceOverrides).where(and(eq(attendanceOverrides.employeeId, body.employeeId), eq(attendanceOverrides.date, body.date)));
    } else {
      const values = { companyId: req.user.companyId, employeeId: body.employeeId, date: body.date, status: body.status, note: body.note || null, points: body.points ?? null, setById: req.user.sub, updatedAt: new Date() };
      await db.insert(attendanceOverrides).values(values).onConflictDoUpdate({ target: [attendanceOverrides.employeeId, attendanceOverrides.date], set: values });
    }
    const data = await computeAttendance(req.user.companyId, body.date, body.date, [body.employeeId]);
    return { day: data.people[0]?.days[0] ?? null, points: data.people[0]?.points ?? null };
  });
};

export default routes;

import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { WEEKDAYS, availabilitySchema, describeRule } from "@crewdesk/shared";
import { db } from "../db";
import { availability, employees } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { approversFor, except, notify } from "../lib/notify";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Managers can list everyone's (for the schedule grid); employees see their own. */
  app.get<{ Querystring: { employeeId?: string } }>("/", async (req) => {
    const filters = [eq(availability.companyId, req.user.companyId)];
    if (!isManager(req)) filters.push(eq(availability.employeeId, req.user.sub));
    else if (req.query.employeeId) filters.push(eq(availability.employeeId, req.query.employeeId));
    return db
      .select()
      .from(availability)
      .where(and(...filters))
      .orderBy(asc(availability.weekday), asc(availability.startTime));
  });

  /** Replaces one person's whole set of rules. Managers may update anyone's (e.g. after a phone call). */
  app.put<{ Querystring: { employeeId?: string } }>("/", async (req) => {
    const { rules } = parse(availabilitySchema, req.body);
    const employeeId = req.query.employeeId ?? req.user.sub;
    if (employeeId !== req.user.sub && !isManager(req)) throw new HttpError(403, "You can only change your own availability");
    const [emp] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, employeeId), eq(employees.companyId, req.user.companyId)));
    if (!emp) notFound("Employee");

    const saved = await db.transaction(async (tx) => {
      await tx.delete(availability).where(eq(availability.employeeId, emp.id));
      if (!rules.length) return [];
      return tx
        .insert(availability)
        .values(rules.map((r) => ({ ...r, companyId: emp.companyId, employeeId: emp.id })))
        .returning();
    });

    if (employeeId === req.user.sub) {
      const summary = saved.length
        ? saved.map((r) => `${WEEKDAYS[r.weekday].slice(0, 3)} ${describeRule(r).toLowerCase()}`).join(", ")
        : "Available any time";
      notify(req.user.companyId, except(await approversFor(req.user.companyId, emp.id), req.user.sub), {
        category: "schedule",
        title: `${emp.firstName} ${emp.lastName} updated their availability`,
        body: `Can't work: ${summary}`.replace("Can't work: Available any time", "Now available any time"),
        link: { screen: "schedule" },
      });
    }
    return saved;
  });
};

export default routes;

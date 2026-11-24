import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, gte, inArray, isNull, notInArray, or } from "drizzle-orm";
import { INACTIVE_STATUSES, crewPeople, crewSchema, type CrewInput } from "@crewdesk/shared";
import { db } from "../db";
import { assets, crewMembers, crews, employees, visitAssignees, visits } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";

const AREA = "customers" as const;

/** Every crew with its lead, members and truck. */
export async function crewList(companyId: string, onlyActive = false) {
  const rows = await db.select({ c: crews, assetName: assets.name }).from(crews).leftJoin(assets, eq(assets.id, crews.assetId))
    .where(and(eq(crews.companyId, companyId), ...(onlyActive ? [eq(crews.active, true)] : []))).orderBy(asc(crews.name));
  const ids = rows.map((r) => r.c.id);
  const members = ids.length ? await db.select({ crewId: crewMembers.crewId, id: employees.id, firstName: employees.firstName, lastName: employees.lastName, title: employees.title, status: employees.status })
    .from(crewMembers).innerJoin(employees, eq(employees.id, crewMembers.employeeId)).where(inArray(crewMembers.crewId, ids)).orderBy(asc(employees.firstName)) : [];
  return rows.map(({ c, assetName }) => {
    const people = members.filter((m) => m.crewId === c.id).map(({ id, firstName, lastName, title, status }) => ({ id, firstName, lastName, title, status }));
    // The lead first.
    people.sort((a, b) => (a.id === c.leadId ? -1 : b.id === c.leadId ? 1 : 0));
    return { ...c, assetName, members: people, memberIds: people.map((p) => p.id) };
  });
}

async function checkPeople(companyId: string, body: CrewInput) {
  const people = crewPeople({ leadId: body.leadId ?? null, memberIds: body.memberIds });
  if (people.length) {
    const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, people), notInArray(employees.status, INACTIVE_STATUSES)));
    if (found.length !== people.length) throw new HttpError(400, "One of the people picked isn't on the team");
  }
  if (body.assetId) {
    const [a] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, body.assetId), eq(assets.companyId, companyId)));
    if (!a) throw new HttpError(400, "That truck or equipment isn't in Fleet");
  }
  return people;
}

/**
 * Crews (like Homeworks'): everyone can see them (they show on work orders); Customers & billing
 * managers add and change them. Changing members can also update the crew's open work orders.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  const manager = { preHandler: requireRole("manager", AREA) };

  app.get<{ Querystring: { all?: string } }>("/", async (req) => crewList(req.user.companyId, req.query.all !== "1"));

  app.post("/", manager, async (req) => {
    const body = parse(crewSchema, req.body);
    const people = await checkPeople(req.user.companyId, body);
    const crew = await db.transaction(async (tx) => {
      const [c] = await tx.insert(crews).values({ companyId: req.user.companyId, name: body.name, color: body.color, leadId: body.leadId ?? null, assetId: body.assetId ?? null, notes: body.notes ?? null, active: body.active, dailyHours: body.dailyHours }).returning();
      if (people.length) await tx.insert(crewMembers).values(people.map((employeeId) => ({ crewId: c.id, employeeId })));
      return c;
    });
    return (await crewList(req.user.companyId)).find((c) => c.id === crew.id);
  });

  app.put<{ Params: { id: string } }>("/:id", manager, async (req) => {
    const body = parse(crewSchema, req.body);
    const { companyId } = req.user;
    const [crew] = await db.select().from(crews).where(and(eq(crews.id, req.params.id), eq(crews.companyId, companyId)));
    if (!crew) notFound("Crew");
    const people = await checkPeople(companyId, body);
    let updated = 0;
    await db.transaction(async (tx) => {
      await tx.update(crews).set({ name: body.name, color: body.color, leadId: body.leadId ?? null, assetId: body.assetId ?? null, notes: body.notes ?? null, active: body.active, dailyHours: body.dailyHours }).where(eq(crews.id, crew.id));
      await tx.delete(crewMembers).where(eq(crewMembers.crewId, crew.id));
      if (people.length) await tx.insert(crewMembers).values(people.map((employeeId) => ({ crewId: crew.id, employeeId })));
      if (body.updateOpenWorkOrders) {
        // The crew's open work orders from today on (and on the waitlist) get the new people.
        const today = await companyToday(companyId);
        const open = await tx.select({ id: visits.id }).from(visits)
          .where(and(eq(visits.companyId, companyId), eq(visits.crewId, crew.id), eq(visits.status, "open"), or(isNull(visits.date), gte(visits.date, today))));
        const ids = open.map((v) => v.id);
        if (ids.length) {
          await tx.delete(visitAssignees).where(inArray(visitAssignees.visitId, ids));
          if (people.length) await tx.insert(visitAssignees).values(ids.flatMap((visitId) => people.map((employeeId) => ({ visitId, employeeId }))));
        }
        updated = ids.length;
      }
    });
    return { ...(await crewList(companyId)).find((c) => c.id === crew.id), workOrdersUpdated: updated };
  });

  /** Deleting a crew leaves its work orders (and their people) as they are. */
  app.delete<{ Params: { id: string } }>("/:id", manager, async (req) => {
    const rows = await db.delete(crews).where(and(eq(crews.id, req.params.id), eq(crews.companyId, req.user.companyId))).returning({ id: crews.id });
    if (!rows.length) notFound("Crew");
    return { ok: true };
  });
};

export default routes;

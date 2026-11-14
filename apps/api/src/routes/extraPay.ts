import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { extraPaySchema } from "@crewdesk/shared";
import { db } from "../db";
import { employees, extraPay, payPeriods } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { notFound, parse } from "../lib/errors";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Extra pay (bonus, commission, reimbursement, other): owners and admins add and remove it;
 * managers can see it, like the rest of someone's pay. It shows up in the pay period its date
 * falls in.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { employeeId?: string; from?: string; to?: string } }>("/", { preHandler: requireRole("manager", "people") }, async (req) => {
    const q = parse(z.object({ employeeId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional() }), req.query);
    const filters = [eq(extraPay.companyId, req.user.companyId)];
    if (q.employeeId) filters.push(eq(extraPay.employeeId, q.employeeId));
    if (q.from) filters.push(gte(extraPay.date, q.from));
    if (q.to) filters.push(lte(extraPay.date, q.to));
    const rows = await db.select().from(extraPay).where(and(...filters)).orderBy(desc(extraPay.date), desc(extraPay.createdAt)).limit(500);
    const people = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(eq(employees.companyId, req.user.companyId));
    const name = (id: string | null) => { const p = people.find((x) => x.id === id); return p ? `${p.firstName} ${p.lastName}` : null; };
    return rows.map((r) => ({ ...r, employeeName: name(r.employeeId), createdBy: name(r.createdById) }));
  });

  app.post("/", { preHandler: requireRole("admin", "payroll") }, async (req) => {
    const body = parse(extraPaySchema, req.body);
    const ids = [...new Set(body.employeeIds)];
    // Everyone must work here. Former staff are allowed (e.g. a final commission or reimbursement).
    const people = await db.select({ id: employees.id }).from(employees)
      .where(and(eq(employees.companyId, req.user.companyId), inArray(employees.id, ids)));
    if (people.length !== ids.length) notFound("Employee");
    const rows = await db.insert(extraPay).values(ids.map((employeeId) => ({
      companyId: req.user.companyId, employeeId, date: body.date, kind: body.kind, amountCents: body.amountCents, note: body.note || null, createdById: req.user.sub,
    }))).returning();
    return { added: rows.length, items: rows, warning: await approvedPeriodFor(req.user.companyId, body.date) };
  });

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin", "payroll") }, async (req) => {
    const [row] = await db.delete(extraPay).where(and(eq(extraPay.id, req.params.id), eq(extraPay.companyId, req.user.companyId))).returning();
    if (!row) notFound("Extra pay");
    return { ok: true, warning: await approvedPeriodFor(req.user.companyId, row.date) };
  });

  /** Approved pay periods keep their saved figures; say so when extra pay is dated inside one. */
  async function approvedPeriodFor(companyId: string, date: string) {
    const [p] = await db.select({ start: payPeriods.periodStart, end: payPeriods.periodEnd }).from(payPeriods)
      .where(and(eq(payPeriods.companyId, companyId), eq(payPeriods.status, "approved"), lte(payPeriods.periodStart, date), gte(payPeriods.periodEnd, date))).limit(1);
    return p ? `The pay period ${p.start} to ${p.end} is already approved and keeps its saved figures, so this isn't in it yet. An admin can reopen that period and approve it again to include it.` : null;
  }
};

export default routes;

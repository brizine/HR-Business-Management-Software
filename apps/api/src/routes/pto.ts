import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { ptoDecisionSchema, ptoPolicySchema, ptoRequestSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { employees, ptoLedger, ptoPolicies, ptoRequests } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

async function balances(companyId: string, employeeId: string) {
  const policies = await db.select().from(ptoPolicies).where(eq(ptoPolicies.companyId, companyId));
  const ledger = await db.select().from(ptoLedger).where(eq(ptoLedger.employeeId, employeeId));
  const pending = await db
    .select()
    .from(ptoRequests)
    .where(and(eq(ptoRequests.employeeId, employeeId), eq(ptoRequests.status, "pending")));
  return policies.map((p) => ({
    policyId: p.id,
    name: p.name,
    balanceHours: round(ledger.filter((l) => l.policyId === p.id).reduce((s, l) => s + l.hours, 0)),
    pendingHours: round(pending.filter((r) => r.policyId === p.id).reduce((s, r) => s + r.hours, 0)),
  }));
}

const round = (n: number) => Math.round(n * 100) / 100;

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/policies", async (req) =>
    db.select().from(ptoPolicies).where(eq(ptoPolicies.companyId, req.user.companyId)),
  );

  app.post("/policies", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(ptoPolicySchema, req.body);
    const [row] = await db
      .insert(ptoPolicies)
      .values({ ...body, companyId: req.user.companyId })
      .returning();
    return row;
  });

  /** Adds (or with negative hours, removes) hours, e.g. the annual grant or a correction. */
  app.post("/adjustments", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(
      z.object({
        employeeId: z.string().uuid(),
        policyId: z.string().uuid(),
        hours: z.number(),
        reason: z.string().default("adjustment"),
      }),
      req.body,
    );
    const [emp] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, body.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!emp) notFound("Employee");
    const [row] = await db
      .insert(ptoLedger)
      .values({ ...body, companyId: req.user.companyId })
      .returning();
    return row;
  });

  app.get<{ Querystring: { employeeId?: string } }>("/balances", async (req) => {
    const employeeId = isManager(req) && req.query.employeeId ? req.query.employeeId : req.user.sub;
    return balances(req.user.companyId, employeeId);
  });

  app.get<{ Querystring: { status?: string; mine?: string } }>("/requests", async (req) => {
    const filters = [eq(ptoRequests.companyId, req.user.companyId)];
    if (!isManager(req) || req.query.mine === "true") filters.push(eq(ptoRequests.employeeId, req.user.sub));
    if (req.query.status) filters.push(eq(ptoRequests.status, req.query.status));
    return db
      .select({
        request: ptoRequests,
        employee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName },
        policyName: ptoPolicies.name,
      })
      .from(ptoRequests)
      .innerJoin(employees, eq(employees.id, ptoRequests.employeeId))
      .innerJoin(ptoPolicies, eq(ptoPolicies.id, ptoRequests.policyId))
      .where(and(...filters))
      .orderBy(desc(ptoRequests.createdAt));
  });

  app.post("/requests", async (req) => {
    const body = parse(ptoRequestSchema, req.body);
    if (body.endDate < body.startDate) throw new HttpError(400, "End date must be on or after start date");
    const bal = (await balances(req.user.companyId, req.user.sub)).find((b) => b.policyId === body.policyId);
    if (!bal) notFound("Policy");
    if (body.hours > bal.balanceHours - bal.pendingHours) {
      throw new HttpError(400, `Not enough balance (${round(bal.balanceHours - bal.pendingHours)}h available)`);
    }
    const [row] = await db
      .insert(ptoRequests)
      .values({ ...body, companyId: req.user.companyId, employeeId: req.user.sub })
      .returning();
    return row;
  });

  app.post<{ Params: { id: string } }>("/requests/:id/decide", { preHandler: requireRole("manager") }, async (req) => {
    const body = parse(ptoDecisionSchema, req.body);
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(ptoRequests)
        .where(and(eq(ptoRequests.id, req.params.id), eq(ptoRequests.companyId, req.user.companyId)));
      if (!existing) notFound("Request");
      if (existing.status !== "pending") throw new HttpError(409, "Request already decided");
      if (existing.employeeId === req.user.sub && req.user.role !== "owner") {
        throw new HttpError(403, "You cannot approve your own request");
      }
      const [row] = await tx
        .update(ptoRequests)
        .set({ status: body.status, decisionNote: body.note, decidedById: req.user.sub, decidedAt: new Date() })
        .where(eq(ptoRequests.id, existing.id))
        .returning();
      if (body.status === "approved") {
        await tx.insert(ptoLedger).values({
          companyId: existing.companyId,
          employeeId: existing.employeeId,
          policyId: existing.policyId,
          hours: -existing.hours,
          reason: "time off taken",
          requestId: existing.id,
        });
      }
      return row;
    });
  });

  app.post<{ Params: { id: string } }>("/requests/:id/cancel", async (req) => {
    const [row] = await db
      .update(ptoRequests)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(ptoRequests.id, req.params.id),
          eq(ptoRequests.employeeId, req.user.sub),
          eq(ptoRequests.status, "pending"),
        ),
      )
      .returning();
    if (!row) notFound("Pending request");
    return row;
  });

  /** Approved time off overlapping a date range, for the team calendar. */
  app.get<{ Querystring: { from: string; to: string } }>("/calendar", async (req) => {
    const rows = await db
      .select({
        id: ptoRequests.id,
        startDate: ptoRequests.startDate,
        endDate: ptoRequests.endDate,
        firstName: employees.firstName,
        lastName: employees.lastName,
        policyName: ptoPolicies.name,
      })
      .from(ptoRequests)
      .innerJoin(employees, eq(employees.id, ptoRequests.employeeId))
      .innerJoin(ptoPolicies, eq(ptoPolicies.id, ptoRequests.policyId))
      .where(and(eq(ptoRequests.companyId, req.user.companyId), eq(ptoRequests.status, "approved")));
    const { from, to } = req.query;
    return rows.filter((r) => (!to || r.startDate <= to) && (!from || r.endDate >= from));
  });
};

export default routes;

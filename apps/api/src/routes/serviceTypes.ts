import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { serviceTypeSchema } from "@crewdesk/shared";
import { db } from "../db";
import { serviceTypes } from "../db/schema";
import { companyToday, materialSummary, serviceProductLines } from "../lib/productCosts";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";

const AREA = "customers" as const;

/** The services price list. Managers in Customers & billing read it; admins change it. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  app.get<{ Querystring: { all?: string } }>("/", async (req) => {
    const where = [eq(serviceTypes.companyId, req.user.companyId)];
    if (req.query.all !== "1") where.push(eq(serviceTypes.active, true));
    const rows = await db.select().from(serviceTypes).where(and(...where)).orderBy(asc(serviceTypes.sortOrder), asc(serviceTypes.name));
    const lines = await serviceProductLines(rows.map((r) => r.id), await companyToday(req.user.companyId));
    // Each service with the products it applies and what they cost per 1,000 sq ft today.
    return rows.map((r) => ({
      ...r,
      products: (lines.get(r.id) ?? []).map((l) => ({
        id: l.id, productId: l.productId, productRateId: l.productRateId, startDate: l.startDate, endDate: l.endDate,
        productName: l.productName, rateName: l.rateName, amountPer1000: l.amountPer1000, unit: l.unit, costPer1000Cents: l.costPer1000Cents, applies: l.applies,
      })),
      ...materialSummary(lines.get(r.id)),
    }));
  });

  app.post("/", admin, async (req) => {
    // The application site is set in Chemical Tracking, not on the price list.
    const { applicationSite: _site, ...body } = parse(serviceTypeSchema, req.body);
    const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${serviceTypes.sortOrder}), -1)::int` }).from(serviceTypes).where(eq(serviceTypes.companyId, req.user.companyId));
    const [row] = await db.insert(serviceTypes).values({ ...body, companyId: req.user.companyId, sortOrder: n + 1 }).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const { applicationSite: _site, ...body } = parse(serviceTypeSchema, req.body);
    const [row] = await db.update(serviceTypes).set(body).where(and(eq(serviceTypes.id, req.params.id), eq(serviceTypes.companyId, req.user.companyId))).returning();
    if (!row) throw new HttpError(404, "Service not found");
    return row;
  });

  app.put("/order", admin, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(500) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.update(serviceTypes).set({ sortOrder: i }).where(and(eq(serviceTypes.id, id), eq(serviceTypes.companyId, req.user.companyId)));
      }
    });
    return { ok: true };
  });
};

export default routes;

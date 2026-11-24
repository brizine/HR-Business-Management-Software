import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { serviceProductsSchema, serviceTypeSchema } from "@crewdesk/shared";
import { db } from "../db";
import { productRates, products, serviceProducts, serviceTypes } from "../db/schema";
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

  /** Sets the products a service applies (the list sent replaces the one before). */
  app.put<{ Params: { id: string } }>("/:id/products", admin, async (req) => {
    const { products: links } = parse(serviceProductsSchema, req.body);
    const [svc] = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.id, req.params.id), eq(serviceTypes.companyId, req.user.companyId)));
    if (!svc) throw new HttpError(404, "Service not found");
    const rateIds = [...new Set(links.map((l) => l.productRateId))];
    const found = rateIds.length
      ? await db.select({ rateId: productRates.id, productId: productRates.productId }).from(productRates)
        .innerJoin(products, eq(products.id, productRates.productId))
        .where(and(inArray(productRates.id, rateIds), eq(products.companyId, req.user.companyId)))
      : [];
    for (const l of links) {
      if (!found.some((f) => f.rateId === l.productRateId && f.productId === l.productId)) throw new HttpError(400, "Pick one of the product's own rates");
    }
    await db.transaction(async (tx) => {
      await tx.delete(serviceProducts).where(eq(serviceProducts.serviceTypeId, svc.id));
      if (links.length) await tx.insert(serviceProducts).values(links.map((l, i) => ({ ...l, serviceTypeId: svc.id, sortOrder: i })));
    });
    return { ok: true };
  });

  app.post("/", admin, async (req) => {
    const body = parse(serviceTypeSchema, req.body);
    const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${serviceTypes.sortOrder}), -1)::int` }).from(serviceTypes).where(eq(serviceTypes.companyId, req.user.companyId));
    const [row] = await db.insert(serviceTypes).values({ ...body, companyId: req.user.companyId, sortOrder: n + 1 }).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const body = parse(serviceTypeSchema, req.body);
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

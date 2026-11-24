import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { applicationMethodSchema, hasRole, serviceProductsSchema, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { applicationMethods, chemicalAccess, employees, productRates, products, serviceProducts, serviceTypes, visitProducts } from "../db/schema";
import { authenticate } from "../lib/auth";
import { requireAdmin, requireChemicalAccess } from "../lib/chemicalAccess";
import { HttpError, parse } from "../lib/errors";
import { companyToday, materialSummary, serviceProductLines } from "../lib/productCosts";
import { methodsFor } from "../lib/techChemicals";

/**
 * Chemical Tracking (Resources): application methods, which services apply which products and
 * where, and who can use it. Admins and the people they add only. Kept apart from the Spray Mix
 * Calculator, where any tech can change a rate.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireChemicalAccess);
  const admin = { preHandler: requireAdmin };

  // ---- Application methods ----

  app.get("/methods", async (req) => {
    const rows = await methodsFor(req.user.companyId, db, { all: true });
    const used = rows.length ? await db.select({ id: visitProducts.applicationMethodId, n: count() }).from(visitProducts)
      .where(inArray(visitProducts.applicationMethodId, rows.map((r) => r.id))).groupBy(visitProducts.applicationMethodId) : [];
    return rows.map((r) => ({ ...r, timesUsed: used.find((u) => u.id === r.id)?.n ?? 0 }));
  });
  app.post("/methods", async (req) => {
    const body = parse(applicationMethodSchema, req.body);
    await methodsFor(req.user.companyId);
    const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${applicationMethods.sortOrder}), -1)::int` }).from(applicationMethods).where(eq(applicationMethods.companyId, req.user.companyId));
    const [row] = await db.insert(applicationMethods).values({ ...body, companyId: req.user.companyId, sortOrder: n + 1, updatedById: req.user.sub }).returning();
    return row;
  });
  app.put<{ Params: { id: string } }>("/methods/:id", async (req) => {
    const body = parse(applicationMethodSchema, req.body);
    const [row] = await db.transaction(async (tx) => {
      const r = await tx.update(applicationMethods).set({ ...body, updatedById: req.user.sub, updatedAt: new Date() })
        .where(and(eq(applicationMethods.id, req.params.id), eq(applicationMethods.companyId, req.user.companyId))).returning();
      // Rates for this method follow its spray volume. Records already saved keep theirs.
      if (r[0]) await tx.update(productRates).set({ carrierGalPer1000: body.galPer1000, method: body.galPer1000 == null ? "push_spreader" : "truck_spray" }).where(eq(productRates.applicationMethodId, r[0].id));
      return r;
    });
    if (!row) throw new HttpError(404, "Method not found");
    return row;
  });
  app.put("/methods/order", async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(100) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(applicationMethods).set({ sortOrder: i }).where(and(eq(applicationMethods.id, id), eq(applicationMethods.companyId, req.user.companyId)));
    });
    return { ok: true };
  });
  /** Removes a method nobody has used; one that's on a record or a rate can only be turned off. */
  app.delete<{ Params: { id: string } }>("/methods/:id", async (req) => {
    const [m] = await db.select().from(applicationMethods).where(and(eq(applicationMethods.id, req.params.id), eq(applicationMethods.companyId, req.user.companyId)));
    if (!m) throw new HttpError(404, "Method not found");
    const [{ n: onRecords }] = await db.select({ n: count() }).from(visitProducts).where(eq(visitProducts.applicationMethodId, m.id));
    const [{ n: onRates }] = await db.select({ n: count() }).from(productRates).where(eq(productRates.applicationMethodId, m.id));
    if (onRecords || onRates) throw new HttpError(409, onRecords ? "This method is on saved applications. Turn it off instead." : "Products have rates for this method. Remove those rates or turn the method off.");
    await db.delete(applicationMethods).where(eq(applicationMethods.id, m.id));
    return { ok: true };
  });

  // ---- Services: where each is applied and the products it uses ----

  app.get("/services", async (req) => {
    const rows = await db.select().from(serviceTypes).where(eq(serviceTypes.companyId, req.user.companyId)).orderBy(asc(serviceTypes.sortOrder), asc(serviceTypes.name));
    const lines = await serviceProductLines(rows.map((r) => r.id), await companyToday(req.user.companyId));
    return rows.map((r) => ({
      id: r.id, name: r.name, active: r.active, chemical: r.chemical, applicationSite: r.applicationSite,
      products: (lines.get(r.id) ?? []).map((l) => ({
        id: l.id, productId: l.productId, productRateId: l.productRateId, startDate: l.startDate, endDate: l.endDate,
        productName: l.productName, rateName: l.rateName, amountPer1000: l.amountPer1000, unit: l.unit, costPer1000Cents: l.costPer1000Cents, applies: l.applies,
        methodName: l.applicationMethodName,
      })),
      ...materialSummary(lines.get(r.id)),
    }));
  });
  app.put<{ Params: { id: string } }>("/services/:id", async (req) => {
    const body = parse(z.object({ applicationSite: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(200).nullable()) }), req.body);
    const [row] = await db.update(serviceTypes).set({ applicationSite: body.applicationSite })
      .where(and(eq(serviceTypes.id, req.params.id), eq(serviceTypes.companyId, req.user.companyId))).returning({ id: serviceTypes.id });
    if (!row) throw new HttpError(404, "Service not found");
    return { ok: true };
  });
  /** Sets the products a service applies (the list sent replaces the one before). */
  app.put<{ Params: { id: string } }>("/services/:id/products", async (req) => {
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

  // ---- Access: admins always; admins add anyone else ----

  app.get("/access", async (req) => {
    const rows = await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, role: employees.role, listed: chemicalAccess.employeeId })
      .from(employees).leftJoin(chemicalAccess, eq(chemicalAccess.employeeId, employees.id))
      .where(and(eq(employees.companyId, req.user.companyId), eq(employees.status, "active"))).orderBy(asc(employees.firstName), asc(employees.lastName));
    return {
      canManage: hasRole(req.user.role as Role, "admin"),
      people: rows.map((r) => {
        const isAdmin = hasRole(r.role as Role, "admin");
        return { id: r.id, name: `${r.first} ${r.last}`.trim(), role: r.role, admin: isAdmin, listed: !!r.listed, access: isAdmin || !!r.listed };
      }),
    };
  });
  app.put<{ Params: { employeeId: string } }>("/access/:employeeId", admin, async (req) => {
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, req.params.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!e) throw new HttpError(404, "Employee not found");
    await db.insert(chemicalAccess).values({ employeeId: e.id, companyId: req.user.companyId, addedById: req.user.sub }).onConflictDoNothing();
    return { ok: true };
  });
  app.delete<{ Params: { employeeId: string } }>("/access/:employeeId", admin, async (req) => {
    await db.delete(chemicalAccess).where(and(eq(chemicalAccess.employeeId, req.params.employeeId), eq(chemicalAccess.companyId, req.user.companyId)));
    return { ok: true };
  });
};

export default routes;

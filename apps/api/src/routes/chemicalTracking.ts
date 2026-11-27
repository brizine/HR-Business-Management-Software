import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { applicationMethodSchema, chemicalMixSchema, hasRole, type ChemicalMixInput, noticeSettings, noticeSettingsSchema, serviceProductsSchema, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { applicationMethods, applicationRecords, applicatorCerts, chemicalAccess, chemicalMixItems, chemicalMixes, serviceMixes, chemicalNotices, companies, employees, productRates, products, serviceProducts, serviceTypes, visitProducts } from "../db/schema";
import { authenticate } from "../lib/auth";
import { requireAdmin, requireChemicalAccess } from "../lib/chemicalAccess";
import { HttpError, parse } from "../lib/errors";
import { companyToday, materialSummary, serviceProductLines } from "../lib/productCosts";
import { methodsFor } from "../lib/techChemicals";
import { loadSheet } from "../lib/loadSheet";
import { buildNotice, deliverNotice, noticeContacts, noticeCounts, noticeRows } from "../lib/chemicalNotices";
import { emailTransport } from "../lib/channels";
import { textingConfig } from "../lib/texting";

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

  // ---- Mixes: products that go in one tank together ----

  const mixRows = async (companyId: string) => {
    const mixes = await db.select({ m: chemicalMixes, methodName: applicationMethods.name }).from(chemicalMixes)
      .leftJoin(applicationMethods, eq(applicationMethods.id, chemicalMixes.applicationMethodId))
      .where(eq(chemicalMixes.companyId, companyId)).orderBy(asc(chemicalMixes.sortOrder), asc(chemicalMixes.name));
    const items = mixes.length ? await db.select({ i: chemicalMixItems, name: products.name, unit: products.useUnit, active: products.active }).from(chemicalMixItems)
      .innerJoin(products, eq(products.id, chemicalMixItems.productId)).where(inArray(chemicalMixItems.mixId, mixes.map((x) => x.m.id))).orderBy(asc(chemicalMixItems.sortOrder)) : [];
    return mixes.map(({ m, methodName }) => ({
      ...m, methodName,
      items: items.filter((x) => x.i.mixId === m.id).map((x) => ({ productId: x.i.productId, productName: x.name, unit: x.unit, ratePer1000: x.i.ratePer1000, productActive: x.active })),
    }));
  };
  /** Checks a mix's method and products are this company's, and the rates are within each label's maximum. */
  const checkMix = async (companyId: string, body: ChemicalMixInput) => {
    const [m] = await db.select({ id: applicationMethods.id }).from(applicationMethods).where(and(eq(applicationMethods.id, body.applicationMethodId), eq(applicationMethods.companyId, companyId)));
    if (!m) throw new HttpError(400, "Pick one of your application methods");
    const ids = body.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "A product is in the mix twice");
    const ps = await db.select().from(products).where(and(inArray(products.id, ids), eq(products.companyId, companyId)));
    if (ps.length !== ids.length) throw new HttpError(400, "One of the products isn't in your product list");
    for (const i of body.items) {
      const p = ps.find((x) => x.id === i.productId)!;
      if (p.labelMaxPer1000 != null && i.ratePer1000 > p.labelMaxPer1000) throw new HttpError(400, `${p.name}: ${i.ratePer1000} is more than the label allows (${p.labelMaxPer1000} per 1,000 sq ft)`);
    }
  };
  const saveItems = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], mixId: string, items: ChemicalMixInput["items"]) => {
    await tx.delete(chemicalMixItems).where(eq(chemicalMixItems.mixId, mixId));
    await tx.insert(chemicalMixItems).values(items.map((i, n) => ({ mixId, productId: i.productId, ratePer1000: i.ratePer1000, sortOrder: n })));
  };

  app.get("/mixes", async (req) => mixRows(req.user.companyId));
  app.post("/mixes", async (req) => {
    const body = parse(chemicalMixSchema, req.body);
    await checkMix(req.user.companyId, body);
    const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${chemicalMixes.sortOrder}), -1)::int` }).from(chemicalMixes).where(eq(chemicalMixes.companyId, req.user.companyId));
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(chemicalMixes).values({ companyId: req.user.companyId, name: body.name, applicationMethodId: body.applicationMethodId, notes: body.notes ?? null, active: body.active, sortOrder: n + 1, updatedById: req.user.sub }).returning();
      await saveItems(tx, row.id, body.items);
      return row.id;
    });
    return (await mixRows(req.user.companyId)).find((m) => m.id === id);
  });
  app.put<{ Params: { id: string } }>("/mixes/:id", async (req) => {
    const body = parse(chemicalMixSchema, req.body);
    await checkMix(req.user.companyId, body);
    const ok = await db.transaction(async (tx) => {
      const [row] = await tx.update(chemicalMixes).set({ name: body.name, applicationMethodId: body.applicationMethodId, notes: body.notes ?? null, active: body.active, updatedById: req.user.sub, updatedAt: new Date() })
        .where(and(eq(chemicalMixes.id, req.params.id), eq(chemicalMixes.companyId, req.user.companyId))).returning();
      if (!row) return false;
      await saveItems(tx, row.id, body.items);
      return true;
    });
    if (!ok) throw new HttpError(404, "Mix not found");
    return (await mixRows(req.user.companyId)).find((m) => m.id === req.params.id);
  });
  /** Mixes can be removed once no service uses them: records keep each product (and the mix's name) as applied. */
  app.delete<{ Params: { id: string } }>("/mixes/:id", async (req) => {
    const onServices = await db.select({ name: serviceTypes.name }).from(serviceMixes).innerJoin(serviceTypes, eq(serviceTypes.id, serviceMixes.serviceTypeId))
      .where(and(eq(serviceMixes.mixId, req.params.id), eq(serviceTypes.companyId, req.user.companyId)));
    if (onServices.length) throw new HttpError(409, `This mix is on ${onServices.map((x) => x.name).join(", ")}. Take it off the service first, or turn the mix off.`);
    const rows = await db.delete(chemicalMixes).where(and(eq(chemicalMixes.id, req.params.id), eq(chemicalMixes.companyId, req.user.companyId))).returning({ id: chemicalMixes.id });
    if (!rows.length) throw new HttpError(404, "Mix not found");
    return { ok: true };
  });

  // ---- Services: where each is applied and the products it uses ----

  app.get("/services", async (req) => {
    const rows = await db.select().from(serviceTypes).where(eq(serviceTypes.companyId, req.user.companyId)).orderBy(asc(serviceTypes.sortOrder), asc(serviceTypes.name));
    const lines = await serviceProductLines(rows.map((r) => r.id), await companyToday(req.user.companyId));
    const mixState = await db.select({ id: chemicalMixes.id, active: chemicalMixes.active }).from(chemicalMixes).where(eq(chemicalMixes.companyId, req.user.companyId));
    return rows.map((r) => ({
      id: r.id, name: r.name, active: r.active, chemical: r.chemical, applicationSite: r.applicationSite,
      // Mixes on the service: one entry each, with its products and today's cost.
      mixes: [...new Set((lines.get(r.id) ?? []).filter((l) => l.serviceMixId).map((l) => l.serviceMixId!))].map((smId) => {
        const ls = (lines.get(r.id) ?? []).filter((l) => l.serviceMixId === smId);
        const f = ls[0];
        return {
          id: smId, mixId: f.mixId!, mixName: f.mixName!, methodName: f.applicationMethodName, startDate: f.startDate, endDate: f.endDate, applies: f.applies,
          mixActive: mixState.find((m) => m.id === f.mixId)?.active ?? true,
          costPer1000Cents: ls.some((l) => l.costPer1000Cents == null) ? null : ls.reduce((s, l) => s + (l.costPer1000Cents ?? 0), 0),
          items: ls.map((l) => ({ productId: l.productId, productName: l.productName, amountPer1000: l.amountPer1000, unit: l.unit })),
        };
      }),
      products: (lines.get(r.id) ?? []).filter((l) => !l.serviceMixId).map((l) => ({
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

  /** Sets the mixes a service applies (the list sent replaces the one before). */
  app.put<{ Params: { id: string } }>("/services/:id/mixes", async (req) => {
    const { mixes } = parse(z.object({ mixes: z.array(z.object({
      mixId: z.string().uuid(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    })).max(20) }), req.body);
    const [svc] = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.id, req.params.id), eq(serviceTypes.companyId, req.user.companyId)));
    if (!svc) throw new HttpError(404, "Service not found");
    const ids = [...new Set(mixes.map((m) => m.mixId))];
    const found = ids.length ? await db.select({ id: chemicalMixes.id }).from(chemicalMixes).where(and(inArray(chemicalMixes.id, ids), eq(chemicalMixes.companyId, req.user.companyId))) : [];
    if (found.length !== ids.length) throw new HttpError(400, "Pick one of your mixes");
    if (mixes.some((m) => m.startDate && m.endDate && m.endDate < m.startDate)) throw new HttpError(400, "The end date is before the start date");
    await db.transaction(async (tx) => {
      await tx.delete(serviceMixes).where(eq(serviceMixes.serviceTypeId, svc.id));
      if (mixes.length) await tx.insert(serviceMixes).values(mixes.map((m, i) => ({ serviceTypeId: svc.id, mixId: m.mixId, startDate: m.startDate ?? null, endDate: m.endDate ?? null, sortOrder: i })));
    });
    return { ok: true };
  });

  // ---- Load sheet ----

  app.get<{ Querystring: { date?: string; by?: string } }>("/load-sheet", async (req) => {
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), by: z.enum(["tech", "truck", "day"]).default("tech") }), req.query);
    return loadSheet(req.user.companyId, q.date ?? (await companyToday(req.user.companyId)), q.by);
  });

  // ---- Customer notices ----

  app.get("/notice-settings", async (req) => {
    const [co] = await db.select({ s: companies.chemicalNotices }).from(companies).where(eq(companies.id, req.user.companyId));
    return { ...noticeSettings(co?.s), emailReady: !!emailTransport(), textingReady: !!(await textingConfig(req.user.companyId)) };
  });
  app.put("/notice-settings", async (req) => {
    const body = parse(noticeSettingsSchema, req.body);
    await db.update(companies).set({ chemicalNotices: body }).where(eq(companies.id, req.user.companyId));
    return body;
  });
  app.get<{ Querystring: { status?: string; recordId?: string } }>("/notices", async (req) => noticeRows(req.user.companyId, { status: req.query.status, recordId: req.query.recordId }));
  app.get<{ Params: { id: string } }>("/notices/:id", async (req) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, "Notice not found");
    const [n] = await noticeRows(req.user.companyId, { id: req.params.id, limit: 1 });
    if (!n) throw new HttpError(404, "Notice not found");
    return n;
  });
  /**
   * A notice for a record now: email or text it, or queue it to print (any record, any time).
   * Emailing or texting it also reaches the property's contacts who get its service notifications
   * and haven't had this one yet.
   */
  app.post<{ Params: { recordId: string } }>("/records/:recordId/notice", async (req) => {
    const { channel } = parse(z.object({ channel: z.enum(["email", "text", "printed"]) }), req.body);
    const [r] = await db.select({ id: applicationRecords.id }).from(applicationRecords).where(and(eq(applicationRecords.id, req.params.recordId), eq(applicationRecords.companyId, req.user.companyId)));
    if (!r) throw new HttpError(404, "Record not found");
    const row = await deliverNotice(r.id, channel, req.user.sub);
    if (channel !== "printed") await noticeContacts(r.id, req.user.sub);
    return row;
  });
  /** What a record's notice would say (for printing one that wasn't queued). */
  app.get<{ Params: { recordId: string } }>("/records/:recordId/notice-preview", async (req) => {
    const [r] = await db.select({ id: applicationRecords.id }).from(applicationRecords).where(and(eq(applicationRecords.id, req.params.recordId), eq(applicationRecords.companyId, req.user.companyId)));
    if (!r) throw new HttpError(404, "Record not found");
    const n = await buildNotice(r.id);
    return { subject: n.subject, body: n.body, text: n.text, company: n.company, customerName: n.record.customerName, siteAddress: n.record.siteAddress };
  });
  /** Printed notices: mark them printed (or back to print). */
  app.post("/notices/printed", async (req) => {
    const { ids, printed } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), printed: z.boolean().default(true) }), req.body);
    const rows = await db.update(chemicalNotices).set(printed ? { status: "printed", printedAt: new Date() } : { status: "to_print", printedAt: null })
      .where(and(inArray(chemicalNotices.id, ids), eq(chemicalNotices.companyId, req.user.companyId), eq(chemicalNotices.channel, "printed"))).returning({ id: chemicalNotices.id });
    return { updated: rows.length };
  });

  // ---- What needs attention (My Day) ----

  app.get("/attention", async (req) => {
    const companyId = req.user.companyId;
    const today = await companyToday(companyId);
    const soon = new Date(Date.parse(`${today}T12:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10);
    const records = await db.select({ id: applicationRecords.id, appliedOn: applicationRecords.appliedOn, customerName: applicationRecords.customerName, issues: applicationRecords.issues })
      .from(applicationRecords)
      .where(and(eq(applicationRecords.companyId, companyId), isNull(applicationRecords.voidedAt), sql`jsonb_array_length(${applicationRecords.issues}) > 0`))
      .orderBy(desc(applicationRecords.appliedOn)).limit(200);
    const certs = await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, certNo: applicatorCerts.certNo, expiresOn: applicatorCerts.expiresOn })
      .from(applicatorCerts).innerJoin(employees, eq(employees.id, applicatorCerts.employeeId))
      .where(and(eq(applicatorCerts.companyId, companyId), eq(employees.status, "active"), lte(applicatorCerts.expiresOn, soon))).orderBy(asc(applicatorCerts.expiresOn));
    return {
      records: { count: records.length, rows: records.slice(0, 5) },
      certs: certs.map((c) => ({ id: c.id, name: `${c.first} ${c.last}`.trim(), certNo: c.certNo, expiresOn: c.expiresOn, expired: c.expiresOn < today })),
      notices: await noticeCounts(companyId),
    };
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

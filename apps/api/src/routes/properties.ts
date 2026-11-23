import type { FastifyPluginAsync } from "fastify";
import { aliasedTable, and, arrayContains, arrayOverlaps, asc, desc, eq, ilike, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { assignmentSchema, cancelSchema, customerName, endAssignmentSchema, lawnTotal, propertyCreateSchema, propertySchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { newRecordCustom, updatedCustom } from "../lib/customFields";
import { cancellationReasons, cancellations, customers, measurements, properties, propertyAssignments } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { assignCustomer, checkTags, customerInCompany, propertyInCompany, recordTagChanges, type Tx } from "../lib/crm";
import { idList } from "./customers";

const AREA = "customers" as const;

type ListQuery = { q?: string; status?: string; mapCode?: string; tags?: string; anyTags?: string; notTags?: string; customerTags?: string; limit?: string; offset?: string };

/** The lawn sizes from a saved Property Measure (checked to be the company's). */
async function measurementSizes(tx: Tx, companyId: string, measurementId: string) {
  const [m] = await tx.select().from(measurements).where(and(eq(measurements.id, measurementId), eq(measurements.companyId, companyId)));
  if (!m) throw new HttpError(400, "That measurement doesn't exist");
  return { frontSqFt: m.frontSqFt, backSqFt: m.backSqFt, lawnSqFt: m.netSqFt, lat: m.pinLat ?? m.lat, lng: m.pinLng ?? m.lng };
}

/**
 * Properties: service addresses, each assigned to one bill-to customer plus any residents. Lawn
 * size can come from a saved Property Measure.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  const billTo = aliasedTable(customers, "bill_to");
  const billToJoin = and(eq(propertyAssignments.propertyId, properties.id), eq(propertyAssignments.role, "bill_to"), isNull(propertyAssignments.endDate));

  app.get<{ Querystring: ListQuery }>("/", async (req) => {
    const { companyId } = req.user;
    const where: SQL[] = [eq(properties.companyId, companyId)];
    const status = req.query.status ?? "active";
    if (status === "active" || status === "cancelled") where.push(eq(properties.status, status));
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (q) {
      const like = `%${q}%`;
      where.push(or(
        ilike(properties.street, like), ilike(properties.city, like), ilike(properties.zip, like), ilike(properties.name, like),
        ilike(billTo.lastName, like), ilike(billTo.firstName, like), ilike(billTo.companyName, like),
      )!);
    }
    const mc = (req.query.mapCode ?? "").trim().slice(0, 20);
    if (mc === "none") where.push(isNull(properties.mapCode));
    else if (mc) where.push(ilike(properties.mapCode, `${mc.replace(/[%_]/g, "")}%`));
    const all = idList(req.query.tags), any = idList(req.query.anyTags), none = idList(req.query.notTags), ctags = idList(req.query.customerTags);
    if (all.length) where.push(arrayContains(properties.tagIds, all));
    if (any.length) where.push(arrayOverlaps(properties.tagIds, any));
    if (none.length) where.push(not(arrayOverlaps(properties.tagIds, none)));
    if (ctags.length) where.push(arrayContains(billTo.tagIds, ctags));

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const base = db.select({
      id: properties.id, name: properties.name, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip,
      lat: properties.lat, lng: properties.lng, mapCode: properties.mapCode, lawnSqFt: properties.lawnSqFt, status: properties.status,
      tagIds: properties.tagIds, sample: properties.sample,
      billToId: billTo.id, billToKind: billTo.kind, billToFirst: billTo.firstName, billToLast: billTo.lastName, billToCompany: billTo.companyName,
    })
      .from(properties)
      .leftJoin(propertyAssignments, billToJoin)
      .leftJoin(billTo, eq(billTo.id, propertyAssignments.customerId))
      .where(and(...where));
    const rows = await base.orderBy(asc(properties.street)).limit(limit).offset(offset);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(properties)
      .leftJoin(propertyAssignments, billToJoin).leftJoin(billTo, eq(billTo.id, propertyAssignments.customerId)).where(and(...where));
    return {
      total,
      rows: rows.map(({ billToId, billToKind, billToFirst, billToLast, billToCompany, ...r }) => ({
        ...r,
        billTo: billToId ? { id: billToId, name: customerName({ kind: billToKind, firstName: billToFirst, lastName: billToLast, companyName: billToCompany }) } : null,
      })),
    };
  });

  app.post("/", async (req) => {
    const { billToCustomerId, residentIds, tagIds: tags, ...body } = parse(propertyCreateSchema, req.body);
    const { companyId, sub } = req.user;
    const today = await companyToday(companyId);
    // The bill-to customer's same-named fields can transfer onto the property.
    const [payer] = billToCustomerId ? await db.select({ custom: customers.custom }).from(customers).where(and(eq(customers.id, billToCustomerId), eq(customers.companyId, companyId))) : [];
    const custom = await newRecordCustom(companyId, "property", (req.body as { custom?: unknown })?.custom, [{ target: "customer", values: payer?.custom }]);
    return db.transaction(async (tx) => {
      const tagIds = await checkTags(tx, companyId, tags);
      const sizes = body.measurementId ? await measurementSizes(tx, companyId, body.measurementId) : null;
      const values = { ...body, ...(sizes && body.frontSqFt == null && body.backSqFt == null ? { frontSqFt: sizes.frontSqFt, backSqFt: sizes.backSqFt, lawnSqFt: sizes.lawnSqFt } : {}) };
      if (sizes && values.lat == null) Object.assign(values, { lat: sizes.lat, lng: sizes.lng });
      const [p] = await tx.insert(properties).values({ ...values, custom, lawnSqFt: lawnTotal(values), tagIds, companyId, createdById: sub }).returning();
      await recordTagChanges(tx, { companyId, before: [], after: tagIds, propertyId: p.id, source: "hand", byId: sub });
      if (billToCustomerId) {
        await customerInCompany(tx, companyId, billToCustomerId);
        await assignCustomer(tx, { companyId, propertyId: p.id, customerId: billToCustomerId, role: "bill_to", startDate: today });
      }
      for (const rid of new Set(residentIds)) {
        await customerInCompany(tx, companyId, rid);
        await assignCustomer(tx, { companyId, propertyId: p.id, customerId: rid, role: "resident", startDate: today });
      }
      return p;
    });
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const { companyId } = req.user;
    const p = await propertyInCompany(db, companyId, req.params.id);
    const people = await db
      .select({
        assignmentId: propertyAssignments.id, role: propertyAssignments.role, startDate: propertyAssignments.startDate, endDate: propertyAssignments.endDate,
        customerId: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName,
        email: customers.email, phone: customers.phone, status: customers.status, number: customers.number,
      })
      .from(propertyAssignments)
      .innerJoin(customers, eq(customers.id, propertyAssignments.customerId))
      .where(eq(propertyAssignments.propertyId, p.id))
      .orderBy(sql`${propertyAssignments.endDate} is not null`, asc(propertyAssignments.role), desc(propertyAssignments.startDate));
    const [measurement] = p.measurementId
      ? await db.select({ id: measurements.id, name: measurements.name, netSqFt: measurements.netSqFt, updatedAt: measurements.updatedAt }).from(measurements).where(eq(measurements.id, p.measurementId))
      : [];
    const history = await db.select().from(cancellations).where(eq(cancellations.propertyId, p.id)).orderBy(desc(cancellations.createdAt));
    return {
      ...p,
      assignments: people.map((a) => ({ ...a, name: customerName(a) })),
      measurement: measurement ?? null,
      cancellations: history,
    };
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(propertySchema, req.body);
    const { companyId, sub } = req.user;
    return db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      const tagIds = await checkTags(tx, companyId, body.tagIds, p.tagIds);
      if (body.measurementId && body.measurementId !== p.measurementId) await measurementSizes(tx, companyId, body.measurementId);
      const mapCodeManual = body.mapCode !== (p.mapCode ?? undefined) ? !!body.mapCode : p.mapCodeManual;
      const custom = await updatedCustom(companyId, "property", (req.body as { custom?: unknown })?.custom, p.custom);
      const [u] = await tx.update(properties).set({
        ...body, ...(custom ? { custom } : {}), mapCode: body.mapCode ?? null, mapCodeManual, lawnSqFt: lawnTotal(body), tagIds, updatedAt: new Date(),
      }).where(eq(properties.id, p.id)).returning();
      await recordTagChanges(tx, { companyId, before: p.tagIds, after: tagIds, propertyId: p.id, source: "hand", byId: sub });
      return u;
    });
  });

  /** Links a saved Property Measure and takes its front, back and total lawn size. */
  app.post<{ Params: { id: string } }>("/:id/measurement", async (req) => {
    const { measurementId } = parse(z.object({ measurementId: z.string().uuid() }), req.body);
    const { companyId } = req.user;
    return db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      const s = await measurementSizes(tx, companyId, measurementId);
      const [u] = await tx.update(properties).set({
        measurementId, frontSqFt: s.frontSqFt, backSqFt: s.backSqFt, lawnSqFt: lawnTotal({ frontSqFt: s.frontSqFt, backSqFt: s.backSqFt, lawnSqFt: s.lawnSqFt }),
        lat: p.lat ?? s.lat, lng: p.lng ?? s.lng, updatedAt: new Date(),
      }).where(eq(properties.id, p.id)).returning();
      return u;
    });
  });

  /** Puts a customer on the property as bill-to (replacing the current one) or as a resident. */
  app.post<{ Params: { id: string } }>("/:id/assign", async (req) => {
    const body = parse(assignmentSchema, req.body);
    const { companyId } = req.user;
    const startDate = body.startDate ?? (await companyToday(companyId));
    return db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      await customerInCompany(tx, companyId, body.customerId);
      return assignCustomer(tx, { companyId, propertyId: p.id, customerId: body.customerId, role: body.role, startDate });
    });
  });

  /** Ends someone's time on the property (e.g. a tenant moved out); the record stays as history. */
  app.post<{ Params: { id: string; assignmentId: string } }>("/:id/assignments/:assignmentId/end", async (req) => {
    const body = parse(endAssignmentSchema, req.body);
    const { companyId } = req.user;
    const endDate = body.endDate ?? (await companyToday(companyId));
    const p = await propertyInCompany(db, companyId, req.params.id);
    const [a] = await db.select().from(propertyAssignments).where(and(eq(propertyAssignments.id, req.params.assignmentId), eq(propertyAssignments.propertyId, p.id)));
    if (!a) throw new HttpError(404, "Assignment not found");
    if (a.endDate) throw new HttpError(400, "That has already ended");
    if (endDate < a.startDate) throw new HttpError(400, "The end date is before it started");
    const [u] = await db.update(propertyAssignments).set({ endDate }).where(eq(propertyAssignments.id, a.id)).returning();
    return u;
  });

  app.post<{ Params: { id: string } }>("/:id/cancel", async (req) => {
    const body = parse(cancelSchema, req.body);
    const { companyId, sub } = req.user;
    const effectiveDate = body.effectiveDate ?? (await companyToday(companyId));
    return db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      if (p.status === "cancelled") throw new HttpError(400, "That property is already cancelled");
      const [reason] = await tx.select().from(cancellationReasons).where(and(eq(cancellationReasons.id, body.reasonId), eq(cancellationReasons.companyId, companyId)));
      if (!reason || reason.retired) throw new HttpError(400, "Choose a reason from the list");
      if (reason.commentRequired && !body.comment) throw new HttpError(400, `"${reason.label}" needs a comment`);
      const [bill] = await tx.select({ customerId: propertyAssignments.customerId }).from(propertyAssignments).where(billToJoinFor(p.id));
      await tx.insert(cancellations).values({
        companyId, propertyId: p.id, customerId: bill?.customerId ?? null, reasonId: reason.id, reasonLabel: reason.label, effectiveDate, comment: body.comment ?? null, byId: sub,
      });
      await tx.update(properties).set({ status: "cancelled", updatedAt: new Date() }).where(eq(properties.id, p.id));
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>("/:id/reactivate", async (req) => {
    const { companyId, sub } = req.user;
    return db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      if (p.status !== "cancelled") throw new HttpError(400, "That property isn't cancelled");
      await tx.update(properties).set({ status: "active", updatedAt: new Date() }).where(eq(properties.id, p.id));
      await tx.update(cancellations).set({ reactivatedAt: new Date(), reactivatedById: sub }).where(and(eq(cancellations.propertyId, p.id), isNull(cancellations.reactivatedAt)));
      return { ok: true };
    });
  });

  /** Admins: delete a property nobody was ever assigned to (or a sample); anything else is cancelled instead. */
  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const { companyId } = req.user;
    const p = await propertyInCompany(db, companyId, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(propertyAssignments).where(eq(propertyAssignments.propertyId, p.id));
    if (n > 0 && !p.sample) throw new HttpError(409, "This property has customer history; cancel it instead");
    await db.delete(properties).where(eq(properties.id, p.id));
    return { ok: true };
  });

  /** Quick list of customers matching a name, for the "assign a customer" picker. */
  app.get<{ Querystring: { q?: string } }>("/customer-search", async (req) => {
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (!q) return [];
    const like = `%${q}%`;
    const rows = await db.select({ id: customers.id, number: customers.number, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, status: customers.status, email: customers.email })
      .from(customers)
      .where(and(eq(customers.companyId, req.user.companyId), inArray(customers.status, ["active", "lead"]), or(
        ilike(customers.firstName, like), ilike(customers.lastName, like), ilike(customers.companyName, like), ilike(customers.email, like),
        sql`(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')) ilike ${like}`,
      )))
      .orderBy(asc(customers.lastName))
      .limit(20);
    return rows.map((r) => ({ ...r, name: customerName(r) }));
  });
};

const billToJoinFor = (propertyId: string) => and(eq(propertyAssignments.propertyId, propertyId), eq(propertyAssignments.role, "bill_to"), isNull(propertyAssignments.endDate));

export default routes;

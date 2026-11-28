import type { FastifyPluginAsync } from "fastify";
import { aliasedTable, and, arrayContains, arrayOverlaps, asc, desc, eq, ilike, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { NOTICE_CHANNELS, assignmentSchema, cancelSchema, customerName, endAssignmentSchema, formatAddress, lawnTotal, propertyContactSchema, propertyCreateSchema, propertySchema, splitPropertyValues, type CustomValues } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { fieldsFor, newRecordCustom, propertyColumnChanges, updatedCustom } from "../lib/customFields";
import { contactColumns } from "../lib/propertyContacts";
import { locateAddress } from "../lib/dispatch";
import { assignMapCode, placeProperty } from "../lib/mapCodes";
import { cancellationReasons, cancellations, customers, measurements, properties, propertyAssignments, propertyContacts } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { assignCustomer, checkTags, customerInCompany, propertyInCompany, recordTagChanges, type Tx } from "../lib/crm";
import { idList } from "./customers";

const AREA = "customers" as const;

type ListQuery = { q?: string; status?: string; mapCode?: string; tags?: string; anyTags?: string; notTags?: string; customerTags?: string; limit?: string; offset?: string };

/**
 * The sizes from a saved Property Measure (checked to be the company's): front, back, anything
 * measured that was marked neither ("other"), and the total after cut-outs.
 */
async function measurementSizes(tx: Tx, companyId: string, measurementId: string) {
  const [m] = await tx.select().from(measurements).where(and(eq(measurements.id, measurementId), eq(measurements.companyId, companyId)));
  if (!m) throw new HttpError(400, "That measurement doesn't exist");
  const whole = (n: number | null) => (n == null ? null : Math.round(n));
  const front = whole(m.frontSqFt), back = whole(m.backSqFt), total = whole(m.netSqFt);
  // "Other" only means something once some of the drawing is marked front or back.
  const rest = front != null || back != null ? (total ?? 0) - (front ?? 0) - (back ?? 0) : 0;
  return { frontSqFt: front, backSqFt: back, otherSqFt: rest > 0 ? rest : null, lawnSqFt: total, lat: m.pinLat ?? m.lat, lng: m.pinLng ?? m.lng };
}

/** Values sent under `custom` that belong to Crewdesk's own fields go to the property's columns; the rest are its custom values. */
async function ownColumns(companyId: string, raw: unknown, cleaned: CustomValues) {
  const fields = await fieldsFor(companyId, "property");
  return splitPropertyValues(fields, raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null, cleaned);
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
    const sentCustom = (req.body as { custom?: unknown })?.custom;
    const own = await ownColumns(companyId, sentCustom, await newRecordCustom(companyId, "property", sentCustom, [{ target: "customer", values: payer?.custom }]));
    const made = await db.transaction(async (tx) => {
      const tagIds = await checkTags(tx, companyId, tags);
      const sizes = body.measurementId ? await measurementSizes(tx, companyId, body.measurementId) : null;
      // Sizes typed on the form win; otherwise the linked image's are taken.
      const typed = [body.frontSqFt, body.backSqFt, body.otherSqFt, body.lawnSqFt, own.columns.frontSqFt, own.columns.backSqFt, own.columns.otherSqFt, own.columns.lawnSqFt].some((v) => v != null);
      const values = { ...body, ...own.columns, ...(sizes && !typed ? { frontSqFt: sizes.frontSqFt, backSqFt: sizes.backSqFt, otherSqFt: sizes.otherSqFt, lawnSqFt: sizes.lawnSqFt } : {}) };
      if (sizes && values.lat == null) Object.assign(values, { lat: sizes.lat, lng: sizes.lng });
      // A code typed while adding it is a code set by hand.
      const [p] = await tx.insert(properties).values({ ...values, mapCodeManual: !!values.mapCode, custom: own.custom, lawnSqFt: lawnTotal(values), tagIds, companyId, createdById: sub }).returning();
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
    // Its pin (the address found on the map) and, from the pin, its map code.
    await placeProperty(companyId, made.id);
    return propertyInCompany(db, companyId, made.id);
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
    // Tenants and other contacts who aren't customers: the current ones first, then those who've moved out.
    const contacts = await db.select().from(propertyContacts).where(eq(propertyContacts.propertyId, p.id))
      .orderBy(sql`${propertyContacts.endDate} is not null`, asc(propertyContacts.sortOrder), asc(propertyContacts.createdAt));
    return {
      ...p,
      contacts,
      assignments: people.map((a) => ({ ...a, name: customerName(a) })),
      measurement: measurement ?? null,
      cancellations: history,
    };
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(propertySchema, req.body);
    const { companyId, sub } = req.user;
    let moved = false;
    const saved = await db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      moved = formatAddress(p).toLowerCase() !== formatAddress({ street: body.street, city: body.city, state: body.state, zip: body.zip }).toLowerCase();
      const tagIds = await checkTags(tx, companyId, body.tagIds, p.tagIds);
      if (body.measurementId && body.measurementId !== p.measurementId) await measurementSizes(tx, companyId, body.measurementId);
      const mapCodeManual = body.mapCode !== (p.mapCode ?? undefined) ? !!body.mapCode : p.mapCodeManual;
      const sentCustom = (req.body as { custom?: unknown })?.custom;
      const cleaned = await updatedCustom(companyId, "property", sentCustom, p.custom);
      // Crewdesk's own fields sent as custom values (the property box's Edit) land in the property's columns.
      const own = cleaned ? await ownColumns(companyId, sentCustom, cleaned) : null;
      // The property as the form's own boxes leave it: a total left blank is front + back + other (an "other" the form didn't mention is kept).
      const kept = <K extends "frontSqFt" | "backSqFt" | "otherSqFt">(k: K) => (body[k] !== undefined ? body[k] ?? null : p[k]);
      const state = {
        mapCode: body.mapCode ?? null, mapCodeManual, frontSqFt: kept("frontSqFt"), backSqFt: kept("backSqFt"), otherSqFt: kept("otherSqFt"),
        lawnSqFt: lawnTotal({ otherSqFt: p.otherSqFt, ...body }),
      };
      const [u] = await tx.update(properties).set({
        ...body, ...(own ? { custom: own.custom } : {}), mapCode: state.mapCode, mapCodeManual, lawnSqFt: state.lawnSqFt, tagIds, updatedAt: new Date(),
        ...(own ? propertyColumnChanges(state, own.columns) : {}),
      }).where(eq(properties.id, p.id)).returning();
      await recordTagChanges(tx, { companyId, before: p.tagIds, after: tagIds, propertyId: p.id, source: "hand", byId: sub });
      return u;
    });
    // A new address is looked up for a new pin; either way the map code follows the pin (unless it's set by hand).
    await placeProperty(companyId, saved.id, { moved });
    return propertyInCompany(db, companyId, saved.id);
  });

  /** Map Code back to automatic: the code typed by hand gives way to the outline the pin is in. */
  app.post<{ Params: { id: string } }>("/:id/map-code/auto", async (req) => {
    const { companyId } = req.user;
    const p = await propertyInCompany(db, companyId, req.params.id);
    await db.update(properties).set({ mapCodeManual: false, updatedAt: new Date() }).where(eq(properties.id, p.id));
    return { mapCode: await assignMapCode(companyId, p.id), mapCodeManual: false };
  });

  /**
   * The pin: where the property is on the map, put there by hand (dragged onto the house or the
   * driveway). Routes, drive times and the weather use this spot.
   */
  app.put<{ Params: { id: string } }>("/:id/pin", async (req) => {
    const at = parse(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }), req.body);
    const p = await propertyInCompany(db, req.user.companyId, req.params.id);
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const [u] = await db.update(properties).set({ lat: round(at.lat), lng: round(at.lng), pinLookupAt: null, updatedAt: new Date() }).where(eq(properties.id, p.id)).returning({ lat: properties.lat, lng: properties.lng });
    // A moved pin may be in another map code now.
    return { ...u, mapCode: await assignMapCode(req.user.companyId, p.id) };
  });
  /** Where the map services find the property's address, to start the pin from. Nothing is saved. */
  app.post<{ Params: { id: string } }>("/:id/pin/find", async (req) => {
    const p = await propertyInCompany(db, req.user.companyId, req.params.id);
    const at = await locateAddress(formatAddress(p)).catch(() => null);
    if (!at) throw new HttpError(404, "That address couldn't be found on the map. Zoom in and click where the property is instead");
    return { lat: at.lat, lng: at.lng };
  });

  /** How the customer hears about a chemical application here: email, text, printed or none. */
  app.put<{ Params: { id: string } }>("/:id/chemical-notice", async (req) => {
    const { chemicalNotice } = parse(z.object({ chemicalNotice: z.enum(NOTICE_CHANNELS) }), req.body);
    const [row] = await db.update(properties).set({ chemicalNotice, updatedAt: new Date() })
      .where(and(eq(properties.id, req.params.id), eq(properties.companyId, req.user.companyId))).returning({ id: properties.id });
    if (!row) throw new HttpError(404, "Property not found");
    return { chemicalNotice };
  });

  /**
   * The property's image: links a saved Property Measure and takes its sizes (front, back, other and
   * total), replacing what was there. They can be changed by hand afterwards; the image stays linked.
   */
  app.post<{ Params: { id: string } }>("/:id/measurement", async (req) => {
    const { measurementId } = parse(z.object({ measurementId: z.string().uuid() }), req.body);
    const { companyId } = req.user;
    return db.transaction(async (tx) => {
      const p = await propertyInCompany(tx, companyId, req.params.id);
      const s = await measurementSizes(tx, companyId, measurementId);
      const [u] = await tx.update(properties).set({
        measurementId, frontSqFt: s.frontSqFt, backSqFt: s.backSqFt, otherSqFt: s.otherSqFt, lawnSqFt: s.lawnSqFt,
        lat: p.lat ?? s.lat, lng: p.lng ?? s.lng, updatedAt: new Date(),
      }).where(eq(properties.id, p.id)).returning();
      // The drawing can give a property its first pin, and with it a map code.
      await assignMapCode(companyId, p.id, tx);
      return propertyInCompany(tx, companyId, u.id);
    });
  });
  /** Takes the image off the property; the sizes stay as they are. */
  app.delete<{ Params: { id: string } }>("/:id/measurement", async (req) => {
    const p = await propertyInCompany(db, req.user.companyId, req.params.id);
    await db.update(properties).set({ measurementId: null, updatedAt: new Date() }).where(eq(properties.id, p.id));
    return { ok: true };
  });

  // ---- Contacts who aren't customers (tenants and the like).

  const contactOn = async (companyId: string, propertyId: string, contactId: string) => {
    const [c] = await db.select().from(propertyContacts).where(and(eq(propertyContacts.id, contactId), eq(propertyContacts.propertyId, propertyId), eq(propertyContacts.companyId, companyId)));
    if (!c) throw new HttpError(404, "Contact not found");
    return c;
  };
  /** Adds a tenant or other contact to the property. They are not a customer: no account, no invoices. */
  app.post<{ Params: { id: string } }>("/:id/contacts", async (req) => {
    const body = parse(propertyContactSchema, req.body);
    const { companyId, sub } = req.user;
    const p = await propertyInCompany(db, companyId, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(propertyContacts).where(eq(propertyContacts.propertyId, p.id));
    if (n >= 50) throw new HttpError(400, "Up to 50 contacts on a property. Delete ones no longer needed first.");
    const [row] = await db.insert(propertyContacts).values({ companyId, propertyId: p.id, ...contactColumns(body), sortOrder: n, createdById: sub }).returning();
    return row;
  });
  app.put<{ Params: { id: string; contactId: string } }>("/:id/contacts/:contactId", async (req) => {
    const body = parse(propertyContactSchema, req.body);
    const c = await contactOn(req.user.companyId, req.params.id, req.params.contactId);
    if (c.startDate && c.endDate && body.startDate && body.startDate > c.endDate) throw new HttpError(400, "They can't move in after they moved out");
    const cols = contactColumns(body);
    // A different cell phone hasn't replied STOP.
    const [row] = await db.update(propertyContacts).set({ ...cols, ...(cols.cellPhone !== c.cellPhone ? { textOptOutAt: null } : {}) }).where(eq(propertyContacts.id, c.id)).returning();
    return row;
  });
  /** Moved out: they stay on the property's history. `back: true` puts them on it again. */
  app.post<{ Params: { id: string; contactId: string } }>("/:id/contacts/:contactId/end", async (req) => {
    const body = parse(endAssignmentSchema.extend({ back: z.boolean().optional() }), req.body ?? {});
    const c = await contactOn(req.user.companyId, req.params.id, req.params.contactId);
    const endDate = body.back ? null : body.endDate ?? (await companyToday(req.user.companyId));
    if (endDate && c.startDate && endDate < c.startDate) throw new HttpError(400, "They can't move out before they moved in");
    const [row] = await db.update(propertyContacts).set({ endDate }).where(eq(propertyContacts.id, c.id)).returning();
    return row;
  });
  /** Removes a contact added by mistake (use Moved out to keep them as history). */
  app.delete<{ Params: { id: string; contactId: string } }>("/:id/contacts/:contactId", async (req) => {
    const c = await contactOn(req.user.companyId, req.params.id, req.params.contactId);
    await db.delete(propertyContacts).where(eq(propertyContacts.id, c.id));
    return { ok: true };
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
      if (p.status === "cancelled") throw new HttpError(400, "That property is already inactive");
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
      if (p.status !== "cancelled") throw new HttpError(400, "That property isn't inactive");
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

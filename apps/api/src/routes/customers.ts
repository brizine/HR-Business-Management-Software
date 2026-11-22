import type { FastifyPluginAsync } from "fastify";
import { and, arrayContains, arrayOverlaps, asc, desc, eq, ilike, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { cancelSchema, customerName, customerSchema, customerUpdateSchema, lawnTotal } from "@crewdesk/shared";
import { db } from "../db";
import { cancellationReasons, cancellations, customerContacts, customerCredits, customers, invoices, prepayments, properties, propertyAssignments, visits } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { assignCustomer, checkTags, customerInCompany, nextCustomerNumber, recordTagChanges } from "../lib/crm";
import { queueBillingSync, syncCustomer } from "../lib/billingSync";

const AREA = "customers" as const;

/** Comma-separated ids from a query string, keeping only things shaped like uuids. */
export function idList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  return v.split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);
}

type ListQuery = { q?: string; status?: string; tags?: string; anyTags?: string; notTags?: string; limit?: string; offset?: string };

/**
 * Customers: the people and companies ProSpray bills. Managers (in Customers & billing) see and
 * edit them; admins delete ones with no history.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  // Written out with table aliases: in a plain select the outer table's columns lose their table name.
  const currentProps = sql<number>`(select count(*)::int from property_assignments pa where pa.customer_id = "customers"."id" and pa.end_date is null)`;
  const firstAddress = sql<string | null>`(select p.street || coalesce(', ' || p.city, '') from property_assignments pa join properties p on p.id = pa.property_id
    where pa.customer_id = "customers"."id" and pa.end_date is null order by pa.role, pa.created_at limit 1)`;

  app.get<{ Querystring: ListQuery }>("/", async (req) => {
    const { companyId } = req.user;
    const where: SQL[] = [eq(customers.companyId, companyId)];
    const status = req.query.status ?? "current";
    if (status === "current") where.push(inArray(customers.status, ["active", "lead"]));
    else if (["active", "lead", "cancelled"].includes(status)) where.push(eq(customers.status, status));
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (q) {
      const like = `%${q}%`;
      const digits = q.replace(/\D/g, "");
      const match = [
        ilike(customers.firstName, like), ilike(customers.lastName, like), ilike(customers.companyName, like), ilike(customers.email, like),
        sql`(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')) ilike ${like}`,
        sql`exists (select 1 from property_assignments pa join properties p on p.id = pa.property_id where pa.customer_id = "customers"."id" and p.street ilike ${like})`,
      ];
      if (digits.length >= 4) match.push(sql`regexp_replace(coalesce(${customers.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}`);
      if (/^\d+$/.test(q)) match.push(eq(customers.number, Number(q)));
      where.push(or(...match)!);
    }
    const all = idList(req.query.tags), any = idList(req.query.anyTags), none = idList(req.query.notTags);
    if (all.length) where.push(arrayContains(customers.tagIds, all));
    if (any.length) where.push(arrayOverlaps(customers.tagIds, any));
    if (none.length) where.push(not(arrayOverlaps(customers.tagIds, none)));

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await db
      .select({
        id: customers.id, number: customers.number, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName,
        companyName: customers.companyName, email: customers.email, phone: customers.phone, status: customers.status,
        tagIds: customers.tagIds, delivery: customers.delivery, sample: customers.sample, propertyCount: currentProps, address: firstAddress,
      })
      .from(customers)
      .where(and(...where))
      .orderBy(sql`lower(coalesce(${customers.companyName}, ${customers.lastName}, ${customers.firstName}, ''))`, asc(customers.firstName))
      .limit(limit)
      .offset(offset);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(customers).where(and(...where));
    return { total, rows: rows.map((r) => ({ ...r, name: customerName(r) })) };
  });

  /** A new customer, optionally with their first service address (they become its bill-to). */
  app.post("/", async (req) => {
    const { property, contacts, ...body } = parse(customerSchema, req.body);
    const { companyId, sub } = req.user;
    const today = await companyToday(companyId);
    const created = await db.transaction(async (tx) => {
      const tagIds = await checkTags(tx, companyId, body.tagIds);
      const number = await nextCustomerNumber(tx, companyId);
      const [c] = await tx.insert(customers).values({ ...body, tagIds, companyId, number, createdById: sub }).returning();
      if (contacts.length) await tx.insert(customerContacts).values(contacts.map((k, i) => ({ ...k, companyId, customerId: c.id, sortOrder: i })));
      await recordTagChanges(tx, { companyId, before: [], after: tagIds, customerId: c.id, source: "hand", byId: sub });
      if (property) {
        const { tagIds: propTags, ...p } = property;
        const ptags = await checkTags(tx, companyId, propTags);
        const [prop] = await tx.insert(properties).values({ ...p, tagIds: ptags, lawnSqFt: lawnTotal(p), companyId, createdById: sub }).returning();
        await recordTagChanges(tx, { companyId, before: [], after: ptags, propertyId: prop.id, source: "hand", byId: sub });
        await assignCustomer(tx, { companyId, propertyId: prop.id, customerId: c.id, role: "bill_to", startDate: today });
      }
      return c;
    });
    return { ...created, name: customerName(created) };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    const contacts = await db.select().from(customerContacts).where(eq(customerContacts.customerId, c.id)).orderBy(asc(customerContacts.sortOrder));
    const props = await db
      .select({
        assignmentId: propertyAssignments.id, role: propertyAssignments.role, startDate: propertyAssignments.startDate, endDate: propertyAssignments.endDate,
        id: properties.id, name: properties.name, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip,
        mapCode: properties.mapCode, lawnSqFt: properties.lawnSqFt, status: properties.status, tagIds: properties.tagIds,
      })
      .from(propertyAssignments)
      .innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
      .where(eq(propertyAssignments.customerId, c.id))
      .orderBy(sql`${propertyAssignments.endDate} is not null`, asc(propertyAssignments.role), asc(properties.street));
    const history = await db.select().from(cancellations).where(and(eq(cancellations.customerId, c.id), isNull(cancellations.propertyId))).orderBy(desc(cancellations.createdAt));
    return { ...c, name: customerName(c), contacts, properties: props, cancellations: history };
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const { contacts, status, ...body } = parse(customerUpdateSchema, req.body);
    const { companyId, sub } = req.user;
    const updated = await db.transaction(async (tx) => {
      const c = await customerInCompany(tx, companyId, req.params.id);
      const tagIds = await checkTags(tx, companyId, body.tagIds, c.tagIds);
      // Cancelling and reactivating have their own steps (with a reason); a lead can become active here.
      const nextStatus = c.status === "cancelled" ? "cancelled" : status;
      const [u] = await tx.update(customers).set({ ...body, status: nextStatus, tagIds, updatedAt: new Date() }).where(eq(customers.id, c.id)).returning();
      await tx.delete(customerContacts).where(eq(customerContacts.customerId, c.id));
      if (contacts.length) await tx.insert(customerContacts).values(contacts.map((k, i) => ({ ...k, companyId, customerId: c.id, sortOrder: i })));
      await recordTagChanges(tx, { companyId, before: c.tagIds, after: tagIds, customerId: c.id, source: "hand", byId: sub });
      return u;
    });
    // Already in Bigcapital: keep their name, email, phone and address in step there.
    if (updated.bigcapitalCustomerId) queueBillingSync(() => syncCustomer(companyId, updated.id));
    return { ...updated, name: customerName(updated) };
  });

  /**
   * Cancels a customer (reason required). Properties they're the current bill-to for are cancelled
   * with the same reason, since nobody would be billed for them; other properties are untouched.
   */
  app.post<{ Params: { id: string } }>("/:id/cancel", async (req) => {
    const body = parse(cancelSchema, req.body);
    const { companyId, sub } = req.user;
    const effectiveDate = body.effectiveDate ?? (await companyToday(companyId));
    return db.transaction(async (tx) => {
      const c = await customerInCompany(tx, companyId, req.params.id);
      if (c.status === "cancelled") throw new HttpError(400, "That customer is already cancelled");
      const [reason] = await tx.select().from(cancellationReasons).where(and(eq(cancellationReasons.id, body.reasonId), eq(cancellationReasons.companyId, companyId)));
      if (!reason || reason.retired) throw new HttpError(400, "Choose a reason from the list");
      if (reason.commentRequired && !body.comment) throw new HttpError(400, `"${reason.label}" needs a comment`);
      const base = { companyId, reasonId: reason.id, reasonLabel: reason.label, effectiveDate, comment: body.comment ?? null, byId: sub };
      await tx.insert(cancellations).values({ ...base, customerId: c.id });
      await tx.update(customers).set({ status: "cancelled", updatedAt: new Date() }).where(eq(customers.id, c.id));
      const billed = await tx.select({ id: properties.id }).from(propertyAssignments).innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
        .where(and(eq(propertyAssignments.customerId, c.id), eq(propertyAssignments.role, "bill_to"), isNull(propertyAssignments.endDate), eq(properties.status, "active")));
      for (const p of billed) {
        await tx.update(properties).set({ status: "cancelled", updatedAt: new Date() }).where(eq(properties.id, p.id));
        await tx.insert(cancellations).values({ ...base, customerId: c.id, propertyId: p.id });
      }
      return { ok: true, propertiesCancelled: billed.length };
    });
  });

  /** Reactivates a cancelled customer; their properties are reactivated one by one from each property. */
  app.post<{ Params: { id: string } }>("/:id/reactivate", async (req) => {
    const { companyId, sub } = req.user;
    return db.transaction(async (tx) => {
      const c = await customerInCompany(tx, companyId, req.params.id);
      if (c.status !== "cancelled") throw new HttpError(400, "That customer isn't cancelled");
      await tx.update(customers).set({ status: "active", updatedAt: new Date() }).where(eq(customers.id, c.id));
      await tx.update(cancellations).set({ reactivatedAt: new Date(), reactivatedById: sub })
        .where(and(eq(cancellations.customerId, c.id), isNull(cancellations.propertyId), isNull(cancellations.reactivatedAt)));
      return { ok: true };
    });
  });

  /** Admins: delete a lead or a customer who was never on a property (anyone else is cancelled instead, to keep history). */
  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(propertyAssignments).where(eq(propertyAssignments.customerId, c.id));
    if (n > 0 && c.status !== "lead" && !c.sample) throw new HttpError(409, "This customer has property history; cancel them instead");
    const [{ inv }] = await db.select({ inv: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.customerId, c.id));
    if (inv > 0 && !c.sample) throw new HttpError(409, "This customer has invoices; cancel them instead");
    const [{ wo }] = await db.select({ wo: sql<number>`count(*)::int` }).from(visits).where(eq(visits.customerId, c.id));
    if (wo > 0 && !c.sample) throw new HttpError(409, "This customer has work orders; cancel them instead");
    await db.transaction(async (tx) => {
      await tx.delete(invoices).where(eq(invoices.customerId, c.id));
      await tx.delete(customerCredits).where(eq(customerCredits.customerId, c.id));
      await tx.delete(prepayments).where(eq(prepayments.customerId, c.id));
      await tx.delete(customers).where(eq(customers.id, c.id));
    });
    return { ok: true };
  });
};

export default routes;

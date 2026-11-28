import type { FastifyPluginAsync } from "fastify";
import { and, arrayContains, arrayOverlaps, asc, desc, eq, ilike, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { BULK_MAX, cancelSchema, customerName, customerSchema, customerIdsSchema, customerMatchSchema, customerUpdateSchema, lawnTotal, parseCustomerFilters, splitPropertyValues, type CustomerFilter, type CustomerSelection } from "@crewdesk/shared";
import { placeProperty } from "../lib/mapCodes";
import { db } from "../db";
import { fieldsFor, newRecordCustom, updatedCustom } from "../lib/customFields";
import { filterSql, listColumns, sortSql } from "../lib/customerList";
import { cancellationReasons, cancellations, customerContacts, customerCredits, customers, invoices, prepayments, properties, propertyAssignments, visits } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { assignCustomer, checkTags, customerInCompany, nextCustomerNumber, recordTagChanges, type Tx } from "../lib/crm";
import { queueBillingSync, syncCustomer } from "../lib/billingSync";

const AREA = "customers" as const;

/** Comma-separated ids from a query string, keeping only things shaped like uuids. */
export function idList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  return v.split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);
}

type ListQuery = { q?: string; status?: string; tags?: string; anyTags?: string; notTags?: string; limit?: string; offset?: string; filters?: string; sort?: string; dir?: string; export?: string };

/**
 * The list's search, old tag params and filter rules as SQL (everything but the status tab), and
 * the status tab on its own, so the counts can leave it out.
 */
async function listWhere(companyId: string, query: { q?: string; tags?: string; anyTags?: string; notTags?: string; filters?: string | CustomerFilter[]; status?: string }) {
  const today = await companyToday(companyId);
  const cols = listColumns(today, `${today.slice(0, 4)}-01-01`);
  const where: SQL[] = [eq(customers.companyId, companyId)];
  const q = (query.q ?? "").trim().slice(0, 100);
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
  // The older tag filters (still used by links from elsewhere).
  const all = idList(query.tags), any = idList(query.anyTags), none = idList(query.notTags);
  if (all.length) where.push(arrayContains(customers.tagIds, all));
  if (any.length) where.push(arrayOverlaps(customers.tagIds, any));
  if (none.length) where.push(not(arrayOverlaps(customers.tagIds, none)));
  // Filter rules.
  const rules = Array.isArray(query.filters) ? query.filters : parseCustomerFilters(query.filters);
  if (rules.length) {
    const custom = rules.some((r) => r.f.startsWith("cf:")) ? await fieldsFor(companyId, "customer") : [];
    for (const r of rules) { const w = filterSql(r, cols, custom); if (w) where.push(w); }
  }
  const status = query.status ?? "current";
  const statusWhere = status === "current" ? inArray(customers.status, ["active", "lead"])
    : ["active", "lead", "cancelled"].includes(status) ? eq(customers.status, status) : undefined;
  return { where, statusWhere, cols };
}

/** Which customers a request is for: { ids } (the ticked ones) or { match } (everyone the list matches). */
export function parseSelection(raw: Record<string, unknown>): CustomerSelection {
  return raw.match ? { match: parse(customerMatchSchema, raw.match) } : parse(customerIdsSchema, { ids: raw.ids });
}

/** The customers a bulk action is for: the ticked ones, or all that match the list (up to BULK_MAX), in name order. */
export async function selectedIds(companyId: string, sel: CustomerSelection): Promise<string[]> {
  if ("ids" in sel) return sel.ids;
  const { where, statusWhere, cols } = await listWhere(companyId, sel.match);
  const rows = await db.select({ id: customers.id }).from(customers).where(and(...where, ...(statusWhere ? [statusWhere] : [])))
    .orderBy(sortSql("name", cols)!, asc(customers.number)).limit(BULK_MAX + 1);
  if (rows.length > BULK_MAX) throw new HttpError(400, `That's more than ${BULK_MAX.toLocaleString()} customers; narrow the list first`);
  return rows.map((r) => r.id);
}

/** A cancel reason from this company's list (not retired), with its comment if it needs one. */
async function cancelReason(tx: Tx, companyId: string, body: { reasonId: string; comment?: string | null }) {
  const [reason] = await tx.select().from(cancellationReasons).where(and(eq(cancellationReasons.id, body.reasonId), eq(cancellationReasons.companyId, companyId)));
  if (!reason || reason.retired) throw new HttpError(400, "Choose a reason from the list");
  if (reason.commentRequired && !body.comment) throw new HttpError(400, `"${reason.label}" needs a comment`);
  return reason;
}

/**
 * Cancels one customer with a reason, and the properties they're the current bill-to for (nobody
 * would be billed for them). Returns how many properties were cancelled.
 */
async function cancelCustomer(tx: Tx, o: { companyId: string; byId: string; customerId: string; reason: { id: string; label: string }; effectiveDate: string; comment: string | null }) {
  const base = { companyId: o.companyId, reasonId: o.reason.id, reasonLabel: o.reason.label, effectiveDate: o.effectiveDate, comment: o.comment, byId: o.byId };
  await tx.insert(cancellations).values({ ...base, customerId: o.customerId });
  await tx.update(customers).set({ status: "cancelled", updatedAt: new Date() }).where(eq(customers.id, o.customerId));
  const billed = await tx.select({ id: properties.id }).from(propertyAssignments).innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
    .where(and(eq(propertyAssignments.customerId, o.customerId), eq(propertyAssignments.role, "bill_to"), isNull(propertyAssignments.endDate), eq(properties.status, "active")));
  for (const p of billed) {
    await tx.update(properties).set({ status: "cancelled", updatedAt: new Date() }).where(eq(properties.id, p.id));
    await tx.insert(cancellations).values({ ...base, customerId: o.customerId, propertyId: p.id });
  }
  return billed.length;
}

/**
 * Customers: the people and companies ProSpray bills. Managers (in Customers & billing) see and
 * edit them; admins delete ones with no history.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  /**
   * The list (like Homeworks' Customers page): a status tab, a quick search, any number of filter
   * rules (all must match), a sort, a page; with counts by status for the tabs and the worked-out
   * columns (balance, credit, prepaid, billed this year, last and next service). export=1 returns up
   * to 5,000 rows at once for the spreadsheet export.
   */
  app.get<{ Querystring: ListQuery }>("/", async (req) => {
    const { companyId } = req.user;
    const { where, statusWhere, cols } = await listWhere(companyId, req.query);
    // Counts by status for the tabs (everything but the status itself).
    const counts = await db.select({ status: customers.status, n: sql<number>`count(*)::int` }).from(customers).where(and(...where)).groupBy(customers.status);
    const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    if (statusWhere) where.push(statusWhere);
    const max = req.query.export === "1" ? 5000 : 250;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), max);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const by = sortSql(req.query.sort ?? "name", cols) ?? sortSql("name", cols)!;
    const dir = req.query.dir === "desc" ? sql`desc nulls last` : sql`asc nulls last`;
    const rows = await db
      .select({
        id: customers.id, number: customers.number, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName,
        companyName: customers.companyName, email: customers.email, phone: customers.phone, altPhone: customers.altPhone, status: customers.status,
        tagIds: customers.tagIds, delivery: customers.delivery, sample: customers.sample, source: customers.source, poRequired: customers.poRequired,
        taxExempt: customers.taxExempt, emailOptOutAt: customers.emailOptOutAt, autopay: customers.autopay, onFile: cols.onFile, openEstimates: cols.openEstimates, notes: sql<string | null>`left(${customers.notes}, 200)`, createdAt: customers.createdAt, custom: customers.custom,
        billingStreet: customers.billingStreet, billingCity: customers.billingCity, billingState: customers.billingState, billingZip: customers.billingZip,
        propertyCount: cols.properties, address: cols.address, city: cols.city, zip: cols.zip, balanceCents: cols.balance, overdueCents: cols.overdue,
        creditCents: cols.credit, prepaidCents: cols.prepaid, revenueCents: cols.revenue, lastService: cols.lastService, nextService: cols.nextService,
      })
      .from(customers)
      .where(and(...where))
      .orderBy(sql`${by} ${dir}`, asc(customers.number))
      .limit(limit)
      .offset(offset);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(customers).where(and(...where));
    return {
      total, rows: rows.map((r) => ({ ...r, name: customerName(r) })),
      counts: { active: count("active"), lead: count("lead"), cancelled: count("cancelled"), current: count("active") + count("lead"), all: count("active") + count("lead") + count("cancelled") },
    };
  });

  /**
   * Several customers at once: the ticked rows, or all that match the list. Add or remove tags,
   * mark them active or leads, or cancel them with a reason (like cancelling one at a time:
   * properties they're the current bill-to for are cancelled too). Already-cancelled customers are
   * skipped for status changes and cancelling.
   */
  app.post("/bulk", async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const sel = parseSelection(raw);
    const body = parse(z.object({
      addTagIds: z.array(z.string().uuid()).max(20).default([]),
      removeTagIds: z.array(z.string().uuid()).max(20).default([]),
      status: z.enum(["active", "lead"]).optional(),
      cancel: cancelSchema.optional(),
    }), raw);
    if (!body.addTagIds.length && !body.removeTagIds.length && !body.status && !body.cancel) throw new HttpError(400, "Pick tags to add or remove, a status, or a cancel reason");
    if (body.cancel && (body.status || body.addTagIds.length || body.removeTagIds.length)) throw new HttpError(400, "Cancel on its own, not with other changes");
    const { companyId, sub } = req.user;
    const ids = await selectedIds(companyId, sel);
    if (!ids.length) return { changed: 0, skipped: 0, missing: 0, propertiesCancelled: 0 };
    const effectiveDate = body.cancel ? body.cancel.effectiveDate ?? (await companyToday(companyId)) : null;
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, ids)));
      let changed = 0, skipped = 0, propertiesCancelled = 0;
      if (body.cancel) {
        const reason = await cancelReason(tx, companyId, body.cancel);
        for (const c of rows) {
          if (c.status === "cancelled") { skipped++; continue; }
          propertiesCancelled += await cancelCustomer(tx, { companyId, byId: sub, customerId: c.id, reason, effectiveDate: effectiveDate!, comment: body.cancel.comment ?? null });
          changed++;
        }
        return { changed, skipped, missing: ids.length - rows.length, propertiesCancelled };
      }
      const add = await checkTags(tx, companyId, body.addTagIds);
      for (const c of rows) {
        const tagIds = [...new Set([...c.tagIds.filter((t) => !body.removeTagIds.includes(t)), ...add])];
        // Cancelled customers keep their status (reactivating has its own step).
        const nextStatus = body.status && c.status !== "cancelled" ? body.status : c.status;
        if (body.status && c.status === "cancelled") skipped++;
        const sameTags = tagIds.length === c.tagIds.length && tagIds.every((t) => c.tagIds.includes(t));
        if (sameTags && nextStatus === c.status) continue;
        await tx.update(customers).set({ tagIds, status: nextStatus, updatedAt: new Date() }).where(eq(customers.id, c.id));
        await recordTagChanges(tx, { companyId, before: c.tagIds, after: tagIds, customerId: c.id, source: "bulk", byId: sub });
        changed++;
      }
      return { changed, skipped, missing: ids.length - rows.length, propertiesCancelled: 0 };
    });
  });

  /** A new customer, optionally with their first service address (they become its bill-to). */
  app.post("/", async (req) => {
    const { property, contacts, ...body } = parse(customerSchema, req.body);
    const { companyId, sub } = req.user;
    const today = await companyToday(companyId);
    const raw = req.body as { custom?: unknown; property?: { custom?: unknown } };
    const custom = await newRecordCustom(companyId, "customer", raw?.custom);
    // The property's values: Crewdesk's own fields (Gate Code, the sizes …) go to its columns, the rest are its custom values.
    const propFields = property ? await fieldsFor(companyId, "property") : [];
    const propSent = raw?.property?.custom && typeof raw.property.custom === "object" ? (raw.property.custom as Record<string, unknown>) : null;
    const propOwn = splitPropertyValues(propFields, propSent, property ? await newRecordCustom(companyId, "property", raw?.property?.custom, [{ target: "customer", values: custom }]) : {});
    let firstProperty: string | null = null;
    const created = await db.transaction(async (tx) => {
      const tagIds = await checkTags(tx, companyId, body.tagIds);
      const number = await nextCustomerNumber(tx, companyId);
      const [c] = await tx.insert(customers).values({ ...body, custom, tagIds, companyId, number, createdById: sub }).returning();
      if (contacts.length) await tx.insert(customerContacts).values(contacts.map((k, i) => ({ ...k, companyId, customerId: c.id, sortOrder: i })));
      await recordTagChanges(tx, { companyId, before: [], after: tagIds, customerId: c.id, source: "hand", byId: sub });
      if (property) {
        const { tagIds: propTags, ...typed } = property;
        const p = { ...typed, ...propOwn.columns };
        const ptags = await checkTags(tx, companyId, propTags);
        const [prop] = await tx.insert(properties).values({ ...p, mapCodeManual: !!p.mapCode, custom: propOwn.custom, tagIds: ptags, lawnSqFt: lawnTotal(p), companyId, createdById: sub }).returning();
        await recordTagChanges(tx, { companyId, before: [], after: ptags, propertyId: prop.id, source: "hand", byId: sub });
        await assignCustomer(tx, { companyId, propertyId: prop.id, customerId: c.id, role: "bill_to", startDate: today });
        firstProperty = prop.id;
      }
      return c;
    });
    // The property's pin (its address found on the map) and, from the pin, its map code.
    if (firstProperty) await placeProperty(companyId, firstProperty);
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
        mapCode: properties.mapCode, lawnSqFt: properties.lawnSqFt, frontSqFt: properties.frontSqFt, backSqFt: properties.backSqFt, otherSqFt: properties.otherSqFt, custom: properties.custom, status: properties.status, tagIds: properties.tagIds, taxRate: properties.taxRate,
        lastService: sql<string | null>`(select max(v.date)::text from visits v where v.property_id = ${properties.id} and v.status = 'completed')`,
        nextService: sql<string | null>`(select min(v.date)::text from visits v where v.property_id = ${properties.id} and v.status in ('open', 'on_site') and v.date >= current_date)`,
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
      const custom = await updatedCustom(companyId, "customer", (req.body as { custom?: unknown })?.custom, c.custom);
      // The form sends the whole customer: a box left blank clears it.
      const cleared = { title: body.title ?? null, county: body.county ?? null, invoiceNotes: body.invoiceNotes ?? null, notes: body.notes ?? null, source: body.source ?? null, altPhone: body.altPhone ?? null, termsDays: body.termsDays ?? null };
      const [u] = await tx.update(customers).set({ ...body, ...cleared, ...(custom ? { custom } : {}), status: nextStatus, tagIds, updatedAt: new Date() }).where(eq(customers.id, c.id)).returning();
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
      if (c.status === "cancelled") throw new HttpError(400, "That customer is already inactive");
      const reason = await cancelReason(tx, companyId, body);
      const propertiesCancelled = await cancelCustomer(tx, { companyId, byId: sub, customerId: c.id, reason, effectiveDate, comment: body.comment ?? null });
      return { ok: true, propertiesCancelled };
    });
  });

  /** Reactivates a cancelled customer; their properties are reactivated one by one from each property. */
  app.post<{ Params: { id: string } }>("/:id/reactivate", async (req) => {
    const { companyId, sub } = req.user;
    return db.transaction(async (tx) => {
      const c = await customerInCompany(tx, companyId, req.params.id);
      if (c.status !== "cancelled") throw new HttpError(400, "That customer isn't inactive");
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

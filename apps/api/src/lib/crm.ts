import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DEFAULT_CANCEL_REASONS, dayBefore, type PropertyRole } from "@crewdesk/shared";
import { db, type DB } from "../db";
import { cancellationReasons, crmTags, customers, properties, propertyAssignments, tagEvents } from "../db/schema";
import { HttpError } from "./errors";

/** A transaction or the database itself. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0] | DB;

/** Customer numbers start at 1001 and go up by one per company. */
export async function nextCustomerNumber(tx: Tx, companyId: string) {
  // One number at a time per company, so two people adding customers at once don't collide.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`customers:${companyId}`}))`);
  const [{ n }] = await tx.select({ n: sql<number | null>`max(${customers.number})` }).from(customers).where(eq(customers.companyId, companyId));
  return (n ?? 1000) + 1;
}

/** The company's cancellation reasons, creating the starting list the first time. */
export async function reasonsFor(companyId: string) {
  const list = await db.select().from(cancellationReasons).where(eq(cancellationReasons.companyId, companyId)).orderBy(asc(cancellationReasons.sortOrder), asc(cancellationReasons.createdAt));
  if (list.length) return list;
  await db.insert(cancellationReasons).values(DEFAULT_CANCEL_REASONS.map((r, i) => ({ companyId, label: r.label, initiatedBy: r.initiatedBy, commentRequired: !!r.commentRequired, sortOrder: i })));
  return db.select().from(cancellationReasons).where(eq(cancellationReasons.companyId, companyId)).orderBy(asc(cancellationReasons.sortOrder));
}

/**
 * Checks tag ids belong to the company and drops duplicates. Archived tags can stay where they
 * already are, but can't be newly added.
 */
export async function checkTags(tx: Tx, companyId: string, ids: string[], keep: string[] = []) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await tx.select({ id: crmTags.id, archived: crmTags.archived }).from(crmTags).where(and(eq(crmTags.companyId, companyId), inArray(crmTags.id, unique)));
  if (found.length !== unique.length) throw new HttpError(400, "One of those tags doesn't exist");
  if (found.some((t) => t.archived && !keep.includes(t.id))) throw new HttpError(400, "That tag is archived");
  return unique;
}

/** Records each tag added or removed (the history automations will key on). */
export async function recordTagChanges(
  tx: Tx,
  o: { companyId: string; before: string[]; after: string[]; customerId?: string; propertyId?: string; source: string; byId: string | null },
) {
  const added = o.after.filter((t) => !o.before.includes(t));
  const removed = o.before.filter((t) => !o.after.includes(t));
  const rows = [
    ...added.map((tagId) => ({ tagId, action: "add" })),
    ...removed.map((tagId) => ({ tagId, action: "remove" })),
  ].map((r) => ({ ...r, companyId: o.companyId, customerId: o.customerId ?? null, propertyId: o.propertyId ?? null, source: o.source, byId: o.byId }));
  if (rows.length) await tx.insert(tagEvents).values(rows);
}

export async function customerInCompany(tx: Tx, companyId: string, id: string) {
  const [c] = await tx.select().from(customers).where(and(eq(customers.id, id), eq(customers.companyId, companyId)));
  if (!c) throw new HttpError(404, "Customer not found");
  return c;
}

export async function propertyInCompany(tx: Tx, companyId: string, id: string) {
  const [p] = await tx.select().from(properties).where(and(eq(properties.id, id), eq(properties.companyId, companyId)));
  if (!p) throw new HttpError(404, "Property not found");
  return p;
}

/**
 * Puts a customer on a property. A new bill-to replaces the current one, whose assignment ends the
 * day before (history kept); a customer already current in that role is left as is.
 */
export async function assignCustomer(tx: Tx, o: { companyId: string; propertyId: string; customerId: string; role: PropertyRole; startDate: string }) {
  const current = await tx.select().from(propertyAssignments)
    .where(and(eq(propertyAssignments.propertyId, o.propertyId), eq(propertyAssignments.role, o.role), isNull(propertyAssignments.endDate)));
  const same = current.find((a) => a.customerId === o.customerId);
  if (same) return same;
  if (o.role === "bill_to") {
    for (const old of current) {
      // Never end before it started (a replacement on the same day just closes the old one that day).
      const end = dayBefore(o.startDate) < old.startDate ? old.startDate : dayBefore(o.startDate);
      await tx.update(propertyAssignments).set({ endDate: end }).where(eq(propertyAssignments.id, old.id));
    }
  }
  const [row] = await tx.insert(propertyAssignments).values(o).returning();
  return row;
}

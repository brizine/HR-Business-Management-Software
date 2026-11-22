import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { bulkTagSchema, cancelReasonSchema, tagSchema } from "@crewdesk/shared";
import { db } from "../db";
import { cancellationReasons, crmTags, customerCredits, customers, invoices, properties, tagEvents } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { reasonsFor, recordTagChanges } from "../lib/crm";
import { addSamples } from "../lib/sampleCustomers";

const AREA = "customers" as const;

/** Customer-system settings: tags, cancellation reasons, and the sample customers used for testing. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  /* ── Tags ── */

  app.get("/tags", async (req) => {
    const counts = sql<number>`(select count(*)::int from customers c where c.company_id = "crm_tags"."company_id" and "crm_tags"."id" = any(c.tag_ids))`;
    const pcounts = sql<number>`(select count(*)::int from properties p where p.company_id = "crm_tags"."company_id" and "crm_tags"."id" = any(p.tag_ids))`;
    return db.select({ id: crmTags.id, name: crmTags.name, color: crmTags.color, description: crmTags.description, archived: crmTags.archived, customers: counts, properties: pcounts })
      .from(crmTags).where(eq(crmTags.companyId, req.user.companyId)).orderBy(asc(sql`lower(${crmTags.name})`));
  });

  app.post("/tags", admin, async (req) => {
    const body = parse(tagSchema, req.body);
    const [t] = await db.insert(crmTags).values({ ...body, companyId: req.user.companyId }).returning();
    return t;
  });

  app.put<{ Params: { id: string } }>("/tags/:id", admin, async (req) => {
    const body = parse(tagSchema, req.body);
    const [t] = await db.update(crmTags).set(body).where(and(eq(crmTags.id, req.params.id), eq(crmTags.companyId, req.user.companyId))).returning();
    if (!t) throw new HttpError(404, "Tag not found");
    return t;
  });

  /** Merges one tag into another: everything tagged with it gets the other tag, then it's removed. */
  app.post<{ Params: { id: string } }>("/tags/:id/merge", admin, async (req) => {
    const { intoId } = parse(z.object({ intoId: z.string().uuid() }), req.body);
    const { companyId } = req.user;
    if (intoId === req.params.id) throw new HttpError(400, "Choose a different tag to merge into");
    await db.transaction(async (tx) => {
      const both = await tx.select({ id: crmTags.id }).from(crmTags).where(and(eq(crmTags.companyId, companyId), inArray(crmTags.id, [req.params.id, intoId])));
      if (both.length !== 2) throw new HttpError(404, "Tag not found");
      for (const table of [customers, properties] as const) {
        await tx.update(table).set({
          tagIds: sql`array(select distinct unnest(array_replace(${table.tagIds}, ${req.params.id}::uuid, ${intoId}::uuid)))`,
        }).where(and(eq(table.companyId, companyId), sql`${req.params.id}::uuid = any(${table.tagIds})`));
      }
      await tx.delete(crmTags).where(eq(crmTags.id, req.params.id));
    });
    return { ok: true };
  });

  /** Adds or removes one tag on many customers and properties at once (recorded as "bulk"). */
  app.post("/tags/apply", async (req) => {
    const body = parse(bulkTagSchema, req.body);
    const { companyId, sub } = req.user;
    const [tag] = await db.select().from(crmTags).where(and(eq(crmTags.id, body.tagId), eq(crmTags.companyId, companyId)));
    if (!tag) throw new HttpError(404, "Tag not found");
    if (tag.archived && body.action === "add") throw new HttpError(400, "That tag is archived");
    let changed = 0;
    await db.transaction(async (tx) => {
      for (const [table, ids, key] of [[customers, body.customerIds, "customerId"], [properties, body.propertyIds, "propertyId"]] as const) {
        if (!ids.length) continue;
        const rows = await tx.select({ id: table.id, tagIds: table.tagIds }).from(table).where(and(eq(table.companyId, companyId), inArray(table.id, ids)));
        for (const r of rows) {
          const has = r.tagIds.includes(tag.id);
          if (has === (body.action === "add")) continue;
          const after = body.action === "add" ? [...r.tagIds, tag.id] : r.tagIds.filter((t) => t !== tag.id);
          await tx.update(table).set({ tagIds: after }).where(eq(table.id, r.id));
          await recordTagChanges(tx, { companyId, before: r.tagIds, after, [key]: r.id, source: "bulk", byId: sub });
          changed++;
        }
      }
    });
    return { changed };
  });

  /** Recent tag changes (who, when, how) for a customer or property. */
  app.get<{ Querystring: { customerId?: string; propertyId?: string } }>("/tags/history", async (req) => {
    const where = [eq(tagEvents.companyId, req.user.companyId)];
    if (req.query.customerId) where.push(eq(tagEvents.customerId, req.query.customerId));
    else if (req.query.propertyId) where.push(eq(tagEvents.propertyId, req.query.propertyId));
    else throw new HttpError(400, "Say which customer or property");
    return db.select().from(tagEvents).where(and(...where)).orderBy(sql`${tagEvents.createdAt} desc`).limit(100);
  });

  /* ── Cancellation reasons ── */

  app.get("/cancel-reasons", async (req) => reasonsFor(req.user.companyId));

  app.post("/cancel-reasons", admin, async (req) => {
    const body = parse(cancelReasonSchema, req.body);
    const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${cancellationReasons.sortOrder}), -1)::int` }).from(cancellationReasons).where(eq(cancellationReasons.companyId, req.user.companyId));
    const [r] = await db.insert(cancellationReasons).values({ ...body, companyId: req.user.companyId, sortOrder: n + 1 }).returning();
    return r;
  });

  app.put<{ Params: { id: string } }>("/cancel-reasons/:id", admin, async (req) => {
    const body = parse(cancelReasonSchema, req.body);
    const [r] = await db.update(cancellationReasons).set(body).where(and(eq(cancellationReasons.id, req.params.id), eq(cancellationReasons.companyId, req.user.companyId))).returning();
    if (!r) throw new HttpError(404, "Reason not found");
    return r;
  });

  app.put("/cancel-reasons-order", admin, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(200) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.update(cancellationReasons).set({ sortOrder: i }).where(and(eq(cancellationReasons.id, id), eq(cancellationReasons.companyId, req.user.companyId)));
      }
    });
    return reasonsFor(req.user.companyId);
  });

  /* ── Sample customers (for testing; removable in one go) ── */

  app.get("/sample-customers", async (req) => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(eq(customers.companyId, req.user.companyId), eq(customers.sample, true)));
    return { count: n };
  });

  app.post("/sample-customers", admin, async (req) => {
    const { companyId, sub } = req.user;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.sample, true)));
    if (n > 0) throw new HttpError(409, "The sample customers are already here; remove them first to start over");
    const today = await companyToday(companyId);
    const created = await db.transaction(async (tx) => addSamples(tx, companyId, sub, today));
    return { created };
  });

  app.delete("/sample-customers", admin, async (req) => {
    const { companyId } = req.user;
    const removed = await db.transaction(async (tx) => {
      // Their invoices (and payments) and credits go first; they keep customers from being deleted otherwise.
      const samples = () => tx.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.sample, true)));
      await tx.delete(invoices).where(and(eq(invoices.companyId, companyId), inArray(invoices.customerId, samples())));
      await tx.delete(customerCredits).where(and(eq(customerCredits.companyId, companyId), inArray(customerCredits.customerId, samples())));
      const props = await tx.delete(properties).where(and(eq(properties.companyId, companyId), eq(properties.sample, true))).returning({ id: properties.id });
      const custs = await tx.delete(customers).where(and(eq(customers.companyId, companyId), eq(customers.sample, true))).returning({ id: customers.id });
      return { customers: custs.length, properties: props.length };
    });
    return removed;
  });
};

export default routes;

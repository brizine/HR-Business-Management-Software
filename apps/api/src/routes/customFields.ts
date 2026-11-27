import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CUSTOM_FIELDS_MAX, CUSTOM_FIELD_TARGETS, CUSTOM_FIELD_TARGET_LABELS, customFieldSchema, customFieldUpdateSchema, propertyFieldValues, splitPropertyValues,
  type CustomFieldTarget, type CustomValues,
} from "@crewdesk/shared";
import { db } from "../db";
import { assets, customFields, customers, invoices, properties, todoAssignees, todos, visitAssignees, visits } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { asDef, enteredCustom, ensurePropertyFields, fieldsFor, propertyColumnChanges } from "../lib/customFields";
import { HttpError, notFound, parse } from "../lib/errors";
import { todoVisibility } from "./todos";
import { canManageVisits, visitVisibility } from "./visits";

const isTarget = (t: string): t is CustomFieldTarget => (CUSTOM_FIELD_TARGETS as readonly string[]).includes(t);
const asText = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * One record's custom values, if you may see it; `edit` also checks you may change them:
 * customers, properties and invoices: Customers & billing managers; work orders: managers or the
 * crew on it; to-dos: managers, whoever made it or the people it's for; equipment: everyone sees,
 * Fleet managers change.
 */
async function recordValues(req: FastifyRequest, target: CustomFieldTarget, id: string, edit: boolean): Promise<{ values: CustomValues; save: (v: CustomValues, sent?: Record<string, unknown> | null) => Promise<CustomValues | void> }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound("Record");
  const { companyId, sub: me } = req.user;
  const deny = () => { throw new HttpError(403, "You don't have access to change these"); };
  switch (target) {
    case "property": {
      // A property's fields include Crewdesk's own (Map Code, the sizes, Gate Code …): those read and write the property itself.
      if (!isManager(req, "customers")) throw new HttpError(403, "This needs Customers & billing access");
      const [row] = await db.select().from(properties).where(and(eq(properties.id, id), eq(properties.companyId, companyId)));
      if (!row) notFound("Property");
      const fields = await fieldsFor(companyId, "property");
      return {
        values: propertyFieldValues(fields, row),
        save: async (v, sent) => {
          const { columns, custom } = splitPropertyValues(fields, sent, v);
          const [u] = await db.update(properties).set({ custom, ...propertyColumnChanges(row, columns), updatedAt: new Date() }).where(eq(properties.id, id)).returning();
          return propertyFieldValues(fields, u);
        },
      };
    }
    case "customer":
    case "invoice": {
      if (!isManager(req, "customers")) throw new HttpError(403, "This needs Customers & billing access");
      const table = target === "customer" ? customers : invoices;
      const [row] = await db.select({ custom: table.custom }).from(table).where(and(eq(table.id, id), eq(table.companyId, companyId)));
      if (!row) notFound(target === "customer" ? "Customer" : "Invoice");
      return { values: row.custom, save: async (v) => { await db.update(table).set({ custom: v }).where(eq(table.id, id)); } };
    }
    case "workorder": {
      const [row] = await db.select({ custom: visits.custom }).from(visits).where(and(eq(visits.id, id), eq(visits.companyId, companyId), visitVisibility(req)));
      if (!row) notFound("Work order");
      if (edit && !canManageVisits(req)) {
        const [crew] = await db.select({ x: visitAssignees.visitId }).from(visitAssignees).where(and(eq(visitAssignees.visitId, id), eq(visitAssignees.employeeId, me)));
        if (!crew) deny();
      }
      return { values: row.custom, save: async (v) => { await db.update(visits).set({ custom: v, updatedAt: new Date() }).where(eq(visits.id, id)); } };
    }
    case "todo": {
      const [row] = await db.select({ custom: todos.custom, createdById: todos.createdById }).from(todos).where(and(eq(todos.id, id), eq(todos.companyId, companyId), todoVisibility(req)));
      if (!row) notFound("To-do");
      if (edit && !isManager(req, "todos") && row.createdById !== me) {
        const [mine] = await db.select({ x: todoAssignees.todoId }).from(todoAssignees).where(and(eq(todoAssignees.todoId, id), eq(todoAssignees.employeeId, me)));
        if (!mine) deny();
      }
      return { values: row.custom, save: async (v) => { await db.update(todos).set({ custom: v, updatedAt: new Date() }).where(eq(todos.id, id)); } };
    }
    case "asset": {
      const [row] = await db.select({ custom: assets.custom }).from(assets).where(and(eq(assets.id, id), eq(assets.companyId, companyId)));
      if (!row) notFound("Equipment");
      if (edit && !isManager(req, "fleet")) deny();
      return { values: row.custom, save: async (v) => { await db.update(assets).set({ custom: v }).where(eq(assets.id, id)); } };
    }
  }
}

/**
 * Custom fields (Homeworks' Custom Fields page): everyone signed in can read the fields (so forms
 * and job sheets can show them); owners and admins add, change, order and delete them.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { appliesTo?: string } }>("/", async (req) => {
    const where = [eq(customFields.companyId, req.user.companyId)];
    if (req.query.appliesTo && isTarget(req.query.appliesTo)) where.push(eq(customFields.appliesTo, req.query.appliesTo));
    // A property's list includes Crewdesk's own fields.
    if (!req.query.appliesTo || req.query.appliesTo === "property") await ensurePropertyFields(req.user.companyId);
    const rows = await db.select().from(customFields).where(and(...where)).orderBy(customFields.appliesTo, customFields.sortOrder, customFields.name);
    return rows.map(asDef);
  });

  const uniqueName = async (companyId: string, appliesTo: string, name: string, notId?: string) => {
    const [dupe] = await db.select({ id: customFields.id }).from(customFields)
      .where(and(eq(customFields.companyId, companyId), eq(customFields.appliesTo, appliesTo), sql`lower(${customFields.name}) = lower(${name})`, notId ? ne(customFields.id, notId) : undefined));
    if (dupe) throw new HttpError(400, `There's already a field called "${name}" on ${CUSTOM_FIELD_TARGET_LABELS[appliesTo as CustomFieldTarget].toLowerCase()}`);
  };

  app.post("/", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(customFieldSchema, req.body);
    const { companyId } = req.user;
    await uniqueName(companyId, body.appliesTo, body.name);
    const [{ n, top }] = await db.select({ n: sql<number>`count(*)::int`, top: max(customFields.sortOrder) }).from(customFields)
      .where(and(eq(customFields.companyId, companyId), eq(customFields.appliesTo, body.appliesTo), isNull(customFields.builtin)));
    if (n >= CUSTOM_FIELDS_MAX) throw new HttpError(400, `Up to ${CUSTOM_FIELDS_MAX} custom fields on ${CUSTOM_FIELD_TARGET_LABELS[body.appliesTo].toLowerCase()}`);
    const [row] = await db.insert(customFields).values({
      companyId, appliesTo: body.appliesTo, name: body.name, type: body.type, options: body.type === "select" ? body.options : [],
      defaultValue: asText(body.defaultValue), transferable: body.transferable, sortOrder: (top ?? -1) + 1,
    }).returning();
    return asDef(row);
  });

  /** Rename, change the choices, the default value or transferable (Homeworks edits these in the list). */
  app.put<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(customFieldUpdateSchema, req.body);
    const [f] = await db.select().from(customFields).where(and(eq(customFields.id, req.params.id), eq(customFields.companyId, req.user.companyId)));
    if (!f) notFound("Custom field");
    if (body.name) await uniqueName(req.user.companyId, f.appliesTo, body.name, f.id);
    // Check the default (and choices) against the field's own type.
    const check = customFieldSchema.safeParse({
      appliesTo: f.appliesTo, type: f.type, name: body.name ?? f.name, options: body.options ?? f.options, transferable: body.transferable ?? f.transferable,
      defaultValue: body.defaultValue !== undefined ? body.defaultValue : f.defaultValue,
    });
    if (!check.success) throw new HttpError(400, check.error.issues[0].message);
    const [row] = await db.update(customFields).set({
      ...(body.name ? { name: body.name } : {}),
      ...(body.options && f.type === "select" ? { options: body.options } : {}),
      ...(body.defaultValue !== undefined ? { defaultValue: asText(body.defaultValue) } : {}),
      ...(body.transferable !== undefined ? { transferable: body.transferable } : {}),
    }).where(eq(customFields.id, f.id)).returning();
    return asDef(row);
  });

  /** Their order on forms and pages. */
  app.put("/order", { preHandler: requireRole("admin") }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(CUSTOM_FIELDS_MAX * CUSTOM_FIELD_TARGETS.length) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(customFields).set({ sortOrder: i }).where(and(eq(customFields.id, id), eq(customFields.companyId, req.user.companyId)));
    });
    return { ok: true };
  });

  /** Deleting a field hides its values everywhere (one, or several at once). */
  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin") }, async (req) => {
    const [f] = await db.select().from(customFields).where(and(eq(customFields.id, req.params.id), eq(customFields.companyId, req.user.companyId)));
    if (!f) notFound("Custom field");
    if (f.builtin) throw new HttpError(400, `Crewdesk uses "${f.name}" itself, so it can't be deleted. You can rename it, or hide it from the property page in the layout editor.`);
    await db.delete(customFields).where(eq(customFields.id, f.id));
    return { deleted: 1 };
  });
  app.post("/delete", { preHandler: requireRole("admin") }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1, "Pick the fields to delete").max(300) }), req.body);
    // Crewdesk's own property fields stay (they're skipped, and counted so the page can say so).
    const rows = await db.delete(customFields).where(and(inArray(customFields.id, ids), eq(customFields.companyId, req.user.companyId), isNull(customFields.builtin))).returning({ id: customFields.id });
    const [{ kept }] = await db.select({ kept: sql<number>`count(*)::int` }).from(customFields)
      .where(and(inArray(customFields.id, ids), eq(customFields.companyId, req.user.companyId)));
    return { deleted: rows.length, kept };
  });

  // ---- One record's values (Homeworks' "Save Custom Fields" on a property).

  app.get<{ Params: { target: string; id: string } }>("/values/:target/:id", async (req) => {
    if (!isTarget(req.params.target)) notFound("Record");
    return (await recordValues(req, req.params.target, req.params.id, false)).values;
  });
  /** { values: { fieldId: value } }: fields left out keep their value; blank clears one. */
  app.put<{ Params: { target: string; id: string } }>("/values/:target/:id", async (req) => {
    if (!isTarget(req.params.target)) notFound("Record");
    const target = req.params.target;
    const rec = await recordValues(req, target, req.params.id, true);
    const sent = (req.body as { values?: unknown } | null)?.values;
    const values = await enteredCustom(req.user.companyId, target, sent, rec.values);
    return (await rec.save(values, sent && typeof sent === "object" ? (sent as Record<string, unknown>) : null)) ?? values;
  });
};

export default routes;

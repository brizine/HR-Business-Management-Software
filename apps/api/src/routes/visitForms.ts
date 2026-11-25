import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { cleanFormDef, formCopyName, formFieldCount, visitFormSchema } from "@crewdesk/shared";
import { db } from "../db";
import { visitFormEntries, visitForms } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { formUse, refreshUnfilled } from "../lib/visitForms";

const AREA = "customers" as const;

/**
 * Marketing → Visit Forms (like Homeworks): the forms crews fill in on work orders. Filling one
 * in is on the work order itself (/visits/:id/forms).
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  const find = async (companyId: string, id: string) => {
    const [f] = /^[0-9a-f-]{36}$/i.test(id) ? await db.select().from(visitForms).where(and(eq(visitForms.id, id), eq(visitForms.companyId, companyId))) : [];
    if (!f) throw new HttpError(404, "Form not found");
    return f;
  };
  /** Homeworks' message for a name that's taken. */
  const checkName = async (companyId: string, name: string, exceptId?: string) => {
    const [same] = await db.select({ id: visitForms.id }).from(visitForms).where(and(eq(visitForms.companyId, companyId), sql`lower(${visitForms.name}) = ${name.toLowerCase()}`));
    if (same && same.id !== exceptId) throw new HttpError(400, "Form name exists, please change");
  };

  app.get("/", async (req) => {
    const { companyId } = req.user;
    const use = await formUse(companyId);
    const rows = await db.select().from(visitForms).where(eq(visitForms.companyId, companyId)).orderBy(asc(sql`lower(${visitForms.name})`));
    return rows.map((f) => ({
      id: f.id, name: f.name, autoAttach: f.autoAttach, updatedAt: f.updatedAt, fields: formFieldCount(f.def), signature: f.def.signature,
      linked: use.get(f.id)?.linked ?? 0, submitted: use.get(f.id)?.submitted ?? 0,
    }));
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const f = await find(req.user.companyId, req.params.id);
    const use = (await formUse(req.user.companyId)).get(f.id);
    return { id: f.id, name: f.name, def: f.def, autoAttach: f.autoAttach, updatedAt: f.updatedAt, linked: use?.linked ?? 0, submitted: use?.submitted ?? 0 };
  });

  app.post("/", async (req) => {
    const b = parse(visitFormSchema, req.body);
    const { companyId, sub } = req.user;
    await checkName(companyId, b.name);
    const [f] = await db.insert(visitForms).values({ companyId, name: b.name, def: cleanFormDef(b.def), autoAttach: b.autoAttach, createdById: sub, updatedById: sub }).returning();
    return { id: f.id, name: f.name, def: f.def, autoAttach: f.autoAttach };
  });

  /** Changing a form changes the copies on work orders that nobody has submitted yet. */
  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const b = parse(visitFormSchema, req.body);
    const { companyId, sub } = req.user;
    const f = await find(companyId, req.params.id);
    await checkName(companyId, b.name, f.id);
    const def = cleanFormDef(b.def);
    await db.transaction(async (tx) => {
      await tx.update(visitForms).set({ name: b.name, def, autoAttach: b.autoAttach, updatedById: sub, updatedAt: new Date() }).where(eq(visitForms.id, f.id));
      await refreshUnfilled(tx, f.id, b.name, def);
    });
    return { id: f.id, name: b.name, def, autoAttach: b.autoAttach };
  });

  /** Homeworks' Duplicate Form. The copy doesn't attach itself to new work orders until it's told to. */
  app.post<{ Params: { id: string } }>("/:id/copy", async (req) => {
    const { companyId, sub } = req.user;
    const f = await find(companyId, req.params.id);
    const taken = (await db.select({ name: visitForms.name }).from(visitForms).where(eq(visitForms.companyId, companyId))).map((x) => x.name);
    const [copy] = await db.insert(visitForms).values({ companyId, name: formCopyName(f.name, taken), def: f.def, autoAttach: false, createdById: sub, updatedById: sub }).returning();
    return { id: copy.id, name: copy.name };
  });

  /** Deleting a form takes it off the work orders where it hasn't been submitted; submitted ones stay. */
  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const f = await find(req.user.companyId, req.params.id);
    const removed = await db.transaction(async (tx) => {
      const gone = await tx.delete(visitFormEntries).where(and(eq(visitFormEntries.formId, f.id), isNull(visitFormEntries.submittedAt))).returning({ id: visitFormEntries.id });
      await tx.delete(visitForms).where(eq(visitForms.id, f.id));
      return gone.length;
    });
    return { ok: true, removed };
  });
};

export default routes;

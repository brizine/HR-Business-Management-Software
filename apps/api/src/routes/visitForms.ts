import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { cleanFormDef, csvRow, formCopyName, formFieldCount, formHasFlags, formTagIds, visitFormSchema, visitNumber, type FormDef } from "@crewdesk/shared";
import { db } from "../db";
import { companies, crmTags, employees, serviceTypes, visitFormEntries, visitForms } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { answerPairs, formUse, refreshUnfilled, submittedForms, type SubmittedFilter } from "../lib/visitForms";

const AREA = "customers" as const;

/**
 * Resources → Visit Forms (like Homeworks): the forms crews fill in on work orders. Filling one
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

  /** The services a form is tied to and the tags its flags add must be the company's own. */
  const checkLinks = async (companyId: string, serviceTypeIds: string[], def: FormDef) => {
    const svc = [...new Set(serviceTypeIds)];
    if (svc.length && (await db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, svc)))).length !== svc.length) {
      throw new HttpError(400, "One of those services isn't on the price list");
    }
    const tags = formTagIds(def);
    if (tags.length && (await db.select({ id: crmTags.id }).from(crmTags).where(and(eq(crmTags.companyId, companyId), inArray(crmTags.id, tags)))).length !== tags.length) {
      throw new HttpError(400, "One of those tags doesn't exist");
    }
    return svc;
  };
  const settings = (f: typeof visitForms.$inferSelect) => ({ mustSubmit: !!f.def.mustSubmit, emailCopy: !!f.def.emailCopy, flags: formHasFlags(f.def), serviceTypeIds: f.serviceTypeIds ?? [] });

  /* ── Submitted forms: the report, and a customer's ── */

  const filterOf = (q: Record<string, string | undefined>): SubmittedFilter => ({
    name: q.name || undefined, customerId: q.customerId, from: q.from, to: q.to, byId: q.byId, q: q.q,
    limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
  });
  const summary = (pairs: [string, string][]) => pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ").slice(0, 300);

  app.get<{ Querystring: Record<string, string | undefined> }>("/submitted", async (req) => {
    const { companyId } = req.user;
    const r = await submittedForms(companyId, filterOf(req.query));
    return {
      total: r.total,
      rows: r.rows.map(({ def, answers, signature: _s, signatures, ...row }) => ({ ...row, summary: summary(answerPairs(def, answers, signatures)) })),
    };
  });

  /** What the report can be narrowed by: the forms that have been submitted, and who submitted them. */
  app.get("/submitted/filters", async (req) => {
    const { companyId } = req.user;
    const names = await db.selectDistinct({ name: visitFormEntries.name }).from(visitFormEntries).where(and(eq(visitFormEntries.companyId, companyId), isNotNull(visitFormEntries.submittedAt))).orderBy(asc(visitFormEntries.name));
    const people = await db.selectDistinct({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(visitFormEntries)
      .innerJoin(employees, eq(employees.id, visitFormEntries.submittedById)).where(and(eq(visitFormEntries.companyId, companyId), isNotNull(visitFormEntries.submittedAt))).orderBy(asc(employees.firstName));
    return { names: names.map((n) => n.name), people: people.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` })) };
  });

  /** The same list as a spreadsheet: one row per submitted form, one column per question. */
  app.get<{ Querystring: Record<string, string | undefined> }>("/submitted/export", async (req, reply) => {
    const r = await submittedForms(req.user.companyId, { ...filterOf(req.query), limit: 5000, offset: 0 });
    const rows = r.rows.map((x) => ({ x, pairs: [...answerPairs(x.def, x.answers, x.signatures), ...(x.def.signature ? [[x.def.signatureLabel || "Signature", x.signature?.d ? "Signed" : ""] as [string, string]] : [])] }));
    const questions = [...new Set(rows.flatMap((x) => x.pairs.map(([k]) => k)))];
    // Times as the office reads them (the company's time zone), in a form a spreadsheet takes as a date.
    const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, req.user.companyId));
    const local = (d: Date) => d.toLocaleString("sv-SE", { timeZone: co?.tz ?? "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const out = [csvRow(["Submitted", "Form", "Work order", "Work order title", "Work order date", "Customer", "Property", "Submitted by", "Emailed to customer", ...questions])];
    for (const { x, pairs } of rows) {
      const byQ = new Map(pairs);
      out.push(csvRow([
        local(x.submittedAt), x.name, visitNumber(x.workOrder.number), x.workOrder.title, x.workOrder.date ?? "", x.customer.name, x.address, x.submittedBy ?? "",
        x.emailedAt ? local(x.emailedAt) : "", ...questions.map((k) => byQ.get(k) ?? ""),
      ]));
    }
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="visit-forms-${new Date().toISOString().slice(0, 10)}.csv"`);
    return `\uFEFF${out.join("\r\n")}\r\n`;
  });

  app.get("/", async (req) => {
    const { companyId } = req.user;
    const use = await formUse(companyId);
    const rows = await db.select().from(visitForms).where(eq(visitForms.companyId, companyId)).orderBy(asc(sql`lower(${visitForms.name})`));
    return rows.map((f) => ({
      id: f.id, name: f.name, autoAttach: f.autoAttach, updatedAt: f.updatedAt, fields: formFieldCount(f.def), signature: f.def.signature,
      linked: use.get(f.id)?.linked ?? 0, submitted: use.get(f.id)?.submitted ?? 0, ...settings(f),
    }));
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const f = await find(req.user.companyId, req.params.id);
    const use = (await formUse(req.user.companyId)).get(f.id);
    return { id: f.id, name: f.name, def: f.def, autoAttach: f.autoAttach, serviceTypeIds: f.serviceTypeIds ?? [], updatedAt: f.updatedAt, linked: use?.linked ?? 0, submitted: use?.submitted ?? 0 };
  });

  app.post("/", async (req) => {
    const b = parse(visitFormSchema, req.body);
    const { companyId, sub } = req.user;
    await checkName(companyId, b.name);
    const def = cleanFormDef(b.def);
    const serviceTypeIds = await checkLinks(companyId, b.serviceTypeIds, def);
    const [f] = await db.insert(visitForms).values({ companyId, name: b.name, def, autoAttach: b.autoAttach, serviceTypeIds, createdById: sub, updatedById: sub }).returning();
    return { id: f.id, name: f.name, def: f.def, autoAttach: f.autoAttach, serviceTypeIds: f.serviceTypeIds };
  });

  /** Changing a form changes the copies on work orders that nobody has submitted yet. */
  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const b = parse(visitFormSchema, req.body);
    const { companyId, sub } = req.user;
    const f = await find(companyId, req.params.id);
    await checkName(companyId, b.name, f.id);
    const def = cleanFormDef(b.def);
    const serviceTypeIds = await checkLinks(companyId, b.serviceTypeIds, def);
    await db.transaction(async (tx) => {
      await tx.update(visitForms).set({ name: b.name, def, autoAttach: b.autoAttach, serviceTypeIds, updatedById: sub, updatedAt: new Date() }).where(eq(visitForms.id, f.id));
      await refreshUnfilled(tx, f.id, b.name, def);
    });
    return { id: f.id, name: b.name, def, autoAttach: b.autoAttach, serviceTypeIds };
  });

  /** Homeworks' Duplicate Form. The copy doesn't attach itself to new work orders until it's told to. */
  app.post<{ Params: { id: string } }>("/:id/copy", async (req) => {
    const { companyId, sub } = req.user;
    const f = await find(companyId, req.params.id);
    const taken = (await db.select({ name: visitForms.name }).from(visitForms).where(eq(visitForms.companyId, companyId))).map((x) => x.name);
    const [copy] = await db.insert(visitForms).values({ companyId, name: formCopyName(f.name, taken), def: f.def, autoAttach: false, serviceTypeIds: [], createdById: sub, updatedById: sub }).returning();
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

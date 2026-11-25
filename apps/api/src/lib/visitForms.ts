import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FormDef } from "@crewdesk/shared";
import { db } from "../db";
import { employees, visitFormEntries, visitForms } from "../db/schema";
import type { Tx } from "./crm";
import { HttpError } from "./errors";

/**
 * Visit forms on work orders. A work order gets its own copy of each form picked for it; the
 * copy follows the form until the crew submits it, and then stays as it was answered.
 */

type Db = Tx | typeof db;

/** The forms that go on every new work order. */
export async function autoFormIds(companyId: string): Promise<string[]> {
  return (await db.select({ id: visitForms.id }).from(visitForms).where(and(eq(visitForms.companyId, companyId), eq(visitForms.autoAttach, true))).orderBy(asc(visitForms.name))).map((f) => f.id);
}

/** The company's forms among these ids (a wrong id is refused). */
export async function formsFor(companyId: string, ids: string[]) {
  const want = [...new Set(ids)];
  if (!want.length) return [];
  const found = await db.select().from(visitForms).where(and(eq(visitForms.companyId, companyId), inArray(visitForms.id, want)));
  if (found.length !== want.length) throw new HttpError(400, "One of those visit forms doesn't exist");
  return want.map((id) => found.find((f) => f.id === id)!);
}

/**
 * Makes these work orders' forms match the ones picked: new ones are added; ones taken off are
 * removed unless they've been submitted (a submitted form stays on its work order).
 */
export async function syncVisitForms(tx: Db, companyId: string, visitIds: string[], forms: { id: string; name: string; def: FormDef }[]) {
  if (!visitIds.length) return;
  const have = await tx.select({ id: visitFormEntries.id, visitId: visitFormEntries.visitId, formId: visitFormEntries.formId, submittedAt: visitFormEntries.submittedAt })
    .from(visitFormEntries).where(inArray(visitFormEntries.visitId, visitIds));
  const want = new Set(forms.map((f) => f.id));
  const gone = have.filter((e) => !e.submittedAt && (!e.formId || !want.has(e.formId))).map((e) => e.id);
  if (gone.length) await tx.delete(visitFormEntries).where(inArray(visitFormEntries.id, gone));
  const rows = visitIds.flatMap((visitId) => forms.filter((f) => !have.some((e) => e.visitId === visitId && e.formId === f.id)).map((f) => ({ companyId, visitId, formId: f.id, name: f.name, def: f.def })));
  if (rows.length) await tx.insert(visitFormEntries).values(rows);
}

export interface VisitFormRow { id: string; formId: string | null; name: string; submitted: boolean; submittedAt: Date | null; submittedBy: string | null; updatedAt: Date }

/** Each work order's forms, in the order they were put on it (for lists and the work order page). */
export async function formsByVisit(visitIds: string[]): Promise<Map<string, VisitFormRow[]>> {
  const out = new Map<string, VisitFormRow[]>();
  if (!visitIds.length) return out;
  const rows = await db.select({
    id: visitFormEntries.id, visitId: visitFormEntries.visitId, formId: visitFormEntries.formId, name: visitFormEntries.name,
    submittedAt: visitFormEntries.submittedAt, updatedAt: visitFormEntries.updatedAt, firstName: employees.firstName, lastName: employees.lastName,
  }).from(visitFormEntries).leftJoin(employees, eq(employees.id, visitFormEntries.submittedById))
    .where(inArray(visitFormEntries.visitId, visitIds)).orderBy(asc(visitFormEntries.createdAt), asc(visitFormEntries.name));
  for (const r of rows) {
    const list = out.get(r.visitId) ?? [];
    list.push({ id: r.id, formId: r.formId, name: r.name, submitted: !!r.submittedAt, submittedAt: r.submittedAt, submittedBy: r.firstName ? `${r.firstName} ${r.lastName}` : null, updatedAt: r.updatedAt });
    out.set(r.visitId, list);
  }
  return out;
}

/** After a form is changed: the copies nobody has submitted yet take the new questions and name. */
export async function refreshUnfilled(tx: Db, formId: string, name: string, def: FormDef) {
  await tx.update(visitFormEntries).set({ name, def, updatedAt: new Date() }).where(and(eq(visitFormEntries.formId, formId), isNull(visitFormEntries.submittedAt)));
}

/** How many work orders each form is on, and on how many it's been submitted. */
export async function formUse(companyId: string): Promise<Map<string, { linked: number; submitted: number }>> {
  const rows = await db.select({ formId: visitFormEntries.formId, linked: sql<number>`count(*)::int`, submitted: sql<number>`count(${visitFormEntries.submittedAt})::int` })
    .from(visitFormEntries).where(eq(visitFormEntries.companyId, companyId)).groupBy(visitFormEntries.formId);
  return new Map(rows.filter((r) => r.formId).map((r) => [r.formId!, { linked: r.linked, submitted: r.submitted }]));
}

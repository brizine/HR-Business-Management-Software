import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  INACTIVE_STATUSES, VISIT_FORM_TEMPLATE_KEY, customerName, flaggedAnswers, formAnswerText, formFields, formatAddress, visitNumber,
  type FormAnswers, type FormChange, type FormDef,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, crmTags, customers, employees, invoices, properties, templates, todoAssignees, todos, visitFiles, visitFormEntries, visitFormHistory, visitForms, visits } from "../db/schema";
import { emailTransport, isUndeliverable } from "./channels";
import { recordTagChanges, type Tx } from "./crm";
import { letterCompany } from "./docs";
import { HttpError } from "./errors";
import { notify } from "./notify";
import { companyToday } from "./payRates";
import { storage } from "./storage";
import { ensureSystemTemplates, sendTemplateEmail } from "./templates";
import { visitFormPdf } from "./visitFormPdf";

/**
 * Visit forms on work orders. A work order gets its own copy of each form picked for it; the
 * copy follows the form until the crew submits it, and then stays as it was answered.
 */

type Db = Tx | typeof db;

/** The forms a new work order gets by itself: the ones set for every work order, and the ones tied to one of its services. */
export async function autoFormIds(companyId: string, serviceTypeIds: string[] = []): Promise<string[]> {
  const svc = [...new Set(serviceTypeIds)].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const byService = svc.length ? sql`${visitForms.serviceTypeIds} && ARRAY[${sql.join(svc.map((x) => sql`${x}::uuid`), sql`, `)}]` : sql`false`;
  return (await db.select({ id: visitForms.id }).from(visitForms).where(and(eq(visitForms.companyId, companyId), or(eq(visitForms.autoAttach, true), byService))).orderBy(asc(visitForms.name))).map((f) => f.id);
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

export interface VisitFormRow { id: string; formId: string | null; name: string; submitted: boolean; submittedAt: Date | null; submittedBy: string | null; updatedAt: Date; /** Needed before the work order can be marked Completed. */ mustSubmit: boolean }

/** Each work order's forms, in the order they were put on it (for lists and the work order page). */
export async function formsByVisit(visitIds: string[]): Promise<Map<string, VisitFormRow[]>> {
  const out = new Map<string, VisitFormRow[]>();
  if (!visitIds.length) return out;
  const rows = await db.select({
    id: visitFormEntries.id, visitId: visitFormEntries.visitId, formId: visitFormEntries.formId, name: visitFormEntries.name,
    mustSubmit: sql<boolean>`coalesce((${visitFormEntries.def}->>'mustSubmit')::boolean, false)`,
    submittedAt: visitFormEntries.submittedAt, updatedAt: visitFormEntries.updatedAt, firstName: employees.firstName, lastName: employees.lastName,
  }).from(visitFormEntries).leftJoin(employees, eq(employees.id, visitFormEntries.submittedById))
    .where(inArray(visitFormEntries.visitId, visitIds)).orderBy(asc(visitFormEntries.createdAt), asc(visitFormEntries.name));
  for (const r of rows) {
    const list = out.get(r.visitId) ?? [];
    list.push({ id: r.id, formId: r.formId, name: r.name, submitted: !!r.submittedAt, submittedAt: r.submittedAt, submittedBy: r.firstName ? `${r.firstName} ${r.lastName}` : null, updatedAt: r.updatedAt, mustSubmit: !!r.mustSubmit });
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

/* ───────────── Locked once invoiced ───────────── */

/** A work order on a live invoice: its forms can't be changed (void the invoice first, as with reopening it). */
export async function formsLocked(v: { invoiceId: string | null }): Promise<boolean> {
  if (!v.invoiceId) return false;
  return (await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, v.invoiceId), sql`${invoices.status} <> 'void'`))).length > 0;
}

/** The forms that must be in before this work order can be marked Completed, and aren't yet. */
export async function formsStillNeeded(visitId: string): Promise<string[]> {
  const rows = await db.select({ name: visitFormEntries.name, def: visitFormEntries.def }).from(visitFormEntries).where(and(eq(visitFormEntries.visitId, visitId), isNull(visitFormEntries.submittedAt)));
  return rows.filter((r) => r.def.mustSubmit).map((r) => r.name);
}

/* ───────────── History ───────────── */

export async function addFormHistory(tx: Db, o: { companyId: string; entryId: string; action: "submitted" | "updated" | "emailed"; byId: string | null; changes?: FormChange[]; detail?: string | null }) {
  await tx.insert(visitFormHistory).values({ companyId: o.companyId, entryId: o.entryId, action: o.action, byId: o.byId, changes: o.changes?.length ? o.changes : null, detail: o.detail ?? null });
}
export async function formHistory(entryId: string) {
  const rows = await db.select({ h: visitFormHistory, firstName: employees.firstName, lastName: employees.lastName }).from(visitFormHistory)
    .leftJoin(employees, eq(employees.id, visitFormHistory.byId)).where(eq(visitFormHistory.entryId, entryId)).orderBy(asc(visitFormHistory.createdAt));
  return rows.map(({ h, firstName, lastName }) => ({ id: h.id, action: h.action, at: h.createdAt, by: firstName ? `${firstName} ${lastName}` : null, changes: h.changes ?? [], detail: h.detail }));
}

/* ───────────── Flagged answers: a tag, a to-do ───────────── */

type Entry = typeof visitFormEntries.$inferSelect;
type Visit = typeof visits.$inferSelect;

/**
 * Acts on the flagged choices picked on a form, once each: a choice's tag goes on the customer
 * (which a "tag added" automation can follow) and on the work order; a choice's to-do is made for
 * the office, given to whoever scheduled the work order. Returns what it did, in words.
 */
export async function applyFlags(e: Entry, v: Visit, answers: FormAnswers, byId: string): Promise<string[]> {
  const done = new Set(e.flagged ?? []);
  const flags = flaggedAnswers(e.def, answers).filter((f) => !done.has(f.optionId));
  if (!flags.length) return [];
  const did: string[] = [];
  const want = [...new Set(flags.map((f) => f.tagId).filter((t): t is string => !!t))];
  const tags = want.length ? await db.select({ id: crmTags.id, name: crmTags.name }).from(crmTags).where(and(eq(crmTags.companyId, e.companyId), inArray(crmTags.id, want))) : [];
  const [by] = await db.select({ firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(eq(employees.id, byId));
  const [cust] = await db.select().from(customers).where(eq(customers.id, v.customerId));
  // To-dos go to whoever scheduled the work order (if they're still on the team).
  const [owner] = v.createdById ? await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, v.createdById), notInArray(employees.status, INACTIVE_STATUSES))) : [];
  const today = await companyToday(e.companyId);
  const made: { id: string; title: string }[] = [];
  await db.transaction(async (tx) => {
    if (tags.length && cust) {
      const after = [...new Set([...cust.tagIds, ...tags.map((t) => t.id)])];
      if (after.length !== cust.tagIds.length) {
        await tx.update(customers).set({ tagIds: after, updatedAt: new Date() }).where(eq(customers.id, cust.id));
        await recordTagChanges(tx, { companyId: e.companyId, before: cust.tagIds, after, customerId: cust.id, source: "form", byId });
      }
      const onVisit = [...new Set([...(v.tagIds ?? []), ...tags.map((t) => t.id)])];
      if (onVisit.length !== (v.tagIds ?? []).length) await tx.update(visits).set({ tagIds: onVisit, updatedAt: new Date() }).where(eq(visits.id, v.id));
      did.push(...tags.map((t) => `Tag "${t.name}" added`));
    }
    for (const f of flags.filter((x) => x.todo)) {
      const title = `${e.name}: ${f.question ? `${f.question}: ` : ""}${f.answer}`.slice(0, 200);
      const notes = `From the visit form "${e.name}" on ${visitNumber(v.number)} ${v.title}${cust ? ` for ${customerName(cust)}` : ""}${by ? `, filled in by ${by.firstName} ${by.lastName}` : ""}.`;
      const [t] = await tx.insert(todos).values({ companyId: e.companyId, title, notes, customerId: v.customerId, propertyId: v.propertyId, date: today, createdById: byId }).returning();
      if (owner) await tx.insert(todoAssignees).values({ todoId: t.id, employeeId: owner.id }).onConflictDoNothing();
      made.push({ id: t.id, title });
      did.push(`To-do made: ${title}`);
    }
    await tx.update(visitFormEntries).set({ flagged: [...done, ...flags.map((f) => f.optionId)] }).where(eq(visitFormEntries.id, e.id));
  });
  for (const t of made) if (owner && owner.id !== byId) notify(e.companyId, [owner.id], { category: "todos", title: `New to-do: ${t.title}`, body: `From a visit form on ${visitNumber(v.number)}.`, link: { screen: "todos", id: t.id } });
  return did;
}

/* ───────────── The PDF, and the customer's copy by email ───────────── */

const stamp = (d: Date, tz: string) => d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A form on a work order as a PDF (blank if it hasn't been submitted). */
export async function entryPdf(e: Entry): Promise<{ pdf: Uint8Array; fileName: string }> {
  const [v] = await db.select().from(visits).where(eq(visits.id, e.visitId));
  const [cust] = await db.select().from(customers).where(eq(customers.id, v.customerId));
  const [prop] = v.propertyId ? await db.select().from(properties).where(eq(properties.id, v.propertyId)) : [];
  const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, e.companyId));
  const [by] = e.submittedById ? await db.select({ firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(eq(employees.id, e.submittedById)) : [];
  // The pictures on its photo questions (the work order's own files).
  const ids = [...new Set(formFields(e.def).filter((f) => f.type === "photo").flatMap((f) => (Array.isArray(e.answers?.[f.id]) ? (e.answers![f.id] as string[]) : [])))];
  const files = ids.length ? await db.select().from(visitFiles).where(and(eq(visitFiles.visitId, v.id), inArray(visitFiles.id, ids))) : [];
  const photos = new Map<string, { bytes: Buffer; contentType: string }>();
  for (const f of files) {
    if (!/^image\/(jpeg|png)$/.test(f.contentType)) continue;
    try { photos.set(f.id, { bytes: await storage.get(f.storageKey), contentType: f.contentType }); } catch { /* a file that can't be read is named instead of shown */ }
  }
  const pdf = await visitFormPdf({
    company: await letterCompany(e.companyId), name: e.name,
    meta: [
      ["Work order", `${visitNumber(v.number)} ${v.title}`],
      ["Customer", cust ? customerName(cust) : ""],
      ["Property", prop ? formatAddress(prop) : ""],
      ["Date", v.date ? longDay(v.date) : ""],
      ["Submitted", e.submittedAt ? `${by ? `${by.firstName} ${by.lastName}, ` : ""}${stamp(e.submittedAt, co?.tz ?? "America/Chicago")}` : "Not submitted yet"],
    ],
    def: e.def, answers: e.answers ?? {}, signature: e.signature ?? null, signatures: e.signatures ?? {}, photos,
  });
  const safe = e.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "visit-form";
  return { pdf, fileName: `${safe}-${visitNumber(v.number)}.pdf` };
}

/**
 * Emails the customer a copy of a submitted form (the PDF, with the company's "Visit form copy"
 * email from Templates). A service message about their own visit, so it goes even if they've
 * unsubscribed from other email; sample customers and customers with no address are skipped.
 */
export async function emailEntry(entryId: string, byId: string | null): Promise<{ sent: boolean; to?: string; reason?: string }> {
  const [e] = await db.select().from(visitFormEntries).where(eq(visitFormEntries.id, entryId));
  if (!e) return { sent: false, reason: "Form not found" };
  if (!e.submittedAt) return { sent: false, reason: "It hasn't been submitted yet" };
  const [v] = await db.select().from(visits).where(eq(visits.id, e.visitId));
  const [cust] = await db.select().from(customers).where(eq(customers.id, v.customerId));
  const email = cust?.email?.trim() || null;
  const reason = !cust ? "No customer on the work order" : cust.sample ? "Sample customers aren't emailed" : !email ? `${customerName(cust)} has no email address` : isUndeliverable(email) ? "That address can't get email" : !emailTransport() ? "Email isn't set up on this server yet" : null;
  if (reason) return { sent: false, reason };
  await ensureSystemTemplates(e.companyId);
  const [tpl] = await db.select().from(templates).where(and(eq(templates.companyId, e.companyId), eq(templates.systemKey, VISIT_FORM_TEMPLATE_KEY)));
  if (!tpl) return { sent: false, reason: "The visit form email template is missing" };
  const { pdf, fileName } = await entryPdf(e);
  await sendTemplateEmail({
    companyId: e.companyId, template: tpl, to: email!, ctx: { customerId: cust.id, visitId: v.id }, transactional: true, vars: { VISIT_FORM_NAME: e.name },
    attachments: [{ filename: fileName, content: Buffer.from(pdf), contentType: "application/pdf" }],
  });
  await db.transaction(async (tx) => {
    await tx.update(visitFormEntries).set({ emailedAt: new Date(), emailedTo: email }).where(eq(visitFormEntries.id, e.id));
    await addFormHistory(tx, { companyId: e.companyId, entryId: e.id, action: "emailed", byId, detail: `Emailed to ${email}` });
  });
  return { sent: true, to: email! };
}

const pending = new Set<Promise<unknown>>();
/** Tests wait for the copies going out in the background. */
export async function flushFormEmails() { while (pending.size) await Promise.all([...pending]); }

/**
 * Once a work order is completed (or a form is submitted on one that already is): each submitted
 * form set to email the customer a copy sends it, once.
 */
export function emailCopiesAfter(visitId: string) {
  const p = (async () => {
    const [v] = await db.select({ status: visits.status }).from(visits).where(eq(visits.id, visitId));
    if (v?.status !== "completed") return;
    const rows = await db.select({ id: visitFormEntries.id, def: visitFormEntries.def }).from(visitFormEntries)
      .where(and(eq(visitFormEntries.visitId, visitId), isNotNull(visitFormEntries.submittedAt), isNull(visitFormEntries.emailedAt)));
    for (const r of rows) if (r.def.emailCopy) await emailEntry(r.id, null);
  })().catch((e) => console.error("Visit form copy failed", e)).finally(() => pending.delete(p));
  pending.add(p);
}

/* ───────────── Submitted forms: the customer's, and the report ───────────── */

export interface SubmittedFilter { name?: string; customerId?: string; from?: string; to?: string; byId?: string; q?: string; limit?: number; offset?: number }

/** Submitted forms, newest first, with what they're on and who sent them. */
export async function submittedForms(companyId: string, f: SubmittedFilter) {
  const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const local = sql`(${visitFormEntries.submittedAt} at time zone ${co?.tz ?? "America/Chicago"})::date`;
  const where: (SQL | undefined)[] = [eq(visitFormEntries.companyId, companyId), isNotNull(visitFormEntries.submittedAt)];
  if (f.name) where.push(eq(visitFormEntries.name, f.name));
  if (f.customerId && /^[0-9a-f-]{36}$/i.test(f.customerId)) where.push(eq(visits.customerId, f.customerId));
  if (f.byId && /^[0-9a-f-]{36}$/i.test(f.byId)) where.push(eq(visitFormEntries.submittedById, f.byId));
  if (day(f.from)) where.push(gte(local, day(f.from)!));
  if (day(f.to)) where.push(lte(local, day(f.to)!));
  if (f.q?.trim()) {
    const t = `%${f.q.trim()}%`;
    where.push(or(ilike(visitFormEntries.name, t), ilike(visits.title, t), ilike(customers.firstName, t), ilike(customers.lastName, t), ilike(customers.companyName, t), ilike(properties.street, t), sql`${visitFormEntries.answers}::text ilike ${t}`));
  }
  const base = () => db.select({
    e: visitFormEntries, number: visits.number, title: visits.title, date: visits.date, status: visits.status, invoiceId: visits.invoiceId, customerId: visits.customerId,
    c: { kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName },
    street: properties.street, city: properties.city, byFirst: employees.firstName, byLast: employees.lastName,
  }).from(visitFormEntries).innerJoin(visits, eq(visits.id, visitFormEntries.visitId)).innerJoin(customers, eq(customers.id, visits.customerId))
    .leftJoin(properties, eq(properties.id, visits.propertyId)).leftJoin(employees, eq(employees.id, visitFormEntries.submittedById));
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 5000);
  const rows = await base().where(and(...where)).orderBy(desc(visitFormEntries.submittedAt)).limit(limit).offset(Math.max(f.offset ?? 0, 0));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(visitFormEntries).innerJoin(visits, eq(visits.id, visitFormEntries.visitId)).innerJoin(customers, eq(customers.id, visits.customerId))
    .leftJoin(properties, eq(properties.id, visits.propertyId)).where(and(...where));
  return {
    total: n,
    rows: rows.map((r) => ({
      id: r.e.id, visitId: r.e.visitId, formId: r.e.formId, name: r.e.name, submittedAt: r.e.submittedAt!, submittedBy: r.byFirst ? `${r.byFirst} ${r.byLast}` : null,
      emailedAt: r.e.emailedAt, flags: (r.e.flagged ?? []).length, def: r.e.def, answers: r.e.answers ?? {}, signature: r.e.signature ?? null, signatures: r.e.signatures ?? {},
      workOrder: { number: r.number, title: r.title, date: r.date, status: r.status },
      customer: { id: r.customerId, name: customerName(r.c as never) }, address: [r.street, r.city].filter(Boolean).join(", "),
    })),
  };
}

/** A report row's answers, question by question (for the table's summary and the export). */
export const answerPairs = (def: FormDef, answers: FormAnswers, signatures: Record<string, unknown> | null | undefined): [string, string][] =>
  formFields(def).map((f) => [f.label, formAnswerText(f, answers[f.id], (signatures as never)?.[f.id])] as [string, string]);

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { MESSAGE_SKIP_REASONS, customerName, fillTags, htmlToText, type DocHistoryAction, type DocHistoryDetail } from "@crewdesk/shared";
import { db } from "../db";
import { customers, marketingDocHistory, marketingDocTemplates, marketingDocs, properties, propertyAssignments, templates } from "../db/schema";
import { emailTransport } from "./channels";
import { recipientsFor } from "./customerMessages";
import { lettersPdf, type Letter } from "./docPdf";
import { HttpError } from "./errors";
import { billToLines, type PdfCompany } from "./invoicePdf";
import { cleanEmailHtml, sendTemplateEmail, templateVars } from "./templates";

/** Marketing → Documents: the letters for chosen customers, emailing them, the history and the Homeworks import. */

export type DocRow = typeof marketingDocs.$inferSelect;

export async function docHistory(companyId: string, docId: string, action: DocHistoryAction, byId: string | null, detail: DocHistoryDetail | null = null) {
  const [h] = await db.insert(marketingDocHistory).values({ companyId, docId, action, byId, detail }).returning({ id: marketingDocHistory.id });
  return h.id;
}

/** The document filled in for each customer (in the order given), addressed to them. Customers that aren't this company's are left out. */
export async function docLetters(companyId: string, content: string, customerIds: string[]): Promise<(Letter & { customerId: string })[]> {
  const ids = [...new Set(customerIds)];
  if (!ids.length) return [];
  const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, ids)));
  const byId = new Map(rows.map((c) => [c.id, c]));
  // Where there's no billing address, the letter goes to the customer's first property.
  const props = await db.select({ customerId: propertyAssignments.customerId, p: properties }).from(propertyAssignments)
    .innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
    .where(and(inArray(propertyAssignments.customerId, rows.map((c) => c.id)), sql`${propertyAssignments.endDate} is null`)).orderBy(asc(propertyAssignments.startDate));
  const firstProp = new Map<string, (typeof props)[number]["p"]>();
  for (const r of props) if (!firstProp.has(r.customerId)) firstProp.set(r.customerId, r.p);
  const out: (Letter & { customerId: string })[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const vars = await templateVars(companyId, { customerId: id });
    out.push({ customerId: id, toName: customerName(c), toLines: billToLines(c, firstProp.get(id)), html: fillTags(content, vars, { html: true, plainLinks: true }) });
  }
  return out;
}

export const pdfFileName = (name: string) => `${name.replace(/[^\w .()&'-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Document"}.pdf`;

/* ───────────── Emailing ───────────── */

let gapMs = 250;
/** Tests send without the pause between emails. */
export function setDocEmailGap(ms: number) { gapMs = ms; }
const pause = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let queue: Promise<void> = Promise.resolve();
/** Resolves when every document email asked for so far has gone (tests wait on this). */
export const drainDocEmails = () => queue;

/**
 * Emails a document to the chosen customers, one email each: the document as the email itself, or
 * an email template with the document attached as a PDF. Customers with no email address, ones who
 * unsubscribed and sample customers are skipped. The emails go one at a time after this returns;
 * the document's history keeps the count.
 */
export async function emailDoc(o: { companyId: string; by: string; doc: DocRow; customerIds: string[]; emailTemplateId: string | null; attachPdf: boolean; company: PdfCompany }) {
  if (!emailTransport()) throw new HttpError(400, "Email isn't set up on this server yet");
  const [tpl] = o.emailTemplateId ? await db.select().from(templates).where(and(eq(templates.id, o.emailTemplateId), eq(templates.companyId, o.companyId))) : [];
  if (o.emailTemplateId && (!tpl || tpl.channel !== "email")) throw new HttpError(400, "Pick an email template");
  // With an email template, the template is the email and the document rides along as a PDF.
  const attachPdf = o.attachPdf || !!tpl;
  const people = await recipientsFor(o.companyId, [...new Set(o.customerIds)]);
  if (!people.length) throw new HttpError(400, "Please select at least one customer");
  const going = people.filter((p) => p.status === "queued");
  const skipped = people.filter((p) => p.status === "skipped").map((p) => ({ name: p.name, reason: MESSAGE_SKIP_REASONS[p.skipReason!] ?? "Skipped" }));
  const detail: DocHistoryDetail = { customers: going.length, sent: 0, failed: 0, skipped: skipped.length, done: !going.length, emailTemplate: tpl?.name ?? null, attachPdf, error: null };
  const historyId = await docHistory(o.companyId, o.doc.id, "emailed", o.by, detail);
  const save = () => db.update(marketingDocHistory).set({ detail: { ...detail } }).where(eq(marketingDocHistory.id, historyId));

  const run = async () => {
    for (const p of going) {
      try {
        const attachments = attachPdf
          ? [{ filename: pdfFileName(o.doc.name), content: Buffer.from(await lettersPdf(o.company, await docLetters(o.companyId, o.doc.content, [p.customerId]), { title: o.doc.name })), contentType: "application/pdf" }]
          : undefined;
        await sendTemplateEmail({
          companyId: o.companyId, to: p.email!, ctx: { customerId: p.customerId }, attachments,
          template: tpl ? { id: tpl.id, subject: tpl.subject, body: tpl.body } : { id: null, subject: o.doc.name, body: o.doc.content },
        });
        detail.sent = (detail.sent ?? 0) + 1;
      } catch (err) {
        detail.failed = (detail.failed ?? 0) + 1;
        detail.error ??= (err as Error).message.slice(0, 200);
      }
      await save().catch(() => undefined);
      await pause(gapMs);
    }
    detail.done = true;
    await save().catch(() => undefined);
  };
  if (going.length) queue = queue.then(run, run);
  return { sending: going.length, skipped, attachPdf };
}

/* ───────────── Homeworks import ───────────── */

/**
 * Brings in document templates from another system (Homeworks). One with the same id there is
 * left alone, so importing again adds nothing; an empty one is skipped.
 */
export async function importDocTemplates(companyId: string, by: string, source: string, list: { name: string; content: string; homeworksId?: string | number | null }[]) {
  let added = 0, skipped = 0;
  for (const t of list) {
    const content = cleanEmailHtml(t.content);
    if (!htmlToText(content).trim()) { skipped++; continue; }
    const [row] = await db.insert(marketingDocTemplates).values({
      companyId, name: t.name, content, importedFrom: t.homeworksId != null ? `${source}:${t.homeworksId}` : null, createdById: by, updatedById: by,
    }).onConflictDoNothing().returning({ id: marketingDocTemplates.id });
    if (row) added++; else skipped++;
  }
  return { added, skipped };
}

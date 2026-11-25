import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { MESSAGE_SKIP_REASONS, customerName, fillTags, htmlToText, type DocHistoryAction, type DocHistoryDetail, type MessageSkipReason } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerMessageRecipients, customerMessages, customers, employees, marketingDocHistory, marketingDocTemplates, marketingDocs, properties, propertyAssignments, templates } from "../db/schema";
import { emailTransport } from "./channels";
import { createCustomerMessage, drainCustomerMessages, messageCounts, recipientsFor } from "./customerMessages";
import { lettersPdf, type Letter } from "./docPdf";
import { HttpError } from "./errors";
import { billToLines, type PdfCompany } from "./invoicePdf";
import { storage } from "./storage";
import { cleanEmailHtml, customerTemplateVars, renderTemplateEmail, sendTemplateEmail, templateVars } from "./templates";

/** Marketing → Documents: the letters for chosen customers, emailing them, previews, the history and the Homeworks import. */

export type DocRow = typeof marketingDocs.$inferSelect;

export async function docHistory(companyId: string, docId: string, action: DocHistoryAction, byId: string | null, detail: DocHistoryDetail | null = null) {
  const [h] = await db.insert(marketingDocHistory).values({ companyId, docId, action, byId, detail }).returning({ id: marketingDocHistory.id });
  return h.id;
}

/** A document's history, newest first. Emails show how the sending is going (or went). */
export async function docHistoryList(docId: string) {
  const rows = await db.select({ h: marketingDocHistory, first: employees.firstName, last: employees.lastName }).from(marketingDocHistory)
    .leftJoin(employees, eq(employees.id, marketingDocHistory.byId)).where(eq(marketingDocHistory.docId, docId))
    .orderBy(sql`${marketingDocHistory.createdAt} desc`, sql`${marketingDocHistory.id} desc`).limit(200);
  const messageIds = rows.map((r) => r.h.detail?.messageId).filter((x): x is string => !!x);
  const counts = await messageCounts(messageIds);
  const messages = new Map((messageIds.length ? await db.select({ id: customerMessages.id, status: customerMessages.status }).from(customerMessages).where(inArray(customerMessages.id, messageIds)) : []).map((m) => [m.id, m.status]));
  const failedIds = messageIds.filter((id) => (counts.get(id)?.failed ?? 0) > 0);
  const errors = new Map((failedIds.length
    ? await db.selectDistinctOn([customerMessageRecipients.messageId], { id: customerMessageRecipients.messageId, error: customerMessageRecipients.error }).from(customerMessageRecipients)
      .where(and(inArray(customerMessageRecipients.messageId, failedIds), eq(customerMessageRecipients.status, "failed"))).orderBy(customerMessageRecipients.messageId, asc(customerMessageRecipients.createdAt))
    : []).map((r) => [r.id, r.error]));
  return rows.map((r) => {
    let detail = r.h.detail;
    const id = detail?.messageId;
    if (detail && id) {
      const c = counts.get(id);
      const status = messages.get(id);
      // The message was removed: all we know is what was asked for.
      detail = c && status
        ? { ...detail, sent: c.sent, failed: c.failed, skipped: c.skipped, done: status !== "sending", stopped: status === "stopped", error: errors.get(id) ?? null }
        : { ...detail, sent: detail.customers ?? 0, done: true };
    }
    return { id: r.h.id, action: r.h.action, detail, by: [r.first, r.last].filter(Boolean).join(" ") || null, at: r.h.createdAt };
  });
}

/** The company as the letterhead needs it. Kept for a minute, so a run of emails doesn't fetch the logo each time. */
const letterheads = new Map<string, { at: number; company: PdfCompany }>();
export async function letterCompany(companyId: string): Promise<PdfCompany> {
  const have = letterheads.get(companyId);
  if (have && Date.now() - have.at < 60_000) return have.company;
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  let logo: Buffer | null = null;
  if (c.logoKey) { try { logo = await storage.get(c.logoKey); } catch { logo = null; } }
  const company: PdfCompany = { name: c.name, legalName: c.legalName, addressLine1: c.addressLine1, addressLine2: c.addressLine2, city: c.city, state: c.state, zip: c.zip, phone: c.phone, email: c.email, website: c.website, logo };
  letterheads.set(companyId, { at: Date.now(), company });
  return company;
}

/** The document filled in for each customer (in the order given), addressed to them. Customers that aren't this company's are left out. */
export async function docLetters(companyId: string, content: string, customerIds: string[]): Promise<(Letter & { customerId: string })[]> {
  const ids = [...new Set(customerIds)];
  if (!ids.length) return [];
  const vars = await customerTemplateVars(companyId, ids);
  const byId = new Map<string, typeof customers.$inferSelect>();
  // Where there's no billing address, the letter goes to the customer's first property.
  const firstProp = new Map<string, typeof properties.$inferSelect>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, ids.slice(i, i + 500))));
    for (const c of rows) byId.set(c.id, c);
    if (!rows.length) continue;
    const props = await db.select({ customerId: propertyAssignments.customerId, p: properties }).from(propertyAssignments)
      .innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
      .where(and(inArray(propertyAssignments.customerId, rows.map((c) => c.id)), sql`${propertyAssignments.endDate} is null`)).orderBy(asc(propertyAssignments.startDate));
    for (const r of props) if (!firstProp.has(r.customerId)) firstProp.set(r.customerId, r.p);
  }
  const out: (Letter & { customerId: string })[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    out.push({ customerId: id, toName: customerName(c), toLines: billToLines(c, firstProp.get(id)), html: fillTags(content, vars.get(id) ?? {}, { html: true, plainLinks: true }) });
  }
  return out;
}

export const pdfFileName = (name: string) => `${name.replace(/[^\w .()&'-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Document"}.pdf`;

/* ───────────── Who a list reaches ───────────── */

/** Customers an email can't reach but a mailed letter can. (Not samples, and not a second customer sharing an address already on the list.) */
const BY_MAIL: MessageSkipReason[] = ["no_email", "unsubscribed", "undeliverable"];

/** Who an email of a document would go to on a list, who it wouldn't (and why), and who'd need a letter instead. */
export async function docAudience(companyId: string, customerIds: string[]) {
  const people = await recipientsFor(companyId, [...new Set(customerIds)]);
  const reasons = new Map<MessageSkipReason, number>();
  for (const p of people) if (p.skipReason) reasons.set(p.skipReason, (reasons.get(p.skipReason) ?? 0) + 1);
  return {
    people,
    going: people.filter((p) => p.status === "queued"),
    byMail: people.filter((p) => p.skipReason && BY_MAIL.includes(p.skipReason)),
    skipped: [...reasons].map(([reason, n]) => ({ reason, label: MESSAGE_SKIP_REASONS[reason], n })),
  };
}

/* ───────────── Emailing ───────────── */

async function emailTemplateFor(companyId: string, id: string | null) {
  if (!id) return null;
  const [tpl] = await db.select().from(templates).where(and(eq(templates.id, id), eq(templates.companyId, companyId)));
  if (!tpl || tpl.channel !== "email") throw new HttpError(400, "Pick an email template");
  return tpl;
}

/**
 * Emails a document to the chosen customers, one email each: the document as the email itself, or
 * an email template with the document attached as a PDF. Customers with no email address, ones who
 * unsubscribed and sample customers are skipped. It goes out through the same saved queue as the
 * Customers page's emails (one at a time in the background, safe across a restart, with Stop and a
 * list of everyone on it under Sent messages); the document's history follows the count.
 */
export async function emailDoc(o: { companyId: string; by: string; doc: DocRow; customerIds: string[]; emailTemplateId: string | null; attachPdf: boolean; audience?: string | null }) {
  if (!emailTransport()) throw new HttpError(400, "Email isn't set up on this server yet");
  const tpl = await emailTemplateFor(o.companyId, o.emailTemplateId);
  // With an email template, the template is the email and the document rides along as a PDF.
  const attachPdf = o.attachPdf || !!tpl;
  const a = await docAudience(o.companyId, o.customerIds);
  if (!a.people.length) throw new HttpError(400, "Please select at least one customer");
  const m = await createCustomerMessage({
    companyId: o.companyId, byId: o.by, subject: tpl?.subject ?? o.doc.name, body: tpl?.body ?? o.doc.content, rows: a.people,
    audience: [o.audience, `Document: ${o.doc.name}`].filter(Boolean).join(" · ").slice(0, 300),
    doc: { docId: o.doc.id, docName: o.doc.name, docContent: o.doc.content, attachPdf, emailTemplateId: tpl?.id ?? null },
  });
  await docHistory(o.companyId, o.doc.id, "emailed", o.by, { messageId: m.id, customers: a.going.length, skipped: a.people.length - a.going.length, emailTemplate: tpl?.name ?? null, attachPdf });
  if (a.going.length) void drainCustomerMessages().catch((err) => console.error("document emails failed", err));
  return {
    messageId: m.id, sending: a.going.length, attachPdf, skipped: a.skipped,
    skippedNames: a.people.filter((p) => p.skipReason).slice(0, 20).map((p) => ({ name: p.name, reason: MESSAGE_SKIP_REASONS[p.skipReason!] ?? "Skipped" })),
  };
}

/** One queued document email (called by the customer email queue for each customer on it). */
export async function sendDocMessage(m: typeof customerMessages.$inferSelect, r: { customerId: string | null; email: string }) {
  if (!r.customerId) throw new Error("The customer was removed before it was sent");
  const attachments = m.attachPdf && m.docContent != null
    ? [{
      filename: pdfFileName(m.docName ?? m.subject), contentType: "application/pdf",
      content: Buffer.from(await lettersPdf(await letterCompany(m.companyId), await docLetters(m.companyId, m.docContent, [r.customerId]), { title: m.docName ?? m.subject })),
    }]
    : undefined;
  await sendTemplateEmail({ companyId: m.companyId, to: r.email, ctx: { customerId: r.customerId }, attachments, template: { id: m.emailTemplateId, subject: m.subject, body: m.body } });
}

/* ───────────── Preview ───────────── */

/** The document as one customer will get it: the email (the document, or the email template chosen) and the printed letter. */
export async function previewDoc(companyId: string, doc: DocRow, customerId: string, emailTemplateId: string | null) {
  const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!c) throw new HttpError(404, "Customer not found");
  const tpl = await emailTemplateFor(companyId, emailTemplateId);
  const email = await renderTemplateEmail(companyId, tpl ? { subject: tpl.subject, body: tpl.body } : { subject: doc.name, body: doc.content }, await templateVars(companyId, { customerId }));
  const [letter] = await docLetters(companyId, doc.content, [customerId]);
  return {
    customer: { id: c.id, name: customerName(c), email: c.email?.trim() || null },
    email: { subject: email.subject, html: email.html },
    letter: { toName: letter.toName, toLines: letter.toLines, html: letter.html },
    attachPdf: !!tpl,
  };
}

/* ───────────── Homeworks import ───────────── */

/**
 * Brings in document templates from another system (Homeworks). One already here from the same
 * file is brought up to date when nobody has changed it in Crewdesk (so a tidied file replaces the
 * first import) and left alone when someone has; an empty one is skipped.
 */
export async function importDocTemplates(companyId: string, by: string, source: string, list: { name: string; content: string; homeworksId?: string | number | null }[]) {
  const here = new Map((await db.select().from(marketingDocTemplates).where(and(eq(marketingDocTemplates.companyId, companyId), isNotNull(marketingDocTemplates.importedFrom)))).map((t) => [t.importedFrom!, t]));
  let added = 0, updated = 0, kept = 0, skipped = 0;
  for (const t of list) {
    const content = cleanEmailHtml(t.content);
    if (!htmlToText(content).trim()) { skipped++; continue; }
    const importedFrom = t.homeworksId != null ? `${source}:${t.homeworksId}` : null;
    const have = importedFrom ? here.get(importedFrom) : undefined;
    if (!have) {
      const [row] = await db.insert(marketingDocTemplates).values({ companyId, name: t.name, content, importedFrom, createdById: by, updatedById: by })
        .onConflictDoNothing().returning({ id: marketingDocTemplates.id });
      if (row) added++; else skipped++;
    } else if (have.content === content && have.name === t.name) skipped++;
    else if (have.updatedAt.getTime() === have.createdAt.getTime()) {
      // Never edited here: take the file's version (and keep it marked as not edited).
      await db.update(marketingDocTemplates).set({ name: t.name, content }).where(eq(marketingDocTemplates.id, have.id));
      updated++;
    } else kept++;
  }
  return { added, updated, kept, skipped };
}

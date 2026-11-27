import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { customerName, fillNotice, noticeSettings, noticeVars, type NoticeChannel } from "@crewdesk/shared";
import { db } from "../db";
import { applicationRecordProducts, applicationRecords, chemicalNotices, companies, customers, products, properties } from "../db/schema";
import { emailTransport, isUndeliverable } from "./channels";
import { companyInfo, messageVars, renderCustomerEmail } from "./customerMessages";
import { HttpError } from "./errors";
import { contactLabel, contactVars, contactsToNotify, reachContact } from "./propertyContacts";
import { sendCustomerText } from "./texting";

/**
 * After-application notices: when a chemical record is made, the customer hears what was applied
 * and how long to stay off the lawn, the way their property chooses. The property's contacts who
 * are ticked for service notifications (a tenant, say) get it too. Off until the company turns
 * notices on (Chemical Tracking → Notices). Never slows the tech down: it runs after completion.
 */

const pending = new Set<Promise<unknown>>();
/** Tests wait for the notices started by completing a work order. */
export async function flushNotices() { while (pending.size) await Promise.all([...pending]); }

/**
 * The notice for a record, filled in: email subject and body, the text, and who it's for. With
 * `who` (a contact on the property) their name goes where the customer's would.
 */
export async function buildNotice(recordId: string, who?: Parameters<typeof contactVars>[0]) {
  const [r] = await db.select().from(applicationRecords).where(eq(applicationRecords.id, recordId));
  if (!r) throw new HttpError(404, "Record not found");
  const [co] = await db.select({ chemicalNotices: companies.chemicalNotices }).from(companies).where(eq(companies.id, r.companyId));
  const settings = noticeSettings(co?.chemicalNotices);
  const items = await db.select({ name: applicationRecordProducts.tradeName, type: applicationRecordProducts.productType, customerNote: products.customerNote, reiHours: products.reiHours })
    .from(applicationRecordProducts).leftJoin(products, eq(products.id, applicationRecordProducts.productId))
    .where(eq(applicationRecordProducts.recordId, r.id)).orderBy(asc(applicationRecordProducts.sortOrder));
  // Surfactants and other adjuvants are on the record, not in the customer's notice.
  const shown = items.filter((i) => i.type !== "adjuvant");
  const company = await companyInfo(r.companyId);
  const vars = who ? contactVars(who, company)
    : r.customerId ? (await messageVars(r.companyId, [r.customerId], company)).get(r.customerId) ?? {} : { company: company.name, company_phone: company.phone ?? "" };
  const nv = noticeVars({ date: r.appliedOn, property: r.siteAddress ?? "", products: shown.map((i) => ({ name: i.name, customerNote: i.customerNote ?? null, reiHours: i.reiHours ?? null })) });
  return {
    record: r, settings, company,
    subject: fillNotice(settings.emailSubject, vars, nv).replace(/\s+/g, " "),
    body: fillNotice(settings.emailBody, vars, nv),
    text: fillNotice(settings.textBody, vars, nv).replace(/\s*\n\s*/g, " "),
    vars,
  };
}

/** Sends (or queues to print) a notice for a record on a channel, saving what went out. */
export async function deliverNotice(recordId: string, channel: Exclude<NoticeChannel, "none">, by: string | null) {
  const n = await buildNotice(recordId);
  const r = n.record;
  const base = { companyId: r.companyId, recordId: r.id, customerId: r.customerId, propertyId: r.propertyId, channel, sentById: by };
  if (channel === "printed") {
    const [row] = await db.insert(chemicalNotices).values({ ...base, status: "to_print", subject: n.subject, body: n.body }).returning();
    return row;
  }
  const [cust] = r.customerId ? await db.select().from(customers).where(eq(customers.id, r.customerId)) : [];
  if (channel === "text") {
    if (!cust) return (await db.insert(chemicalNotices).values({ ...base, status: "skipped", body: n.text, detail: "No customer on the record" }).returning())[0];
    const sent = await sendCustomerText(r.companyId, cust.id, n.text, { by, source: "automation" });
    const status = sent.skipped ? "skipped" : sent.text?.status === "failed" ? "failed" : "sent";
    return (await db.insert(chemicalNotices).values({ ...base, status, to: sent.text?.phone ?? null, body: n.text, detail: sent.skipped ?? sent.text?.error ?? null, sentAt: status === "sent" ? new Date() : null }).returning())[0];
  }
  // Email: a service notice for this customer (like an invoice), so a bulk-email unsubscribe doesn't stop it.
  const email = cust?.email?.trim() || null;
  const skip = !cust ? "No customer on the record" : cust.sample ? "Sample customer" : !email ? `${customerName(cust)} has no email address` : isUndeliverable(email) ? "That address can't get email" : !emailTransport() ? "Email isn't set up on the server" : null;
  const [row] = await db.insert(chemicalNotices).values({ ...base, status: skip ? "skipped" : "sending", to: email, subject: n.subject, body: n.body, detail: skip }).returning();
  if (skip) return row;
  const msg = renderCustomerEmail({ company: n.company, subject: n.subject, body: n.body, vars: n.vars });
  try {
    await emailTransport()!.send({ to: email!, subject: msg.subject, text: msg.text, html: msg.html, fromName: n.company.name, replyTo: n.company.email ?? undefined });
    return (await db.update(chemicalNotices).set({ status: "sent", sentAt: new Date() }).where(eq(chemicalNotices.id, row.id)).returning())[0];
  } catch (e) {
    return (await db.update(chemicalNotices).set({ status: "failed", detail: (e as Error).message.slice(0, 500) }).where(eq(chemicalNotices.id, row.id)).returning())[0];
  }
}

/**
 * The same notice for the property's contacts who get its service notifications, each the way
 * they're reached. One who is reached only by phone is logged as skipped with their number, so the
 * office sees who to call. Nobody gets it twice: a later call only reaches those it hasn't yet.
 */
export async function noticeContacts(recordId: string, by: string | null) {
  const [r] = await db.select().from(applicationRecords).where(eq(applicationRecords.id, recordId));
  if (!r?.propertyId) return [];
  const contacts = await contactsToNotify(r.companyId, [r.propertyId]);
  if (!contacts.length) return [];
  const before = await db.select({ who: chemicalNotices.recipient, status: chemicalNotices.status, channel: chemicalNotices.channel }).from(chemicalNotices).where(eq(chemicalNotices.recordId, r.id));
  const had = new Set(before.filter((x) => x.status === "sent" || x.status === "sending" || x.channel === "call").map((x) => x.who));
  const out = [];
  for (const k of contacts) {
    const recipient = contactLabel(k);
    if (had.has(recipient)) continue;
    const n = await buildNotice(r.id, k);
    const sent = await reachContact(r.companyId, k, n.company, { subject: n.subject, body: n.body, text: n.text }, { by, source: "automation" });
    const email = sent.channel === "email";
    const [row] = await db.insert(chemicalNotices).values({
      companyId: r.companyId, recordId: r.id, customerId: r.customerId, propertyId: r.propertyId, sentById: by, recipient,
      channel: sent.channel ?? "email", status: sent.status === "call" ? "skipped" : sent.status, to: sent.to,
      subject: email ? n.subject : null, body: email ? n.body : n.text, detail: sent.detail, sentAt: sent.status === "sent" ? new Date() : null,
    }).returning();
    out.push(row);
  }
  return out;
}

/** Called after a work order is completed: its record's notice, if notices are on and the property wants one. */
export function noticeAfterComplete(visitId: string, companyId: string) {
  const p = (async () => {
    const [co] = await db.select({ chemicalNotices: companies.chemicalNotices }).from(companies).where(eq(companies.id, companyId));
    if (!noticeSettings(co?.chemicalNotices).on) return;
    const [r] = await db.select({ id: applicationRecords.id, propertyId: applicationRecords.propertyId }).from(applicationRecords)
      .where(and(eq(applicationRecords.visitId, visitId), isNull(applicationRecords.voidedAt))).orderBy(desc(applicationRecords.createdAt)).limit(1);
    if (!r) return;
    const [already] = await db.select({ id: chemicalNotices.id }).from(chemicalNotices).where(eq(chemicalNotices.recordId, r.id)).limit(1);
    if (already) return;
    const [prop] = r.propertyId ? await db.select({ chemicalNotice: properties.chemicalNotice }).from(properties).where(eq(properties.id, r.propertyId)) : [];
    const channel = (prop?.chemicalNotice ?? "email") as NoticeChannel;
    if (channel !== "none") await deliverNotice(r.id, channel, null);
    // A tenant ticked for notifications is told even when the customer (a landlord, say) wants none.
    await noticeContacts(r.id, null);
  })().catch((e) => console.error("Chemical notice failed", e)).finally(() => pending.delete(p));
  pending.add(p);
}

/** Notices for the log: newest first, with the customer and record date. */
export async function noticeRows(companyId: string, o: { status?: string; recordId?: string; id?: string; limit?: number }) {
  const where = [eq(chemicalNotices.companyId, companyId)];
  if (o.status === "to_print") where.push(eq(chemicalNotices.status, "to_print"));
  else if (o.status === "problems") where.push(inArray(chemicalNotices.status, ["failed", "skipped"]));
  if (o.recordId) where.push(eq(chemicalNotices.recordId, o.recordId));
  if (o.id) where.push(eq(chemicalNotices.id, o.id));
  return db.select({
    id: chemicalNotices.id, recordId: chemicalNotices.recordId, channel: chemicalNotices.channel, status: chemicalNotices.status, to: chemicalNotices.to, recipient: chemicalNotices.recipient,
    subject: chemicalNotices.subject, body: chemicalNotices.body, detail: chemicalNotices.detail, sentAt: chemicalNotices.sentAt, printedAt: chemicalNotices.printedAt, createdAt: chemicalNotices.createdAt,
    customerId: chemicalNotices.customerId, customerName: applicationRecords.customerName, siteAddress: applicationRecords.siteAddress, appliedOn: applicationRecords.appliedOn,
  }).from(chemicalNotices).innerJoin(applicationRecords, eq(applicationRecords.id, chemicalNotices.recordId))
    .where(and(...where)).orderBy(desc(chemicalNotices.createdAt)).limit(Math.min(o.limit ?? 200, 500));
}

/** Count of notices waiting to print or that didn't go, for My Day. */
export async function noticeCounts(companyId: string) {
  const rows = await db.select({ status: chemicalNotices.status }).from(chemicalNotices)
    .where(and(eq(chemicalNotices.companyId, companyId), inArray(chemicalNotices.status, ["to_print", "failed"]), ne(chemicalNotices.channel, "none")));
  return { toPrint: rows.filter((r) => r.status === "to_print").length, failed: rows.filter((r) => r.status === "failed").length };
}

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { contactChannel, contactName, contactPhone, formatPhone, type FormOfContact, type MessageVars, type PropertyContactInput } from "@crewdesk/shared";
import { db } from "../db";
import { propertyContacts } from "../db/schema";
import { emailTransport, isUndeliverable } from "./channels";
import { renderCustomerEmail } from "./customerMessages";
import { sendStaffText } from "./texting";

/**
 * Contacts on a property who aren't customers (tenants and the like), and the service
 * notifications the ticked ones get for that property: the pre-visit notice and the notice after a
 * chemical application. Nothing else is sent to them: no invoices, statements or marketing.
 */

export type PropertyContact = typeof propertyContacts.$inferSelect;
type Company = Parameters<typeof renderCustomerEmail>[0]["company"];

/** The columns for a contact as the form sent it: the display name and the first number to show are kept alongside. */
export const contactColumns = (b: PropertyContactInput) => ({
  firstName: b.firstName ?? null, lastName: b.lastName ?? null, nickname: b.nickname ?? null, name: contactName(b),
  relation: b.relation, email: b.email ?? null, homePhone: b.homePhone ?? null, workPhone: b.workPhone ?? null, cellPhone: b.cellPhone ?? null, otherPhone: b.otherPhone ?? null,
  fax: b.fax ?? null, phone: contactPhone(b), formOfContact: b.formOfContact ?? null, birthday: b.birthday ?? null, notes: b.notes ?? null,
  notify: b.notify, startDate: b.startDate ?? null,
});

/** The contacts on these properties now who are ticked for service notifications. */
export async function contactsToNotify(companyId: string, propertyIds: string[]): Promise<PropertyContact[]> {
  if (!propertyIds.length) return [];
  return db.select().from(propertyContacts)
    .where(and(eq(propertyContacts.companyId, companyId), inArray(propertyContacts.propertyId, propertyIds), eq(propertyContacts.notify, true), isNull(propertyContacts.endDate)))
    .orderBy(asc(propertyContacts.sortOrder), asc(propertyContacts.createdAt));
}

/** How many contacts on each property get its service notifications (properties with none are left out). */
export async function notifyContactCounts(companyId: string, propertyIds: string[]): Promise<Map<string, number>> {
  if (!propertyIds.length) return new Map();
  const rows = await db.select({ propertyId: propertyContacts.propertyId, n: sql<number>`count(*)::int` }).from(propertyContacts)
    .where(and(eq(propertyContacts.companyId, companyId), inArray(propertyContacts.propertyId, propertyIds), eq(propertyContacts.notify, true), isNull(propertyContacts.endDate)))
    .groupBy(propertyContacts.propertyId);
  return new Map(rows.map((r) => [r.propertyId, r.n]));
}

/** A contact's own fill-ins: their name where a customer's would go. They have no balance or customer number. */
export const contactVars = (c: PropertyContact, company: Company): MessageVars => ({
  first_name: c.firstName?.trim() || c.nickname?.trim() || c.name, last_name: c.lastName ?? "", name: c.name, company: company.name, company_phone: company.phone ?? "",
});

/** "Tina Tenant (tenant)": who a notice went to, for the office. */
export const contactLabel = (c: Pick<PropertyContact, "name" | "relation">) => `${c.name} (${c.relation.toLowerCase()})`;

/** What happened to one notification. "call": they're reached by phone, so the office calls them. */
export type Reached = { channel: FormOfContact | null; status: "sent" | "failed" | "skipped" | "call"; to: string | null; detail: string | null };

/**
 * Sends one service notification to a contact the way they're reached: their form of contact when
 * they have what it needs, else email, then a text to their cell. Someone reached only by a phone
 * call isn't sent anything; the office is told to call.
 */
export async function reachContact(companyId: string, c: PropertyContact, company: Company, m: { subject: string; body: string; text: string }, o: { by: string | null; source: "office" | "automation" }): Promise<Reached> {
  const channel = contactChannel(c);
  if (!channel) return { channel: null, status: "skipped", to: null, detail: `${c.name} has no email address or phone number` };
  if (channel === "call") {
    const phone = contactPhone(c)!;
    return { channel, status: "call", to: phone, detail: `${c.name} is reached by phone: call ${formatPhone(phone)}` };
  }
  if (channel === "text") {
    if (c.textOptOutAt) return { channel, status: "skipped", to: c.cellPhone, detail: `${c.name} replied STOP, so they can't be texted until they reply START` };
    const s = await sendStaffText(companyId, c.cellPhone, m.text, { by: o.by, source: o.source });
    return { channel, status: s.sent ? "sent" : s.skipped ? "skipped" : "failed", to: c.cellPhone, detail: s.sent ? null : s.skipped ?? s.error ?? null };
  }
  const to = c.email!.trim();
  if (isUndeliverable(to)) return { channel, status: "skipped", to, detail: "That address can't get email" };
  if (!emailTransport()) return { channel, status: "skipped", to, detail: "Email isn't set up on the server" };
  // A service notice about the address they live or work at: no unsubscribe link (untick them on the property instead).
  const msg = renderCustomerEmail({ company, subject: m.subject, body: m.body, vars: contactVars(c, company) });
  try {
    await emailTransport()!.send({ to, subject: msg.subject, text: msg.text, html: msg.html, fromName: company.name, replyTo: company.email ?? undefined });
    return { channel, status: "sent", to, detail: null };
  } catch (e) {
    return { channel, status: "failed", to, detail: (e as Error).message.slice(0, 500) };
  }
}

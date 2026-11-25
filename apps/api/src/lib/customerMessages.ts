import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { customerName, fillMessage, formatCompanyAddress, formatMoney, type MessageSkipReason, type MessageVars } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerMessageRecipients, customerMessages, customers } from "../db/schema";
import { PUBLIC_API_URL, WEB_URL, emailTransport, isUndeliverable } from "./channels";
import { listColumns } from "./customerList";
import { companyToday } from "./payRates";

/**
 * Emails to many customers at once. Creating one works out who gets it (and who's skipped, and why)
 * right away; the emails then go out one at a time in the background, so a slow mail server or a
 * restart doesn't lose any. Customers can unsubscribe with the link at the bottom.
 */

// ---------- Unsubscribe links ----------

const secret = () => process.env.JWT_SECRET ?? "dev-only-secret";
const sign = (id: string) => createHmac("sha256", secret()).update(`customer-unsubscribe:${id}`).digest("base64url");

/** A link token that unsubscribes one customer from emails sent to many customers. It doesn't expire. */
export const customerUnsubscribeToken = (customerId: string) => `${Buffer.from(customerId).toString("base64url")}.${sign(customerId)}`;

export function readCustomerUnsubscribeToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  let id: string;
  try { id = Buffer.from(payload, "base64url").toString(); } catch { return null; }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

// ---------- Fill-in values ----------

const longDate = (ymd: string | null) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);

type CompanyInfo = { name: string; phone: string | null; email: string | null; address: string };
export async function companyInfo(companyId: string): Promise<CompanyInfo> {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  return { name: c.name, phone: c.phone, email: c.email, address: formatCompanyAddress(c) };
}

/** Each customer's fill-in values (name, balance, next and last service), by customer id. */
export async function messageVars(companyId: string, customerIds: string[], company: CompanyInfo): Promise<Map<string, MessageVars>> {
  const out = new Map<string, MessageVars>();
  if (!customerIds.length) return out;
  const today = await companyToday(companyId);
  const cols = listColumns(today, `${today.slice(0, 4)}-01-01`);
  for (let i = 0; i < customerIds.length; i += 1000) {
    const rows = await db
      .select({ id: customers.id, number: customers.number, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName,
        balance: cols.balance, next: cols.nextService, last: cols.lastService })
      .from(customers)
      .where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds.slice(i, i + 1000))));
    for (const r of rows) {
      const name = customerName(r);
      out.set(r.id, {
        first_name: r.firstName?.trim() || name, last_name: r.lastName ?? "", name, customer_number: String(r.number),
        balance: formatMoney(r.balance), next_service: longDate(r.next) ?? "not scheduled yet", last_service: longDate(r.last) ?? "none yet",
        company: company.name, company_phone: company.phone ?? "",
      });
    }
  }
  return out;
}

// ---------- The email ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Plain text to simple HTML: paragraphs, line breaks and clickable links. */
function textToHtml(text: string) {
  return text.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</p>`).join("\n");
}

/** The email one customer gets: the message filled in, with the company's details and an unsubscribe link at the bottom. */
export function renderCustomerEmail(o: { company: CompanyInfo; subject: string; body: string; vars: MessageVars; customerId?: string }) {
  const subject = fillMessage(o.subject, o.vars).replace(/\s+/g, " ").trim();
  const body = fillMessage(o.body, o.vars).trim();
  const token = o.customerId ? customerUnsubscribeToken(o.customerId) : null;
  const unsubscribe = token ? `${WEB_URL}/unsubscribe?customer=${encodeURIComponent(token)}` : null;
  const footer = [o.company.name, o.company.address, o.company.phone].filter(Boolean).join(" · ");
  const text = `${body}\n\n--\n${footer}${unsubscribe ? `\nDon't want these emails? Unsubscribe: ${unsubscribe}` : ""}\n`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1d2939">
${textToHtml(body)}
<hr style="border:0;border-top:1px solid #eaecf0;margin:24px 0 12px">
<p style="color:#667085;font-size:12px">${esc(footer)}${unsubscribe ? `<br>Don't want these emails? <a href="${esc(unsubscribe)}" style="color:#667085">Unsubscribe</a>. You'll still get your invoices and receipts.` : ""}</p>
</div>`;
  const headers: Record<string, string> = token
    ? { "List-Unsubscribe": `<${PUBLIC_API_URL}/public/unsubscribe/customer?token=${encodeURIComponent(token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : {};
  return { subject, text, html, headers };
}

// ---------- Creating a message ----------

/** Works out who gets it (in list order) and who's skipped, and saves the message; sending starts in the background. */
export async function createCustomerMessage(o: {
  companyId: string; byId: string; subject: string; body: string; audience: string | null;
  /** Who it's for: the customers, or the list already worked out with `recipientsFor`. */
  customerIds?: string[]; rows?: Recipient[];
  /** A Marketing → Documents document: formatted with {{TAGS}}, optionally with the document as a PDF. */
  doc?: { docId: string; docName: string; docContent: string; attachPdf: boolean; emailTemplateId: string | null };
}) {
  const rows = o.rows ?? await recipientsFor(o.companyId, o.customerIds ?? []);
  const message = await db.transaction(async (tx) => {
    const [m] = await tx.insert(customerMessages).values({ companyId: o.companyId, subject: o.subject, body: o.body, audience: o.audience, byId: o.byId,
      ...(o.doc ? { format: "template", ...o.doc } : {}),
      status: rows.some((r) => r.status === "queued") ? "sending" : "sent", finishedAt: rows.some((r) => r.status === "queued") ? null : new Date() }).returning();
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(customerMessageRecipients).values(rows.slice(i, i + 500).map((r) => ({ ...r, companyId: o.companyId, messageId: m.id })));
    }
    return m;
  });
  return message;
}

export type Recipient = { customerId: string; name: string; email: string | null; status: "queued" | "skipped"; skipReason: MessageSkipReason | null };

/** Each customer's address, or why they're skipped (no email, unsubscribed, sample, same address as one earlier on the list). */
export async function recipientsFor(companyId: string, customerIds: string[]): Promise<Recipient[]> {
  const found = new Map<string, typeof customers.$inferSelect>();
  for (let i = 0; i < customerIds.length; i += 1000) {
    const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds.slice(i, i + 1000))));
    for (const r of rows) found.set(r.id, r);
  }
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const id of customerIds) {
    const c = found.get(id);
    if (!c) continue;
    const email = c.email?.trim() || null;
    const skip: MessageSkipReason | null = c.sample ? "sample" : !email ? "no_email" : c.emailOptOutAt ? "unsubscribed" : isUndeliverable(email) ? "undeliverable" : seen.has(email.toLowerCase()) ? "duplicate" : null;
    if (!skip) seen.add(email!.toLowerCase());
    out.push({ customerId: c.id, name: customerName(c), email, status: skip ? "skipped" : "queued", skipReason: skip });
  }
  return out;
}

// ---------- Sending ----------

let gapMs = 250;
/** Tests send without the pause between emails. */
export function setMessageGap(ms: number) { gapMs = ms; }
const pause = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let onlyCompanies: string[] | null = null;
/** Tests share one database: each test file's queue run takes only its own companies' emails. */
export function setMessageQueueScope(companyIds: string[] | null) { onlyCompanies = companyIds; }

let running: Promise<void> | null = null;

/**
 * Sends every queued customer email, one at a time (with a short pause, to stay under mail
 * servers' limits). Only one run at a time in this server; the database lock keeps two servers
 * from sending the same email. Called right after a message is created and by the scheduler, which
 * picks up anything left after a restart.
 */
export function drainCustomerMessages(): Promise<void> {
  if (!running) running = drain().finally(() => { running = null; });
  return running;
}

async function drain() {
  const transport = emailTransport();
  // Ones caught mid-send by a restart: we can't tell whether they went, so don't send them twice.
  await db.update(customerMessageRecipients).set({ status: "failed", error: "Interrupted while sending (the server restarted); it may not have gone" })
    .where(and(eq(customerMessageRecipients.status, "sending"), sql`${customerMessageRecipients.createdAt} < now() - interval '15 minutes'`));
  const companiesSeen = new Map<string, CompanyInfo>();
  const messagesSeen = new Map<string, typeof customerMessages.$inferSelect>();
  for (;;) {
    // Claim a few at a time.
    const batch = await db.execute<{ id: string }>(sql`
      update customer_message_recipients set status = 'sending'
      where id in (
        select r.id from customer_message_recipients r join customer_messages m on m.id = r.message_id
        where r.status = 'queued' and m.status = 'sending'
          ${onlyCompanies ? sql`and r.company_id in (${sql.join(onlyCompanies.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``}
        order by r.created_at, r.id limit 10 for update of r skip locked)
      returning id`);
    const ids = batch.rows.map((r) => r.id);
    if (!ids.length) break;
    const rows = await db.select().from(customerMessageRecipients).where(inArray(customerMessageRecipients.id, ids)).orderBy(asc(customerMessageRecipients.createdAt));
    for (const r of rows) {
      let m = messagesSeen.get(r.messageId);
      if (!m) { [m] = await db.select().from(customerMessages).where(eq(customerMessages.id, r.messageId)); messagesSeen.set(m.id, m); }
      let company = companiesSeen.get(r.companyId);
      if (!company) { company = await companyInfo(r.companyId); companiesSeen.set(r.companyId, company); }
      try {
        if (!transport) throw new Error("Email isn't set up on this server");
        if (m.format === "template") {
          // A document (Marketing → Documents): the templates' tags and letterhead, and the PDF when asked for.
          const { sendDocMessage } = await import("./docs");
          await sendDocMessage(m, { customerId: r.customerId, email: r.email! });
        } else {
          const vars = r.customerId ? (await messageVars(r.companyId, [r.customerId], company)).get(r.customerId) ?? {} : {};
          const email = renderCustomerEmail({ company, subject: m.subject, body: m.body, vars, customerId: r.customerId ?? undefined });
          await transport.send({ to: r.email!, ...email, fromName: company.name, replyTo: company.email ?? undefined });
        }
        await db.update(customerMessageRecipients).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(customerMessageRecipients.id, r.id));
      } catch (err) {
        await db.update(customerMessageRecipients).set({ status: "failed", error: (err as Error).message.slice(0, 300) }).where(eq(customerMessageRecipients.id, r.id));
      }
      await pause(gapMs);
    }
    await finishDone([...new Set(rows.map((r) => r.messageId))]);
  }
  // Messages stopped mid-way, or with nothing left to send, are finished.
  await finishDone();
}

/** Marks messages with nothing left queued as sent. */
async function finishDone(ids?: string[]) {
  await db.execute(sql`
    update customer_messages m set status = 'sent', finished_at = now()
    where m.status = 'sending' ${ids?.length ? sql`and m.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``}
      and not exists (select 1 from customer_message_recipients r where r.message_id = m.id and r.status in ('queued', 'sending'))`);
}

/** Counts by status, for a message (or several). */
export async function messageCounts(messageIds: string[]) {
  if (!messageIds.length) return new Map<string, Record<string, number>>();
  const rows = await db.select({ messageId: customerMessageRecipients.messageId, status: customerMessageRecipients.status, n: sql<number>`count(*)::int` })
    .from(customerMessageRecipients).where(inArray(customerMessageRecipients.messageId, messageIds)).groupBy(customerMessageRecipients.messageId, customerMessageRecipients.status);
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const c = out.get(r.messageId) ?? { total: 0, queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    c[r.status] = (c[r.status] ?? 0) + r.n;
    c.total += r.n;
    out.set(r.messageId, c);
  }
  return out;
}

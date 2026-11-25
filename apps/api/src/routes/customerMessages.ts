import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { MESSAGE_SKIP_REASONS, SAMPLE_MESSAGE_VARS, customerEmailSchema, customerName, formatPhone, type MessageVars } from "@crewdesk/shared";
import { db } from "../db";
import { customerMessageRecipients, customerMessages, customers, employees } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { emailTransport } from "../lib/channels";
import { companyInfo, createCustomerMessage, drainCustomerMessages, messageCounts, messageVars, recipientsFor, renderCustomerEmail } from "../lib/customerMessages";
import { customerInCompany } from "../lib/crm";
import { HttpError, parse } from "../lib/errors";
import { parseSelection, selectedIds } from "./customers";

const AREA = "customers" as const;
const audienceSchema = z.string().trim().max(300).optional();

/**
 * Emails to many customers at once (the Customers list's Send menu), the list of what's been sent,
 * and each customer's emails and unsubscribe status. Managers in Customers & billing.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  /** Before sending: how many get it, who's skipped and why, and the first customer's email filled in. */
  app.post("/preview", async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const { companyId } = req.user;
    const ids = await selectedIds(companyId, parseSelection(raw));
    const list = await recipientsFor(companyId, ids);
    const skipped: Record<string, number> = {};
    for (const r of list) if (r.skipReason) skipped[r.skipReason] = (skipped[r.skipReason] ?? 0) + 1;
    const first = list.find((r) => r.status === "queued");
    const subject = typeof raw.subject === "string" ? raw.subject : "";
    const body = typeof raw.body === "string" ? raw.body : "";
    let sample = null;
    if (first && (subject || body)) {
      const company = await companyInfo(companyId);
      const vars = (await messageVars(companyId, [first.customerId], company)).get(first.customerId) ?? {};
      sample = { name: first.name, email: first.email, ...renderCustomerEmail({ company, subject, body, vars, customerId: first.customerId }) };
    }
    return {
      total: list.length, sending: list.filter((r) => r.status === "queued").length,
      skipped: Object.entries(skipped).map(([reason, n]) => ({ reason, label: MESSAGE_SKIP_REASONS[reason as keyof typeof MESSAGE_SKIP_REASONS], n })),
      emailReady: !!emailTransport(), sample,
    };
  });

  /** "Send me a test": the email as the first customer on the list would get it, to the person sending. */
  app.post("/test", async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const msg = parse(customerEmailSchema, raw);
    const { companyId, sub } = req.user;
    const transport = emailTransport();
    if (!transport) throw new HttpError(400, "Email isn't set up on this server yet");
    const [me] = await db.select({ email: employees.email }).from(employees).where(eq(employees.id, sub));
    if (!me?.email) throw new HttpError(400, "Your account has no email address");
    const company = await companyInfo(companyId);
    let vars: MessageVars = { ...SAMPLE_MESSAGE_VARS, company: company.name, company_phone: company.phone ?? "" };
    if (raw.ids || raw.match) {
      const first = (await recipientsFor(companyId, (await selectedIds(companyId, parseSelection(raw))).slice(0, 200))).find((r) => r.status === "queued");
      if (first) vars = (await messageVars(companyId, [first.customerId], company)).get(first.customerId) ?? vars;
    }
    const email = renderCustomerEmail({ company, subject: msg.subject, body: msg.body, vars });
    await transport.send({ to: me.email, ...email, subject: `[Test] ${email.subject}`, fromName: company.name, replyTo: company.email ?? undefined });
    return { to: me.email };
  });

  /** Sends it: saves who gets it now, then the emails go out one by one in the background. */
  app.post("/", async (req) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const msg = parse(customerEmailSchema, raw);
    const audience = parse(audienceSchema, raw.audience) ?? null;
    const { companyId, sub } = req.user;
    if (!emailTransport()) throw new HttpError(400, "Email isn't set up on this server yet, so nothing can be sent");
    const ids = await selectedIds(companyId, parseSelection(raw));
    const m = await createCustomerMessage({ companyId, byId: sub, subject: msg.subject, body: msg.body, customerIds: ids, audience });
    void drainCustomerMessages().catch((err) => console.error("customer emails failed", err));
    const counts = (await messageCounts([m.id])).get(m.id);
    return { ...m, counts };
  });

  /** What's been sent, newest first, with counts. */
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/", async (req) => {
    const { companyId } = req.user;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await db.select({ m: customerMessages, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` })
      .from(customerMessages).leftJoin(employees, eq(employees.id, customerMessages.byId))
      .where(eq(customerMessages.companyId, companyId)).orderBy(desc(customerMessages.createdAt)).limit(limit).offset(offset);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(customerMessages).where(eq(customerMessages.companyId, companyId));
    const counts = await messageCounts(rows.map((r) => r.m.id));
    // A document's words (kept for its PDF) aren't needed in the list.
    return { total, rows: rows.map((r) => ({ ...r.m, docContent: undefined, byName: r.by, counts: counts.get(r.m.id) ?? null })) };
  });

  /** One message: what it said, and each customer on it (sent, failed, skipped and why). */
  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const { companyId } = req.user;
    const [row] = await db.select({ m: customerMessages, by: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}` })
      .from(customerMessages).leftJoin(employees, eq(employees.id, customerMessages.byId))
      .where(and(eq(customerMessages.id, req.params.id), eq(customerMessages.companyId, companyId)));
    if (!row) throw new HttpError(404, "Message not found");
    const recipients = await db.select().from(customerMessageRecipients).where(eq(customerMessageRecipients.messageId, row.m.id))
      .orderBy(sql`case ${customerMessageRecipients.status} when 'failed' then 0 when 'sending' then 1 when 'queued' then 2 when 'sent' then 3 else 4 end`, asc(customerMessageRecipients.createdAt)).limit(5000);
    const counts = (await messageCounts([row.m.id])).get(row.m.id) ?? null;
    return { ...row.m, docContent: undefined, byName: row.by, counts, recipients: recipients.map((r) => ({ ...r, skipLabel: r.skipReason ? MESSAGE_SKIP_REASONS[r.skipReason as keyof typeof MESSAGE_SKIP_REASONS] ?? r.skipReason : null })) };
  });

  /** Stops a message that's still sending; customers not reached yet are skipped. */
  app.post<{ Params: { id: string } }>("/:id/stop", async (req) => {
    const { companyId } = req.user;
    const [m] = await db.select().from(customerMessages).where(and(eq(customerMessages.id, req.params.id), eq(customerMessages.companyId, companyId)));
    if (!m) throw new HttpError(404, "Message not found");
    if (m.status !== "sending") throw new HttpError(400, "It's already finished");
    await db.transaction(async (tx) => {
      await tx.update(customerMessages).set({ status: "stopped", finishedAt: new Date() }).where(eq(customerMessages.id, m.id));
      await tx.update(customerMessageRecipients).set({ status: "skipped", skipReason: "stopped" })
        .where(and(eq(customerMessageRecipients.messageId, m.id), eq(customerMessageRecipients.status, "queued")));
    });
    return { ok: true };
  });

  /** Phone numbers for the customers picked (for pasting into Talkroute's bulk texting), one per number. */
  app.post("/phones", async (req) => {
    const { companyId } = req.user;
    const ids = await selectedIds(companyId, parseSelection((req.body ?? {}) as Record<string, unknown>));
    const seen = new Set<string>();
    const phones: { name: string; phone: string }[] = [];
    let missing = 0, sample = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, ids.slice(i, i + 1000))));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids.slice(i, i + 1000)) {
        const c = byId.get(id);
        if (!c) continue;
        const digits = (c.phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        if (c.sample) { sample++; continue; }
        if (digits.length !== 10) { missing++; continue; }
        if (seen.has(digits)) continue;
        seen.add(digits);
        phones.push({ name: customerName(c), phone: formatPhone(digits) });
      }
    }
    return { phones, missing, sample };
  });

  /** A customer's emails from here (newest first) and whether they've unsubscribed. */
  app.get<{ Params: { customerId: string } }>("/customer/:customerId", async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.customerId);
    const rows = await db.select({ r: customerMessageRecipients, subject: customerMessages.subject, createdAt: customerMessages.createdAt })
      .from(customerMessageRecipients).innerJoin(customerMessages, eq(customerMessages.id, customerMessageRecipients.messageId))
      .where(and(eq(customerMessageRecipients.customerId, c.id), isNotNull(customerMessageRecipients.messageId)))
      .orderBy(desc(customerMessages.createdAt)).limit(50);
    return {
      emailOptOutAt: c.emailOptOutAt,
      messages: rows.map((x) => ({ id: x.r.messageId, subject: x.subject, createdAt: x.createdAt, status: x.r.status, sentAt: x.r.sentAt, email: x.r.email,
        skipLabel: x.r.skipReason ? MESSAGE_SKIP_REASONS[x.r.skipReason as keyof typeof MESSAGE_SKIP_REASONS] ?? x.r.skipReason : null })),
    };
  });

  /** Puts a customer who unsubscribed back on (only when they've asked to be). */
  app.post<{ Params: { customerId: string } }>("/customer/:customerId/resubscribe", async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.customerId);
    await db.update(customers).set({ emailOptOutAt: null, updatedAt: new Date() }).where(eq(customers.id, c.id));
    return { ok: true };
  });
};

export default routes;

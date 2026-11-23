import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { customerBillingRulesSchema, customerNoteSchema, formatMoney, hasRole, visitNumber } from "@crewdesk/shared";
import { db } from "../db";
import {
  cancellations, customerCredits, customerFiles, customers, customerMessageRecipients, customerMessages, customerNotes, customerPaymentMethods, employees, estimates,
  invoicePayments, invoices, prepayments, todos, visits,
} from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { fileView, sendStored, storeUpload } from "../lib/attachments";
import { customerInCompany } from "../lib/crm";
import { HttpError, parse } from "../lib/errors";
import { notify } from "../lib/notify";
import { companyToday } from "../lib/payRates";

const AREA = "customers" as const;
const FILES_MAX = 200;
const name = sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The customer's page, laid out like Homeworks': call notes (tell someone, make a follow-up to-do),
 * photos and documents, the timeline of everything that happened, the stats and revenue projection,
 * and payments by month. Managers in Customers & billing.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  /* ── Call notes and notes ── */

  app.get<{ Params: { id: string } }>("/:id/notes", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const rows = await db.select({ n: customerNotes, by: name, todoTitle: todos.title }).from(customerNotes)
      .leftJoin(employees, eq(employees.id, customerNotes.byId)).leftJoin(todos, eq(todos.id, customerNotes.todoId))
      .where(eq(customerNotes.customerId, c.id)).orderBy(desc(customerNotes.createdAt)).limit(200);
    const ids = [...new Set(rows.flatMap((r) => r.n.notifiedIds))];
    const people = ids.length ? await db.select({ id: employees.id, n: name }).from(employees).where(inArray(employees.id, ids)) : [];
    return rows.map((r) => ({ ...r.n, byName: r.by, todoTitle: r.todoTitle, notified: r.n.notifiedIds.map((x) => people.find((p) => p.id === x)?.n ?? "Someone") }));
  });

  /** Saves a call note or note; anyone ticked to be told gets a notification (with a link here). */
  app.post<{ Params: { id: string } }>("/:id/notes", async (req) => {
    const body = parse(customerNoteSchema, req.body);
    const { companyId, sub } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    const notifyIds = body.notifyIds.length
      ? (await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, body.notifyIds)))).map((e) => e.id)
      : [];
    if (body.todoId) {
      const [t] = await db.select({ id: todos.id }).from(todos).where(and(eq(todos.id, body.todoId), eq(todos.companyId, companyId)));
      if (!t) throw new HttpError(400, "That follow-up to-do wasn't found");
    }
    const [n] = await db.insert(customerNotes).values({ companyId, customerId: c.id, kind: body.kind, body: body.body, notifiedIds: notifyIds, todoId: body.todoId ?? null, byId: sub }).returning();
    if (notifyIds.length) {
      const [me] = await db.select({ n: name }).from(employees).where(eq(employees.id, sub));
      const who = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "a customer";
      notify(companyId, notifyIds.filter((x) => x !== sub), {
        category: "customers", title: `${body.kind === "call" ? "Call note" : "Note"} on ${who}${me?.n ? ` from ${me.n}` : ""}`,
        body: body.body.slice(0, 300), link: { screen: "customer", id: c.id },
      });
    }
    return n;
  });

  /** Whoever wrote it, or an admin. */
  app.delete<{ Params: { id: string; noteId: string } }>("/:id/notes/:noteId", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const [n] = await db.select().from(customerNotes).where(and(eq(customerNotes.id, req.params.noteId), eq(customerNotes.customerId, c.id)));
    if (!n) throw new HttpError(404, "Note not found");
    if (n.byId !== req.user.sub && !hasRole(req.user.role, "admin")) throw new HttpError(403, "Only whoever wrote it or an admin can remove it");
    await db.delete(customerNotes).where(eq(customerNotes.id, n.id));
    return { ok: true };
  });

  /** Their late fee and auto-send choices (company default, none/off, or their own). */
  app.put<{ Params: { id: string } }>("/:id/billing-rules", async (req) => {
    const body = parse(customerBillingRulesSchema, req.body);
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const [u] = await db.update(customers).set({
      lateFeeMode: body.lateFeeMode, lateFeeRules: body.lateFeeMode === "custom" ? body.lateFeeRules : null,
      autoSendMode: body.autoSendMode, autoSendSchedule: body.autoSendMode === "custom" ? body.autoSendSchedule ?? null : null, updatedAt: new Date(),
    }).where(eq(customers.id, c.id)).returning();
    return { lateFeeMode: u.lateFeeMode, lateFeeRules: u.lateFeeRules, autoSendMode: u.autoSendMode, autoSendSchedule: u.autoSendSchedule };
  });

  /* ── Photos and documents ── */

  const loadFile = async (customerId: string, fileId: string) => {
    const [f] = await db.select().from(customerFiles).where(and(eq(customerFiles.id, fileId), eq(customerFiles.customerId, customerId)));
    if (!f) throw new HttpError(404, "File not found");
    return f;
  };
  app.get<{ Params: { id: string } }>("/:id/files", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const rows = await db.select({ f: customerFiles, by: name }).from(customerFiles).leftJoin(employees, eq(employees.id, customerFiles.uploadedById))
      .where(eq(customerFiles.customerId, c.id)).orderBy(asc(customerFiles.createdAt));
    return rows.map((r) => fileView(r.f, r.by));
  });
  app.post<{ Params: { id: string } }>("/:id/files", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(customerFiles).where(eq(customerFiles.customerId, c.id));
    if (n >= FILES_MAX) throw new HttpError(400, `A customer can have up to ${FILES_MAX} photos and documents`);
    const stored = await storeUpload(req, "customers", c.id);
    const [row] = await db.insert(customerFiles).values({ companyId: req.user.companyId, customerId: c.id, ...stored, uploadedById: req.user.sub }).returning();
    return fileView(row);
  });
  app.get<{ Params: { id: string; fileId: string }; Querystring: { download?: string } }>("/:id/files/:fileId", async (req, reply) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    return sendStored(reply, await loadFile(c.id, req.params.fileId), !!req.query.download);
  });
  app.patch<{ Params: { id: string; fileId: string } }>("/:id/files/:fileId", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const f = await loadFile(c.id, req.params.fileId);
    const { caption } = parse(z.object({ caption: z.string().trim().max(300).nullable() }), req.body);
    const [row] = await db.update(customerFiles).set({ caption: caption || null }).where(eq(customerFiles.id, f.id)).returning();
    return fileView(row);
  });
  app.delete<{ Params: { id: string; fileId: string } }>("/:id/files/:fileId", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const f = await loadFile(c.id, req.params.fileId);
    await db.delete(customerFiles).where(eq(customerFiles.id, f.id));
    return { ok: true };
  });

  /* ── Stats and revenue projection ── */

  /**
   * Like Homeworks' Customer Stat box: money collected, owed, past-due invoices, visits done and
   * their average value; plus last and next service, and what open work orders will bring in today,
   * this week, this month and this year.
   */
  app.get<{ Params: { id: string } }>("/:id/stats", async (req) => {
    const { companyId } = req.user;
    const c = await customerInCompany(db, companyId, req.params.id);
    const today = await companyToday(companyId);
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const weekEnd = addDays(today, 6 - dow);
    const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const yearEnd = `${today.slice(0, 4)}-12-31`;
    const [paid] = await db.select({ cents: sql<number>`coalesce(sum(${invoicePayments.amountCents} - ${invoicePayments.refundedCents}), 0)::int` }).from(invoicePayments)
      .where(and(eq(invoicePayments.customerId, c.id), eq(invoicePayments.status, "completed")));
    const [owed] = await db.select({
      cents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents}), 0)::int`,
      pastDue: sql<number>`count(*) filter (where ${invoices.dueDate} < ${today}::date)::int`,
    }).from(invoices).where(and(eq(invoices.customerId, c.id), inArray(invoices.status, ["sent", "partial"])));
    const value = sql`(select coalesce(sum(l.amount_cents), 0) from visit_lines l where l.visit_id = ${visits.id})`;
    const [done] = await db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${value}), 0)::int`, last: sql<string | null>`max(${visits.date})::text` })
      .from(visits).where(and(eq(visits.customerId, c.id), eq(visits.status, "completed")));
    const open = and(eq(visits.customerId, c.id), inArray(visits.status, ["open", "on_site"]), eq(visits.billing, "invoice"));
    const [proj] = await db.select({
      today: sql<number>`coalesce(sum(${value}) filter (where ${visits.date} = ${today}::date), 0)::int`,
      week: sql<number>`coalesce(sum(${value}) filter (where ${visits.date} between ${today}::date and ${weekEnd}::date), 0)::int`,
      month: sql<number>`coalesce(sum(${value}) filter (where ${visits.date} between ${today}::date and ${monthEnd}::date), 0)::int`,
      year: sql<number>`coalesce(sum(${value}) filter (where ${visits.date} between ${today}::date and ${yearEnd}::date), 0)::int`,
      next: sql<string | null>`min(${visits.date}) filter (where ${visits.date} >= ${today}::date)`,
    }).from(visits).where(open);
    return {
      collectedCents: paid.cents, balanceCents: owed.cents, pastDueInvoices: owed.pastDue, visitsDone: done.n,
      averageVisitCents: done.n ? Math.round(done.cents / done.n) : 0, lastService: done.last, nextService: proj.next ? String(proj.next).slice(0, 10) : null,
      projection: { todayCents: proj.today, weekCents: proj.week, monthCents: proj.month, yearCents: proj.year },
    };
  });

  /* ── Payments by month ── */

  app.get<{ Params: { id: string }; Querystring: { year?: string; month?: string } }>("/:id/payments", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const year = Number(req.query.year) || null, month = Number(req.query.month) || null;
    const where = [eq(invoicePayments.customerId, c.id), inArray(invoicePayments.status, ["completed", "pending", "void"])];
    if (year) where.push(sql`extract(year from ${invoicePayments.receivedOn}) = ${year}`);
    if (year && month) where.push(sql`extract(month from ${invoicePayments.receivedOn}) = ${month}`);
    const rows = await db.select({ p: invoicePayments, number: invoices.number }).from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
      .where(and(...where)).orderBy(desc(invoicePayments.receivedOn), desc(invoicePayments.createdAt)).limit(300);
    const years = await db.select({ y: sql<number>`distinct extract(year from ${invoicePayments.receivedOn})::int` }).from(invoicePayments).where(eq(invoicePayments.customerId, c.id));
    return {
      years: years.map((y) => y.y).sort((a, b) => b - a),
      rows: rows.map(({ p, number }) => ({ id: p.id, invoiceId: p.invoiceId, invoiceNumber: number, amountCents: p.amountCents, refundedCents: p.refundedCents, method: p.method, methodDetail: p.methodDetail, reference: p.reference, receivedOn: p.receivedOn, status: p.status })),
    };
  });

  /* ── Timeline ── */

  /**
   * Everything that happened with the customer, newest first (like Homeworks' Timeline): notes and
   * call notes, invoices sent, payments, estimates sent and answered, emails to many customers, work
   * orders done or skipped, cards and bank accounts saved, credits, prepayments, cancellations.
   */
  app.get<{ Params: { id: string }; Querystring: { kinds?: string; limit?: string } }>("/:id/timeline", async (req) => {
    const c = await customerInCompany(db, req.user.companyId, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 300);
    const kinds = new Set((req.query.kinds ?? "").split(",").filter(Boolean));
    const want = (k: string) => !kinds.size || kinds.has(k);
    type Item = { kind: string; at: string; title: string; body?: string | null; by?: string | null; href?: string | null; tone?: "ok" | "bad" | "warn" | null; id: string };
    const items: Item[] = [];
    const iso = (d: Date | string | null) => (d instanceof Date ? d.toISOString() : d ? `${d}T12:00:00.000Z` : "");
    if (want("note")) {
      const rows = await db.select({ n: customerNotes, by: name }).from(customerNotes).leftJoin(employees, eq(employees.id, customerNotes.byId))
        .where(eq(customerNotes.customerId, c.id)).orderBy(desc(customerNotes.createdAt)).limit(limit);
      for (const { n, by } of rows) items.push({ kind: "note", id: n.id, at: iso(n.createdAt), title: n.kind === "call" ? "Call note" : "Note", body: n.body, by, href: n.todoId ? `/todos/${n.todoId}` : null });
    }
    if (want("email")) {
      const sentInv = await db.select({ id: invoices.id, number: invoices.number, at: invoices.emailedAt, to: invoices.emailedTo, total: invoices.totalCents }).from(invoices)
        .where(and(eq(invoices.customerId, c.id), sql`${invoices.emailedAt} is not null`)).orderBy(desc(invoices.emailedAt)).limit(limit);
      for (const r of sentInv) items.push({ kind: "email", id: `inv-${r.id}`, at: iso(r.at), title: `Invoice ${r.number} emailed`, body: `${formatMoney(r.total)} to ${r.to}`, href: `/invoices/${r.id}` });
      const msgs = await db.select({ r: customerMessageRecipients, subject: customerMessages.subject, by: name }).from(customerMessageRecipients)
        .innerJoin(customerMessages, eq(customerMessages.id, customerMessageRecipients.messageId)).leftJoin(employees, eq(employees.id, customerMessages.byId))
        .where(and(eq(customerMessageRecipients.customerId, c.id), inArray(customerMessageRecipients.status, ["sent", "failed"]))).orderBy(desc(customerMessageRecipients.createdAt)).limit(limit);
      for (const { r, subject, by } of msgs) items.push({ kind: "email", id: `msg-${r.id}`, at: iso(r.sentAt ?? r.createdAt), title: r.status === "sent" ? "Email sent" : "Email didn't go", body: `${subject}${r.error ? ` (${r.error})` : ""}`, by, href: `/customers/messages/${r.messageId}`, tone: r.status === "failed" ? "bad" : null });
    }
    if (want("estimate")) {
      const ests = await db.select().from(estimates).where(eq(estimates.customerId, c.id)).orderBy(desc(estimates.createdAt)).limit(limit);
      for (const e of ests) {
        if (e.sentAt) items.push({ kind: "estimate", id: `est-s-${e.id}`, at: iso(e.sentAt), title: `Estimate ${e.number} sent`, body: `${e.title ?? ""} ${formatMoney(e.totalCents)}`.trim(), href: `/estimates/${e.id}` });
        if (e.respondedAt) items.push({ kind: "estimate", id: `est-r-${e.id}`, at: iso(e.respondedAt), title: `Estimate ${e.number} ${e.status === "accepted" ? "accepted" : e.status === "declined" ? "declined" : "changes requested"}`, body: e.responseComment, by: e.respondedBy === "customer" ? e.responseName ?? "The customer" : null, href: `/estimates/${e.id}`, tone: e.status === "accepted" ? "ok" : e.status === "declined" ? "bad" : "warn" });
      }
    }
    if (want("payment")) {
      const pays = await db.select({ p: invoicePayments, number: invoices.number }).from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
        .where(and(eq(invoicePayments.customerId, c.id), inArray(invoicePayments.status, ["completed", "pending"]))).orderBy(desc(invoicePayments.createdAt)).limit(limit);
      for (const { p, number } of pays) items.push({ kind: "payment", id: `pay-${p.id}`, at: iso(p.createdAt), title: `Payment ${formatMoney(p.amountCents)}${p.status === "pending" ? " (clearing)" : ""}`, body: `Invoice ${number} · ${p.methodDetail ?? p.method}${p.reference ? ` #${p.reference}` : ""}`, href: `/invoices/${p.invoiceId}`, tone: "ok" });
      const pps = await db.select().from(prepayments).where(and(eq(prepayments.customerId, c.id), inArray(prepayments.status, ["open", "closed", "pending"]))).orderBy(desc(prepayments.createdAt)).limit(limit);
      for (const p of pps) items.push({ kind: "payment", id: `pp-${p.id}`, at: iso(p.createdAt), title: `Prepayment PP-${p.number}: ${formatMoney(p.amountCents)}`, body: p.description, tone: "ok" });
      const crs = await db.select().from(customerCredits).where(eq(customerCredits.customerId, c.id)).orderBy(desc(customerCredits.createdAt)).limit(limit);
      for (const cr of crs) items.push({ kind: "payment", id: `cr-${cr.id}`, at: iso(cr.createdAt), title: `Credit CR-${cr.number}: ${formatMoney(cr.amountCents)}${cr.status === "void" ? " (void)" : ""}`, body: cr.description });
      const pms = await db.select().from(customerPaymentMethods).where(eq(customerPaymentMethods.customerId, c.id));
      for (const m of pms) items.push({ kind: "payment", id: `pm-${m.id}`, at: iso(m.createdAt), title: `${m.type === "ach" ? "Bank account" : "Card"} saved`, body: `${m.type === "ach" ? m.bankName ?? "Bank" : m.brand ?? "Card"} ·· ${m.last4} (by ${m.addedBy === "office" ? "the office" : "the customer"})` });
    }
    if (want("work")) {
      const vs = await db.select().from(visits).where(and(eq(visits.customerId, c.id), inArray(visits.status, ["completed", "skipped"]))).orderBy(desc(visits.updatedAt)).limit(limit);
      for (const v of vs) items.push({ kind: "work", id: `wo-${v.id}`, at: iso(v.completedAt ?? v.updatedAt), title: `${visitNumber(v.number)} ${v.status === "completed" ? "done" : "skipped"}`, body: v.title, href: `/visits/${v.id}`, tone: v.status === "completed" ? "ok" : "warn" });
    }
    if (want("account")) {
      const cs = await db.select({ x: cancellations, by: name }).from(cancellations).leftJoin(employees, eq(employees.id, cancellations.byId))
        .where(and(eq(cancellations.customerId, c.id), sql`${cancellations.propertyId} is null`));
      for (const { x, by } of cs) {
        items.push({ kind: "account", id: `cx-${x.id}`, at: iso(x.createdAt), title: `Cancelled: ${x.reasonLabel}`, body: x.comment, by, tone: "bad" });
        if (x.reactivatedAt) items.push({ kind: "account", id: `re-${x.id}`, at: iso(x.reactivatedAt), title: "Reactivated", tone: "ok" });
      }
      items.push({ kind: "account", id: `new-${c.id}`, at: iso(c.createdAt), title: c.status === "lead" ? "Added as a lead" : "Added as a customer" });
    }
    items.sort((a, b) => b.at.localeCompare(a.at));
    return items.slice(0, limit);
  });
};

export default routes;

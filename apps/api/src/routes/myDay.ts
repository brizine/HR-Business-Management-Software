import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AUTOMATION_ACTIONS, customerName, invoiceBalance, isOverdue } from "@crewdesk/shared";
import { db } from "../db";
import {
  automationSteps, automations, crews, customerCredits, customerTexts, customers, employees, estimates, invoicePayments, invoices, prepayments, todoAssignees, todos, visits,
} from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { emailHealth } from "../lib/emailHealth";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = (c: { kind: string; firstName: string | null; lastName: string | null; companyName: string | null } | null) => (c ? customerName(c) : "—");

/**
 * My Day (like Homeworks'): the account standing, job stats for a date range, and short lists of
 * what needs attention: automations waiting for review, upcoming to-dos, today's work orders,
 * recent payments, invoices and estimates.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", "customers"));

  app.get("/", async (req) => {
    const { companyId } = req.user;
    const today = await companyToday(companyId);
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
    const from = q.from ?? today, to = q.to && q.to >= from ? q.to : from;
    const cust = { kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, id: customers.id };

    // Account standing: what's owed (past due and not yet due), credit on account, and money in over the range.
    const [owed] = await db.select({
      pastDue: sql<number>`coalesce(sum(case when ${invoices.dueDate} < ${today} then ${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents} else 0 end), 0)::int`,
      outstanding: sql<number>`coalesce(sum(case when ${invoices.dueDate} >= ${today} then ${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents} else 0 end), 0)::int`,
    }).from(invoices).where(and(eq(invoices.companyId, companyId), inArray(invoices.status, ["sent", "partial"])));
    const [credit] = await db.select({ n: sql<number>`coalesce(sum(${customerCredits.amountCents} - ${customerCredits.appliedCents}), 0)::int` }).from(customerCredits)
      .where(and(eq(customerCredits.companyId, companyId), ne(customerCredits.status, "void")));
    const [paidInv] = await db.select({ n: sql<number>`coalesce(sum(${invoicePayments.amountCents} - ${invoicePayments.refundedCents}), 0)::int` }).from(invoicePayments)
      .where(and(eq(invoicePayments.companyId, companyId), eq(invoicePayments.status, "completed"), ne(invoicePayments.method, "prepaid"), gte(invoicePayments.receivedOn, from), lte(invoicePayments.receivedOn, to)));
    const [paidPre] = await db.select({ n: sql<number>`coalesce(sum(${prepayments.amountCents} - ${prepayments.refundedCents}), 0)::int` }).from(prepayments)
      .where(and(eq(prepayments.companyId, companyId), inArray(prepayments.status, ["open", "closed"]), gte(prepayments.receivedOn, from), lte(prepayments.receivedOn, to)));

    // Job stats: work orders dated in the range.
    const jobRows = await db.select({ status: visits.status, n: sql<number>`count(*)::int` }).from(visits)
      .where(and(eq(visits.companyId, companyId), gte(visits.date, from), lte(visits.date, to))).groupBy(visits.status);
    const jobs = (s: string) => jobRows.find((r) => r.status === s)?.n ?? 0;

    // Automation actions waiting for review.
    const review = await db.select({ id: automationSteps.id, at: automationSteps.createdAt, action: automationSteps.action, name: automations.name, c: cust })
      .from(automationSteps).innerJoin(automations, eq(automations.id, automationSteps.automationId)).leftJoin(customers, eq(customers.id, automationSteps.customerId))
      .where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review"))).orderBy(asc(automationSteps.createdAt)).limit(6);
    const [{ reviewTotal }] = await db.select({ reviewTotal: sql<number>`count(*)::int` }).from(automationSteps).where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review")));

    // Upcoming to-dos (not done, from today), with who they're for.
    const todoRows = await db.select({ id: todos.id, title: todos.title, date: todos.date, startTime: todos.startTime, color: todos.color, c: cust }).from(todos)
      .leftJoin(customers, eq(customers.id, todos.customerId))
      .where(and(eq(todos.companyId, companyId), isNull(todos.doneAt), gte(todos.date, today))).orderBy(asc(todos.date), asc(todos.startTime)).limit(8);
    const who = todoRows.length ? await db.select({ todoId: todoAssignees.todoId, first: employees.firstName, last: employees.lastName }).from(todoAssignees)
      .innerJoin(employees, eq(employees.id, todoAssignees.employeeId)).where(inArray(todoAssignees.todoId, todoRows.map((t) => t.id))) : [];
    const [{ overdueTodos }] = await db.select({ overdueTodos: sql<number>`count(*)::int` }).from(todos).where(and(eq(todos.companyId, companyId), isNull(todos.doneAt), sql`${todos.date} < ${today}`));

    // Today's work orders.
    const visitRows = await db.select({ id: visits.id, title: visits.title, status: visits.status, startTime: visits.startTime, crew: crews.name, c: cust }).from(visits)
      .innerJoin(customers, eq(customers.id, visits.customerId)).leftJoin(crews, eq(crews.id, visits.crewId))
      .where(and(eq(visits.companyId, companyId), eq(visits.date, today))).orderBy(asc(visits.startTime), asc(visits.title)).limit(10);
    const [{ visitsToday }] = await db.select({ visitsToday: sql<number>`count(*)::int` }).from(visits).where(and(eq(visits.companyId, companyId), eq(visits.date, today)));

    // Recent payments, invoices and estimates.
    const payRows = await db.select({ id: invoicePayments.id, amountCents: invoicePayments.amountCents, method: invoicePayments.method, methodDetail: invoicePayments.methodDetail, receivedOn: invoicePayments.receivedOn, status: invoicePayments.status, invoiceId: invoicePayments.invoiceId, number: invoices.number, c: cust })
      .from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId)).leftJoin(customers, eq(customers.id, invoicePayments.customerId))
      .where(and(eq(invoicePayments.companyId, companyId), ne(invoicePayments.method, "prepaid"), inArray(invoicePayments.status, ["completed", "pending"]))).orderBy(desc(invoicePayments.createdAt)).limit(6);
    const invRows = await db.select({ inv: invoices, c: cust }).from(invoices).leftJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(invoices.companyId, companyId), ne(invoices.status, "void"))).orderBy(desc(invoices.updatedAt)).limit(6);
    const estRows = await db.select({ id: estimates.id, number: estimates.number, title: estimates.title, status: estimates.status, totalCents: estimates.totalCents, validUntil: estimates.validUntil, updatedAt: estimates.updatedAt, c: cust })
      .from(estimates).leftJoin(customers, eq(customers.id, estimates.customerId)).where(eq(estimates.companyId, companyId)).orderBy(desc(estimates.updatedAt)).limit(6);

    // Estimates waiting on an answer: how many and what they come to; the ones that run out soonest (or were sent longest ago).
    const pending = and(eq(estimates.companyId, companyId), inArray(estimates.status, ["sent", "changes"]), sql`(${estimates.validUntil} is null or ${estimates.validUntil} >= ${today})`);
    const [w] = await db.select({ n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${estimates.totalCents}), 0)::int`, unseen: sql<number>`count(*) filter (where ${estimates.viewedAt} is null)::int`,
      soon: sql<number>`count(*) filter (where ${estimates.validUntil} <= ${addDays(today, 7)})::int` }).from(estimates).where(pending);
    const waitRows = await db.select({ id: estimates.id, number: estimates.number, title: estimates.title, status: estimates.status, totalCents: estimates.totalCents, validUntil: estimates.validUntil, sentAt: estimates.sentAt, viewedAt: estimates.viewedAt, c: cust })
      .from(estimates).leftJoin(customers, eq(customers.id, estimates.customerId)).where(pending)
      .orderBy(sql`${estimates.validUntil} asc nulls last`, asc(estimates.sentAt)).limit(6);

    const [{ unreadTexts }] = await db.select({ unreadTexts: sql<number>`count(*)::int` }).from(customerTexts)
      .where(and(eq(customerTexts.companyId, companyId), eq(customerTexts.direction, "in"), isNull(customerTexts.readAt)));

    return {
      today, from, to,
      standing: { pastDueCents: owed.pastDue, outstandingCents: owed.outstanding, creditCents: credit.n, paidCents: paidInv.n + paidPre.n },
      jobs: { total: jobRows.reduce((s, r) => s + (r.status === "skipped" ? 0 : r.n), 0), notStarted: jobs("open"), inProgress: jobs("on_site"), completed: jobs("completed"), skipped: jobs("skipped") },
      review: { total: reviewTotal, rows: review.map((r) => ({ id: r.id, at: r.at, automation: r.name, step: AUTOMATION_ACTIONS[r.action.action]?.label ?? "", customer: r.c?.id ? { id: r.c.id, name: name(r.c) } : null })) },
      todos: { overdue: overdueTodos, rows: todoRows.map((t) => ({ id: t.id, title: t.title, date: t.date, startTime: t.startTime, color: t.color, customer: t.c?.id ? { id: t.c.id, name: name(t.c) } : null, people: who.filter((w) => w.todoId === t.id).map((w) => `${w.first} ${w.last}`) })) },
      visits: { total: visitsToday, rows: visitRows.map((v) => ({ id: v.id, title: v.title, status: v.status, startTime: v.startTime, crew: v.crew, customer: { id: v.c.id, name: name(v.c) } })) },
      payments: payRows.map((p) => ({ id: p.id, amountCents: p.amountCents, method: p.method, methodDetail: p.methodDetail, receivedOn: p.receivedOn, status: p.status, invoiceId: p.invoiceId, invoiceNumber: p.number, customer: p.c?.id ? { id: p.c.id, name: name(p.c) } : null })),
      invoices: invRows.map(({ inv, c }) => ({ id: inv.id, number: inv.number, status: inv.status, totalCents: inv.totalCents, balanceCents: invoiceBalance(inv), dueDate: inv.dueDate, overdue: isOverdue(inv, today), customer: c?.id ? { id: c.id, name: name(c) } : null })),
      estimates: estRows.map((e) => ({ id: e.id, number: e.number, title: e.title, status: e.status, totalCents: e.totalCents, expired: !!e.validUntil && e.validUntil < today && (e.status === "sent" || e.status === "changes"), customer: e.c?.id ? { id: e.c.id, name: name(e.c) } : null })),
      waiting: {
        count: w.n, totalCents: w.cents, notSeen: w.unseen, expiringSoon: w.soon,
        rows: waitRows.map((e) => ({ id: e.id, number: e.number, title: e.title, status: e.status, totalCents: e.totalCents, validUntil: e.validUntil, sentAt: e.sentAt, seen: !!e.viewedAt,
          daysLeft: e.validUntil ? Math.round((Date.parse(`${e.validUntil}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : null, customer: e.c?.id ? { id: e.c.id, name: name(e.c) } : null })),
      },
      unreadTexts,
    };
  });

  /** Email deliverability: sending setup (SPF, DKIM, DMARC), what went out to customers, and addresses that can't get email. */
  app.get("/email", async (req) => emailHealth(req.user.companyId));
};

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export default routes;

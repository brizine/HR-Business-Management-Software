import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  AUTOMATION_ACTIONS, BEFORE_HOUR, NOT_ANSWERED_DAYS, TEXT_HOURS, TODO_DUE_TIME, customerName, fillTags, isInactive, isTextAction, triggerDef, triggerLabel,
  type ActionDef, type AutomationAction, type AutomationCond, type AutomationDef, type AutomationSubject, type TriggerKey,
} from "@crewdesk/shared";
import { db } from "../db";
import {
  automationEvents, automationRuns, automationSteps, automations, cancellations, companies, customerPaymentMethods, customers, employees, estimateLines, estimates,
  crewMembers, invoicePayments, invoices, tagEvents, templates, todoAssignees, todos, visitAssignees, visits, workOrders,
} from "../db/schema";
import { emailTransport } from "./channels";
import { recordTagChanges } from "./crm";
import { notify } from "./notify";
import { sendTemplateEmail, sendTemplateText, templateVars, fillTemplateText, type TemplateContext } from "./templates";
import { sendStaffText } from "./texting";
import { localParts, zonedTime } from "./tz";

/**
 * Runs automations and sequences (see shared/automations). Every few minutes, with the other
 * scheduled checks:
 *  1. For each automation that's on, it looks for what has happened since it was turned on (at
 *     most a week back) and starts a run for each thing, once. A sequence runs the first block whose
 *     trigger happened and whose conditions are true (any one group of AND conditions); when none
 *     match, the run is kept as "skipped".
 *  2. Each run's actions are queued with their times. Due ones are done: texts wait for 9 AM–6 PM,
 *     "review before execution" holds them in Review, and a sequence stops (doing its stop actions)
 *     when any "stop when" happens.
 */

type Automation = typeof automations.$inferSelect;
type Run = typeof automationRuns.$inferSelect;
type Step = typeof automationSteps.$inferSelect;
type Co = { id: string; tz: string; testOf: string | null };
type Found = { trigger: TriggerKey; customerId: string | null; subjectType: AutomationSubject; subjectId: string | null; at: Date; key: string };

const MIN = 60_000;
const DAY = 86_400_000;
const LOOKBACK = 7 * DAY;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** A condition's identity (its trigger and picks), to know which one found something. */
const condId = (c: AutomationCond) => `${c.key}|${c.tagIds.join(",")}|${c.categoryIds.join(",")}|${c.serviceIds.join(",")}`;

/* ───────────── 1. What happened ───────────── */

/** Things that happened for a trigger since `since` (or, for "before" triggers, what's that many days away at 9 AM). */
async function detect(cond: AutomationCond, a: Automation, co: Co, now: Date): Promise<Found[]> {
  const k = cond.key as TriggerKey;
  const def = a.def;
  const since = new Date(Math.max(a.enabledAt?.getTime() ?? now.getTime(), now.getTime() - LOOKBACK));
  const local = localParts(now, co.tz);
  const sinceDate = localParts(since, co.tz).date;
  const nineAm = local.minutes >= BEFORE_HOUR * 60;
  const daysBefore = def.kind === "simple" ? def.daysBefore ?? 1 : 1;
  const out = <R extends { id: string; customerId: string | null; at: Date | null }>(rows: R[], subjectType: AutomationSubject, key: (r: R) => string, subjectId: (r: R) => string | null = (r) => r.id): Found[] =>
    rows.map((r) => ({ trigger: k, customerId: r.customerId, subjectType, subjectId: subjectId(r), at: r.at ?? now, key: key(r) }));
  const events = async (kind: string) => db.select({ id: automationEvents.id, customerId: automationEvents.customerId, at: automationEvents.createdAt, subjectId: automationEvents.subjectId }).from(automationEvents)
    .where(and(eq(automationEvents.companyId, co.id), eq(automationEvents.kind, kind), gte(automationEvents.createdAt, since)));
  const estimatesWith = (statuses: string[]) => db.select({ id: estimates.id, customerId: estimates.customerId, at: estimates.respondedAt, status: estimates.status }).from(estimates)
    .where(and(eq(estimates.companyId, co.id), inArray(estimates.status, statuses), gte(estimates.respondedAt, since)));
  const owed = sql`${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents} > 0`;

  switch (k) {
    case "certain_time": {
      if (def.kind !== "simple" || !def.runAt) return [];
      const [date, time] = def.runAt.split("T");
      const at = zonedTime(date, time, co.tz);
      const on = a.enabledAt?.getTime() ?? now.getTime();
      return at <= now && at.getTime() >= on - MIN && at.getTime() >= now.getTime() - LOOKBACK
        ? [{ trigger: k, customerId: null, subjectType: "none", subjectId: null, at, key: `time:${def.runAt}` }] : [];
    }
    case "add_visit": {
      // A repeating work order adds many at once: one run for the series (its first).
      const rows = await db.select({ id: visits.id, customerId: visits.customerId, at: visits.createdAt, seriesId: visits.seriesId }).from(visits)
        .where(and(eq(visits.companyId, co.id), gte(visits.createdAt, since), eq(visits.status, "open"))).orderBy(asc(visits.date), asc(visits.createdAt));
      return out(rows, "visit", (r) => (r.seriesId ? `visit-series:${r.seriesId}:added` : `visit:${r.id}:added`));
    }
    case "before_visit": {
      if (!nineAm) return [];
      const day = addDays(local.date, daysBefore);
      const rows = await db.select({ id: visits.id, customerId: visits.customerId, at: sql<Date | null>`null` }).from(visits)
        .where(and(eq(visits.companyId, co.id), eq(visits.status, "open"), eq(visits.date, day)));
      return out(rows, "visit", (r) => `visit:${r.id}:before:${day}`);
    }
    case "complete_visit": case "stop_timer": {
      const rows = await db.select({ id: visits.id, customerId: visits.customerId, at: visits.completedAt }).from(visits)
        .where(and(eq(visits.companyId, co.id), gte(visits.completedAt, since)));
      return out(rows, "visit", (r) => `visit:${r.id}:completed`);
    }
    case "visit_skipped": case "property_not_serviced": {
      const rows = await db.select({ id: visits.id, customerId: visits.customerId, at: visits.skippedAt }).from(visits)
        .where(and(eq(visits.companyId, co.id), gte(visits.skippedAt, since)));
      return out(rows, "visit", (r) => `visit:${r.id}:skipped`);
    }
    case "start_timer": {
      const rows = await db.select({ id: visits.id, customerId: visits.customerId, at: visits.startedAt }).from(visits)
        .where(and(eq(visits.companyId, co.id), gte(visits.startedAt, since)));
      return out(rows, "visit", (r) => `visit:${r.id}:started`);
    }
    case "todo_created": {
      const rows = await db.select({ id: todos.id, customerId: todos.customerId, at: todos.createdAt, seriesId: todos.seriesId }).from(todos)
        .where(and(eq(todos.companyId, co.id), gte(todos.createdAt, since))).orderBy(asc(todos.date), asc(todos.createdAt));
      return out(rows, "todo", (r) => (r.seriesId ? `todo-series:${r.seriesId}:added` : `todo:${r.id}:added`));
    }
    case "before_todo": {
      if (!nineAm) return [];
      const day = addDays(local.date, daysBefore);
      const rows = await db.select({ id: todos.id, customerId: todos.customerId, at: sql<Date | null>`null` }).from(todos)
        .where(and(eq(todos.companyId, co.id), isNull(todos.doneAt), eq(todos.date, day)));
      return out(rows, "todo", (r) => `todo:${r.id}:before:${day}`);
    }
    case "complete_task": {
      const rows = await db.select({ id: todos.id, customerId: todos.customerId, at: todos.doneAt }).from(todos)
        .where(and(eq(todos.companyId, co.id), gte(todos.doneAt, since)));
      return out(rows, "todo", (r) => `todo:${r.id}:done`);
    }
    case "add_maintenance": {
      const rows = await db.select({ id: workOrders.id, customerId: sql<string | null>`null`, at: workOrders.createdAt }).from(workOrders)
        .where(and(eq(workOrders.companyId, co.id), gte(workOrders.createdAt, since)));
      return out(rows, "maintenance", (r) => `maintenance:${r.id}:added`);
    }
    case "before_maintenance": {
      if (!nineAm) return [];
      const day = addDays(local.date, daysBefore);
      const rows = await db.select({ id: workOrders.id, customerId: sql<string | null>`null`, at: sql<Date | null>`null` }).from(workOrders)
        .where(and(eq(workOrders.companyId, co.id), isNull(workOrders.completedAt), notInArray(workOrders.status, ["completed", "cancelled", "closed"]), eq(workOrders.dueDate, day)));
      return out(rows, "maintenance", (r) => `maintenance:${r.id}:before:${day}`);
    }
    case "complete_maintenance": {
      const rows = await db.select({ id: workOrders.id, customerId: sql<string | null>`null`, at: workOrders.completedAt }).from(workOrders)
        .where(and(eq(workOrders.companyId, co.id), gte(workOrders.completedAt, since)));
      return out(rows, "maintenance", (r) => `maintenance:${r.id}:done`);
    }
    case "customer_added": {
      const rows = await db.select({ id: customers.id, customerId: customers.id, at: customers.createdAt }).from(customers)
        .where(and(eq(customers.companyId, co.id), gte(customers.createdAt, since)));
      return out(rows, "customer", (r) => `customer:${r.id}:added`);
    }
    case "customer_inactive": {
      const rows = await db.select({ id: cancellations.id, customerId: cancellations.customerId, at: cancellations.createdAt }).from(cancellations)
        .innerJoin(customers, eq(customers.id, cancellations.customerId))
        .where(and(eq(cancellations.companyId, co.id), gte(cancellations.createdAt, since), eq(customers.status, "cancelled"), isNull(cancellations.reactivatedAt)));
      return out(rows, "customer", (r) => `customer:${r.customerId}:cancelled:${localParts(r.at ?? now, co.tz).date}`, (r) => r.customerId);
    }
    case "tag_added": case "tag_removed": {
      if (!cond.tagIds.length) return [];
      const rows = await db.select({ id: tagEvents.id, customerId: tagEvents.customerId, at: tagEvents.createdAt }).from(tagEvents)
        .where(and(eq(tagEvents.companyId, co.id), inArray(tagEvents.tagId, cond.tagIds), eq(tagEvents.action, k === "tag_added" ? "add" : "remove"), isNotNull(tagEvents.customerId), gte(tagEvents.createdAt, since)));
      return out(rows, "customer", (r) => `tag:${r.id}`, (r) => r.customerId);
    }
    case "estimate_create": {
      const rows = await db.select({ id: estimates.id, customerId: estimates.customerId, at: estimates.createdAt }).from(estimates)
        .where(and(eq(estimates.companyId, co.id), gte(estimates.createdAt, since)));
      return out(rows, "estimate", (r) => `estimate:${r.id}:created`);
    }
    case "estimate_sent": {
      const rows = await db.select({ id: estimates.id, customerId: estimates.customerId, at: estimates.sentAt }).from(estimates)
        .where(and(eq(estimates.companyId, co.id), gte(estimates.sentAt, since)));
      return out(rows, "estimate", (r) => `estimate:${r.id}:sent`);
    }
    case "estimate_accept": case "estimate_declined": case "estimate_changes": case "estimate_responded": {
      const statuses = k === "estimate_responded" ? ["accepted", "declined"] : [{ estimate_accept: "accepted", estimate_declined: "declined", estimate_changes: "changes" }[k]];
      return out(await estimatesWith(statuses), "estimate", (r) => `estimate:${r.id}:${r.status}:${r.at?.getTime() ?? 0}`);
    }
    case "estimate_not_responded": {
      const cutoff = new Date(now.getTime() - NOT_ANSWERED_DAYS * DAY);
      const rows = await db.select({ id: estimates.id, customerId: estimates.customerId, at: estimates.sentAt }).from(estimates)
        .where(and(eq(estimates.companyId, co.id), eq(estimates.status, "sent"), lte(estimates.sentAt, cutoff), gte(estimates.sentAt, new Date(since.getTime() - NOT_ANSWERED_DAYS * DAY))));
      return out(rows.map((r) => ({ ...r, at: r.at ? new Date(r.at.getTime() + NOT_ANSWERED_DAYS * DAY) : now })), "estimate", (r) => `estimate:${r.id}:noanswer`);
    }
    case "invoice_sent": {
      const sentAt = sql<Date | null>`coalesce(${invoices.emailedAt}, ${invoices.autoSentAt}, ${invoices.mailedAt})`;
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId, at: sentAt }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), isNotNull(invoices.number), notInArray(invoices.status, ["draft", "void"]), gte(invoices.createdAt, new Date(since.getTime() - 30 * DAY)),
          or(gte(invoices.emailedAt, since), gte(invoices.autoSentAt, since), gte(invoices.mailedAt, since), sql`${invoices.sentOn} > ${sinceDate}`)));
      return out(rows.map((r) => ({ ...r, at: r.at ? new Date(r.at) : null })), "invoice", (r) => `invoice:${r.id}:sent`);
    }
    case "invoice_past_due": {
      // Due before today, and past due since it was turned on.
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId, at: sql<Date | null>`null`, due: invoices.dueDate }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), inArray(invoices.status, ["sent", "partial"]), sql`${invoices.dueDate} < ${local.date}`, gte(invoices.dueDate, addDays(sinceDate, -1)), owed));
      return out(rows, "invoice", (r) => `invoice:${r.id}:pastdue:${r.due}`);
    }
    case "before_invoice_past_due": {
      if (!nineAm) return [];
      const day = addDays(local.date, daysBefore);
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId, at: sql<Date | null>`null` }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), inArray(invoices.status, ["sent", "partial"]), eq(invoices.dueDate, day), owed));
      return out(rows, "invoice", (r) => `invoice:${r.id}:due-in-${daysBefore}:${day}`);
    }
    case "invoice_paid_in_full": {
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId, at: sql<Date | null>`(select max(p.created_at) from ${invoicePayments} p where p.invoice_id = ${invoices.id} and p.status = 'completed')` }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), eq(invoices.status, "paid"),
          sql`exists (select 1 from ${invoicePayments} p where p.invoice_id = ${invoices.id} and p.status = 'completed' and p.created_at >= ${since.toISOString()})`));
      return out(rows.map((r) => ({ ...r, at: r.at ? new Date(r.at) : null })), "invoice", (r) => `invoice:${r.id}:paid`);
    }
    case "invoice_partially_paid": {
      const rows = await db.select({ id: invoicePayments.id, customerId: invoicePayments.customerId, at: invoicePayments.createdAt, invoiceId: invoicePayments.invoiceId }).from(invoicePayments)
        .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
        .where(and(eq(invoicePayments.companyId, co.id), eq(invoicePayments.status, "completed"), gte(invoicePayments.createdAt, since), eq(invoices.status, "partial")));
      return out(rows, "invoice", (r) => `payment:${r.id}:partial`, (r) => r.invoiceId);
    }
    case "invoice_write_off": {
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId, at: invoices.voidedAt }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), gte(invoices.voidedAt, since)));
      return out(rows, "invoice", (r) => `invoice:${r.id}:void`);
    }
    case "payment_to_account": {
      const rows = await db.select({ id: invoicePayments.id, customerId: invoicePayments.customerId, at: invoicePayments.createdAt }).from(invoicePayments)
        .where(and(eq(invoicePayments.companyId, co.id), eq(invoicePayments.status, "completed"), ne(invoicePayments.method, "prepaid"), gte(invoicePayments.createdAt, since)));
      return out(rows, "payment", (r) => `payment:${r.id}`);
    }
    case "customer_payment_declined":
      return out(await events("payment_declined"), "invoice", (r) => `event:${r.id}`, (r) => r.subjectId);
    case "payment_receipt":
      return out(await events("receipt_sent"), "payment", (r) => `event:${r.id}`, (r) => r.subjectId);
    case "customer_removed_credit_card": case "customer_removed_bank_account":
      return out(await events(k === "customer_removed_credit_card" ? "card_removed" : "bank_removed"), "customer", (r) => `event:${r.id}`, (r) => r.customerId);
    case "customer_added_a_credit_card": case "customer_added_bank_account": {
      const rows = await db.select({ id: customerPaymentMethods.id, customerId: customerPaymentMethods.customerId, at: customerPaymentMethods.createdAt }).from(customerPaymentMethods)
        .where(and(eq(customerPaymentMethods.companyId, co.id), eq(customerPaymentMethods.type, k === "customer_added_bank_account" ? "ach" : "card"), gte(customerPaymentMethods.createdAt, since)));
      return out(rows, "customer", (r) => `method:${r.id}`, (r) => r.customerId);
    }
    default:
      // Conditions only, and triggers Crewdesk doesn't have.
      return [];
  }
}

/* ───────────── Conditions and stops ───────────── */

type Subject = { customerId: string | null; subjectType: string; subjectId: string | null };

/** The estimate, invoice or to-do a run is about (a payment's invoice counts as its invoice). */
async function subjectRow(s: Subject) {
  if (!s.subjectId) return {};
  if (s.subjectType === "estimate") return { estimate: (await db.select().from(estimates).where(eq(estimates.id, s.subjectId)))[0] ?? null };
  if (s.subjectType === "todo") return { todo: (await db.select().from(todos).where(eq(todos.id, s.subjectId)))[0] ?? null };
  if (s.subjectType === "visit") return { visit: (await db.select().from(visits).where(eq(visits.id, s.subjectId)))[0] ?? null };
  if (s.subjectType === "maintenance") return { fix: (await db.select().from(workOrders).where(eq(workOrders.id, s.subjectId)))[0] ?? null };
  if (s.subjectType === "invoice") return { invoice: (await db.select().from(invoices).where(eq(invoices.id, s.subjectId)))[0] ?? null };
  if (s.subjectType === "payment") {
    const [p] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, s.subjectId));
    return { payment: p ?? null, invoice: p ? (await db.select().from(invoices).where(eq(invoices.id, p.invoiceId)))[0] ?? null : null };
  }
  return {};
}

const hasMethod = async (customerId: string, type?: "card" | "ach") =>
  (await db.select({ id: customerPaymentMethods.id }).from(customerPaymentMethods).where(and(eq(customerPaymentMethods.customerId, customerId), type ? eq(customerPaymentMethods.type, type) : undefined)).limit(1)).length > 0;

/** Whether a condition is true now for this customer (and what the run is about). */
async function condTrue(c: AutomationCond, s: Subject, co: Co): Promise<boolean> {
  const k = c.key as TriggerKey;
  const [cust] = s.customerId ? await db.select({ status: customers.status, tagIds: customers.tagIds }).from(customers).where(eq(customers.id, s.customerId)) : [];
  const sub = await subjectRow(s);
  switch (k) {
    case "customer_has_tag": return !!cust && c.tagIds.some((t) => cust.tagIds.includes(t));
    case "customer_does_not_have_tag": return !!cust && !c.tagIds.some((t) => cust.tagIds.includes(t));
    case "customer_inactive": return cust?.status === "cancelled";
    case "has_no_recurring_job": {
      if (!s.customerId) return false;
      const today = localParts(new Date(), co.tz).date;
      const [r] = await db.select({ id: visits.id }).from(visits).where(and(eq(visits.customerId, s.customerId), eq(visits.status, "open"), isNotNull(visits.seriesId), gte(visits.date, today))).limit(1);
      return !r;
    }
    case "customer_does_not_have_card_on_file": return !!s.customerId && !(await hasMethod(s.customerId));
    case "customer_added_a_credit_card": return !!s.customerId && hasMethod(s.customerId, "card");
    case "customer_added_bank_account": return !!s.customerId && hasMethod(s.customerId, "ach");
    case "estimate_draft": return sub.estimate?.status === "draft";
    case "estimate_accept": return sub.estimate?.status === "accepted";
    case "estimate_declined": return sub.estimate?.status === "declined";
    case "estimate_changes": return sub.estimate?.status === "changes";
    case "estimate_responded": return ["accepted", "declined"].includes(sub.estimate?.status ?? "");
    case "estimate_service": {
      if (!sub.estimate || !c.serviceIds.length) return false;
      const [l] = await db.select({ id: estimateLines.id }).from(estimateLines).where(and(eq(estimateLines.estimateId, sub.estimate.id), inArray(estimateLines.serviceTypeId, c.serviceIds))).limit(1);
      return !!l;
    }
    case "todo_has_category": return !!sub.todo?.categoryId && c.categoryIds.includes(sub.todo.categoryId);
    case "invoice_paid_in_full": return sub.invoice?.status === "paid";
    case "invoice_partially_paid": return sub.invoice?.status === "partial";
    default: return false;
  }
}

/** Why a running sequence should stop (one of its "stop when" happened), or null. */
async function stopReason(def: AutomationDef, run: Run, co: Co): Promise<string | null> {
  if (def.kind !== "sequence" || !def.stops.length) return null;
  const since = run.createdAt;
  const sub = await subjectRow(run);
  const said = (c: AutomationCond) => `Stopped: ${triggerLabel(c.key, "stop")}`;
  for (const c of def.stops) {
    const k = c.key as TriggerKey;
    let hit = false;
    const estimateNow = async (statuses: string[]) => {
      if (sub.estimate !== undefined) return !!sub.estimate && statuses.includes(sub.estimate.status);
      if (!run.customerId) return false;
      return (await db.select({ id: estimates.id }).from(estimates).where(and(eq(estimates.customerId, run.customerId), inArray(estimates.status, statuses), gte(estimates.respondedAt, since))).limit(1)).length > 0;
    };
    switch (k) {
      case "estimate_accept": hit = await estimateNow(["accepted"]); break;
      case "estimate_declined": hit = await estimateNow(["declined"]); break;
      case "estimate_changes": hit = await estimateNow(["changes"]); break;
      case "estimate_responded": hit = await estimateNow(["accepted", "declined"]); break;
      case "invoice_paid_in_full": case "invoice_partially_paid": case "invoice_write_off": {
        const want = { invoice_paid_in_full: "paid", invoice_partially_paid: "partial", invoice_write_off: "void" }[k];
        if (sub.invoice !== undefined) hit = sub.invoice?.status === want;
        else if (run.customerId) hit = (await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.customerId, run.customerId), eq(invoices.status, want), gte(invoices.updatedAt, since))).limit(1)).length > 0;
        break;
      }
      case "payment_to_account":
        hit = !!run.customerId && (await db.select({ id: invoicePayments.id }).from(invoicePayments)
          .where(and(eq(invoicePayments.customerId, run.customerId), eq(invoicePayments.status, "completed"), ne(invoicePayments.method, "prepaid"), gte(invoicePayments.createdAt, since))).limit(1)).length > 0;
        break;
      case "tag_added": case "tag_removed":
        hit = !!run.customerId && c.tagIds.length > 0 && (await db.select({ id: tagEvents.id }).from(tagEvents)
          .where(and(eq(tagEvents.customerId, run.customerId), inArray(tagEvents.tagId, c.tagIds), eq(tagEvents.action, k === "tag_added" ? "add" : "remove"), gte(tagEvents.createdAt, since))).limit(1)).length > 0;
        break;
      case "add_visit":
        hit = !!run.customerId && (await db.select({ id: visits.id }).from(visits).where(and(eq(visits.customerId, run.customerId), gte(visits.createdAt, since), run.subjectId ? ne(visits.id, run.subjectId) : undefined)).limit(1)).length > 0;
        break;
      case "complete_visit": case "visit_skipped": {
        const col = k === "complete_visit" ? visits.completedAt : visits.skippedAt;
        if (sub.visit !== undefined) hit = !!sub.visit && (k === "complete_visit" ? sub.visit.status === "completed" : sub.visit.status === "skipped");
        else if (run.customerId) hit = (await db.select({ id: visits.id }).from(visits).where(and(eq(visits.customerId, run.customerId), gte(col, since))).limit(1)).length > 0;
        break;
      }
      case "complete_task":
        if (sub.todo !== undefined) hit = !!sub.todo?.doneAt;
        else if (run.customerId) hit = (await db.select({ id: todos.id }).from(todos).where(and(eq(todos.customerId, run.customerId), gte(todos.doneAt, since))).limit(1)).length > 0;
        break;
      default:
        hit = await condTrue(c, run, co);
    }
    if (hit) return said(c);
  }
  return null;
}

/**
 * Whether the thing a run is about is still there and still makes sense for this action (a
 * deleted invoice, a voided one, a work order no longer coming up…). The reason to skip, or null.
 */
async function subjectProblem(run: Run): Promise<string | null> {
  if (!run.subjectId || run.subjectType === "customer" || run.subjectType === "none") return null;
  const sub = await subjectRow(run);
  const what = { visit: "work order", todo: "to-do", maintenance: "repair order", estimate: "estimate", invoice: "invoice", payment: "payment" }[run.subjectType] ?? "record";
  const row = sub.visit ?? sub.todo ?? sub.fix ?? sub.estimate ?? sub.payment ?? sub.invoice;
  if (!row) return `The ${what} was deleted`;
  if (sub.invoice?.status === "void" && run.triggerKey !== "invoice_write_off") return "The invoice was voided";
  switch (run.triggerKey) {
    case "before_visit": return sub.visit?.status === "open" ? null : "The work order isn't coming up any more";
    case "before_todo": return sub.todo?.doneAt ? "The to-do is done" : null;
    case "before_maintenance": return sub.fix?.completedAt ? "The repair order is done" : null;
    case "before_invoice_past_due": case "invoice_past_due": return sub.invoice && ["sent", "partial"].includes(sub.invoice.status) ? null : `The invoice is ${sub.invoice?.status ?? "gone"}`;
    case "estimate_not_responded": return sub.estimate?.status === "sent" ? null : "The estimate was answered";
  }
  return null;
}

/* ───────────── Starting runs ───────────── */

/** Starts a run for each new thing an automation's triggers found (once each). */
async function startRuns(a: Automation, co: Co, now: Date) {
  const def = a.def;
  const triggers = def.kind === "simple" ? [def.trigger] : def.blocks.map((b) => b.trigger);
  const found = new Map<string, Found & { via: Set<string> }>();
  for (const c of triggers) {
    const id = condId(c);
    for (const f of await detect(c, a, co, now)) {
      const had = found.get(f.key);
      if (had) had.via.add(id); else found.set(f.key, { ...f, via: new Set([id]) });
    }
  }
  if (!found.size) return 0;
  const keys = [...found.keys()];
  const have = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500);
    for (const r of await db.select({ k: automationRuns.dedupeKey }).from(automationRuns).where(and(eq(automationRuns.automationId, a.id), inArray(automationRuns.dedupeKey, part)))) have.add(r.k);
  }
  const fresh = [...found.values()].filter((f) => !have.has(f.key));
  if (!fresh.length) return 0;
  const ids = [...new Set(fresh.map((f) => f.customerId).filter((x): x is string => !!x))];
  const custs = new Map(ids.length ? (await db.select({ id: customers.id, sample: customers.sample, off: customers.automationOffIds }).from(customers).where(inArray(customers.id, ids))).map((c) => [c.id, c]) : []);
  let started = 0;
  for (const f of fresh) {
    const c = f.customerId ? custs.get(f.customerId) : null;
    if (f.customerId && !c) continue;
    // Sample customers never get real messages (except in a test company).
    if (c?.sample && !co.testOf) continue;
    let blockIndex: number | null = null;
    let reason: string | null = null;
    if (c?.off.includes(a.id)) reason = "Turned off for this customer";
    else if (def.kind === "sequence") {
      for (const [i, b] of def.blocks.entries()) {
        if (!f.via.has(condId(b.trigger))) continue;
        // No conditions: always. Otherwise any one group whose conditions are all true.
        let ok = b.when.length === 0;
        for (const group of b.when) {
          let all = true;
          for (const cond of group) if (!(await condTrue(cond, f, co))) { all = false; break; }
          if (all) { ok = true; break; }
        }
        if (ok) { blockIndex = i; break; }
      }
      if (blockIndex == null) reason = "Its conditions weren't met";
    }
    const [run] = await db.insert(automationRuns).values({
      companyId: co.id, automationId: a.id, customerId: f.customerId, subjectType: f.subjectType, subjectId: f.subjectId, triggerKey: f.trigger, blockIndex,
      dedupeKey: f.key, triggeredAt: f.at, status: reason ? "skipped" : "running", reason, finishedAt: reason ? now : null,
    }).onConflictDoNothing().returning();
    if (!run || reason) continue;
    const before = !!triggerDef(f.trigger)?.before;
    const actions = def.kind === "simple"
      ? [{ ...def.action, waitMinutes: before || f.trigger === "certain_time" ? 0 : def.delayMinutes }]
      : def.blocks[blockIndex!].actions;
    await db.insert(automationSteps).values(actions.map((act, idx) => ({
      companyId: co.id, runId: run.id, automationId: a.id, customerId: f.customerId, kind: "action", idx, action: act,
      dueAt: new Date(f.at.getTime() + act.waitMinutes * MIN),
    })));
    started++;
  }
  return started;
}

/* ───────────── Doing actions ───────────── */

/** 9 AM to 6 PM in the company's time zone: when, if not now, a text can go. */
function textTime(now: Date, tz: string): Date | null {
  const l = localParts(now, tz);
  if (l.minutes >= TEXT_HOURS.start * 60 && l.minutes < TEXT_HOURS.end * 60) return null;
  const day = l.minutes < TEXT_HOURS.start * 60 ? l.date : addDays(l.date, 1);
  return zonedTime(day, `${String(TEXT_HOURS.start).padStart(2, "0")}:00`, tz);
}
const isText = (act: AutomationAction) => isTextAction(act.action);

/** What a run's messages fill in from. */
async function contextFor(run: Run): Promise<TemplateContext> {
  const ctx: TemplateContext = { customerId: run.customerId };
  const id = run.subjectId;
  if (!id) return ctx;
  if (run.subjectType === "visit") ctx.visitId = id;
  if (run.subjectType === "todo") ctx.todoId = id;
  if (run.subjectType === "maintenance") ctx.maintenanceId = id;
  if (run.subjectType === "estimate") ctx.estimateId = id;
  if (run.subjectType === "invoice") ctx.invoiceId = id;
  if (run.subjectType === "payment") {
    ctx.paymentId = id;
    ctx.invoiceId = (await db.select({ i: invoicePayments.invoiceId }).from(invoicePayments).where(eq(invoicePayments.id, id)))[0]?.i ?? null;
  }
  return ctx;
}

/** The owner(s), or the chosen employees: active people in this company. */
async function people(companyId: string, act: AutomationAction, to: "owner" | "employee") {
  const rows = await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, email: employees.email, phone: employees.phone, status: employees.status, role: employees.role })
    .from(employees).where(and(eq(employees.companyId, companyId), to === "owner" || !act.employeeIds.length ? eq(employees.role, "owner") : inArray(employees.id, act.employeeIds)));
  return rows.filter((p) => !isInactive(p.status));
}

/** Whoever a run's work order or to-do is given to (the work order's crew too); the owner when it's no one's. */
async function assignedPeople(companyId: string, run: Run) {
  let ids: string[] = [];
  if (run.subjectType === "visit" && run.subjectId) {
    const direct = await db.select({ id: visitAssignees.employeeId }).from(visitAssignees).where(eq(visitAssignees.visitId, run.subjectId));
    const crew = await db.select({ id: crewMembers.employeeId }).from(visits).innerJoin(crewMembers, eq(crewMembers.crewId, visits.crewId)).where(eq(visits.id, run.subjectId));
    ids = [...direct, ...crew].map((r) => r.id);
  } else if (run.subjectType === "todo" && run.subjectId) {
    ids = (await db.select({ id: todoAssignees.employeeId }).from(todoAssignees).where(eq(todoAssignees.todoId, run.subjectId))).map((r) => r.id);
  }
  const rows = await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, email: employees.email, phone: employees.phone, status: employees.status, role: employees.role })
    .from(employees).where(and(eq(employees.companyId, companyId), ids.length ? inArray(employees.id, [...new Set(ids)]) : eq(employees.role, "owner")));
  return rows.filter((p) => !isInactive(p.status));
}
const names = (ps: { first: string | null; last: string | null }[]) => ps.map((p) => [p.first, p.last].filter(Boolean).join(" ")).join(", ");

type Outcome = { status: "done" | "skipped" | "failed"; detail: string };

/** Does one action; says what happened. */
export async function doAction(a: Automation, run: Run, act: AutomationAction, co: Co, at: Date): Promise<Outcome> {
  const def = AUTOMATION_ACTIONS[act.action] as ActionDef;
  const ctx = await contextFor(run);
  const [tpl] = act.templateId ? await db.select().from(templates).where(and(eq(templates.id, act.templateId), eq(templates.companyId, a.companyId))) : [];
  if (def.channel) {
    if (!tpl) return { status: "failed", detail: act.templateId ? "Its template was deleted" : "No template is chosen" };
    if (tpl.channel !== def.channel) return { status: "failed", detail: `"${tpl.name}" is ${tpl.channel === "email" ? "an email" : "a text"} template` };
  }
  const [cust] = run.customerId ? await db.select().from(customers).where(eq(customers.id, run.customerId)) : [];
  if (def.to === "customer" && !cust) return { status: "skipped", detail: "No customer" };
  if (cust?.automationOffIds.includes(a.id)) return { status: "skipped", detail: "Turned off for this customer" };
  try {
    switch (act.action) {
      case "email_customer": {
        if (!cust.email) return { status: "skipped", detail: `${customerName(cust)} has no email address` };
        if (cust.emailOptOutAt) return { status: "skipped", detail: `${customerName(cust)} unsubscribed from emails` };
        if (!emailTransport()) return { status: "failed", detail: "Email isn't set up on this server" };
        const m = await sendTemplateEmail({ companyId: a.companyId, template: tpl, to: cust.email, ctx });
        return { status: "done", detail: `Message sent to ${customerName(cust)} at ${cust.email} successfully ("${m.subject}")` };
      }
      case "text_customer": {
        const r = await sendTemplateText({ companyId: a.companyId, template: tpl, ctx, by: null, source: "automation" });
        if (r.skipped) return { status: "skipped", detail: r.skipped };
        return r.sent ? { status: "done", detail: `Message sent to ${customerName(cust)}${r.phone ? ` at ${r.phone}` : ""} successfully` } : { status: "failed", detail: `Text didn't go: ${r.error ?? ""}` };
      }
      case "email_admin": case "email_employee": {
        if (!emailTransport()) return { status: "failed", detail: "Email isn't set up on this server" };
        const to = (await people(a.companyId, act, def.to as "owner" | "employee")).filter((p) => p.email);
        if (!to.length) return { status: "skipped", detail: "No one to email" };
        let subject = "";
        for (const p of to) subject = (await sendTemplateEmail({ companyId: a.companyId, template: tpl, to: p.email, ctx, internal: true })).subject;
        return { status: "done", detail: `Message sent to ${to.map((p) => `${names([p])} at ${p.email}`).join(", ")} successfully ("${subject}")` };
      }
      case "text_admin": case "text_employee": {
        const to = (await people(a.companyId, act, def.to as "owner" | "employee")).filter((p) => p.phone);
        if (!to.length) return { status: "skipped", detail: "No one with a mobile number to text" };
        const body = fillTemplateText(tpl.body, await templateVars(a.companyId, ctx));
        const results = [];
        for (const p of to) results.push({ p, r: await sendStaffText(a.companyId, p.phone, body) });
        const sent = results.filter((x) => x.r.sent).map((x) => x.p);
        if (sent.length) return { status: "done", detail: `Message sent to ${sent.map((p) => `${names([p])} at ${p.phone}`).join(", ")} successfully` };
        const why = results[0].r;
        return why.skipped ? { status: "skipped", detail: why.skipped } : { status: "failed", detail: `Text didn't go: ${why.error ?? ""}` };
      }
      case "push_notification": {
        // A reminder to whoever the work order or to-do is given to (its crew too); else the owner.
        const to = await assignedPeople(a.companyId, run);
        if (!to.length) return { status: "skipped", detail: "No one to notify" };
        const v = await templateVars(a.companyId, ctx);
        const about = [v.EVENT_TITLE, v.CUSTOMER_NAME, [v.EVENT_DATE, v.EVENT_SCHEDULED_TIME].filter(Boolean).join(" at ")].filter(Boolean).join(" · ");
        const link = run.subjectType === "visit" && run.subjectId ? { screen: "workorder" as const, id: run.subjectId }
          : run.subjectType === "todo" && run.subjectId ? { screen: "todos" as const, id: run.subjectId }
          : cust ? { screen: "customer" as const, id: cust.id } : { screen: "automations" as const };
        notify(a.companyId, to.map((p) => p.id), { category: run.subjectType === "todo" ? "todos" : run.subjectType === "visit" ? "workorders" : "customers", title: a.name.slice(0, 200), body: (about || triggerLabel(run.triggerKey, "simple")).slice(0, 400), link });
        return { status: "done", detail: `Push notification sent to ${names(to)}` };
      }
      case "add_tag": case "remove_tag": {
        if (!act.tagId) return { status: "failed", detail: "No tag is chosen" };
        const has = cust.tagIds.includes(act.tagId);
        if ((act.action === "add_tag") === has) return { status: "skipped", detail: act.action === "add_tag" ? "They already have the tag" : "They don't have the tag" };
        const after = act.action === "add_tag" ? [...cust.tagIds, act.tagId] : cust.tagIds.filter((t) => t !== act.tagId);
        await db.transaction(async (tx) => {
          await tx.update(customers).set({ tagIds: after, updatedAt: new Date() }).where(eq(customers.id, cust.id));
          await recordTagChanges(tx, { companyId: a.companyId, before: cust.tagIds, after, customerId: cust.id, source: "automation", byId: null });
        });
        return { status: "done", detail: act.action === "add_tag" ? "Tag added" : "Tag removed" };
      }
      case "create_assign_todo": {
        // Due 8 AM the day after its waiting period.
        const date = addDays(localParts(at, co.tz).date, 1);
        const title = (fillTags(act.todoTitle ?? "", await templateVars(a.companyId, ctx)).trim() || a.name).slice(0, 200);
        const [t] = await db.insert(todos).values({ companyId: a.companyId, title, notes: `From the automation "${a.name}".`, customerId: cust?.id ?? null, date, startTime: TODO_DUE_TIME }).returning();
        const who = await people(a.companyId, act, "employee");
        if (who.length) await db.insert(todoAssignees).values(who.map((p) => ({ todoId: t.id, employeeId: p.id }))).onConflictDoNothing();
        notify(a.companyId, who.map((p) => p.id), { category: "todos", title: `New to-do: ${t.title}`, body: cust ? `For ${customerName(cust)}, due ${date} at 8 AM.` : `Due ${date} at 8 AM.`, link: { screen: "todos", id: t.id } });
        return { status: "done", detail: `To-do "${t.title}" for ${names(who) || "no one"}, due ${date} 8 AM` };
      }
    }
  } catch (e) {
    return { status: "failed", detail: (e as Error).message.slice(0, 300) };
  }
}

/* ───────────── Runs and steps ───────────── */

/** Marks a run done once nothing's left waiting. */
async function finishIfDone(runId: string, now: Date) {
  const [left] = await db.select({ id: automationSteps.id }).from(automationSteps).where(and(eq(automationSteps.runId, runId), inArray(automationSteps.status, ["waiting", "review"]))).limit(1);
  if (!left) await db.update(automationRuns).set({ status: "done", finishedAt: now }).where(and(eq(automationRuns.id, runId), eq(automationRuns.status, "running")));
}

/** Stops a run: what's still waiting won't happen. A sequence's stop actions are queued, each after its waiting period (when it's a "stop when"). */
export async function stopRun(a: Automation, run: Run, reason: string, now: Date, o: { stopActions: boolean }) {
  const [r] = await db.update(automationRuns).set({ status: "stopped", reason, finishedAt: now }).where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, "running"))).returning();
  await db.update(automationSteps).set({ status: "stopped", detail: reason, dueAt: null, doneAt: now })
    .where(and(eq(automationSteps.runId, run.id), eq(automationSteps.kind, "action"), inArray(automationSteps.status, ["waiting", "review"])));
  if (r && o.stopActions && a.def.kind === "sequence" && a.def.stopActions.length) {
    await db.insert(automationSteps).values(a.def.stopActions.map((act, idx) => ({
      companyId: run.companyId, runId: run.id, automationId: a.id, customerId: run.customerId, kind: "stop", idx, action: act, dueAt: new Date(now.getTime() + act.waitMinutes * MIN),
    })));
  }
}

/** Does a step that's due (or waits for daytime or review, or stops the run). */
async function processStep(step: Step, run: Run, a: Automation, co: Co, now: Date): Promise<void> {
  const mark = (o: { status: string; detail: string }) => db.update(automationSteps).set({ status: o.status, detail: o.detail, doneAt: now, dueAt: null }).where(eq(automationSteps.id, step.id));
  // Run by another automation ("run another automation"): goes even while this one is off.
  const chained = run.dedupeKey.startsWith("after:");
  if (!a.enabled && !chained) {
    if (step.kind === "stop") { await mark({ status: "stopped", detail: "The automation was turned off" }); return; }
    await stopRun(a, run, "The automation was turned off", now, { stopActions: false });
    return;
  }
  if (step.kind === "action") {
    if (run.status !== "running") { await mark({ status: "stopped", detail: run.reason ?? "The run had stopped" }); return; }
    const why = await stopReason(a.def, run, co);
    if (why) { await stopRun(a, run, why, now, { stopActions: true }); return; }
    const problem = await subjectProblem(run);
    if (problem) { await mark({ status: "skipped", detail: problem }); await finishIfDone(run.id, now); return; }
  }
  if (isText(step.action)) {
    const later = textTime(now, co.tz);
    if (later) { await db.update(automationSteps).set({ dueAt: later }).where(eq(automationSteps.id, step.id)); return; }
  }
  if (a.review && !step.reviewedAt) {
    await db.update(automationSteps).set({ status: "review", dueAt: null }).where(eq(automationSteps.id, step.id));
    return;
  }
  const result = await doAction(a, run, step.action, co, step.dueAt ?? now);
  await mark(result);
  if (step.kind === "action" && result.status === "done" && a.def.kind === "simple") await subAction(a, run, now);
  await finishIfDone(run.id, now);
}

/** After an automation's action: run another one, or turn this one off. */
async function subAction(a: Automation, run: Run, now: Date) {
  const def = a.def;
  if (def.kind !== "simple") return;
  if (def.subAction === "stop_automation") {
    await db.update(automations).set({ enabled: false, updatedAt: now }).where(eq(automations.id, a.id));
    return;
  }
  if (def.subAction !== "run_automation" || !def.subAutomationId) return;
  const [next] = await db.select().from(automations).where(and(eq(automations.id, def.subAutomationId), eq(automations.companyId, a.companyId)));
  if (!next || next.def.kind !== "simple" || next.id === a.id) return;
  const [r] = await db.insert(automationRuns).values({
    companyId: a.companyId, automationId: next.id, customerId: run.customerId, subjectType: run.subjectType, subjectId: run.subjectId, triggerKey: run.triggerKey,
    dedupeKey: `after:${run.id}`, triggeredAt: now, status: "running", reason: `Run by "${a.name}"`,
  }).onConflictDoNothing().returning();
  if (r) await db.insert(automationSteps).values({ companyId: a.companyId, runId: r.id, automationId: next.id, customerId: run.customerId, kind: "action", idx: 0, action: next.def.action, dueAt: new Date(now.getTime() + def.subDelayMinutes * MIN) });
}

/** Does the steps that are due (claiming each first, so two checks at once don't both do it). */
async function processDueSteps(now: Date) {
  const due = await db.select({ step: automationSteps, run: automationRuns, a: automations, tz: companies.timezone, testOf: companies.testOfCompanyId }).from(automationSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationSteps.runId)).innerJoin(automations, eq(automations.id, automationSteps.automationId))
    .innerJoin(companies, eq(companies.id, automationSteps.companyId))
    .where(and(eq(automationSteps.status, "waiting"), lte(automationSteps.dueAt, now))).orderBy(asc(automationSteps.dueAt), asc(automationSteps.idx)).limit(500);
  let n = 0;
  for (const { step, run, a, tz, testOf } of due) {
    const [claimed] = await db.update(automationSteps).set({ dueAt: new Date(now.getTime() + 10 * MIN) })
      .where(and(eq(automationSteps.id, step.id), eq(automationSteps.status, "waiting"), lte(automationSteps.dueAt, now))).returning();
    if (!claimed) continue;
    // The run may have changed (stopped by an earlier step this round).
    const [fresh] = await db.select().from(automationRuns).where(eq(automationRuns.id, run.id));
    try {
      await processStep(claimed, fresh ?? run, a, { id: a.companyId, tz, testOf }, now);
    } catch (e) {
      console.error(`Automation step ${step.id} failed:`, (e as Error).message);
      await db.update(automationSteps).set({ status: "failed", detail: (e as Error).message.slice(0, 300), doneAt: now, dueAt: null }).where(eq(automationSteps.id, step.id));
    }
    n++;
  }
  return n;
}

/** Starts runs for what's happened and does the actions that are due. */
export async function runAutomations(now = new Date()) {
  const list = await db.select({ a: automations, tz: companies.timezone, testOf: companies.testOfCompanyId }).from(automations)
    .innerJoin(companies, eq(companies.id, automations.companyId)).where(eq(automations.enabled, true));
  let started = 0;
  for (const { a, tz, testOf } of list) {
    try { started += await startRuns(a, { id: a.companyId, tz, testOf }, now); }
    catch (e) { console.error(`Automation ${a.id} failed to check:`, (e as Error).message); }
  }
  const steps = await processDueSteps(now);
  return { started, steps };
}

/* ───────────── Review ───────────── */

/** Send (now, or at 9 AM for a text at night), skip, or stop the whole run, for an action waiting in Review. */
export async function reviewStep(companyId: string, stepId: string, decision: "send" | "skip" | "stop", by: string) {
  const [row] = await db.select({ step: automationSteps, run: automationRuns, a: automations, tz: companies.timezone, testOf: companies.testOfCompanyId }).from(automationSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationSteps.runId)).innerJoin(automations, eq(automations.id, automationSteps.automationId))
    .innerJoin(companies, eq(companies.id, automationSteps.companyId))
    .where(and(eq(automationSteps.id, stepId), eq(automationSteps.companyId, companyId)));
  if (!row || row.step.status !== "review") return null;
  const now = new Date();
  const co = { id: companyId, tz: row.tz, testOf: row.testOf };
  if (decision === "stop") await stopRun(row.a, row.run, "Stopped in review", now, { stopActions: false });
  else if (decision === "skip") {
    await db.update(automationSteps).set({ status: "skipped", detail: "Skipped in review", doneAt: now, reviewedById: by, reviewedAt: now }).where(eq(automationSteps.id, stepId));
    await finishIfDone(row.run.id, now);
  } else {
    const [step] = await db.update(automationSteps).set({ status: "waiting", dueAt: now, reviewedById: by, reviewedAt: now }).where(eq(automationSteps.id, stepId)).returning();
    // Even when the automation's been turned off since: someone chose to send it.
    await processStep(step, row.run, { ...row.a, enabled: true }, co, now);
  }
  return (await db.select().from(automationSteps).where(eq(automationSteps.id, stepId)))[0];
}

/** Actions waiting in Review (for the badge and My Day). */
export async function reviewCount(companyId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(automationSteps).where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review")));
  return n;
}

/** What a waiting action will say (for Review): the template filled in for this run. */
export async function previewStep(step: Step, run: Run) {
  const act = step.action;
  if (!act.templateId) return null;
  const [tpl] = await db.select().from(templates).where(eq(templates.id, act.templateId));
  if (!tpl) return null;
  const vars = await templateVars(step.companyId, await contextFor(run));
  return tpl.channel === "email"
    ? { channel: "email" as const, subject: fillTags(tpl.subject ?? "", vars), body: fillTags(tpl.body, vars, { html: true }) }
    : { channel: "text" as const, subject: null, body: fillTemplateText(tpl.body, vars) };
}

export const _test = { textTime, detect, condTrue, stopReason };

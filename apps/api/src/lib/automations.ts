import { and, asc, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  AUTOMATION_TRIGGERS, CUSTOMER_FACING, TEXT_HOURS, customerName, fillTemplate, formatAddress, formatMoney, invoiceBalance,
  type AutomationStep, type AutomationTrigger, type StopCondition,
} from "@crewdesk/shared";
import { db } from "../db";
import {
  automationRuns, automations, companies, customers, employees, estimates, invoicePayments, invoices, messageTemplates, properties, tagEvents, todoAssignees, todos, visits,
} from "../db/schema";
import { WEB_URL, emailTransport } from "./channels";
import { recordTagChanges } from "./crm";
import { companyInfo, messageVars, renderCustomerEmail } from "./customerMessages";
import { payLinkFor, portalUrl } from "./invoices";
import { notify } from "./notify";
import { sendCustomerText } from "./texting";
import { localParts, zonedTime } from "./tz";

/**
 * Runs automations. Every few minutes (with the other scheduled checks) it looks for what has
 * happened since each automation was turned on, starts a run for each (once per thing), and does
 * the steps that are due. Steps wait in between; texts only go out in the daytime; a run stops
 * when its "stop when" happens; with "review first", customer emails and texts wait for approval.
 */

type Automation = typeof automations.$inferSelect;
type Run = typeof automationRuns.$inferSelect;
type Co = { id: string; tz: string; testOf: string | null };
type Found = { customerId: string; subjectType: string; subjectId: string | null; dedupeKey: string };

const DAY = 86_400_000;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** What has happened since the automation was turned on (looking back at most a week). */
async function detect(a: Automation, co: Co, now: Date): Promise<Found[]> {
  const since = new Date(Math.max(a.enabledAt?.getTime() ?? now.getTime(), now.getTime() - 7 * DAY));
  const local = localParts(now, co.tz);
  const sinceDate = localParts(since, co.tz).date;
  const t = a.trigger as AutomationTrigger;
  const est = (status?: string) => db.select({ id: estimates.id, customerId: estimates.customerId }).from(estimates)
    .where(and(eq(estimates.companyId, co.id), status ? and(eq(estimates.status, status), gte(estimates.respondedAt, since)) : gte(estimates.sentAt, since)));
  switch (t) {
    case "estimate_sent":
      return (await est()).map((r) => ({ customerId: r.customerId, subjectType: "estimate", subjectId: r.id, dedupeKey: `estimate:${r.id}` }));
    case "estimate_accepted": case "estimate_declined": case "estimate_changes": {
      const status = { estimate_accepted: "accepted", estimate_declined: "declined", estimate_changes: "changes" }[t];
      return (await est(status)).map((r) => ({ customerId: r.customerId, subjectType: "estimate", subjectId: r.id, dedupeKey: `estimate:${r.id}:${status}` }));
    }
    case "invoice_sent": {
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), isNotNull(invoices.number), ne(invoices.status, "void"), gte(invoices.sentOn, sinceDate), gte(invoices.createdAt, new Date(since.getTime() - 30 * DAY))));
      return rows.map((r) => ({ customerId: r.customerId, subjectType: "invoice", subjectId: r.id, dedupeKey: `invoice:${r.id}` }));
    }
    case "invoice_past_due": {
      // Due before today, and became past due after the automation was turned on.
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), inArray(invoices.status, ["sent", "partial"]), lt(invoices.dueDate, local.date), gte(invoices.dueDate, addDays(localParts(a.enabledAt ?? now, co.tz).date, -1)),
          sql`${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents} > 0`));
      return rows.map((r) => ({ customerId: r.customerId, subjectType: "invoice", subjectId: r.id, dedupeKey: `invoice:${r.id}` }));
    }
    case "invoice_paid": {
      const rows = await db.select({ id: invoices.id, customerId: invoices.customerId }).from(invoices)
        .where(and(eq(invoices.companyId, co.id), eq(invoices.status, "paid"),
          sql`exists (select 1 from ${invoicePayments} p where p.invoice_id = ${invoices.id} and p.status = 'completed' and p.created_at >= ${since.toISOString()})`));
      return rows.map((r) => ({ customerId: r.customerId, subjectType: "invoice", subjectId: r.id, dedupeKey: `invoice:${r.id}` }));
    }
    case "payment_received": {
      const rows = await db.select({ id: invoicePayments.id, customerId: invoicePayments.customerId }).from(invoicePayments)
        .where(and(eq(invoicePayments.companyId, co.id), eq(invoicePayments.status, "completed"), ne(invoicePayments.method, "prepaid"), gte(invoicePayments.createdAt, since)));
      return rows.map((r) => ({ customerId: r.customerId, subjectType: "payment", subjectId: r.id, dedupeKey: `payment:${r.id}` }));
    }
    case "visit_added": case "visit_completed": case "visit_skipped": case "visit_upcoming": {
      const when = t === "visit_added" ? and(gte(visits.createdAt, since), eq(visits.status, "open"))
        : t === "visit_completed" ? gte(visits.completedAt, since)
        : t === "visit_skipped" ? gte(visits.skippedAt, since)
        // At 8 AM or later, the work orders a set number of days away.
        : local.minutes >= 8 * 60 ? and(eq(visits.status, "open"), eq(visits.date, addDays(local.date, a.daysBefore ?? 1))) : sql`false`;
      const rows = await db.select({ id: visits.id, customerId: visits.customerId }).from(visits).where(and(eq(visits.companyId, co.id), when));
      return rows.map((r) => ({ customerId: r.customerId, subjectType: "visit", subjectId: r.id, dedupeKey: `visit:${r.id}` }));
    }
    case "customer_added": {
      const rows = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, co.id), gte(customers.createdAt, since)));
      return rows.map((r) => ({ customerId: r.id, subjectType: "customer", subjectId: r.id, dedupeKey: `customer:${r.id}` }));
    }
    case "tag_added": case "tag_removed": {
      if (!a.tagId) return [];
      const rows = await db.select({ id: tagEvents.id, customerId: tagEvents.customerId }).from(tagEvents)
        .where(and(eq(tagEvents.companyId, co.id), eq(tagEvents.tagId, a.tagId), eq(tagEvents.action, t === "tag_added" ? "add" : "remove"), isNotNull(tagEvents.customerId), gte(tagEvents.createdAt, since)));
      return rows.map((r) => ({ customerId: r.customerId!, subjectType: "customer", subjectId: r.customerId, dedupeKey: `tag:${r.id}` }));
    }
  }
}

/** Starts a run for each new thing (once each), for customers it applies to. */
async function startRuns(a: Automation, co: Co, found: Found[], now: Date) {
  if (!found.length) return 0;
  const ids = [...new Set(found.map((f) => f.customerId))];
  const custs = new Map((await db.select({ id: customers.id, status: customers.status, sample: customers.sample, tagIds: customers.tagIds }).from(customers).where(inArray(customers.id, ids))).map((c) => [c.id, c]));
  let n = 0;
  for (const f of found) {
    const c = custs.get(f.customerId);
    if (!c || c.status === "cancelled" || (c.sample && !co.testOf)) continue;
    if (a.onlyTagIds.length && !a.onlyTagIds.some((t) => c.tagIds.includes(t))) continue;
    if (a.exceptTagIds.some((t) => c.tagIds.includes(t))) continue;
    const [r] = await db.insert(automationRuns).values({
      companyId: co.id, automationId: a.id, customerId: f.customerId, subjectType: f.subjectType, subjectId: f.subjectId, dedupeKey: f.dedupeKey,
      status: "running", stepIndex: 0, nextAt: new Date(now.getTime() + (a.steps[0]?.waitMinutes ?? 0) * 60_000),
    }).onConflictDoNothing().returning();
    if (r) n++;
  }
  return n;
}

/** Whether something it should stop on has happened; the reason if so. */
async function stopReason(a: Automation, run: Run): Promise<string | null> {
  const stops = a.stopWhen as StopCondition[];
  if (!stops.length) return null;
  if (stops.includes("customer_cancelled") && run.customerId) {
    const [c] = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, run.customerId));
    if (!c || c.status === "cancelled") return "The customer was cancelled";
  }
  if (stops.includes("estimate_answered") && run.subjectType === "estimate" && run.subjectId) {
    const [e] = await db.select({ status: estimates.status }).from(estimates).where(eq(estimates.id, run.subjectId));
    if (!e || ["accepted", "declined", "changes"].includes(e.status)) return `The estimate was ${e?.status === "changes" ? "answered (changes asked for)" : e?.status ?? "deleted"}`;
  }
  if (stops.includes("invoice_paid") && run.subjectType === "invoice" && run.subjectId) {
    const [i] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, run.subjectId));
    if (!i || i.status === "paid" || i.status === "void") return `The invoice was ${i?.status ?? "deleted"}`;
  }
  if (stops.includes("visit_closed") && run.subjectType === "visit" && run.subjectId) {
    const [v] = await db.select({ status: visits.status }).from(visits).where(eq(visits.id, run.subjectId));
    if (!v || v.status !== "open") return `The work order was ${v?.status ?? "deleted"}`;
  }
  if (stops.includes("tag_removed") && a.tagId && run.customerId) {
    const [c] = await db.select({ tagIds: customers.tagIds }).from(customers).where(eq(customers.id, run.customerId));
    if (!c?.tagIds.includes(a.tagId)) return "The tag came off";
  }
  return null;
}

const longDate = (ymd: string | null) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");

/** The fill-in values for a run: the customer's, plus its estimate, invoice, payment or work order. */
export async function runVars(companyId: string, customerId: string | null, subjectType: string, subjectId: string | null): Promise<Record<string, string>> {
  const company = await companyInfo(companyId);
  const v: Record<string, string> = { ...(customerId ? (await messageVars(companyId, [customerId], company)).get(customerId) ?? {} : {}), company: company.name, company_phone: company.phone ?? "", portal_link: portalUrl(companyId) };
  let invoiceId = subjectType === "invoice" ? subjectId : null;
  if (subjectType === "estimate" && subjectId) {
    const [e] = await db.select().from(estimates).where(eq(estimates.id, subjectId));
    if (e) Object.assign(v, { estimate_number: String(e.number), estimate_title: e.title ?? `Estimate ${e.number}`, estimate_total: formatMoney(e.totalCents), estimate_link: e.token ? `${WEB_URL}/estimate/${e.token}` : "" });
  }
  if (subjectType === "payment" && subjectId) {
    const [p] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, subjectId));
    if (p) { v.payment_amount = formatMoney(p.amountCents); invoiceId = p.invoiceId; }
  }
  if (invoiceId) {
    const [i] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (i) Object.assign(v, { invoice_number: i.number != null ? String(i.number) : "", invoice_total: formatMoney(i.totalCents), invoice_balance: formatMoney(invoiceBalance(i)), invoice_due: longDate(i.dueDate), pay_link: payLinkFor(i) ?? portalUrl(companyId) });
  }
  if (subjectType === "visit" && subjectId) {
    const [w] = await db.select().from(visits).where(eq(visits.id, subjectId));
    const [p] = w?.propertyId ? await db.select().from(properties).where(eq(properties.id, w.propertyId)) : [];
    if (w) Object.assign(v, { visit_title: w.title, visit_date: longDate(w.date), visit_address: p ? formatAddress(p) : "" });
  }
  return v;
}

/** Does one step; says what happened. */
export async function doStep(a: Automation, run: Run, step: AutomationStep): Promise<{ status: "done" | "skipped" | "failed"; detail: string }> {
  const [tpl] = step.templateId ? await db.select().from(messageTemplates).where(and(eq(messageTemplates.id, step.templateId), eq(messageTemplates.companyId, a.companyId))) : [];
  if (step.templateId && !tpl) return { status: "failed", detail: "Its template was deleted" };
  const vars = await runVars(a.companyId, run.customerId, run.subjectType, run.subjectId);
  const fill = (s: string | null | undefined) => fillTemplate(s ?? "", vars);
  const [cust] = run.customerId ? await db.select().from(customers).where(eq(customers.id, run.customerId)) : [];
  const [co] = await db.select({ name: companies.name, email: companies.email }).from(companies).where(eq(companies.id, a.companyId));
  switch (step.action) {
    case "email_customer": {
      if (!cust?.email) return { status: "skipped", detail: "No email address on file" };
      if (cust.emailOptOutAt) return { status: "skipped", detail: "They unsubscribed from emails" };
      const transport = emailTransport();
      if (!transport) return { status: "failed", detail: "Email isn't set up on this server" };
      const m = renderCustomerEmail({ company: await companyInfo(a.companyId), subject: fill(tpl.subject), body: fill(tpl.body), vars: vars as never, customerId: cust.id });
      try { await transport.send({ to: cust.email, subject: m.subject, text: m.text, html: m.html, headers: m.headers, fromName: co.name, replyTo: co.email ?? undefined }); }
      catch (e) { return { status: "failed", detail: `Email didn't go: ${(e as Error).message}` }; }
      return { status: "done", detail: `Emailed ${cust.email}: "${m.subject}"` };
    }
    case "text_customer": {
      if (!cust) return { status: "skipped", detail: "No customer" };
      const r = await sendCustomerText(a.companyId, cust.id, fill(tpl.body).slice(0, 1000), { by: null, source: "automation" });
      if (!r.text) return { status: "skipped", detail: r.skipped ?? "Not sent" };
      return r.text.status === "failed" ? { status: "failed", detail: `Text didn't go: ${r.text.error ?? ""}` } : { status: "done", detail: `Texted ${r.text.phone}` };
    }
    case "email_staff": {
      const people = await db.select({ email: employees.email }).from(employees).where(and(eq(employees.companyId, a.companyId), inArray(employees.id, step.employeeIds)));
      const transport = emailTransport();
      if (!transport) return { status: "failed", detail: "Email isn't set up on this server" };
      const to = people.map((p) => p.email).filter((x): x is string => !!x);
      const subject = fill(tpl.subject ?? tpl.name), body = fill(tpl.body);
      const link = cust ? `\n\n${WEB_URL}/customers/${cust.id}` : "";
      for (const addr of to) await transport.send({ to: addr, subject, text: body + link, html: `<p>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>${cust ? `<p><a href="${WEB_URL}/customers/${cust.id}">Open ${customerName(cust).replace(/</g, "&lt;")}</a></p>` : ""}` });
      return to.length ? { status: "done", detail: `Emailed ${to.length} ${to.length === 1 ? "person" : "people"}` } : { status: "skipped", detail: "No one with an email address" };
    }
    case "notify_staff": {
      notify(a.companyId, step.employeeIds, { category: "customers", title: fill(tpl.subject ?? tpl.name).slice(0, 200), body: fill(tpl.body).slice(0, 400), link: cust ? { screen: "customer", id: cust.id } : { screen: "automations" } });
      return { status: "done", detail: `Notified ${step.employeeIds.length} ${step.employeeIds.length === 1 ? "person" : "people"}` };
    }
    case "add_tag": case "remove_tag": {
      if (!cust || !step.tagId) return { status: "skipped", detail: "No customer" };
      const has = cust.tagIds.includes(step.tagId);
      if ((step.action === "add_tag") === has) return { status: "skipped", detail: step.action === "add_tag" ? "They already have the tag" : "They don't have the tag" };
      const after = step.action === "add_tag" ? [...cust.tagIds, step.tagId] : cust.tagIds.filter((t) => t !== step.tagId);
      await db.transaction(async (tx) => {
        await tx.update(customers).set({ tagIds: after, updatedAt: new Date() }).where(eq(customers.id, cust.id));
        await recordTagChanges(tx, { companyId: a.companyId, before: cust.tagIds, after, customerId: cust.id, source: "automation", byId: null });
      });
      return { status: "done", detail: step.action === "add_tag" ? "Tag added" : "Tag taken off" };
    }
    case "create_todo": {
      const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, a.companyId));
      const date = addDays(localParts(new Date(), c.tz).date, 1);
      const [t] = await db.insert(todos).values({ companyId: a.companyId, title: fill(step.todoTitle).slice(0, 200) || a.name, notes: `From the automation "${a.name}".`, customerId: cust?.id ?? null, date, startTime: "08:00" }).returning();
      if (step.employeeIds.length) await db.insert(todoAssignees).values(step.employeeIds.map((employeeId) => ({ todoId: t.id, employeeId }))).onConflictDoNothing();
      notify(a.companyId, step.employeeIds, { category: "todos", title: `New to-do: ${t.title}`, body: cust ? `For ${customerName(cust)}, due tomorrow at 8 AM.` : "Due tomorrow at 8 AM.", link: { screen: "todos", id: t.id } });
      return { status: "done", detail: `To-do "${t.title}" for ${date}` };
    }
  }
}

/** Moves a run on after its step (to the next step's time, or done). */
async function advance(a: Automation, run: Run, entry: { status: string; detail: string }, now: Date) {
  const log = [...run.log, { step: run.stepIndex, action: a.steps[run.stepIndex]?.action ?? "?", ...entry, at: now.toISOString() }];
  const next = run.stepIndex + 1;
  const more = next < a.steps.length;
  await db.update(automationRuns).set({
    log, stepIndex: next, status: more ? "running" : "done", nextAt: more ? new Date(now.getTime() + a.steps[next].waitMinutes * 60_000) : null, finishedAt: more ? null : now,
  }).where(eq(automationRuns.id, run.id));
}

/** 9 AM to 6 PM in the company's time zone: when, if not now, a text can go. */
function textTime(now: Date, tz: string): Date | null {
  const l = localParts(now, tz);
  if (l.minutes >= TEXT_HOURS.start * 60 && l.minutes < TEXT_HOURS.end * 60) return null;
  const day = l.minutes < TEXT_HOURS.start * 60 ? l.date : addDays(l.date, 1);
  return zonedTime(day, `${String(TEXT_HOURS.start).padStart(2, "0")}:00`, tz);
}

/** Does a run's due step (or stops it, holds it for review, or waits for daytime for a text). */
async function processRun(run: Run, a: Automation, tz: string, now: Date) {
  if (!a.enabled) {
    await db.update(automationRuns).set({ status: "stopped", stoppedReason: "The automation was turned off", nextAt: null, finishedAt: now }).where(eq(automationRuns.id, run.id));
    return;
  }
  const reason = await stopReason(a, run);
  if (reason) {
    await db.update(automationRuns).set({ status: "stopped", stoppedReason: reason, nextAt: null, finishedAt: now }).where(eq(automationRuns.id, run.id));
    return;
  }
  const step = a.steps[run.stepIndex];
  if (!step) { await db.update(automationRuns).set({ status: "done", nextAt: null, finishedAt: now }).where(eq(automationRuns.id, run.id)); return; }
  if (step.action === "text_customer") {
    const later = textTime(now, tz);
    if (later) { await db.update(automationRuns).set({ nextAt: later }).where(eq(automationRuns.id, run.id)); return; }
  }
  if (a.review && CUSTOMER_FACING.includes(step.action)) {
    await db.update(automationRuns).set({ status: "review", nextAt: null }).where(eq(automationRuns.id, run.id));
    return;
  }
  let entry: { status: string; detail: string };
  try { entry = await doStep(a, run, step); } catch (e) { entry = { status: "failed", detail: (e as Error).message.slice(0, 300) }; }
  await advance(a, run, entry, now);
}

/** Approve (do it now) or skip a step that's waiting for review. */
export async function reviewStep(companyId: string, runId: string, decision: "send" | "skip" | "stop") {
  const [run] = await db.select().from(automationRuns).where(and(eq(automationRuns.id, runId), eq(automationRuns.companyId, companyId)));
  if (!run || run.status !== "review") return null;
  const [a] = await db.select().from(automations).where(eq(automations.id, run.automationId));
  const now = new Date();
  if (decision === "stop") {
    await db.update(automationRuns).set({ status: "stopped", stoppedReason: "Stopped by the office", finishedAt: now }).where(eq(automationRuns.id, run.id));
  } else {
    const reason = await stopReason(a, run);
    if (reason) await db.update(automationRuns).set({ status: "stopped", stoppedReason: reason, finishedAt: now }).where(eq(automationRuns.id, run.id));
    else await advance(a, run, decision === "skip" ? { status: "skipped", detail: "Skipped in review" } : await doStep(a, run, a.steps[run.stepIndex]), now);
  }
  return (await db.select().from(automationRuns).where(eq(automationRuns.id, run.id)))[0];
}

/** Starts runs for what's happened and does the steps that are due. */
export async function runAutomations(now = new Date()) {
  const list = await db.select({ a: automations, tz: companies.timezone, testOf: companies.testOfCompanyId }).from(automations)
    .innerJoin(companies, eq(companies.id, automations.companyId)).where(eq(automations.enabled, true));
  let started = 0;
  for (const { a, tz, testOf } of list) {
    try { started += await startRuns(a, { id: a.companyId, tz, testOf }, await detect(a, { id: a.companyId, tz, testOf }, now), now); }
    catch (e) { console.error(`Automation ${a.id} failed to check:`, (e as Error).message); }
  }
  const due = await db.select({ run: automationRuns, a: automations, tz: companies.timezone }).from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId)).innerJoin(companies, eq(companies.id, automationRuns.companyId))
    .where(and(eq(automationRuns.status, "running"), lte(automationRuns.nextAt, now))).orderBy(asc(automationRuns.nextAt)).limit(500);
  let steps = 0;
  for (const { run, a, tz } of due) {
    // Claim it, so two checks running at once don't both do it.
    const [claimed] = await db.update(automationRuns).set({ nextAt: new Date(now.getTime() + 10 * 60_000) })
      .where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, "running"), eq(automationRuns.stepIndex, run.stepIndex), lte(automationRuns.nextAt, now))).returning();
    if (!claimed) continue;
    await processRun(run, a, tz, now);
    steps++;
  }
  return { started, steps };
}

/** Customers' automations that are waiting in review, for the badge. */
export async function reviewCount(companyId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(automationRuns).where(and(eq(automationRuns.companyId, companyId), eq(automationRuns.status, "review")));
  return n;
}

export const _test = { textTime };

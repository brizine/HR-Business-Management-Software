import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, customerName, describeWait, fillTemplate, automationSchema, messageTemplateSchema,
  type AutomationInput, type AutomationStep, type AutomationTrigger,
} from "@crewdesk/shared";
import { db } from "../db";
import { automationRuns, automations, crmTags, customers, employees, messageTemplates } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { reviewCount, reviewStep, runVars } from "../lib/automations";

const AREA = "customers" as const;
const EMAIL_ACTIONS = ["email_customer", "email_staff"];

/** Checks the templates, people and tags an automation uses are this company's (and the right kind). */
async function checkRefs(companyId: string, a: AutomationInput) {
  const tplIds = [...new Set(a.steps.map((s) => s.templateId).filter((x): x is string => !!x))];
  const tpls = new Map((tplIds.length ? await db.select().from(messageTemplates).where(and(eq(messageTemplates.companyId, companyId), inArray(messageTemplates.id, tplIds))) : []).map((t) => [t.id, t]));
  for (const [i, s] of a.steps.entries()) {
    if (!s.templateId) continue;
    const t = tpls.get(s.templateId);
    if (!t) throw new HttpError(400, `Step ${i + 1}: that template doesn't exist`);
    if (EMAIL_ACTIONS.includes(s.action) && t.kind !== "email") throw new HttpError(400, `Step ${i + 1}: choose an email template`);
    if (s.action === "text_customer" && t.kind !== "text") throw new HttpError(400, `Step ${i + 1}: choose a text template`);
  }
  const people = [...new Set(a.steps.flatMap((s) => s.employeeIds))];
  if (people.length) {
    const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, people)));
    if (found.length !== people.length) throw new HttpError(400, "One of those people isn't in your company");
  }
  const tags = [...new Set([a.tagId, ...a.onlyTagIds, ...a.exceptTagIds, ...a.steps.map((s) => s.tagId)].filter((x): x is string => !!x))];
  if (tags.length) {
    const found = await db.select({ id: crmTags.id }).from(crmTags).where(and(eq(crmTags.companyId, companyId), inArray(crmTags.id, tags)));
    if (found.length !== tags.length) throw new HttpError(400, "One of those tags doesn't exist");
  }
}

const values = (a: AutomationInput) => ({
  name: a.name, description: a.description ?? null, enabled: a.enabled, trigger: a.trigger,
  daysBefore: a.trigger === "visit_upcoming" ? a.daysBefore ?? 1 : null, tagId: a.trigger === "tag_added" || a.trigger === "tag_removed" ? a.tagId ?? null : null,
  onlyTagIds: a.onlyTagIds, exceptTagIds: a.exceptTagIds, stopWhen: a.stopWhen, review: a.review,
  steps: a.steps.map((s) => ({ ...s, templateId: s.templateId ?? null, tagId: s.tagId ?? null, todoTitle: s.todoTitle ?? null })),
});

/** Automations (like Homeworks'): the list, templates, runs (history and review), and a starter set. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  app.get("/", async (req) => {
    const { companyId } = req.user;
    const list = await db.select().from(automations).where(eq(automations.companyId, companyId)).orderBy(automations.name);
    const counts = await db.select({ id: automationRuns.automationId, status: automationRuns.status, n: sql<number>`count(*)::int` }).from(automationRuns)
      .where(and(eq(automationRuns.companyId, companyId), sql`(${automationRuns.status} in ('running','review') or ${automationRuns.createdAt} > now() - interval '30 days')`))
      .groupBy(automationRuns.automationId, automationRuns.status);
    const of = (id: string, status: string) => counts.find((c) => c.id === id && c.status === status)?.n ?? 0;
    return {
      review: await reviewCount(companyId),
      automations: list.map((a) => ({ ...a, counts: { running: of(a.id, "running"), review: of(a.id, "review"), done: of(a.id, "done"), stopped: of(a.id, "stopped") } })),
    };
  });

  app.post("/", admin, async (req) => {
    const a = parse(automationSchema, req.body);
    await checkRefs(req.user.companyId, a);
    const [row] = await db.insert(automations).values({ ...values(a), companyId: req.user.companyId, createdById: req.user.sub, enabledAt: a.enabled ? new Date() : null }).returning();
    return row;
  });

  const find = async (companyId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Automation not found");
    const [a] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.companyId, companyId)));
    if (!a) throw new HttpError(404, "Automation not found");
    return a;
  };

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const a = parse(automationSchema, req.body);
    const old = await find(req.user.companyId, req.params.id);
    await checkRefs(req.user.companyId, a);
    // Turning it on starts from now: only what happens after this starts it.
    const [row] = await db.update(automations).set({ ...values(a), enabledAt: a.enabled ? (old.enabled ? old.enabledAt : new Date()) : old.enabledAt, updatedAt: new Date() })
      .where(eq(automations.id, old.id)).returning();
    return row;
  });

  app.post<{ Params: { id: string } }>("/:id/enabled", admin, async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const old = await find(req.user.companyId, req.params.id);
    const [row] = await db.update(automations).set({ enabled, enabledAt: enabled && !old.enabled ? new Date() : old.enabledAt, updatedAt: new Date() }).where(eq(automations.id, old.id)).returning();
    if (!enabled) {
      // Runs waiting in review stop too.
      await db.update(automationRuns).set({ status: "stopped", stoppedReason: "The automation was turned off", nextAt: null, finishedAt: new Date() })
        .where(and(eq(automationRuns.automationId, old.id), inArray(automationRuns.status, ["running", "review"])));
    }
    return row;
  });

  app.delete<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const a = await find(req.user.companyId, req.params.id);
    await db.delete(automations).where(eq(automations.id, a.id));
    return { ok: true };
  });

  /* ── Templates ── */

  app.get("/templates", async (req) => db.select().from(messageTemplates).where(eq(messageTemplates.companyId, req.user.companyId)).orderBy(messageTemplates.kind, messageTemplates.name));

  app.post("/templates", admin, async (req) => {
    const t = parse(messageTemplateSchema, req.body);
    const [row] = await db.insert(messageTemplates).values({ companyId: req.user.companyId, kind: t.kind, name: t.name, subject: t.kind === "email" ? t.subject ?? null : null, body: t.body }).returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/templates/:id", admin, async (req) => {
    const t = parse(messageTemplateSchema, req.body);
    const [old] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.id, req.params.id), eq(messageTemplates.companyId, req.user.companyId)));
    if (!old) throw new HttpError(404, "Template not found");
    if (old.kind !== t.kind) throw new HttpError(400, "A template can't change between email and text; make a new one");
    const [row] = await db.update(messageTemplates).set({ name: t.name, subject: t.kind === "email" ? t.subject ?? null : null, body: t.body, updatedAt: new Date() }).where(eq(messageTemplates.id, old.id)).returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", admin, async (req) => {
    const { companyId } = req.user;
    const used = (await db.select({ name: automations.name, steps: automations.steps }).from(automations).where(eq(automations.companyId, companyId)))
      .filter((a) => a.steps.some((s) => s.templateId === req.params.id));
    if (used.length) throw new HttpError(400, `It's used by ${used.map((u) => `"${u.name}"`).join(", ")}. Change those steps first`);
    await db.delete(messageTemplates).where(and(eq(messageTemplates.id, req.params.id), eq(messageTemplates.companyId, companyId)));
    return { ok: true };
  });

  /** The template filled in for a customer (or with sample values), for the preview. */
  app.post("/templates/preview", async (req) => {
    const b = parse(z.object({ subject: z.string().max(400).optional(), body: z.string().max(10000), customerId: z.string().uuid().optional() }), req.body);
    const vars = b.customerId ? await runVars(req.user.companyId, b.customerId, "customer", b.customerId) : null;
    return { subject: b.subject ? fillTemplate(b.subject, vars ?? {}) : null, body: fillTemplate(b.body, vars ?? {}) };
  });

  /* ── Runs ── */

  app.get<{ Querystring: { status?: string; customerId?: string; automationId?: string; limit?: string } }>("/runs", async (req) => {
    const { companyId } = req.user;
    const q = req.query;
    const where = and(eq(automationRuns.companyId, companyId),
      q.status ? inArray(automationRuns.status, q.status.split(",")) : undefined,
      q.customerId ? eq(automationRuns.customerId, q.customerId) : undefined,
      q.automationId ? eq(automationRuns.automationId, q.automationId) : undefined);
    const rows = await db.select({ r: automationRuns, a: automations, c: customers }).from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId)).leftJoin(customers, eq(customers.id, automationRuns.customerId))
      .where(where).orderBy(desc(automationRuns.createdAt)).limit(Math.min(Number(q.limit) || 100, 300));
    const tplIds = [...new Set(rows.flatMap(({ r, a }) => (r.status === "review" ? [a.steps[r.stepIndex]?.templateId] : [])).filter((x): x is string => !!x))];
    const tpls = new Map((tplIds.length ? await db.select().from(messageTemplates).where(inArray(messageTemplates.id, tplIds)) : []).map((t) => [t.id, t]));
    const out = [];
    for (const { r, a, c } of rows) {
      const step: AutomationStep | undefined = a.steps[r.stepIndex];
      let preview: { subject: string | null; body: string } | null = null;
      if (r.status === "review" && step?.templateId && tpls.get(step.templateId)) {
        const t = tpls.get(step.templateId)!;
        const vars = await runVars(companyId, r.customerId, r.subjectType, r.subjectId);
        preview = { subject: t.subject ? fillTemplate(t.subject, vars) : null, body: fillTemplate(t.body, vars) };
      }
      out.push({
        id: r.id, status: r.status, stepIndex: r.stepIndex, steps: a.steps.length, nextAt: r.nextAt, createdAt: r.createdAt, finishedAt: r.finishedAt, stoppedReason: r.stoppedReason, log: r.log,
        subjectType: r.subjectType, subjectId: r.subjectId,
        automation: { id: a.id, name: a.name, trigger: AUTOMATION_TRIGGERS[a.trigger as AutomationTrigger]?.label ?? a.trigger },
        customer: c ? { id: c.id, name: customerName(c) } : null,
        next: step && (r.status === "running" || r.status === "review") ? { action: AUTOMATION_ACTIONS[step.action], wait: describeWait(step.waitMinutes) } : null,
        preview,
      });
    }
    return out;
  });

  app.post<{ Params: { id: string } }>("/runs/:id/review", async (req) => {
    const { decision } = parse(z.object({ decision: z.enum(["send", "skip", "stop"]) }), req.body);
    const r = await reviewStep(req.user.companyId, req.params.id, decision);
    if (!r) throw new HttpError(400, "It isn't waiting for review any more");
    return r;
  });

  app.post<{ Params: { id: string } }>("/runs/:id/stop", async (req) => {
    const [r] = await db.update(automationRuns).set({ status: "stopped", stoppedReason: "Stopped by the office", nextAt: null, finishedAt: new Date() })
      .where(and(eq(automationRuns.id, req.params.id), eq(automationRuns.companyId, req.user.companyId), inArray(automationRuns.status, ["running", "review"]))).returning();
    if (!r) throw new HttpError(400, "It isn't running");
    return r;
  });

  /** Adds ready-made templates and automations (all off), like Homeworks' defaults. Skips any already there by name. */
  app.post("/starter", admin, async (req) => {
    const { companyId, sub } = req.user;
    const have = new Set((await db.select({ name: messageTemplates.name }).from(messageTemplates).where(eq(messageTemplates.companyId, companyId))).map((t) => t.name));
    const ids: Record<string, string> = {};
    for (const t of STARTER_TEMPLATES) {
      if (have.has(t.name)) { ids[t.key] = (await db.select({ id: messageTemplates.id }).from(messageTemplates).where(and(eq(messageTemplates.companyId, companyId), eq(messageTemplates.name, t.name))))[0].id; continue; }
      const [row] = await db.insert(messageTemplates).values({ companyId, kind: t.kind, name: t.name, subject: t.subject ?? null, body: t.body }).returning();
      ids[t.key] = row.id;
    }
    const haveA = new Set((await db.select({ name: automations.name }).from(automations).where(eq(automations.companyId, companyId))).map((a) => a.name));
    let added = 0;
    for (const a of starterAutomations(ids, sub)) {
      if (haveA.has(a.name)) continue;
      await db.insert(automations).values({ ...values(a), companyId, createdById: sub, enabled: false });
      added++;
    }
    return { added };
  });
};

const STOP_TEXT = "\nReply STOP to opt out.";
const STARTER_TEMPLATES: { key: string; kind: "email" | "text"; name: string; subject?: string; body: string }[] = [
  { key: "estFollowEmail", kind: "email", name: "Estimate follow-up (customer)", subject: "Your estimate from {company}",
    body: "Hi {first_name},\n\nJust checking in on your estimate for {estimate_title} ({estimate_total}). You can see it and accept it here:\n{estimate_link}\n\nAny questions? Just reply to this email.\n\nThank you,\n{company}" },
  { key: "estFollowText", kind: "text", name: "Estimate follow-up (text)", body: `Hi {first_name}, it's {company}. Any questions about your estimate? You can accept it here: {estimate_link}${STOP_TEXT}` },
  { key: "estLastEmail", kind: "email", name: "Estimate follow-up: last check-in (customer)", subject: "Still interested? Your estimate from {company}",
    body: "Hi {first_name},\n\nWe don't want you to lose your spot on our schedule. Your estimate for {estimate_title} is here whenever you're ready:\n{estimate_link}\n\nIf the timing or price isn't right, reply and let us know. We're happy to adjust it.\n\n{company}" },
  { key: "invPastDueEmail", kind: "email", name: "Invoice past due (customer)", subject: "Invoice {invoice_number} is past due",
    body: "Hi {first_name},\n\nA friendly reminder that invoice {invoice_number} for {invoice_total} was due {invoice_due}. The balance is {invoice_balance}.\n\nPay online (card or bank account): {pay_link}\n\nAlready paid? Thank you, and please ignore this.\n\n{company}" },
  { key: "invPastDueText", kind: "text", name: "Invoice past due (text)", body: `Hi {first_name}, {company} here. Invoice {invoice_number} ({invoice_balance}) is past due. Pay online: {pay_link}${STOP_TEXT}` },
  { key: "visitReminderText", kind: "text", name: "Reminder: your job is on the schedule (text)", body: `Hi {first_name}, {company} is scheduled at {visit_address} on {visit_date}. Please leave gates unlocked and pets inside.${STOP_TEXT}` },
  { key: "visitDoneEmail", kind: "email", name: "Your property has been serviced (customer)", subject: "We serviced your property today",
    body: "Hi {first_name},\n\nWe completed {visit_title} at {visit_address} today. Please keep kids and pets off the lawn until it's dry.\n\nQuestions? Just reply to this email.\n\nThank you,\n{company}" },
  { key: "cardOnFileEmail", kind: "email", name: "Add a card on file (new customer)", subject: "Welcome to {company}",
    body: "Hi {first_name},\n\nWelcome, and thank you for choosing {company}! To make paying easy, you can save a card or bank account in your account:\n{portal_link}\n\nYou'll get an email code to sign in; there's no password.\n\n{company}" },
];

function starterAutomations(t: Record<string, string>, me: string): AutomationInput[] {
  const base: Pick<AutomationInput, "enabled" | "onlyTagIds" | "exceptTagIds" | "review" | "description" | "daysBefore" | "tagId"> = { enabled: false, onlyTagIds: [], exceptTagIds: [], review: false, description: null, daysBefore: null, tagId: null };
  const step = (waitMinutes: number, action: AutomationStep["action"], extra: Partial<AutomationStep> = {}): AutomationStep => ({ waitMinutes, action, employeeIds: [], templateId: null, tagId: null, todoTitle: null, ...extra });
  return [
    { ...base, name: "7 days to close: estimate follow-up", description: "Follows up on a sent estimate until it's answered, then hands it to the office.", trigger: "estimate_sent", stopWhen: ["estimate_answered", "customer_cancelled"],
      steps: [step(2 * 1440, "email_customer", { templateId: t.estFollowEmail }), step(2 * 1440, "text_customer", { templateId: t.estFollowText }), step(3 * 1440, "email_customer", { templateId: t.estLastEmail }), step(0, "create_todo", { todoTitle: "Call about estimate {estimate_number}", employeeIds: [me] })] },
    { ...base, name: "Overdue invoice follow-up", description: "Reminds the customer about a past-due invoice until it's paid.", trigger: "invoice_past_due", stopWhen: ["invoice_paid", "customer_cancelled"],
      steps: [step(0, "email_customer", { templateId: t.invPastDueEmail }), step(7 * 1440, "text_customer", { templateId: t.invPastDueText }), step(7 * 1440, "create_todo", { todoTitle: "Call about overdue invoice {invoice_number}", employeeIds: [me] })] },
    { ...base, name: "Reminder: your job is on the schedule", description: "Texts the customer the day before a work order.", trigger: "visit_upcoming", daysBefore: 1, stopWhen: ["visit_closed", "customer_cancelled"],
      steps: [step(0, "text_customer", { templateId: t.visitReminderText })] },
    { ...base, name: "Your property has been serviced", description: "Emails the customer when a work order is completed.", trigger: "visit_completed", stopWhen: [],
      steps: [step(0, "email_customer", { templateId: t.visitDoneEmail })] },
    { ...base, name: "New customer: card on file request", description: "Welcomes a new customer and asks them to save a card or bank account.", trigger: "customer_added", stopWhen: ["customer_cancelled"],
      steps: [step(15, "email_customer", { templateId: t.cardOnFileEmail })] },
  ];
}

export default routes;

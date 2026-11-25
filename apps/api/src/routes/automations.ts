import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ACTION_KEYS, AUTOMATION_ACTIONS, actionLabel, allActions, allConds, automationImportSchema, automationProblems, automationSchema, cannotTurnOn, customerName, deadBlocks,
  homeworksDelay, triggerDef, triggerKeyFor,
  type ActionDef, type ActionKey, type AutomationAction, type AutomationCond, type AutomationDef, type AutomationImport, type AutomationInput, type SubAction,
} from "@crewdesk/shared";
import { db } from "../db";
import { automationRuns, automationSteps, automations, crmTags, customers, employees, serviceTypes, templates, todoCategories } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { previewStep, reviewCount, reviewStep, stopRun } from "../lib/automations";
import { HttpError, parse } from "../lib/errors";
import { importTemplates } from "../lib/templates";

const AREA = "customers" as const;
type Row = typeof automations.$inferSelect;
const actionOf = (k: ActionKey) => AUTOMATION_ACTIONS[k] as ActionDef;

/** The stored parts (everything but the columns). */
const defOf = (a: AutomationInput): AutomationDef => {
  const { name: _n, description: _d, labels: _l, enabled: _e, review: _r, ...rest } = a;
  const def = rest as AutomationDef & { password?: unknown };
  delete def.password;
  return def;
};

/** Checks the templates, people, tags, categories, services and next automation it uses are this company's (and the right kind). */
async function checkRefs(companyId: string, def: AutomationDef, selfId?: string) {
  const acts = allActions(def);
  const tplIds = [...new Set(acts.map((s) => s.templateId).filter((x): x is string => !!x))];
  const tpls = new Map((tplIds.length ? await db.select({ id: templates.id, channel: templates.channel, name: templates.name }).from(templates).where(and(eq(templates.companyId, companyId), inArray(templates.id, tplIds))) : []).map((t) => [t.id, t]));
  for (const act of acts) {
    if (!act.templateId) continue;
    const t = tpls.get(act.templateId);
    const want = actionOf(act.action);
    if (!t) throw new HttpError(400, `${want.label}: that template doesn't exist`);
    if (want.channel && t.channel !== want.channel) throw new HttpError(400, `${want.label}: choose ${want.channel === "email" ? "an email" : "a text"} template ("${t.name}" is ${t.channel === "email" ? "an email" : "a text"})`);
  }
  const same = async (ids: string[], q: (ids: string[]) => Promise<{ id: string }[]>, what: string) => {
    const u = [...new Set(ids)];
    if (u.length && (await q(u)).length !== u.length) throw new HttpError(400, `One of those ${what} isn't in your company`);
  };
  const conds = allConds(def).map((c) => c.cond);
  await same(acts.flatMap((s) => s.employeeIds), (ids) => db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, ids))), "people");
  await same([...conds.flatMap((c) => c.tagIds), ...acts.map((s) => s.tagId).filter((x): x is string => !!x)], (ids) => db.select({ id: crmTags.id }).from(crmTags).where(and(eq(crmTags.companyId, companyId), inArray(crmTags.id, ids))), "tags");
  await same(conds.flatMap((c) => c.categoryIds), (ids) => db.select({ id: todoCategories.id }).from(todoCategories).where(and(eq(todoCategories.companyId, companyId), inArray(todoCategories.id, ids))), "to-do categories");
  await same(conds.flatMap((c) => c.serviceIds), (ids) => db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, ids))), "services");
  if (def.kind === "simple" && def.subAction === "run_automation" && def.subAutomationId) {
    const [next] = await db.select({ id: automations.id, kind: automations.kind }).from(automations).where(and(eq(automations.id, def.subAutomationId), eq(automations.companyId, companyId)));
    if (!next) throw new HttpError(400, "The automation to run next doesn't exist");
    if (next.kind !== "simple") throw new HttpError(400, "Only an automation (not a sequence) can run next");
    if (next.id === selfId) throw new HttpError(400, "An automation can't run itself next");
  }
}

/** The input cleaned: what each trigger and action doesn't use is cleared; a sequence's actions go in time order. */
function cleaned(a: AutomationInput): AutomationInput {
  const cond = (c: AutomationCond): AutomationCond => {
    const p = triggerDef(c.key)?.param;
    return { key: c.key, tagIds: p === "tags" ? c.tagIds : [], categoryIds: p === "categories" ? c.categoryIds : [], serviceIds: p === "services" ? c.serviceIds : [] };
  };
  const act = (x: AutomationAction, keepWait: boolean): AutomationAction => {
    const d = actionOf(x.action);
    return {
      waitMinutes: keepWait ? x.waitMinutes : 0, action: x.action, templateId: d.channel ? x.templateId : null,
      employeeIds: d.to === "employee" ? x.employeeIds : [], tagId: d.needs === "tag" ? x.tagId : null, todoTitle: d.needs === "todo" ? x.todoTitle : null,
    };
  };
  const byWait = (list: AutomationAction[]) => list.map((x, i) => ({ x, i })).sort((p, q) => p.x.waitMinutes - q.x.waitMinutes || p.i - q.i).map((p) => act(p.x, true));
  if (a.kind === "simple") {
    const d = triggerDef(a.trigger.key);
    return {
      ...a, trigger: cond(a.trigger), action: act(a.action, false),
      runAt: d?.param === "datetime" ? a.runAt : null, daysBefore: d?.param === "datetime" ? null : a.daysBefore, delayMinutes: d?.param === "datetime" || a.daysBefore != null ? 0 : a.delayMinutes,
      subAutomationId: a.subAction === "run_automation" ? a.subAutomationId : null, subDelayMinutes: a.subAction === "run_automation" ? a.subDelayMinutes : 0,
    };
  }
  return {
    ...a,
    blocks: a.blocks.map((b) => ({ trigger: cond(b.trigger), when: b.when.map((g) => g.map(cond)).filter((g) => g.length), actions: byWait(b.actions) })),
    stops: a.stops.map(cond), stopActions: byWait(a.stopActions),
  };
}

async function checked(companyId: string, body: unknown, selfId?: string) {
  const a = cleaned(parse(automationSchema, body));
  const problems = automationProblems(a);
  if (problems.length) throw new HttpError(400, problems.slice(0, 3).join(". "));
  await checkRefs(companyId, defOf(a), selfId);
  return a;
}

type Counts = { running: number; review: number; done: number; skipped: number; lastAt: Date | null };
const view = (a: Row, counts?: Counts) => ({
  id: a.id, number: a.number, kind: a.kind, name: a.name, description: a.description, labels: a.labels, enabled: a.enabled, enabledAt: a.enabledAt, review: a.review, def: a.def,
  imported: a.importedFrom?.split(":")[0] ?? null, wasOn: a.importedOn, locked: !!a.passwordHash, createdAt: a.createdAt, updatedAt: a.updatedAt,
  problems: automationProblems(a.def), cannotTurnOn: cannotTurnOn(a.def), deadBlocks: deadBlocks(a.def),
  counts: counts ?? { running: 0, review: 0, done: 0, skipped: 0, lastAt: null },
});

/** Why it can't be turned on right now (something's not picked, or Crewdesk can't run its trigger), or null. */
const notReady = (a: Row) => cannotTurnOn(a.def) ?? automationProblems(a.def)[0] ?? null;

/** Turns an automation off: its runs stop (what's waiting, or in Review, won't happen). */
async function stopAll(a: Row, why: string) {
  const now = new Date();
  await db.update(automationSteps).set({ status: "stopped", detail: why, dueAt: null, doneAt: now }).where(and(eq(automationSteps.automationId, a.id), inArray(automationSteps.status, ["waiting", "review"])));
  await db.update(automationRuns).set({ status: "stopped", reason: why, finishedAt: now }).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.status, "running")));
}

const LIST_ORDER = [sql`lower(array_to_string(${automations.labels}, ','))`, sql`lower(${automations.name})`, asc(automations.number)];

async function nextNumber(companyId: string) {
  const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${automations.number}), 0)::int` }).from(automations).where(eq(automations.companyId, companyId));
  return n + 1;
}

/** Marketing → Automations: automations and sequences, Review, history, the customer tab, and the Homeworks import. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  const find = async (companyId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Automation not found");
    const [a] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.companyId, companyId)));
    if (!a) throw new HttpError(404, "Automation not found");
    return a;
  };
  /** A password-protected sequence can only be changed with its password (the owner always can). */
  const unlock = async (a: Row, req: { user: { role: string }; headers: Record<string, unknown> }, password?: string | null) => {
    if (!a.passwordHash || req.user.role === "owner") return;
    const given = password ?? (typeof req.headers["x-sequence-password"] === "string" ? (req.headers["x-sequence-password"] as string) : "");
    if (!given || !(await bcrypt.compare(given, a.passwordHash))) throw new HttpError(403, given ? "That isn't the sequence's password" : "This sequence is protected with a password");
  };

  app.get("/", async (req) => {
    const { companyId } = req.user;
    // Homeworks lists them by their Tags box (none first), then by name.
    const list = await db.select().from(automations).where(eq(automations.companyId, companyId)).orderBy(...LIST_ORDER);
    const runs = await db.select({ id: automationRuns.automationId, status: automationRuns.status, n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${automationRuns.createdAt})` }).from(automationRuns)
      .where(and(eq(automationRuns.companyId, companyId), sql`(${automationRuns.status} = 'running' or ${automationRuns.createdAt} > now() - interval '30 days')`))
      .groupBy(automationRuns.automationId, automationRuns.status);
    const inReview = await db.select({ id: automationSteps.automationId, n: sql<number>`count(*)::int` }).from(automationSteps)
      .where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review"))).groupBy(automationSteps.automationId);
    const of = (id: string, status: string) => runs.find((c) => c.id === id && c.status === status)?.n ?? 0;
    return {
      review: await reviewCount(companyId),
      // Imported from Homeworks, on there, off here, and able to run: what "turn on what was on in Homeworks" would turn on.
      wasOnAndReady: list.filter((a) => a.importedOn && !a.enabled && !notReady(a)).length,
      automations: list.map((a) => {
        const mine = runs.filter((r) => r.id === a.id && r.last);
        const lastAt = mine.length ? new Date(Math.max(...mine.map((r) => new Date(r.last!).getTime()))) : null;
        return view(a, { running: of(a.id, "running"), review: inReview.find((r) => r.id === a.id)?.n ?? 0, done: of(a.id, "done"), skipped: of(a.id, "skipped"), lastAt });
      }),
    };
  });

  /** What the editor picks from: templates, tags, to-do categories, services, people and automations. */
  app.get("/options", async (req) => {
    const { companyId } = req.user;
    const [tpls, tags, cats, services, people, autos] = await Promise.all([
      db.select({ id: templates.id, name: templates.name, channel: templates.channel, audience: templates.audience }).from(templates).where(eq(templates.companyId, companyId)).orderBy(sql`lower(${templates.name})`),
      db.select({ id: crmTags.id, name: crmTags.name, color: crmTags.color }).from(crmTags).where(and(eq(crmTags.companyId, companyId), eq(crmTags.archived, false))).orderBy(asc(crmTags.name)),
      db.select({ id: todoCategories.id, name: todoCategories.name }).from(todoCategories).where(eq(todoCategories.companyId, companyId)).orderBy(asc(todoCategories.name)),
      db.select({ id: serviceTypes.id, name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.companyId, companyId)).orderBy(asc(serviceTypes.name)),
      db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, role: employees.role, status: employees.status }).from(employees).where(eq(employees.companyId, companyId)).orderBy(asc(employees.firstName)),
      db.select({ id: automations.id, number: automations.number, name: automations.name, kind: automations.kind }).from(automations).where(eq(automations.companyId, companyId)).orderBy(sql`lower(${automations.name})`),
    ]);
    return {
      templates: tpls, tags, categories: cats, services,
      employees: people.filter((p) => !["inactive", "terminated"].includes(p.status)).map((p) => ({ id: p.id, name: [p.first, p.last].filter(Boolean).join(" "), owner: p.role === "owner" })),
      automations: autos,
    };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => view(await find(req.user.companyId, req.params.id)));

  /** Checks a protected sequence's password (before opening it to edit). */
  app.post<{ Params: { id: string } }>("/:id/unlock", admin, async (req) => {
    const { password } = parse(z.object({ password: z.string().max(100) }), req.body);
    await unlock(await find(req.user.companyId, req.params.id), req, password);
    return { ok: true };
  });

  app.post("/", admin, async (req) => {
    const { companyId, sub } = req.user;
    const a = await checked(companyId, req.body);
    // New ones are on (like Homeworks), unless Crewdesk can't run its trigger.
    const enabled = a.enabled && !cannotTurnOn(defOf(a));
    const [row] = await db.insert(automations).values({
      companyId, number: await nextNumber(companyId), kind: a.kind, name: a.name, description: a.description, labels: a.labels, enabled, enabledAt: enabled ? new Date() : null,
      review: a.review, def: defOf(a), createdById: sub, updatedById: sub,
      passwordHash: a.kind === "sequence" && a.password ? await bcrypt.hash(a.password, 10) : null,
    }).returning();
    return view(row);
  });

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const { companyId, sub } = req.user;
    const old = await find(companyId, req.params.id);
    await unlock(old, req);
    const a = await checked(companyId, req.body, old.id);
    if (a.kind !== old.kind) throw new HttpError(400, "An automation can't become a sequence (or the other way); make a new one");
    const enabled = a.enabled && !cannotTurnOn(defOf(a));
    // Turning it on starts from now: only what happens after this starts it.
    const [row] = await db.update(automations).set({
      name: a.name, description: a.description, labels: a.labels, enabled, enabledAt: enabled ? (old.enabled ? old.enabledAt : new Date()) : old.enabledAt,
      review: a.review, def: defOf(a), updatedById: sub, updatedAt: new Date(),
      // A new password sets it; "" takes it off; left out keeps what's there.
      ...(a.kind === "sequence" && a.password != null ? { passwordHash: a.password ? await bcrypt.hash(a.password, 10) : null } : {}),
    }).where(eq(automations.id, old.id)).returning();
    if (old.enabled && !enabled) await stopAll(row, "The automation was turned off");
    return view(row);
  });

  app.post<{ Params: { id: string } }>("/:id/enabled", admin, async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const old = await find(req.user.companyId, req.params.id);
    if (enabled) {
      const no = notReady(old);
      if (no) throw new HttpError(400, no.startsWith("Can't run") ? no : `Before it can be turned on: ${no}`);
      await checkRefs(req.user.companyId, old.def, old.id);
    }
    const [row] = await db.update(automations).set({ enabled, enabledAt: enabled && !old.enabled ? new Date() : old.enabledAt, updatedById: req.user.sub, updatedAt: new Date() }).where(eq(automations.id, old.id)).returning();
    if (!enabled && old.enabled) await stopAll(row, "The automation was turned off");
    return view(row);
  });

  /** The Review column's switch: Review Before Execution on or off. */
  app.post<{ Params: { id: string } }>("/:id/review", admin, async (req) => {
    const { review } = parse(z.object({ review: z.boolean() }), req.body);
    const old = await find(req.user.companyId, req.params.id);
    const [row] = await db.update(automations).set({ review, updatedById: req.user.sub, updatedAt: new Date() }).where(eq(automations.id, old.id)).returning();
    return view(row);
  });

  /**
   * Turns on everything that was on in Homeworks and can run here. Ones that still need something
   * picked, or that Crewdesk can't run, are left off and listed with why.
   */
  app.post("/enable-homeworks", admin, async (req) => {
    const { companyId, sub } = req.user;
    const list = await db.select().from(automations).where(and(eq(automations.companyId, companyId), eq(automations.importedOn, true), eq(automations.enabled, false))).orderBy(sql`lower(${automations.name})`);
    const turnedOn: string[] = [];
    const left: { name: string; why: string }[] = [];
    for (const a of list) {
      const no = notReady(a);
      if (no) { left.push({ name: a.name, why: no }); continue; }
      await db.update(automations).set({ enabled: true, enabledAt: new Date(), updatedById: sub, updatedAt: new Date() }).where(eq(automations.id, a.id));
      turnedOn.push(a.name);
    }
    return { turnedOn, left };
  });

  app.delete<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const { companyId } = req.user;
    const a = await find(companyId, req.params.id);
    await unlock(a, req);
    const callers = (await db.select({ name: automations.name, def: automations.def }).from(automations).where(eq(automations.companyId, companyId)))
      .filter((x) => x.def.kind === "simple" && x.def.subAction === "run_automation" && x.def.subAutomationId === a.id);
    if (callers.length) throw new HttpError(400, `${callers.map((c) => `"${c.name}"`).join(", ")} run${callers.length === 1 ? "s" : ""} it next. Change ${callers.length === 1 ? "that" : "those"} first`);
    await db.delete(automations).where(eq(automations.id, a.id));
    return { ok: true };
  });

  /* ── Review Sequence ── */

  app.get("/review/list", async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({ s: automationSteps, r: automationRuns, a: { id: automations.id, name: automations.name, kind: automations.kind, number: automations.number }, c: customers }).from(automationSteps)
      .innerJoin(automationRuns, eq(automationRuns.id, automationSteps.runId)).innerJoin(automations, eq(automations.id, automationSteps.automationId))
      .leftJoin(customers, eq(customers.id, automationSteps.customerId))
      .where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review"))).orderBy(asc(automationSteps.createdAt)).limit(200);
    const out = [];
    for (const { s, r, a, c } of rows) {
      out.push({
        id: s.id, number: s.number, kind: s.kind, action: s.action, actionLabel: actionLabel(s.action.action, a.kind === "simple"), createdAt: s.createdAt, triggeredAt: r.triggeredAt, triggerKey: r.triggerKey,
        automation: a, customer: c ? { id: c.id, name: customerName(c), email: c.email, phone: c.phone } : null, subjectType: r.subjectType, subjectId: r.subjectId,
        preview: await previewStep(s, r).catch(() => null),
      });
    }
    return out;
  });

  /** Approve ("send"), reject ("skip"), or stop the rest for that customer. */
  app.post<{ Params: { id: string } }>("/steps/:id/review", async (req) => {
    const { decision } = parse(z.object({ decision: z.enum(["send", "skip", "stop"]) }), req.body);
    const s = await reviewStep(req.user.companyId, req.params.id, decision, req.user.sub);
    if (!s) throw new HttpError(400, "It isn't waiting for review any more");
    return s;
  });

  /** Stop a run for a customer (what's still waiting won't happen; no stop actions). */
  app.post<{ Params: { id: string } }>("/runs/:id/stop", async (req) => {
    const [row] = await db.select({ r: automationRuns, a: automations }).from(automationRuns).innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(and(eq(automationRuns.id, req.params.id), eq(automationRuns.companyId, req.user.companyId)));
    if (!row || row.r.status !== "running") throw new HttpError(400, "It isn't running");
    await stopRun(row.a, row.r, "Stopped by the office", new Date(), { stopActions: false });
    return { ok: true };
  });

  /* ── History ── */

  const PAGE = 25;
  const historyQuery = z.object({
    kind: z.enum(["simple", "sequence"]).optional(), automationId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
    /** "done" (done, skipped, failed: Automation History) or "all" (waiting and stopped too: Sequence History). */
    show: z.enum(["done", "all"]).default("done"), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).max(10_000).default(1),
  });

  /**
   * Automation History and Sequence History: each action, newest first, a page at a time. Added
   * (queued), scheduled and executed times; ones still waiting have no executed time.
   */
  app.get("/history", async (req) => {
    const { companyId } = req.user;
    const q = parse(historyQuery, req.query);
    const where = and(eq(automationSteps.companyId, companyId),
      q.show === "done" ? inArray(automationSteps.status, ["done", "skipped", "failed"]) : undefined,
      q.kind ? eq(automations.kind, q.kind) : undefined,
      q.automationId ? eq(automationSteps.automationId, q.automationId) : undefined,
      q.customerId ? eq(automationSteps.customerId, q.customerId) : undefined,
      q.q ? or(ilike(automations.name, `%${q.q}%`), ilike(automationSteps.detail, `%${q.q}%`)) : undefined);
    const from = db.select({ s: automationSteps, triggerKey: automationRuns.triggerKey, runId: automationRuns.id, runStatus: automationRuns.status, a: { id: automations.id, name: automations.name, kind: automations.kind, number: automations.number }, c: customers })
      .from(automationSteps).innerJoin(automationRuns, eq(automationRuns.id, automationSteps.runId)).innerJoin(automations, eq(automations.id, automationSteps.automationId))
      .leftJoin(customers, eq(customers.id, automationSteps.customerId));
    const rows = await from.where(where).orderBy(desc(sql`coalesce(${automationSteps.doneAt}, ${automationSteps.createdAt})`), desc(automationSteps.number)).limit(PAGE).offset((q.page - 1) * PAGE);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(automationSteps).innerJoin(automations, eq(automations.id, automationSteps.automationId)).where(where);
    return {
      rows: rows.map(({ s, triggerKey, runId, runStatus, a, c }) => ({
        id: s.id, number: s.number, addedAt: s.createdAt, scheduledAt: s.dueAt, executedAt: ["done", "skipped", "failed"].includes(s.status) ? s.doneAt : null, at: s.doneAt,
        status: s.status, detail: s.detail, kind: s.kind, action: s.action.action, actionLabel: actionLabel(s.action.action, a.kind === "simple"), triggerKey, runId, runStatus,
        automation: a, customer: c ? { id: c.id, name: customerName(c) } : null,
      })),
      page: q.page, pages: Math.max(1, Math.ceil(n / PAGE)), total: n,
    };
  });

  /* ── A customer's automations (their page → Automations) ── */

  const customerOf = async (companyId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Customer not found");
    const [c] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.companyId, companyId)));
    if (!c) throw new HttpError(404, "Customer not found");
    return c;
  };

  app.get<{ Params: { customerId: string } }>("/customer/:customerId", async (req) => {
    const { companyId } = req.user;
    const c = await customerOf(companyId, req.params.customerId);
    const list = await db.select().from(automations).where(eq(automations.companyId, companyId)).orderBy(...LIST_ORDER);
    return { automations: list.map((a) => ({ ...view(a), off: c.automationOffIds.includes(a.id) })) };
  });

  app.put<{ Params: { customerId: string; automationId: string } }>("/customer/:customerId/:automationId", async (req) => {
    const { on } = parse(z.object({ on: z.boolean() }), req.body);
    const { companyId } = req.user;
    const c = await customerOf(companyId, req.params.customerId);
    const a = await find(companyId, req.params.automationId);
    const off = on ? c.automationOffIds.filter((x) => x !== a.id) : [...new Set([...c.automationOffIds, a.id])];
    await db.update(customers).set({ automationOffIds: off }).where(eq(customers.id, c.id));
    if (!on) {
      // What's still waiting for them won't happen.
      const now = new Date();
      const running = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.customerId, c.id), eq(automationRuns.status, "running")));
      for (const r of running) await stopRun(a, r, "Turned off for this customer", now, { stopActions: false });
    }
    return { ok: true, off: !on };
  });

  /* ── Homeworks import ── */

  app.post("/import", { preHandler: requireRole("admin", AREA), bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = parse(automationImportSchema, req.body);
    return importHomeworks(req.user.companyId, req.user.sub, b);
  });
};

/**
 * Brings in Homeworks' automations and sequences (and the templates in the file, first), all
 * turned OFF, so nothing goes to a customer until someone turns it on; whether each was on in
 * Homeworks is kept. They keep their Homeworks Id. Templates are matched by their Homeworks id,
 * then by name; missing customer tags are made; people are matched by name. Ones already imported
 * are left as they are (only their Id and "was on in Homeworks" are brought up to date).
 */
export async function importHomeworks(companyId: string, by: string, b: AutomationImport) {
  const tplResult = b.templates.length ? await importTemplates(companyId, by, "homeworks", b.templates) : { added: 0, skipped: 0 };
  const tpls = await db.select({ id: templates.id, channel: templates.channel, name: templates.name, importedFrom: templates.importedFrom }).from(templates).where(eq(templates.companyId, companyId));
  const tagRows = await db.select({ id: crmTags.id, name: crmTags.name }).from(crmTags).where(eq(crmTags.companyId, companyId));
  const tags = new Map(tagRows.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const cats = new Map((await db.select({ id: todoCategories.id, name: todoCategories.name }).from(todoCategories).where(eq(todoCategories.companyId, companyId))).map((t) => [t.name.trim().toLowerCase(), t.id]));
  const services = new Map((await db.select({ id: serviceTypes.id, name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.companyId, companyId))).map((t) => [t.name.trim().toLowerCase(), t.id]));
  const people = (await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName }).from(employees).where(eq(employees.companyId, companyId)))
    .map((p) => ({ id: p.id, name: [p.first, p.last].filter(Boolean).join(" ").toLowerCase() }));
  const existing = await db.select({ id: automations.id, f: automations.importedFrom, number: automations.number, importedOn: automations.importedOn, labels: automations.labels, description: automations.description })
    .from(automations).where(eq(automations.companyId, companyId));
  const had = new Map(existing.filter((r) => r.f).map((r) => [r.f!, r]));
  const numbers = new Set(existing.map((r) => r.number));
  const notes: string[] = [];
  let tagsMade = 0;
  let missingTemplates = 0;

  const pickText = (p: { value?: string | null; text?: string | null } | null | undefined) => {
    const t = p?.text?.trim();
    return t && !/^-+\s*(please select|select tag)\s*-+$/i.test(t) ? t : null;
  };
  const tagId = async (name: string | null) => {
    if (!name) return null;
    const k = name.trim().toLowerCase();
    if (tags.has(k)) return tags.get(k)!;
    const [t] = await db.insert(crmTags).values({ companyId, name: name.trim().slice(0, 60) }).onConflictDoNothing().returning();
    const id = t?.id ?? (await db.select({ id: crmTags.id }).from(crmTags).where(and(eq(crmTags.companyId, companyId), sql`lower(${crmTags.name}) = ${k}`)))[0]?.id;
    if (t) tagsMade++;
    if (id) tags.set(k, id);
    return id ?? null;
  };
  const template = (channel: "email" | "text", p: { value?: string | null; text?: string | null } | null | undefined) => {
    const name = pickText(p);
    if (!name && !p?.value) return null;
    const hit = tpls.find((t) => t.channel === channel && p?.value && t.importedFrom === `homeworks:${p.value}`) ?? tpls.find((t) => t.channel === channel && name && t.name.trim().toLowerCase() === name.toLowerCase());
    if (!hit) missingTemplates++;
    return hit?.id ?? null;
  };
  const person = (p: { text?: string | null } | null | undefined) => {
    const n = pickText(p)?.toLowerCase();
    const hit = n ? people.find((x) => x.name === n) : null;
    return hit ? [hit.id] : [];
  };
  const cond = async (value: string, attrs: string[]): Promise<AutomationCond | null> => {
    const key = triggerKeyFor(value);
    if (!key) return null;
    const p = triggerDef(key)?.param;
    const c: AutomationCond = { key, tagIds: [], categoryIds: [], serviceIds: [] };
    for (const at of attrs) {
      if (p === "tags") { const id = await tagId(at); if (id) c.tagIds.push(id); }
      if (p === "categories") { const id = cats.get(at.trim().toLowerCase()); if (id) c.categoryIds.push(id); }
      if (p === "services") { const id = services.get(at.replace(/\s*-\s*\$[\d,.]+$/, "").trim().toLowerCase()); if (id) c.serviceIds.push(id); }
    }
    return c;
  };
  type HwAction = AutomationImport["sequences"][number]["blocks"][number]["actions"][number];
  const action = async (x: HwAction): Promise<AutomationAction | null> => {
    const key = x.action?.value as ActionKey | undefined;
    if (!key || !ACTION_KEYS.includes(key)) return null;
    const d = actionOf(key);
    return {
      waitMinutes: x.instant ? 0 : x.days * 1440 + x.hours * 60 + x.minutes, action: key,
      templateId: d.channel ? template(d.channel, d.channel === "email" ? x.email : x.text) : null,
      employeeIds: d.to === "employee" ? person(x.employee) : [], tagId: d.needs === "tag" ? await tagId(pickText(x.tag)) : null,
      todoTitle: d.needs === "todo" ? (x.title?.trim() || null) : null,
    };
  };
  const inOrder = (list: AutomationAction[]) => list.map((x, i) => ({ x, i })).sort((p, q) => p.x.waitMinutes - q.x.waitMinutes || p.i - q.i).map((p) => p.x);

  let next = await nextNumber(companyId);
  /** Its Homeworks Id when that number's free here; else the next one. */
  const numberFor = (hwId: string | number) => {
    const n = Number(hwId);
    const pick = Number.isInteger(n) && n > 0 && n < 2_000_000_000 && !numbers.has(n) ? n : null;
    const number = pick ?? next;
    numbers.add(number);
    if (number >= next) next = number + 1;
    return number;
  };
  /**
   * One already here: bring its Id and "was on in Homeworks" up to date, and fill in its Tags and
   * Notes if it has none (an earlier file left them out). Nothing anyone has set is changed.
   */
  const refresh = async (row: (typeof existing)[number], hwId: string | number, on: boolean, labels: string[] = [], notes?: string | null) => {
    const n = Number(hwId);
    const number = Number.isInteger(n) && n > 0 && n < 2_000_000_000 && row.number !== n && !numbers.has(n) ? n : row.number;
    if (number !== row.number) { numbers.add(number); if (number >= next) next = number + 1; }
    const fillLabels = !row.labels.length && labels.length ? labels.slice(0, 20).map((t) => t.slice(0, 40)) : null;
    const fillNotes = !row.description && notes?.trim() ? notes.trim() : null;
    if (number !== row.number || row.importedOn !== on || fillLabels || fillNotes) {
      await db.update(automations).set({ number, importedOn: on, ...(fillLabels ? { labels: fillLabels } : {}), ...(fillNotes ? { description: fillNotes } : {}) }).where(eq(automations.id, row.id));
    }
  };

  let added = 0;
  let already = 0;
  const later: { id: string; sub: string }[] = [];
  for (const h of b.automations) {
    const importedFrom = `homeworks:auto:${h.id}`;
    const was = had.get(importedFrom);
    if (was) { already++; await refresh(was, h.id, !!h.on, h.tags, h.notes); continue; }
    const key = triggerKeyFor(h.trigger?.value ?? "");
    const actKey = h.action?.value as ActionKey | undefined;
    if (!key || !actKey || !ACTION_KEYS.includes(actKey)) { notes.push(`"${h.title}": its trigger or action isn't one Crewdesk has, so it was left out`); continue; }
    const d = triggerDef(key)!;
    const delay = homeworksDelay(h.delay?.value);
    const ad = actionOf(actKey);
    let runAt: string | null = null;
    if (d.param === "datetime" && h.date) {
      const day = new Date(`${h.date} 12:00 UTC`);
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(h.time?.trim() ?? "");
      if (!Number.isNaN(day.getTime()) && m) {
        const h12 = Number(m[1]);
        const hour = m[3] ? (h12 % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0) : h12;
        runAt = `${day.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${m[2]}`;
      }
    }
    const subValue = h.subAction?.value ?? "none";
    const subAction: SubAction = subValue === "none" || !subValue ? "none" : subValue === "stop_automation" ? "stop_automation" : "run_automation";
    const trig = await cond(key, d.param === "tags" ? [pickText(h.tag)].filter((x): x is string => !!x) : []);
    const def: AutomationDef = {
      kind: "simple", trigger: trig!, runAt, delayMinutes: d.param === "datetime" || delay.daysBefore != null ? 0 : delay.delayMinutes, daysBefore: d.param === "datetime" ? null : delay.daysBefore,
      action: {
        waitMinutes: 0, action: actKey, templateId: ad.channel ? template(ad.channel, ad.channel === "email" ? h.emailTemplate : h.textTemplate) : null,
        employeeIds: ad.to === "employee" ? person(h.employee) : [], tagId: ad.needs === "tag" ? await tagId(pickText(h.actionTag)) : null, todoTitle: null,
      },
      subAction, subAutomationId: null, subDelayMinutes: subAction === "run_automation" ? homeworksDelay(h.subDelay?.value).delayMinutes : 0,
    };
    const [row] = await db.insert(automations).values({
      companyId, number: numberFor(h.id), kind: "simple", name: h.title.trim().slice(0, 150), description: h.notes?.trim() || null, labels: h.tags.slice(0, 20).map((t) => t.slice(0, 40)),
      enabled: false, review: !!h.review, def, importedFrom, importedOn: !!h.on, createdById: by, updatedById: by,
    }).onConflictDoNothing().returning();
    if (!row) continue;
    added++;
    if (subAction === "run_automation" && h.subAutomation?.value) later.push({ id: row.id, sub: `homeworks:auto:${h.subAutomation.value}` });
  }

  for (const s of b.sequences) {
    const importedFrom = `homeworks:seq:${s.id}`;
    const was = had.get(importedFrom);
    if (was) { already++; await refresh(was, s.id, s.on !== false, [], s.description); continue; }
    const blocks = [];
    let bad = "";
    for (const blk of s.blocks) {
      const trig = await cond(blk.trigger.value, blk.trigger.attrs);
      if (!trig) { bad = `its trigger "${blk.trigger.text ?? blk.trigger.value}" isn't one Crewdesk has`; break; }
      // Homeworks' groups of conditions: all in a group (AND), any one group (OR).
      const when: AutomationCond[][] = [];
      for (const group of blk.when) {
        const g = (await Promise.all(group.map((w) => cond(w.value, w.attrs)))).filter((x): x is AutomationCond => !!x);
        if (g.length) when.push(g);
      }
      const actions = inOrder((await Promise.all(blk.actions.map((x) => action(x)))).filter((x): x is AutomationAction => !!x));
      if (!actions.length) { bad = "a block has no actions Crewdesk can do"; break; }
      blocks.push({ trigger: trig, when, actions });
    }
    if (bad || !blocks.length) { notes.push(`"${s.title}": ${bad || "it has no blocks"}, so it was left out`); continue; }
    const stops = (await Promise.all(s.stops.map((x) => cond(x.value, x.attrs)))).filter((x): x is AutomationCond => !!x);
    const stopActions = inOrder((await Promise.all(s.stopActions.map((x) => action(x)))).filter((x): x is AutomationAction => !!x));
    const def: AutomationDef = { kind: "sequence", blocks, stops, stopActions };
    const [row] = await db.insert(automations).values({
      companyId, number: numberFor(s.id), kind: "sequence", name: s.title.trim().slice(0, 150), description: s.description?.trim() || null, enabled: false, review: !!s.review, def,
      importedFrom, importedOn: s.on !== false, createdById: by, updatedById: by,
    }).onConflictDoNothing().returning();
    if (row) added++;
  }

  // "Run Another Automation": point at the imported one.
  for (const l of later) {
    const [nextA] = await db.select({ id: automations.id }).from(automations).where(and(eq(automations.companyId, companyId), eq(automations.importedFrom, l.sub)));
    const [row] = await db.select().from(automations).where(eq(automations.id, l.id));
    if (nextA && row.def.kind === "simple") await db.update(automations).set({ def: { ...row.def, subAutomationId: nextA.id } }).where(eq(automations.id, l.id));
  }
  return { added, already, notes, tagsMade, missingTemplates, templatesAdded: tplResult.added };
}

export default routes;

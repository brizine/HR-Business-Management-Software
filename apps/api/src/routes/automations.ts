import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ACTION_KEYS, AUTOMATION_ACTIONS, allActions, allConds, automationImportSchema, automationProblems, automationSchema, cannotTurnOn, customerName, deadBlocks,
  homeworksDelay, triggerDef, triggerKeyFor,
  type ActionKey, type AutomationAction, type AutomationCond, type AutomationDef, type AutomationImport, type AutomationInput, type SubAction,
} from "@crewdesk/shared";
import { db } from "../db";
import { automationRuns, automationSteps, automations, crmTags, customers, employees, serviceTypes, templates, todoCategories } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { previewStep, reviewCount, reviewStep, stopRun } from "../lib/automations";
import { HttpError, parse } from "../lib/errors";

const AREA = "customers" as const;
type Row = typeof automations.$inferSelect;

/** The stored parts (everything but the columns). */
const defOf = (a: AutomationInput): AutomationDef => {
  const { name: _n, description: _d, labels: _l, enabled: _e, review: _r, ...def } = a;
  return def as AutomationDef;
};

/** Checks the templates, people, tags, categories, services and next automation it uses are this company's (and the right kind). */
async function checkRefs(companyId: string, def: AutomationDef, selfId?: string) {
  const acts = allActions(def);
  const tplIds = [...new Set(acts.map((s) => s.templateId).filter((x): x is string => !!x))];
  const tpls = new Map((tplIds.length ? await db.select({ id: templates.id, channel: templates.channel, name: templates.name }).from(templates).where(and(eq(templates.companyId, companyId), inArray(templates.id, tplIds))) : []).map((t) => [t.id, t]));
  for (const act of acts) {
    if (!act.templateId) continue;
    const t = tpls.get(act.templateId);
    const want = AUTOMATION_ACTIONS[act.action];
    if (!t) throw new HttpError(400, `${want.label}: that template doesn't exist`);
    if ("channel" in want && t.channel !== want.channel) throw new HttpError(400, `${want.label}: choose ${want.channel === "email" ? "an email" : "a text"} template ("${t.name}" is ${t.channel === "email" ? "an email" : "a text"})`);
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

/** The input checked and cleaned: what each trigger and action doesn't use is cleared. */
function cleaned(a: AutomationInput): AutomationInput {
  const cond = (c: AutomationCond): AutomationCond => {
    const p = triggerDef(c.key)?.param;
    return { key: c.key, tagIds: p === "tags" ? c.tagIds : [], categoryIds: p === "categories" ? c.categoryIds : [], serviceIds: p === "services" ? c.serviceIds : [] };
  };
  const act = (x: AutomationAction, keepWait: boolean): AutomationAction => {
    const d = AUTOMATION_ACTIONS[x.action];
    return {
      waitMinutes: keepWait ? x.waitMinutes : 0, action: x.action, templateId: "channel" in d ? x.templateId : null,
      employeeIds: d.to === "employee" ? x.employeeIds : [], tagId: "needs" in d && d.needs === "tag" ? x.tagId : null, todoTitle: "needs" in d && d.needs === "todo" ? x.todoTitle : null,
    };
  };
  if (a.kind === "simple") {
    const d = triggerDef(a.trigger.key);
    return {
      ...a, trigger: cond(a.trigger), action: act(a.action, false),
      runAt: d?.param === "datetime" ? a.runAt : null, daysBefore: d?.before ? a.daysBefore : null, delayMinutes: d?.before || d?.param === "datetime" ? 0 : a.delayMinutes,
      subAutomationId: a.subAction === "run_automation" ? a.subAutomationId : null, subDelayMinutes: a.subAction === "run_automation" ? a.subDelayMinutes : 0,
    };
  }
  return {
    ...a,
    blocks: a.blocks.map((b) => ({ trigger: cond(b.trigger), or: b.or.map(cond), and: b.and.map(cond), actions: [...b.actions].sort((x, y) => x.waitMinutes - y.waitMinutes).map((x) => act(x, true)) })),
    stops: a.stops.map(cond), stopActions: a.stopActions.map((x) => act(x, false)),
  };
}

async function checked(companyId: string, body: unknown, selfId?: string) {
  const a = cleaned(parse(automationSchema, body));
  const problems = automationProblems(a);
  if (problems.length) throw new HttpError(400, problems.slice(0, 3).join(". "));
  await checkRefs(companyId, defOf(a), selfId);
  if (a.enabled) { const no = cannotTurnOn(defOf(a)); if (no) throw new HttpError(400, no); }
  return a;
}

const view = (a: Row, counts?: { running: number; review: number; done: number; skipped: number; lastAt: Date | null }) => ({
  id: a.id, number: a.number, kind: a.kind, name: a.name, description: a.description, labels: a.labels, enabled: a.enabled, enabledAt: a.enabledAt, review: a.review, def: a.def,
  imported: a.importedFrom?.split(":")[0] ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt,
  problems: automationProblems(a.def), cannotTurnOn: cannotTurnOn(a.def), deadBlocks: deadBlocks(a.def),
  counts: counts ?? { running: 0, review: 0, done: 0, skipped: 0, lastAt: null },
});

/** Turns an automation off: its runs stop (what's waiting, or in Review, won't happen). */
async function stopAll(a: Row, why: string) {
  const now = new Date();
  await db.update(automationSteps).set({ status: "stopped", detail: why, dueAt: null, doneAt: now }).where(and(eq(automationSteps.automationId, a.id), inArray(automationSteps.status, ["waiting", "review"])));
  await db.update(automationRuns).set({ status: "stopped", reason: why, finishedAt: now }).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.status, "running")));
}

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

  app.get("/", async (req) => {
    const { companyId } = req.user;
    const list = await db.select().from(automations).where(eq(automations.companyId, companyId)).orderBy(asc(automations.number));
    const runs = await db.select({ id: automationRuns.automationId, status: automationRuns.status, n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${automationRuns.createdAt})` }).from(automationRuns)
      .where(and(eq(automationRuns.companyId, companyId), sql`(${automationRuns.status} = 'running' or ${automationRuns.createdAt} > now() - interval '30 days')`))
      .groupBy(automationRuns.automationId, automationRuns.status);
    const inReview = await db.select({ id: automationSteps.automationId, n: sql<number>`count(*)::int` }).from(automationSteps)
      .where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review"))).groupBy(automationSteps.automationId);
    const of = (id: string, status: string) => runs.find((c) => c.id === id && c.status === status)?.n ?? 0;
    return {
      review: await reviewCount(companyId),
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
      db.select({ id: templates.id, name: templates.name, channel: templates.channel, audience: templates.audience }).from(templates).where(eq(templates.companyId, companyId)).orderBy(asc(templates.name)),
      db.select({ id: crmTags.id, name: crmTags.name, color: crmTags.color }).from(crmTags).where(and(eq(crmTags.companyId, companyId), eq(crmTags.archived, false))).orderBy(asc(crmTags.name)),
      db.select({ id: todoCategories.id, name: todoCategories.name }).from(todoCategories).where(eq(todoCategories.companyId, companyId)).orderBy(asc(todoCategories.name)),
      db.select({ id: serviceTypes.id, name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.companyId, companyId)).orderBy(asc(serviceTypes.name)),
      db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, role: employees.role, status: employees.status }).from(employees).where(eq(employees.companyId, companyId)).orderBy(asc(employees.firstName)),
      db.select({ id: automations.id, number: automations.number, name: automations.name, kind: automations.kind }).from(automations).where(eq(automations.companyId, companyId)).orderBy(asc(automations.number)),
    ]);
    return {
      templates: tpls, tags, categories: cats, services,
      employees: people.filter((p) => !["inactive", "terminated"].includes(p.status)).map((p) => ({ id: p.id, name: [p.first, p.last].filter(Boolean).join(" "), owner: p.role === "owner" })),
      automations: autos,
    };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => view(await find(req.user.companyId, req.params.id)));

  app.post("/", admin, async (req) => {
    const { companyId, sub } = req.user;
    const a = await checked(companyId, req.body);
    const [row] = await db.insert(automations).values({
      companyId, number: await nextNumber(companyId), kind: a.kind, name: a.name, description: a.description, labels: a.labels, enabled: a.enabled, enabledAt: a.enabled ? new Date() : null,
      review: a.review, def: defOf(a), createdById: sub, updatedById: sub,
    }).returning();
    return view(row);
  });

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const { companyId, sub } = req.user;
    const old = await find(companyId, req.params.id);
    const a = await checked(companyId, req.body, old.id);
    if (a.kind !== old.kind) throw new HttpError(400, "An automation can't become a sequence (or the other way); make a new one");
    // Turning it on starts from now: only what happens after this starts it.
    const [row] = await db.update(automations).set({
      name: a.name, description: a.description, labels: a.labels, enabled: a.enabled, enabledAt: a.enabled ? (old.enabled ? old.enabledAt : new Date()) : old.enabledAt,
      review: a.review, def: defOf(a), updatedById: sub, updatedAt: new Date(),
    }).where(eq(automations.id, old.id)).returning();
    if (old.enabled && !a.enabled) await stopAll(row, "The automation was turned off");
    return view(row);
  });

  app.post<{ Params: { id: string } }>("/:id/enabled", admin, async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const old = await find(req.user.companyId, req.params.id);
    if (enabled) {
      const problems = automationProblems(old.def);
      if (problems.length) throw new HttpError(400, `Fix it first: ${problems.slice(0, 2).join(". ")}`);
      const no = cannotTurnOn(old.def);
      if (no) throw new HttpError(400, no);
      await checkRefs(req.user.companyId, old.def, old.id);
    }
    const [row] = await db.update(automations).set({ enabled, enabledAt: enabled && !old.enabled ? new Date() : old.enabledAt, updatedById: req.user.sub, updatedAt: new Date() }).where(eq(automations.id, old.id)).returning();
    if (!enabled && old.enabled) await stopAll(row, "The automation was turned off");
    return view(row);
  });

  app.post<{ Params: { id: string } }>("/:id/clone", admin, async (req) => {
    const { companyId, sub } = req.user;
    const old = await find(companyId, req.params.id);
    const [row] = await db.insert(automations).values({
      companyId, number: await nextNumber(companyId), kind: old.kind, name: `Copy of ${old.name}`.slice(0, 150), description: old.description, labels: old.labels, enabled: false,
      review: old.review, def: old.def, createdById: sub, updatedById: sub,
    }).returning();
    return view(row);
  });

  app.delete<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const { companyId } = req.user;
    const a = await find(companyId, req.params.id);
    const callers = (await db.select({ name: automations.name, def: automations.def }).from(automations).where(eq(automations.companyId, companyId)))
      .filter((x) => x.def.kind === "simple" && x.def.subAction === "run_automation" && x.def.subAutomationId === a.id);
    if (callers.length) throw new HttpError(400, `${callers.map((c) => `"${c.name}"`).join(", ")} run${callers.length === 1 ? "s" : ""} it next. Change ${callers.length === 1 ? "that" : "those"} first`);
    await db.delete(automations).where(eq(automations.id, a.id));
    return { ok: true };
  });

  /* ── Review ── */

  app.get("/review/list", async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({ s: automationSteps, r: automationRuns, a: { id: automations.id, name: automations.name, kind: automations.kind, number: automations.number }, c: customers }).from(automationSteps)
      .innerJoin(automationRuns, eq(automationRuns.id, automationSteps.runId)).innerJoin(automations, eq(automations.id, automationSteps.automationId))
      .leftJoin(customers, eq(customers.id, automationSteps.customerId))
      .where(and(eq(automationSteps.companyId, companyId), eq(automationSteps.status, "review"))).orderBy(asc(automationSteps.createdAt)).limit(200);
    const out = [];
    for (const { s, r, a, c } of rows) {
      out.push({
        id: s.id, kind: s.kind, action: s.action, actionLabel: AUTOMATION_ACTIONS[s.action.action]?.label ?? s.action.action, createdAt: s.createdAt, triggeredAt: r.triggeredAt, triggerKey: r.triggerKey,
        automation: a, customer: c ? { id: c.id, name: customerName(c), email: c.email, phone: c.phone } : null, subjectType: r.subjectType, subjectId: r.subjectId,
        preview: await previewStep(s, r).catch(() => null),
      });
    }
    return out;
  });

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

  const historyQuery = z.object({
    kind: z.enum(["simple", "sequence"]).optional(), automationId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
    status: z.string().max(60).optional(), q: z.string().max(100).optional(), before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
    skipped: z.enum(["0", "1"]).optional(),
  });

  /** Sequence History (and the customer tab): runs, newest first, with their actions. */
  app.get("/runs", async (req) => {
    const { companyId } = req.user;
    const q = parse(historyQuery, req.query);
    const where = and(eq(automationRuns.companyId, companyId),
      q.kind ? eq(automations.kind, q.kind) : undefined,
      q.automationId ? eq(automationRuns.automationId, q.automationId) : undefined,
      q.customerId ? eq(automationRuns.customerId, q.customerId) : undefined,
      q.status ? inArray(automationRuns.status, q.status.split(",")) : q.skipped === "1" ? undefined : sql`${automationRuns.status} <> 'skipped'`,
      q.before ? lt(automationRuns.createdAt, new Date(q.before)) : undefined,
      q.q ? or(ilike(automations.name, `%${q.q}%`), sql`concat_ws(' ', ${customers.firstName}, ${customers.lastName}, ${customers.companyName}) ilike ${`%${q.q}%`}`) : undefined);
    const rows = await db.select({ r: automationRuns, a: { id: automations.id, name: automations.name, kind: automations.kind, number: automations.number }, c: customers }).from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId)).leftJoin(customers, eq(customers.id, automationRuns.customerId))
      .where(where).orderBy(desc(automationRuns.createdAt)).limit(q.limit);
    const steps = rows.length ? await db.select().from(automationSteps).where(inArray(automationSteps.runId, rows.map((r) => r.r.id))).orderBy(asc(automationSteps.kind), asc(automationSteps.idx)) : [];
    return {
      runs: rows.map(({ r, a, c }) => ({
        id: r.id, status: r.status, reason: r.reason, triggerKey: r.triggerKey, blockIndex: r.blockIndex, triggeredAt: r.triggeredAt, createdAt: r.createdAt, finishedAt: r.finishedAt,
        subjectType: r.subjectType, subjectId: r.subjectId, automation: a, customer: c ? { id: c.id, name: customerName(c) } : null,
        steps: steps.filter((s) => s.runId === r.id).map((s) => ({ id: s.id, kind: s.kind, idx: s.idx, action: s.action, dueAt: s.dueAt, status: s.status, detail: s.detail, doneAt: s.doneAt })),
      })),
      more: rows.length === q.limit ? rows[rows.length - 1].r.createdAt : null,
    };
  });

  /** Automation History: each action done (or skipped, or failed), newest first. */
  app.get("/history", async (req) => {
    const { companyId } = req.user;
    const q = parse(historyQuery, req.query);
    const where = and(eq(automationSteps.companyId, companyId), inArray(automationSteps.status, q.status ? q.status.split(",") : ["done", "skipped", "failed"]),
      q.kind ? eq(automations.kind, q.kind) : undefined,
      q.automationId ? eq(automationSteps.automationId, q.automationId) : undefined,
      q.customerId ? eq(automationSteps.customerId, q.customerId) : undefined,
      q.before ? lt(automationSteps.doneAt, new Date(q.before)) : undefined,
      q.q ? or(ilike(automations.name, `%${q.q}%`), ilike(automationSteps.detail, `%${q.q}%`)) : undefined);
    const rows = await db.select({ s: automationSteps, triggerKey: automationRuns.triggerKey, a: { id: automations.id, name: automations.name, kind: automations.kind, number: automations.number }, c: customers })
      .from(automationSteps).innerJoin(automationRuns, eq(automationRuns.id, automationSteps.runId)).innerJoin(automations, eq(automations.id, automationSteps.automationId))
      .leftJoin(customers, eq(customers.id, automationSteps.customerId))
      .where(where).orderBy(desc(automationSteps.doneAt)).limit(q.limit);
    return {
      rows: rows.map(({ s, triggerKey, a, c }) => ({ id: s.id, at: s.doneAt, status: s.status, detail: s.detail, kind: s.kind, action: s.action.action, triggerKey, automation: a, customer: c ? { id: c.id, name: customerName(c) } : null })),
      more: rows.length === q.limit ? rows[rows.length - 1].s.doneAt : null,
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
    const list = await db.select({ id: automations.id, number: automations.number, kind: automations.kind, name: automations.name, enabled: automations.enabled, def: automations.def })
      .from(automations).where(eq(automations.companyId, companyId)).orderBy(asc(automations.number));
    return { automations: list.map(({ def, ...a }) => ({ ...a, trigger: def.kind === "simple" ? def.trigger.key : def.blocks[0]?.trigger.key ?? null, off: c.automationOffIds.includes(a.id) })) };
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

  app.post("/import", { preHandler: requireRole("admin", AREA), bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const b = parse(automationImportSchema, req.body);
    return importHomeworks(req.user.companyId, req.user.sub, b);
  });
};

/**
 * Brings in Homeworks' automations and sequences, all turned OFF (so nothing goes to a customer
 * until someone checks each one and turns it on). Templates are matched to the ones imported from
 * Homeworks (by their Homeworks id, then by name); missing customer tags are made; people are
 * matched by name. Ones already imported are left alone.
 */
export async function importHomeworks(companyId: string, by: string, b: AutomationImport) {
  const tpls = await db.select({ id: templates.id, channel: templates.channel, name: templates.name, importedFrom: templates.importedFrom }).from(templates).where(eq(templates.companyId, companyId));
  const tagRows = await db.select({ id: crmTags.id, name: crmTags.name }).from(crmTags).where(eq(crmTags.companyId, companyId));
  const tags = new Map(tagRows.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const cats = new Map((await db.select({ id: todoCategories.id, name: todoCategories.name }).from(todoCategories).where(eq(todoCategories.companyId, companyId))).map((t) => [t.name.trim().toLowerCase(), t.id]));
  const services = new Map((await db.select({ id: serviceTypes.id, name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.companyId, companyId))).map((t) => [t.name.trim().toLowerCase(), t.id]));
  const people = (await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName }).from(employees).where(eq(employees.companyId, companyId)))
    .map((p) => ({ id: p.id, name: [p.first, p.last].filter(Boolean).join(" ").toLowerCase() }));
  const had = new Set((await db.select({ f: automations.importedFrom }).from(automations).where(eq(automations.companyId, companyId))).map((r) => r.f));
  const notes: string[] = [];
  let tagsMade = 0;
  let missingTemplates = 0;

  const pickText = (p: { value?: string | null; text?: string | null } | null | undefined) => {
    const t = p?.text?.trim();
    return t && !/^-+\s*please select\s*-+$/i.test(t) ? t : null;
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
  const action = async (x: HwAction, keepWait: boolean): Promise<AutomationAction | null> => {
    const key = x.action?.value as ActionKey | undefined;
    if (!key || !ACTION_KEYS.includes(key)) return null;
    const d = AUTOMATION_ACTIONS[key];
    return {
      waitMinutes: keepWait && !x.instant ? x.days * 1440 + x.hours * 60 + x.minutes : 0, action: key,
      templateId: "channel" in d ? template(d.channel, d.channel === "email" ? x.email : x.text) : null,
      employeeIds: d.to === "employee" ? person(x.employee) : [], tagId: "needs" in d && d.needs === "tag" ? await tagId(pickText(x.tag)) : null,
      todoTitle: "needs" in d && d.needs === "todo" ? (x.title?.trim() || null) : null,
    };
  };

  let number = await nextNumber(companyId);
  let added = 0;
  let already = 0;
  const later: { id: string; sub: string }[] = [];
  for (const h of b.automations) {
    const importedFrom = `homeworks:auto:${h.id}`;
    if (had.has(importedFrom)) { already++; continue; }
    const key = triggerKeyFor(h.trigger?.value ?? "");
    const actKey = h.action?.value as ActionKey | undefined;
    if (!key || !actKey || !ACTION_KEYS.includes(actKey)) { notes.push(`"${h.title}": its trigger or action isn't one Crewdesk has, so it was left out`); continue; }
    const d = triggerDef(key)!;
    const delay = homeworksDelay(h.delay?.value);
    const ad = AUTOMATION_ACTIONS[actKey];
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
      kind: "simple", trigger: trig!, runAt, delayMinutes: d.before || d.param === "datetime" ? 0 : delay.delayMinutes, daysBefore: d.before ? delay.daysBefore ?? d.before[0] : null,
      action: {
        waitMinutes: 0, action: actKey, templateId: "channel" in ad ? template(ad.channel, ad.channel === "email" ? h.emailTemplate : h.textTemplate) : null,
        employeeIds: ad.to === "employee" ? person(h.employee) : [], tagId: "needs" in ad && ad.needs === "tag" ? await tagId(pickText(h.actionTag)) : null, todoTitle: null,
      },
      subAction, subAutomationId: null, subDelayMinutes: subAction === "run_automation" ? homeworksDelay(h.subDelay?.value).delayMinutes : 0,
    };
    const [row] = await db.insert(automations).values({
      companyId, number: number++, kind: "simple", name: h.title.slice(0, 150), description: h.notes?.trim() || null, labels: h.tags.slice(0, 20).map((t) => t.slice(0, 40)),
      enabled: false, review: !!h.review, def, importedFrom, createdById: by, updatedById: by,
    }).onConflictDoNothing().returning();
    if (!row) continue;
    added++;
    if (subAction === "run_automation" && h.subAutomation?.value) later.push({ id: row.id, sub: `homeworks:auto:${h.subAutomation.value}` });
  }

  for (const s of b.sequences) {
    const importedFrom = `homeworks:seq:${s.id}`;
    if (had.has(importedFrom)) { already++; continue; }
    const blocks = [];
    let bad = "";
    for (const blk of s.blocks) {
      const trig = await cond(blk.trigger.value, blk.trigger.attrs);
      if (!trig) { bad = `its trigger "${blk.trigger.text ?? blk.trigger.value}" isn't one Crewdesk has`; break; }
      const and: AutomationCond[] = [];
      const orC: AutomationCond[] = [];
      for (const [gi, group] of blk.when.entries()) {
        for (const w of group) {
          const c = await cond(w.value, w.attrs);
          if (!c) continue;
          const uses = triggerDef(c.key)!.use as readonly string[];
          if (gi > 0 && uses.includes("if")) orC.push(c); else and.push(c);
        }
      }
      const actions = (await Promise.all(blk.actions.map((x) => action(x, true)))).filter((x): x is AutomationAction => !!x).sort((x, y) => x.waitMinutes - y.waitMinutes);
      if (!actions.length) { bad = "a block has no actions Crewdesk can do"; break; }
      blocks.push({ trigger: trig, or: orC, and, actions });
    }
    if (bad || !blocks.length) { notes.push(`"${s.title}": ${bad || "it has no blocks"}, so it was left out`); continue; }
    const stops = (await Promise.all(s.stops.map((x) => cond(x.value, x.attrs)))).filter((x): x is AutomationCond => !!x);
    const stopActions = (await Promise.all(s.stopActions.map((x) => action(x, false)))).filter((x): x is AutomationAction => !!x);
    const def: AutomationDef = { kind: "sequence", blocks, stops, stopActions };
    const [row] = await db.insert(automations).values({
      companyId, number: number++, kind: "sequence", name: s.title.slice(0, 150), description: s.description?.trim() || null, enabled: false, review: !!s.review, def, importedFrom, createdById: by, updatedById: by,
    }).onConflictDoNothing().returning();
    if (row) added++;
  }

  // "Run another automation": point at the imported one.
  for (const l of later) {
    const [next] = await db.select({ id: automations.id }).from(automations).where(and(eq(automations.companyId, companyId), eq(automations.importedFrom, l.sub)));
    const [row] = await db.select().from(automations).where(eq(automations.id, l.id));
    if (next && row.def.kind === "simple") await db.update(automations).set({ def: { ...row.def, subAutomationId: next.id } }).where(eq(automations.id, l.id));
  }
  return { added, already, notes, tagsMade, missingTemplates };
}

export default routes;

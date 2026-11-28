import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  INACTIVE_STATUSES, TODO_HORIZON_DAYS, TODO_REPEAT_LABELS, VISIT_FILES_MAX, customerName, describeSeries, formatAddress, formatTodoTime, ruleDates,
  todoCategorySchema, todoNoteSchema, todoSchema, todoUpdateSchema, trackedMinutes,
  type OffSeason, type TodoRepeat, type TodoRule, type TodoUpdate,
} from "@crewdesk/shared";
import { db } from "../db";
import type { Tx } from "../lib/crm";
import {
  companies, crewMembers, crews, customers, employees, offSeasons, properties, propertyAssignments, todoAssignees, todoCategories, todoFiles, todoNotes, todoSeries, todos,
} from "../db/schema";
import { fileView, sendStored, storeUpload } from "../lib/attachments";
import { jobSources, newRecordCustom, updatedCustom } from "../lib/customFields";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { localParts } from "../lib/tz";
import { except, notify } from "../lib/notify";

const AREA = "todos" as const;
type Todo = typeof todos.$inferSelect;
type Series = typeof todoSeries.$inferSelect;

const dayMs = 86_400_000;
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

/** Managers (To-dos area) see every to-do; everyone else sees the ones given to them or that they made. */
export function todoVisibility(req: FastifyRequest): SQL | undefined {
  if (isManager(req, AREA)) return undefined;
  const me = req.user.sub;
  return or(
    eq(todos.createdById, me),
    exists(db.select({ x: sql`1` }).from(todoAssignees).where(and(eq(todoAssignees.todoId, todos.id), eq(todoAssignees.employeeId, me)))),
  );
}

/** The repeat in words: the series' own description, or the older fixed repeat's name. */
const repeatLabel = (t: Todo, series: Pick<Series, "id" | "label">[]) =>
  t.seriesId ? series.find((s) => s.id === t.seriesId)?.label ?? TODO_REPEAT_LABELS[t.repeat as TodoRepeat] ?? "Repeats" : null;

/** To-dos with their customer, property, category, crew, people, repeat and work time, ready to show. */
export async function present(rows: Todo[]) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const people = await db.select({ todoId: todoAssignees.todoId, id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(todoAssignees).innerJoin(employees, eq(employees.id, todoAssignees.employeeId))
    .where(inArray(todoAssignees.todoId, ids)).orderBy(asc(employees.firstName));
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const customerIds = uniq(rows.map((t) => t.customerId));
  const propertyIds = uniq(rows.map((t) => t.propertyId));
  const personIds = uniq(rows.flatMap((t) => [t.doneById, t.createdById]));
  const categoryIds = uniq(rows.map((t) => t.categoryId));
  const crewIds = uniq(rows.map((t) => t.crewId));
  const seriesIds = uniq(rows.map((t) => t.seriesId));
  const cs = customerIds.length ? await db.select({ id: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName }).from(customers).where(inArray(customers.id, customerIds)) : [];
  const ps = propertyIds.length ? await db.select({ id: properties.id, name: properties.name, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip, gateCode: properties.gateCode, accessNotes: properties.accessNotes, notes: properties.notes, custom: properties.custom }).from(properties).where(inArray(properties.id, propertyIds)) : [];
  const es = personIds.length ? await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(inArray(employees.id, personIds)) : [];
  const cats = categoryIds.length ? await db.select({ id: todoCategories.id, name: todoCategories.name }).from(todoCategories).where(inArray(todoCategories.id, categoryIds)) : [];
  const crewRows = crewIds.length ? await db.select({ id: crews.id, name: crews.name, color: crews.color }).from(crews).where(inArray(crews.id, crewIds)) : [];
  const series = seriesIds.length ? await db.select({ id: todoSeries.id, label: todoSeries.label }).from(todoSeries).where(inArray(todoSeries.id, seriesIds)) : [];
  const counts = async (table: typeof todoFiles | typeof todoNotes) =>
    db.select({ todoId: table.todoId, n: sql<number>`count(*)::int` }).from(table).where(inArray(table.todoId, ids)).groupBy(table.todoId);
  const [files, notes] = await Promise.all([counts(todoFiles), counts(todoNotes)]);
  const name = (id: string | null) => { const e = es.find((x) => x.id === id); return e ? `${e.firstName} ${e.lastName}` : null; };
  const now = new Date();
  return rows.map((t) => {
    const c = cs.find((x) => x.id === t.customerId);
    const p = ps.find((x) => x.id === t.propertyId);
    return {
      ...t,
      customer: c ? { id: c.id, name: customerName(c) } : null,
      property: p ? { id: p.id, name: p.name, address: formatAddress(p), gateCode: p.gateCode, accessNotes: p.accessNotes, notes: p.notes, custom: p.custom } : null,
      category: cats.find((x) => x.id === t.categoryId) ?? null,
      crew: crewRows.find((x) => x.id === t.crewId) ?? null,
      assignees: people.filter((x) => x.todoId === t.id).map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
      doneBy: name(t.doneById),
      createdBy: name(t.createdById),
      repeatLabel: repeatLabel(t, series),
      trackedMinutes: trackedMinutes(t, now),
      fileCount: files.find((x) => x.todoId === t.id)?.n ?? 0,
      noteCount: notes.find((x) => x.todoId === t.id)?.n ?? 0,
    };
  });
}

async function findTodo(req: FastifyRequest, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound("To-do");
  const [t] = await db.select().from(todos).where(and(eq(todos.id, id), eq(todos.companyId, req.user.companyId), todoVisibility(req)));
  if (!t) notFound("To-do");
  return t;
}

/** Work on it (start, stop, finish, add photos and notes): whoever it's for, whoever made it, or a manager. */
async function workOn(req: FastifyRequest, id: string) {
  const t = await findTodo(req, id);
  if (isManager(req, AREA) || t.createdById === req.user.sub) return t;
  const [mine] = await db.select({ x: todoAssignees.todoId }).from(todoAssignees).where(and(eq(todoAssignees.todoId, t.id), eq(todoAssignees.employeeId, req.user.sub)));
  if (!mine) throw new HttpError(403, "This to-do isn't yours");
  return t;
}

async function assigneesOf(todoId: string) {
  return (await db.select({ id: todoAssignees.employeeId }).from(todoAssignees).where(eq(todoAssignees.todoId, todoId))).map((r) => r.id);
}

type Before = { customerId: string | null; propertyId: string | null; crewId: string | null };
/** Checks who it's for, the customer and property, category and crew before saving. Returns the people to assign. */
async function checkInput(req: FastifyRequest, body: TodoUpdate, before?: Before) {
  const { companyId, sub: me } = req.user;
  const manager = isManager(req, AREA);
  let ids = [...new Set(body.assigneeIds)];
  if (body.crewId && body.crewId !== before?.crewId) {
    if (!manager) throw new HttpError(403, "Giving a to-do to a crew needs To-dos manager access");
    const [crew] = await db.select({ id: crews.id, leadId: crews.leadId }).from(crews).where(and(eq(crews.id, body.crewId), eq(crews.companyId, companyId)));
    if (!crew) throw new HttpError(400, "That crew isn't set up");
    // A crew and nobody ticked: the crew's people.
    if (!ids.length) {
      const members = (await db.select({ id: crewMembers.employeeId }).from(crewMembers).innerJoin(employees, eq(employees.id, crewMembers.employeeId))
        .where(and(eq(crewMembers.crewId, crew.id), notInArray(employees.status, INACTIVE_STATUSES)))).map((m) => m.id);
      ids = [...new Set([...(crew.leadId ? [crew.leadId] : []), ...members])];
    }
  }
  if (!manager) {
    // Without To-dos manager access you can only make to-dos for yourself.
    if (ids.some((id) => id !== me)) throw new HttpError(403, "You can only give to-dos to yourself. A manager can give them to others.");
    if (!ids.length) ids = [me];
  }
  if (ids.length) {
    const found = await db.select({ id: employees.id }).from(employees)
      .where(and(eq(employees.companyId, companyId), inArray(employees.id, ids), notInArray(employees.status, INACTIVE_STATUSES)));
    if (found.length !== ids.length) throw new HttpError(400, "One of the people picked isn't on the team");
  }
  const linkChanged = !before || before.customerId !== (body.customerId ?? null) || before.propertyId !== (body.propertyId ?? null);
  if (linkChanged && (body.customerId || body.propertyId) && !isManager(req, "customers")) {
    throw new HttpError(403, "Linking a customer or property needs Customers & billing access");
  }
  if (body.customerId) {
    const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, body.customerId), eq(customers.companyId, companyId)));
    if (!c) throw new HttpError(404, "Customer not found");
  }
  if (body.propertyId) {
    const [p] = await db.select({ id: properties.id }).from(properties)
      .innerJoin(propertyAssignments, eq(propertyAssignments.propertyId, properties.id))
      .where(and(eq(properties.id, body.propertyId), eq(properties.companyId, companyId), eq(propertyAssignments.customerId, body.customerId!)))
      .limit(1);
    if (!p) throw new HttpError(400, "That property isn't one of this customer's");
  }
  if (body.categoryId) {
    const [c] = await db.select({ id: todoCategories.id }).from(todoCategories).where(and(eq(todoCategories.id, body.categoryId), eq(todoCategories.companyId, companyId)));
    if (!c) throw new HttpError(400, "That category isn't set up");
  }
  return ids;
}

const fields = (b: TodoUpdate) => ({
  title: b.title, notes: b.notes ?? null, customerId: b.customerId ?? null, propertyId: b.propertyId ?? null, location: b.location ?? null,
  color: b.color, startTime: b.startTime ?? null, endTime: b.startTime ? b.endTime ?? null : null, budgetedHours: b.budgetedHours ?? null,
  categoryId: b.categoryId ?? null, crewId: b.crewId ?? null,
});

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** "Mon, Nov 23 · 8:00 AM – 10:00 AM · 1201 Bluestem Dr" for notifications. */
function whenWhere(t: { date: string; endDate?: string | null; startTime?: string | null; endTime?: string | null; location?: string | null }, place?: string | null) {
  const days = t.endDate && t.endDate !== t.date ? `${fmtDay(t.date)} – ${fmtDay(t.endDate)}` : fmtDay(t.date);
  return [days, formatTodoTime(t.startTime, t.endTime), place ?? t.location].filter(Boolean).join(" · ");
}
async function placeOf(propertyId: string | null | undefined) {
  if (!propertyId) return null;
  const [p] = await db.select({ street: properties.street, city: properties.city }).from(properties).where(eq(properties.id, propertyId));
  return p ? [p.street, p.city].filter(Boolean).join(", ") : null;
}

async function seasonFor(companyId: string, id: string | null | undefined) {
  if (!id) return null;
  const [s] = await db.select().from(offSeasons).where(and(eq(offSeasons.id, id), eq(offSeasons.companyId, companyId)));
  return s ?? null;
}
const asSeason = (s: { startMd: string; endMd: string } | null): OffSeason | null => (s ? { start: s.startMd, end: s.endMd } : null);

/** How far ahead a series is made now: a year from today (and never past its last date). */
function horizonFor(rule: TodoRule, start: string, today: string) {
  const base = plusDays(start > today ? start : today, TODO_HORIZON_DAYS);
  return rule.end === "date" && rule.until && rule.until < base ? rule.until : base;
}

/** Inserts to-dos copying `template` on each date, with these people. */
async function insertCopies(tx: Tx, template: Omit<typeof todos.$inferInsert, "date">, dates: string[], people: string[]) {
  if (!dates.length) return [];
  const rows: Todo[] = [];
  // In chunks, so a 500-day series stays within the query size.
  for (let i = 0; i < dates.length; i += 200) {
    const part = await tx.insert(todos).values(dates.slice(i, i + 200).map((date) => ({ ...template, date }))).returning();
    rows.push(...part);
  }
  if (people.length) {
    const links = rows.flatMap((t) => people.map((employeeId) => ({ todoId: t.id, employeeId })));
    for (let i = 0; i < links.length; i += 1000) await tx.insert(todoAssignees).values(links.slice(i, i + 1000));
  }
  return rows;
}

/**
 * Tops up repeating series that end on a date or never: their to-dos are made a year ahead, so
 * this adds the next stretch (copying the latest to-do in the series) as time passes. Run by the
 * scheduler; cheap when nothing is due.
 */
export async function extendTodoSeries(now = new Date()) {
  const due = await db.select().from(todoSeries).where(and(
    isNull(todoSeries.stoppedAt),
    sql`${todoSeries.rule}->>'end' <> 'count'`,
    sql`${todoSeries.generatedThrough} < (${now.toISOString().slice(0, 10)}::date + 335)`,
  )).limit(200);
  let made = 0;
  for (const s of due) {
    const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, s.companyId));
    const today = localParts(now, co?.tz ?? "America/Chicago").date;
    const through = horizonFor(s.rule, s.startDate, today);
    if (through <= s.generatedThrough) {
      // A series ending on a date that's all made: nothing more to do.
      if (s.rule.end === "date") await db.update(todoSeries).set({ stoppedAt: now }).where(eq(todoSeries.id, s.id));
      continue;
    }
    const [template] = await db.select().from(todos).where(eq(todos.seriesId, s.id)).orderBy(desc(todos.date)).limit(1);
    if (!template) { await db.update(todoSeries).set({ stoppedAt: now }).where(eq(todoSeries.id, s.id)); continue; }
    const season = asSeason(await seasonFor(s.companyId, s.offSeasonId));
    const dates = ruleDates(s.startDate, s.rule, { offSeason: season, through, after: s.generatedThrough }).map((d) => plusDays(d, s.shiftDays));
    const people = await assigneesOf(template.id);
    const { id: _id, date: _date, endDate: _end, doneAt: _d, doneById: _db, startedAt: _s, trackedSeconds: _t, createdAt: _c, updatedAt: _u, ...copy } = template;
    await db.transaction(async (tx) => {
      const rows = await insertCopies(tx, { ...copy, endDate: null }, dates.filter((d) => d > template.date), people);
      made += rows.length;
      await tx.update(todoSeries).set({ generatedThrough: through }).where(eq(todoSeries.id, s.id));
    });
  }
  return made;
}

/**
 * To-dos: everyone can see and work on the ones given to them and make their own; managers (To-dos
 * area) see all of them, give them to anyone or a crew, and keep the categories. Linking a customer
 * needs Customers & billing.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { status?: string; to?: string; from?: string; mine?: string; assigneeId?: string; customerId?: string; propertyId?: string; categoryId?: string; crewId?: string; q?: string; limit?: string } }>("/", async (req) => {
    const { companyId, sub: me } = req.user;
    const today = await companyToday(companyId);
    const q = req.query;
    const where: (SQL | undefined)[] = [eq(todos.companyId, companyId), todoVisibility(req)];
    const status = q.status === "done" || q.status === "all" ? q.status : "open";
    if (status === "open") where.push(isNull(todos.doneAt));
    if (status === "done") where.push(isNotNull(todos.doneAt));
    if (q.to === "today") where.push(lte(todos.date, today));
    else if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) where.push(lte(todos.date, q.to));
    // From a date: the to-dos still running on it (a multi-day one that started earlier counts).
    if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) where.push(gte(sql`coalesce(${todos.endDate}, ${todos.date})`, q.from));
    const who = q.mine === "true" ? me : q.assigneeId === "none" ? null : q.assigneeId;
    if (who) where.push(exists(db.select({ x: sql`1` }).from(todoAssignees).where(and(eq(todoAssignees.todoId, todos.id), eq(todoAssignees.employeeId, who)))));
    if (q.assigneeId === "none") where.push(sql`not exists (select 1 from todo_assignees ta where ta.todo_id = ${todos.id})`);
    if (q.customerId) where.push(eq(todos.customerId, q.customerId));
    if (q.propertyId) where.push(eq(todos.propertyId, q.propertyId));
    if (q.categoryId === "none") where.push(isNull(todos.categoryId));
    else if (q.categoryId) where.push(eq(todos.categoryId, q.categoryId));
    if (q.crewId) where.push(eq(todos.crewId, q.crewId));
    if (q.q?.trim()) where.push(or(ilike(todos.title, `%${q.q.trim()}%`), ilike(todos.notes, `%${q.q.trim()}%`), ilike(todos.location, `%${q.q.trim()}%`)));
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 500);
    const rows = await db.select().from(todos).where(and(...where))
      .orderBy(...(status === "done" ? [desc(todos.doneAt)] : [asc(todos.date), sql`${todos.startTime} nulls last`, asc(todos.createdAt)]))
      .limit(limit + 1);
    return { today, items: await present(rows.slice(0, limit)), more: rows.length > limit };
  });

  /** For the top bar: your open to-dos that are due today or overdue. */
  app.get("/count", async (req) => {
    const today = await companyToday(req.user.companyId);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(todos)
      .innerJoin(todoAssignees, and(eq(todoAssignees.todoId, todos.id), eq(todoAssignees.employeeId, req.user.sub)))
      .where(and(eq(todos.companyId, req.user.companyId), isNull(todos.doneAt), lte(todos.date, today)));
    return { due: n };
  });

  /**
   * Budgeted hours already booked, week by week from `from` (to-dos and work orders), for these
   * people or everyone visible: Homeworks' chart beside the date.
   */
  app.get<{ Querystring: { from?: string; weeks?: string; ids?: string; not?: string } }>("/workload", async (req) => {
    const { companyId } = req.user;
    const from = req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : await companyToday(companyId);
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 5, 1), 12);
    const to = plusDays(from, weeks * 7 - 1);
    const ids = (req.query.ids ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50);
    const who = ids.length ? sql`and exists (select 1 from todo_assignees ta where ta.todo_id = t.id and ta.employee_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}))` : sql``;
    const whoV = ids.length ? sql`and exists (select 1 from visit_assignees va where va.visit_id = v.id and va.employee_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}))` : sql``;
    // The to-do being edited isn't counted as already booked.
    const skip = req.query.not && /^[0-9a-f-]{36}$/i.test(req.query.not) ? sql`and t.id <> ${req.query.not}::uuid` : sql``;
    const mineT = isManager(req, AREA) ? sql`` : sql`and (t.created_by_id = ${req.user.sub} or exists (select 1 from todo_assignees ta2 where ta2.todo_id = t.id and ta2.employee_id = ${req.user.sub}))`;
    const mineV = isManager(req, "customers") ? sql`` : sql`and exists (select 1 from visit_assignees va2 where va2.visit_id = v.id and va2.employee_id = ${req.user.sub})`;
    const rows = await db.execute<{ week: number; hours: number }>(sql`
      select week, sum(hours)::float as hours from (
        select floor((t.date - ${from}::date) / 7)::int as week, coalesce(t.budgeted_hours, 0) as hours from todos t
          where t.company_id = ${companyId} and t.date between ${from}::date and ${to}::date ${who} ${mineT} ${skip}
        union all
        select floor((v.date - ${from}::date) / 7)::int, coalesce(v.budgeted_hours, 0) from visits v
          where v.company_id = ${companyId} and v.status <> 'skipped' and v.date between ${from}::date and ${to}::date ${whoV} ${mineV}
      ) x group by week order by week`);
    const list = rows.rows as { week: number; hours: number }[];
    return Array.from({ length: weeks }, (_, i) => ({ start: plusDays(from, i * 7), end: plusDays(from, i * 7 + 6), hours: Math.round((list.find((r) => Number(r.week) === i)?.hours ?? 0) * 100) / 100 }));
  });

  // ---- Categories (Homeworks' "To-do Category" with "Add New Category"): everyone picks, managers keep the list.

  app.get("/categories", async (req) => {
    const rows = await db.select({ id: todoCategories.id, name: todoCategories.name, n: sql<number>`(select count(*)::int from todos t where t.category_id = "todo_categories"."id")` })
      .from(todoCategories).where(eq(todoCategories.companyId, req.user.companyId)).orderBy(asc(todoCategories.name));
    return rows.map(({ n, ...c }) => ({ ...c, todoCount: n }));
  });
  const categoryManager = (req: FastifyRequest) => {
    if (!isManager(req, AREA)) throw new HttpError(403, "Keeping the to-do categories needs To-dos manager access");
  };
  const uniqueName = async (companyId: string, name: string, notId?: string) => {
    const [dupe] = await db.select({ id: todoCategories.id }).from(todoCategories)
      .where(and(eq(todoCategories.companyId, companyId), sql`lower(${todoCategories.name}) = lower(${name})`, notId ? ne(todoCategories.id, notId) : undefined));
    if (dupe) throw new HttpError(400, "There's already a category with that name");
  };
  app.post("/categories", async (req) => {
    categoryManager(req);
    const { name } = parse(todoCategorySchema, req.body);
    await uniqueName(req.user.companyId, name);
    const [row] = await db.insert(todoCategories).values({ companyId: req.user.companyId, name }).returning();
    return { id: row.id, name: row.name, todoCount: 0 };
  });
  app.put<{ Params: { id: string } }>("/categories/:id", async (req) => {
    categoryManager(req);
    const { name } = parse(todoCategorySchema, req.body);
    await uniqueName(req.user.companyId, name, req.params.id);
    const [row] = await db.update(todoCategories).set({ name }).where(and(eq(todoCategories.id, req.params.id), eq(todoCategories.companyId, req.user.companyId))).returning();
    if (!row) notFound("Category");
    return { id: row.id, name: row.name };
  });
  /** Its to-dos stay, with no category. */
  app.delete<{ Params: { id: string } }>("/categories/:id", async (req) => {
    categoryManager(req);
    const rows = await db.delete(todoCategories).where(and(eq(todoCategories.id, req.params.id), eq(todoCategories.companyId, req.user.companyId))).returning({ id: todoCategories.id });
    if (!rows.length) notFound("Category");
    return { ok: true };
  });

  // ---- One to-do

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const t = await findTodo(req, req.params.id);
    const [shown] = await present([t]);
    const seriesLeft = t.seriesId
      ? (await db.select({ n: sql<number>`count(*)::int` }).from(todos).where(and(eq(todos.seriesId, t.seriesId), gte(todos.date, t.date), isNull(todos.doneAt))))[0].n
      : 0;
    const [series] = t.seriesId ? await db.select({ stoppedAt: todoSeries.stoppedAt, rule: todoSeries.rule }).from(todoSeries).where(eq(todoSeries.id, t.seriesId)) : [];
    return { ...shown, seriesLeft, seriesEnd: series?.rule.end ?? null, today: await companyToday(req.user.companyId) };
  });

  app.post("/", async (req) => {
    const body = parse(todoSchema, req.body);
    const { companyId, sub: me } = req.user;
    const people = await checkInput(req, body);
    const rule = body.rule ?? null;
    const season = rule?.offSeasonId ? await seasonFor(companyId, rule.offSeasonId) : null;
    if (rule?.offSeasonId && !season) throw new HttpError(400, "That off-season isn't set up");
    const today = await companyToday(companyId);
    const through = rule ? horizonFor(rule, body.date, today) : null;
    const dates = rule ? ruleDates(body.date, rule, { offSeason: asSeason(season), through: through! }) : [body.date];
    if (!dates.length) throw new HttpError(400, "These settings don't make any to-dos. Check the dates and the off-season.");
    const seriesId = rule ? randomUUID() : null;
    const label = rule ? describeSeries(body.date, rule, season?.name) : null;
    const custom = await newRecordCustom(companyId, "todo", (req.body as { custom?: unknown })?.custom, await jobSources(companyId, body.propertyId, body.customerId));
    const created = await db.transaction(async (tx) => {
      if (rule) {
        await tx.insert(todoSeries).values({
          id: seriesId!, companyId, rule, startDate: body.date, offSeasonId: season?.id ?? null, label: label!,
          // A set number of to-dos is made at once; others are topped up later.
          generatedThrough: rule.end === "count" ? dates[dates.length - 1] : through!,
          stoppedAt: rule.end === "count" ? new Date() : null,
        });
      }
      return insertCopies(tx, {
        ...fields(body), custom, companyId, endDate: rule || !body.endDate || body.endDate === body.date ? null : body.endDate,
        seriesId, repeat: rule ? rule.freq : "none", createdById: me,
      }, dates, people);
    });
    const first = created[0];
    notify(companyId, except(people, me), {
      category: "todos",
      title: `New to-do: ${first.title}`,
      body: whenWhere(first, await placeOf(first.propertyId)) + (label ? ` · ${label.charAt(0).toLowerCase()}${label.slice(1)}` : ""),
      link: { screen: "todos", id: first.id },
    });
    const [shown] = await present([first]);
    return { ...shown, created: created.length };
  });

  /** Edit one to-do, or (applyTo=following) this one and the later open ones in its series. */
  app.put<{ Params: { id: string }; Querystring: { applyTo?: string } }>("/:id", async (req) => {
    const t = await findTodo(req, req.params.id);
    const { companyId, sub: me } = req.user;
    if (!isManager(req, AREA) && t.createdById !== me) throw new HttpError(403, "Only the person who made this to-do or a manager can change it");
    const body = parse(todoUpdateSchema, req.body);
    const people = await checkInput(req, body, t);
    const before = new Set(await assigneesOf(t.id));
    const shift = Math.round((Date.parse(`${body.date}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / dayMs);
    const custom = await updatedCustom(companyId, "todo", (req.body as { custom?: unknown })?.custom, t.custom);
    const following = req.query.applyTo === "following" && !!t.seriesId;
    const targets = following
      ? await db.select().from(todos).where(and(eq(todos.seriesId, t.seriesId!), eq(todos.companyId, companyId), gte(todos.date, t.date), or(isNull(todos.doneAt), eq(todos.id, t.id))))
      : [t];
    await db.transaction(async (tx) => {
      for (const row of targets) {
        const date = row.id === t.id ? body.date : plusDays(row.date, shift);
        const endDate = row.id === t.id ? (body.endDate && body.endDate !== body.date ? body.endDate : null) : row.endDate;
        await tx.update(todos).set({ ...fields(body), ...(custom ? { custom } : {}), date, endDate, updatedAt: new Date() }).where(eq(todos.id, row.id));
        await tx.delete(todoAssignees).where(eq(todoAssignees.todoId, row.id));
        if (people.length) await tx.insert(todoAssignees).values(people.map((employeeId) => ({ todoId: row.id, employeeId })));
      }
      // Later top-ups land on the moved days too.
      if (following && shift) await tx.update(todoSeries).set({ shiftDays: sql`${todoSeries.shiftDays} + ${shift}` }).where(eq(todoSeries.id, t.seriesId!));
    });
    const [after] = await db.select().from(todos).where(eq(todos.id, t.id));
    const added = people.filter((id) => !before.has(id));
    notify(companyId, except(added, me), {
      category: "todos",
      title: `New to-do: ${after.title}`,
      body: whenWhere(after, await placeOf(after.propertyId)) + (targets.length > 1 ? ` · and ${targets.length - 1} later` : ""),
      link: { screen: "todos", id: after.id },
    });
    const [shown] = await present([after]);
    return { ...shown, changed: targets.length };
  });

  const show = async (id: string) => {
    const [after] = await db.select().from(todos).where(eq(todos.id, id));
    const [shown] = await present([after]);
    return shown;
  };
  const elapsed = (t: Todo, now: Date) => (t.startedAt ? Math.max(0, Math.round((now.getTime() - t.startedAt.getTime()) / 1000)) : 0);

  /** Check it off (or undo); a running timer stops. Anyone it's for, whoever made it, or a manager. */
  app.post<{ Params: { id: string }; Body: { done?: boolean } }>("/:id/done", async (req) => {
    const t = await workOn(req, req.params.id);
    const done = req.body?.done !== false;
    const now = new Date();
    await db.update(todos).set(done
      ? { doneAt: t.doneAt ?? now, doneById: t.doneById ?? req.user.sub, startedAt: null, trackedSeconds: t.trackedSeconds + elapsed(t, now) }
      : { doneAt: null, doneById: null }).where(eq(todos.id, t.id));
    return show(t.id);
  });

  /** Work tracking (Homeworks' "Start Work" on the to-do's sheet): start the timer. */
  app.post<{ Params: { id: string } }>("/:id/start", async (req) => {
    const t = await workOn(req, req.params.id);
    if (t.doneAt) throw new HttpError(400, "This to-do is done; undo that to track more time");
    if (!t.startedAt) await db.update(todos).set({ startedAt: new Date() }).where(eq(todos.id, t.id));
    return show(t.id);
  });
  /** Stop the timer, keeping the time. */
  app.post<{ Params: { id: string } }>("/:id/stop", async (req) => {
    const t = await workOn(req, req.params.id);
    if (t.startedAt) await db.update(todos).set({ startedAt: null, trackedSeconds: t.trackedSeconds + elapsed(t, new Date()) }).where(eq(todos.id, t.id));
    return show(t.id);
  });

  /** Delete one, or (scope=following) this one and the later open ones in its series, which stops the series. */
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>("/:id", async (req) => {
    const t = await findTodo(req, req.params.id);
    if (!isManager(req, AREA) && t.createdById !== req.user.sub) throw new HttpError(403, "Only the person who made this to-do or a manager can delete it");
    const following = req.query.scope === "following" && !!t.seriesId;
    const rows = await db.transaction(async (tx) => {
      if (following) await tx.update(todoSeries).set({ stoppedAt: new Date() }).where(eq(todoSeries.id, t.seriesId!));
      return following
        ? tx.delete(todos).where(and(eq(todos.seriesId, t.seriesId!), eq(todos.companyId, req.user.companyId), gte(todos.date, t.date), or(isNull(todos.doneAt), eq(todos.id, t.id)))).returning({ id: todos.id })
        : tx.delete(todos).where(eq(todos.id, t.id)).returning({ id: todos.id });
    });
    return { deleted: rows.length };
  });

  // ---- Notes for the dispatcher: anyone working on it adds them; whoever wrote one or a manager removes it.

  app.get<{ Params: { id: string } }>("/:id/notes", async (req) => {
    const t = await findTodo(req, req.params.id);
    const rows = await db.select({ n: todoNotes, first: employees.firstName, last: employees.lastName }).from(todoNotes)
      .leftJoin(employees, eq(employees.id, todoNotes.authorId)).where(eq(todoNotes.todoId, t.id)).orderBy(asc(todoNotes.createdAt));
    return rows.map(({ n, first, last }) => ({ id: n.id, body: n.body, authorId: n.authorId, author: first ? `${first} ${last}` : null, createdAt: n.createdAt }));
  });
  app.post<{ Params: { id: string } }>("/:id/notes", async (req) => {
    const t = await workOn(req, req.params.id);
    const { body } = parse(todoNoteSchema, req.body);
    const { companyId, sub: me } = req.user;
    const [n] = await db.insert(todoNotes).values({ companyId, todoId: t.id, body, authorId: me }).returning();
    const [author] = await db.select({ firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(eq(employees.id, me));
    const who = author ? `${author.firstName} ${author.lastName}` : "Someone";
    notify(companyId, except([...(t.createdById ? [t.createdById] : []), ...(await assigneesOf(t.id))], me), {
      category: "todos",
      title: `Note on "${t.title}" from ${who}`,
      body: body.length > 140 ? `${body.slice(0, 137)}…` : body,
      link: { screen: "todos", id: t.id },
    });
    return { id: n.id, body: n.body, authorId: n.authorId, author: who, createdAt: n.createdAt };
  });
  app.delete<{ Params: { id: string; noteId: string } }>("/:id/notes/:noteId", async (req) => {
    const t = await findTodo(req, req.params.id);
    const [n] = await db.select().from(todoNotes).where(and(eq(todoNotes.id, req.params.noteId), eq(todoNotes.todoId, t.id)));
    if (!n) notFound("Note");
    if (!isManager(req, AREA) && n.authorId !== req.user.sub) throw new HttpError(403, "Only whoever wrote it or a manager can remove it");
    await db.delete(todoNotes).where(eq(todoNotes.id, n.id));
    return { ok: true };
  });

  // ---- Photos and documents (like Homeworks'): anyone working on it adds them; everyone who sees it sees them.

  const loadFile = async (todoId: string, fileId: string) => {
    const [f] = await db.select().from(todoFiles).where(and(eq(todoFiles.id, fileId), eq(todoFiles.todoId, todoId)));
    if (!f) notFound("File");
    return f;
  };
  app.get<{ Params: { id: string } }>("/:id/files", async (req) => {
    const t = await findTodo(req, req.params.id);
    const rows = await db.select({ f: todoFiles, first: employees.firstName, last: employees.lastName }).from(todoFiles)
      .leftJoin(employees, eq(employees.id, todoFiles.uploadedById)).where(eq(todoFiles.todoId, t.id)).orderBy(asc(todoFiles.createdAt));
    return rows.map((r) => fileView(r.f, r.first ? `${r.first} ${r.last}` : null));
  });
  /** multipart/form-data: "file" (a photo, PDF or short video, up to 25 MB) and an optional "caption". */
  app.post<{ Params: { id: string } }>("/:id/files", async (req) => {
    const t = await workOn(req, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(todoFiles).where(eq(todoFiles.todoId, t.id));
    if (n >= VISIT_FILES_MAX) throw new HttpError(400, `A to-do can have up to ${VISIT_FILES_MAX} photos and documents`);
    const stored = await storeUpload(req, "todos", t.id);
    const [row] = await db.insert(todoFiles).values({ companyId: req.user.companyId, todoId: t.id, ...stored, uploadedById: req.user.sub }).returning();
    return fileView(row);
  });
  app.get<{ Params: { id: string; fileId: string }; Querystring: { download?: string } }>("/:id/files/:fileId", async (req, reply) => {
    const t = await findTodo(req, req.params.id);
    return sendStored(reply, await loadFile(t.id, req.params.fileId), !!req.query.download);
  });
  app.patch<{ Params: { id: string; fileId: string } }>("/:id/files/:fileId", async (req) => {
    const t = await workOn(req, req.params.id);
    const f = await loadFile(t.id, req.params.fileId);
    const { caption } = parse(z.object({ caption: z.string().trim().max(300).nullable() }), req.body);
    const [row] = await db.update(todoFiles).set({ caption: caption || null }).where(eq(todoFiles.id, f.id)).returning();
    return fileView(row);
  });
  /** Whoever added it, or a manager. */
  app.delete<{ Params: { id: string; fileId: string } }>("/:id/files/:fileId", async (req) => {
    const t = await findTodo(req, req.params.id);
    const f = await loadFile(t.id, req.params.fileId);
    if (!isManager(req, AREA) && f.uploadedById !== req.user.sub) throw new HttpError(403, "Only whoever added it or a manager can remove it");
    await db.delete(todoFiles).where(eq(todoFiles.id, f.id));
    return { ok: true };
  });
};

export default routes;

import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  INACTIVE_STATUSES, TODO_REPEAT_LABELS, customerName, formatAddress, formatTodoTime, todoDates, todoSchema, todoUpdateSchema,
  type TodoRepeat, type TodoUpdate,
} from "@crewdesk/shared";
import { db } from "../db";
import { customers, employees, properties, propertyAssignments, todoAssignees, todos } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { except, notify } from "../lib/notify";

const AREA = "todos" as const;
type Todo = typeof todos.$inferSelect;

/** Managers (To-dos area) see every to-do; everyone else sees the ones given to them or that they made. */
export function todoVisibility(req: FastifyRequest): SQL | undefined {
  if (isManager(req, AREA)) return undefined;
  const me = req.user.sub;
  return or(
    eq(todos.createdById, me),
    exists(db.select({ x: sql`1` }).from(todoAssignees).where(and(eq(todoAssignees.todoId, todos.id), eq(todoAssignees.employeeId, me)))),
  );
}

/** To-dos with their customer, property and people, ready to show. */
async function present(rows: Todo[]) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const people = await db.select({ todoId: todoAssignees.todoId, id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(todoAssignees).innerJoin(employees, eq(employees.id, todoAssignees.employeeId))
    .where(inArray(todoAssignees.todoId, ids)).orderBy(asc(employees.firstName));
  const customerIds = [...new Set(rows.map((t) => t.customerId).filter((x): x is string => !!x))];
  const propertyIds = [...new Set(rows.map((t) => t.propertyId).filter((x): x is string => !!x))];
  const personIds = [...new Set(rows.flatMap((t) => [t.doneById, t.createdById]).filter((x): x is string => !!x))];
  const cs = customerIds.length ? await db.select({ id: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName }).from(customers).where(inArray(customers.id, customerIds)) : [];
  const ps = propertyIds.length ? await db.select({ id: properties.id, name: properties.name, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip, gateCode: properties.gateCode }).from(properties).where(inArray(properties.id, propertyIds)) : [];
  const es = personIds.length ? await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(inArray(employees.id, personIds)) : [];
  const name = (id: string | null) => { const e = es.find((x) => x.id === id); return e ? `${e.firstName} ${e.lastName}` : null; };
  return rows.map((t) => {
    const c = cs.find((x) => x.id === t.customerId);
    const p = ps.find((x) => x.id === t.propertyId);
    return {
      ...t,
      customer: c ? { id: c.id, name: customerName(c) } : null,
      property: p ? { id: p.id, name: p.name, address: formatAddress(p), gateCode: p.gateCode } : null,
      assignees: people.filter((x) => x.todoId === t.id).map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
      doneBy: name(t.doneById),
      createdBy: name(t.createdById),
    };
  });
}

async function findTodo(req: FastifyRequest, id: string) {
  const [t] = await db.select().from(todos).where(and(eq(todos.id, id), eq(todos.companyId, req.user.companyId), todoVisibility(req)));
  if (!t) notFound("To-do");
  return t;
}

async function assigneesOf(todoId: string) {
  return (await db.select({ id: todoAssignees.employeeId }).from(todoAssignees).where(eq(todoAssignees.todoId, todoId))).map((r) => r.id);
}

/** Checks who it's for, and the customer and property, before saving. Returns the people to assign. */
async function checkInput(req: FastifyRequest, body: TodoUpdate, before?: { customerId: string | null; propertyId: string | null }) {
  const { companyId, sub: me } = req.user;
  const manager = isManager(req, AREA);
  let ids = [...new Set(body.assigneeIds)];
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
  return ids;
}

const fields = (b: TodoUpdate) => ({
  title: b.title, notes: b.notes ?? null, customerId: b.customerId ?? null, propertyId: b.propertyId ?? null, location: b.location ?? null,
  color: b.color, startTime: b.startTime ?? null, endTime: b.startTime ? b.endTime ?? null : null, budgetedHours: b.budgetedHours ?? null,
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

/**
 * To-dos: everyone can see and finish the ones given to them and make their own; managers (To-dos
 * area) see all of them and give them to anyone. Linking a customer needs Customers & billing.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { status?: string; to?: string; from?: string; mine?: string; assigneeId?: string; customerId?: string; propertyId?: string; q?: string; limit?: string } }>("/", async (req) => {
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

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const t = await findTodo(req, req.params.id);
    const [shown] = await present([t]);
    const seriesLeft = t.seriesId
      ? (await db.select({ n: sql<number>`count(*)::int` }).from(todos).where(and(eq(todos.seriesId, t.seriesId), gte(todos.date, t.date), isNull(todos.doneAt))))[0].n
      : 0;
    return { ...shown, seriesLeft, today: await companyToday(req.user.companyId) };
  });

  app.post("/", async (req) => {
    const body = parse(todoSchema, req.body);
    const { companyId, sub: me } = req.user;
    const people = await checkInput(req, body);
    const dates = todoDates(body.date, body.repeat as TodoRepeat, body.repeatUntil);
    const seriesId = dates.length > 1 ? randomUUID() : null;
    const created = await db.transaction(async (tx) => {
      const rows = await tx.insert(todos).values(dates.map((date) => ({
        ...fields(body), companyId, date, endDate: dates.length > 1 || !body.endDate || body.endDate === body.date ? null : body.endDate,
        seriesId, repeat: dates.length > 1 ? body.repeat : "none", createdById: me,
      }))).returning();
      if (people.length) await tx.insert(todoAssignees).values(rows.flatMap((t) => people.map((employeeId) => ({ todoId: t.id, employeeId }))));
      return rows;
    });
    const first = created[0];
    const repeats = created.length > 1 ? ` · ${TODO_REPEAT_LABELS[body.repeat as TodoRepeat].toLowerCase()} until ${fmtDay(body.repeatUntil!)}` : "";
    notify(companyId, except(people, me), {
      category: "todos",
      title: `New to-do: ${first.title}`,
      body: whenWhere(first, await placeOf(first.propertyId)) + repeats,
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
    const shift = Math.round((Date.parse(`${body.date}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / 86_400_000);
    const targets = req.query.applyTo === "following" && t.seriesId
      ? await db.select().from(todos).where(and(eq(todos.seriesId, t.seriesId), eq(todos.companyId, companyId), gte(todos.date, t.date), or(isNull(todos.doneAt), eq(todos.id, t.id))))
      : [t];
    await db.transaction(async (tx) => {
      for (const row of targets) {
        const date = row.id === t.id ? body.date : new Date(Date.parse(`${row.date}T00:00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10);
        const endDate = row.id === t.id ? (body.endDate && body.endDate !== body.date ? body.endDate : null) : row.endDate;
        await tx.update(todos).set({ ...fields(body), date, endDate, updatedAt: new Date() }).where(eq(todos.id, row.id));
        await tx.delete(todoAssignees).where(eq(todoAssignees.todoId, row.id));
        if (people.length) await tx.insert(todoAssignees).values(people.map((employeeId) => ({ todoId: row.id, employeeId })));
      }
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

  /** Check it off (or undo). Anyone it's for, whoever made it, or a manager. */
  app.post<{ Params: { id: string }; Body: { done?: boolean } }>("/:id/done", async (req) => {
    const t = await findTodo(req, req.params.id);
    const done = req.body?.done !== false;
    await db.update(todos).set(done ? { doneAt: t.doneAt ?? new Date(), doneById: t.doneById ?? req.user.sub } : { doneAt: null, doneById: null }).where(eq(todos.id, t.id));
    const [after] = await db.select().from(todos).where(eq(todos.id, t.id));
    const [shown] = await present([after]);
    return shown;
  });

  /** Delete one, or (scope=following) this one and the later open ones in its series. */
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>("/:id", async (req) => {
    const t = await findTodo(req, req.params.id);
    if (!isManager(req, AREA) && t.createdById !== req.user.sub) throw new HttpError(403, "Only the person who made this to-do or a manager can delete it");
    const rows = req.query.scope === "following" && t.seriesId
      ? await db.delete(todos).where(and(eq(todos.seriesId, t.seriesId), eq(todos.companyId, req.user.companyId), gte(todos.date, t.date), or(isNull(todos.doneAt), eq(todos.id, t.id)))).returning({ id: todos.id })
      : await db.delete(todos).where(eq(todos.id, t.id)).returning({ id: todos.id });
    return { deleted: rows.length };
  });
};

export default routes;

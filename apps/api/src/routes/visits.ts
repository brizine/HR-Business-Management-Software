import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, lte, max, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  INACTIVE_STATUSES, VISIT_STATUS_LABELS, customerName, describeRepeat, formatAddress, formatMoney, formatTodoTime, invoiceTotals, lineAmount,
  visitCompleteSchema, visitDates, visitLineHours, visitNumber, visitSchema, visitSkipSchema, visitTotal, visitUpdateSchema,
  type VisitStatus, type VisitUpdate,
} from "@crewdesk/shared";
import { db } from "../db";
import type { Tx } from "../lib/crm";
import { customers, employees, invoiceLines, invoices, properties, propertyAssignments, serviceTypes, visitAssignees, visitLines, visits } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { addDays, billingSettings } from "../lib/invoices";
import { companyToday } from "../lib/payRates";
import { except, notify } from "../lib/notify";

type Visit = typeof visits.$inferSelect;
/** Customers & billing managers schedule, see and invoice every work order; the crew sees theirs. */
export const canManageVisits = (req: FastifyRequest) => isManager(req, "customers");

export function visitVisibility(req: FastifyRequest): SQL | undefined {
  if (canManageVisits(req)) return undefined;
  return exists(db.select({ x: sql`1` }).from(visitAssignees).where(and(eq(visitAssignees.visitId, visits.id), eq(visitAssignees.employeeId, req.user.sub))));
}

async function nextVisitNumber(tx: Tx, companyId: string) {
  const [{ n }] = await tx.select({ n: max(visits.number) }).from(visits).where(eq(visits.companyId, companyId));
  return (n ?? 1000) + 1;
}

const minutesBetween = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000)) : null);

/** Work orders with their lines, crew, customer, property and invoice, ready to show (prices only for managers). */
export async function presentVisits(req: FastifyRequest, rows: Visit[]) {
  if (!rows.length) return [];
  const showPrices = canManageVisits(req);
  const ids = rows.map((v) => v.id);
  const lines = await db.select().from(visitLines).where(inArray(visitLines.visitId, ids)).orderBy(asc(visitLines.sortOrder));
  const crew = await db.select({ visitId: visitAssignees.visitId, id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(visitAssignees).innerJoin(employees, eq(employees.id, visitAssignees.employeeId)).where(inArray(visitAssignees.visitId, ids)).orderBy(asc(employees.firstName));
  const custIds = [...new Set(rows.map((v) => v.customerId))];
  const propIds = [...new Set(rows.map((v) => v.propertyId).filter((x): x is string => !!x))];
  const invIds = [...new Set(rows.map((v) => v.invoiceId).filter((x): x is string => !!x))];
  const people = [...new Set(rows.flatMap((v) => [v.finishedById, v.createdById]).filter((x): x is string => !!x))];
  const cs = await db.select({ id: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, phone: customers.phone, tagIds: customers.tagIds })
    .from(customers).where(inArray(customers.id, custIds));
  const ps = propIds.length ? await db.select({ id: properties.id, name: properties.name, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip, gateCode: properties.gateCode, pets: properties.pets, accessNotes: properties.accessNotes, lawnSqFt: properties.lawnSqFt, lat: properties.lat, lng: properties.lng })
    .from(properties).where(inArray(properties.id, propIds)) : [];
  const inv = invIds.length ? await db.select({ id: invoices.id, number: invoices.number, status: invoices.status }).from(invoices).where(inArray(invoices.id, invIds)) : [];
  const es = people.length ? await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName }).from(employees).where(inArray(employees.id, people)) : [];
  const name = (id: string | null) => { const e = es.find((x) => x.id === id); return e ? `${e.firstName} ${e.lastName}` : null; };
  return rows.map((v) => {
    const c = cs.find((x) => x.id === v.customerId)!;
    const p = ps.find((x) => x.id === v.propertyId);
    const i = inv.find((x) => x.id === v.invoiceId);
    return {
      ...v,
      totalCents: showPrices ? v.totalCents : null,
      lines: lines.filter((l) => l.visitId === v.id).map((l) => ({ ...l, unitPriceCents: showPrices ? l.unitPriceCents : null, amountCents: showPrices ? l.amountCents : null })),
      assignees: crew.filter((x) => x.visitId === v.id).map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
      customer: { id: c.id, name: customerName(c), phone: c.phone, tagIds: c.tagIds },
      property: p ? { id: p.id, name: p.name, address: formatAddress(p), gateCode: p.gateCode, pets: p.pets, accessNotes: p.accessNotes, lawnSqFt: p.lawnSqFt, lat: p.lat, lng: p.lng } : null,
      invoice: i ? { id: i.id, number: i.number, status: i.status } : null,
      invoiced: v.billing === "invoice" ? !!i && i.status !== "void" : null,
      trackedMinutes: minutesBetween(v.startedAt, v.completedAt),
      finishedBy: name(v.finishedById),
      createdBy: name(v.createdById),
      statusLabel: VISIT_STATUS_LABELS[v.status as VisitStatus] ?? v.status,
    };
  });
}

async function findVisit(req: FastifyRequest, id: string) {
  const [v] = await db.select().from(visits).where(and(eq(visits.id, id), eq(visits.companyId, req.user.companyId), visitVisibility(req)));
  if (!v) notFound("Work order");
  return v;
}
const isCrew = async (visitId: string, employeeId: string) =>
  (await db.select({ x: visitAssignees.visitId }).from(visitAssignees).where(and(eq(visitAssignees.visitId, visitId), eq(visitAssignees.employeeId, employeeId)))).length > 0;
function requireManager(req: FastifyRequest) {
  if (!canManageVisits(req)) throw new HttpError(403, "Scheduling work orders needs Customers & billing access");
}

/** Checks the customer, property, services and crew before saving. */
async function checkInput(companyId: string, body: VisitUpdate) {
  const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, body.customerId), eq(customers.companyId, companyId)));
  if (!c) throw new HttpError(404, "Customer not found");
  const [p] = await db.select({ id: properties.id }).from(properties).innerJoin(propertyAssignments, eq(propertyAssignments.propertyId, properties.id))
    .where(and(eq(properties.id, body.propertyId), eq(properties.companyId, companyId), eq(propertyAssignments.customerId, body.customerId))).limit(1);
  if (!p) throw new HttpError(400, "That property isn't one of this customer's");
  const svc = [...new Set(body.lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
  if (svc.length) {
    const found = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, svc)));
    if (found.length !== svc.length) throw new HttpError(400, "One of those services isn't on the price list");
  }
  const crew = [...new Set(body.assigneeIds)];
  if (crew.length) {
    const found = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, companyId), inArray(employees.id, crew), notInArray(employees.status, INACTIVE_STATUSES)));
    if (found.length !== crew.length) throw new HttpError(400, "One of the people picked isn't on the team");
  }
  return crew;
}

const fields = (b: VisitUpdate) => ({
  title: b.title, customerId: b.customerId, propertyId: b.propertyId, color: b.color, location: b.location ?? null, billing: b.billing,
  startTime: b.startTime ?? null, endTime: b.startTime ? b.endTime ?? null : null, notes: b.notes ?? null,
  budgetedHours: b.budgetedHours ?? (b.lines.length ? visitLineHours(b.lines) || null : null),
  totalCents: visitTotal(b.lines),
});
const lineRows = (visitId: string, b: VisitUpdate) => b.lines.map((l, i) => ({
  visitId, serviceTypeId: l.serviceTypeId ?? null, description: l.description, quantity: l.quantity, budgetedHours: l.budgetedHours ?? null,
  unitPriceCents: l.unitPriceCents, amountCents: lineAmount(l), sortOrder: i,
}));

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
async function whenWhere(v: Visit) {
  const [p] = v.propertyId ? await db.select({ street: properties.street, city: properties.city }).from(properties).where(eq(properties.id, v.propertyId)) : [];
  return [visitNumber(v.number), v.date ? fmtDay(v.date) : "Waitlist", formatTodoTime(v.startTime, v.endTime), p ? [p.street, p.city].filter(Boolean).join(", ") : v.location].filter(Boolean).join(" · ");
}

/**
 * Makes draft invoices for work orders: one per customer and property, with each work order's line
 * items (dated when there are several). Skipped, "don't invoice" and already-invoiced ones are refused.
 */
async function invoiceVisits(req: FastifyRequest, ids: string[]) {
  const { companyId, sub } = req.user;
  const rows = await db.select().from(visits).where(and(eq(visits.companyId, companyId), inArray(visits.id, ids)));
  if (rows.length !== ids.length) notFound("Work order");
  const invIds = rows.map((v) => v.invoiceId).filter((x): x is string => !!x);
  const live = invIds.length ? await db.select({ id: invoices.id }).from(invoices).where(and(inArray(invoices.id, invIds), sql`${invoices.status} <> 'void'`)) : [];
  for (const v of rows) {
    if (v.status === "skipped") throw new HttpError(400, `${visitNumber(v.number)} was skipped, so there's nothing to invoice`);
    if (v.billing !== "invoice") throw new HttpError(400, `${visitNumber(v.number)} is set to "Don't invoice"`);
    if (v.invoiceId && live.some((x) => x.id === v.invoiceId)) throw new HttpError(400, `${visitNumber(v.number)} is already on an invoice`);
  }
  const lines = await db.select({ l: visitLines, account: serviceTypes.incomeAccountCode }).from(visitLines).leftJoin(serviceTypes, eq(serviceTypes.id, visitLines.serviceTypeId))
    .where(inArray(visitLines.visitId, ids)).orderBy(asc(visitLines.sortOrder));
  for (const v of rows) if (!lines.some((x) => x.l.visitId === v.id)) throw new HttpError(400, `${visitNumber(v.number)} has no line items to invoice`);
  const today = await companyToday(companyId);
  const settings = await billingSettings(companyId);
  const groups = new Map<string, Visit[]>();
  for (const v of [...rows].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
    const key = `${v.customerId}:${v.propertyId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return db.transaction(async (tx) => {
    const made: { id: string; visits: number; totalCents: number }[] = [];
    for (const group of groups.values()) {
      const several = group.length > 1;
      const items = group.flatMap((v) => lines.filter((x) => x.l.visitId === v.id).map(({ l, account }) => ({
        serviceTypeId: l.serviceTypeId, description: several && v.date ? `${fmtDay(v.date)}: ${l.description}` : l.description,
        quantity: l.quantity, unitPriceCents: l.unitPriceCents, incomeAccountCode: account ?? "4000",
      })));
      const totals = invoiceTotals(items, "none", 0);
      const [inv] = await tx.insert(invoices).values({
        companyId, customerId: group[0].customerId, propertyId: group[0].propertyId, issueDate: today, dueDate: addDays(today, settings.termsDays),
        notes: `Work order${several ? "s" : ""} ${group.map((v) => visitNumber(v.number)).join(", ")}`, discountKind: "none", discountValue: 0, ...totals, createdById: sub,
      }).returning();
      await tx.insert(invoiceLines).values(items.map((l, i) => ({ ...l, invoiceId: inv.id, amountCents: lineAmount(l), sortOrder: i })));
      await tx.update(visits).set({ invoiceId: inv.id, updatedAt: new Date() }).where(inArray(visits.id, group.map((v) => v.id)));
      made.push({ id: inv.id, visits: group.length, totalCents: totals.totalCents });
    }
    return made;
  });
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: Record<string, string | undefined> }>("/", async (req) => {
    const q = req.query;
    const { companyId, sub: me } = req.user;
    const where: (SQL | undefined)[] = [eq(visits.companyId, companyId), visitVisibility(req)];
    const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    if (q.waitlist === "true") where.push(isNull(visits.date));
    if (day(q.from)) where.push(gte(sql`coalesce(${visits.endDate}, ${visits.date})`, day(q.from)!));
    if (day(q.to)) where.push(lte(visits.date, day(q.to)!));
    if (q.status && ["open", "on_site", "completed", "skipped"].includes(q.status)) where.push(eq(visits.status, q.status));
    if (q.status === "active") where.push(inArray(visits.status, ["open", "on_site"]));
    if (q.customerId) where.push(eq(visits.customerId, q.customerId));
    if (q.propertyId) where.push(eq(visits.propertyId, q.propertyId));
    const who = q.mine === "true" ? me : q.assigneeId;
    if (who === "none") where.push(sql`not exists (select 1 from visit_assignees va where va.visit_id = ${visits.id})`);
    else if (who) where.push(exists(db.select({ x: sql`1` }).from(visitAssignees).where(and(eq(visitAssignees.visitId, visits.id), eq(visitAssignees.employeeId, who)))));
    // Ready to invoice: completed, billed, not on a live invoice.
    if (q.invoiceable === "true") {
      where.push(eq(visits.status, "completed"), eq(visits.billing, "invoice"));
      where.push(or(isNull(visits.invoiceId), sql`exists (select 1 from invoices i where i.id = ${visits.invoiceId} and i.status = 'void')`));
    }
    if (q.q?.trim()) {
      const t = q.q.trim();
      const n = /^(wo-?\s*)?(\d+)$/i.exec(t);
      where.push(or(ilike(visits.title, `%${t}%`), ilike(visits.notes, `%${t}%`), ...(n ? [eq(visits.number, Number(n[2]))] : [])));
    }
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 500);
    const order = q.order === "recent" ? [desc(visits.date), desc(visits.number)] : [sql`${visits.date} nulls first`, sql`${visits.startTime} nulls last`, asc(visits.number)];
    const rows = await db.select().from(visits).where(and(...where)).orderBy(...order).limit(limit + 1);
    return { today: await companyToday(companyId), items: await presentVisits(req, rows.slice(0, limit)), more: rows.length > limit, canManage: canManageVisits(req) };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const v = await findVisit(req, req.params.id);
    const [shown] = await presentVisits(req, [v]);
    const seriesLeft = v.seriesId && v.date
      ? (await db.select({ n: sql<number>`count(*)::int` }).from(visits).where(and(eq(visits.seriesId, v.seriesId), gte(visits.date, v.date), inArray(visits.status, ["open", "on_site"]))))[0].n : 0;
    return { ...shown, seriesLeft, today: await companyToday(req.user.companyId), canManage: canManageVisits(req), isCrew: await isCrew(v.id, req.user.sub) };
  });

  app.post("/", async (req) => {
    requireManager(req);
    const body = parse(visitSchema, req.body);
    const { companyId, sub: me } = req.user;
    const crew = await checkInput(companyId, body);
    const dates: (string | null)[] = body.scheduling === "waitlist" ? [null]
      : body.scheduling === "repeat" ? visitDates(body.date!, body.repeatUnit, body.repeatEvery, body.repeatUntil, body.offMonths) : [body.date!];
    if (!dates.length) throw new HttpError(400, "Every date in that series falls in the off-season");
    const series = dates.length > 1;
    const created = await db.transaction(async (tx) => {
      let number = await nextVisitNumber(tx, companyId);
      const rows: Visit[] = [];
      for (const date of dates) {
        const [v] = await tx.insert(visits).values({
          ...fields(body), companyId, number: number++, date, endDate: !series && body.endDate && body.endDate !== body.date ? body.endDate : null,
          repeatLabel: series ? describeRepeat(body.repeatUnit, body.repeatEvery, body.offMonths) : null, createdById: me,
        }).returning();
        rows.push(v);
      }
      if (series) {
        const seriesId = randomUUID();
        await tx.update(visits).set({ seriesId }).where(inArray(visits.id, rows.map((v) => v.id)));
        for (const v of rows) v.seriesId = seriesId;
      }
      const ls = rows.flatMap((v) => lineRows(v.id, body));
      if (ls.length) await tx.insert(visitLines).values(ls);
      if (crew.length) await tx.insert(visitAssignees).values(rows.flatMap((v) => crew.map((employeeId) => ({ visitId: v.id, employeeId }))));
      return rows;
    });
    const first = created[0];
    notify(companyId, except(crew, me), {
      category: "workorders", title: `New work order: ${first.title}`,
      body: (await whenWhere(first)) + (series ? ` · ${first.repeatLabel?.toLowerCase()}, ${created.length} in all` : ""),
      link: { screen: "workorder", id: first.id },
    });
    const [shown] = await presentVisits(req, [first]);
    return { ...shown, created: created.length };
  });

  /** Edit one, or (applyTo=following) this one and the later open ones in its series. Moving the date moves them all by as many days. */
  app.put<{ Params: { id: string }; Querystring: { applyTo?: string } }>("/:id", async (req) => {
    requireManager(req);
    const v = await findVisit(req, req.params.id);
    const body = parse(visitUpdateSchema, req.body);
    const { companyId, sub: me } = req.user;
    const crew = await checkInput(companyId, body);
    const before = new Set((await db.select({ id: visitAssignees.employeeId }).from(visitAssignees).where(eq(visitAssignees.visitId, v.id))).map((r) => r.id));
    const shift = v.date && body.date ? Math.round((Date.parse(body.date) - Date.parse(v.date)) / 86_400_000) : 0;
    const targets = req.query.applyTo === "following" && v.seriesId && v.date
      ? await db.select().from(visits).where(and(eq(visits.seriesId, v.seriesId), eq(visits.companyId, companyId), gte(visits.date, v.date), or(inArray(visits.status, ["open", "on_site"]), eq(visits.id, v.id))))
      : [v];
    await db.transaction(async (tx) => {
      for (const row of targets) {
        const date = row.id === v.id ? body.date ?? null : row.date ? addDays(row.date, shift) : null;
        const endDate = row.id === v.id ? (body.endDate && body.endDate !== body.date ? body.endDate : null) : row.endDate;
        await tx.update(visits).set({ ...fields(body), date, endDate, updatedAt: new Date() }).where(eq(visits.id, row.id));
        await tx.delete(visitLines).where(eq(visitLines.visitId, row.id));
        const ls = lineRows(row.id, body);
        if (ls.length) await tx.insert(visitLines).values(ls);
        await tx.delete(visitAssignees).where(eq(visitAssignees.visitId, row.id));
        if (crew.length) await tx.insert(visitAssignees).values(crew.map((employeeId) => ({ visitId: row.id, employeeId })));
      }
    });
    const [after] = await db.select().from(visits).where(eq(visits.id, v.id));
    notify(companyId, except(crew.filter((id) => !before.has(id)), me), {
      category: "workorders", title: `New work order: ${after.title}`,
      body: (await whenWhere(after)) + (targets.length > 1 ? ` · and ${targets.length - 1} later` : ""), link: { screen: "workorder", id: after.id },
    });
    const [shown] = await presentVisits(req, [after]);
    return { ...shown, changed: targets.length };
  });

  /** The crew: arrived (on site), finished, or skipped it; or undo that. */
  const crewAction = async (req: FastifyRequest, id: string) => {
    const v = await findVisit(req, id);
    if (!canManageVisits(req) && !(await isCrew(v.id, req.user.sub))) throw new HttpError(403, "Only the crew on this work order or a manager can do that");
    return v;
  };
  const reply = async (req: FastifyRequest, id: string) => (await presentVisits(req, await db.select().from(visits).where(eq(visits.id, id))))[0];

  app.post<{ Params: { id: string } }>("/:id/start", async (req) => {
    const v = await crewAction(req, req.params.id);
    if (v.status !== "open") throw new HttpError(400, `This work order is ${VISIT_STATUS_LABELS[v.status as VisitStatus].toLowerCase()}`);
    await db.update(visits).set({ status: "on_site", startedAt: new Date(), updatedAt: new Date() }).where(eq(visits.id, v.id));
    return reply(req, v.id);
  });
  app.post<{ Params: { id: string } }>("/:id/complete", async (req) => {
    const v = await crewAction(req, req.params.id);
    const { notes } = parse(visitCompleteSchema, req.body ?? {});
    if (v.status === "completed" || v.status === "skipped") throw new HttpError(400, `This work order is already ${VISIT_STATUS_LABELS[v.status as VisitStatus].toLowerCase()}`);
    await db.update(visits).set({ status: "completed", completedAt: new Date(), finishedById: req.user.sub, completionNotes: notes ?? null, updatedAt: new Date() }).where(eq(visits.id, v.id));
    return reply(req, v.id);
  });
  app.post<{ Params: { id: string } }>("/:id/skip", async (req) => {
    const v = await crewAction(req, req.params.id);
    const { reason } = parse(visitSkipSchema, req.body ?? {});
    if (v.status === "completed" || v.status === "skipped") throw new HttpError(400, `This work order is already ${VISIT_STATUS_LABELS[v.status as VisitStatus].toLowerCase()}`);
    await db.update(visits).set({ status: "skipped", skippedAt: new Date(), finishedById: req.user.sub, skipReason: reason, startedAt: null, updatedAt: new Date() }).where(eq(visits.id, v.id));
    return reply(req, v.id);
  });
  app.post<{ Params: { id: string } }>("/:id/reopen", async (req) => {
    const v = await crewAction(req, req.params.id);
    if (v.invoiceId && (await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, v.invoiceId), sql`${invoices.status} <> 'void'`))).length) {
      throw new HttpError(400, "This work order is on an invoice; void the invoice first");
    }
    await db.update(visits).set({ status: "open", startedAt: null, completedAt: null, skippedAt: null, finishedById: null, skipReason: null, updatedAt: new Date() }).where(eq(visits.id, v.id));
    return reply(req, v.id);
  });

  /** A draft invoice from this work order. */
  app.post<{ Params: { id: string } }>("/:id/invoice", async (req) => {
    requireManager(req);
    await findVisit(req, req.params.id);
    const [inv] = await invoiceVisits(req, [req.params.id]);
    return { invoiceId: inv.id, totalCents: inv.totalCents };
  });
  /** Draft invoices for several work orders at once: one per customer and property. */
  app.post("/invoice", async (req) => {
    requireManager(req);
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1, "Pick the work orders to invoice").max(200) }), req.body);
    const made = await invoiceVisits(req, [...new Set(ids)]);
    return { invoices: made, totalCents: made.reduce((s, i) => s + i.totalCents, 0), summary: `${made.length} draft invoice${made.length === 1 ? "" : "s"} for ${formatMoney(made.reduce((s, i) => s + i.totalCents, 0))}` };
  });

  /** Delete one, or (scope=following) this and the later open ones in its series. Invoiced ones stay. */
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>("/:id", async (req) => {
    requireManager(req);
    const v = await findVisit(req, req.params.id);
    const live = sql`exists (select 1 from invoices i where i.id = ${visits.invoiceId} and i.status <> 'void')`;
    if (v.invoiceId && (await db.select({ id: visits.id }).from(visits).where(and(eq(visits.id, v.id), live))).length) throw new HttpError(400, "This work order is on an invoice; void the invoice first");
    const rows = req.query.scope === "following" && v.seriesId && v.date
      ? await db.delete(visits).where(and(eq(visits.seriesId, v.seriesId), eq(visits.companyId, req.user.companyId), gte(visits.date, v.date),
        or(and(inArray(visits.status, ["open", "on_site"]), sql`not ${live}`), eq(visits.id, v.id)))).returning({ id: visits.id })
      : await db.delete(visits).where(eq(visits.id, v.id)).returning({ id: visits.id });
    return { deleted: rows.length };
  });
};

export default routes;

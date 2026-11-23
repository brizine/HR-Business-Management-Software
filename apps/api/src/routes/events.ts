import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, eq, gte, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { FastifyRequest as Req } from "fastify";
import { z } from "zod";
import { holidaysBetween, type CalendarEvent, type HolidayObserve } from "@crewdesk/shared";
import { db } from "../db";
import { assets, companies, customers, employees, holidays, ptoPolicies, ptoRequests, shifts, todos, visits, workOrders } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { localParts } from "../lib/tz";
import { present, todoVisibility } from "./todos";
import { canManageVisits, presentVisits, visitVisibility } from "./visits";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeSchema = z.object({ from: isoDate, to: isoDate }).refine((r) => r.from <= r.to, "The range ends before it starts")
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 120, "Show up to four months at a time");
const moveSchema = z.object({ type: z.enum(["todo", "repair", "visit"]), id: z.string().uuid(), date: isoDate });

const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const REPAIR_LABELS: Record<string, string> = { open: "Open", in_progress: "In progress", waiting_parts: "Waiting on parts", completed: "Completed", cancelled: "Cancelled" };
const name = (e: { firstName: string | null; lastName: string | null } | null) => (e?.firstName ? `${e.firstName} ${e.lastName ?? ""}`.trim() : null);

const base = (over: Partial<CalendarEvent> & Pick<CalendarEvent, "type" | "id" | "title" | "date">): CalendarEvent => ({
  key: `${over.type}:${over.id}`, endDate: null, startTime: null, endTime: null, color: null, status: "open", statusLabel: "Open",
  recurring: false, customer: null, property: null, location: null, people: [], hours: null, notes: null, tagIds: [], href: null,
  amountCents: null, invoiced: null, onSite: false, trackedMinutes: null, serviceIds: [], crew: null, mediaCount: 0,
  canMove: false, canComplete: false, ...over,
});

type ShownVisit = Awaited<ReturnType<typeof presentVisits>>[number];
async function visitEvents(req: Req, rows: ShownVisit[]): Promise<CalendarEvent[]> {
  const manage = canManageVisits(req);
  return rows.map((v) => {
    const crew = v.assignees.some((a) => a.id === req.user.sub);
    const done = v.status === "completed" || v.status === "skipped";
    return base({
      type: "visit", id: v.id, title: v.title, date: v.date ?? "", endDate: v.endDate, startTime: v.startTime, endTime: v.endTime, color: v.color,
      status: done ? "done" : "open", statusLabel: `WO-${v.number} · ${v.statusLabel}`, recurring: !!v.seriesId,
      customer: { id: v.customer.id, name: v.customer.name }, property: v.property ? { id: v.property.id, address: v.property.address } : null, location: v.location,
      people: v.assignees.map((a) => ({ id: a.id, name: `${a.firstName} ${a.lastName}` })), hours: v.budgetedHours, notes: v.notes, tagIds: [...new Set([...(v.customer.tagIds ?? []), ...(v.tagIds ?? [])])],
      href: `/visits/${v.id}`, amountCents: v.billing === "invoice" ? v.totalCents : null, invoiced: v.invoiced, onSite: v.status === "on_site",
      trackedMinutes: v.trackedMinutes, serviceIds: v.lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x), crew: v.crew, mediaCount: v.fileCount,
      canMove: manage && !done, canComplete: !done && (manage || crew),
    });
  });
}

type RepairRow = { wo: typeof workOrders.$inferSelect; assetName: string; person: { firstName: string | null; lastName: string | null } | null };
function repairEvent(req: FastifyRequest, { wo, assetName, person }: RepairRow): CalendarEvent {
  const done = wo.status === "completed" || wo.status === "cancelled";
  return base({
    type: "repair", id: wo.id, title: `#${wo.number} ${wo.title}`, date: wo.dueDate ?? "",
    status: done ? "done" : "open", statusLabel: REPAIR_LABELS[wo.status] ?? wo.status,
    location: assetName, people: wo.assignedToId && person ? [{ id: wo.assignedToId, name: name(person)! }] : [],
    hours: wo.laborHours, notes: wo.description, href: `/work-orders?highlight=${wo.id}`,
    canMove: isManager(req, "fleet"), canComplete: !done && (isManager(req, "fleet") || wo.assignedToId === req.user.sub),
  });
}
const repairSelect = { wo: workOrders, assetName: assets.name, person: { firstName: employees.firstName, lastName: employees.lastName } };

/**
 * The Calendar page's data: work orders, to-dos, repair orders with a due date, time off, holidays and shifts in
 * a date range, all in one shape. Each person sees what they could see on those pages: their own
 * to-dos (managers all), every repair order, their own time off (time-off or schedule managers
 * everyone's), the published shifts (schedule managers drafts too), and the company's holidays.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) => {
    const { from, to } = parse(rangeSchema, req.query);
    const { companyId, sub: me } = req.user;
    const [company] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const tz = company?.tz ?? "America/Chicago";
    const out: CalendarEvent[] = [];

    // To-dos (a multi-day one that started earlier still shows).
    const todoRows = await db.select().from(todos)
      .where(and(eq(todos.companyId, companyId), todoVisibility(req), lte(todos.date, to), gte(sql`coalesce(${todos.endDate}, ${todos.date})`, from)))
      .orderBy(asc(todos.date)).limit(2000);
    const shown = await present(todoRows);
    const custIds = [...new Set(shown.map((t) => t.customerId).filter((x): x is string => !!x))];
    const tags = custIds.length ? await db.select({ id: customers.id, tagIds: customers.tagIds }).from(customers).where(inArray(customers.id, custIds)) : [];
    const todoManager = isManager(req, "todos");
    for (const t of shown) {
      out.push(base({
        type: "todo", id: t.id, title: t.title, date: t.date, endDate: t.endDate, startTime: t.startTime, endTime: t.endTime, color: t.color,
        status: t.doneAt ? "done" : "open", statusLabel: t.doneAt ? "Done" : "Open", recurring: !!t.seriesId,
        customer: t.customer, property: t.property ? { id: t.property.id, address: t.property.address } : null, location: t.location,
        people: t.assignees.map((a) => ({ id: a.id, name: `${a.firstName} ${a.lastName}` })), hours: t.budgetedHours, notes: t.notes,
        tagIds: tags.find((c) => c.id === t.customerId)?.tagIds ?? [], href: `/todos/${t.id}`,
        trackedMinutes: t.trackedMinutes || null, onSite: !!t.startedAt && !t.doneAt, crew: t.crew, mediaCount: t.fileCount,
        canMove: todoManager || t.createdById === me, canComplete: true,
      }));
    }

    // Work orders (customer jobs) in the range.
    const visitRows = await db.select().from(visits)
      .where(and(eq(visits.companyId, companyId), visitVisibility(req), lte(visits.date, to), gte(sql`coalesce(${visits.endDate}, ${visits.date})`, from)))
      .orderBy(asc(visits.date)).limit(3000);
    out.push(...(await visitEvents(req, await presentVisits(req, visitRows))));

    // Repair orders due in the range (cancelled ones are left off).
    const repairs = await db.select(repairSelect).from(workOrders)
      .innerJoin(assets, eq(assets.id, workOrders.assetId)).leftJoin(employees, eq(employees.id, workOrders.assignedToId))
      .where(and(eq(workOrders.companyId, companyId), gte(workOrders.dueDate, from), lte(workOrders.dueDate, to), notInArray(workOrders.status, ["cancelled"])));
    for (const r of repairs) out.push(repairEvent(req, r));

    // Approved time off.
    const seeAllOff = isManager(req, "timeoff") || isManager(req, "schedule");
    const off = await db.select({ r: ptoRequests, policy: ptoPolicies.name, firstName: employees.firstName, lastName: employees.lastName }).from(ptoRequests)
      .innerJoin(employees, eq(employees.id, ptoRequests.employeeId)).innerJoin(ptoPolicies, eq(ptoPolicies.id, ptoRequests.policyId))
      .where(and(eq(employees.companyId, companyId), eq(ptoRequests.status, "approved"), lte(ptoRequests.startDate, to), gte(ptoRequests.endDate, from),
        ...(seeAllOff ? [] : [eq(ptoRequests.employeeId, me)])));
    for (const { r, policy, firstName, lastName } of off) {
      const who = `${firstName} ${lastName}`;
      out.push(base({
        type: "timeoff", id: r.id, title: r.employeeId === me ? `Time off (${policy})` : `${who} off`, date: r.startDate,
        endDate: r.endDate !== r.startDate ? r.endDate : null, statusLabel: "Approved", people: [{ id: r.employeeId, name: who }], hours: r.hours, href: "/time-off",
      }));
    }

    // The company's paid holidays (on the day they're observed).
    const hols = await db.select().from(holidays).where(eq(holidays.companyId, companyId));
    for (const h of holidaysBetween(hols.map((x) => ({ ...x, observe: x.observe as HolidayObserve })), from, to)) {
      out.push(base({ type: "holiday", id: `${h.holiday.id}-${h.observed}`, title: h.holiday.name, date: h.observed, statusLabel: "Holiday", hours: h.holiday.hours, href: "/schedule" }));
    }

    // Shifts, by their local start date (published ones; schedule managers also see drafts).
    const shiftRows = await db.select({ s: shifts, firstName: employees.firstName, lastName: employees.lastName }).from(shifts)
      .leftJoin(employees, eq(employees.id, shifts.employeeId))
      .where(and(eq(shifts.companyId, companyId), gte(shifts.startsAt, new Date(Date.parse(`${plusDays(from, -1)}T00:00:00Z`))), lt(shifts.startsAt, new Date(Date.parse(`${plusDays(to, 2)}T00:00:00Z`))),
        ...(isManager(req, "schedule") ? [] : [eq(shifts.status, "published")])))
      .orderBy(asc(shifts.startsAt)).limit(3000);
    for (const { s, firstName, lastName } of shiftRows) {
      const start = localParts(s.startsAt, tz);
      if (start.date < from || start.date > to) continue;
      const end = localParts(s.endsAt, tz);
      const who = firstName ? `${firstName} ${lastName}` : null;
      out.push(base({
        type: "shift", id: s.id, title: [who ?? "Open shift", s.position].filter(Boolean).join(" · "), date: start.date,
        startTime: hhmm(start.minutes), endTime: hhmm(end.minutes), statusLabel: s.status === "draft" ? "Draft" : "Published",
        location: s.location, people: s.employeeId && who ? [{ id: s.employeeId, name: who }] : [],
        hours: Math.round(((s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000) * 100) / 100, notes: s.notes, href: "/schedule",
      }));
    }

    return { from, to, today: localParts(new Date(), tz).date, events: out };
  });

  /** The calendar's waitlist: work orders with no date, and open repair orders with no due date (drag one onto a day). */
  app.get("/unscheduled", async (req) => {
    const waiting = await db.select().from(visits)
      .where(and(eq(visits.companyId, req.user.companyId), visitVisibility(req), isNull(visits.date), inArray(visits.status, ["open", "on_site"])))
      .orderBy(asc(visits.number)).limit(200);
    const rows = await db.select(repairSelect).from(workOrders)
      .innerJoin(assets, eq(assets.id, workOrders.assetId)).leftJoin(employees, eq(employees.id, workOrders.assignedToId))
      .where(and(eq(workOrders.companyId, req.user.companyId), isNull(workOrders.dueDate), notInArray(workOrders.status, ["completed", "cancelled"])))
      .orderBy(asc(workOrders.createdAt)).limit(200);
    return [...(await visitEvents(req, await presentVisits(req, waiting))), ...rows.map((r) => repairEvent(req, r))];
  });

  /** Drag and drop: a to-do (keeping how many days it runs) or a repair order to another day. */
  app.post("/move", async (req) => {
    const { type, id, date } = parse(moveSchema, req.body);
    const { companyId, sub: me } = req.user;
    if (type === "todo") {
      const [t] = await db.select().from(todos).where(and(eq(todos.id, id), eq(todos.companyId, companyId), todoVisibility(req)));
      if (!t) notFound("To-do");
      if (!isManager(req, "todos") && t.createdById !== me) throw new HttpError(403, "Only the person who made this to-do or a manager can move it");
      const span = t.endDate ? Math.round((Date.parse(t.endDate) - Date.parse(t.date)) / 86_400_000) : 0;
      await db.update(todos).set({ date, endDate: span ? plusDays(date, span) : null, updatedAt: new Date() }).where(eq(todos.id, t.id));
    } else if (type === "visit") {
      if (!canManageVisits(req)) throw new HttpError(403, "Scheduling work orders needs Customers & billing access");
      const [v] = await db.select().from(visits).where(and(eq(visits.id, id), eq(visits.companyId, companyId)));
      if (!v) notFound("Work order");
      if (v.status === "completed" || v.status === "skipped") throw new HttpError(400, "That work order is finished; reopen it to move it");
      const span = v.date && v.endDate ? Math.round((Date.parse(v.endDate) - Date.parse(v.date)) / 86_400_000) : 0;
      await db.update(visits).set({ date, endDate: span ? plusDays(date, span) : null, updatedAt: new Date() }).where(eq(visits.id, v.id));
    } else {
      if (!isManager(req, "fleet")) throw new HttpError(403, "Only fleet managers can reschedule repair orders");
      const [wo] = await db.update(workOrders).set({ dueDate: date }).where(and(eq(workOrders.id, id), eq(workOrders.companyId, companyId))).returning({ id: workOrders.id });
      if (!wo) notFound("Repair order");
    }
    return { ok: true, date };
  });
};

export default routes;

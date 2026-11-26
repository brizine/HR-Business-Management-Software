import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import {
  customerName, eligibleFrom, formatAddress, historyMinutes, holidaysBetween, sizeMinutes, waitBadges,
  type NotifyBefore, type Priority, type WaitBadge,
} from "@crewdesk/shared";
import { db } from "../db";
import { crews, customerPaymentMethods, customers, dispatchRoutes, holidays, properties, serviceTypes, visitLines, visits } from "../db/schema";
import { billingSettings } from "./invoices";
import { companyToday } from "./payRates";

/**
 * The waiting list (Crewdesk plan): open work orders with no date yet, each with its window
 * (eligible from, due by), what it needs (card on file), how long it should take, and badges.
 */

export type EstSource = "set" | "history" | "size" | "none";

/** Estimated minutes for work orders: the work order's own hours (locked), else the property's history, else lawn size × the service rate. */
export async function estimateMinutes(rows: { id: string; propertyId: string | null; budgetedHours: number | null }[]) {
  const out = new Map<string, { minutes: number | null; source: EstSource; used: number; leftOut: number }>();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const lines = await db.select({ visitId: visitLines.visitId, serviceTypeId: visitLines.serviceTypeId, sortOrder: visitLines.sortOrder }).from(visitLines).where(inArray(visitLines.visitId, ids));
  const typeIds = [...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
  const rates = new Map((typeIds.length ? await db.select({ id: serviceTypes.id, setupMinutes: serviceTypes.setupMinutes, minutesPer1000: serviceTypes.minutesPer1000 }).from(serviceTypes).where(inArray(serviceTypes.id, typeIds)) : []).map((r) => [r.id, r]));
  const propIds = [...new Set(rows.map((r) => r.propertyId).filter((x): x is string => !!x))];
  const sizes = new Map((propIds.length ? await db.select({ id: properties.id, sqFt: properties.lawnSqFt }).from(properties).where(inArray(properties.id, propIds)) : []).map((p) => [p.id, p.sqFt]));
  // The property's past visits of the same main service, Start to Complete (newest first).
  const past = !propIds.length ? [] : await db.select({ propertyId: visits.propertyId, startedAt: visits.startedAt, completedAt: visits.completedAt, serviceTypeId: sql<string | null>`(select l.service_type_id from visit_lines l where l.visit_id = "visits"."id" order by l.sort_order limit 1)` })
    .from(visits).where(and(inArray(visits.propertyId, propIds), eq(visits.status, "completed"), isNotNull(visits.startedAt), isNotNull(visits.completedAt), gte(visits.completedAt, new Date(Date.now() - 2 * 365 * 86_400_000))))
    .orderBy(desc(visits.completedAt)).limit(20_000);
  const byLine = new Map<string, typeof lines>();
  for (const l of lines) byLine.set(l.visitId, [...(byLine.get(l.visitId) ?? []), l]);
  for (const r of rows) {
    if (r.budgetedHours != null && r.budgetedHours > 0) { out.set(r.id, { minutes: Math.round(r.budgetedHours * 60), source: "set", used: 0, leftOut: 0 }); continue; }
    const ls = (byLine.get(r.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
    const sqFt = r.propertyId ? sizes.get(r.propertyId) ?? null : null;
    const sizeParts = ls.map((l) => (l.serviceTypeId && rates.get(l.serviceTypeId) ? sizeMinutes(rates.get(l.serviceTypeId)!, sqFt) : null)).filter((m): m is number => m != null);
    const size = sizeParts.length ? sizeParts.reduce((a, b) => a + b, 0) : null;
    const main = ls.find((l) => l.serviceTypeId)?.serviceTypeId ?? null;
    const durations = main ? past.filter((p) => p.propertyId === r.propertyId && p.serviceTypeId === main).map((p) => (p.completedAt!.getTime() - p.startedAt!.getTime()) / 60_000) : [];
    const h = historyMinutes(durations, size);
    if (h.minutes != null) out.set(r.id, { minutes: h.minutes, source: "history", used: h.used, leftOut: h.leftOut });
    else out.set(r.id, { minutes: size, source: size != null ? "size" : "none", used: 0, leftOut: 0 });
  }
  return out;
}

/** Customers with a usable card or bank account on file (cards not expired). */
export async function customersWithCard(customerIds: string[], today: string) {
  if (!customerIds.length) return new Set<string>();
  const [y, m] = today.split("-").map(Number);
  const rows = await db.select({ customerId: customerPaymentMethods.customerId, type: customerPaymentMethods.type, expMonth: customerPaymentMethods.expMonth, expYear: customerPaymentMethods.expYear })
    .from(customerPaymentMethods).where(inArray(customerPaymentMethods.customerId, customerIds));
  return new Set(rows.filter((r) => r.type !== "card" || !r.expYear || r.expYear > y || (r.expYear === y && (r.expMonth ?? 12) >= m)).map((r) => r.customerId));
}

export type WaitRow = {
  id: string; number: number; title: string; status: string; date: string | null; priority: Priority; releaseOn: string | null; dueBy: string | null; minDaysAfterLast: number | null;
  eligible: string | null; lastServiceOn: string | null; waitingDays: number; windowStart: string | null; windowEnd: string | null; backReason: string | null;
  estMinutes: number | null; estSource: EstSource; estUsed: number; estLeftOut: number; totalCents: number; crewId: string | null; preferredCrewId: string | null;
  service: { id: string | null; name: string }; serviceTypeIds: string[]; tagIds: string[];
  customer: { id: string; name: string; notifyBefore: NotifyBefore; tagIds: string[] };
  property: { id: string; address: string; street: string; city: string | null; zip: string | null; lat: number | null; lng: number | null; mapCode: string | null; sqFt: number | null; pets: string | null; tagIds: string[] };
  needsCard: boolean; badges: WaitBadge[];
};

/** The waiting list (open work orders with no date): released ones, or all with `upcoming`. Also any open work orders by id (for Edit work orders). */
export async function waitingList(companyId: string, o: { upcoming?: boolean; ids?: string[] } = {}): Promise<{ today: string; requireCard: boolean; rows: WaitRow[] }> {
  const today = await companyToday(companyId);
  const settings = await billingSettings(companyId);
  const requireCard = !!settings.requireCardOnFile;
  const where = o.ids
    ? and(eq(visits.companyId, companyId), inArray(visits.id, o.ids))
    : and(eq(visits.companyId, companyId), isNull(visits.date), eq(visits.status, "open"), o.upcoming ? undefined : sql`(${visits.releaseOn} is null or ${visits.releaseOn} <= ${today})`);
  const rows = await db.select({ v: visits, p: properties, c: customers }).from(visits)
    .innerJoin(properties, eq(properties.id, visits.propertyId)).innerJoin(customers, eq(customers.id, visits.customerId))
    .where(where).limit(5000);
  if (!rows.length) return { today, requireCard, rows: [] };
  const ids = rows.map((r) => r.v.id);
  const lines = await db.select({ visitId: visitLines.visitId, serviceTypeId: visitLines.serviceTypeId, description: visitLines.description, sortOrder: visitLines.sortOrder, name: serviceTypes.name })
    .from(visitLines).leftJoin(serviceTypes, eq(serviceTypes.id, visitLines.serviceTypeId)).where(inArray(visitLines.visitId, ids));
  const propIds = [...new Set(rows.map((r) => r.p.id))];
  const last = new Map((await db.select({ propertyId: visits.propertyId, on: sql<string>`max(coalesce(${visits.date}, (${visits.completedAt} at time zone 'UTC')::date))::text` })
    .from(visits).where(and(inArray(visits.propertyId, propIds), eq(visits.status, "completed"))).groupBy(visits.propertyId)).map((r) => [r.propertyId, r.on]));
  const est = await estimateMinutes(rows.map((r) => ({ id: r.v.id, propertyId: r.v.propertyId, budgetedHours: r.v.budgetedHours })));
  const carded = requireCard ? await customersWithCard([...new Set(rows.map((r) => r.c.id))], today) : new Set<string>();
  const now = Date.now();
  return {
    today, requireCard,
    rows: rows.map(({ v, p, c }) => {
      const ls = lines.filter((l) => l.visitId === v.id).sort((a, b) => a.sortOrder - b.sortOrder);
      const main = ls.find((l) => l.serviceTypeId) ?? ls[0];
      const lastOn = last.get(p.id) ?? null;
      const eligible = eligibleFrom({ releaseOn: v.releaseOn, minDaysAfterLast: v.minDaysAfterLast, lastServiceOn: lastOn });
      const notify = ((p.notifyBefore ?? c.notifyBefore) || "none") as NotifyBefore;
      const needsCard = requireCard && !c.cardExemptAt && !p.cardExemptAt && !carded.has(c.id);
      const e = est.get(v.id)!;
      return {
        id: v.id, number: v.number, title: v.title, status: v.status, date: v.date, priority: (v.priority || "normal") as Priority, releaseOn: v.releaseOn, dueBy: v.dueBy, minDaysAfterLast: v.minDaysAfterLast,
        eligible, lastServiceOn: lastOn, waitingDays: Math.max(0, Math.floor((now - (v.waitingSince ?? v.createdAt).getTime()) / 86_400_000)),
        windowStart: v.windowStart, windowEnd: v.windowEnd, backReason: v.backReason, estMinutes: e.minutes, estSource: e.source, estUsed: e.used, estLeftOut: e.leftOut, totalCents: v.totalCents ?? 0,
        crewId: v.crewId, preferredCrewId: p.preferredCrewId,
        service: { id: main?.serviceTypeId ?? null, name: main?.name ?? main?.description ?? v.title }, serviceTypeIds: [...new Set(ls.map((l) => l.serviceTypeId).filter((x): x is string => !!x))], tagIds: v.tagIds,
        customer: { id: c.id, name: customerName(c), notifyBefore: (c.notifyBefore || "none") as NotifyBefore, tagIds: c.tagIds },
        property: { id: p.id, address: formatAddress(p), street: p.street, city: p.city, zip: p.zip, lat: p.lat, lng: p.lng, mapCode: p.mapCode, sqFt: p.lawnSqFt, pets: p.pets, tagIds: p.tagIds },
        needsCard, badges: waitBadges({ today, dueBy: v.dueBy, eligible, needsCard, pets: p.pets, notify, priority: (v.priority || "normal") as Priority }),
      };
    }),
  };
}

/** Hours booked per crew per day (and with no crew) for the days given, against each crew's daily hours. */
export async function workload(companyId: string, from: string, days: number) {
  const to = new Date(Date.parse(`${from}T12:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const crewRows = await db.select({ id: crews.id, name: crews.name, color: crews.color, dailyHours: crews.dailyHours }).from(crews).where(and(eq(crews.companyId, companyId), eq(crews.active, true))).orderBy(crews.name);
  const booked = await db.select({ id: visits.id, date: visits.date, crewId: visits.crewId, propertyId: visits.propertyId, budgetedHours: visits.budgetedHours }).from(visits)
    .where(and(eq(visits.companyId, companyId), gte(visits.date, from), lte(visits.date, to), ne(visits.status, "skipped")));
  const est = await estimateMinutes(booked.map((b) => ({ id: b.id, propertyId: b.propertyId, budgetedHours: b.budgetedHours })));
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  // The drive on each crew's route that day (from the shop, between stops and back).
  const drives = await db.select({ date: dispatchRoutes.date, crewId: dispatchRoutes.crewId, seconds: dispatchRoutes.totalDriveSeconds }).from(dispatchRoutes)
    .where(and(eq(dispatchRoutes.companyId, companyId), gte(dispatchRoutes.date, from), lte(dispatchRoutes.date, to), isNotNull(dispatchRoutes.crewId)));
  const cell = (crewId: string | null, d: string) => {
    const vs = booked.filter((b) => b.date === d && (b.crewId ?? null) === crewId);
    const drive = crewId ? drives.filter((r) => r.date === d && r.crewId === crewId).reduce((s, r) => s + (r.seconds ?? 0), 0) / 3600 : 0;
    // hours: on site. drive: on the road. A crew's day is the two together.
    return { count: vs.length, hours: Math.round((vs.reduce((s, b) => s + (est.get(b.id)?.minutes ?? 0), 0) / 60) * 10) / 10, drive: Math.round(drive * 10) / 10 };
  };
  const hol = holidaysBetween((await db.select().from(holidays).where(eq(holidays.companyId, companyId))).map((h) => ({ ...h, observe: h.observe as "none" | "nearest" })), from, to);
  return {
    dates,
    holidays: Object.fromEntries(hol.map((h) => [h.date, h.holiday.name])),
    crews: [
      ...crewRows.map((c) => ({ id: c.id, name: c.name, color: c.color, dailyHours: c.dailyHours, days: dates.map((d) => cell(c.id, d)) })),
      { id: null, name: "No crew yet", color: "#94a3b8", dailyHours: null, days: dates.map((d) => cell(null, d)) },
    ],
  };
}

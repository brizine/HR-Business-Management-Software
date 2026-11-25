import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { customerName } from "@crewdesk/shared";
import { db } from "../db";
import { assets, crews, customers, employees, properties, serviceTypes, visitAssignees, visitLines, visits } from "../db/schema";
import { serviceProductLines } from "./productCosts";

/**
 * The load sheet: what each tech or truck needs on board for a day's chemical work orders, from
 * the services' products and rates (Chemical Tracking) and each lawn's size. Planned amounts only;
 * what was actually applied is on the records.
 */
export type LoadBy = "tech" | "truck";

interface Item { productId: string; product: string; unit: string; amount: number; method: string | null; sprayGal: number | null }
interface Stop {
  visitId: string; number: number; time: string | null; status: string; customer: string; address: string;
  sqFt: number | null; items: Item[];
}
interface Group {
  key: string; label: string; stops: Stop[];
  /** Per product and method: concentrate and the spray it makes. */
  totals: { productId: string; product: string; unit: string; method: string | null; amount: number; sprayGal: number | null; stops: number }[];
  /** Spray to mix for each method (water and product together). */
  spray: { method: string; gal: number }[];
  missingSize: number;
}

export async function loadSheet(companyId: string, date: string, by: LoadBy) {
  const vs = await db.select({
    id: visits.id, number: visits.number, time: visits.startTime, status: visits.status, crewId: visits.crewId, propertyId: visits.propertyId,
    c: { kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName },
    street: properties.street, city: properties.city, lawnSqFt: properties.lawnSqFt,
  }).from(visits).innerJoin(customers, eq(customers.id, visits.customerId)).leftJoin(properties, eq(properties.id, visits.propertyId))
    .where(and(eq(visits.companyId, companyId), eq(visits.date, date), ne(visits.status, "skipped")))
    .orderBy(asc(visits.startTime), asc(visits.number));
  if (!vs.length) return { date, by, groups: [] as Group[] };
  const ids = vs.map((v) => v.id);
  const lines = await db.select({ visitId: visitLines.visitId, serviceTypeId: visitLines.serviceTypeId, quantity: visitLines.quantity, chemical: serviceTypes.chemical })
    .from(visitLines).leftJoin(serviceTypes, eq(serviceTypes.id, visitLines.serviceTypeId)).where(inArray(visitLines.visitId, ids)).orderBy(asc(visitLines.sortOrder));
  const byService = await serviceProductLines([...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))], date);
  const people = await db.select({ visitId: visitAssignees.visitId, id: employees.id, first: employees.firstName, last: employees.lastName })
    .from(visitAssignees).innerJoin(employees, eq(employees.id, visitAssignees.employeeId)).where(inArray(visitAssignees.visitId, ids));
  const crewIds = [...new Set(vs.map((v) => v.crewId).filter((x): x is string => !!x))];
  const crewRows = crewIds.length ? await db.select({ id: crews.id, name: crews.name, assetId: crews.assetId }).from(crews).where(inArray(crews.id, crewIds)) : [];
  const trucks = await db.select({ id: assets.id, name: assets.name, employeeId: assets.assignedEmployeeId }).from(assets).where(and(eq(assets.companyId, companyId), ne(assets.status, "retired")));

  const groups = new Map<string, Group>();
  for (const v of vs) {
    const vl = lines.filter((l) => l.visitId === v.id);
    const sqFtOf = (q: number) => (v.lawnSqFt ? v.lawnSqFt * (q || 1) : null);
    const items: Item[] = vl.flatMap((l) => (l.serviceTypeId ? byService.get(l.serviceTypeId) ?? [] : []).filter((p) => p.applies).map((p) => {
      const sq = sqFtOf(l.quantity);
      return {
        productId: p.productId, product: p.productName, unit: p.unit, method: p.applicationMethodName ?? null,
        amount: sq == null ? 0 : (p.amountPer1000 * sq) / 1000,
        sprayGal: sq == null || p.carrierGalPer1000 == null ? null : (p.carrierGalPer1000 * sq) / 1000,
      };
    }));
    if (!items.length && !vl.some((l) => l.chemical)) continue;
    const who = people.filter((p) => p.visitId === v.id).sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`));
    let key: string, label: string;
    if (by === "tech") {
      key = who.map((w) => w.id).join("+") || "none";
      label = who.map((w) => `${w.first} ${w.last}`.trim()).join(" & ") || "Not assigned";
    } else {
      const crew = crewRows.find((c) => c.id === v.crewId);
      const truck = trucks.find((t) => t.id === crew?.assetId) ?? trucks.find((t) => t.employeeId && who.some((w) => w.id === t.employeeId));
      key = truck?.id ?? "none";
      label = truck?.name ?? "No truck";
    }
    const g = groups.get(key) ?? { key, label, stops: [], totals: [], spray: [], missingSize: 0 };
    g.stops.push({
      visitId: v.id, number: v.number, time: v.time, status: v.status, customer: customerName(v.c),
      address: [v.street, v.city].filter(Boolean).join(", "), sqFt: v.lawnSqFt ? vl.reduce((s, l) => s + (sqFtOf(l.quantity) ?? 0), 0) || v.lawnSqFt : null, items,
    });
    if (!v.lawnSqFt) g.missingSize++;
    for (const it of items) {
      const t = g.totals.find((x) => x.productId === it.productId && x.method === it.method && x.unit === it.unit);
      if (t) { t.amount += it.amount; t.sprayGal = t.sprayGal == null && it.sprayGal == null ? null : (t.sprayGal ?? 0) + (it.sprayGal ?? 0); t.stops++; }
      else g.totals.push({ productId: it.productId, product: it.product, unit: it.unit, method: it.method, amount: it.amount, sprayGal: it.sprayGal, stops: 1 });
    }
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.totals.sort((a, b) => (a.method ?? "~").localeCompare(b.method ?? "~") || a.product.localeCompare(b.product));
    // Spray per method: each stop's largest spray volume for that method (products share one tank mix).
    const spray = new Map<string, number>();
    for (const s of g.stops) {
      const per = new Map<string, number>();
      for (const it of s.items) if (it.method && it.sprayGal != null) per.set(it.method, Math.max(per.get(it.method) ?? 0, it.sprayGal));
      for (const [m, gal] of per) spray.set(m, (spray.get(m) ?? 0) + gal);
    }
    g.spray = [...spray].map(([method, gal]) => ({ method, gal })).sort((a, b) => a.method.localeCompare(b.method));
  }
  const out = [...groups.values()].sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.label.localeCompare(b.label)));
  return { date, by, groups: out };
}

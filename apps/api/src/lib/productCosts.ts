import { asc, eq, inArray } from "drizzle-orm";
import { appliesOn, costOn, costPerUseUnitCents } from "@crewdesk/shared";
import { db } from "../db";
import { productCosts, productRates, products, properties, serviceProducts, visitLines, visitProducts, visits } from "../db/schema";
import { companyToday } from "./payRates";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { companyToday };

type LinkRow = Awaited<ReturnType<typeof load>>[number];
export type ServiceProductLine = LinkRow & { costId: string | null; costPerUseUnitCents: number | null; costPer1000Cents: number | null; applies: boolean };

/** Each service's product links, with rate, unit and the cost per use unit in force on `day`. */
export async function serviceProductLines(serviceIds: string[], day: string, run: Db | Tx = db) {
  const out = new Map<string, ServiceProductLine[]>();
  if (!serviceIds.length) return out;
  const rows = await load(serviceIds, run);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const costs = productIds.length ? await run.select().from(productCosts).where(inArray(productCosts.productId, productIds)) : [];
  for (const r of rows) {
    const cost = costOn(costs.filter((c) => c.productId === r.productId), day);
    const perUse = costPerUseUnitCents(cost?.costPerPurchaseUnitCents, r.purchaseUnitSize);
    const line: ServiceProductLine = { ...r, costId: cost?.id ?? null, costPerUseUnitCents: perUse, costPer1000Cents: perUse == null ? null : perUse * r.amountPer1000, applies: appliesOn(r, day) };
    out.set(r.serviceTypeId, [...(out.get(r.serviceTypeId) ?? []), line]);
  }
  return out;
}

function load(serviceIds: string[], run: Db | Tx) {
  return run
    .select({
      id: serviceProducts.id, serviceTypeId: serviceProducts.serviceTypeId, productId: serviceProducts.productId, productRateId: serviceProducts.productRateId,
      startDate: serviceProducts.startDate, endDate: serviceProducts.endDate,
      productName: products.name, epaRegNo: products.epaRegNo, unit: products.useUnit, purchaseUnitSize: products.purchaseUnitSize, trackRecords: products.trackRecords,
      rateName: productRates.name, amountPer1000: productRates.amountPer1000,
    })
    .from(serviceProducts)
    .innerJoin(products, eq(products.id, serviceProducts.productId))
    .innerJoin(productRates, eq(productRates.id, serviceProducts.productRateId))
    .where(inArray(serviceProducts.serviceTypeId, serviceIds))
    .orderBy(asc(serviceProducts.sortOrder));
}

/**
 * Material per 1,000 sq ft of each service on `day`: the sum of its products that apply that day.
 * Null with no products; `materialMissingCost` counts products that apply but have no cost.
 */
export function materialSummary(lines: { applies: boolean; costPer1000Cents: number | null }[] | undefined) {
  const applying = (lines ?? []).filter((l) => l.applies);
  if (!applying.length) return { materialPer1000Cents: null, materialMissingCost: 0 };
  return {
    materialPer1000Cents: applying.reduce((s, l) => s + (l.costPer1000Cents ?? 0), 0),
    materialMissingCost: applying.filter((l) => l.costPer1000Cents == null).length,
  };
}

/**
 * Saves what a completed visit applied: each line's service products that apply on the visit's day,
 * × the property's lawn size × the line's quantity, at the cost in force that day. Replaces any rows
 * saved before (a reopened visit completed again). Lines without a lawn size save nothing.
 */
export async function snapshotVisitProducts(tx: Tx, visitId: string, companyId: string) {
  const [v] = await tx.select({ id: visits.id, date: visits.date, propertyId: visits.propertyId }).from(visits).where(eq(visits.id, visitId));
  await tx.delete(visitProducts).where(eq(visitProducts.visitId, visitId));
  if (!v) return 0;
  const day = v.date ?? (await companyToday(companyId));
  const [prop] = v.propertyId ? await tx.select({ lawnSqFt: properties.lawnSqFt }).from(properties).where(eq(properties.id, v.propertyId)) : [];
  const area = prop?.lawnSqFt ?? null;
  if (!area || area <= 0) return 0;
  const lines = await tx.select({ serviceTypeId: visitLines.serviceTypeId, quantity: visitLines.quantity }).from(visitLines).where(eq(visitLines.visitId, visitId)).orderBy(asc(visitLines.sortOrder));
  const serviceIds = [...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
  const byService = await serviceProductLines(serviceIds, day, tx);
  const rows = lines.flatMap((l, li) => (l.serviceTypeId ? byService.get(l.serviceTypeId) ?? [] : []).filter((p) => p.applies).map((p, pi) => {
    const sqFt = area * (l.quantity || 1);
    const amount = (p.amountPer1000 * sqFt) / 1000;
    return {
      companyId, visitId, serviceTypeId: l.serviceTypeId, productId: p.productId, productRateId: p.productRateId, productCostId: p.costId,
      productName: p.productName, epaRegNo: p.epaRegNo, rateName: p.rateName, amountPer1000: p.amountPer1000, areaSqFt: sqFt, amount, unit: p.unit,
      costPerUseUnitCents: p.costPerUseUnitCents, costCents: p.costPerUseUnitCents == null ? null : Math.round(amount * p.costPerUseUnitCents), costDate: day, sortOrder: li * 100 + pi,
    };
  }));
  if (rows.length) await tx.insert(visitProducts).values(rows);
  return rows.length;
}

/** A visit's saved products (what it applied and what that cost on its day). */
export function visitProductRows(visitId: string) {
  return db.select().from(visitProducts).where(eq(visitProducts.visitId, visitId)).orderBy(asc(visitProducts.sortOrder));
}

import { asc, eq, inArray } from "drizzle-orm";
import { APPLICATION_METHOD_LABELS, appliesOn, costOn, costPerUseUnitCents, type ApplicationMethod } from "@crewdesk/shared";
import { db } from "../db";
import { applicationMethods, chemicalMixItems, chemicalMixes, productCosts, productRates, products, properties, serviceMixes, serviceProducts, visitLines, visitProducts, visits } from "../db/schema";
import { companyToday } from "./payRates";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { companyToday };

type ProductLink = Awaited<ReturnType<typeof load>>[number];
/** A service's product line: a single product at one of its rates, or one product of a mix at the mix's rate. */
type LinkRow = Omit<ProductLink, "productRateId"> & { productRateId: string | null; mixId: string | null; mixName: string | null; serviceMixId: string | null };
export type ServiceProductLine = LinkRow & { costId: string | null; costPerUseUnitCents: number | null; costPer1000Cents: number | null; applies: boolean };

/** Each service's product links, with rate, unit and the cost per use unit in force on `day`. */
export async function serviceProductLines(serviceIds: string[], day: string, run: Db | Tx = db) {
  const out = new Map<string, ServiceProductLine[]>();
  if (!serviceIds.length) return out;
  const rows: LinkRow[] = [
    ...(await load(serviceIds, run)).map((r) => ({ ...r, mixId: null, mixName: null, serviceMixId: null })),
    ...(await loadMixes(serviceIds, run)),
  ];
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

/** A service's mixes, one line per product in each mix (at the mix's rate, applied the mix's way). Always read live. */
async function loadMixes(serviceIds: string[], run: Db | Tx): Promise<LinkRow[]> {
  const rows = await run.select({
    sm: serviceMixes, mixName: chemicalMixes.name, methodId: chemicalMixes.applicationMethodId, methodName: applicationMethods.name, gal: applicationMethods.galPer1000,
    item: chemicalMixItems, p: { name: products.name, epaRegNo: products.epaRegNo, unit: products.useUnit, purchaseUnitSize: products.purchaseUnitSize, trackRecords: products.trackRecords },
  }).from(serviceMixes)
    .innerJoin(chemicalMixes, eq(chemicalMixes.id, serviceMixes.mixId))
    .innerJoin(chemicalMixItems, eq(chemicalMixItems.mixId, chemicalMixes.id))
    .innerJoin(products, eq(products.id, chemicalMixItems.productId))
    .leftJoin(applicationMethods, eq(applicationMethods.id, chemicalMixes.applicationMethodId))
    .where(inArray(serviceMixes.serviceTypeId, serviceIds))
    .orderBy(asc(serviceMixes.sortOrder), asc(chemicalMixItems.sortOrder));
  return rows.map((r) => ({
    id: `${r.sm.id}:${r.item.productId}`, serviceTypeId: r.sm.serviceTypeId, productId: r.item.productId, productRateId: null,
    startDate: r.sm.startDate, endDate: r.sm.endDate,
    productName: r.p.name, epaRegNo: r.p.epaRegNo, unit: r.p.unit, purchaseUnitSize: r.p.purchaseUnitSize, trackRecords: r.p.trackRecords,
    rateName: r.mixName, amountPer1000: r.item.ratePer1000, carrierGalPer1000: r.gal ?? null, method: r.gal == null ? "push_spreader" : "truck_spray",
    applicationMethodId: r.methodId, applicationMethodName: r.methodName,
    mixId: r.sm.mixId, mixName: r.mixName, serviceMixId: r.sm.id,
  }));
}

function load(serviceIds: string[], run: Db | Tx) {
  return run
    .select({
      id: serviceProducts.id, serviceTypeId: serviceProducts.serviceTypeId, productId: serviceProducts.productId, productRateId: serviceProducts.productRateId,
      startDate: serviceProducts.startDate, endDate: serviceProducts.endDate,
      productName: products.name, epaRegNo: products.epaRegNo, unit: products.useUnit, purchaseUnitSize: products.purchaseUnitSize, trackRecords: products.trackRecords,
      rateName: productRates.name, amountPer1000: productRates.amountPer1000, carrierGalPer1000: productRates.carrierGalPer1000, method: productRates.method,
      applicationMethodId: productRates.applicationMethodId, applicationMethodName: applicationMethods.name,
    })
    .from(serviceProducts)
    .innerJoin(products, eq(products.id, serviceProducts.productId))
    .innerJoin(productRates, eq(productRates.id, serviceProducts.productRateId))
    .leftJoin(applicationMethods, eq(applicationMethods.id, productRates.applicationMethodId))
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
      applicationMethodId: p.applicationMethodId, carrierGalPer1000: p.carrierGalPer1000,
      methodName: p.applicationMethodName ?? APPLICATION_METHOD_LABELS[p.method as ApplicationMethod] ?? null, mixName: p.mixName,
    };
  }));
  if (rows.length) await tx.insert(visitProducts).values(rows);
  return rows.length;
}

/** A visit's saved products (what it applied and what that cost on its day). */
export function visitProductRows(visitId: string) {
  return db.select().from(visitProducts).where(eq(visitProducts.visitId, visitId)).orderBy(asc(visitProducts.sortOrder));
}

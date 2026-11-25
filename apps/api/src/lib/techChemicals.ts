import { and, asc, eq, inArray } from "drizzle-orm";
import { DEFAULT_APPLICATION_METHODS, costOn, costPerUseUnitCents, type ChemicalCompletion } from "@crewdesk/shared";
import { db } from "../db";
import { applicationMethods, chemicalMixItems, chemicalMixes, productCosts, productRates, products, properties, serviceTypes, visitLines, visitProducts, visits } from "../db/schema";
import { HttpError } from "./errors";
import { companyToday, serviceProductLines } from "./productCosts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Run = typeof db | Tx;

/**
 * The company's application methods (Chemical Tracking), adding the starting list the first time.
 * Not the Spray Mix Calculator: techs change rates there, so records never read from it.
 */
export async function methodsFor(companyId: string, run: Run = db, opts: { all?: boolean } = {}) {
  let rows = await run.select().from(applicationMethods).where(eq(applicationMethods.companyId, companyId)).orderBy(asc(applicationMethods.sortOrder), asc(applicationMethods.name));
  if (!rows.length) {
    rows = await run.insert(applicationMethods)
      .values(DEFAULT_APPLICATION_METHODS.map((m, i) => ({ companyId, name: m.name, galPer1000: m.galPer1000, sortOrder: i })))
      .onConflictDoNothing().returning();
    rows.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return opts.all ? rows : rows.filter((m) => m.active);
}
type Method = Awaited<ReturnType<typeof methodsFor>>[number];
type Rate = typeof productRates.$inferSelect;

/** A product's rate with a method: the rate set for that method, else its first rate. */
function rateFor(rates: Rate[], methodId: string) {
  return rates.find((r) => r.applicationMethodId === methodId) ?? rates[0] ?? null;
}

/** The method a rate is usually applied with: its own method, else one with the same spray volume, else a dry one. */
function defaultMethod(methods: Method[], rate: { applicationMethodId?: string | null; carrierGalPer1000: number | null } | null) {
  const own = rate?.applicationMethodId ? methods.find((m) => m.id === rate.applicationMethodId) : null;
  if (own) return own;
  const carrier = rate?.carrierGalPer1000 ?? null;
  if (carrier) return methods.find((m) => m.galPer1000 != null && Math.abs(m.galPer1000 - carrier) < 0.01) ?? methods.find((m) => m.galPer1000 != null) ?? methods[0] ?? null;
  return methods.find((m) => m.galPer1000 == null) ?? methods[0] ?? null;
}

/**
 * What the tech sees when completing a chemical work order: the service's products prefilled
 * (how they're usually applied and the amount for this lawn), the company's application methods,
 * and every active product to add, with its rate for each method. No costs: crews don't see them.
 */
export async function chemicalOptions(visitId: string, companyId: string) {
  const [v] = await db.select({ date: visits.date, propertyId: visits.propertyId }).from(visits).where(eq(visits.id, visitId));
  const day = v?.date ?? (await companyToday(companyId));
  const lines = await db.select({ serviceTypeId: visitLines.serviceTypeId, chemical: serviceTypes.chemical, site: serviceTypes.applicationSite })
    .from(visitLines).leftJoin(serviceTypes, eq(serviceTypes.id, visitLines.serviceTypeId)).where(eq(visitLines.visitId, visitId)).orderBy(asc(visitLines.sortOrder));
  const [prop] = v?.propertyId ? await db.select({ lawnSqFt: properties.lawnSqFt }).from(properties).where(eq(properties.id, v.propertyId)) : [];
  const area = prop?.lawnSqFt ?? null;
  const serviceIds = [...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
  const byService = await serviceProductLines(serviceIds, day);
  const methods = await methodsFor(companyId);
  const catalog = await db.select({ id: products.id, name: products.name, unit: products.useUnit, productType: products.productType })
    .from(products).where(and(eq(products.companyId, companyId), eq(products.active, true))).orderBy(asc(products.name));
  const rates = catalog.length ? await db.select().from(productRates).where(inArray(productRates.productId, catalog.map((c) => c.id))).orderBy(asc(productRates.sortOrder)) : [];

  const productInfo = catalog.map((c) => {
    const own = rates.filter((r) => r.productId === c.id);
    return {
      ...c,
      ratePer1000: own[0]?.amountPer1000 ?? null,
      defaultMethodId: defaultMethod(methods, own[0] ?? null)?.id ?? null,
      byMethod: Object.fromEntries(methods.map((m) => [m.id, rateFor(own, m.id)?.amountPer1000 ?? null])),
    };
  });
  const items = lines.flatMap((l) => (l.serviceTypeId ? byService.get(l.serviceTypeId) ?? [] : []).filter((p) => p.applies).map((p) => {
    // A mix on the service: the mix's rate and method, grouped under the mix's name.
    if (p.mixId) {
      const method = methods.find((m) => m.id === p.applicationMethodId) ?? defaultMethod(methods, { carrierGalPer1000: p.carrierGalPer1000 });
      return {
        productId: p.productId, productName: p.productName, unit: p.unit, fromService: true, used: true, mixName: p.mixName,
        methodId: method?.id ?? null, ratePer1000: p.amountPer1000, amount: area ? (p.amountPer1000 * area) / 1000 : null,
      };
    }
    const rate = rates.find((r) => r.id === p.productRateId) ?? null;
    const method = defaultMethod(methods, rate ?? { carrierGalPer1000: p.carrierGalPer1000 });
    // The service's chosen rate, unless it's for another method and the product has one for this method.
    const forMethod = method ? rates.find((r) => r.productId === p.productId && r.applicationMethodId === method.id) : null;
    const ratePer1000 = rate?.applicationMethodId === method?.id ? p.amountPer1000 : forMethod?.amountPer1000 ?? p.amountPer1000;
    return {
      productId: p.productId, productName: p.productName, unit: p.unit, fromService: true, used: true, mixName: null as string | null,
      methodId: method?.id ?? null, ratePer1000, amount: area ? (ratePer1000 * area) / 1000 : null,
    };
  }));
  // Mixes: add every product in one tap, each at the mix's rate, applied the mix's way.
  const mixes = await db.select().from(chemicalMixes).where(and(eq(chemicalMixes.companyId, companyId), eq(chemicalMixes.active, true))).orderBy(asc(chemicalMixes.sortOrder), asc(chemicalMixes.name));
  const mixItems = mixes.length ? await db.select().from(chemicalMixItems).where(inArray(chemicalMixItems.mixId, mixes.map((m) => m.id))).orderBy(asc(chemicalMixItems.sortOrder)) : [];
  const mixList = mixes.map((m) => ({
    id: m.id, name: m.name, notes: m.notes,
    methodId: methods.some((x) => x.id === m.applicationMethodId) ? m.applicationMethodId : null,
    items: mixItems.filter((i) => i.mixId === m.id && catalog.some((c) => c.id === i.productId)).map((i) => ({ productId: i.productId, ratePer1000: i.ratePer1000 })),
  })).filter((m) => m.items.length);
  return {
    mixes: mixList,
    chemical: lines.some((l) => l.chemical) || items.length > 0,
    areaSqFt: area,
    site: lines.find((l) => l.site)?.site ?? null,
    methods: methods.map((m) => ({ id: m.id, name: m.name, galPer1000: m.galPer1000 })),
    items,
    products: productInfo,
  };
}

/**
 * Saves what the tech says was applied (replacing anything saved before): each used product, the
 * application method (its name and spray volume saved with the row), the rate and amount they
 * confirmed, at the cost in force on the work order's day.
 */
export async function snapshotFromTech(tx: Tx, visitId: string, companyId: string, c: ChemicalCompletion) {
  const [v] = await tx.select({ date: visits.date, propertyId: visits.propertyId }).from(visits).where(eq(visits.id, visitId));
  await tx.delete(visitProducts).where(eq(visitProducts.visitId, visitId));
  if (!v) return 0;
  const day = v.date ?? (await companyToday(companyId));
  const used = c.items.filter((i) => i.used);
  if (!used.length) return 0;
  const [prop] = v.propertyId ? await tx.select({ lawnSqFt: properties.lawnSqFt }).from(properties).where(eq(properties.id, v.propertyId)) : [];
  const area = c.areaSqFt ?? prop?.lawnSqFt ?? 0;
  const ids = [...new Set(used.map((i) => i.productId))];
  const ps = await tx.select().from(products).where(and(inArray(products.id, ids), eq(products.companyId, companyId)));
  if (ps.length !== ids.length) throw new HttpError(400, "One of the products isn't in your product list");
  const methods = await methodsFor(companyId, tx, { all: true });
  const costs = await tx.select().from(productCosts).where(inArray(productCosts.productId, ids));
  const lines = await tx.select({ serviceTypeId: visitLines.serviceTypeId }).from(visitLines).where(eq(visitLines.visitId, visitId));
  const byService = await serviceProductLines([...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))], day, tx);
  const links = [...byService.values()].flat().filter((l) => l.applies);

  const rows = used.map((i, n) => {
    const p = ps.find((x) => x.id === i.productId)!;
    const method = methods.find((m) => m.id === i.methodId);
    if (!method) throw new HttpError(400, "Pick one of your application methods");
    const link = links.find((l) => l.productId === p.id);
    const cost = costOn(costs.filter((x) => x.productId === p.id), day);
    const perUse = costPerUseUnitCents(cost?.costPerPurchaseUnitCents, p.purchaseUnitSize);
    return {
      companyId, visitId, serviceTypeId: link?.serviceTypeId ?? null, productId: p.id, productRateId: link?.productRateId ?? null, productCostId: cost?.id ?? null,
      productName: p.name, epaRegNo: p.epaRegNo, rateName: link?.rateName ?? null, amountPer1000: i.ratePer1000, areaSqFt: area, amount: i.amount, unit: p.useUnit,
      costPerUseUnitCents: perUse, costCents: perUse == null ? null : Math.round(i.amount * perUse), costDate: day,
      applicationMethodId: method.id, methodName: method.name, carrierGalPer1000: method.galPer1000, mixName: i.mixName ?? null, sortOrder: n,
    };
  });
  await tx.insert(visitProducts).values(rows);
  return rows.length;
}

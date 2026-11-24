import { and, asc, eq, inArray } from "drizzle-orm";
import {
  APPLICATION_METHOD_LABELS, DRY_METHOD, DRY_METHOD_LABEL, costOn, costPerUseUnitCents, galPer1000FromAcre, per1000FromAcre,
  type ApplicationMethod, type ChemicalCompletion,
} from "@crewdesk/shared";
import { db } from "../db";
import { mixProducts, mixSheets, productCosts, productRates, products, properties, serviceTypes, visitLines, visitProducts, visits } from "../db/schema";
import { HttpError } from "./errors";
import { companyToday, serviceProductLines } from "./productCosts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** "As set on the product": used when the company has no Spray Mix sheets. */
export const RATE_METHOD = "rate";

async function sheetsFor(companyId: string, run: typeof db | Tx = db) {
  const sheets = await run.select().from(mixSheets).where(eq(mixSheets.companyId, companyId)).orderBy(asc(mixSheets.sortOrder), asc(mixSheets.name));
  const rows = sheets.length ? await run.select().from(mixProducts).where(inArray(mixProducts.sheetId, sheets.map((s) => s.id))) : [];
  return sheets.map((s) => ({ ...s, rows: rows.filter((r) => r.sheetId === s.id) }));
}
type Sheet = Awaited<ReturnType<typeof sheetsFor>>[number];

/** A product's rate per 1,000 sq ft with a sheet: the sheet's linked row (same unit), else the product's own rate. */
function sheetRate(sheet: Sheet, productId: string, unit: string, fallback: number | null) {
  const row = sheet.rows.find((r) => r.productId === productId && r.unit === unit);
  return row ? per1000FromAcre(row.ratePerAcre) : fallback;
}

/** The sheet a product rate's spray volume matches (2 gal / 1,000 → "Truck 2gal/1000ft"), else one that lists the product. */
function defaultSheet(sheets: Sheet[], productId: string, carrier: number | null) {
  if (!carrier) return null;
  return sheets.find((s) => Math.abs(galPer1000FromAcre(s.gallonsPerAcre) - carrier) < 0.01)
    ?? sheets.find((s) => s.rows.some((r) => r.productId === productId))
    ?? sheets[0] ?? null;
}

/**
 * What the tech sees when completing a chemical work order: the service's products prefilled
 * (with how they're usually applied and the amount for this lawn), the application methods (the
 * Spray Mix sheets, plus spreader for dry products), and every active product to add.
 * No costs: crews don't see them.
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
  const sheets = await sheetsFor(companyId);
  const catalog = await db.select({ id: products.id, name: products.name, unit: products.useUnit, productType: products.productType })
    .from(products).where(and(eq(products.companyId, companyId), eq(products.active, true))).orderBy(asc(products.name));
  const rates = catalog.length ? await db.select().from(productRates).where(inArray(productRates.productId, catalog.map((c) => c.id))).orderBy(asc(productRates.sortOrder)) : [];

  const methods = [
    ...sheets.map((s) => ({ id: s.id, name: s.name, galPer1000: galPer1000FromAcre(s.gallonsPerAcre) })),
    { id: DRY_METHOD, name: DRY_METHOD_LABEL, galPer1000: null as number | null },
  ];
  /** For each product: its own rate and unit, and its rate with each sheet (for when the tech changes the method). */
  const productInfo = catalog.map((c) => {
    const own = rates.find((r) => r.productId === c.id);
    return {
      ...c,
      ratePer1000: own?.amountPer1000 ?? null,
      defaultMethodId: (own?.carrierGalPer1000 ? defaultSheet(sheets, c.id, own.carrierGalPer1000)?.id : null) ?? (own?.carrierGalPer1000 && !sheets.length ? RATE_METHOD : DRY_METHOD),
      bySheet: Object.fromEntries(sheets.map((s) => [s.id, sheetRate(s, c.id, c.unit, own?.amountPer1000 ?? null)])),
    };
  });
  const items = lines.flatMap((l) => (l.serviceTypeId ? byService.get(l.serviceTypeId) ?? [] : []).filter((p) => p.applies).map((p) => {
    const sheet = p.carrierGalPer1000 ? defaultSheet(sheets, p.productId, p.carrierGalPer1000) : null;
    const rate = sheet ? sheetRate(sheet, p.productId, p.unit, p.amountPer1000) ?? p.amountPer1000 : p.amountPer1000;
    return {
      productId: p.productId, productName: p.productName, unit: p.unit, fromService: true, used: true,
      methodId: sheet?.id ?? (p.carrierGalPer1000 ? RATE_METHOD : DRY_METHOD), ratePer1000: rate,
      amount: area ? (rate * area) / 1000 : null,
    };
  }));
  return {
    chemical: lines.some((l) => l.chemical) || items.length > 0,
    areaSqFt: area,
    site: lines.find((l) => l.site)?.site ?? null,
    methods: sheets.length ? methods : [{ id: RATE_METHOD, name: "As set on the product", galPer1000: null }, ...methods.slice(-1)],
    items,
    products: productInfo,
  };
}

/**
 * Saves what the tech says was applied (replacing anything saved before): each used product, how it
 * was applied (a Spray Mix sheet's spray volume, the product's own rate, or dry), the rate and amount
 * they confirmed, at the cost in force on the work order's day.
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
  const sheets = await sheetsFor(companyId, tx);
  const rates = await tx.select().from(productRates).where(inArray(productRates.productId, ids)).orderBy(asc(productRates.sortOrder));
  const costs = await tx.select().from(productCosts).where(inArray(productCosts.productId, ids));
  // Which service (and rate) each product came from, when it's on the work order's services.
  const lines = await tx.select({ serviceTypeId: visitLines.serviceTypeId }).from(visitLines).where(eq(visitLines.visitId, visitId));
  const byService = await serviceProductLines([...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))], day, tx);
  const links = [...byService.values()].flat().filter((l) => l.applies);

  const rows = used.map((i, n) => {
    const p = ps.find((x) => x.id === i.productId)!;
    const own = rates.find((r) => r.productId === p.id);
    const link = links.find((l) => l.productId === p.id);
    let methodName: string; let carrier: number | null; let sheetId: string | null = null;
    if (i.methodId === DRY_METHOD) { methodName = DRY_METHOD_LABEL; carrier = null; }
    else if (i.methodId === RATE_METHOD) {
      carrier = own?.carrierGalPer1000 ?? null;
      methodName = APPLICATION_METHOD_LABELS[(own?.method ?? "other") as ApplicationMethod] ?? "As set on the product";
    } else {
      const sheet = sheets.find((s) => s.id === i.methodId);
      if (!sheet) throw new HttpError(400, "That application method isn't one of your Spray Mix sheets");
      sheetId = sheet.id; methodName = sheet.name; carrier = galPer1000FromAcre(sheet.gallonsPerAcre);
    }
    const cost = costOn(costs.filter((x) => x.productId === p.id), day);
    const perUse = costPerUseUnitCents(cost?.costPerPurchaseUnitCents, p.purchaseUnitSize);
    return {
      companyId, visitId, serviceTypeId: link?.serviceTypeId ?? null, productId: p.id, productRateId: link?.productRateId ?? null, productCostId: cost?.id ?? null,
      productName: p.name, epaRegNo: p.epaRegNo, rateName: link?.rateName ?? null, amountPer1000: i.ratePer1000, areaSqFt: area, amount: i.amount, unit: p.useUnit,
      costPerUseUnitCents: perUse, costCents: perUse == null ? null : Math.round(i.amount * perUse), costDate: day,
      mixSheetId: sheetId, methodName, carrierGalPer1000: carrier, sortOrder: n,
    };
  });
  await tx.insert(visitProducts).values(rows);
  return rows.length;
}

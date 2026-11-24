import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { customerName, dilutionPerGal, formatAddress, recordIssues, tankMixGallons } from "@crewdesk/shared";
import { localParts } from "./tz";
import { db } from "../db";
import {
  applicationRecordProducts, applicationRecords, applicatorCerts, companies, customers, employees, productLabels, productRates, products,
  properties, serviceTypes, visitLines, visitProducts, visits,
} from "../db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The label in force on a day: the newest uploaded by the end of that day. */
async function labelOn(tx: Tx, productId: string, day: string) {
  const [l] = await tx.select({ id: productLabels.id }).from(productLabels)
    .where(and(eq(productLabels.productId, productId), lte(productLabels.createdAt, new Date(`${day}T23:59:59.999Z`))))
    .orderBy(desc(productLabels.createdAt)).limit(1);
  if (l) return l.id;
  // A label added later still documents the product; the newest one is better than none.
  const [any] = await tx.select({ id: productLabels.id }).from(productLabels).where(eq(productLabels.productId, productId)).orderBy(desc(productLabels.createdAt)).limit(1);
  return any?.id ?? null;
}

/**
 * Makes the chemical application record for a completed work order, from what it applied (its saved
 * products) and who, where, when: OAC 35:30-17-21(a). Only work orders that applied a product kept in
 * records, or have a chemical service, get one. Called in the completion's transaction, after the
 * products are saved. Returns the record id, or null when none was needed.
 */
export async function createApplicationRecord(tx: Tx, visitId: string, companyId: string) {
  const [v] = await tx.select().from(visits).where(eq(visits.id, visitId));
  if (!v) return null;
  const lines = await tx.select({ chemical: serviceTypes.chemical, site: serviceTypes.applicationSite })
    .from(visitLines).innerJoin(serviceTypes, eq(serviceTypes.id, visitLines.serviceTypeId))
    .where(eq(visitLines.visitId, visitId)).orderBy(asc(visitLines.sortOrder));
  const used = await tx.select({ vp: visitProducts, p: products, carrier: productRates.carrierGalPer1000 })
    .from(visitProducts)
    .innerJoin(products, eq(products.id, visitProducts.productId))
    .leftJoin(productRates, eq(productRates.id, visitProducts.productRateId))
    .where(eq(visitProducts.visitId, visitId)).orderBy(asc(visitProducts.sortOrder));
  const kept = used.filter((u) => u.p.trackRecords || u.p.productType === "adjuvant");
  if (!kept.length && !lines.some((l) => l.chemical)) return null;

  const [co] = await tx.select().from(companies).where(eq(companies.id, companyId));
  const tz = co?.timezone ?? "America/Chicago";
  const [cust] = await tx.select().from(customers).where(eq(customers.id, v.customerId));
  const [prop] = v.propertyId ? await tx.select().from(properties).where(eq(properties.id, v.propertyId)) : [];
  const applicatorId = v.finishedById;
  const [emp] = applicatorId ? await tx.select({ first: employees.firstName, last: employees.lastName }).from(employees).where(eq(employees.id, applicatorId)) : [];
  const [cert] = applicatorId ? await tx.select().from(applicatorCerts).where(eq(applicatorCerts.employeeId, applicatorId)) : [];

  const appliedOn = v.date ?? localParts(v.completedAt ?? new Date(), tz).date;
  const area = kept[0]?.vp.areaSqFt ?? prop?.lawnSqFt ?? null;
  const productRows = [];
  for (const [i, u] of kept.entries()) {
    productRows.push({
      productId: u.p.id, tradeName: u.vp.productName, epaRegNo: u.vp.epaRegNo, productType: u.p.productType, restrictedUse: u.p.restrictedUse,
      rateName: u.vp.rateName, ratePer1000: u.vp.amountPer1000, unit: u.vp.unit,
      dilutionPerGal: dilutionPerGal(u.vp.amountPer1000, u.carrier), carrierGalPer1000: u.carrier ?? null,
      amount: u.vp.amount, targets: u.p.targets, reiHours: u.p.reiHours, labelId: await labelOn(tx, u.p.id, appliedOn), sortOrder: i,
      requiredAdjuvant: u.p.requiredAdjuvant, requiredDriftAgent: u.p.requiredDriftAgent,
    });
  }
  const custAddress = cust?.billingStreet ? formatAddress({ street: cust.billingStreet, city: cust.billingCity, state: cust.billingState, zip: cust.billingZip }) : prop ? formatAddress(prop) : null;
  const header = {
    companyId, visitId, visitNumber: v.number,
    companyName: co?.name ?? "", companyAddress: co?.addressLine1 ? formatAddress({ street: co.addressLine1, city: co.city, state: co.state, zip: co.zip }) : null,
    companyLicenseNo: co?.pesticideLicenseNo ?? null,
    applicatorId, applicatorName: emp ? `${emp.first} ${emp.last}`.trim() : "Unknown",
    applicatorCertNo: cert?.certNo ?? null, applicatorCertExpires: cert?.expiresOn ?? null,
    customerId: v.customerId, customerName: cust ? customerName(cust) : "Unknown", customerAddress: custAddress,
    propertyId: v.propertyId, siteAddress: prop ? formatAddress(prop) : null,
    appliedOn, startedAt: v.startedAt, stoppedAt: v.completedAt,
    site: lines.find((l) => l.site)?.site ?? null, areaSqFt: area,
    tankMixGal: tankMixGallons(productRows, area), lat: v.completedLat, lng: v.completedLng,
  };
  const issues = recordIssues({ ...header, products: productRows });
  const [rec] = await tx.insert(applicationRecords).values({ ...header, issues }).returning({ id: applicationRecords.id });
  if (productRows.length) {
    await tx.insert(applicationRecordProducts).values(productRows.map(({ requiredAdjuvant: _a, requiredDriftAgent: _d, ...p }) => ({ ...p, recordId: rec.id })));
  }
  return rec.id;
}

/** A reopened work order: its record is voided (kept, never deleted); completing it again makes a new one. */
export async function voidApplicationRecords(tx: Tx, visitId: string, reason: string) {
  await tx.update(applicationRecords).set({ voidedAt: new Date(), voidReason: reason, updatedAt: new Date() })
    .where(and(eq(applicationRecords.visitId, visitId), isNull(applicationRecords.voidedAt)));
}

/** Re-checks a record after a correction (with the label requirements of its products as they are now). */
export async function refreshIssues(tx: Tx, recordId: string) {
  const [r] = await tx.select().from(applicationRecords).where(eq(applicationRecords.id, recordId));
  const ps = await tx.select().from(applicationRecordProducts).where(eq(applicationRecordProducts.recordId, recordId));
  const ids = ps.map((p) => p.productId).filter((x): x is string => !!x);
  const req = new Map((ids.length ? await tx.select({ id: products.id, a: products.requiredAdjuvant, d: products.requiredDriftAgent }).from(products).where(inArray(products.id, ids)) : []).map((p) => [p.id, p]));
  const issues = recordIssues({ ...r, products: ps.map((p) => ({ ...p, requiredAdjuvant: p.productId ? req.get(p.productId)?.a : null, requiredDriftAgent: p.productId ? req.get(p.productId)?.d : null })) });
  await tx.update(applicationRecords).set({ issues, updatedAt: new Date() }).where(eq(applicationRecords.id, recordId));
  return issues;
}

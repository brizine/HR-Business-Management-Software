import { and, eq, inArray } from "drizzle-orm";
import { lineMaterialCents, lineSqFt } from "@crewdesk/shared";
import { db } from "../db";
import { estimateLines, estimates, properties } from "../db/schema";
import { companyToday, materialSummary, serviceProductLines } from "./productCosts";

/** Estimates still being worked on or waiting on the customer; accepted and declined ones keep their numbers. */
const OPEN = ["draft", "sent", "changes"];

/**
 * Brings "Our cost" up to date on open estimates' lines that took it from the service's products
 * (not ones someone typed): today's product costs, rates and mixes, for the line's lawn.
 */
export async function refreshEstimateCosts(companyId: string, estimateIds?: string[]) {
  const es = await db.select({ id: estimates.id, propertyId: estimates.propertyId }).from(estimates)
    .where(and(eq(estimates.companyId, companyId), inArray(estimates.status, OPEN), ...(estimateIds ? [inArray(estimates.id, estimateIds)] : [])));
  if (!es.length) return 0;
  const lines = await db.select().from(estimateLines).where(and(inArray(estimateLines.estimateId, es.map((e) => e.id)), eq(estimateLines.costAuto, true)));
  if (!lines.length) return 0;
  const propIds = [...new Set([...lines.map((l) => l.propertyId), ...es.map((e) => e.propertyId)].filter((x): x is string => !!x))];
  const props = propIds.length ? await db.select({ id: properties.id, lawnSqFt: properties.lawnSqFt, frontSqFt: properties.frontSqFt, backSqFt: properties.backSqFt, otherSqFt: properties.otherSqFt, custom: properties.custom }).from(properties).where(inArray(properties.id, propIds)) : [];
  const byService = await serviceProductLines([...new Set(lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))], await companyToday(companyId));
  let changed = 0;
  for (const l of lines) {
    if (!l.serviceTypeId) continue;
    const propertyId = l.propertyId ?? es.find((e) => e.id === l.estimateId)?.propertyId ?? null;
    const lawn = lineSqFt(l, props.find((p) => p.id === propertyId));
    const cost = lineMaterialCents(materialSummary(byService.get(l.serviceTypeId)), lawn);
    if (cost !== l.costCents) {
      await db.update(estimateLines).set({ costCents: cost }).where(eq(estimateLines.id, l.id));
      changed++;
    }
  }
  return changed;
}

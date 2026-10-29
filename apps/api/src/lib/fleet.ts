import { eq, max } from "drizzle-orm";
import { computeDue } from "@crewdesk/shared";
import type { DB } from "../db";
import { assets, maintenanceSchedules, meterReadings, workOrders } from "../db/schema";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0] | DB;

export async function nextWorkOrderNumber(tx: Tx, companyId: string) {
  const [{ n }] = await tx
    .select({ n: max(workOrders.number) })
    .from(workOrders)
    .where(eq(workOrders.companyId, companyId));
  return (n ?? 1000) + 1;
}

/**
 * Records a meter reading and raises the asset's current meters. Readings lower
 * than the current value are logged but never roll the asset back.
 */
export async function recordMeter(
  tx: Tx,
  asset: typeof assets.$inferSelect,
  reading: { odometer?: number; engineHours?: number },
  recordedById: string,
) {
  if (reading.odometer == null && reading.engineHours == null) return asset;
  await tx.insert(meterReadings).values({
    companyId: asset.companyId,
    assetId: asset.id,
    odometer: reading.odometer,
    engineHours: reading.engineHours,
    recordedById,
  });
  const [updated] = await tx
    .update(assets)
    .set({
      odometer: Math.max(asset.odometer, reading.odometer ?? 0),
      engineHours: Math.max(asset.engineHours, reading.engineHours ?? 0),
    })
    .where(eq(assets.id, asset.id))
    .returning();
  return updated;
}

export type ScheduleRow = typeof maintenanceSchedules.$inferSelect;

export function withDue(schedule: ScheduleRow, asset: { odometer: number; engineHours: number }) {
  return { ...schedule, due: computeDue(schedule, asset) };
}

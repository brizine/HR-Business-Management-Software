import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { assetSchema, fleetSettingsSchema, isInactive, maintenanceScheduleSchema, maintenanceScheduleUpdateSchema, meterReadingSchema } from "@crewdesk/shared";
import { db } from "../db";
import { assets, companies, employees, inspections, maintenanceSchedules, meterReadings, newAssetCode, workOrders } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { fleetSettingsFor, recordMeter, withDue } from "../lib/fleet";

/** Which area of the Permissions page controls access here. */
const AREA = "fleet" as const;

const STATUS_RANK = { ok: 0, due_soon: 1, overdue: 2 } as const;

async function loadAsset(companyId: string, id: string) {
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.companyId, companyId)));
  if (!asset) notFound("Asset");
  return asset;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Company-wide maintenance reminder defaults. */
  app.get("/settings", async (req) => fleetSettingsFor(req.user.companyId));
  app.put("/settings", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(fleetSettingsSchema, req.body);
    const settings = {
      remindMilesBefore: body.remindMilesBefore ?? null,
      remindHoursBefore: body.remindHoursBefore ?? null,
      remindDaysBefore: body.remindDaysBefore ?? null,
      repeatOverdueDays: body.repeatOverdueDays ?? null,
    };
    await db.update(companies).set({ fleetSettings: settings }).where(eq(companies.id, req.user.companyId));
    return settings;
  });

  /** All assets, each with its worst maintenance status. */
  app.get("/", async (req) => {
    const settings = await fleetSettingsFor(req.user.companyId);
    const list = await db
      .select()
      .from(assets)
      .where(eq(assets.companyId, req.user.companyId))
      .orderBy(asc(assets.name));
    const schedules = await db
      .select()
      .from(maintenanceSchedules)
      .where(eq(maintenanceSchedules.companyId, req.user.companyId));
    return list.map((a) => {
      const due = schedules.filter((s) => s.assetId === a.id).map((s) => withDue(s, a, settings).due.status);
      const maintenanceStatus = due.reduce<"ok" | "due_soon" | "overdue">(
        (w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w),
        "ok",
      );
      return { ...a, maintenanceStatus };
    });
  });

  /** Every schedule that is due soon or overdue across the fleet. */
  app.get("/maintenance/due", async (req) => {
    const settings = await fleetSettingsFor(req.user.companyId);
    const rows = await db
      .select({ schedule: maintenanceSchedules, asset: assets })
      .from(maintenanceSchedules)
      .innerJoin(assets, eq(assets.id, maintenanceSchedules.assetId))
      .where(eq(maintenanceSchedules.companyId, req.user.companyId));
    return rows
      .map(({ schedule, asset }) => ({ ...withDue(schedule, asset, settings), assetName: asset.name }))
      .filter((s) => s.due.status !== "ok")
      .sort((a, b) => STATUS_RANK[b.due.status] - STATUS_RANK[a.due.status]);
  });

  /**
   * Resolves a scanned QR label. Codes are case-insensitive and ignore stray
   * characters so a hand-typed code from a scuffed label still works.
   */
  app.get<{ Params: { code: string } }>("/by-code/:code", async (req) => {
    const code = req.params.code.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const [asset] = await db
      .select({ id: assets.id, name: assets.name })
      .from(assets)
      .where(and(eq(assets.qrCode, code), eq(assets.companyId, req.user.companyId)));
    if (!asset) notFound("Equipment for this code");
    return asset;
  });

  /** Issues a new code, e.g. when a label is lost or stolen. Old labels stop working. */
  app.post<{ Params: { id: string } }>("/:id/regenerate-code", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const [row] = await db
      .update(assets)
      .set({ qrCode: newAssetCode() })
      .where(and(eq(assets.id, req.params.id), eq(assets.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Asset");
    return row;
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const asset = await loadAsset(req.user.companyId, req.params.id);
    const settings = await fleetSettingsFor(req.user.companyId);
    const [schedules, orders, recentInspections, readings] = await Promise.all([
      db.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.assetId, asset.id)),
      db.select().from(workOrders).where(eq(workOrders.assetId, asset.id)).orderBy(desc(workOrders.createdAt)),
      db
        .select()
        .from(inspections)
        .where(eq(inspections.assetId, asset.id))
        .orderBy(desc(inspections.createdAt))
        .limit(20),
      db
        .select()
        .from(meterReadings)
        .where(eq(meterReadings.assetId, asset.id))
        .orderBy(desc(meterReadings.createdAt))
        .limit(20),
    ]);
    const completed = orders.filter((o) => o.status === "completed");
    return {
      ...asset,
      schedules: schedules.map((s) => withDue(s, asset, settings)),
      workOrders: orders,
      inspections: recentInspections,
      meterReadings: readings,
      totalMaintenanceCostCents: completed.reduce((s, o) => s + o.partsCostCents + o.laborCostCents, 0),
    };
  });

  app.post("/", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(assetSchema, req.body);
    const [row] = await db
      .insert(assets)
      .values({ ...body, companyId: req.user.companyId })
      .returning();
    return row;
  });

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(assetSchema.partial(), req.body);
    const [row] = await db
      .update(assets)
      .set(body)
      .where(and(eq(assets.id, req.params.id), eq(assets.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Asset");
    return row;
  });

  /** Any employee can log a meter reading (e.g. from the mobile app at end of shift). */
  app.post<{ Params: { id: string } }>("/:id/meter", async (req) => {
    const body = parse(meterReadingSchema, req.body);
    const asset = await loadAsset(req.user.companyId, req.params.id);
    return recordMeter(db, asset, body, req.user.sub);
  });

  /** The person must work here (and not be inactive). */
  async function checkAssignee(companyId: string, id: string | null | undefined) {
    if (!id) return;
    const [e] = await db.select({ status: employees.status }).from(employees).where(and(eq(employees.id, id), eq(employees.companyId, companyId)));
    if (!e) notFound("Employee");
    if (isInactive(e.status)) throw new HttpError(400, "That person is no longer active");
  }

  app.post("/schedules", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(maintenanceScheduleSchema, req.body);
    const asset = await loadAsset(req.user.companyId, body.assetId);
    await checkAssignee(req.user.companyId, body.assignedToId);
    const [row] = await db
      .insert(maintenanceSchedules)
      .values({
        ...body,
        companyId: req.user.companyId,
        // Default "last service" to now so new schedules count from today's meters.
        lastServiceDate: body.lastServiceDate ?? new Date().toISOString().slice(0, 10),
        lastServiceOdometer: body.lastServiceOdometer ?? asset.odometer,
        lastServiceHours: body.lastServiceHours ?? asset.engineHours,
      })
      .returning();
    return withDue(row, asset, await fleetSettingsFor(req.user.companyId));
  });

  /** Change who a schedule is assigned to, or when its reminder goes out (null = company default). */
  app.patch<{ Params: { id: string } }>("/schedules/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(maintenanceScheduleUpdateSchema, req.body);
    if (body.assignedToId !== undefined) await checkAssignee(req.user.companyId, body.assignedToId);
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) throw new HttpError(400, "Nothing to change");
    const [row] = await db
      .update(maintenanceSchedules)
      .set(changes)
      .where(and(eq(maintenanceSchedules.id, req.params.id), eq(maintenanceSchedules.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Schedule");
    return withDue(row, await loadAsset(req.user.companyId, row.assetId), await fleetSettingsFor(req.user.companyId));
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const [row] = await db
      .delete(maintenanceSchedules)
      .where(and(eq(maintenanceSchedules.id, req.params.id), eq(maintenanceSchedules.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Schedule");
    return { ok: true };
  });
};

export default routes;

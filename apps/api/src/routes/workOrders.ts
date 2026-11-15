import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { pastServiceSchema, workOrderSchema, workOrderUpdateSchema, resolveLead, workOrderDue } from "@crewdesk/shared";
import { db } from "../db";
import { assets, employees, maintenanceSchedules, workOrders } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { nextWorkOrderNumber, recordMeter, fleetSettingsFor } from "../lib/fleet";
import { except, notify, staffWithRole } from "../lib/notify";
import { accountingConfig, autoPost, postWorkOrder } from "../lib/accounting";

/** Which area of the Permissions page controls access here. */
const AREA = "fleet" as const;

function notifyAssigned(wo: typeof workOrders.$inferSelect, assetName: string, actorId: string) {
  notify(wo.companyId, except([wo.assignedToId], actorId), {
    category: "fleet",
    title: `Work order #${wo.number} assigned to you`,
    body: `${assetName}: ${wo.title}${wo.dueDate ? ` (due ${wo.dueDate})` : ""}`,
    link: { screen: "tasks" },
  });
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { status?: string; assetId?: string; mine?: string; assignedToId?: string } }>("/", async (req) => {
    const filters = [eq(workOrders.companyId, req.user.companyId)];
    if (req.query.status === "active") {
      filters.push(inArray(workOrders.status, ["open", "in_progress", "waiting_parts"]));
    } else if (req.query.status) {
      filters.push(eq(workOrders.status, req.query.status));
    }
    if (req.query.assetId) filters.push(eq(workOrders.assetId, req.query.assetId));
    if (req.query.mine === "true") filters.push(eq(workOrders.assignedToId, req.user.sub));
    // Managers can list one person's work orders (their Tasks box on the employee page).
    else if (req.query.assignedToId && isManager(req, AREA)) filters.push(eq(workOrders.assignedToId, req.query.assignedToId));
    const lead = resolveLead({}, await fleetSettingsFor(req.user.companyId));
    const rows = await db
      .select({
        workOrder: workOrders,
        assetName: assets.name,
        assetMeter: { odometer: assets.odometer, engineHours: assets.engineHours },
        assignee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName },
      })
      .from(workOrders)
      .innerJoin(assets, eq(assets.id, workOrders.assetId))
      .leftJoin(employees, eq(employees.id, workOrders.assignedToId))
      .where(and(...filters))
      .orderBy(desc(workOrders.createdAt));
    // Where each scheduled one stands (using the company's reminder lead times).
    const done = (s: string) => s === "completed" || s === "cancelled";
    return rows.map((r) => ({ ...r, due: done(r.workOrder.status) ? null : workOrderDue(r.workOrder, r.assetMeter, new Date(), lead) }));
  });

  /** Anyone can report an issue; only managers can assign or set a schedule. */
  app.post("/", async (req) => {
    const body = parse(workOrderSchema, req.body);
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, body.assetId), eq(assets.companyId, req.user.companyId)));
    if (!asset) notFound("Asset");
    if (!isManager(req, AREA)) {
      body.assignedToId = null;
      body.scheduleId = null;
      body.dueOdometer = null;
      body.dueHours = null;
    }
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(workOrders)
        .values({
          ...body,
          companyId: req.user.companyId,
          number: await nextWorkOrderNumber(tx, req.user.companyId),
          reportedById: req.user.sub,
        })
        .returning();
      if (body.priority === "critical") {
        await tx.update(assets).set({ status: "out_of_service" }).where(eq(assets.id, asset.id));
      }
      return row;
    });

    const link = { screen: "work-order", id: created.id, assetId: asset.id } as const;
    if (created.assignedToId) notifyAssigned(created, asset.name, req.user.sub);
    // Field reports and urgent issues go to everyone who manages the fleet.
    if (!isManager(req, AREA) || created.priority === "high" || created.priority === "critical") {
      notify(req.user.companyId, except(await staffWithRole(req.user.companyId, "manager", AREA), req.user.sub), {
        category: "fleet",
        title: `${created.priority === "critical" ? "CRITICAL: " : ""}${asset.name}: ${created.title}`,
        body: created.priority === "critical" ? "Asset taken out of service." : `New ${created.priority}-priority work order #${created.number}.`,
        link,
      });
    }
    return created;
  });

  /**
   * Adds a service done in the past to an asset's history, as a completed work order dated then
   * (e.g. records from before Crewdesk). If it's linked to a schedule and newer than the schedule's
   * last service, the schedule counts from it. Not sent to accounting.
   */
  app.post("/past", async (req) => {
    if (!isManager(req, AREA)) throw new HttpError(403, "Only fleet managers can add past services");
    const body = parse(pastServiceSchema, req.body);
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, body.assetId), eq(assets.companyId, req.user.companyId)));
    if (!asset) notFound("Asset");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    if (body.date > tomorrow) throw new HttpError(400, "The date can't be in the future");
    let schedule: typeof maintenanceSchedules.$inferSelect | undefined;
    if (body.scheduleId) {
      [schedule] = await db.select().from(maintenanceSchedules).where(and(eq(maintenanceSchedules.id, body.scheduleId), eq(maintenanceSchedules.assetId, asset.id)));
      if (!schedule) notFound("Schedule");
    }
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(workOrders).values({
        companyId: req.user.companyId,
        number: await nextWorkOrderNumber(tx, req.user.companyId),
        assetId: asset.id,
        scheduleId: schedule?.id ?? null,
        title: body.title,
        priority: "low",
        status: "completed",
        reportedById: req.user.sub,
        vendor: body.vendor || null,
        partsCostCents: body.partsCostCents,
        laborCostCents: body.laborCostCents,
        laborHours: body.laborHours ?? null,
        resolutionNotes: body.notes || null,
        completedAt: new Date(`${body.date}T12:00:00Z`),
        completedOdometer: body.odometer ?? null,
        completedHours: body.hours ?? null,
      }).returning();
      if (schedule && (!schedule.lastServiceDate || body.date >= schedule.lastServiceDate)) {
        await tx.update(maintenanceSchedules).set({
          lastServiceDate: body.date,
          lastServiceOdometer: body.odometer ?? schedule.lastServiceOdometer,
          lastServiceHours: body.hours ?? schedule.lastServiceHours,
        }).where(eq(maintenanceSchedules.id, schedule.id));
      }
      if (body.odometer != null || body.hours != null) {
        await recordMeter(tx, asset, { odometer: body.odometer ?? undefined, engineHours: body.hours ?? undefined }, req.user.sub);
      }
      return row;
    });
  });

  /**
   * Managers can change anything; the assigned technician can update progress.
   * Completing a work order linked to a schedule resets that schedule's
   * "last service" to the completion date and meters.
   */
  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(workOrderUpdateSchema, req.body);
    const [wo] = await db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.id, req.params.id), eq(workOrders.companyId, req.user.companyId)));
    if (!wo) notFound("Work order");
    if (!isManager(req, AREA)) {
      if (wo.assignedToId !== req.user.sub) throw new HttpError(403, "Only the assigned technician or a manager can update this");
      delete body.assignedToId;
      delete body.dueDate;
      delete body.dueOdometer;
      delete body.dueHours;
    }
    const { completedOdometer, completedHours, ...fields } = body;
    const completing = fields.status === "completed" && wo.status !== "completed";

    const updated = await db.transaction(async (tx) => {
      const changes = { ...fields, ...(completing ? { completedAt: new Date() } : {}) };
      // Nothing this person may change (e.g. a technician sending only a due point): leave it as is.
      const [row] = Object.values(changes).some((v) => v !== undefined)
        ? await tx.update(workOrders).set(changes).where(eq(workOrders.id, wo.id)).returning()
        : [wo];

      if (completing) {
        let [asset] = await tx.select().from(assets).where(eq(assets.id, wo.assetId));
        asset = await recordMeter(tx, asset, { odometer: completedOdometer, engineHours: completedHours }, req.user.sub);
        // Remember the meters for the maintenance history (0 = the asset doesn't track that meter).
        await tx.update(workOrders).set({
          completedOdometer: completedOdometer ?? (asset.odometer > 0 ? asset.odometer : null),
          completedHours: completedHours ?? (asset.engineHours > 0 ? asset.engineHours : null),
        }).where(eq(workOrders.id, wo.id));
        row.completedOdometer = completedOdometer ?? (asset.odometer > 0 ? asset.odometer : null);
        row.completedHours = completedHours ?? (asset.engineHours > 0 ? asset.engineHours : null);
        if (wo.scheduleId) {
          await tx
            .update(maintenanceSchedules)
            .set({
              lastServiceDate: new Date().toISOString().slice(0, 10),
              lastServiceOdometer: completedOdometer ?? asset.odometer,
              lastServiceHours: completedHours ?? asset.engineHours,
            })
            .where(eq(maintenanceSchedules.id, wo.scheduleId));
        }
        // Return the asset to service when nothing else is outstanding on it.
        const outstanding = await tx
          .select()
          .from(workOrders)
          .where(
            and(eq(workOrders.assetId, wo.assetId), inArray(workOrders.status, ["open", "in_progress", "waiting_parts"])),
          );
        if (outstanding.length === 0 && asset.status !== "retired") {
          await tx.update(assets).set({ status: "active" }).where(eq(assets.id, asset.id));
        }
      } else if (fields.status === "in_progress") {
        await tx
          .update(assets)
          .set({ status: "in_shop" })
          .where(and(eq(assets.id, wo.assetId), eq(assets.status, "active")));
      }
      return row;
    });

    const [asset] = await db.select({ name: assets.name }).from(assets).where(eq(assets.id, wo.assetId));
    if (updated.assignedToId && updated.assignedToId !== wo.assignedToId) notifyAssigned(updated, asset.name, req.user.sub);
    if (completing) {
      notify(req.user.companyId, except([wo.reportedById], req.user.sub), {
        category: "fleet",
        title: `Work order #${wo.number} completed`,
        body: `${asset.name}: ${wo.title}`,
        link: { screen: "work-order", id: wo.id, assetId: wo.assetId },
      });
      // Send its parts and labor to Bigcapital as an expense, if the company asked for that.
      if (updated.partsCostCents + updated.laborCostCents > 0) {
        const acct = await accountingConfig(req.user.companyId);
        if (acct.settings.enabled && acct.settings.autoPostWorkOrders && acct.hasKey) autoPost(() => postWorkOrder(req.user.companyId, wo.id, req.user.sub));
      }
    }
    return updated;
  });
};

export default routes;

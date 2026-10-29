import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { workOrderSchema, workOrderUpdateSchema } from "@crewdesk/shared";
import { db } from "../db";
import { assets, employees, maintenanceSchedules, workOrders } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { nextWorkOrderNumber, recordMeter } from "../lib/fleet";
import { except, notify, staffWithRole } from "../lib/notify";

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

  app.get<{ Querystring: { status?: string; assetId?: string; mine?: string } }>("/", async (req) => {
    const filters = [eq(workOrders.companyId, req.user.companyId)];
    if (req.query.status === "active") {
      filters.push(inArray(workOrders.status, ["open", "in_progress", "waiting_parts"]));
    } else if (req.query.status) {
      filters.push(eq(workOrders.status, req.query.status));
    }
    if (req.query.assetId) filters.push(eq(workOrders.assetId, req.query.assetId));
    if (req.query.mine === "true") filters.push(eq(workOrders.assignedToId, req.user.sub));
    return db
      .select({
        workOrder: workOrders,
        assetName: assets.name,
        assignee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName },
      })
      .from(workOrders)
      .innerJoin(assets, eq(assets.id, workOrders.assetId))
      .leftJoin(employees, eq(employees.id, workOrders.assignedToId))
      .where(and(...filters))
      .orderBy(desc(workOrders.createdAt));
  });

  /** Anyone can report an issue; only managers can assign or set a schedule. */
  app.post("/", async (req) => {
    const body = parse(workOrderSchema, req.body);
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, body.assetId), eq(assets.companyId, req.user.companyId)));
    if (!asset) notFound("Asset");
    if (!isManager(req)) {
      body.assignedToId = null;
      body.scheduleId = null;
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
    if (!isManager(req) || created.priority === "high" || created.priority === "critical") {
      notify(req.user.companyId, except(await staffWithRole(req.user.companyId, "manager"), req.user.sub), {
        category: "fleet",
        title: `${created.priority === "critical" ? "CRITICAL: " : ""}${asset.name}: ${created.title}`,
        body: created.priority === "critical" ? "Asset taken out of service." : `New ${created.priority}-priority work order #${created.number}.`,
        link,
      });
    }
    return created;
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
    if (!isManager(req)) {
      if (wo.assignedToId !== req.user.sub) throw new HttpError(403, "Only the assigned technician or a manager can update this");
      delete body.assignedToId;
    }
    const { completedOdometer, completedHours, ...fields } = body;
    const completing = fields.status === "completed" && wo.status !== "completed";

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(workOrders)
        .set({ ...fields, ...(completing ? { completedAt: new Date() } : {}) })
        .where(eq(workOrders.id, wo.id))
        .returning();

      if (completing) {
        let [asset] = await tx.select().from(assets).where(eq(assets.id, wo.assetId));
        asset = await recordMeter(tx, asset, { odometer: completedOdometer, engineHours: completedHours }, req.user.sub);
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
    }
    return updated;
  });
};

export default routes;

import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { inspectionSchema } from "@crewdesk/shared";
import { db } from "../db";
import { assets, employees, inspections, workOrders } from "../db/schema";
import { authenticate } from "../lib/auth";
import { notFound, parse } from "../lib/errors";
import { nextWorkOrderNumber, recordMeter } from "../lib/fleet";
import { except, notify, staffWithRole } from "../lib/notify";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { assetId?: string } }>("/", async (req) => {
    const filters = [eq(inspections.companyId, req.user.companyId)];
    if (req.query.assetId) filters.push(eq(inspections.assetId, req.query.assetId));
    return db
      .select({
        inspection: inspections,
        assetName: assets.name,
        inspector: { firstName: employees.firstName, lastName: employees.lastName },
      })
      .from(inspections)
      .innerJoin(assets, eq(assets.id, inspections.assetId))
      .leftJoin(employees, eq(employees.id, inspections.inspectorId))
      .where(and(...filters))
      .orderBy(desc(inspections.createdAt))
      .limit(200);
  });

  /**
   * Pre-trip / pre-use inspection (DVIR-style). Any failed item automatically
   * opens a high-priority work order listing the defects.
   */
  app.post("/", async (req) => {
    const body = parse(inspectionSchema, req.body);
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, body.assetId), eq(assets.companyId, req.user.companyId)));
    if (!asset) notFound("Asset");
    const failed = body.items.filter((i) => !i.ok);

    const result = await db.transaction(async (tx) => {
      const [inspection] = await tx
        .insert(inspections)
        .values({
          ...body,
          companyId: req.user.companyId,
          inspectorId: req.user.sub,
          passed: failed.length === 0,
        })
        .returning();
      await recordMeter(tx, asset, body, req.user.sub);

      let workOrder = null;
      if (failed.length) {
        [workOrder] = await tx
          .insert(workOrders)
          .values({
            companyId: req.user.companyId,
            number: await nextWorkOrderNumber(tx, req.user.companyId),
            assetId: asset.id,
            inspectionId: inspection.id,
            title: `Inspection defects: ${failed.map((f) => f.item).join(", ")}`,
            description: failed.map((f) => `- ${f.item}${f.note ? `: ${f.note}` : ""}`).join("\n"),
            priority: "high",
            reportedById: req.user.sub,
          })
          .returning();
      }
      return { inspection, workOrder };
    });

    if (result.workOrder) {
      notify(req.user.companyId, except(await staffWithRole(req.user.companyId, "manager"), req.user.sub), {
        category: "fleet",
        title: `${asset.name} failed inspection`,
        body: `${failed.map((f) => f.item).join(", ")}. Work order #${result.workOrder.number} opened.`,
        link: { screen: "work-order", id: result.workOrder.id, assetId: asset.id },
      });
    }
    return result;
  });
};

export default routes;

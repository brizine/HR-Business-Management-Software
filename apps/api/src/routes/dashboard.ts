import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { computeDue } from "@crewdesk/shared";
import { db } from "../db";
import { assets, employees, maintenanceSchedules, ptoRequests, timeEntries, workOrders } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", { preHandler: requireRole("manager") }, async (req) => {
    const c = req.user.companyId;
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const [staff, clockedIn, pendingPto, openOrders, fleet, schedules] = await Promise.all([
      db.select({ status: employees.status }).from(employees).where(eq(employees.companyId, c)),
      db
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(and(eq(timeEntries.companyId, c), isNull(timeEntries.clockOut))),
      db
        .select({ id: ptoRequests.id })
        .from(ptoRequests)
        .where(and(eq(ptoRequests.companyId, c), eq(ptoRequests.status, "pending"))),
      db
        .select({ priority: workOrders.priority })
        .from(workOrders)
        .where(and(eq(workOrders.companyId, c), inArray(workOrders.status, ["open", "in_progress", "waiting_parts"]))),
      db.select().from(assets).where(eq(assets.companyId, c)),
      db.select().from(maintenanceSchedules).where(eq(maintenanceSchedules.companyId, c)),
    ]);

    const byId = new Map(fleet.map((a) => [a.id, a]));
    const dues = schedules.map((s) => computeDue(s, byId.get(s.assetId)!).status);
    const expiring = fleet.filter(
      (a) => (a.registrationExpires && a.registrationExpires <= in30) || (a.insuranceExpires && a.insuranceExpires <= in30),
    );

    return {
      people: {
        active: staff.filter((s) => s.status === "active").length,
        onboarding: staff.filter((s) => s.status === "onboarding").length,
        clockedIn: clockedIn.length,
        pendingPto: pendingPto.length,
      },
      fleet: {
        assets: fleet.filter((a) => a.status !== "retired").length,
        outOfService: fleet.filter((a) => a.status === "out_of_service" || a.status === "in_shop").length,
        openWorkOrders: openOrders.length,
        criticalWorkOrders: openOrders.filter((o) => o.priority === "critical" || o.priority === "high").length,
        maintenanceOverdue: dues.filter((d) => d === "overdue").length,
        maintenanceDueSoon: dues.filter((d) => d === "due_soon").length,
        expiringDocuments: expiring.map((a) => ({
          id: a.id,
          name: a.name,
          registrationExpires: a.registrationExpires,
          insuranceExpires: a.insuranceExpires,
        })),
      },
    };
  });
};

export default routes;

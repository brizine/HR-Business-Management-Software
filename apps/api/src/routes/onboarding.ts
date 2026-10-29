import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { onboardingTemplateSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { employees, onboardingTasks, onboardingTemplates } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { notify } from "../lib/notify";

export async function applyOnboardingTemplate(
  companyId: string,
  employeeId: string,
  templateId: string,
  startDate?: string | null,
) {
  const [tpl] = await db
    .select()
    .from(onboardingTemplates)
    .where(and(eq(onboardingTemplates.id, templateId), eq(onboardingTemplates.companyId, companyId)));
  if (!tpl) notFound("Onboarding template");
  const base = startDate ? Date.parse(startDate + "T00:00:00Z") : Date.now();
  const mine = tpl.tasks.filter((t) => t.assignee === "employee").length;
  if (mine) {
    notify(companyId, [employeeId], {
      category: "onboarding",
      title: "Welcome aboard! You have onboarding tasks",
      body: `${mine} task${mine > 1 ? "s" : ""} to finish before your first day.`,
      link: { screen: "onboarding" },
    });
  }
  return db
    .insert(onboardingTasks)
    .values(
      tpl.tasks.map((t) => ({
        companyId,
        employeeId,
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        requiresDocument: t.requiresDocument,
        dueDate: new Date(base + t.dueInDays * 86_400_000).toISOString().slice(0, 10),
      })),
    )
    .returning();
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/templates", { preHandler: requireRole("manager") }, async (req) =>
    db.select().from(onboardingTemplates).where(eq(onboardingTemplates.companyId, req.user.companyId)),
  );

  app.post("/templates", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(onboardingTemplateSchema, req.body);
    const [row] = await db
      .insert(onboardingTemplates)
      .values({ ...body, companyId: req.user.companyId })
      .returning();
    return row;
  });

  app.post("/assign", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(z.object({ employeeId: z.string().uuid(), templateId: z.string().uuid() }), req.body);
    const [emp] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, body.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!emp) notFound("Employee");
    return applyOnboardingTemplate(req.user.companyId, emp.id, body.templateId, emp.startDate);
  });

  /** Tasks for one employee; employees can only see their own. */
  app.get<{ Querystring: { employeeId?: string; open?: string } }>("/tasks", async (req) => {
    const employeeId = isManager(req) && req.query.employeeId ? req.query.employeeId : req.user.sub;
    const filters = [eq(onboardingTasks.companyId, req.user.companyId), eq(onboardingTasks.employeeId, employeeId)];
    if (req.query.open === "true") filters.push(isNull(onboardingTasks.completedAt));
    return db
      .select()
      .from(onboardingTasks)
      .where(and(...filters))
      .orderBy(asc(onboardingTasks.dueDate));
  });

  /** Onboarding progress for everyone currently onboarding. */
  app.get("/progress", { preHandler: requireRole("manager") }, async (req) => {
    const tasks = await db.select().from(onboardingTasks).where(eq(onboardingTasks.companyId, req.user.companyId));
    const staff = await db
      .select()
      .from(employees)
      .where(and(eq(employees.companyId, req.user.companyId), eq(employees.status, "onboarding")));
    return staff.map((e) => {
      const mine = tasks.filter((t) => t.employeeId === e.id);
      return {
        employeeId: e.id,
        name: `${e.firstName} ${e.lastName}`,
        startDate: e.startDate,
        total: mine.length,
        done: mine.filter((t) => t.completedAt).length,
      };
    });
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/complete", async (req) => {
    const [task] = await db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.id, req.params.id), eq(onboardingTasks.companyId, req.user.companyId)));
    if (!task) notFound("Task");
    const ownTask = task.employeeId === req.user.sub && task.assignee === "employee";
    if (!ownTask && !isManager(req)) throw new HttpError(403, "This task is assigned to someone else");
    const [row] = await db
      .update(onboardingTasks)
      .set({ completedAt: new Date(), completedById: req.user.sub })
      .where(eq(onboardingTasks.id, task.id))
      .returning();

    // Flip the employee to active once every task is done.
    const remaining = await db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.employeeId, task.employeeId), isNull(onboardingTasks.completedAt)));
    if (remaining.length === 0) {
      await db
        .update(employees)
        .set({ status: "active" })
        .where(and(eq(employees.id, task.employeeId), eq(employees.status, "onboarding")));
    }
    return row;
  });
};

export default routes;

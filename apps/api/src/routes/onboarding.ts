import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { hasRole, onboardingTemplateSchema, type Role } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { documents, employees, onboardingTasks, onboardingTemplates } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { except, notify, staffWithRole } from "../lib/notify";
import { storage } from "../lib/storage";

type Task = typeof onboardingTasks.$inferSelect;
type Employee = typeof employees.$inferSelect;

/** Who a task is waiting on: the new hire, their manager (or admins if none), or the admins. */
export async function taskOwners(task: { assignee: string }, employee: Employee) {
  if (task.assignee === "employee") return [employee.id];
  if (task.assignee === "manager" && employee.managerId) return [employee.managerId];
  return staffWithRole(employee.companyId, "admin");
}

const name = (e: Employee) => `${e.firstName} ${e.lastName}`;

/**
 * Creates a new hire's tasks from a template. "Sign" tasks get their own copy
 * of the company document to sign. Everyone with tasks is told about them.
 */
export async function applyOnboardingTemplate(companyId: string, employeeId: string, templateId: string, actorId?: string) {
  const [tpl] = await db
    .select()
    .from(onboardingTemplates)
    .where(and(eq(onboardingTemplates.id, templateId), eq(onboardingTemplates.companyId, companyId)));
  if (!tpl) notFound("Onboarding template");
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId));
  const base = emp.startDate ? Date.parse(emp.startDate + "T00:00:00Z") : Date.now();

  const created: Task[] = [];
  for (const t of tpl.tasks) {
    let action = t.action ?? (t.requiresDocument ? "upload" : "none");
    let documentId: string | null = null;
    let description = t.description ?? null;
    if (action === "sign") {
      const [source] = t.documentId
        ? await db.select().from(documents).where(and(eq(documents.id, t.documentId), eq(documents.companyId, companyId)))
        : [];
      if (source) {
        const [copy] = await db
          .insert(documents)
          .values({
            companyId,
            employeeId,
            name: source.name,
            category: source.category,
            storageKey: source.storageKey,
            mimeType: source.mimeType,
            sizeBytes: source.sizeBytes,
            requiresSignature: true,
            uploadedById: actorId ?? source.uploadedById,
          })
          .returning();
        documentId = copy.id;
      } else {
        action = "none";
        description = [description, "(The document to sign was removed from the template; ask HR for a copy.)"].filter(Boolean).join(" ");
      }
    }
    const [task] = await db
      .insert(onboardingTasks)
      .values({
        companyId,
        employeeId,
        title: t.title,
        description,
        assignee: t.assignee,
        action,
        documentId,
        requiresDocument: action === "upload",
        dueDate: new Date(base + t.dueInDays * 86_400_000).toISOString().slice(0, 10),
      })
      .returning();
    created.push(task);
  }

  // Tell each person what's waiting on them (one message each).
  const byPerson = new Map<string, Task[]>();
  for (const task of created) {
    for (const id of await taskOwners(task, emp)) byPerson.set(id, [...(byPerson.get(id) ?? []), task]);
  }
  const start = emp.startDate ? ` (starts ${emp.startDate})` : "";
  for (const [personId, tasks] of byPerson) {
    const mine = personId === emp.id;
    // Someone without a login yet gets the invite email instead (it leads to the same checklist).
    if (mine && !emp.passwordHash) continue;
    notify(companyId, except([personId], actorId ?? ""), {
      category: "onboarding",
      title: mine ? "Welcome aboard! You have onboarding tasks" : `New hire ${name(emp)}${start}: ${tasks.length} task${tasks.length > 1 ? "s" : ""} for you`,
      body: mine ? `${tasks.length} task${tasks.length > 1 ? "s" : ""} to finish before your first day.` : tasks.map((t) => t.title).join(", "),
      link: { screen: "onboarding" },
    });
  }
  return created;
}

/**
 * Marks a task done and handles milestones: the manager hears when the new
 * hire has finished their own tasks, and everyone involved hears when the
 * whole checklist is done (which also makes the employee active).
 */
export async function completeTask(task: Task, actorId: string) {
  if (task.completedAt) return task;
  const [done] = await db
    .update(onboardingTasks)
    .set({ completedAt: new Date(), completedById: actorId })
    .where(and(eq(onboardingTasks.id, task.id), isNull(onboardingTasks.completedAt)))
    .returning();
  if (!done) return task;

  const remaining = await db
    .select()
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.employeeId, task.employeeId), isNull(onboardingTasks.completedAt)));
  const [emp] = await db.select().from(employees).where(eq(employees.id, task.employeeId));
  const managers = emp.managerId ? [emp.managerId] : await staffWithRole(emp.companyId, "admin");

  if (remaining.length === 0) {
    await db
      .update(employees)
      .set({ status: "active" })
      .where(and(eq(employees.id, emp.id), eq(employees.status, "onboarding")));
    notify(emp.companyId, except([...managers, ...(await staffWithRole(emp.companyId, "admin")), emp.id], actorId), {
      category: "onboarding",
      title: `${name(emp)} is fully onboarded`,
      body: "Every onboarding task is done. They're now active.",
      link: { screen: "onboarding" },
    });
  } else if (task.assignee === "employee" && !remaining.some((t) => t.assignee === "employee")) {
    notify(emp.companyId, except(managers, actorId), {
      category: "onboarding",
      title: `${name(emp)} finished their onboarding paperwork`,
      body: `${remaining.length} task${remaining.length > 1 ? "s" : ""} left for managers/admins: ${remaining.map((t) => t.title).join(", ")}`,
      link: { screen: "onboarding" },
    });
  }
  return done;
}

/** Completes the "sign" task for a document once it's signed. */
export async function completeSignTaskFor(documentId: string, actorId: string) {
  const [task] = await db
    .select()
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.documentId, documentId), eq(onboardingTasks.action, "sign"), isNull(onboardingTasks.completedAt)));
  if (task) await completeTask(task, actorId);
}

/** Tasks with their document (for upload/sign tasks) attached. */
async function withDocuments(tasks: Task[]) {
  const ids = tasks.map((t) => t.documentId).filter((x): x is string => !!x);
  const docs = ids.length ? await db.select().from(documents).where(inArray(documents.id, ids)) : [];
  return tasks.map((t) => {
    const d = docs.find((x) => x.id === t.documentId);
    return { ...t, document: d ? { id: d.id, name: d.name, signedAt: d.signedAt, mimeType: d.mimeType } : null };
  });
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/templates", { preHandler: requireRole("manager") }, async (req) =>
    db.select().from(onboardingTemplates).where(eq(onboardingTemplates.companyId, req.user.companyId)),
  );

  async function validateTemplate(req: FastifyRequest) {
    const body = parse(onboardingTemplateSchema, req.body);
    for (const t of body.tasks.filter((t) => t.action === "sign")) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.id, t.documentId!), eq(documents.companyId, req.user.companyId), isNull(documents.employeeId)));
      if (!doc) throw new HttpError(400, `"${t.title}": choose a company-wide document (upload it on the Documents page first)`);
    }
    return body;
  }

  app.post("/templates", { preHandler: requireRole("admin") }, async (req) => {
    const body = await validateTemplate(req);
    const [row] = await db
      .insert(onboardingTemplates)
      .values({ ...body, companyId: req.user.companyId })
      .returning();
    return row;
  });

  app.put<{ Params: { id: string } }>("/templates/:id", { preHandler: requireRole("admin") }, async (req) => {
    const body = await validateTemplate(req);
    const [row] = await db
      .update(onboardingTemplates)
      .set(body)
      .where(and(eq(onboardingTemplates.id, req.params.id), eq(onboardingTemplates.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Template");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", { preHandler: requireRole("admin") }, async (req) => {
    const [row] = await db
      .delete(onboardingTemplates)
      .where(and(eq(onboardingTemplates.id, req.params.id), eq(onboardingTemplates.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Template");
    return { ok: true };
  });

  app.post("/assign", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(z.object({ employeeId: z.string().uuid(), templateId: z.string().uuid() }), req.body);
    const [emp] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, body.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!emp) notFound("Employee");
    return applyOnboardingTemplate(req.user.companyId, emp.id, body.templateId, req.user.sub);
  });

  /** Tasks for one employee; employees can only see their own. */
  app.get<{ Querystring: { employeeId?: string; open?: string } }>("/tasks", async (req) => {
    const employeeId = isManager(req) && req.query.employeeId ? req.query.employeeId : req.user.sub;
    const filters = [eq(onboardingTasks.companyId, req.user.companyId), eq(onboardingTasks.employeeId, employeeId)];
    if (req.query.open === "true") filters.push(isNull(onboardingTasks.completedAt));
    const tasks = await db
      .select()
      .from(onboardingTasks)
      .where(and(...filters))
      .orderBy(asc(onboardingTasks.dueDate));
    return withDocuments(tasks);
  });

  /** Open tasks waiting on the signed-in manager/admin, across all new hires. */
  app.get("/assigned", { preHandler: requireRole("manager") }, async (req) => {
    const rows = await db
      .select({ task: onboardingTasks, employee: employees })
      .from(onboardingTasks)
      .innerJoin(employees, eq(employees.id, onboardingTasks.employeeId))
      .where(and(eq(onboardingTasks.companyId, req.user.companyId), isNull(onboardingTasks.completedAt), inArray(onboardingTasks.assignee, ["manager", "admin"])))
      .orderBy(asc(onboardingTasks.dueDate));
    const admin = hasRole(req.user.role, "admin");
    return rows
      .filter(({ task, employee }) =>
        task.assignee === "admin" ? admin : employee.managerId ? employee.managerId === req.user.sub : admin,
      )
      .map(({ task, employee }) => ({ ...task, employee: { id: employee.id, name: name(employee), startDate: employee.startDate } }));
  });

  /** Onboarding progress for everyone currently onboarding. */
  app.get("/progress", { preHandler: requireRole("manager") }, async (req) => {
    const tasks = await db.select().from(onboardingTasks).where(eq(onboardingTasks.companyId, req.user.companyId));
    const staff = await db
      .select()
      .from(employees)
      .where(and(eq(employees.companyId, req.user.companyId), eq(employees.status, "onboarding")));
    const today = new Date().toISOString().slice(0, 10);
    return staff.map((e) => {
      const mine = tasks.filter((t) => t.employeeId === e.id);
      return {
        employeeId: e.id,
        name: name(e),
        startDate: e.startDate,
        hasLogin: !!e.passwordHash,
        invitedAt: e.invitedAt,
        total: mine.length,
        done: mine.filter((t) => t.completedAt).length,
        overdue: mine.filter((t) => !t.completedAt && t.dueDate && t.dueDate < today).length,
      };
    });
  });

  async function loadTask(req: FastifyRequest, id: string) {
    const [task] = await db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.id, id), eq(onboardingTasks.companyId, req.user.companyId)));
    if (!task) notFound("Task");
    return task;
  }

  /**
   * Checks a task off. New hires can only check off plain tasks; upload and
   * sign tasks finish when they upload or sign. Managers and admins can check
   * off anything (e.g. they received a paper copy).
   */
  app.post<{ Params: { id: string } }>("/tasks/:id/complete", async (req) => {
    const task = await loadTask(req, req.params.id);
    const ownTask = task.employeeId === req.user.sub && task.assignee === "employee";
    if (!ownTask && !isManager(req)) throw new HttpError(403, "This task is assigned to someone else");
    if (!isManager(req) && task.action === "upload") throw new HttpError(400, "Upload the document to finish this task");
    if (!isManager(req) && task.action === "sign") throw new HttpError(400, "Sign the document to finish this task");
    if (task.assignee === "admin" && !hasRole(req.user.role as Role, "admin")) throw new HttpError(403, "This task is for an admin");
    return completeTask(task, req.user.sub);
  });

  /** Finishes an upload task by uploading the file (multipart field "file"). */
  app.post<{ Params: { id: string } }>("/tasks/:id/upload", async (req) => {
    const task = await loadTask(req, req.params.id);
    if (task.employeeId !== req.user.sub && !isManager(req)) throw new HttpError(403, "This task is assigned to someone else");
    if (task.action !== "upload") throw new HttpError(400, "This task doesn't take an upload");
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file uploaded");
    const buf = await file.toBuffer();
    if (!buf.length) throw new HttpError(400, "The file is empty");
    const key = `${req.user.companyId}/${randomUUID()}-${file.filename.replace(/[^\w.-]/g, "_")}`;
    await storage.put(key, buf);
    const [doc] = await db
      .insert(documents)
      .values({
        companyId: req.user.companyId,
        employeeId: task.employeeId,
        name: `${task.title}: ${file.filename}`,
        category: "onboarding",
        storageKey: key,
        mimeType: file.mimetype,
        sizeBytes: buf.length,
        uploadedById: req.user.sub,
      })
      .returning();
    await db.update(onboardingTasks).set({ documentId: doc.id }).where(eq(onboardingTasks.id, task.id));
    const done = await completeTask({ ...task, documentId: doc.id }, req.user.sub);
    return { ...done, documentId: doc.id };
  });
};

export default routes;

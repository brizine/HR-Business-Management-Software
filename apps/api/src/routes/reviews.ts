import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, ne, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { acknowledgeSchema, hasRole, recordInputSchema, recordTypeLabel, type RecordKind, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { employeeRecords, employees } from "../db/schema";
import { authenticate, isManager, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { notify } from "../lib/notify";

/** Which area of the Permissions page controls access here. */
const AREA = "reviews" as const;

const author = alias(employees, "author");
type Row = typeof employeeRecords.$inferSelect;

async function load(where: SQL) {
  const rows = await db
    .select({
      record: employeeRecords,
      employee: { id: employees.id, firstName: employees.firstName, lastName: employees.lastName, title: employees.title },
      author: { firstName: author.firstName, lastName: author.lastName },
    })
    .from(employeeRecords)
    .innerJoin(employees, eq(employees.id, employeeRecords.employeeId))
    .leftJoin(author, eq(author.id, employeeRecords.authorId))
    .where(where)
    .orderBy(desc(employeeRecords.date), desc(employeeRecords.createdAt));
  return rows.map((r) => ({
    ...r.record,
    employee: r.employee,
    authorName: r.author?.firstName ? `${r.author.firstName} ${r.author.lastName}` : null,
  }));
}

/** One record, if this person may see it: managers in this area see all; employees only their own shared ones. */
async function visible(req: FastifyRequest, id: string) {
  const [r] = await load(and(eq(employeeRecords.id, id), eq(employeeRecords.companyId, req.user.companyId))!);
  if (!r) notFound("Record");
  // Nobody sees drafts about themselves, managers included.
  if (r.employeeId === req.user.sub && r.status === "draft") notFound("Record");
  if (isManager(req, AREA)) return r;
  if (r.employeeId === req.user.sub && r.status !== "draft") return r;
  notFound("Record");
  return r;
}

/** May this person change (or delete) a record? Drafts: its author or an admin. Shared: admins only. */
function canChange(req: FastifyRequest, r: Row) {
  if (r.employeeId === req.user.sub) return false;
  if (hasRole(roleIn(req, AREA), "admin")) return true;
  return r.status === "draft" && r.authorId === req.user.sub && isManager(req, AREA);
}

/** Managers can't write records about themselves, or about someone at their own level or above (owners can). */
async function checkSubject(req: FastifyRequest, employeeId: string) {
  if (employeeId === req.user.sub) throw new HttpError(403, "You can't write a review or disciplinary action for yourself");
  const [who] = await db.select().from(employees).where(and(eq(employees.id, employeeId), eq(employees.companyId, req.user.companyId)));
  if (!who) notFound("Employee");
  // Their level here (a person given Manager access in this area counts as a manager).
  const mine = req.user.role === "owner" ? "owner" : roleIn(req, AREA);
  if (mine !== "owner" && hasRole(who.role as Role, mine)) throw new HttpError(403, "You can only write these for people below your own role");
  return who;
}

const fields = (body: ReturnType<typeof recordInputSchema.parse>) =>
  body.kind === "review"
    ? { kind: "review", type: body.type, date: body.date, periodStart: body.periodStart, periodEnd: body.periodEnd, rating: body.rating, summary: body.summary, strengths: body.strengths, improvements: body.improvements, goals: body.goals,
        reason: null, incidentDate: null, expectations: null, followUpDate: null }
    : { kind: "discipline", type: body.type, date: body.date, reason: body.reason, incidentDate: body.incidentDate, summary: body.summary, expectations: body.expectations, followUpDate: body.followUpDate,
        periodStart: null, periodEnd: null, rating: null, strengths: null, improvements: null, goals: null };

const noun = (kind: string) => (kind === "review" ? "review" : "disciplinary action");

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  /** Managers: everyone's (optionally one person's). Everyone else: their own shared records. */
  app.get<{ Querystring: { employeeId?: string; kind?: string } }>("/", async (req) => {
    const where: SQL[] = [eq(employeeRecords.companyId, req.user.companyId)];
    if (!isManager(req, AREA)) where.push(eq(employeeRecords.employeeId, req.user.sub), ne(employeeRecords.status, "draft"));
    else {
      if (req.query.employeeId) where.push(eq(employeeRecords.employeeId, req.query.employeeId));
      // Nobody sees drafts about themselves, managers included.
      where.push(or(ne(employeeRecords.employeeId, req.user.sub), ne(employeeRecords.status, "draft"))!);
    }
    if (req.query.kind === "review" || req.query.kind === "discipline") where.push(eq(employeeRecords.kind, req.query.kind));
    return load(and(...where)!);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => visible(req, req.params.id));

  /** A new draft (only managers see drafts). */
  app.post("/", async (req) => {
    if (!isManager(req, AREA)) throw new HttpError(403, "You don't have access to write reviews or disciplinary actions");
    const body = parse(recordInputSchema, req.body);
    await checkSubject(req, body.employeeId);
    const [row] = await db.insert(employeeRecords).values({ ...fields(body), companyId: req.user.companyId, employeeId: body.employeeId, authorId: req.user.sub }).returning();
    return visible(req, row.id);
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const current = await visible(req, req.params.id);
    if (!canChange(req, current)) throw new HttpError(403, current.status === "draft" ? "Only its author or an admin can edit this draft" : "Only admins can edit a record that's been shared");
    const body = parse(recordInputSchema, req.body);
    if (body.employeeId !== current.employeeId || body.kind !== current.kind) throw new HttpError(400, "Start a new record to change who it's for or what kind it is");
    await db.update(employeeRecords).set({ ...fields(body), updatedAt: new Date() }).where(eq(employeeRecords.id, current.id));
    return visible(req, current.id);
  });

  /** Shares a draft with the employee, who's notified and can acknowledge it. */
  app.post<{ Params: { id: string } }>("/:id/share", async (req) => {
    const r = await visible(req, req.params.id);
    if (!isManager(req, AREA) || r.employeeId === req.user.sub) throw new HttpError(403, "Only its author or an admin can share this");
    if (r.status !== "draft") throw new HttpError(409, "This has already been shared");
    if (!canChange(req, r)) throw new HttpError(403, "Only its author or an admin can share this");
    await db.update(employeeRecords).set({ status: "shared", sharedAt: new Date(), updatedAt: new Date() }).where(eq(employeeRecords.id, r.id));
    notify(req.user.companyId, [r.employeeId], {
      category: "reviews",
      title: `New ${noun(r.kind)}: ${recordTypeLabel(r.kind as RecordKind, r.type)}`,
      body: `${r.authorName ?? "Your manager"} shared it with you. Please read it and acknowledge that you've seen it.`,
      link: { screen: "reviews", id: r.id },
    });
    return visible(req, r.id);
  });

  /** The employee confirms they've seen it, optionally with their own comment. */
  app.post<{ Params: { id: string } }>("/:id/acknowledge", async (req) => {
    const r = await visible(req, req.params.id);
    if (r.employeeId !== req.user.sub) throw new HttpError(403, "Only the employee can acknowledge this");
    if (r.status !== "shared") throw new HttpError(409, "This has already been acknowledged");
    const { comment } = parse(acknowledgeSchema, req.body ?? {});
    await db.update(employeeRecords).set({ status: "acknowledged", acknowledgedAt: new Date(), employeeComment: comment || null, updatedAt: new Date() }).where(eq(employeeRecords.id, r.id));
    notify(req.user.companyId, [r.authorId], {
      category: "reviews",
      title: `${r.employee.firstName} ${r.employee.lastName} acknowledged their ${noun(r.kind)}`,
      body: comment ? `Their comment: "${comment}"` : `${recordTypeLabel(r.kind as RecordKind, r.type)} from ${r.date}.`,
      link: { screen: "reviews", id: r.id },
    });
    return visible(req, r.id);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const r = await visible(req, req.params.id);
    if (!canChange(req, r)) throw new HttpError(403, r.status === "draft" ? "Only its author or an admin can delete this draft" : "Only admins can delete a record that's been shared");
    await db.delete(employeeRecords).where(eq(employeeRecords.id, r.id));
    return { ok: true };
  });
};

export default routes;

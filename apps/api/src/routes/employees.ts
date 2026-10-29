import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import { employeeSchema, hasRole } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { employees } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

type EmployeeRow = typeof employees.$inferSelect;

export function publicEmployee(e: EmployeeRow) {
  const { passwordHash, ...rest } = e;
  return { ...rest, hasLogin: !!passwordHash };
}

/** Strips pay details for viewers who are not managers. */
function directoryView(e: EmployeeRow) {
  const { payRateCents, payType, payrollProviderEmployeeId, ...rest } = publicEmployee(e);
  return rest;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) => {
    const rows = await db
      .select()
      .from(employees)
      .where(eq(employees.companyId, req.user.companyId))
      .orderBy(asc(employees.lastName), asc(employees.firstName));
    return hasRole(req.user.role, "manager") ? rows.map(publicEmployee) : rows.map(directoryView);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const [row] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, req.params.id), eq(employees.companyId, req.user.companyId)));
    if (!row) notFound("Employee");
    const canSeePay = hasRole(req.user.role, "manager") || row.id === req.user.sub;
    return canSeePay ? publicEmployee(row) : directoryView(row);
  });

  app.post("/", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(employeeSchema, req.body);
    if (body.role === "owner" && req.user.role !== "owner") throw new HttpError(403, "Only owners can add owners");
    const { password, ...rest } = body;
    const [row] = await db
      .insert(employees)
      .values({
        ...rest,
        email: rest.email.toLowerCase(),
        companyId: req.user.companyId,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
      })
      .returning();
    return publicEmployee(row);
  });

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(employeeSchema.partial(), req.body);
    if (body.role === "owner" && req.user.role !== "owner") throw new HttpError(403, "Only owners can add owners");
    const { password, ...rest } = body;
    const [row] = await db
      .update(employees)
      .set({
        ...rest,
        ...(rest.email ? { email: rest.email.toLowerCase() } : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      })
      .where(and(eq(employees.id, req.params.id), eq(employees.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Employee");
    return publicEmployee(row);
  });

  /** Lets an employee update their own contact info and password. */
  app.patch("/me/profile", async (req) => {
    const body = parse(z.object({ phone: z.string().optional(), password: z.string().min(8).optional() }), req.body);
    const [row] = await db
      .update(employees)
      .set({
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 10) } : {}),
      })
      .where(eq(employees.id, req.user.sub))
      .returning();
    return publicEmployee(row);
  });
};

export default routes;

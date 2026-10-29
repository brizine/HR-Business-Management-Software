import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import { employeeSchema, hasRole, type Role } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { employees, recoveryCodes } from "../db/schema";
import { authenticate, canManageAccount, requireRole, signOutEverywhere } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

type EmployeeRow = typeof employees.$inferSelect;

/** Never sends password hashes, two-factor secrets or lockout counters to clients. */
export function publicEmployee(e: EmployeeRow) {
  const { passwordHash, totpSecret, totpPendingSecret, totpLastStep, tokenVersion, failedLoginCount, lockedUntil, ...rest } = e;
  return {
    ...rest,
    hasLogin: !!passwordHash,
    twoFactorEnabled: !!totpSecret,
    locked: !!lockedUntil && lockedUntil > new Date(),
  };
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
    if (!canManageAccount(req.user.role, body.role)) throw new HttpError(403, "Only the owner can add admins and owners");
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

  /** Loads someone in the caller's company that the caller is allowed to manage. */
  async function manageable(req: { user: { companyId: string; sub: string; role: Role } }, id: string, allowSelf = true) {
    const [target] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), eq(employees.companyId, req.user.companyId)));
    if (!target) notFound("Employee");
    const self = target.id === req.user.sub;
    if (self ? !allowSelf : !canManageAccount(req.user.role, target.role as Role)) {
      throw new HttpError(403, self ? "Use your Security settings for your own account" : "Only the owner can change another admin's or the owner's account");
    }
    return target;
  }

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(employeeSchema.partial(), req.body);
    const target = await manageable(req, req.params.id);
    if (body.role && body.role !== target.role) {
      if (target.id === req.user.sub) throw new HttpError(403, "You can't change your own role");
      if (!canManageAccount(req.user.role, body.role)) throw new HttpError(403, "Only the owner can make someone an admin or owner");
    }
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
    // Anything that changes who can sign in, or as what, ends their current sessions.
    const changedAccess =
      !!password ||
      (rest.email !== undefined && rest.email.toLowerCase() !== target.email) ||
      (rest.role !== undefined && rest.role !== target.role) ||
      (rest.status === "terminated" && target.status !== "terminated");
    return publicEmployee(changedAccess ? await signOutEverywhere(row.id) : row);
  });

  /** Ends all of someone's sessions, e.g. a lost phone or the day they leave. */
  app.post<{ Params: { id: string } }>("/:id/sign-out-everywhere", { preHandler: requireRole("admin") }, async (req) => {
    const target = await manageable(req, req.params.id);
    await signOutEverywhere(target.id);
    return { ok: true };
  });

  /**
   * For someone who lost their phone and backup codes: turns two-factor off
   * and signs them out. If their role requires it, they'll set it up again at
   * their next sign-in. Unlocks the account too.
   */
  app.post<{ Params: { id: string } }>("/:id/reset-two-factor", { preHandler: requireRole("admin") }, async (req) => {
    const target = await manageable(req, req.params.id, false);
    await db
      .update(employees)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, failedLoginCount: 0, lockedUntil: null })
      .where(eq(employees.id, target.id));
    await db.delete(recoveryCodes).where(eq(recoveryCodes.employeeId, target.id));
    await signOutEverywhere(target.id);
    return { ok: true };
  });

  /** Unlocks an account locked by too many failed sign-in attempts. */
  app.post<{ Params: { id: string } }>("/:id/unlock", { preHandler: requireRole("admin") }, async (req) => {
    const target = await manageable(req, req.params.id);
    await db.update(employees).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(employees.id, target.id));
    return { ok: true };
  });

  /** Lets an employee update their own contact info. Passwords change via /auth/password. */
  app.patch("/me/profile", async (req) => {
    const body = parse(z.object({ phone: z.string().optional() }), req.body);
    const [row] = await db
      .update(employees)
      .set(body.phone !== undefined ? { phone: body.phone } : {})
      .where(eq(employees.id, req.user.sub))
      .returning();
    return publicEmployee(row);
  });
};

export default routes;

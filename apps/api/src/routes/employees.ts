import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import { EMPLOYEE_PRIVATE_CONTACT_FIELDS, employeeContactSchema, employeeSchema, hasRole, isInactive, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { employees, recoveryCodes } from "../db/schema";
import { authenticate, canManageAccount, requireRole, signOutEverywhere } from "../lib/auth";
import { sendInvite } from "../lib/invites";

async function actorName(id: string) {
  const [e] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, id));
  return e ? `${e.f} ${e.l}` : undefined;
}
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

/** Strips pay, home address, emergency contact and the reason someone left for viewers who are not managers. */
function directoryView(e: EmployeeRow) {
  const { payRateCents, payType, payrollProviderEmployeeId, statusReason, statusChangedById, ...rest } = publicEmployee(e);
  for (const f of EMPLOYEE_PRIVATE_CONTACT_FIELDS) delete (rest as Partial<EmployeeRow>)[f];
  return rest;
}

/** Someone looking at their own record: everything except the notes managers keep about them leaving. */
function ownView(e: EmployeeRow) {
  const { statusReason, statusChangedById, ...rest } = publicEmployee(e);
  return rest;
}

/** Fills in the reason and who/when for a status change; the reason only applies to inactive and terminated. */
function statusFields(body: { status?: string; statusReason?: string | null }, before: EmployeeRow | null, actorId: string) {
  const status = body.status ?? before?.status ?? "active";
  const changed = status !== (before?.status ?? "active");
  const out: Partial<EmployeeRow> = {};
  if (!isInactive(status)) out.statusReason = null;
  else if (body.statusReason !== undefined) out.statusReason = body.statusReason || null;
  if (changed || (out.statusReason !== undefined && out.statusReason !== (before?.statusReason ?? null))) {
    out.statusChangedAt = new Date();
    out.statusChangedById = actorId;
  }
  return out;
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
    if (hasRole(req.user.role, "manager")) return publicEmployee(row);
    return row.id === req.user.sub ? ownView(row) : directoryView(row);
  });

  app.post("/", { preHandler: requireRole("admin") }, async (req) => {
    const body = parse(employeeSchema, req.body);
    if (!canManageAccount(req.user.role, body.role)) throw new HttpError(403, "Only the owner can add admins and owners");
    const { password, sendInvite: wantsInvite, statusReason, ...rest } = body;
    const [row] = await db
      .insert(employees)
      .values({
        ...rest,
        ...(isInactive(rest.status) ? statusFields(body, null, req.user.sub) : {}),
        email: rest.email.toLowerCase(),
        companyId: req.user.companyId,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
      })
      .returning();
    // No password given: by default, email them a link to choose one.
    const invite = !password && (wantsInvite ?? true) ? await sendInvite(row, await actorName(req.user.sub)) : null;
    return { ...publicEmployee(invite ? { ...row, invitedAt: new Date() } : row), invite };
  });

  /**
   * (Re)sends the "set up your account" email. The response includes the link
   * so an admin can text it if email isn't set up or didn't arrive.
   */
  app.post<{ Params: { id: string } }>("/:id/invite", { preHandler: requireRole("admin") }, async (req) => {
    const target = await manageable(req, req.params.id, false);
    if (target.passwordHash) throw new HttpError(409, `${target.firstName} already has a login. They can use "Forgot your password?" if needed.`);
    if (isInactive(target.status)) throw new HttpError(409, `This person is ${target.status}. Make them active first.`);
    return sendInvite(target, await actorName(req.user.sub));
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
    const { password, statusReason, ...rest } = body;
    const [row] = await db
      .update(employees)
      .set({
        ...rest,
        ...statusFields(body, target, req.user.sub),
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
      (isInactive(rest.status) && !isInactive(target.status));
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

  /** Lets an employee update their own phone, home address and emergency contact. Passwords change via /auth/password. */
  app.patch("/me/profile", async (req) => {
    const body = parse(employeeContactSchema, req.body);
    const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const [row] = Object.keys(changes).length
      ? await db.update(employees).set(changes).where(eq(employees.id, req.user.sub)).returning()
      : await db.select().from(employees).where(eq(employees.id, req.user.sub));
    return ownView(row);
  });
};

export default routes;

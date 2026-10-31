import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { and, asc, eq } from "drizzle-orm";
import { EMPLOYEE_PRIVATE_CONTACT_FIELDS, employeeContactSchema, employeeMenusSchema, employeeSchema, hasRole, isInactive, menuRenameSchema, normalizeTeamFilterLayout, orderProfileFields, profileFieldOrderSchema, teamFilterLayoutSchema, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees, jobs, recoveryCodes } from "../db/schema";
import { authenticate, canManageAccount, requireRole, signOutEverywhere } from "../lib/auth";
import { sendInvite } from "../lib/invites";
import { storage } from "../lib/storage";

async function actorName(id: string) {
  const [e] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(eq(employees.id, id));
  return e ? `${e.f} ${e.l}` : undefined;
}
import { HttpError, notFound, parse } from "../lib/errors";

type EmployeeRow = typeof employees.$inferSelect;

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** The image type from the file's first bytes (not its name or claimed type), or null if it isn't one we accept. */
function imageType(b: Buffer) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Never sends password hashes, two-factor secrets or lockout counters to clients. */
export function publicEmployee(e: EmployeeRow) {
  const { passwordHash, totpSecret, totpPendingSecret, totpLastStep, tokenVersion, failedLoginCount, lockedUntil, photoKey, ...rest } = e;
  return {
    ...rest,
    hasLogin: !!passwordHash,
    twoFactorEnabled: !!totpSecret,
    hasPhoto: !!photoKey,
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

  // ---- Job title and Department menus (owner edits; everyone can read) ----

  async function menus(companyId: string) {
    const [c] = await db.select({ jobTitles: companies.jobTitles, departments: companies.departments }).from(companies).where(eq(companies.id, companyId));
    const used = await db.select({ title: employees.title, department: employees.department }).from(employees).where(eq(employees.companyId, companyId));
    const count = (vals: (string | null)[]) => vals.reduce<Record<string, number>>((n, v) => (v ? { ...n, [v]: (n[v] ?? 0) + 1 } : n), {});
    return { jobTitles: c.jobTitles, departments: c.departments, usage: { jobTitles: count(used.map((u) => u.title)), departments: count(used.map((u) => u.department)) } };
  }

  app.get("/menus", async (req) => menus(req.user.companyId));

  /** Replaces the lists (adding, removing, reordering). Removing an entry leaves people who have it as they are. */
  app.put("/menus", { preHandler: requireRole("owner") }, async (req) => {
    const body = parse(employeeMenusSchema, req.body);
    await db.update(companies).set(body).where(eq(companies.id, req.user.companyId));
    return menus(req.user.companyId);
  });

  /** Renames an entry everywhere: the list, everyone who has it, and (for departments) job postings. */
  app.post("/menus/rename", { preHandler: requireRole("owner") }, async (req) => {
    const { kind, from, to } = parse(menuRenameSchema, req.body);
    const current = await menus(req.user.companyId);
    const list = current[kind];
    if (!list.includes(from)) notFound("Menu entry");
    if (from !== to && list.includes(to)) throw new HttpError(409, `"${to}" is already on the list`);
    await db.transaction(async (tx) => {
      await tx.update(companies).set({ [kind]: list.map((v) => (v === from ? to : v)) }).where(eq(companies.id, req.user.companyId));
      const col = kind === "jobTitles" ? employees.title : employees.department;
      await tx.update(employees).set(kind === "jobTitles" ? { title: to } : { department: to }).where(and(eq(employees.companyId, req.user.companyId), eq(col, from)));
      if (kind === "departments") await tx.update(jobs).set({ department: to }).where(and(eq(jobs.companyId, req.user.companyId), eq(jobs.department, from)));
    });
    return menus(req.user.companyId);
  });

  /** The Team page's filters: their order and which are hidden (the same for everyone in the company). */
  app.get("/team-filters", async (req) => {
    const [c] = await db.select({ layout: companies.teamFilterLayout }).from(companies).where(eq(companies.id, req.user.companyId));
    return normalizeTeamFilterLayout(c?.layout);
  });

  app.put("/team-filters", { preHandler: requireRole("owner") }, async (req) => {
    const layout = normalizeTeamFilterLayout(parse(teamFilterLayoutSchema, req.body));
    await db.update(companies).set({ teamFilterLayout: layout }).where(eq(companies.id, req.user.companyId));
    return layout;
  });

  /** The order of the details on employee pages (the same for everyone in the company). */
  app.get("/field-order", async (req) => {
    const [c] = await db.select({ order: companies.profileFieldOrder }).from(companies).where(eq(companies.id, req.user.companyId));
    return { order: orderProfileFields(c?.order) };
  });

  app.put("/field-order", { preHandler: requireRole("owner") }, async (req) => {
    const { order } = parse(profileFieldOrderSchema, req.body);
    const full = orderProfileFields(order);
    await db.update(companies).set({ profileFieldOrder: full }).where(eq(companies.id, req.user.companyId));
    return { order: full };
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

  // ---- Profile photos ----

  /** Admins can set anyone's photo (within canManageAccount); everyone can set their own. */
  async function photoTarget(req: { user: { companyId: string; sub: string; role: Role } }, id: string) {
    if (id === req.user.sub) {
      const [me] = await db.select().from(employees).where(eq(employees.id, id));
      return me;
    }
    if (!hasRole(req.user.role, "admin")) throw new HttpError(403, "You can only change your own photo");
    return manageable(req, id);
  }

  /** multipart/form-data with one image (JPEG, PNG or WebP, up to 5 MB). */
  app.put<{ Params: { id: string } }>("/:id/photo", async (req) => {
    const target = await photoTarget(req, req.params.id);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No photo uploaded");
    const buf = await file.toBuffer();
    if (buf.length > MAX_PHOTO_BYTES) throw new HttpError(400, "That photo is too large (5 MB max)");
    if (!imageType(buf)) throw new HttpError(400, "Use a JPEG, PNG or WebP photo");
    const key = `${req.user.companyId}/photos/${target.id}-${randomUUID()}`;
    await storage.put(key, buf);
    const [row] = await db.update(employees).set({ photoKey: key, photoUpdatedAt: new Date() }).where(eq(employees.id, target.id)).returning();
    return publicEmployee(row);
  });

  app.delete<{ Params: { id: string } }>("/:id/photo", async (req) => {
    const target = await photoTarget(req, req.params.id);
    const [row] = await db.update(employees).set({ photoKey: null, photoUpdatedAt: new Date() }).where(eq(employees.id, target.id)).returning();
    return publicEmployee(row);
  });

  /** Anyone in the company can see coworkers' photos. Add ?v=<photoUpdatedAt> so a new photo isn't served from cache. */
  app.get<{ Params: { id: string } }>("/:id/photo", async (req, reply) => {
    const [row] = await db
      .select({ photoKey: employees.photoKey })
      .from(employees)
      .where(and(eq(employees.id, req.params.id), eq(employees.companyId, req.user.companyId)));
    if (!row?.photoKey) notFound("Photo");
    const buf = await storage.get(row.photoKey);
    reply.header("Content-Type", imageType(buf) ?? "application/octet-stream");
    reply.header("Cache-Control", "private, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buf);
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

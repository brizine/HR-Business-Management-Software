import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CONFIGURABLE_ROLES, PERMISSION_AREAS, PERMISSION_AREA_KEYS, ROLES, isInactive, maxLevel, hasRole, roleDefaultLevel, type PermissionArea, type Role, type RoleAccess } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employeePermissions, employees } from "../db/schema";
import { authenticate } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

/** Owners, and people the owner (or another permissions manager) gave Permissions access. */
function requireManagesPermissions(req: FastifyRequest) {
  if (!req.user.managesPermissions) throw new HttpError(403, "You don't have access to permissions");
}

/** Area → level; null or left out means what their role gets. */
const areaLevels = z.record(z.enum(PERMISSION_AREA_KEYS as [string, ...string[]]), z.enum(ROLES).nullable());

const updateSchema = z.object({
  /** Area → level for this person; areas left out (or null) go back to what their role gives them. */
  areas: areaLevels,
  /** May this person manage permissions? Only the owner can change this. */
  managesPermissions: z.boolean().optional(),
});

async function roleAccessOf(companyId: string): Promise<RoleAccess> {
  const [c] = await db.select({ roleAccess: companies.roleAccess }).from(companies).where(eq(companies.id, companyId));
  return c?.roleAccess ?? {};
}

/** Checks a level is allowed in an area (its maximum; owner-level only from the owner). */
function checkLevel(area: string, level: Role, isOwner: boolean) {
  const max = maxLevel(area as never);
  if (hasRole(level, max) && level !== max) throw new HttpError(400, `The most anyone can have in ${PERMISSION_AREAS.find((a) => a.key === area)?.label} is ${max}`);
  if (level === "owner" && !isOwner) throw new HttpError(403, "Only the owner can give owner-level access");
}

async function listFor(companyId: string) {
  const staff = await db.select().from(employees).where(eq(employees.companyId, companyId));
  const grants = await db.select().from(employeePermissions).where(eq(employeePermissions.companyId, companyId));
  return {
    areas: PERMISSION_AREAS,
    roleAccess: await roleAccessOf(companyId),
    people: staff
      .filter((e) => !isInactive(e.status))
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))
      .map((e) => {
        const mine = grants.filter((g) => g.employeeId === e.id);
        return {
          id: e.id,
          firstName: e.firstName,
          lastName: e.lastName,
          role: e.role,
          title: e.title,
          areas: Object.fromEntries(mine.filter((g) => g.area !== "permissions").map((g) => [g.area, g.level])),
          managesPermissions: e.role === "owner" || mine.some((g) => g.area === "permissions"),
        };
      }),
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", async (req) => requireManagesPermissions(req));

  app.get("/", async (req) => listFor(req.user.companyId));

  /**
   * The owner sets what each role gets in each area (Settings → Layout Editor). Areas left out (or
   * null) go back to the role itself. Owners always have full access, so they aren't set here.
   */
  app.put<{ Params: { role: string } }>("/roles/:role", async (req) => {
    if (req.user.role !== "owner") throw new HttpError(403, "Only the owner can change what each role can do");
    const role = req.params.role as (typeof CONFIGURABLE_ROLES)[number];
    if (!CONFIGURABLE_ROLES.includes(role)) throw new HttpError(400, "Owners always have full access");
    const { areas } = parse(z.object({ areas: areaLevels }), req.body);
    const levels: Partial<Record<PermissionArea, Role>> = {};
    for (const [area, level] of Object.entries(areas)) {
      if (!level) continue;
      checkLevel(area, level, true);
      if (level !== role) levels[area as PermissionArea] = level; // the role itself: nothing to store
    }
    const next = { ...(await roleAccessOf(req.user.companyId)), [role]: levels };
    await db.update(companies).set({ roleAccess: next }).where(eq(companies.id, req.user.companyId));
    return listFor(req.user.companyId);
  });

  /** Sets one person's access by area. Owners can't be limited; nobody changes their own access. */
  app.put<{ Params: { employeeId: string } }>("/:employeeId", async (req) => {
    const body = parse(updateSchema, req.body);
    const [target] = await db.select().from(employees).where(and(eq(employees.id, req.params.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!target) notFound("Employee");
    if (target.role === "owner") throw new HttpError(400, "Owners always have full access");
    if (target.id === req.user.sub) throw new HttpError(403, "You can't change your own access");
    const isOwner = req.user.role === "owner";
    const current = await db.select().from(employeePermissions).where(eq(employeePermissions.employeeId, target.id));
    const currentPerms = current.some((g) => g.area === "permissions");
    if (body.managesPermissions !== undefined && body.managesPermissions !== currentPerms && !isOwner) {
      throw new HttpError(403, "Only the owner can give or take away Permissions access");
    }
    const rows: { area: string; level: Role }[] = [];
    const roleAccess = await roleAccessOf(req.user.companyId);
    for (const [area, level] of Object.entries(body.areas)) {
      if (!level) continue;
      checkLevel(area, level, isOwner);
      if (level === roleDefaultLevel(target.role as Role, roleAccess, area as PermissionArea)) continue; // same as their role gets: nothing to store
      rows.push({ area, level });
    }
    const keepPerms = body.managesPermissions ?? currentPerms;
    await db.transaction(async (tx) => {
      await tx.delete(employeePermissions).where(eq(employeePermissions.employeeId, target.id));
      const values = [...rows, ...(keepPerms ? [{ area: "permissions", level: "admin" as Role }] : [])];
      if (values.length) await tx.insert(employeePermissions).values(values.map((v) => ({ ...v, companyId: req.user.companyId, employeeId: target.id })));
    });
    return (await listFor(req.user.companyId)).people.find((p) => p.id === target.id);
  });
};

export default routes;

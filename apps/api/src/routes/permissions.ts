import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSION_AREAS, PERMISSION_AREA_KEYS, ROLES, isInactive, maxLevel, hasRole, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { employeePermissions, employees } from "../db/schema";
import { authenticate } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

/** Owners, and people the owner (or another permissions manager) gave Permissions access. */
function requireManagesPermissions(req: FastifyRequest) {
  if (!req.user.managesPermissions) throw new HttpError(403, "You don't have access to permissions");
}

const updateSchema = z.object({
  /** Area → level for this person; areas left out (or null) go back to what their role gives them. */
  areas: z.record(z.enum(PERMISSION_AREA_KEYS as [string, ...string[]]), z.enum(ROLES).nullable()),
  /** May this person manage permissions? Only the owner can change this. */
  managesPermissions: z.boolean().optional(),
});

async function listFor(companyId: string) {
  const staff = await db.select().from(employees).where(eq(employees.companyId, companyId));
  const grants = await db.select().from(employeePermissions).where(eq(employeePermissions.companyId, companyId));
  return {
    areas: PERMISSION_AREAS,
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
    for (const [area, level] of Object.entries(body.areas)) {
      if (!level) continue;
      const max = maxLevel(area as never);
      if (hasRole(level, max) && level !== max) throw new HttpError(400, `The most anyone can have in ${PERMISSION_AREAS.find((a) => a.key === area)?.label} is ${max}`);
      if (level === "owner" && !isOwner) throw new HttpError(403, "Only the owner can give owner-level access");
      if (level === target.role) continue; // same as their role: nothing to store
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

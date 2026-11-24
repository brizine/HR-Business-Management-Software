import type { FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { hasRole, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { chemicalAccess } from "../db/schema";
import { HttpError } from "./errors";

/** Admins always; everyone else only when an admin has added them to Chemical Tracking's access list. */
export async function hasChemicalAccess(req: FastifyRequest) {
  if (hasRole(req.user.role as Role, "admin")) return true;
  const [row] = await db.select({ id: chemicalAccess.employeeId }).from(chemicalAccess)
    .where(and(eq(chemicalAccess.employeeId, req.user.sub), eq(chemicalAccess.companyId, req.user.companyId)));
  return !!row;
}

/** A route hook: Chemical Tracking only (products, rates, methods, records, certifications). */
export async function requireChemicalAccess(req: FastifyRequest) {
  if (!(await hasChemicalAccess(req))) throw new HttpError(403, "Chemical Tracking is limited to admins and the people they add");
}

/** Only admins change who has access. */
export async function requireAdmin(req: FastifyRequest) {
  if (!hasRole(req.user.role as Role, "admin")) throw new HttpError(403, "Only admins change who can use Chemical Tracking");
}

import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { packageSchema, type PackageInput } from "@crewdesk/shared";
import { db } from "../db";
import { packageLines, packages, serviceTypes } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

const AREA = "customers" as const;

async function packageList(companyId: string, all: boolean) {
  const rows = await db.select().from(packages).where(and(eq(packages.companyId, companyId), ...(all ? [] : [eq(packages.active, true)])))
    .orderBy(asc(packages.sortOrder), asc(packages.name));
  const ids = rows.map((p) => p.id);
  const lines = ids.length ? await db.select().from(packageLines).where(inArray(packageLines.packageId, ids)).orderBy(asc(packageLines.sortOrder)) : [];
  return rows.map((p) => ({ ...p, lines: lines.filter((l) => l.packageId === p.id) }));
}

async function checkServices(companyId: string, body: PackageInput) {
  const svc = [...new Set(body.lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
  if (!svc.length) return;
  const found = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, svc)));
  if (found.length !== svc.length) throw new HttpError(400, "One of those services isn't on the price list");
}
const lineRows = (packageId: string, body: PackageInput) => body.lines.map((l, i) => ({
  packageId, serviceTypeId: l.serviceTypeId ?? null, description: l.description, quantity: l.quantity, budgetedHours: l.budgetedHours ?? null, unitPriceCents: l.unitPriceCents ?? null, sortOrder: i,
}));

/** Packages (like Homeworks'): Customers & billing managers use them on work orders; admins (who keep the price list) change them. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  app.get<{ Querystring: { all?: string } }>("/", async (req) => packageList(req.user.companyId, req.query.all === "1"));

  app.post("/", admin, async (req) => {
    const body = parse(packageSchema, req.body);
    await checkServices(req.user.companyId, body);
    const id = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: max(packages.sortOrder) }).from(packages).where(eq(packages.companyId, req.user.companyId));
      const [p] = await tx.insert(packages).values({ companyId: req.user.companyId, name: body.name, description: body.description ?? null, active: body.active, sortOrder: (n ?? -1) + 1 }).returning();
      await tx.insert(packageLines).values(lineRows(p.id, body));
      return p.id;
    });
    return (await packageList(req.user.companyId, true)).find((p) => p.id === id);
  });

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const body = parse(packageSchema, req.body);
    const [p] = await db.select().from(packages).where(and(eq(packages.id, req.params.id), eq(packages.companyId, req.user.companyId)));
    if (!p) notFound("Package");
    await checkServices(req.user.companyId, body);
    await db.transaction(async (tx) => {
      await tx.update(packages).set({ name: body.name, description: body.description ?? null, active: body.active }).where(eq(packages.id, p.id));
      await tx.delete(packageLines).where(eq(packageLines.packageId, p.id));
      await tx.insert(packageLines).values(lineRows(p.id, body));
    });
    return (await packageList(req.user.companyId, true)).find((x) => x.id === p.id);
  });

  /** Work orders already made from a package keep their line items. */
  app.delete<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const rows = await db.delete(packages).where(and(eq(packages.id, req.params.id), eq(packages.companyId, req.user.companyId))).returning({ id: packages.id });
    if (!rows.length) notFound("Package");
    return { ok: true };
  });

  app.put("/order", admin, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(500) }), req.body);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(packages).set({ sortOrder: i }).where(and(eq(packages.id, id), eq(packages.companyId, req.user.companyId)));
    });
    return { ok: true };
  });
};

export default routes;

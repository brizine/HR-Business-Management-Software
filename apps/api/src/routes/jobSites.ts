import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { jobSiteSchema } from "@crewdesk/shared";
import { db } from "../db";
import { jobSites } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { notFound, parse } from "../lib/errors";

/** Job sites for geofenced clock-in/out. Everyone can see them (so crews know where punches count); managers edit. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) =>
    db.select().from(jobSites).where(eq(jobSites.companyId, req.user.companyId)).orderBy(asc(jobSites.name)),
  );

  app.post("/", { preHandler: requireRole("manager") }, async (req) => {
    const body = parse(jobSiteSchema, req.body);
    const [row] = await db.insert(jobSites).values({ ...body, companyId: req.user.companyId }).returning();
    return row;
  });

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager") }, async (req) => {
    const body = parse(jobSiteSchema.partial(), req.body);
    const [row] = await db
      .update(jobSites)
      .set(body)
      .where(and(eq(jobSites.id, req.params.id), eq(jobSites.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Job site");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager") }, async (req) => {
    const [row] = await db
      .delete(jobSites)
      .where(and(eq(jobSites.id, req.params.id), eq(jobSites.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Job site");
    return { ok: true };
  });
};

export default routes;

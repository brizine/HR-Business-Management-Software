import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { jobSiteSchema } from "@crewdesk/shared";
import { db } from "../db";
import { jobSites } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { geocode } from "../lib/geocode";
import { z } from "zod";

/** Which area of the Permissions page controls access here. */
const AREA = "time" as const;

/** Job sites for geofenced clock-in/out. Everyone can see them (so crews know where punches count); managers edit. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) =>
    db.select().from(jobSites).where(eq(jobSites.companyId, req.user.companyId)).orderBy(asc(jobSites.name)),
  );

  /** Turns an address, a maps link (including short share links) or "lat, lng" into coordinates. */
  app.post("/geocode", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const { query } = parse(z.object({ query: z.string().trim().min(1, "Type an address or paste a map link").max(1000) }), req.body);
    const found = await geocode(query);
    if (!found) throw new HttpError(404, "Couldn't find that place. Check the address (street, city and state), or paste a Google Maps link or \"latitude, longitude\".");
    return found;
  });

  app.post("/", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(jobSiteSchema, req.body);
    const [row] = await db.insert(jobSites).values({ ...body, companyId: req.user.companyId }).returning();
    return row;
  });

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const body = parse(jobSiteSchema.partial(), req.body);
    const [row] = await db
      .update(jobSites)
      .set(body)
      .where(and(eq(jobSites.id, req.params.id), eq(jobSites.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Job site");
    return row;
  });

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const [row] = await db
      .delete(jobSites)
      .where(and(eq(jobSites.id, req.params.id), eq(jobSites.companyId, req.user.companyId)))
      .returning();
    if (!row) notFound("Job site");
    return { ok: true };
  });
};

export default routes;

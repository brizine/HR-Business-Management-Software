import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { offSeasonSchema } from "@crewdesk/shared";
import { db } from "../db";
import { offSeasons } from "../db/schema";
import { authenticate, isManager } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

/** Managers of to-dos or of customers (who schedule work orders) keep the list. */
function requireKeeper(req: FastifyRequest) {
  if (!isManager(req, "todos") && !isManager(req, "customers")) throw new HttpError(403, "Adding off-seasons needs To-dos or Customers & billing manager access");
}

const view = (s: typeof offSeasons.$inferSelect) => ({ id: s.id, name: s.name, start: s.startMd, end: s.endMd });

/**
 * Off-seasons (Homeworks' "Available Seasons"): named stretches of the year, like Winter from
 * Dec 1 to Feb 28, that repeating to-dos can pause in. Everyone can read them.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) => (await db.select().from(offSeasons).where(eq(offSeasons.companyId, req.user.companyId)).orderBy(asc(offSeasons.name))).map(view));

  const uniqueName = async (companyId: string, name: string, notId?: string) => {
    const [dupe] = await db.select({ id: offSeasons.id }).from(offSeasons)
      .where(and(eq(offSeasons.companyId, companyId), sql`lower(${offSeasons.name}) = lower(${name})`, notId ? ne(offSeasons.id, notId) : undefined));
    if (dupe) throw new HttpError(400, "There's already an off-season with that name");
  };

  app.post("/", async (req) => {
    requireKeeper(req);
    const body = parse(offSeasonSchema, req.body);
    await uniqueName(req.user.companyId, body.name);
    const [row] = await db.insert(offSeasons).values({ companyId: req.user.companyId, name: body.name, startMd: body.start, endMd: body.end }).returning();
    return view(row);
  });

  /** Changing the dates affects the to-dos made from now on, not the ones already made. */
  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    requireKeeper(req);
    const body = parse(offSeasonSchema, req.body);
    await uniqueName(req.user.companyId, body.name, req.params.id);
    const [row] = await db.update(offSeasons).set({ name: body.name, startMd: body.start, endMd: body.end })
      .where(and(eq(offSeasons.id, req.params.id), eq(offSeasons.companyId, req.user.companyId))).returning();
    if (!row) notFound("Off-season");
    return view(row);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    requireKeeper(req);
    const rows = await db.delete(offSeasons).where(and(eq(offSeasons.id, req.params.id), eq(offSeasons.companyId, req.user.companyId))).returning({ id: offSeasons.id });
    if (!rows.length) notFound("Off-season");
    return { ok: true };
  });
};

export default routes;

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { hasRole, measureTotals, measurementSchema } from "@crewdesk/shared";
import { db } from "../db";
import { employees, measurements } from "../db/schema";
import { authenticate, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { geocode } from "../lib/geocode";

/** Which area of the Permissions page controls editing other people's measurements. */
const AREA = "spray" as const;

/**
 * Property measurements (Measure page). Everyone can measure, save and look up saved
 * measurements; people edit their own, and Spray Mix managers can edit or delete anyone's.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  const listColumns = {
    id: measurements.id, name: measurements.name, address: measurements.address, netSqFt: measurements.netSqFt,
    lat: measurements.lat, lng: measurements.lng, imagery: measurements.imagery, updatedAt: measurements.updatedAt,
    createdById: measurements.createdById, createdByFirst: employees.firstName, createdByLast: employees.lastName,
  };

  app.get<{ Querystring: { q?: string } }>("/", async (req) => {
    const q = (req.query.q ?? "").trim().slice(0, 100);
    const where = [eq(measurements.companyId, req.user.companyId)];
    if (q) where.push(or(ilike(measurements.name, `%${q}%`), ilike(measurements.address, `%${q}%`))!);
    return db
      .select(listColumns)
      .from(measurements)
      .leftJoin(employees, eq(employees.id, measurements.createdById))
      .where(and(...where))
      .orderBy(desc(measurements.updatedAt))
      .limit(200);
  });

  /** Turns an address, a maps link or "lat, lng" into coordinates for centering the map. */
  app.post("/geocode", async (req) => {
    const { query } = parse(z.object({ query: z.string().trim().min(1, "Type an address or paste a map link").max(1000) }), req.body);
    const found = await geocode(query);
    if (!found) throw new HttpError(404, "Couldn't find that place. Check the address (street, city and state), or paste a Google Maps link or \"latitude, longitude\".");
    return found;
  });

  async function load(req: FastifyRequest, id: string) {
    const [row] = await db.select().from(measurements).where(and(eq(measurements.id, id), eq(measurements.companyId, req.user.companyId)));
    if (!row) notFound("Measurement");
    return row;
  }

  function requireEditor(req: FastifyRequest, row: { createdById: string | null }) {
    if (row.createdById !== req.user.sub && !hasRole(roleIn(req, AREA), "manager")) {
      throw new HttpError(403, "Only the person who saved this measurement, or a manager, can change it. Save a copy instead.");
    }
  }

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const row = await load(req, req.params.id);
    return { ...row, canEdit: row.createdById === req.user.sub || hasRole(roleIn(req, AREA), "manager") };
  });

  app.post("/", async (req) => {
    const body = parse(measurementSchema, req.body);
    const [row] = await db
      .insert(measurements)
      .values({ ...body, netSqFt: measureTotals(body.shapes).netSqFt, companyId: req.user.companyId, createdById: req.user.sub, updatedById: req.user.sub })
      .returning();
    return { ...row, canEdit: true };
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const row = await load(req, req.params.id);
    requireEditor(req, row);
    const body = parse(measurementSchema, req.body);
    const [updated] = await db
      .update(measurements)
      .set({ ...body, netSqFt: measureTotals(body.shapes).netSqFt, updatedById: req.user.sub, updatedAt: new Date() })
      .where(eq(measurements.id, row.id))
      .returning();
    return { ...updated, canEdit: true };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const row = await load(req, req.params.id);
    requireEditor(req, row);
    await db.delete(measurements).where(eq(measurements.id, row.id));
    return { ok: true };
  });
};

export default routes;

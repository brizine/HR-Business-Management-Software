import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { customImagerySchema, hasRole, measureTotals, measurementSchema } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees, measurements } from "../db/schema";
import { authenticate, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { geocode } from "../lib/geocode";
import { imageryFor } from "../lib/imagery";

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
    frontSqFt: measurements.frontSqFt, backSqFt: measurements.backSqFt,
    lat: measurements.lat, lng: measurements.lng, imagery: measurements.imagery, updatedAt: measurements.updatedAt,
    createdById: measurements.createdById, createdByFirst: employees.firstName, createdByLast: employees.lastName,
  };

  /** Works out the front/back totals of measurements saved before they were stored. */
  async function fillZoneTotals(companyId: string) {
    const rows = await db
      .select({ id: measurements.id, shapes: measurements.shapes })
      .from(measurements)
      .where(and(eq(measurements.companyId, companyId), or(isNull(measurements.frontSqFt), isNull(measurements.backSqFt))));
    for (const r of rows) {
      const t = measureTotals(r.shapes ?? []);
      await db.update(measurements).set({ frontSqFt: t.frontSqFt, backSqFt: t.backSqFt }).where(eq(measurements.id, r.id));
    }
  }

  const totalsOf = (shapes: Parameters<typeof measureTotals>[0]) => {
    const t = measureTotals(shapes);
    return { netSqFt: t.netSqFt, frontSqFt: t.frontSqFt, backSqFt: t.backSqFt };
  };

  app.get<{ Querystring: { q?: string } }>("/", async (req) => {
    await fillZoneTotals(req.user.companyId);
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

  const canManageImagery = (req: FastifyRequest) => hasRole(roleIn(req, AREA), "admin");

  /** The aerial photos to choose from (Oklahoma's found automatically, plus the company's own). `refresh=1` (admins) re-checks OKMaps now. */
  app.get<{ Querystring: { refresh?: string } }>("/imagery", async (req) => {
    const refresh = req.query.refresh === "1" && canManageImagery(req);
    const result = await imageryFor(req.user.companyId, refresh);
    const [company] = await db.select({ measureImagery: companies.measureImagery }).from(companies).where(eq(companies.id, req.user.companyId));
    return { ...result, canManage: canManageImagery(req), custom: company?.measureImagery?.custom ?? [] };
  });

  /** Admins: replace the company's own photo sources. */
  app.put("/imagery/custom", async (req) => {
    if (!canManageImagery(req)) throw new HttpError(403, "Only admins can change photo sources");
    const { custom } = parse(customImagerySchema, req.body);
    const keys = new Set<string>();
    for (const c of custom) {
      if (keys.has(c.key)) throw new HttpError(400, "Two photo sources have the same key");
      keys.add(c.key);
    }
    const [company] = await db.select({ measureImagery: companies.measureImagery }).from(companies).where(eq(companies.id, req.user.companyId));
    await db.update(companies).set({ measureImagery: { ...(company?.measureImagery ?? {}), custom } }).where(eq(companies.id, req.user.companyId));
    return imageryFor(req.user.companyId);
  });

  /**
   * One photo image for printing and exporting the map (OKMaps doesn't let browsers copy its images, so the
   * server fetches it). Only for the company's known WMS photo sources; `bbox` is in web-mercator meters.
   */
  app.get<{ Params: { key: string }; Querystring: { bbox?: string; width?: string; height?: string } }>("/imagery/:key/wms", async (req, reply) => {
    const { sources } = await imageryFor(req.user.companyId);
    const source = sources.find((s) => s.key === req.params.key && s.kind === "wms");
    if (!source || !source.layers) return notFound("Photo source");
    const bbox = (req.query.bbox ?? "").split(",").map(Number);
    const width = Math.round(Number(req.query.width)), height = Math.round(Number(req.query.height));
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n) || Math.abs(n) > 20_100_000) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      throw new HttpError(400, "Bad map area");
    }
    if (!(width >= 16 && width <= 4096 && height >= 16 && height <= 4096)) throw new HttpError(400, "Image must be 16 to 4096 pixels across");
    const url = new URL(source.url);
    for (const [k, v] of Object.entries({
      service: "WMS", version: "1.1.1", request: "GetMap", layers: source.layers, styles: "", srs: "EPSG:3857",
      bbox: bbox.join(","), width: String(width), height: String(height), format: "image/jpeg",
    })) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { "User-Agent": "Crewdesk/1.0 (self-hosted HR and fleet software)" }, signal: AbortSignal.timeout(45_000) }).catch(() => null);
    const type = res?.headers.get("content-type") ?? "";
    if (!res?.ok || !type.startsWith("image/")) throw new HttpError(502, "The photo server didn't send an image. Try again, or switch photos.");
    reply.header("Content-Type", type).header("Cache-Control", "private, max-age=3600");
    return reply.send(Buffer.from(await res.arrayBuffer()));
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
      .values({ ...body, ...totalsOf(body.shapes), companyId: req.user.companyId, createdById: req.user.sub, updatedById: req.user.sub })
      .returning();
    return { ...row, canEdit: true };
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const row = await load(req, req.params.id);
    requireEditor(req, row);
    const body = parse(measurementSchema, req.body);
    const [updated] = await db
      .update(measurements)
      .set({ ...body, ...totalsOf(body.shapes), updatedById: req.user.sub, updatedAt: new Date() })
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

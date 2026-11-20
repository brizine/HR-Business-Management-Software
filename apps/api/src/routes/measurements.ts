import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { OK_COUNTIES, customImagerySchema, hasRole, measureTotals, measurementSchema, type MeasureImagerySettings } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees, measurements } from "../db/schema";
import { authenticate, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { geocode } from "../lib/geocode";
import { imageryFor } from "../lib/imagery";
import { suggestAddresses, type AddressSuggestion } from "../lib/suggest";
import { addressStatus, countiesFor, isRefreshing, refreshAddresses, searchAddresses, searchStreets } from "../lib/addresses";

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

  /** Address suggestions while typing, near the map's center. */
  app.get<{ Querystring: { q?: string; lat?: string; lng?: string } }>("/suggest", async (req) => {
    const q = (req.query.q ?? "").trim().slice(0, 200);
    if (q.length < 3 || /^https?:/i.test(q) || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(q)) return [];
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    // Nearest the shop first (else nearest the middle of the map).
    const shop = await shopFor(req.user.companyId);
    const near = shop ?? (Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : { lat: 35.22, lng: -97.44 });
    // Oklahoma's 911 addresses first (complete, including new streets): house numbers, or streets when only a name
    // is typed; then OpenStreetMap's (towns and places, and anything the 911 list doesn't have).
    const [ok911, streets, osm] = await Promise.all([
      searchAddresses(q, near, 6).catch(() => []), searchStreets(q, near, 5).catch(() => []), suggestAddresses(q, near),
    ]);
    const out: AddressSuggestion[] = [
      ...ok911.map((m) => ({ label: m.label, lat: m.lat, lng: m.lng, kind: "address" as const, lookUp: false })),
      ...streets.map((m) => ({ label: m.label, lat: m.lat, lng: m.lng, kind: "street" as const, lookUp: false, detail: `${m.addresses} address${m.addresses === 1 ? "" : "es"}` })),
    ];
    const norm = (l: string) => l.toLowerCase().replace(/\b(street|st|drive|dr|avenue|ave|road|rd)\b/g, "").replace(/[^a-z0-9]/g, "");
    const seen = new Set(out.map((s) => norm(s.label)));
    // A street-only guess from OpenStreetMap isn't needed once 911 has the real address.
    // With 911 matches, OpenStreetMap only adds towns and named places (its street guesses are less complete).
    for (const s of osm) {
      if (seen.has(norm(s.label)) || (out.length && s.kind !== "place")) continue;
      out.push(s);
      seen.add(norm(s.label));
    }
    return out.slice(0, 7);
  });

  /**
   * The shop location address suggestions are measured from: what an admin set, else the business address
   * (Company settings) looked up once and remembered.
   */
  async function shopFor(companyId: string) {
    const [c] = await db.select({ s: companies.measureImagery, address: companies.address }).from(companies).where(eq(companies.id, companyId));
    const settings = c?.s ?? {};
    if (settings.shop) return settings.shop;
    if (!c?.address || settings.shop === null) return null;
    const found = await geocode(c.address).catch(() => null);
    const shop = found ? { lat: found.lat, lng: found.lng, label: c.address, source: "company" as const } : null;
    // Remember it (null = tried and couldn't find it, so don't look it up on every keystroke).
    await db.update(companies).set({ measureImagery: { ...settings, shop } }).where(eq(companies.id, companyId));
    return shop;
  }

  /** Admins: set the shop location from an address (or clear it to use the business address). */
  app.put("/shop", async (req) => {
    if (!canManageImagery(req)) throw new HttpError(403, "Only admins can change this");
    const { query } = parse(z.object({ query: z.string().trim().max(300) }), req.body);
    const [c] = await db.select({ s: companies.measureImagery }).from(companies).where(eq(companies.id, req.user.companyId));
    let shop: MeasureImagerySettings["shop"] = undefined;
    if (query) {
      const found = await geocode(query);
      if (!found) throw new HttpError(404, "Couldn't find that address. Check it, or paste a Google Maps link or \"latitude, longitude\".");
      shop = { lat: found.lat, lng: found.lng, label: found.source === "coordinates" ? query : found.label, source: "admin" };
    }
    const next = { ...(c?.s ?? {}) };
    if (shop) next.shop = shop; else delete next.shop;
    await db.update(companies).set({ measureImagery: next }).where(eq(companies.id, req.user.companyId));
    return { shop: (await shopFor(req.user.companyId)) ?? null };
  });

  /** Address search's Oklahoma 911 counties and when each was downloaded. */
  app.get("/addresses", async (req) => {
    const [company] = await db.select({ measureImagery: companies.measureImagery }).from(companies).where(eq(companies.id, req.user.companyId));
    const counties = countiesFor(company?.measureImagery);
    return { counties: await addressStatus(counties), all: OK_COUNTIES, refreshing: isRefreshing(), canManage: canManageImagery(req), shop: await shopFor(req.user.companyId) };
  });

  /** Admins: which counties' addresses to keep (new ones download in the background). */
  app.put("/addresses/counties", async (req) => {
    if (!canManageImagery(req)) throw new HttpError(403, "Only admins can change this");
    const { counties } = parse(z.object({ counties: z.array(z.enum(OK_COUNTIES)).max(20) }), req.body);
    const [company] = await db.select({ measureImagery: companies.measureImagery }).from(companies).where(eq(companies.id, req.user.companyId));
    await db.update(companies).set({ measureImagery: { ...(company?.measureImagery ?? {}), addressCounties: [...new Set(counties)] } }).where(eq(companies.id, req.user.companyId));
    void refreshAddresses();
    return { counties: await addressStatus([...new Set(counties)]), all: OK_COUNTIES, refreshing: true, canManage: true };
  });

  /** Admins: download the company's counties again now (in the background). */
  app.post("/addresses/refresh", async (req) => {
    if (!canManageImagery(req)) throw new HttpError(403, "Only admins can do this");
    const [company] = await db.select({ measureImagery: companies.measureImagery }).from(companies).where(eq(companies.id, req.user.companyId));
    const counties = countiesFor(company?.measureImagery);
    void refreshAddresses(counties);
    return { counties: await addressStatus(counties), all: OK_COUNTIES, refreshing: true, canManage: true };
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

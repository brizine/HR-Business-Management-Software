import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { formatAddress, mapCodeSchema } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { properties } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { parse } from "../lib/errors";
import { autoPreview, checkMapCode, deleteMapCode, findPins, listMapCodes, mapCodesAuto, saveMapCode, setMapCodesAuto } from "../lib/mapCodes";

const AREA = "customers" as const;
const admin = { preHandler: requireRole("admin", AREA) };

/**
 * Map Codes: the service area drawn as outlines (Settings → Map Codes). Customers & billing managers can
 * see them; only admins and owners draw them, turn automatic map codes on, or run the pin catch-up.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get("/", async (req) => {
    const { companyId } = req.user;
    return { auto: await mapCodesAuto(companyId), codes: await listMapCodes(companyId) };
  });

  /**
   * The company's properties for the map: the ones with a pin (as dots, with the code on each), and the ones
   * without (which no outline can place) to work through.
   */
  app.get("/properties", async (req) => {
    const { companyId } = req.user;
    const rows = await db.select({
      id: properties.id, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip,
      lat: properties.lat, lng: properties.lng, mapCode: properties.mapCode, manual: properties.mapCodeManual, tried: properties.pinLookupAt,
    }).from(properties).where(and(eq(properties.companyId, companyId), ne(properties.status, "cancelled"))).orderBy(asc(properties.street));
    const pins = rows.filter((p) => p.lat != null && p.lng != null).map((p) => ({ id: p.id, address: formatAddress(p), lat: p.lat!, lng: p.lng!, mapCode: p.mapCode, manual: p.manual }));
    const noPin = rows.filter((p) => p.lat == null || p.lng == null).map((p) => ({ id: p.id, address: formatAddress(p), mapCode: p.mapCode, tried: !!p.tried }));
    return { pins, noPin };
  });

  /** What saving this outline (or deleting one) would do: the outline as trimmed, and the properties whose code would change. Changes nothing. */
  app.post("/check", admin, async (req) => {
    const body = req.body as { removeId?: unknown };
    if (body && typeof body.removeId === "string") return checkMapCode(req.user.companyId, { removeId: parse(z.object({ removeId: z.string().uuid() }), body).removeId });
    return checkMapCode(req.user.companyId, parse(mapCodeSchema.extend({ id: z.string().uuid().optional() }), req.body));
  });

  app.post("/", admin, async (req) => saveMapCode(req.user.companyId, req.user.sub, parse(mapCodeSchema, req.body)));
  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => saveMapCode(req.user.companyId, req.user.sub, parse(mapCodeSchema, req.body), req.params.id));
  app.delete<{ Params: { id: string } }>("/:id", admin, async (req) => deleteMapCode(req.user.companyId, req.params.id));

  /** What turning automatic map codes on would change on properties. */
  app.get("/auto/preview", admin, async (req) => autoPreview(req.user.companyId));
  app.post("/auto", admin, async (req) => setMapCodesAuto(req.user.companyId, parse(z.object({ on: z.boolean() }), req.body).on));

  /**
   * The pin catch-up: looks up addresses for properties with no pin, a few seconds' worth per call. The page
   * calls it again, sending back the `since` the first call answered with, until `remaining` is 0.
   */
  app.post("/find-pins", admin, async (req) => {
    const { since } = parse(z.object({ since: z.string().datetime().optional() }), req.body ?? {});
    return findPins(req.user.companyId, since ? new Date(since) : undefined);
  });

  /** How many properties have no pin (for the property list and the page's count). */
  app.get("/no-pin-count", async (req) => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(properties)
      .where(and(eq(properties.companyId, req.user.companyId), isNull(properties.lat), ne(properties.status, "cancelled")));
    return { count: n };
  });
};

export default routes;

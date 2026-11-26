import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { companyInfoSchema, hasRole, weatherLinksSchema } from "@crewdesk/shared";
import { db } from "../db";
import { companies } from "../db/schema";
import { authenticate, requireRole, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { MAX_IMAGE_BYTES, imageType } from "../lib/images";
import { storage } from "../lib/storage";
import { FITTED, logoIsFitted, readLogo, smallLogoKey } from "../lib/logo";
import { companyForecast, saveWeatherLinks } from "../lib/forecast";
import { companyAddressUpdate, companyAddressView } from "../lib/companyAddress";

type Company = typeof companies.$inferSelect;

/** Everyone sees the company's details; the EIN only for admins and people with payroll access. */
function view(c: Company, req: FastifyRequest) {
  const seesEin = hasRole(roleIn(req, "company"), "admin") || hasRole(roleIn(req, "payroll"), "admin");
  return {
    name: c.name,
    legalName: c.legalName,
    ein: seesEin ? c.ein : null,
    ...companyAddressView(c),
    phone: c.phone,
    email: c.email,
    website: c.website,
    timezone: c.timezone,
    hasLogo: !!c.logoKey,
    // False for a logo added before Crewdesk trimmed and sized them: the page offers to fit it.
    logoFitted: logoIsFitted(c.logoKey),
    logoUpdatedAt: c.logoUpdatedAt,
    canEdit: hasRole(roleIn(req, "company"), "owner"),
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    return view(c, req);
  });

  /**
   * The logo, for everyone in the company. ?size=small is the copy sized for screens (the top bar);
   * add ?v=<logoUpdatedAt> so a new logo isn't served from cache.
   */
  app.get<{ Querystring: { size?: string } }>("/logo", async (req, reply) => {
    const [c] = await db.select({ key: companies.logoKey }).from(companies).where(eq(companies.id, req.user.companyId));
    if (!c?.key) notFound("Logo");
    const buf = await readLogo(c.key, req.query.size);
    reply.header("Content-Type", imageType(buf) ?? "application/octet-stream");
    reply.header("Cache-Control", "private, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buf);
  });

  /**
   * multipart/form-data: "file" is the logo (JPEG, PNG or WebP, up to 5 MB). The website fits it
   * first (blank border trimmed, sized for print) and sends "small" with it, the same logo sized
   * for screens.
   */
  app.put("/logo", { preHandler: requireRole("owner", "company") }, async (req) => {
    const sent: { file?: Buffer; small?: Buffer } = {};
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const buf = await part.toBuffer();
      if (part.fieldname === "file" || part.fieldname === "small") sent[part.fieldname] = buf;
    }
    if (!sent.file) throw new HttpError(400, "No logo uploaded");
    for (const buf of [sent.file, sent.small]) {
      if (!buf) continue;
      if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, "That image is too large (5 MB max)");
      if (!imageType(buf)) throw new HttpError(400, "Use a JPEG, PNG or WebP image");
    }
    const key = `${req.user.companyId}${sent.small ? FITTED : "/logo-"}${randomUUID()}`;
    await storage.put(key, sent.file);
    if (sent.small) await storage.put(smallLogoKey(key), sent.small);
    const [c] = await db.update(companies).set({ logoKey: key, logoUpdatedAt: new Date() }).where(eq(companies.id, req.user.companyId)).returning();
    return view(c, req);
  });

  app.delete("/logo", { preHandler: requireRole("owner", "company") }, async (req) => {
    const [c] = await db.update(companies).set({ logoKey: null, logoUpdatedAt: new Date() }).where(eq(companies.id, req.user.companyId)).returning();
    return view(c, req);
  });

  /**
   * The forecast box (the weather icon in everyone's top bar): the National Weather Service's
   * forecast for the business address, and the company's own links to other weather sites.
   */
  app.get("/forecast", async (req) => ({ ...(await companyForecast(req.user.companyId)), canEdit: hasRole(roleIn(req, "company"), "owner") }));

  /** The other weather sites listed in the forecast box (Settings → Company Info). */
  app.put("/weather-links", { preHandler: requireRole("owner", "company") }, async (req) => {
    const b = parse(weatherLinksSchema, req.body);
    return { links: await saveWeatherLinks(req.user.companyId, b.links) };
  });

  /** The owner (or owner-level Company settings access) edits the company's details. */
  app.put("/", { preHandler: requireRole("owner", "company") }, async (req) => {
    const body = parse(companyInfoSchema, req.body);
    const blank = (v: string | undefined) => (v ? v : null);
    const [current] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    const [c] = await db
      .update(companies)
      .set({
        name: body.name,
        legalName: blank(body.legalName),
        ein: blank(body.ein),
        ...companyAddressUpdate(body, current),
        phone: blank(body.phone),
        email: blank(body.email),
        website: blank(body.website),
        timezone: body.timezone,
      })
      .where(eq(companies.id, req.user.companyId))
      .returning();
    return view(c, req);
  });
};

export default routes;

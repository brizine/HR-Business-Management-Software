import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { companyInfoSchema, hasRole } from "@crewdesk/shared";
import { db } from "../db";
import { companies } from "../db/schema";
import { authenticate, requireRole, roleIn } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { MAX_IMAGE_BYTES, imageType } from "../lib/images";
import { storage } from "../lib/storage";
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

  /** The logo, for everyone in the company. Add ?v=<logoUpdatedAt> so a new logo isn't served from cache. */
  app.get("/logo", async (req, reply) => {
    const [c] = await db.select({ key: companies.logoKey }).from(companies).where(eq(companies.id, req.user.companyId));
    if (!c?.key) notFound("Logo");
    const buf = await storage.get(c.key);
    reply.header("Content-Type", imageType(buf) ?? "application/octet-stream");
    reply.header("Cache-Control", "private, max-age=86400");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(buf);
  });

  /** multipart/form-data with one image (JPEG, PNG or WebP, up to 5 MB). */
  app.put("/logo", { preHandler: requireRole("owner", "company") }, async (req) => {
    const file = await req.file();
    if (!file) throw new HttpError(400, "No logo uploaded");
    const buf = await file.toBuffer();
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, "That image is too large (5 MB max)");
    if (!imageType(buf)) throw new HttpError(400, "Use a JPEG, PNG or WebP image");
    const key = `${req.user.companyId}/logo-${randomUUID()}`;
    await storage.put(key, buf);
    const [c] = await db.update(companies).set({ logoKey: key, logoUpdatedAt: new Date() }).where(eq(companies.id, req.user.companyId)).returning();
    return view(c, req);
  });

  app.delete("/logo", { preHandler: requireRole("owner", "company") }, async (req) => {
    const [c] = await db.update(companies).set({ logoKey: null, logoUpdatedAt: new Date() }).where(eq(companies.id, req.user.companyId)).returning();
    return view(c, req);
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

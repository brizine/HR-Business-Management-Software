import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { companyInfoSchema, hasRole } from "@crewdesk/shared";
import { db } from "../db";
import { companies } from "../db/schema";
import { authenticate, requireRole, roleIn } from "../lib/auth";
import { parse } from "../lib/errors";

type Company = typeof companies.$inferSelect;

/** Everyone sees the company's details; the EIN only for admins and people with payroll access. */
function view(c: Company, req: FastifyRequest) {
  const seesEin = hasRole(roleIn(req, "company"), "admin") || hasRole(roleIn(req, "payroll"), "admin");
  return {
    name: c.name,
    legalName: c.legalName,
    ein: seesEin ? c.ein : null,
    address: c.address,
    phone: c.phone,
    email: c.email,
    website: c.website,
    timezone: c.timezone,
    canEdit: hasRole(roleIn(req, "company"), "owner"),
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get("/", async (req) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, req.user.companyId));
    return view(c, req);
  });

  /** The owner (or owner-level Company settings access) edits the company's details. */
  app.put("/", { preHandler: requireRole("owner", "company") }, async (req) => {
    const body = parse(companyInfoSchema, req.body);
    const blank = (v: string | undefined) => (v ? v : null);
    const [c] = await db
      .update(companies)
      .set({
        name: body.name,
        legalName: blank(body.legalName),
        ein: blank(body.ein),
        address: blank(body.address),
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

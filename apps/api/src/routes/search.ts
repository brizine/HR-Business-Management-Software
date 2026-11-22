import type { FastifyPluginAsync } from "fastify";
import { and, asc, eq, ilike, inArray, not, or, sql } from "drizzle-orm";
import { customerName, formatAddress, hasRole, isInactive } from "@crewdesk/shared";
import { db } from "../db";
import { assets, customers, employees, properties } from "../db/schema";
import { authenticate, roleIn } from "../lib/auth";

export interface SearchHit { kind: "customer" | "property" | "employee" | "asset"; id: string; title: string; sub: string | null; href: string }

/**
 * The top bar's search (Ctrl+K): customers and properties (for people with Customers & billing
 * access), employees and fleet assets. Each group is capped so the list stays short.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { q?: string } }>("/", async (req) => {
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (q.length < 2) return { results: [] as SearchHit[] };
    const { companyId } = req.user;
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, "");
    const out: SearchHit[] = [];

    if (hasRole(roleIn(req, "customers"), "manager")) {
      const match = [
        ilike(customers.firstName, like), ilike(customers.lastName, like), ilike(customers.companyName, like), ilike(customers.email, like),
        sql`(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')) ilike ${like}`,
      ];
      if (digits.length >= 4) match.push(sql`regexp_replace(coalesce(${customers.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}`);
      if (/^\d+$/.test(q)) match.push(eq(customers.number, Number(q)));
      const cs = await db.select({ id: customers.id, number: customers.number, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName, status: customers.status, email: customers.email })
        .from(customers).where(and(eq(customers.companyId, companyId), or(...match)))
        .orderBy(sql`${customers.status} = 'cancelled'`, asc(customers.lastName)).limit(6);
      for (const c of cs) out.push({ kind: "customer", id: c.id, title: customerName(c), sub: [`#${c.number}`, c.status !== "active" ? c.status : null, c.email].filter(Boolean).join(" · "), href: `/customers/${c.id}` });

      const ps = await db.select({ id: properties.id, name: properties.name, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip, status: properties.status })
        .from(properties).where(and(eq(properties.companyId, companyId), or(ilike(properties.street, like), ilike(properties.name, like), ilike(properties.zip, like))))
        .orderBy(sql`${properties.status} = 'cancelled'`, asc(properties.street)).limit(6);
      for (const p of ps) out.push({ kind: "property", id: p.id, title: p.street, sub: [p.name, formatAddress({ city: p.city, state: p.state, zip: p.zip }), p.status === "cancelled" ? "cancelled" : null].filter(Boolean).join(" · "), href: `/properties/${p.id}` });
    }

    const es = await db.select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, title: employees.title, status: employees.status })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), not(inArray(employees.status, ["terminated"])), or(
        ilike(employees.firstName, like), ilike(employees.lastName, like), sql`(${employees.firstName} || ' ' || ${employees.lastName}) ilike ${like}`,
      )))
      .orderBy(asc(employees.lastName)).limit(6);
    for (const e of es) {
      if (isInactive(e.status) && !hasRole(roleIn(req, "people"), "manager")) continue;
      out.push({ kind: "employee", id: e.id, title: `${e.firstName} ${e.lastName}`, sub: e.title ?? null, href: `/people/${e.id}` });
    }

    const as = await db.select({ id: assets.id, name: assets.name, make: assets.make, model: assets.model, year: assets.year, plate: assets.licensePlate })
      .from(assets)
      .where(and(eq(assets.companyId, companyId), or(ilike(assets.name, like), ilike(assets.make, like), ilike(assets.model, like), ilike(assets.licensePlate, like), ilike(assets.vin, like))))
      .orderBy(asc(assets.name)).limit(5);
    for (const a of as) out.push({ kind: "asset", id: a.id, title: a.name, sub: [a.year, a.make, a.model].filter(Boolean).join(" ") || a.plate || null, href: `/fleet/${a.id}` });

    return { results: out };
  });
};

export default routes;

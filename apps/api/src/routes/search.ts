import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, ilike, inArray, not, or, sql } from "drizzle-orm";
import { PAYMENT_METHOD_LABELS, customerName, formatAddress, hasRole, isInactive, type PaymentMethod } from "@crewdesk/shared";
import { db } from "../db";
import { assets, customers, employees, invoicePayments, invoices, properties, serviceTypes, workOrders } from "../db/schema";
import { authenticate, roleIn } from "../lib/auth";

export interface SearchHit {
  kind: "customer" | "property" | "invoice" | "payment" | "service" | "employee" | "asset" | "workOrder";
  id: string; title: string; sub: string | null; href: string;
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The top bar's search (Ctrl+K). For people with Customers & billing access: customers, properties,
 * invoices (by number or PO), payments (by check or reference number) and price list services. For
 * everyone: employees, fleet assets and repair orders (by number or title). Each group is capped so
 * the list stays short.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  app.get<{ Querystring: { q?: string } }>("/", async (req) => {
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (q.length < 2) return { results: [] as SearchHit[] };
    const { companyId } = req.user;
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, "");
    // A record number on its own or after its name: "1043", "#1043", "inv 1043", "invoice #1043", "RO 12".
    const numbered = q.replace(/^(invoice|inv|repair order|ro|wo)?\s*#?\s*/i, "");
    const number = /^\d{1,9}$/.test(numbered) ? Number(numbered) : null;
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

      const who = { kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName };
      const invMatch = [ilike(invoices.poNumber, like)];
      if (number !== null) invMatch.push(eq(invoices.number, number));
      const is = await db.select({ id: invoices.id, number: invoices.number, status: invoices.status, totalCents: invoices.totalCents, poNumber: invoices.poNumber, customer: who })
        .from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(and(eq(invoices.companyId, companyId), or(...invMatch)))
        .orderBy(desc(invoices.createdAt)).limit(5);
      for (const i of is) {
        out.push({
          kind: "invoice", id: i.id, title: i.number ? `Invoice ${i.number}` : "Draft invoice",
          sub: [customerName(i.customer), money(i.totalCents), i.status, i.poNumber ? `PO ${i.poNumber}` : null].filter(Boolean).join(" · "), href: `/invoices/${i.id}`,
        });
      }

      // Payments by check or reference number ("which invoice did check 4417 pay?").
      if (q.length >= 3) {
        const pays = await db.select({ id: invoicePayments.id, invoiceId: invoicePayments.invoiceId, method: invoicePayments.method, reference: invoicePayments.reference, amountCents: invoicePayments.amountCents, status: invoicePayments.status, number: invoices.number, customer: who })
          .from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId)).innerJoin(customers, eq(customers.id, invoicePayments.customerId))
          .where(and(eq(invoicePayments.companyId, companyId), ilike(invoicePayments.reference, like)))
          .orderBy(desc(invoicePayments.createdAt)).limit(5);
        for (const p of pays) {
          out.push({
            kind: "payment", id: p.id, title: `${PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method} ${p.reference}`,
            sub: [money(p.amountCents), p.number ? `Invoice ${p.number}` : null, customerName(p.customer), p.status !== "completed" ? p.status : null].filter(Boolean).join(" · "), href: `/invoices/${p.invoiceId}`,
          });
        }
      }

      const svcs = await db.select({ id: serviceTypes.id, name: serviceTypes.name, active: serviceTypes.active })
        .from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), ilike(serviceTypes.name, like)))
        .orderBy(desc(serviceTypes.active), asc(serviceTypes.name)).limit(4);
      for (const v of svcs) out.push({ kind: "service", id: v.id, title: v.name, sub: v.active ? "Price list" : "Price list · inactive", href: "/price-list" });
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

    const woMatch = [ilike(workOrders.title, like)];
    if (number !== null) woMatch.push(eq(workOrders.number, number));
    const wos = await db.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, status: workOrders.status, assetName: assets.name })
      .from(workOrders).innerJoin(assets, eq(assets.id, workOrders.assetId))
      .where(and(eq(workOrders.companyId, companyId), or(...woMatch)))
      .orderBy(sql`${workOrders.status} in ('completed', 'cancelled')`, desc(workOrders.createdAt)).limit(5);
    for (const w of wos) out.push({ kind: "workOrder", id: w.id, title: `#${w.number} ${w.title}`, sub: [w.assetName, w.status.replace(/_/g, " ")].join(" · "), href: `/work-orders?highlight=${w.id}` });

    return { results: out };
  });
};

export default routes;

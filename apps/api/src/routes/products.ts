import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, ilike, inArray, notInArray, or } from "drizzle-orm";
import { costOn, costPerUseUnitCents, productCostSchema, productSchema, type ProductInput } from "@crewdesk/shared";
import { db } from "../db";
import { companies, productCosts, productRates, products } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { localDate } from "../lib/tz";

const AREA = "customers" as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Saves a product's rates as the set sent: kept ids are updated, new ones added, missing ones removed. */
async function saveRates(tx: Tx, productId: string, rates: ProductInput["rates"]) {
  const keep = rates.map((r) => r.id).filter((x): x is string => !!x);
  await tx.delete(productRates).where(and(eq(productRates.productId, productId), keep.length ? notInArray(productRates.id, keep) : undefined));
  for (const [i, r] of rates.entries()) {
    const values = { name: r.name, amountPer1000: r.amountPer1000, method: r.method, carrierGalPer1000: r.carrierGalPer1000, sortOrder: i };
    if (r.id) {
      const [hit] = await tx.update(productRates).set(values).where(and(eq(productRates.id, r.id), eq(productRates.productId, productId))).returning({ id: productRates.id });
      if (!hit) throw new HttpError(400, "A rate belongs to another product");
    } else {
      await tx.insert(productRates).values({ ...values, productId });
    }
  }
}

async function today(companyId: string) {
  const [c] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  return localDate(new Date(), c?.tz ?? "America/Chicago");
}

/**
 * The product list: chemicals and fertilizers with their rates and cost history, for budgeting
 * and chemical records. Managers in Customers & billing read it; admins change it.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  /** Products with their rates, the cost in force today, and that cost per use unit. */
  async function load(companyId: string, opts: { ids?: string[]; all?: boolean; q?: string }) {
    const where = [eq(products.companyId, companyId)];
    if (!opts.all) where.push(eq(products.active, true));
    if (opts.ids) where.push(inArray(products.id, opts.ids));
    if (opts.q?.trim()) {
      const like = `%${opts.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      where.push(or(ilike(products.name, like), ilike(products.manufacturer, like), ilike(products.epaRegNo, like))!);
    }
    const rows = await db.select().from(products).where(and(...where)).orderBy(asc(products.name));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [rates, costs, day] = await Promise.all([
      db.select().from(productRates).where(inArray(productRates.productId, ids)).orderBy(asc(productRates.sortOrder)),
      db.select().from(productCosts).where(inArray(productCosts.productId, ids)).orderBy(desc(productCosts.effectiveFrom), desc(productCosts.createdAt)),
      today(companyId),
    ]);
    return rows.map((p) => {
      const history = costs.filter((c) => c.productId === p.id);
      const current = costOn(history, day);
      return {
        ...p,
        rates: rates.filter((r) => r.productId === p.id).map(({ productId: _p, ...r }) => r),
        costs: history.map(({ productId: _p, ...c }) => c),
        currentCost: current ? { costPerPurchaseUnitCents: current.costPerPurchaseUnitCents, vendor: current.vendor, effectiveFrom: current.effectiveFrom } : null,
        costPerUseUnitCents: costPerUseUnitCents(current?.costPerPurchaseUnitCents, p.purchaseUnitSize),
      };
    });
  }

  async function one(companyId: string, id: string) {
    const [row] = await load(companyId, { ids: [id], all: true });
    if (!row) throw new HttpError(404, "Product not found");
    return row;
  }

  app.get<{ Querystring: { all?: string; q?: string } }>("/", async (req) => load(req.user.companyId, { all: req.query.all === "1", q: req.query.q }));

  app.get<{ Params: { id: string } }>("/:id", async (req) => one(req.user.companyId, req.params.id));

  app.post("/", admin, async (req) => {
    const { rates, ...body } = parse(productSchema, req.body);
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(products).values({ ...body, companyId: req.user.companyId, updatedById: req.user.sub }).returning({ id: products.id });
      await saveRates(tx, row.id, rates.map(({ id: _drop, ...r }) => r));
      return row.id;
    });
    return one(req.user.companyId, id);
  });

  app.put<{ Params: { id: string } }>("/:id", admin, async (req) => {
    const { rates, ...body } = parse(productSchema, req.body);
    await db.transaction(async (tx) => {
      const [row] = await tx.update(products).set({ ...body, updatedById: req.user.sub, updatedAt: new Date() })
        .where(and(eq(products.id, req.params.id), eq(products.companyId, req.user.companyId))).returning({ id: products.id });
      if (!row) throw new HttpError(404, "Product not found");
      await saveRates(tx, row.id, rates);
    });
    return one(req.user.companyId, req.params.id);
  });

  /** Adds a cost from a date on (a price change keeps the old cost for earlier dates). */
  app.post<{ Params: { id: string } }>("/:id/costs", admin, async (req) => {
    const body = parse(productCostSchema, req.body);
    await one(req.user.companyId, req.params.id);
    await db.insert(productCosts).values({ ...body, productId: req.params.id, createdById: req.user.sub });
    return one(req.user.companyId, req.params.id);
  });

  /** Removes a cost entered by mistake. */
  app.delete<{ Params: { id: string; costId: string } }>("/:id/costs/:costId", admin, async (req) => {
    await one(req.user.companyId, req.params.id);
    const gone = await db.delete(productCosts).where(and(eq(productCosts.id, req.params.costId), eq(productCosts.productId, req.params.id))).returning({ id: productCosts.id });
    if (!gone.length) throw new HttpError(404, "Cost not found");
    return one(req.user.companyId, req.params.id);
  });
};

export default routes;

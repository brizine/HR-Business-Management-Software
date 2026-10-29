import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { SPRAY_MIX_TEMPLATE, hasRole, mixProductSchema, mixSheetSchema, type Role } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { employees, mixChanges, mixEditors, mixProducts, mixSheets } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";

type Sheet = typeof mixSheets.$inferSelect;
type Product = typeof mixProducts.$inferSelect;

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** Describes what changed, e.g. 'Aquacap: rate 47.9 → 50 ounces liquid/acre'. */
function describeProduct(before: Product, after: Partial<Product>) {
  const parts: string[] = [];
  if (after.name !== undefined && after.name !== before.name) parts.push(`renamed to "${after.name}"`);
  if (after.ratePerAcre !== undefined && after.ratePerAcre !== before.ratePerAcre) parts.push(`rate ${fmt(before.ratePerAcre)} → ${fmt(after.ratePerAcre)} per acre`);
  if (after.unit !== undefined && after.unit !== before.unit) parts.push(`unit ${before.unit} → ${after.unit}`);
  return parts.length ? `${before.name}: ${parts.join(", ")}` : null;
}

function describeSheet(before: Sheet, after: Partial<Sheet>) {
  const parts: string[] = [];
  if (after.name !== undefined && after.name !== before.name) parts.push(`renamed to "${after.name}"`);
  if (after.gallonsPerAcre !== undefined && after.gallonsPerAcre !== before.gallonsPerAcre) parts.push(`gallons/acre ${fmt(before.gallonsPerAcre)} → ${fmt(after.gallonsPerAcre)}`);
  if (after.defaultTankGallons !== undefined && after.defaultTankGallons !== before.defaultTankGallons) parts.push(`default tank ${fmt(before.defaultTankGallons)} → ${fmt(after.defaultTankGallons)} gal`);
  if (after.notes !== undefined && (after.notes ?? "") !== (before.notes ?? "")) parts.push("notes updated");
  return parts.length ? `${before.name}: ${parts.join(", ")}` : null;
}

/**
 * Spray Mix Calculator sheets. Everyone can view them and calculate their own tank
 * (that happens on the device; nothing is saved). Only admins and the
 * employees an admin picks can change products, rates and sheets.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  async function canEdit(req: FastifyRequest) {
    if (hasRole(req.user.role as Role, "admin")) return true;
    const [row] = await db
      .select()
      .from(mixEditors)
      .where(and(eq(mixEditors.companyId, req.user.companyId), eq(mixEditors.employeeId, req.user.sub)));
    return !!row;
  }

  async function requireEditor(req: FastifyRequest) {
    if (!(await canEdit(req))) throw new HttpError(403, "Only people chosen as mix editors can change products and rates");
  }

  async function loadSheet(req: FastifyRequest, id: string) {
    const [sheet] = await db
      .select()
      .from(mixSheets)
      .where(and(eq(mixSheets.id, id), eq(mixSheets.companyId, req.user.companyId)));
    if (!sheet) notFound("Mix sheet");
    return sheet;
  }

  async function loadProduct(req: FastifyRequest, id: string) {
    const [row] = await db
      .select({ product: mixProducts, sheet: mixSheets })
      .from(mixProducts)
      .innerJoin(mixSheets, eq(mixSheets.id, mixProducts.sheetId))
      .where(and(eq(mixProducts.id, id), eq(mixSheets.companyId, req.user.companyId)));
    if (!row) notFound("Product");
    return row;
  }

  async function log(req: FastifyRequest, sheetId: string | null, summary: string | null) {
    if (!summary) return;
    await db.insert(mixChanges).values({ companyId: req.user.companyId, sheetId, employeeId: req.user.sub, summary });
    if (sheetId) await db.update(mixSheets).set({ updatedAt: new Date(), updatedById: req.user.sub }).where(eq(mixSheets.id, sheetId));
  }

  /** All sheets with their products, plus whether the signed-in person can edit. */
  app.get("/", async (req) => {
    const sheets = await db
      .select()
      .from(mixSheets)
      .where(eq(mixSheets.companyId, req.user.companyId))
      .orderBy(asc(mixSheets.sortOrder), asc(mixSheets.createdAt));
    const products = sheets.length
      ? await db
          .select()
          .from(mixProducts)
          .where(inArray(mixProducts.sheetId, sheets.map((s) => s.id)))
          .orderBy(asc(mixProducts.sortOrder), asc(mixProducts.name))
      : [];
    const updaters = sheets.map((s) => s.updatedById).filter((x): x is string => !!x);
    const names = updaters.length
      ? new Map(
          (await db.select({ id: employees.id, f: employees.firstName, l: employees.lastName }).from(employees).where(inArray(employees.id, updaters))).map(
            (e) => [e.id, `${e.f} ${e.l}`],
          ),
        )
      : new Map<string, string>();
    return {
      canEdit: await canEdit(req),
      canManageEditors: hasRole(req.user.role as Role, "admin"),
      sheets: sheets.map((s) => ({
        ...s,
        updatedBy: s.updatedById ? names.get(s.updatedById) ?? null : null,
        products: products.filter((p) => p.sheetId === s.id),
      })),
    };
  });

  // ---- Editors (admins choose) ----

  app.get("/editors", { preHandler: requireRole("admin") }, async (req) =>
    (await db.select().from(mixEditors).where(eq(mixEditors.companyId, req.user.companyId))).map((e) => e.employeeId),
  );

  app.put("/editors", { preHandler: requireRole("admin") }, async (req) => {
    const { employeeIds } = parse(z.object({ employeeIds: z.array(z.string().uuid()).max(500) }), req.body);
    const valid = employeeIds.length
      ? await db
          .select({ id: employees.id, f: employees.firstName, l: employees.lastName })
          .from(employees)
          .where(and(eq(employees.companyId, req.user.companyId), inArray(employees.id, employeeIds)))
      : [];
    if (valid.length !== new Set(employeeIds).size) notFound("Employee");
    await db.transaction(async (tx) => {
      await tx.delete(mixEditors).where(eq(mixEditors.companyId, req.user.companyId));
      if (valid.length) await tx.insert(mixEditors).values(valid.map((e) => ({ companyId: req.user.companyId, employeeId: e.id })));
    });
    await log(req, null, `Mix editors set to: ${valid.map((e) => `${e.f} ${e.l}`).join(", ") || "admins only"}`);
    return valid.map((e) => e.id);
  });

  // ---- Sheets ----

  /** Creates the two mixes from the original spreadsheet (only when there are none yet). */
  app.post("/template", async (req) => {
    await requireEditor(req);
    const existing = await db.select().from(mixSheets).where(eq(mixSheets.companyId, req.user.companyId));
    if (existing.length) throw new HttpError(409, "Mix sheets already exist");
    for (const [i, t] of SPRAY_MIX_TEMPLATE.entries()) {
      const [sheet] = await db
        .insert(mixSheets)
        .values({ companyId: req.user.companyId, name: t.name, gallonsPerAcre: t.gallonsPerAcre, defaultTankGallons: t.defaultTankGallons, notes: t.notes, sortOrder: i, updatedById: req.user.sub })
        .returning();
      await db.insert(mixProducts).values(t.products.map((p, j) => ({ sheetId: sheet.id, name: p.name, ratePerAcre: p.ratePerAcre, unit: p.unit, sortOrder: j })));
      await log(req, sheet.id, `${sheet.name}: created from the original spreadsheet`);
    }
    return { ok: true };
  });

  app.post("/", async (req) => {
    await requireEditor(req);
    const body = parse(mixSheetSchema, req.body);
    const [sheet] = await db.insert(mixSheets).values({ ...body, companyId: req.user.companyId, sortOrder: Date.now() % 1_000_000, updatedById: req.user.sub }).returning();
    await log(req, sheet.id, `${sheet.name}: created`);
    return sheet;
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    await requireEditor(req);
    const body = parse(mixSheetSchema.partial(), req.body);
    const before = await loadSheet(req, req.params.id);
    const [sheet] = await db.update(mixSheets).set(body).where(eq(mixSheets.id, before.id)).returning();
    await log(req, sheet.id, describeSheet(before, body));
    return sheet;
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    await requireEditor(req);
    const sheet = await loadSheet(req, req.params.id);
    await db.delete(mixSheets).where(eq(mixSheets.id, sheet.id));
    await log(req, null, `${sheet.name}: deleted`);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/:id/changes", async (req) => {
    const sheet = await loadSheet(req, req.params.id);
    const rows = await db
      .select({ summary: mixChanges.summary, at: mixChanges.createdAt, f: employees.firstName, l: employees.lastName })
      .from(mixChanges)
      .leftJoin(employees, eq(employees.id, mixChanges.employeeId))
      .where(eq(mixChanges.sheetId, sheet.id))
      .orderBy(desc(mixChanges.createdAt))
      .limit(200);
    return rows.map((r) => ({ summary: r.summary, at: r.at, by: r.f ? `${r.f} ${r.l}` : "Unknown" }));
  });

  // ---- Products ----

  app.post<{ Params: { id: string } }>("/:id/products", async (req) => {
    await requireEditor(req);
    const body = parse(mixProductSchema, req.body);
    const sheet = await loadSheet(req, req.params.id);
    const count = (await db.select().from(mixProducts).where(eq(mixProducts.sheetId, sheet.id))).length;
    const [row] = await db.insert(mixProducts).values({ ...body, sheetId: sheet.id, sortOrder: count }).returning();
    await log(req, sheet.id, `Added ${row.name}: ${fmt(row.ratePerAcre)} ${row.unit}/acre`);
    return row;
  });

  app.patch<{ Params: { productId: string } }>("/products/:productId", async (req) => {
    await requireEditor(req);
    const body = parse(mixProductSchema.partial().extend({ sortOrder: z.number().int().min(0).max(10_000).optional() }), req.body);
    const { product } = await loadProduct(req, req.params.productId);
    const [row] = await db.update(mixProducts).set(body).where(eq(mixProducts.id, product.id)).returning();
    await log(req, product.sheetId, describeProduct(product, body));
    return row;
  });

  app.delete<{ Params: { productId: string } }>("/products/:productId", async (req) => {
    await requireEditor(req);
    const { product } = await loadProduct(req, req.params.productId);
    await db.delete(mixProducts).where(eq(mixProducts.id, product.id));
    await log(req, product.sheetId, `Removed ${product.name} (was ${fmt(product.ratePerAcre)} ${product.unit}/acre)`);
    return { ok: true };
  });
};

export default routes;

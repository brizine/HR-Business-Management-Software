import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, lte, max, ne } from "drizzle-orm";
import { fuelEconomy, fuelEntrySchema, fuelEntryUpdateSchema, fuelTotals, totalCostOfOwnership } from "@crewdesk/shared";
import { db } from "../db";
import { assets, employees, fuelEntries, meterReadings, workOrders } from "../db/schema";
import { authenticate, isManager, requireRole } from "../lib/auth";
import { HttpError, notFound, parse } from "../lib/errors";
import { recordMeter } from "../lib/fleet";
import { storage } from "../lib/storage";

const AREA = "fleet";
const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"];
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
/** A fill-up's logger can fix or remove it for this long; fleet managers any time. */
const OWN_EDIT_HOURS = 24;

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);

  async function loadAsset(companyId: string, id: string) {
    const [a] = await db.select().from(assets).where(and(eq(assets.id, id), eq(assets.companyId, companyId)));
    if (!a) notFound("Asset");
    return a;
  }
  async function loadEntry(companyId: string, id: string) {
    const [e] = await db.select().from(fuelEntries).where(and(eq(fuelEntries.id, id), eq(fuelEntries.companyId, companyId)));
    if (!e) notFound("Fuel entry");
    return e;
  }
  const canChange = (req: Parameters<typeof isManager>[0] & { user: { sub: string } }, e: typeof fuelEntries.$inferSelect) =>
    isManager(req, AREA) || (e.createdById === req.user.sub && Date.now() - e.createdAt.getTime() < OWN_EDIT_HOURS * 3_600_000);
  const notFuture = (date: string) => {
    if (date > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new HttpError(400, "The date can't be in the future");
  };
  const view = (e: typeof fuelEntries.$inferSelect, createdBy: string | null) => {
    const { receiptKey, ...rest } = e;
    return { ...rest, hasReceipt: !!receiptKey, createdBy };
  };

  /** An asset's fill-ups, newest first (everyone who can see assets; drivers log their own). */
  app.get<{ Querystring: { assetId?: string } }>("/", async (req) => {
    if (!req.query.assetId) throw new HttpError(400, "Pick an asset");
    const asset = await loadAsset(req.user.companyId, req.query.assetId);
    const rows = await db.select({ e: fuelEntries, first: employees.firstName, last: employees.lastName }).from(fuelEntries)
      .leftJoin(employees, eq(employees.id, fuelEntries.createdById))
      .where(eq(fuelEntries.assetId, asset.id))
      .orderBy(desc(fuelEntries.date), desc(fuelEntries.createdAt));
    return rows.map(({ e, first, last }) => view(e, first ? `${first} ${last}` : null));
  });

  /** Log a fill-up. Its odometer / hours also update the asset's meters (which keeps maintenance due dates current). */
  app.post("/", async (req) => {
    const body = parse(fuelEntrySchema, req.body);
    notFuture(body.date);
    const asset = await loadAsset(req.user.companyId, body.assetId);
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(fuelEntries).values({
        ...body,
        vendor: body.vendor || null,
        notes: body.notes || null,
        odometer: body.odometer ?? null,
        hours: body.hours ?? null,
        companyId: req.user.companyId,
        createdById: req.user.sub,
      }).returning();
      if (body.odometer != null || body.hours != null) {
        await recordMeter(tx, asset, { odometer: body.odometer ?? undefined, engineHours: body.hours ?? undefined }, req.user.sub);
      }
      return view(row, null);
    });
  });

  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const e = await loadEntry(req.user.companyId, req.params.id);
    if (!canChange(req, e)) throw new HttpError(403, "Only fleet managers can change this fill-up now");
    const body = parse(fuelEntryUpdateSchema, req.body);
    notFuture(body.date);
    const [row] = await db.update(fuelEntries).set({
      ...body, vendor: body.vendor || null, notes: body.notes || null, odometer: body.odometer ?? null, hours: body.hours ?? null,
    }).where(eq(fuelEntries.id, e.id)).returning();
    return view(row, null);
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const e = await loadEntry(req.user.companyId, req.params.id);
    if (!canChange(req, e)) throw new HttpError(403, "Only fleet managers can remove this fill-up now");
    await db.delete(fuelEntries).where(eq(fuelEntries.id, e.id));
    return { ok: true };
  });

  /** Attach (or replace) the receipt: a photo or PDF, multipart field "file". */
  app.post<{ Params: { id: string } }>("/:id/receipt", async (req) => {
    const e = await loadEntry(req.user.companyId, req.params.id);
    if (!canChange(req, e)) throw new HttpError(403, "Only fleet managers can change this receipt now");
    const file = await req.file();
    if (!file) throw new HttpError(400, "No file uploaded");
    if (!RECEIPT_TYPES.includes(file.mimetype)) throw new HttpError(400, "Upload a photo (JPG, PNG, HEIC) or a PDF");
    const buf = await file.toBuffer();
    if (buf.length > MAX_RECEIPT_BYTES) throw new HttpError(400, "The receipt must be under 10 MB");
    const key = `${req.user.companyId}/fuel/${randomUUID()}-${file.filename.replace(/[^\w.-]/g, "_")}`;
    await storage.put(key, buf);
    await db.update(fuelEntries).set({ receiptKey: key, receiptMime: file.mimetype }).where(eq(fuelEntries.id, e.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/:id/receipt", async (req, reply) => {
    const e = await loadEntry(req.user.companyId, req.params.id);
    if (!isManager(req, AREA) && e.createdById !== req.user.sub) notFound("Receipt");
    if (!e.receiptKey) notFound("Receipt");
    reply.header("Content-Type", e.receiptMime ?? "application/octet-stream");
    reply.header("Content-Disposition", `inline; filename="fuel-receipt-${e.date}"`);
    reply.header("Cache-Control", "private, no-store");
    return reply.send(await storage.get(e.receiptKey));
  });

  /**
   * Fleet costs for a date range, per asset: fuel (amount, cost, economy), maintenance, miles /
   * hours run, cost per mile / hour, and lifetime total cost of ownership. Flags assets whose fuel
   * economy in the range is 15%+ worse than their usual.
   */
  app.get<{ Querystring: { from?: string; to?: string } }>("/report", { preHandler: requireRole("manager", AREA) }, async (req) => {
    const { from, to } = req.query;
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new HttpError(400, "Pick a date range");
    const companyId = req.user.companyId;
    const fleet = await db.select().from(assets).where(and(eq(assets.companyId, companyId), ne(assets.status, "retired"))).orderBy(asc(assets.name));
    const fuel = await db.select().from(fuelEntries).where(eq(fuelEntries.companyId, companyId));
    const done = await db.select({ assetId: workOrders.assetId, completedAt: workOrders.completedAt, parts: workOrders.partsCostCents, labor: workOrders.laborCostCents })
      .from(workOrders).where(and(eq(workOrders.companyId, companyId), eq(workOrders.status, "completed")));
    const ids = fleet.map((a) => a.id);
    // Meter at the end of the range and just before it starts: the difference is what it ran.
    const endAt = new Date(`${to}T23:59:59.999Z`);
    const startAt = new Date(`${from}T00:00:00Z`);
    const meterUpTo = async (at: Date, before: boolean) => ids.length
      ? db.select({ assetId: meterReadings.assetId, odo: max(meterReadings.odometer), hrs: max(meterReadings.engineHours) }).from(meterReadings)
          .where(and(inArray(meterReadings.assetId, ids), before ? lt(meterReadings.createdAt, at) : lte(meterReadings.createdAt, at))).groupBy(meterReadings.assetId)
      : [];
    const [atEnd, beforeStart, firstInRange] = await Promise.all([
      meterUpTo(endAt, false),
      meterUpTo(startAt, true),
      ids.length ? db.select({ assetId: meterReadings.assetId, odo: meterReadings.odometer, hrs: meterReadings.engineHours, at: meterReadings.createdAt }).from(meterReadings)
        .where(and(inArray(meterReadings.assetId, ids), gte(meterReadings.createdAt, startAt), lte(meterReadings.createdAt, endAt))).orderBy(asc(meterReadings.createdAt)) : [],
    ]);
    const byAsset = <T extends { assetId: string }>(rows: T[]) => new Map(rows.map((r) => [r.assetId, r]));
    const endMap = byAsset(atEnd), startMap = byAsset(beforeStart);
    const firstOdo = new Map<string, number>(), firstHrs = new Map<string, number>();
    for (const r of firstInRange) {
      if (r.odo != null && r.odo > 0 && !firstOdo.has(r.assetId)) firstOdo.set(r.assetId, r.odo);
      if (r.hrs != null && r.hrs > 0 && !firstHrs.has(r.assetId)) firstHrs.set(r.assetId, r.hrs);
    }
    const ran = (end: number | null | undefined, start: number | null | undefined) => (end != null && start != null && end > start ? end - start : 0);
    const inRange = (d: Date | null) => !!d && d >= startAt && d <= endAt;

    const rows = fleet.map((a) => {
      const all = fuel.filter((f) => f.assetId === a.id);
      const period = all.filter((f) => f.date >= from && f.date <= to);
      const totals = fuelTotals(period);
      const meter = a.odometer > 0 || all.some((f) => f.odometer != null) ? "odometer" : "hours";
      const econ = fuelEconomy(period, meter);
      const usual = fuelEconomy(all, meter);
      const maint = done.filter((w) => w.assetId === a.id);
      const maintPeriod = maint.filter((w) => inRange(w.completedAt)).reduce((t, w) => t + w.parts + w.labor, 0);
      const miles = ran(endMap.get(a.id)?.odo, startMap.get(a.id)?.odo || firstOdo.get(a.id));
      const hours = ran(endMap.get(a.id)?.hrs, startMap.get(a.id)?.hrs || firstHrs.get(a.id));
      const spend = totals.costCents + maintPeriod;
      // Economy is miles (or hours) per gallon: lower is worse.
      const drop = econ.perUnit && usual.perUnit && econ.distance > 0 && usual.distance > econ.distance ? 1 - econ.perUnit / usual.perUnit : null;
      return {
        assetId: a.id, name: a.name, type: a.type, meter,
        fills: totals.fills, quantity: totals.quantity, defQuantity: totals.defQuantity, fuelCents: totals.costCents, avgPriceCents: totals.avgPriceCents,
        economy: econ.perUnit, usualEconomy: usual.perUnit, economyDrop: drop != null && drop >= 0.15 ? drop : null,
        maintenanceCents: maintPeriod, totalCents: spend, miles, hours,
        perMileCents: miles > 0 ? spend / miles : null, perHourCents: hours > 0 ? spend / hours : null,
        tco: totalCostOfOwnership({
          purchasePriceCents: a.purchasePriceCents, purchaseDate: a.purchaseDate, purchaseOdometer: a.purchaseOdometer, purchaseHours: a.purchaseHours,
          odometer: a.odometer, engineHours: a.engineHours,
          maintenanceCents: maint.reduce((t, w) => t + w.parts + w.labor, 0), fuelCents: all.reduce((t, f) => t + f.totalCostCents, 0),
        }),
      };
    });
    const sum = (k: "fuelCents" | "maintenanceCents" | "totalCents" | "quantity" | "miles") => rows.reduce((t, r) => t + r[k], 0);
    return { from, to, rows, totals: { fuelCents: sum("fuelCents"), maintenanceCents: sum("maintenanceCents"), totalCents: sum("totalCents"), quantity: sum("quantity"), miles: sum("miles") } };
  });
};

export default routes;

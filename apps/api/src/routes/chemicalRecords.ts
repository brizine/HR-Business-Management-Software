import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { applicatorCertSchema, chemicalSettingsSchema, csvRow, recordCorrectionSchema, windText } from "@crewdesk/shared";
import { db } from "../db";
import {
  applicationRecordChanges, applicationRecordProducts, applicationRecords, applicatorCerts, companies, employees, productLabels, products, visitWeather,
} from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { fileView, sendStored, storeUpload } from "../lib/attachments";
import { HttpError, parse } from "../lib/errors";
import { refreshIssues } from "../lib/chemicalRecords";

const AREA = "customers" as const;
const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

type Q = { from?: string; to?: string; customerId?: string; productId?: string; applicatorId?: string; visitId?: string; status?: string };

/** The filters the log and its export share. Voided records only when asked for (status=voided). */
function filters(req: FastifyRequest<{ Querystring: Q }>) {
  const q = req.query;
  const where: SQL[] = [eq(applicationRecords.companyId, req.user.companyId)];
  if (isoDate(q.from)) where.push(gte(applicationRecords.appliedOn, q.from!));
  if (isoDate(q.to)) where.push(lte(applicationRecords.appliedOn, q.to!));
  if (q.customerId) where.push(eq(applicationRecords.customerId, q.customerId));
  if (q.applicatorId) where.push(eq(applicationRecords.applicatorId, q.applicatorId));
  if (q.visitId) where.push(eq(applicationRecords.visitId, q.visitId));
  if (q.productId) where.push(exists(db.select({ x: applicationRecordProducts.id }).from(applicationRecordProducts).where(and(eq(applicationRecordProducts.recordId, applicationRecords.id), eq(applicationRecordProducts.productId, q.productId)))));
  if (q.status === "voided") where.push(isNotNull(applicationRecords.voidedAt));
  else {
    where.push(isNull(applicationRecords.voidedAt));
    if (q.status === "issues") where.push(sql`jsonb_array_length(${applicationRecords.issues}) > 0`);
  }
  return and(...where);
}

async function withDetail(recordIds: string[]) {
  if (!recordIds.length) return { products: [], weather: [] as (typeof visitWeather.$inferSelect)[] };
  const ps = await db.select().from(applicationRecordProducts).where(inArray(applicationRecordProducts.recordId, recordIds)).orderBy(asc(applicationRecordProducts.sortOrder));
  const recs = await db.select({ visitId: applicationRecords.visitId }).from(applicationRecords).where(inArray(applicationRecords.id, recordIds));
  const visitIds = recs.map((r) => r.visitId).filter((x): x is string => !!x);
  const weather = visitIds.length ? await db.select().from(visitWeather).where(inArray(visitWeather.visitId, visitIds)) : [];
  return { products: ps, weather };
}

/**
 * Chemical application records (ODAFF, OAC 35:30-17-21): the log, each record, corrections, the
 * export for an inspection, and what they draw on (applicator certifications, the license number,
 * product labels). Managers in Customers & billing read and correct; admins set certifications.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));
  const admin = { preHandler: requireRole("admin", AREA) };

  app.get<{ Querystring: Q & { limit?: string } }>("/", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const rows = await db.select().from(applicationRecords).where(filters(req)).orderBy(desc(applicationRecords.appliedOn), desc(applicationRecords.startedAt)).limit(limit);
    const { products: ps, weather } = await withDetail(rows.map((r) => r.id));
    return rows.map((r) => ({
      ...r,
      products: ps.filter((p) => p.recordId === r.id).map((p) => ({ id: p.id, tradeName: p.tradeName, epaRegNo: p.epaRegNo, amount: p.amount, unit: p.unit })),
      weather: weather.find((w) => w.visitId === r.visitId) ?? null,
    }));
  });

  /** Everything on one record, for the printable page. */
  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const [r] = await db.select().from(applicationRecords).where(and(eq(applicationRecords.id, req.params.id), eq(applicationRecords.companyId, req.user.companyId)));
    if (!r) throw new HttpError(404, "Record not found");
    const { products: ps, weather } = await withDetail([r.id]);
    const labelIds = ps.map((p) => p.labelId).filter((x): x is string => !!x);
    const labels = labelIds.length ? await db.select().from(productLabels).where(inArray(productLabels.id, labelIds)) : [];
    const changes = await db.select({ c: applicationRecordChanges, first: employees.firstName, last: employees.lastName }).from(applicationRecordChanges)
      .leftJoin(employees, eq(employees.id, applicationRecordChanges.employeeId))
      .where(eq(applicationRecordChanges.recordId, r.id)).orderBy(asc(applicationRecordChanges.seq));
    return {
      ...r,
      products: ps.map((p) => ({ ...p, label: (() => { const l = labels.find((x) => x.id === p.labelId); return l ? fileView(l) : null; })() })),
      weather: weather[0] ?? null,
      changes: changes.map((x) => ({ ...x.c, by: x.first ? `${x.first} ${x.last}` : null })),
    };
  });

  /** A correction: only what's sent changes; each change is logged with who, when and why. Voided records can't change. */
  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(recordCorrectionSchema, req.body);
    const [r] = await db.select().from(applicationRecords).where(and(eq(applicationRecords.id, req.params.id), eq(applicationRecords.companyId, req.user.companyId)));
    if (!r) throw new HttpError(404, "Record not found");
    if (r.voidedAt) throw new HttpError(400, "This record was voided; it can't be changed");
    const str = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
    await db.transaction(async (tx) => {
      let [{ seq }] = await tx.select({ seq: sql<number>`coalesce(max(${applicationRecordChanges.seq}), 0)::int` }).from(applicationRecordChanges).where(eq(applicationRecordChanges.recordId, r.id));
      const log = (field: string, from: unknown, to: unknown) => tx.insert(applicationRecordChanges).values({ recordId: r.id, employeeId: req.user.sub, field, oldValue: str(from), newValue: str(to), reason: body.reason, seq: ++seq });
      const set: Partial<typeof applicationRecords.$inferInsert> = {};
      for (const k of ["startedAt", "stoppedAt"] as const) {
        if (body[k] === undefined) continue;
        const next = body[k] ? new Date(body[k]!) : null;
        if (str(next) !== str(r[k])) { set[k] = next; await log(k, r[k], next); }
      }
      for (const k of ["site", "areaSqFt", "tankMixGal"] as const) {
        if (body[k] === undefined || body[k] === r[k]) continue;
        (set as Record<string, unknown>)[k] = body[k];
        await log(k, r[k], body[k]);
      }
      const start = set.startedAt !== undefined ? set.startedAt : r.startedAt;
      const stop = set.stoppedAt !== undefined ? set.stoppedAt : r.stoppedAt;
      if (start && stop && start > stop) throw new HttpError(400, "The stop time is before the start time");
      if (Object.keys(set).length) await tx.update(applicationRecords).set({ ...set, updatedAt: new Date() }).where(eq(applicationRecords.id, r.id));
      if (body.products?.length) {
        const ps = await tx.select().from(applicationRecordProducts).where(eq(applicationRecordProducts.recordId, r.id));
        for (const c of body.products) {
          const p = ps.find((x) => x.id === c.id);
          if (!p) throw new HttpError(400, "That product isn't on this record");
          const patch: Partial<typeof applicationRecordProducts.$inferInsert> = {};
          if (c.amount !== undefined && c.amount !== p.amount) { patch.amount = c.amount; await log(`${p.tradeName}: amount (${p.unit})`, p.amount, c.amount); }
          if (c.targets !== undefined && c.targets !== p.targets) { patch.targets = c.targets; await log(`${p.tradeName}: target pest`, p.targets, c.targets); }
          if (Object.keys(patch).length) await tx.update(applicationRecordProducts).set(patch).where(eq(applicationRecordProducts.id, p.id));
        }
      }
      await refreshIssues(tx, r.id);
    });
    return { ok: true };
  });

  /** The log as a CSV, one row per product applied (for an inspection or a summary to the Board). */
  app.get<{ Querystring: Q }>("/export.csv", async (req, reply) => {
    const rows = await db.select().from(applicationRecords).where(filters(req)).orderBy(asc(applicationRecords.appliedOn), asc(applicationRecords.startedAt)).limit(50_000);
    const { products: ps, weather } = await withDetail(rows.map((r) => r.id));
    const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, req.user.companyId));
    const tz = co?.tz ?? "America/Chicago";
    const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "");
    const out = [csvRow([
      "Date", "Start", "Stop", "Work order", "Company", "Company address", "License #", "Applicator", "Cert #", "Cert expires",
      "Customer", "Customer address", "Site address", "Site", "Area (sq ft)", "Tank mix (gal)",
      "Product (trade name)", "EPA reg #", "Rate per 1,000 sq ft", "Unit", "Dilution per gal", "Amount used", "Target pest", "REI (hours)",
      "Wind", "Temperature (°F)", "Issues",
    ])];
    for (const r of rows) {
      const w = weather.find((x) => x.visitId === r.visitId);
      const wind = w ? windText(w) : "";
      const lines = ps.filter((p) => p.recordId === r.id);
      for (const p of lines.length ? lines : [null]) {
        out.push(csvRow([
          r.appliedOn, time(r.startedAt), time(r.stoppedAt), r.visitNumber ? `WO-${r.visitNumber}` : "", r.companyName, r.companyAddress, r.companyLicenseNo,
          r.applicatorName, r.applicatorCertNo, r.applicatorCertExpires, r.customerName, r.customerAddress, r.siteAddress, r.site,
          r.areaSqFt != null ? Math.round(r.areaSqFt) : "", r.tankMixGal != null ? Math.round(r.tankMixGal * 10) / 10 : "",
          p?.tradeName, p?.epaRegNo, p?.ratePer1000, p?.unit, p?.dilutionPerGal != null ? Math.round(p.dilutionPerGal * 10000) / 10000 : (p ? "not mixed" : ""),
          p ? Math.round(p.amount * 1000) / 1000 : "", p?.targets, p?.reiHours, wind, w?.tempF ?? "", r.issues.join("; "),
        ]));
      }
    }
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="chemical-records${isoDate(req.query.from) ? `-${req.query.from}` : ""}${isoDate(req.query.to) ? `-to-${req.query.to}` : ""}.csv"`);
    return `﻿${out.join("\r\n")}\r\n`;
  });

  /** The company's pesticide license number. */
  app.get("/settings", async (req) => {
    const [c] = await db.select({ pesticideLicenseNo: companies.pesticideLicenseNo }).from(companies).where(eq(companies.id, req.user.companyId));
    return c;
  });
  app.put("/settings", admin, async (req) => {
    const body = parse(chemicalSettingsSchema, req.body);
    await db.update(companies).set(body).where(eq(companies.id, req.user.companyId));
    return body;
  });

  /** Everyone active, with their applicator certification (if any). */
  app.get("/applicators", async (req) => {
    const rows = await db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, cert: applicatorCerts })
      .from(employees).leftJoin(applicatorCerts, eq(applicatorCerts.employeeId, employees.id))
      .where(and(eq(employees.companyId, req.user.companyId), eq(employees.status, "active"))).orderBy(asc(employees.firstName), asc(employees.lastName));
    return rows.map((r) => ({ id: r.id, name: `${r.first} ${r.last}`.trim(), certNo: r.cert?.certNo ?? null, expiresOn: r.cert?.expiresOn ?? null, categories: r.cert?.categories ?? null }));
  });
  app.put<{ Params: { employeeId: string } }>("/applicators/:employeeId", admin, async (req) => {
    const body = parse(applicatorCertSchema, req.body);
    const [e] = await db.select({ id: employees.id }).from(employees).where(and(eq(employees.id, req.params.employeeId), eq(employees.companyId, req.user.companyId)));
    if (!e) throw new HttpError(404, "Employee not found");
    const values = { certNo: body.certNo, expiresOn: body.expiresOn, categories: body.categories ?? null, updatedById: req.user.sub, updatedAt: new Date() };
    await db.insert(applicatorCerts).values({ ...values, employeeId: e.id, companyId: req.user.companyId })
      .onConflictDoUpdate({ target: applicatorCerts.employeeId, set: values });
    return { ok: true };
  });
  app.delete<{ Params: { employeeId: string } }>("/applicators/:employeeId", admin, async (req) => {
    await db.delete(applicatorCerts).where(and(eq(applicatorCerts.employeeId, req.params.employeeId), eq(applicatorCerts.companyId, req.user.companyId)));
    return { ok: true };
  });

  /** A product's labels (newest first). */
  app.get<{ Params: { productId: string } }>("/labels/:productId", async (req) => {
    const rows = await db.select().from(productLabels).where(and(eq(productLabels.productId, req.params.productId), eq(productLabels.companyId, req.user.companyId))).orderBy(desc(productLabels.createdAt));
    return rows.map((l) => fileView(l));
  });
  /** Uploads a label (PDF or photo). Older labels stay: records made before link the label they used. */
  app.post<{ Params: { productId: string } }>("/labels/:productId", admin, async (req) => {
    const [p] = await db.select({ id: products.id }).from(products).where(and(eq(products.id, req.params.productId), eq(products.companyId, req.user.companyId)));
    if (!p) throw new HttpError(404, "Product not found");
    const stored = await storeUpload(req, "product-labels", p.id);
    const [row] = await db.insert(productLabels).values({ ...stored, companyId: req.user.companyId, productId: p.id, uploadedById: req.user.sub }).returning();
    return fileView(row);
  });
  app.get<{ Params: { labelId: string }; Querystring: { download?: string } }>("/label-files/:labelId", async (req, reply) => {
    const [l] = await db.select().from(productLabels).where(and(eq(productLabels.id, req.params.labelId), eq(productLabels.companyId, req.user.companyId)));
    if (!l) throw new HttpError(404, "Label not found");
    return sendStored(reply, l, !!req.query.download);
  });
};

export default routes;

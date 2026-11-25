import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { applicatorCertSchema, chemicalSettingsSchema, csvRow, formatRateAmount, recordCorrectionSchema, windText } from "@crewdesk/shared";
import { db } from "../db";
import {
  applicationRecordChanges, applicationRecordProducts, applicationRecords, applicatorCerts, companies, employees, productLabels, products, properties, visitWeather,
} from "../db/schema";
import { authenticate } from "../lib/auth";
import { requireChemicalAccess } from "../lib/chemicalAccess";
import { fileView, sendStored, storeUpload } from "../lib/attachments";
import { HttpError, parse } from "../lib/errors";
import { refreshIssues } from "../lib/chemicalRecords";
import { companyToday } from "../lib/payRates";
import { monthlyPdf, recordsPdf, type PdfMonthlyRow, type PdfRecordLine } from "../lib/recordsPdf";

const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

type Q = { from?: string; to?: string; customerId?: string; propertyId?: string; productId?: string; applicatorId?: string; mapCode?: string; q?: string; visitId?: string; status?: string };

/** The filters the log and its export share. Voided records only when asked for (status=voided). */
function filters(req: FastifyRequest<{ Querystring: Q }>) {
  const q = req.query;
  const where: SQL[] = [eq(applicationRecords.companyId, req.user.companyId)];
  if (isoDate(q.from)) where.push(gte(applicationRecords.appliedOn, q.from!));
  if (isoDate(q.to)) where.push(lte(applicationRecords.appliedOn, q.to!));
  if (q.customerId) where.push(eq(applicationRecords.customerId, q.customerId));
  if (q.propertyId) where.push(eq(applicationRecords.propertyId, q.propertyId));
  // Property search: the customer's name or the site's address, as on the record.
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(applicationRecords.customerName, like), ilike(applicationRecords.siteAddress, like))!);
  }
  // Map Code: the property's code now (records keep the address, not the code).
  if (q.mapCode?.trim()) {
    where.push(exists(db.select({ x: properties.id }).from(properties).where(and(eq(properties.id, applicationRecords.propertyId), sql`upper(${properties.mapCode}) = upper(${q.mapCode.trim()})`))));
  }
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

const longDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const fileName = (base: string, q: Q, ext: string) => `${base}${isoDate(q.from) ? `-${q.from}` : ""}${isoDate(q.to) ? `-to-${q.to}` : ""}.${ext}`;

/** What the filters say, for the top of a PDF. */
async function filterText(req: FastifyRequest<{ Querystring: Q }>) {
  const q = req.query;
  const parts = [isoDate(q.from) || isoDate(q.to) ? `${isoDate(q.from) ? longDate(q.from!) : "the start"} to ${isoDate(q.to) ? longDate(q.to!) : "today"}` : "All dates"];
  if (q.q?.trim()) parts.push(`Property: "${q.q.trim()}"`);
  if (q.mapCode?.trim()) parts.push(`Map Code ${q.mapCode.trim().toUpperCase()}`);
  if (q.productId) { const [p] = await db.select({ n: products.name }).from(products).where(and(eq(products.id, q.productId), eq(products.companyId, req.user.companyId))); if (p) parts.push(`Product: ${p.n}`); }
  if (q.applicatorId) { const [e] = await db.select({ f: employees.firstName, l: employees.lastName }).from(employees).where(and(eq(employees.id, q.applicatorId), eq(employees.companyId, req.user.companyId))); if (e) parts.push(`Applicator: ${e.f} ${e.l}`); }
  if (q.status === "issues") parts.push("Only records with something missing");
  if (q.status === "voided") parts.push("Voided records");
  return parts.join(" · ");
}

/** Totals per month and product (for the filters), largest months last. */
async function monthlyTotals(req: FastifyRequest<{ Querystring: Q }>) {
  const month = sql<string>`to_char(${applicationRecords.appliedOn}, 'YYYY-MM')`;
  const productKey = sql<string>`coalesce(${applicationRecordProducts.productId}::text, ${applicationRecordProducts.tradeName})`;
  const rows = await db.select({
    month, productId: applicationRecordProducts.productId, tradeName: sql<string>`max(${applicationRecordProducts.tradeName})`, epaRegNo: sql<string | null>`max(${applicationRecordProducts.epaRegNo})`,
    unit: applicationRecordProducts.unit, amount: sql<number>`sum(${applicationRecordProducts.amount})::float8`, applications: sql<number>`count(distinct ${applicationRecords.id})::int`,
  }).from(applicationRecordProducts).innerJoin(applicationRecords, eq(applicationRecords.id, applicationRecordProducts.recordId))
    .where(and(filters(req), ...(req.query.productId ? [eq(applicationRecordProducts.productId, req.query.productId)] : [])))
    .groupBy(month, productKey, applicationRecordProducts.productId, applicationRecordProducts.unit)
    .orderBy(month, sql`max(${applicationRecordProducts.tradeName})`);
  return rows;
}

/**
 * Chemical application records (ODAFF, OAC 35:30-17-21): the log, each record, corrections, the
 * export for an inspection, and what they draw on (applicator certifications, the license number,
 * product labels). Part of Chemical Tracking: admins and the people they add.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  // Chemical Tracking only: admins and the people they add (see lib/chemicalAccess).
  app.addHook("preHandler", requireChemicalAccess);
  const admin = {};

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
      "Product (trade name)", "EPA reg #", "Mix", "Application method", "Rate per 1,000 sq ft", "Unit", "Dilution per gal", "Amount used", "Target pest", "REI (hours)",
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
          p?.tradeName, p?.epaRegNo, p?.mixName ?? "", p?.methodName, p?.ratePer1000, p?.unit, p?.dilutionPerGal != null ? Math.round(p.dilutionPerGal * 10000) / 10000 : (p ? "not mixed" : ""),
          p ? Math.round(p.amount * 1000) / 1000 : "", p?.targets, p?.reiHours, wind, w?.tempF ?? "", r.issues.join("; "),
        ]));
      }
    }
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${fileName("chemical-records", req.query, "csv")}"`);
    return `﻿${out.join("\r\n")}\r\n`;
  });

  /** The same rows as a PDF: one row per product applied, for an inspection or to keep. */
  app.get<{ Querystring: Q }>("/export.pdf", async (req, reply) => {
    const rows = await db.select().from(applicationRecords).where(filters(req)).orderBy(asc(applicationRecords.appliedOn), asc(applicationRecords.startedAt)).limit(5_000);
    const { products: ps, weather } = await withDetail(rows.map((r) => r.id));
    const [co] = await db.select({ tz: companies.timezone, name: companies.name, license: companies.pesticideLicenseNo }).from(companies).where(eq(companies.id, req.user.companyId));
    const tz = co?.tz ?? "America/Chicago";
    const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "");
    const lines: PdfRecordLine[] = [];
    for (const r of rows) {
      const w = weather.find((x) => x.visitId === r.visitId);
      const record = {
        date: longDate(r.appliedOn), time: [time(r.startedAt), time(r.stoppedAt)].filter(Boolean).join("–") || "no times",
        customer: r.customerName, site: [r.siteAddress, r.site].filter(Boolean).join("\n"),
        applicator: `${r.applicatorName}${r.applicatorCertNo ? `\nCert ${r.applicatorCertNo}` : ""}`,
        area: r.areaSqFt != null ? Math.round(r.areaSqFt).toLocaleString("en-US") : "",
        weather: w ? [windText(w), w.tempF != null ? `${w.tempF}°F` : null].filter(Boolean).join(", ") : "not recorded",
        voided: !!r.voidedAt, issues: r.issues.length,
      };
      const mine = ps.filter((p) => p.recordId === r.id);
      if (!mine.length) lines.push({ record: { ...record, first: true }, product: "(no products)", epa: "", method: "", rate: "", amount: "" });
      mine.forEach((p, i) => lines.push({
        record: { ...record, first: i === 0 }, product: p.tradeName, epa: p.epaRegNo ?? "",
        method: [p.methodName, p.mixName ? `Mix: ${p.mixName}` : null].filter(Boolean).join("\n"),
        rate: formatRateAmount(Math.round(p.ratePer1000 * 1000) / 1000, p.unit), amount: formatRateAmount(Math.round(p.amount * 1000) / 1000, p.unit),
      }));
    }
    const pdf = await recordsPdf({
      title: `${co?.name ?? ""}: chemical application records`,
      sub: [await filterText(req), `${rows.length} record${rows.length === 1 ? "" : "s"}${co?.license ? ` · Pesticide license ${co.license}` : ""} · Made ${longDate(await companyToday(req.user.companyId))}`, "Oklahoma Department of Agriculture, Food and Forestry, OAC 35:30-17-21"],
      lines,
    });
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${fileName("chemical-records", req.query, "pdf")}"`);
    return reply.send(Buffer.from(pdf));
  });

  /** Totals per month and product, for the same filters. */
  app.get<{ Querystring: Q }>("/monthly", async (req) => monthlyTotals(req));
  app.get<{ Querystring: Q }>("/monthly.csv", async (req, reply) => {
    const rows = await monthlyTotals(req);
    const out = [csvRow(["Month", "Product (trade name)", "EPA reg #", "Total applied", "Unit", "Applications"])];
    for (const r of rows) out.push(csvRow([r.month, r.tradeName, r.epaRegNo, Math.round(r.amount * 1000) / 1000, r.unit, r.applications]));
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${fileName("chemical-monthly-totals", req.query, "csv")}"`);
    return `\ufeff${out.join("\r\n")}\r\n`;
  });
  app.get<{ Querystring: Q }>("/monthly.pdf", async (req, reply) => {
    const rows = await monthlyTotals(req);
    const [co] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, req.user.companyId));
    const out: PdfMonthlyRow[] = rows.map((r, i) => ({
      month: monthLabel(r.month), first: i === 0 || rows[i - 1].month !== r.month, product: r.tradeName, epa: r.epaRegNo ?? "",
      amount: formatRateAmount(Math.round(r.amount * 100) / 100, r.unit), applications: r.applications,
    }));
    const pdf = await monthlyPdf({ title: `${co?.name ?? ""}: monthly product totals`, sub: [await filterText(req), `Made ${longDate(await companyToday(req.user.companyId))}`], rows: out });
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${fileName("chemical-monthly-totals", req.query, "pdf")}"`);
    return reply.send(Buffer.from(pdf));
  });

  /** Map Codes of properties that have records, for the filter. */
  app.get("/map-codes", async (req) => {
    const rows = await db.selectDistinct({ code: properties.mapCode }).from(applicationRecords).innerJoin(properties, eq(properties.id, applicationRecords.propertyId))
      .where(and(eq(applicationRecords.companyId, req.user.companyId), isNotNull(properties.mapCode))).orderBy(properties.mapCode);
    return rows.map((r) => r.code).filter(Boolean);
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

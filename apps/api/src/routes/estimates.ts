import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ESTIMATE_STATUSES, ESTIMATE_STATUS_LABELS, customerName, estimateLineAmount, estimateResponseSchema, estimateSchema, estimateTotals, formatAddress,
  formatMoney, lineIncluded, sendEstimateSchema, type EstimateInput, type EstimateResponse,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, customers, employees, estimateLines, estimates, invoiceLines, invoices, properties } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { WEB_URL, emailTransport } from "../lib/channels";
import { customerInCompany, type Tx } from "../lib/crm";
import { randomToken } from "../lib/crypto";
import { HttpError, parse } from "../lib/errors";
import { estimatePdf } from "../lib/estimatePdf";
import { billToLines } from "../lib/invoicePdf";
import { addDays, billingSettings } from "../lib/invoices";
import { notify, staffWithRole } from "../lib/notify";
import { companyToday } from "../lib/payRates";
import { companyForPdf, sendPdf } from "./invoices";

const AREA = "customers" as const;
type Estimate = typeof estimates.$inferSelect;
type Line = typeof estimateLines.$inferSelect;

/** Numbered per company from 1000 (like Homeworks). */
async function nextEstimateNumber(tx: Tx, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimates:${companyId}`}))`);
  const [r] = await tx.select({ n: sql<number | null>`max(${estimates.number})` }).from(estimates).where(eq(estimates.companyId, companyId));
  return Math.max(999, r?.n ?? 999) + 1;
}

/** The properties (estimate's and lines') must be in this company. */
async function checkProperties(companyId: string, body: EstimateInput) {
  const ids = [...new Set([body.propertyId, ...body.lines.map((l) => l.propertyId)].filter((x): x is string => !!x))];
  if (!ids.length) return;
  const found = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.companyId, companyId), inArray(properties.id, ids)));
  if (found.length !== ids.length) throw new HttpError(400, "Pick a service address from the list");
}

const chosenSet = (e: Pick<Estimate, "chosenLineIds" | "respondedAt" | "status">) => (e.status === "accepted" && e.chosenLineIds ? new Set(e.chosenLineIds) : null);

/** Saves the lines (keeping their ids, so a customer's choices stay with the right line) and the totals. */
async function saveLines(tx: Tx, e: Estimate, body: EstimateInput) {
  const old = await tx.select({ id: estimateLines.id }).from(estimateLines).where(eq(estimateLines.estimateId, e.id));
  const keep = new Set(old.map((l) => l.id));
  await tx.delete(estimateLines).where(eq(estimateLines.estimateId, e.id));
  const rows = body.lines.map((l, i) => ({
    ...(l.id && keep.has(l.id) ? { id: l.id } : {}), estimateId: e.id, serviceTypeId: l.serviceTypeId ?? null, propertyId: l.propertyId ?? null, description: l.description,
    quantity: l.quantity, unitPriceCents: l.unitPriceCents, visits: l.visits, taxRate: l.taxRate, incomeAccountCode: l.incomeAccountCode,
    costCents: l.costCents ?? null, budgetedHours: l.budgetedHours ?? null, optional: l.optional, selected: l.optional ? l.selected : true, recommended: l.recommended,
    amountCents: estimateLineAmount(l), sortOrder: i,
  }));
  const saved = rows.length ? await tx.insert(estimateLines).values(rows).returning() : [];
  await updateTotals(tx, e.id, saved, body.discountPercent, chosenSet(e));
  return saved;
}

async function updateTotals(tx: Tx, id: string, lines: Line[], discountPercent: number, chosen: Set<string> | null) {
  const t = estimateTotals(lines, discountPercent, chosen);
  await tx.update(estimates).set({ subtotalCents: t.subtotalCents, discountCents: t.discountCents, taxCents: t.taxCents, totalCents: t.totalCents, updatedAt: new Date() }).where(eq(estimates.id, id));
}

/** One estimate with its lines, customer, address and (for the office) costs and margin. */
async function estimateView(e: Estimate, opts: { office: boolean }) {
  const lines = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id)).orderBy(asc(estimateLines.sortOrder));
  const [cust] = await db.select().from(customers).where(eq(customers.id, e.customerId));
  const propIds = [...new Set([e.propertyId, ...lines.map((l) => l.propertyId)].filter((x): x is string => !!x))];
  const props = propIds.length ? await db.select().from(properties).where(inArray(properties.id, propIds)) : [];
  const addr = new Map(props.map((p) => [p.id, formatAddress(p)]));
  const chosen = chosenSet(e);
  const totals = estimateTotals(lines, e.discountPercent, chosen);
  const today = await companyToday(e.companyId);
  const expired = !!e.validUntil && e.validUntil < today && (e.status === "sent" || e.status === "changes");
  const base = {
    id: e.id, number: e.number, title: e.title, status: e.status, statusLabel: ESTIMATE_STATUS_LABELS[e.status as keyof typeof ESTIMATE_STATUS_LABELS] ?? e.status,
    issueDate: e.issueDate, validUntil: e.validUntil, poNumber: e.poNumber, discountPercent: e.discountPercent, expired,
    customer: { id: cust.id, name: customerName(cust), number: cust.number, email: cust.email },
    propertyId: e.propertyId, serviceAddress: e.propertyId ? addr.get(e.propertyId) ?? null : null,
    terms: e.terms, customerNotes: e.customerNotes, sentAt: e.sentAt, respondedAt: e.respondedAt, responseName: e.responseName, responseComment: e.responseComment,
    respondedBy: e.respondedBy, chosenLineIds: e.chosenLineIds ?? null,
    subtotalCents: totals.subtotalCents, discountCents: totals.discountCents, taxCents: totals.taxCents, totalCents: totals.totalCents,
    lines: lines.map((l) => ({
      id: l.id, serviceTypeId: l.serviceTypeId, propertyId: l.propertyId, address: l.propertyId ? addr.get(l.propertyId) ?? null : null, description: l.description,
      quantity: l.quantity, unitPriceCents: l.unitPriceCents, visits: l.visits, taxRate: l.taxRate, amountCents: l.amountCents,
      optional: l.optional, selected: l.selected, recommended: l.recommended, included: lineIncluded(l, chosen),
      ...(opts.office ? { incomeAccountCode: l.incomeAccountCode, costCents: l.costCents, budgetedHours: l.budgetedHours } : {}),
    })),
  };
  if (!opts.office) return base;
  const [by] = e.respondedById ? await db.select({ n: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}` }).from(employees).where(eq(employees.id, e.respondedById)) : [];
  return {
    ...base, requestedAt: e.requestedAt, internalNotes: e.internalNotes, emailedTo: e.emailedTo, viewedAt: e.viewedAt, respondedByName: by?.n ?? null,
    visitId: e.visitId, invoiceId: e.invoiceId, custom: e.custom, link: e.token ? `${WEB_URL}/estimate/${e.token}` : null,
    internal: { costCents: totals.costCents, profitCents: totals.profitCents, marginPercent: totals.marginPercent, hours: totals.hours, visitsRevenueCents: totals.visitsRevenueCents },
  };
}

/** The PDF, as the customer gets it. */
async function pdfFor(e: Estimate) {
  const view = await estimateView(e, { office: false });
  const [cust] = await db.select().from(customers).where(eq(customers.id, e.customerId));
  const [prop] = e.propertyId ? await db.select().from(properties).where(eq(properties.id, e.propertyId)) : [];
  const settings = await billingSettings(e.companyId);
  return estimatePdf(await companyForPdf(e.companyId), {
    number: e.number, status: e.status, issueDate: e.issueDate, validUntil: e.validUntil, poNumber: e.poNumber, title: e.title,
    customerName: view.customer.name, customerNumber: cust.number, billTo: billToLines(cust, prop ?? null), serviceAddress: view.serviceAddress,
    lines: view.lines, subtotalCents: view.subtotalCents, discountCents: view.discountCents, discountPercent: e.discountPercent, taxCents: view.taxCents,
    totalCents: view.totalCents, taxName: settings.taxName, customerNotes: e.customerNotes, terms: e.terms,
    acceptUrl: e.token && (e.status === "sent" || e.status === "changes") ? `${WEB_URL}/estimate/${e.token}` : null,
    accepted: e.status === "accepted" && e.respondedAt ? { name: e.responseName, at: e.respondedAt.toISOString() } : null,
  });
}

/**
 * Records an answer (the customer's online, or one the office took by phone): accepted (with the
 * optional lines chosen), declined, or changes requested. The office is told.
 */
async function recordResponse(e: Estimate, r: EstimateResponse, by: { customer: true } | { employeeId: string }) {
  const lines = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id));
  const optionalIds = new Set(lines.filter((l) => l.optional).map((l) => l.id));
  const chosen = r.action === "accept" ? r.selectedLineIds.filter((id) => optionalIds.has(id)) : null;
  const status = r.action === "accept" ? "accepted" : r.action === "decline" ? "declined" : "changes";
  const [u] = await db.update(estimates).set({
    status, respondedAt: new Date(), responseName: r.name ?? null, responseComment: r.comment ?? null, chosenLineIds: chosen,
    respondedBy: "customer" in by ? "customer" : "office", respondedById: "employeeId" in by ? by.employeeId : null, updatedAt: new Date(),
  }).where(eq(estimates.id, e.id)).returning();
  await updateTotals(db, u.id, lines, u.discountPercent, chosen ? new Set(chosen) : null);
  if ("customer" in by) {
    const [cust] = await db.select().from(customers).where(eq(customers.id, e.customerId));
    const [fresh] = await db.select().from(estimates).where(eq(estimates.id, e.id));
    const who = customerName(cust);
    const words = status === "accepted" ? `accepted (${formatMoney(fresh.totalCents)})` : status === "declined" ? "declined" : "asked for changes to";
    const managers = await staffWithRole(e.companyId, "manager", AREA);
    notify(e.companyId, [...managers, e.createdById], {
      category: "estimates", title: `${who} ${words} estimate ${e.number}`,
      body: r.comment ? `"${r.comment.slice(0, 200)}"` : status === "accepted" ? "Make it a work order or an invoice from the estimate." : "Open the estimate to follow up.",
      link: { screen: "estimate", id: e.id },
    });
  }
  return u;
}

const listQuery = z.object({
  status: z.enum([...ESTIMATE_STATUSES, "all", "open"]).default("all"),
  q: z.string().trim().max(100).optional(),
  customerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Estimates (Billing → Estimates), for managers in Customers & billing. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  /** The list with counts by status (like Homeworks' Total, Pending, Accepted, Declined, Changes requested). */
  app.get("/", async (req) => {
    const qy = parse(listQuery, req.query);
    const { companyId } = req.user;
    const where: SQL[] = [eq(estimates.companyId, companyId)];
    if (qy.customerId) where.push(eq(estimates.customerId, qy.customerId));
    if (qy.q) {
      const like = `%${qy.q}%`;
      const m: SQL[] = [ilike(estimates.title, like), ilike(customers.firstName, like), ilike(customers.lastName, like), ilike(customers.companyName, like),
        sql`(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')) ilike ${like}`];
      if (/^\d+$/.test(qy.q)) m.push(eq(estimates.number, Number(qy.q)));
      where.push(or(...m)!);
    }
    const counts = await db.select({ status: estimates.status, n: sql<number>`count(*)::int` }).from(estimates).innerJoin(customers, eq(customers.id, estimates.customerId))
      .where(and(...where)).groupBy(estimates.status);
    if (qy.status === "open") where.push(inArray(estimates.status, ["sent", "changes"]));
    else if (qy.status !== "all") where.push(eq(estimates.status, qy.status));
    const rows = await db.select({ e: estimates, c: customers }).from(estimates).innerJoin(customers, eq(customers.id, estimates.customerId))
      .where(and(...where)).orderBy(desc(estimates.number)).limit(qy.limit).offset(qy.offset);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(estimates).innerJoin(customers, eq(customers.id, estimates.customerId)).where(and(...where));
    const today = await companyToday(companyId);
    const by = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    return {
      total,
      counts: { ...Object.fromEntries(ESTIMATE_STATUSES.map((s) => [s, by[s] ?? 0])), all: counts.reduce((s, c) => s + c.n, 0) },
      rows: rows.map(({ e, c }) => ({
        id: e.id, number: e.number, title: e.title, status: e.status, issueDate: e.issueDate, validUntil: e.validUntil, totalCents: e.totalCents,
        sentAt: e.sentAt, viewedAt: e.viewedAt, respondedAt: e.respondedAt, visitId: e.visitId, invoiceId: e.invoiceId,
        expired: !!e.validUntil && e.validUntil < today && (e.status === "sent" || e.status === "changes"),
        customer: { id: c.id, name: customerName(c) },
      })),
    };
  });

  app.post("/", async (req) => {
    const body = parse(estimateSchema, req.body);
    const { companyId, sub } = req.user;
    await customerInCompany(db, companyId, body.customerId);
    await checkProperties(companyId, body);
    const today = await companyToday(companyId);
    const e = await db.transaction(async (tx) => {
      const number = await nextEstimateNumber(tx, companyId);
      const [row] = await tx.insert(estimates).values({
        companyId, number, customerId: body.customerId, propertyId: body.propertyId ?? null, title: body.title ?? null, issueDate: body.issueDate ?? today,
        validUntil: body.validUntil ?? null, requestedAt: body.requestedAt ? new Date(body.requestedAt) : null, poNumber: body.poNumber ?? null,
        discountPercent: body.discountPercent, terms: body.terms ?? null, customerNotes: body.customerNotes ?? null, internalNotes: body.internalNotes ?? null, createdById: sub,
      }).returning();
      await saveLines(tx, row, body);
      return row;
    });
    return estimateView((await db.select().from(estimates).where(eq(estimates.id, e.id)))[0], { office: true });
  });

  const find = async (companyId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Estimate not found");
    const [e] = await db.select().from(estimates).where(and(eq(estimates.id, id), eq(estimates.companyId, companyId)));
    if (!e) throw new HttpError(404, "Estimate not found");
    return e;
  };

  app.get<{ Params: { id: string } }>("/:id", async (req) => estimateView(await find(req.user.companyId, req.params.id), { office: true }));

  /** Changes it (not once it's been accepted or declined: copy it instead). A sent estimate's link shows the new version. */
  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(estimateSchema, req.body);
    const { companyId } = req.user;
    const e = await find(companyId, req.params.id);
    if (e.status === "accepted" || e.status === "declined") throw new HttpError(400, `It's ${e.status}; make a copy to change it`);
    await customerInCompany(db, companyId, body.customerId);
    await checkProperties(companyId, body);
    await db.transaction(async (tx) => {
      const [u] = await tx.update(estimates).set({
        customerId: body.customerId, propertyId: body.propertyId ?? null, title: body.title ?? null, issueDate: body.issueDate ?? e.issueDate, validUntil: body.validUntil ?? null,
        requestedAt: body.requestedAt ? new Date(body.requestedAt) : null, poNumber: body.poNumber ?? null, discountPercent: body.discountPercent,
        terms: body.terms ?? null, customerNotes: body.customerNotes ?? null, internalNotes: body.internalNotes ?? null, updatedAt: new Date(),
      }).where(eq(estimates.id, e.id)).returning();
      await saveLines(tx, u, body);
    });
    return estimateView(await find(companyId, e.id), { office: true });
  });

  /** Deletes it, unless it's become a work order or an invoice. */
  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const e = await find(req.user.companyId, req.params.id);
    if (e.visitId || e.invoiceId) throw new HttpError(400, "It's been made into a work order or invoice, so it's kept");
    await db.delete(estimates).where(eq(estimates.id, e.id));
    return { ok: true };
  });

  /** A new draft with the same lines and notes (e.g. to change an accepted one, or quote another customer). */
  app.post<{ Params: { id: string } }>("/:id/copy", async (req) => {
    const { companyId, sub } = req.user;
    const e = await find(companyId, req.params.id);
    const lines = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id)).orderBy(asc(estimateLines.sortOrder));
    const today = await companyToday(companyId);
    const made = await db.transaction(async (tx) => {
      const number = await nextEstimateNumber(tx, companyId);
      const [row] = await tx.insert(estimates).values({
        companyId, number, customerId: e.customerId, propertyId: e.propertyId, title: e.title, issueDate: today, poNumber: e.poNumber, discountPercent: e.discountPercent,
        terms: e.terms, customerNotes: e.customerNotes, internalNotes: e.internalNotes, createdById: sub, custom: e.custom,
      }).returning();
      if (lines.length) await tx.insert(estimateLines).values(lines.map(({ id: _id, estimateId: _e, ...l }) => ({ ...l, estimateId: row.id })));
      await updateTotals(tx, row.id, lines, e.discountPercent, null);
      return row;
    });
    return { id: made.id, number: made.number };
  });

  app.get<{ Params: { id: string } }>("/:id/pdf", async (req, reply) => {
    const e = await find(req.user.companyId, req.params.id);
    return sendPdf(reply, await pdfFor(e), `Estimate-${e.number}.pdf`);
  });

  /** Emails it (with the PDF and a link to accept online). Sending again resends the same link. */
  app.post<{ Params: { id: string } }>("/:id/send", async (req) => {
    const body = parse(sendEstimateSchema, req.body ?? {});
    const { companyId } = req.user;
    const e = await find(companyId, req.params.id);
    if (e.status === "accepted" || e.status === "declined") throw new HttpError(400, `It's already ${e.status}`);
    const [cust] = await db.select().from(customers).where(eq(customers.id, e.customerId));
    const to = body.emailTo ?? cust.email;
    if (!to) throw new HttpError(400, "This customer has no email address. Add one, or enter where to send it");
    const transport = emailTransport();
    if (!transport) throw new HttpError(400, "Email isn't set up on this server yet");
    const [u] = await db.update(estimates).set({ status: "sent", token: e.token ?? randomToken(24), sentAt: new Date(), emailedTo: to, updatedAt: new Date() })
      .where(eq(estimates.id, e.id)).returning();
    const [co] = await db.select().from(companies).where(eq(companies.id, companyId));
    const url = `${WEB_URL}/estimate/${u.token}`;
    const pdf = await pdfFor(u);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const name = customerName(cust);
    const what = u.title ? `${u.title} (estimate ${u.number})` : `estimate ${u.number}`;
    const until = u.validUntil ? ` It's good until ${new Date(`${u.validUntil}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}.` : "";
    const text = [`Hello ${name},`, "", ...(body.message ? [body.message, ""] : []), `Here's your ${what} from ${co.name}: ${formatMoney(u.totalCents)}.${until}`, "",
      `See it, choose any options, and accept it online: ${url}`, "", "The PDF is attached too. Questions? Just reply to this email" + (co.phone ? ` or call ${co.phone}.` : "."), "", `Thank you,`, co.name].join("\n");
    const html = `<p>Hello ${esc(name)},</p>${body.message ? `<p>${esc(body.message).replace(/\n/g, "<br>")}</p>` : ""}
<p>Here's your ${esc(what)} from ${esc(co.name)}: <strong>${formatMoney(u.totalCents)}</strong>.${esc(until)}</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#1f7a3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">View and accept the estimate</a></p>
<p>The PDF is attached too. Questions? Just reply to this email${co.phone ? ` or call ${esc(co.phone)}` : ""}.</p><p>Thank you,<br>${esc(co.name)}</p>`;
    await transport.send({ to, subject: `Estimate ${u.number} from ${co.name}`, text, html, fromName: co.name, replyTo: co.email ?? undefined,
      attachments: [{ filename: `Estimate-${u.number}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }] });
    return estimateView(u, { office: true });
  });

  /** The office records the customer's answer (taken by phone or in person). */
  app.post<{ Params: { id: string } }>("/:id/respond", async (req) => {
    const r = parse(estimateResponseSchema, req.body);
    const e = await find(req.user.companyId, req.params.id);
    if (e.visitId || e.invoiceId) throw new HttpError(400, "It's already been made into a work order or invoice");
    const u = await recordResponse(e, r, { employeeId: req.user.sub });
    return estimateView(await find(req.user.companyId, u.id), { office: true });
  });

  /** Undoes an answer recorded by mistake: back to pending (or draft if it was never sent). */
  app.post<{ Params: { id: string } }>("/:id/reopen", async (req) => {
    const e = await find(req.user.companyId, req.params.id);
    if (e.visitId || e.invoiceId) throw new HttpError(400, "It's already been made into a work order or invoice");
    const lines = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id));
    await db.update(estimates).set({ status: e.sentAt ? "sent" : "draft", respondedAt: null, responseName: null, responseComment: null, respondedBy: null, respondedById: null, chosenLineIds: null, updatedAt: new Date() })
      .where(eq(estimates.id, e.id));
    await updateTotals(db, e.id, lines, e.discountPercent, null);
    return estimateView(await find(req.user.companyId, e.id), { office: true });
  });

  /** An accepted estimate becomes a draft invoice (the lines the customer chose; multi-visit lines with the visits as the quantity). */
  app.post<{ Params: { id: string } }>("/:id/invoice", async (req) => {
    const { companyId, sub } = req.user;
    const e = await find(companyId, req.params.id);
    if (e.status !== "accepted") throw new HttpError(400, "Only an accepted estimate can be invoiced");
    if (e.invoiceId) throw new HttpError(400, "It's already been invoiced");
    const lines = (await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id)).orderBy(asc(estimateLines.sortOrder))).filter((l) => lineIncluded(l, chosenSet(e)));
    if (!lines.length) throw new HttpError(400, "No lines were accepted");
    const settings = await billingSettings(companyId);
    const today = await companyToday(companyId);
    const inv = await db.transaction(async (tx) => {
      const invLines = lines.map((l, i) => {
        const quantity = Math.round(l.quantity * l.visits * 100) / 100;
        return { serviceTypeId: l.serviceTypeId, description: l.description, quantity, unitPriceCents: l.unitPriceCents, incomeAccountCode: l.incomeAccountCode, taxRate: l.taxRate, amountCents: Math.round(quantity * l.unitPriceCents), sortOrder: i };
      });
      const t = estimateTotals(lines.map((l) => ({ ...l, optional: false })), e.discountPercent);
      const [row] = await tx.insert(invoices).values({
        companyId, customerId: e.customerId, propertyId: e.propertyId, issueDate: today, dueDate: addDays(today, (await db.select({ t: customers.termsDays }).from(customers).where(eq(customers.id, e.customerId)))[0]?.t ?? settings.termsDays), poNumber: e.poNumber,
        notes: e.customerNotes ? e.customerNotes.slice(0, 2000) : null, discountKind: e.discountPercent > 0 ? "percent" : "none", discountValue: e.discountPercent,
        subtotalCents: t.subtotalCents, discountCents: t.discountCents, taxCents: t.taxCents, totalCents: t.totalCents, createdById: sub,
      }).returning();
      await tx.insert(invoiceLines).values(invLines.map((l) => ({ ...l, invoiceId: row.id })));
      await tx.update(estimates).set({ invoiceId: row.id, updatedAt: new Date() }).where(eq(estimates.id, e.id));
      return row;
    });
    return { invoiceId: inv.id };
  });
};

/** The customer's link (/estimate/<token>): see it, choose options, accept, decline or ask for changes. No sign-in. */
export const publicEstimateRoutes: FastifyPluginAsync = async (app) => {
  const limited = { config: { rateLimit: { max: 60, timeWindow: "15 minutes" } } };
  const byToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "This link isn't right. Check the link in your email");
    const [e] = await db.select().from(estimates).where(eq(estimates.token, token));
    if (!e || e.status === "draft") throw new HttpError(404, "This link isn't right. Check the link in your email");
    return e;
  };
  const company = async (companyId: string) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    return { id: c.id, name: c.name, phone: c.phone, email: c.email, website: c.website, hasLogo: !!c.logoKey, isTest: !!c.testOfCompanyId };
  };
  const out = async (e: Estimate) => {
    const view = await estimateView(e, { office: false });
    const settings = await billingSettings(e.companyId);
    return { company: await company(e.companyId), taxName: settings.taxName, estimate: view, canRespond: (e.status === "sent" || e.status === "changes") && !view.expired };
  };

  app.get<{ Params: { token: string } }>("/:token", limited, async (req) => {
    const e = await byToken(req.params.token);
    if (!e.viewedAt) await db.update(estimates).set({ viewedAt: new Date() }).where(eq(estimates.id, e.id));
    return out(e);
  });

  app.get<{ Params: { token: string } }>("/:token/pdf", limited, async (req, reply) => {
    const e = await byToken(req.params.token);
    return sendPdf(reply, await pdfFor(e), `Estimate-${e.number}.pdf`);
  });

  app.post<{ Params: { token: string } }>("/:token/respond", limited, async (req) => {
    const r = parse(estimateResponseSchema, req.body);
    const e = await byToken(req.params.token);
    if (e.status === "accepted" || e.status === "declined") throw new HttpError(400, `This estimate was already ${e.status}. Questions? Call or email us`);
    if (e.validUntil && e.validUntil < (await companyToday(e.companyId))) throw new HttpError(400, "This estimate has expired. Call or email us for an updated one");
    if (r.action === "accept" && !r.name) throw new HttpError(400, "Type your name to accept");
    const u = await recordResponse(e, r, { customer: true });
    return out((await db.select().from(estimates).where(eq(estimates.id, u.id)))[0]);
  });
};

export default routes;

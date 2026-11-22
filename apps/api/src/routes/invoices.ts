import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { and, asc, desc, eq, ilike, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  billingSettingsSchema, customerName, formatAddress, formatMoney, invoiceSchema, invoiceTotals, isOverdue, lineAmount, paymentSchema,
  sendInvoiceSchema, termsLabel, voidSchema, type InvoiceInput,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerContacts, customers, invoiceLines, invoicePayments, invoices, properties, serviceTypes } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { customerInCompany, type Tx } from "../lib/crm";
import { addDays, billingSettings, refreshInvoice, takeInvoiceNumber } from "../lib/invoices";
import { batchPdf, billToLines, invoicePdf, type PdfCompany, type PdfInvoice } from "../lib/invoicePdf";
import { emailTransport } from "../lib/channels";
import { randomToken } from "../lib/crypto";
import { storage } from "../lib/storage";

const AREA = "customers" as const;

type ListQuery = { status?: string; q?: string; customerId?: string; limit?: string; offset?: string };

async function companyForPdf(companyId: string): Promise<PdfCompany> {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  let logo: Buffer | null = null;
  if (c.logoKey) { try { logo = await storage.get(c.logoKey); } catch { logo = null; } }
  return { name: c.name, legalName: c.legalName, addressLine1: c.addressLine1, addressLine2: c.addressLine2, city: c.city, state: c.state, zip: c.zip, phone: c.phone, email: c.email, website: c.website, logo };
}

/** Everything the PDF needs for one invoice. */
async function pdfInvoice(companyId: string, invoiceId: string, opts: { copy?: boolean } = {}): Promise<PdfInvoice & { zip: string }> {
  const [row] = await db.select({ inv: invoices, cust: customers, prop: properties }).from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId)).leftJoin(properties, eq(properties.id, invoices.propertyId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!row) throw new HttpError(404, "Invoice not found");
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.sortOrder));
  const settings = await billingSettings(companyId);
  const { inv, cust, prop } = row;
  const termsDays = Math.max(0, Math.round((Date.parse(inv.dueDate) - Date.parse(inv.issueDate)) / 86_400_000));
  return {
    number: inv.number, status: inv.status, issueDate: inv.issueDate, dueDate: inv.dueDate, poNumber: inv.poNumber, notes: inv.notes,
    subtotalCents: inv.subtotalCents, discountCents: inv.discountCents, totalCents: inv.totalCents, paidCents: inv.paidCents, termsDays,
    customerName: customerName(cust), customerNumber: cust.number, billTo: billToLines(cust, prop),
    serviceAddress: prop ? formatAddress(prop) : null,
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
    footer: settings.footer, payableTo: settings.payableTo, copy: opts.copy,
    zip: cust.billingStreet ? cust.billingZip ?? "" : prop?.zip ?? "",
  };
}

function sendPdf(reply: FastifyReply, bytes: Uint8Array, filename: string) {
  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `inline; filename="${filename}"`);
  reply.header("Cache-Control", "no-store");
  return reply.send(Buffer.from(bytes));
}

/** Checks the customer, property and price-list items belong to the company, and works out the lines and totals. */
async function prepare(tx: Tx, companyId: string, body: InvoiceInput) {
  const cust = await customerInCompany(tx, companyId, body.customerId);
  if (body.propertyId) {
    const [p] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, body.propertyId), eq(properties.companyId, companyId)));
    if (!p) throw new HttpError(400, "That property doesn't exist");
  }
  const serviceIds = [...new Set(body.lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
  if (serviceIds.length) {
    const found = await tx.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, serviceIds)));
    if (found.length !== serviceIds.length) throw new HttpError(400, "One of those services isn't on the price list");
  }
  const totals = invoiceTotals(body.lines, body.discountKind, body.discountValue);
  if (totals.totalCents < 0) throw new HttpError(400, "The invoice total can't be below zero");
  return { cust, totals };
}

const INVOICE_TEXT = (o: { company: string; number: number; customer: string; due: string; amount: string; dueDate: string; message?: string; phone?: string | null }) => ({
  subject: `Invoice ${o.number} from ${o.company}: ${o.amount} due ${o.dueDate}`,
  text: `Hello ${o.customer},\n\n${o.message ? `${o.message}\n\n` : ""}Your invoice ${o.number} from ${o.company} is attached.\nAmount due: ${o.amount}\nDue: ${o.due}\n\nTo pay by check, mail it with the bottom part of the invoice. Questions? Just reply to this email${o.phone ? ` or call ${o.phone}` : ""}.\n\nThank you,\n${o.company}`,
});

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/**
 * Invoices and the payments recorded against them. Managers in Customers & billing work with them.
 * Drafts get their number when first sent; sending emails a PDF and/or puts the invoice in the
 * print queue for mailing.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  const balance = sql<number>`(${invoices.totalCents} - ${invoices.paidCents})`;

  app.get<{ Querystring: ListQuery }>("/", async (req) => {
    const { companyId } = req.user;
    const today = await companyToday(companyId);
    const where: SQL[] = [eq(invoices.companyId, companyId)];
    const status = req.query.status ?? "open";
    if (status === "open") where.push(inArray(invoices.status, ["sent", "partial"]));
    else if (status === "overdue") where.push(inArray(invoices.status, ["sent", "partial"]), sql`${invoices.dueDate} < ${today}`);
    else if (status === "mail") where.push(eq(invoices.needsMailing, true), ne(invoices.status, "void"));
    else if (["draft", "paid", "void"].includes(status)) where.push(eq(invoices.status, status));
    if (req.query.customerId) where.push(eq(invoices.customerId, req.query.customerId));
    const q = (req.query.q ?? "").trim().slice(0, 100);
    if (q) {
      const like = `%${q}%`;
      const match: SQL[] = [ilike(customers.lastName, like), ilike(customers.firstName, like), ilike(customers.companyName, like), ilike(properties.street, like), ilike(invoices.poNumber, like),
        sql`(coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')) ilike ${like}`];
      if (/^\d+$/.test(q)) match.push(eq(invoices.number, Number(q)));
      where.push(or(...match)!);
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await db.select({
      id: invoices.id, number: invoices.number, status: invoices.status, issueDate: invoices.issueDate, dueDate: invoices.dueDate, totalCents: invoices.totalCents,
      paidCents: invoices.paidCents, needsMailing: invoices.needsMailing, emailedAt: invoices.emailedAt, mailedAt: invoices.mailedAt, poNumber: invoices.poNumber,
      customerId: customers.id, kind: customers.kind, firstName: customers.firstName, lastName: customers.lastName, companyName: customers.companyName,
      street: properties.street, zip: sql<string | null>`coalesce(${customers.billingZip}, ${properties.zip})`,
    }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId)).leftJoin(properties, eq(properties.id, invoices.propertyId))
      .where(and(...where))
      .orderBy(...(status === "mail" ? [sql`coalesce(${customers.billingZip}, ${properties.zip}) nulls last`, asc(invoices.number)] : [desc(invoices.issueDate), sql`${invoices.number} desc nulls first`]))
      .limit(limit).offset(offset);
    const [agg] = await db.select({ count: sql<number>`count(*)::int`, due: sql<number>`coalesce(sum(case when ${invoices.status} in ('sent','partial') then ${balance} else 0 end), 0)::int` })
      .from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId)).leftJoin(properties, eq(properties.id, invoices.propertyId)).where(and(...where));
    return {
      total: agg?.count ?? rows.length, dueCents: agg?.due ?? 0, today,
      rows: rows.map(({ kind, firstName, lastName, companyName, ...r }) => ({ ...r, customerName: customerName({ kind, firstName, lastName, companyName }), balanceCents: r.totalCents - r.paidCents, overdue: isOverdue(r, today) })),
    };
  });

  /** What a customer owes: outstanding, past due and paid this year (customer page). */
  app.get<{ Params: { customerId: string } }>("/customer-summary/:customerId", async (req) => {
    const { companyId } = req.user;
    await customerInCompany(db, companyId, req.params.customerId);
    const today = await companyToday(companyId);
    const [s] = await db.select({
      outstanding: sql<number>`coalesce(sum(case when ${invoices.status} in ('sent','partial') then ${balance} else 0 end), 0)::int`,
      pastDue: sql<number>`coalesce(sum(case when ${invoices.status} in ('sent','partial') and ${invoices.dueDate} < ${today} then ${balance} else 0 end), 0)::int`,
      drafts: sql<number>`count(*) filter (where ${invoices.status} = 'draft')::int`,
    }).from(invoices).where(and(eq(invoices.companyId, companyId), eq(invoices.customerId, req.params.customerId)));
    const [p] = await db.select({ paid: sql<number>`coalesce(sum(${invoicePayments.amountCents}), 0)::int` }).from(invoicePayments)
      .where(and(eq(invoicePayments.companyId, companyId), eq(invoicePayments.customerId, req.params.customerId), eq(invoicePayments.status, "completed"), sql`${invoicePayments.receivedOn} >= ${`${today.slice(0, 4)}-01-01`}`));
    return { outstandingCents: s.outstanding, pastDueCents: s.pastDue, draftCount: s.drafts, paidThisYearCents: p.paid };
  });

  app.get("/settings", async (req) => billingSettings(req.user.companyId));

  app.put("/settings", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(billingSettingsSchema, req.body);
    const [{ max }] = await db.select({ max: sql<number | null>`max(${invoices.number})` }).from(invoices).where(eq(invoices.companyId, req.user.companyId));
    if (max != null && body.nextInvoiceNumber <= max) throw new HttpError(400, `Invoice ${max} has already been used; the next number must be higher`);
    await db.update(companies).set({ billing: body }).where(eq(companies.id, req.user.companyId));
    return body;
  });

  /** A new draft. Its due date follows the company's terms unless given. */
  app.post("/", async (req) => {
    const body = parse(invoiceSchema, req.body);
    const { companyId, sub } = req.user;
    const today = await companyToday(companyId);
    const settings = await billingSettings(companyId);
    return db.transaction(async (tx) => {
      const { totals } = await prepare(tx, companyId, body);
      const issueDate = body.issueDate ?? today;
      const [inv] = await tx.insert(invoices).values({
        companyId, customerId: body.customerId, propertyId: body.propertyId ?? null, issueDate, dueDate: body.dueDate ?? addDays(issueDate, settings.termsDays),
        poNumber: body.poNumber ?? null, notes: body.notes ?? null, discountKind: body.discountKind, discountValue: body.discountValue, ...totals, createdById: sub,
      }).returning();
      await tx.insert(invoiceLines).values(body.lines.map((l, i) => ({ ...l, serviceTypeId: l.serviceTypeId ?? null, invoiceId: inv.id, amountCents: lineAmount(l), sortOrder: i })));
      return inv;
    });
  });

  /** Waiting to be printed and mailed, sorted by ZIP. */
  app.get("/print-queue", async (req) => {
    const rows = await db.select({ id: invoices.id }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId)).leftJoin(properties, eq(properties.id, invoices.propertyId))
      .where(and(eq(invoices.companyId, req.user.companyId), eq(invoices.needsMailing, true), ne(invoices.status, "void")))
      .orderBy(sql`coalesce(${customers.billingZip}, ${properties.zip}) nulls last`, asc(invoices.number));
    return rows.map((r) => r.id);
  });

  /** One PDF with several invoices (sorted by ZIP) and a cover sheet. Invoices already mailed print as "Copy". */
  app.get<{ Querystring: { ids?: string } }>("/print", async (req, reply) => {
    const ids = (req.query.ids ?? "").split(",").filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 500);
    if (!ids.length) throw new HttpError(400, "Choose the invoices to print");
    const rows = await db.select({ id: invoices.id, mailedAt: invoices.mailedAt }).from(invoices).where(and(eq(invoices.companyId, req.user.companyId), inArray(invoices.id, ids)));
    if (rows.length !== ids.length) throw new HttpError(404, "Invoice not found");
    const list = await Promise.all(rows.map((r) => pdfInvoice(req.user.companyId, r.id, { copy: !!r.mailedAt })));
    list.sort((a, b) => (a.zip || "99999").localeCompare(b.zip || "99999") || (a.number ?? 0) - (b.number ?? 0));
    return sendPdf(reply, await batchPdf(await companyForPdf(req.user.companyId), list), "invoices-to-mail.pdf");
  });

  /** After printing: these went in the mail today (or on the given date). */
  app.post("/mark-mailed", async (req) => {
    const { ids, mailedOn } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), mailedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body);
    const at = mailedOn ? new Date(`${mailedOn}T12:00:00Z`) : new Date();
    const done = await db.update(invoices).set({ needsMailing: false, mailedAt: at, updatedAt: new Date() })
      .where(and(eq(invoices.companyId, req.user.companyId), inArray(invoices.id, ids), isNotNull(invoices.number), ne(invoices.status, "void"))).returning({ id: invoices.id });
    return { marked: done.length };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req) => {
    const { companyId } = req.user;
    const [row] = await db.select({ inv: invoices, cust: customers, prop: properties }).from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId)).leftJoin(properties, eq(properties.id, invoices.propertyId))
      .where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, companyId)));
    if (!row) throw new HttpError(404, "Invoice not found");
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, row.inv.id)).orderBy(asc(invoiceLines.sortOrder));
    const payments = await db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, row.inv.id)).orderBy(desc(invoicePayments.receivedOn), desc(invoicePayments.createdAt));
    const copies = await db.select({ name: customerContacts.name, email: customerContacts.email }).from(customerContacts)
      .where(and(eq(customerContacts.customerId, row.cust.id), eq(customerContacts.getsInvoices, true), isNotNull(customerContacts.email)));
    const today = await companyToday(companyId);
    const { inv, cust, prop } = row;
    return {
      ...inv, balanceCents: inv.totalCents - inv.paidCents, overdue: isOverdue(inv, today), lines, payments,
      customer: { id: cust.id, number: cust.number, name: customerName(cust), email: cust.email, delivery: cust.delivery, poRequired: cust.poRequired, status: cust.status,
        billTo: billToLines(cust, prop), copies },
      property: prop ? { id: prop.id, street: prop.street, name: prop.name, address: formatAddress(prop), lawnSqFt: prop.lawnSqFt } : null,
    };
  });

  /** Drafts can always change; sent invoices only while nothing has been paid on them. */
  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(invoiceSchema, req.body);
    const { companyId } = req.user;
    return db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, companyId)));
      if (!inv) throw new HttpError(404, "Invoice not found");
      if (inv.status === "void") throw new HttpError(400, "A void invoice can't be changed");
      if (inv.paidCents > 0) throw new HttpError(400, "This invoice has payments, so it can't be changed. Void the payments first, or add a new invoice for the difference");
      if (body.customerId !== inv.customerId && inv.number != null) throw new HttpError(400, "A sent invoice can't move to another customer; void it and make a new one");
      const { totals } = await prepare(tx, companyId, body);
      const [u] = await tx.update(invoices).set({
        customerId: body.customerId, propertyId: body.propertyId ?? null, issueDate: body.issueDate ?? inv.issueDate, dueDate: body.dueDate ?? inv.dueDate,
        poNumber: body.poNumber ?? null, notes: body.notes ?? null, discountKind: body.discountKind, discountValue: body.discountValue, ...totals, updatedAt: new Date(),
      }).where(eq(invoices.id, inv.id)).returning();
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      await tx.insert(invoiceLines).values(body.lines.map((l, i) => ({ ...l, serviceTypeId: l.serviceTypeId ?? null, invoiceId: inv.id, amountCents: lineAmount(l), sortOrder: i })));
      return refreshInvoice(tx, u.id);
    });
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req) => {
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, req.user.companyId)));
    if (!inv) throw new HttpError(404, "Invoice not found");
    if (inv.status !== "draft") throw new HttpError(400, "Only drafts can be deleted; void a sent invoice instead");
    await db.delete(invoices).where(eq(invoices.id, inv.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/:id/pdf", async (req, reply) => {
    const data = await pdfInvoice(req.user.companyId, req.params.id);
    return sendPdf(reply, await invoicePdf(await companyForPdf(req.user.companyId), data), `invoice-${data.number ?? "draft"}.pdf`);
  });

  /**
   * Sends the invoice: by email (PDF attached, to the customer and any contacts marked "copy on
   * invoices") and/or onto the print queue for mailing. A draft gets its number now.
   */
  app.post<{ Params: { id: string } }>("/:id/send", async (req) => {
    const body = parse(sendInvoiceSchema, req.body);
    const { companyId } = req.user;
    const [first] = await db.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, companyId)));
    if (!first) throw new HttpError(404, "Invoice not found");
    if (first.status === "void") throw new HttpError(400, "A void invoice can't be sent");
    const cust = await customerInCompany(db, companyId, first.customerId);
    if (cust.poRequired && !first.poNumber) throw new HttpError(400, `${customerName(cust)} needs a PO number on every invoice. Add it, then send`);
    const wantsEmail = body.via.includes("email");
    const to = body.emailTo ?? cust.email;
    if (wantsEmail && !to) throw new HttpError(400, "This customer has no email address. Add one, or send it by paper");
    const transport = emailTransport();
    if (wantsEmail && !transport) throw new HttpError(400, "Email isn't set up on this server yet, so it can't be emailed. Send it by paper for now");

    // Number it (if it's a draft) before building the PDF, so the PDF shows the number.
    const inv = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(invoices).where(eq(invoices.id, first.id)).for("update");
      if (cur.number != null) return cur;
      const number = await takeInvoiceNumber(tx, companyId);
      const [u] = await tx.update(invoices).set({ number, status: "sent", payToken: randomToken(24), updatedAt: new Date() }).where(eq(invoices.id, cur.id)).returning();
      return u;
    });
    const fresh = await refreshInvoice(db, inv.id);

    if (wantsEmail && transport && to) {
      const company = await companyForPdf(companyId);
      const data = await pdfInvoice(companyId, inv.id);
      const pdf = await invoicePdf(company, data);
      const copies = (await db.select({ email: customerContacts.email }).from(customerContacts)
        .where(and(eq(customerContacts.customerId, cust.id), eq(customerContacts.getsInvoices, true), isNotNull(customerContacts.email))))
        .map((c) => c.email!).filter((e) => e !== to);
      const amount = formatMoney(data.totalCents - data.paidCents);
      const due = `${data.dueDate.slice(5, 7)}/${data.dueDate.slice(8, 10)}/${data.dueDate.slice(0, 4)}`;
      const t = INVOICE_TEXT({ company: company.name, number: inv.number!, customer: customerName(cust), due: `${due} (${termsLabel(data.termsDays)})`, amount, dueDate: due, message: body.message, phone: company.phone });
      const html = `<p>Hello ${esc(customerName(cust))},</p>${body.message ? `<p>${esc(body.message).replace(/\n/g, "<br>")}</p>` : ""}
<p>Your invoice <strong>${inv.number}</strong> from ${esc(company.name)} is attached.</p>
<table style="border-collapse:collapse"><tr><td style="padding:2px 12px 2px 0;color:#667085">Amount due</td><td style="font-size:18px;font-weight:700">${amount}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#667085">Due</td><td>${esc(t.text.match(/Due: (.*)/)?.[1] ?? due)}</td></tr></table>
<p>To pay by check, mail it with the bottom part of the invoice. Questions? Just reply to this email${company.phone ? ` or call ${esc(company.phone)}` : ""}.</p>
<p>Thank you,<br>${esc(company.name)}</p>`;
      await transport.send({
        to, cc: copies, subject: t.subject, text: t.text, html, fromName: company.name, replyTo: company.email ?? undefined,
        attachments: [{ filename: `Invoice-${inv.number}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }],
      });
      await db.update(invoices).set({ emailedAt: new Date(), emailedTo: [to, ...copies].join(", ") }).where(eq(invoices.id, inv.id));
    }
    if (body.via.includes("paper")) await db.update(invoices).set({ needsMailing: true }).where(eq(invoices.id, inv.id));
    const [out] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    return { ...out, status: fresh?.status ?? out.status };
  });

  /** Records a cash, check or other payment (card and bank payments come through the portal). */
  app.post<{ Params: { id: string } }>("/:id/payments", async (req) => {
    const body = parse(paymentSchema, req.body);
    const { companyId, sub } = req.user;
    const today = await companyToday(companyId);
    return db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, companyId))).for("update");
      if (!inv) throw new HttpError(404, "Invoice not found");
      if (inv.status === "draft") throw new HttpError(400, "Send the invoice before recording a payment on it");
      if (inv.status === "void") throw new HttpError(400, "That invoice is void");
      const due = inv.totalCents - inv.paidCents;
      if (body.amountCents > due) throw new HttpError(400, `That's more than the ${formatMoney(due)} still owed. Overpayments become credit in Phase 2`);
      const [p] = await tx.insert(invoicePayments).values({ ...body, receivedOn: body.receivedOn ?? today, companyId, invoiceId: inv.id, customerId: inv.customerId, recordedById: sub }).returning();
      const updated = await refreshInvoice(tx, inv.id);
      return { payment: p, invoice: updated };
    });
  });

  app.post<{ Params: { id: string; paymentId: string } }>("/:id/payments/:paymentId/void", async (req) => {
    const { companyId } = req.user;
    return db.transaction(async (tx) => {
      const [p] = await tx.select().from(invoicePayments).where(and(eq(invoicePayments.id, req.params.paymentId), eq(invoicePayments.invoiceId, req.params.id), eq(invoicePayments.companyId, companyId)));
      if (!p) throw new HttpError(404, "Payment not found");
      if (p.status === "void") throw new HttpError(400, "That payment is already void");
      if (p.method === "card" || p.method === "ach") throw new HttpError(400, "Card and bank payments are refunded, not voided");
      await tx.update(invoicePayments).set({ status: "void", voidedAt: new Date() }).where(eq(invoicePayments.id, p.id));
      return refreshInvoice(tx, req.params.id);
    });
  });

  /** Voids a sent invoice (reason kept). Payments must be voided or refunded first. */
  app.post<{ Params: { id: string } }>("/:id/void", async (req) => {
    const { reason } = parse(voidSchema, req.body);
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, req.user.companyId)));
    if (!inv) throw new HttpError(404, "Invoice not found");
    if (inv.status === "void") throw new HttpError(400, "It's already void");
    if (inv.status === "draft") throw new HttpError(400, "Drafts are deleted, not voided");
    if (inv.paidCents > 0) throw new HttpError(400, "Void or refund its payments first");
    const [u] = await db.update(invoices).set({ status: "void", voidedAt: new Date(), voidReason: reason, needsMailing: false, updatedAt: new Date() }).where(eq(invoices.id, inv.id)).returning();
    return u;
  });
};

export default routes;

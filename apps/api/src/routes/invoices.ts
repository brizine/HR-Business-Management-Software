import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  DEFAULT_BILLING_SETTINGS, autoSendSettingsSchema, billingSettingsSchema, customerName, effectiveLateFeeRules, lateFeeSettingsSchema, estimateDepositSettingsSchema, formatAddress, formatMoney, invoiceSchema, invoiceTotals, isOverdue, lineAmount, paymentSchema, taxBreakdown,
  invoiceBalance, sendInvoiceSchema, termsLabel, voidSchema, type InvoiceInput,
} from "@crewdesk/shared";
import { db } from "../db";
import { newRecordCustom, updatedCustom } from "../lib/customFields";
import { companies, creditApplications, customerContacts, customerCredits, customers, invoiceLateFees, invoiceLines, invoicePayments, invoices, paymentRefunds, prepayments, properties, serviceTypes } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { companyToday } from "../lib/payRates";
import { customerInCompany, type Tx } from "../lib/crm";
import { addDays, billingSettings, PAY_LINK_DAYS, payLinkFor, portalUrl, refreshInvoice, takeInvoiceNumber } from "../lib/invoices";
import { autopayInvoice, chargeInvoice } from "../lib/paymentMethods";
import { waiveLateFee } from "../lib/billingJobs";
import { REFUND_REASONS, refundPayment, stripeConfig } from "../lib/stripe";
import { batchPdf, billToLines, invoicePdf, type PdfCompany, type PdfInvoice } from "../lib/invoicePdf";
import { emailTransport } from "../lib/channels";
import { randomToken } from "../lib/crypto";
import { storage } from "../lib/storage";
import { queueBillingSync, syncCredit, syncInvoice, syncInvoiceAndPayments, syncPayment, syncStatus } from "../lib/billingSync";
import { applyCredit, autoApplyCredits, nextCreditNumber, removeInvoiceCredits } from "../lib/credits";
import { creditsFor } from "./credits";
import { prepaymentsFor } from "./prepayments";
import { applyPrepayments, returnToPrepayment } from "../lib/prepayments";

const AREA = "customers" as const;

type ListQuery = { status?: string; q?: string; customerId?: string; limit?: string; offset?: string };

export async function companyForPdf(companyId: string): Promise<PdfCompany> {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  let logo: Buffer | null = null;
  if (c.logoKey) { try { logo = await storage.get(c.logoKey); } catch { logo = null; } }
  return { name: c.name, legalName: c.legalName, addressLine1: c.addressLine1, addressLine2: c.addressLine2, city: c.city, state: c.state, zip: c.zip, phone: c.phone, email: c.email, website: c.website, logo };
}

/** Everything the PDF needs for one invoice. */
export async function pdfInvoice(companyId: string, invoiceId: string, opts: { copy?: boolean } = {}): Promise<PdfInvoice & { zip: string }> {
  const [row] = await db.select({ inv: invoices, cust: customers, prop: properties }).from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId)).leftJoin(properties, eq(properties.id, invoices.propertyId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!row) throw new HttpError(404, "Invoice not found");
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.sortOrder));
  const settings = await billingSettings(companyId);
  const credits = await db.select({ number: customerCredits.number, amountCents: creditApplications.amountCents }).from(creditApplications)
    .innerJoin(customerCredits, eq(customerCredits.id, creditApplications.creditId))
    .where(and(eq(creditApplications.invoiceId, invoiceId), isNull(creditApplications.removedAt))).orderBy(asc(creditApplications.createdAt));
  const { inv, cust, prop } = row;
  const termsDays = Math.max(0, Math.round((Date.parse(inv.dueDate) - Date.parse(inv.issueDate)) / 86_400_000));
  return {
    number: inv.number, status: inv.status, issueDate: inv.issueDate, dueDate: inv.dueDate, poNumber: inv.poNumber, notes: inv.notes,
    subtotalCents: inv.subtotalCents, discountCents: inv.discountCents, taxCents: inv.taxCents, taxName: settings.taxName, totalCents: inv.totalCents, paidCents: inv.paidCents, termsDays,
    creditedCents: inv.creditedCents, credits: credits.map((c) => ({ number: c.number, amountCents: c.amountCents })),
    customerName: customerName(cust), customerNumber: cust.number, billTo: billToLines(cust, prop),
    serviceAddress: prop ? formatAddress(prop) : null,
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents, taxRate: l.taxRate })),
    footer: settings.footer, payableTo: settings.payableTo, copy: opts.copy,
    payOnline: (await stripeConfig(companyId)) ? portalUrl(companyId).replace(/^https?:\/\//, "").replace(/\?.*$/, "") : null,
    zip: cust.billingStreet ? cust.billingZip ?? "" : prop?.zip ?? "",
  };
}

export function sendPdf(reply: FastifyReply, bytes: Uint8Array, filename: string) {
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

const INVOICE_TEXT = (o: { company: string; number: number; customer: string; due: string; amount: string; dueDate: string; message?: string; phone?: string | null; payUrl?: string | null }) => ({
  subject: `Invoice ${o.number} from ${o.company}: ${o.amount} due ${o.dueDate}`,
  text: `Hello ${o.customer},\n\n${o.message ? `${o.message}\n\n` : ""}Your invoice ${o.number} from ${o.company} is attached.\nAmount due: ${o.amount}\nDue: ${o.due}\n\n${o.payUrl ? `Pay online (card or bank account): ${o.payUrl}\n\nOr, to pay by check` : "To pay by check"}, mail it with the bottom part of the invoice. Questions? Just reply to this email${o.phone ? ` or call ${o.phone}` : ""}.\n\nThank you,\n${o.company}`,
});

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/**
 * Sends an invoice: numbers a draft (and gives it the late fee rules in force), uses any credit and
 * prepayment, emails the PDF with a pay link and/or puts it in the print queue, then autopay. Used
 * by "Send" and by the auto-send schedule (`by` is null then).
 */
export async function sendInvoice(companyId: string, invoiceId: string, body: { via: ("email" | "paper")[]; emailTo?: string; message?: string }, by: string | null, opts: { auto?: boolean } = {}) {
  const [first] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
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
    // It gets the late fee rules in force now (later changes to the rules don't touch it).
    const rules = effectiveLateFeeRules((await billingSettings(companyId, tx)).lateFees ?? DEFAULT_BILLING_SETTINGS.lateFees!, cust.lateFeeMode, cust.lateFeeRules);
    const [u] = await tx.update(invoices).set({ number, status: "sent", payToken: randomToken(24), lateFeeRules: rules.length ? rules : null, sentOn: await companyToday(companyId), updatedAt: new Date() }).where(eq(invoices.id, cur.id)).returning();
    return u;
  });
  // Credit on the customer's account goes on the invoice before it's built and sent (if that's turned on).
  let creditsUsed: string[] = [];
  if ((await billingSettings(companyId)).autoApplyCredits) {
    const made = await db.transaction((tx) => autoApplyCredits(tx, companyId, inv.customerId, { invoiceIds: [inv.id], by: by }));
    creditsUsed = [...new Set(made.map((a) => a.creditId))];
  }
  // Then anything the customer prepaid pays it (with its share of any prepay discount).
  const prepaid = await db.transaction((tx) => applyPrepayments(tx, companyId, inv.customerId, { invoiceIds: [inv.id], by: by }));
  creditsUsed.push(...prepaid.creditIds);
  // Each send restarts the pay link's 30 days.
  const [linked] = await db.update(invoices).set({ payToken: inv.payToken ?? randomToken(24), payTokenExpiresAt: new Date(Date.now() + PAY_LINK_DAYS * 86_400_000) })
    .where(eq(invoices.id, inv.id)).returning();
  const fresh = await refreshInvoice(db, inv.id);
  const payUrl = (await stripeConfig(companyId)) ? payLinkFor(linked)?.url ?? null : null;

  if (wantsEmail && transport && to) {
    const company = await companyForPdf(companyId);
    const data = await pdfInvoice(companyId, inv.id);
    const pdf = await invoicePdf(company, data);
    const copies = (await db.select({ email: customerContacts.email }).from(customerContacts)
      .where(and(eq(customerContacts.customerId, cust.id), eq(customerContacts.getsInvoices, true), isNotNull(customerContacts.email))))
      .map((c) => c.email!).filter((e) => e !== to);
    const amount = formatMoney(invoiceBalance(data));
    const due = `${data.dueDate.slice(5, 7)}/${data.dueDate.slice(8, 10)}/${data.dueDate.slice(0, 4)}`;
    const t = INVOICE_TEXT({ company: company.name, number: inv.number!, customer: customerName(cust), due: `${due} (${termsLabel(data.termsDays)})`, amount, dueDate: due, message: body.message, phone: company.phone, payUrl });
    const html = `<p>Hello ${esc(customerName(cust))},</p>${body.message ? `<p>${esc(body.message).replace(/\n/g, "<br>")}</p>` : ""}
<p>Your invoice <strong>${inv.number}</strong> from ${esc(company.name)} is attached.</p>
<table style="border-collapse:collapse"><tr><td style="padding:2px 12px 2px 0;color:#667085">Amount due</td><td style="font-size:18px;font-weight:700">${amount}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#667085">Due</td><td>${esc(t.text.match(/Due: (.*)/)?.[1] ?? due)}</td></tr></table>
${payUrl ? `<p><a href="${esc(payUrl)}" style="display:inline-block;background:#1f7a3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Pay online</a></p>
<p style="color:#667085;font-size:13px">Card or bank account. This button works for ${PAY_LINK_DAYS} days; after that, sign in at <a href="${esc(portalUrl(companyId))}">${esc(portalUrl(companyId).replace(/^https?:\/\//, "").replace(/\?.*$/, ""))}</a>.</p>` : ""}
<p>${payUrl ? "Or, to pay by check" : "To pay by check"}, mail it with the bottom part of the invoice. Questions? Just reply to this email${company.phone ? ` or call ${esc(company.phone)}` : ""}.</p>
<p>Thank you,<br>${esc(company.name)}</p>`;
    await transport.send({
      to, cc: copies, subject: t.subject, text: t.text, html, fromName: company.name, replyTo: company.email ?? undefined,
      attachments: [{ filename: `Invoice-${inv.number}.pdf`, content: Buffer.from(pdf), contentType: "application/pdf" }],
    });
    await db.update(invoices).set({ emailedAt: new Date(), emailedTo: [to, ...copies].join(", ") }).where(eq(invoices.id, inv.id));
  }
  if (body.via.includes("paper")) await db.update(invoices).set({ needsMailing: true }).where(eq(invoices.id, inv.id));
  queueBillingSync(() => syncInvoice(companyId, inv.id, by));
  for (const paymentId of prepaid.paymentIds) queueBillingSync(() => syncPayment(companyId, paymentId, by));
  for (const creditId of creditsUsed) queueBillingSync(() => syncCredit(companyId, creditId, by));
  // Autopay: charge the card or bank account on file (after the invoice went out).
  if (opts.auto) await db.update(invoices).set({ autoSentAt: new Date() }).where(eq(invoices.id, inv.id));
  const autopay = await autopayInvoice(companyId, inv.id);
  const [out] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
  const now = autopay?.ok ? await refreshInvoice(db, inv.id) : fresh;
  return { ...out, status: now?.status ?? out.status, autopay };
  }

/**
 * Invoices and the payments recorded against them. Managers in Customers & billing work with them.
 * Drafts get their number when first sent; sending emails a PDF and/or puts the invoice in the
 * print queue for mailing.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  const balance = sql<number>`(${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents})`;

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
      id: invoices.id, number: invoices.number, status: invoices.status, issueDate: invoices.issueDate, dueDate: invoices.dueDate, totalCents: invoices.totalCents, propertyId: invoices.propertyId,
      paidCents: invoices.paidCents, creditedCents: invoices.creditedCents, needsMailing: invoices.needsMailing, emailedAt: invoices.emailedAt, mailedAt: invoices.mailedAt, poNumber: invoices.poNumber,
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
      rows: rows.map(({ kind, firstName, lastName, companyName, ...r }) => ({ ...r, customerName: customerName({ kind, firstName, lastName, companyName }), balanceCents: invoiceBalance(r), overdue: isOverdue(r, today) })),
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
    const [p] = await db.select({ paid: sql<number>`coalesce(sum(${invoicePayments.amountCents} - ${invoicePayments.refundedCents}), 0)::int` }).from(invoicePayments)
      .where(and(eq(invoicePayments.companyId, companyId), eq(invoicePayments.customerId, req.params.customerId), eq(invoicePayments.status, "completed"), sql`${invoicePayments.receivedOn} >= ${`${today.slice(0, 4)}-01-01`}`));
    const credit = await creditsFor(companyId, req.params.customerId);
    const prepaid = await prepaymentsFor(companyId, req.params.customerId);
    return { outstandingCents: s.outstanding, pastDueCents: s.pastDue, draftCount: s.drafts, paidThisYearCents: p.paid, creditCents: credit.availableCents, prepaidCents: prepaid.prepaidCents };
  });

  app.get("/settings", async (req) => billingSettings(req.user.companyId));

  app.put("/settings", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(billingSettingsSchema, req.body);
    const [{ max }] = await db.select({ max: sql<number | null>`max(${invoices.number})` }).from(invoices).where(eq(invoices.companyId, req.user.companyId));
    if (max != null && body.nextInvoiceNumber <= max) throw new HttpError(400, `Invoice ${max} has already been used; the next number must be higher`);
    // Late fees and auto-sending are saved from their own cards; keep them.
    const current = await billingSettings(req.user.companyId);
    const next = { ...body, lateFees: body.lateFees ?? current.lateFees, autoSend: body.autoSend ?? current.autoSend, estimateDeposit: body.estimateDeposit ?? current.estimateDeposit };
    await db.update(companies).set({ billing: next }).where(eq(companies.id, req.user.companyId));
    return next;
  });

  /** The company's default late fee rules (customers use these unless set otherwise). */
  app.put("/settings/late-fees", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const lateFees = parse(lateFeeSettingsSchema, req.body);
    if (lateFees.enabled && !lateFees.rules.length) throw new HttpError(400, "Add at least one late fee step, or turn late fees off");
    const current = await billingSettings(req.user.companyId);
    await db.update(companies).set({ billing: { ...current, lateFees } }).where(eq(companies.id, req.user.companyId));
    return lateFees;
  });

  /** The company's default auto-send schedule. */
  app.put("/settings/auto-send", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const autoSend = parse(autoSendSettingsSchema, req.body);
    const current = await billingSettings(req.user.companyId);
    await db.update(companies).set({ billing: { ...current, autoSend } }).where(eq(companies.id, req.user.companyId));
    return autoSend;
  });

  /** Who needs a deposit to accept an estimate, from what total, and how much. */
  app.put("/settings/estimate-deposit", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const estimateDeposit = parse(estimateDepositSettingsSchema, req.body);
    const current = await billingSettings(req.user.companyId);
    await db.update(companies).set({ billing: { ...current, estimateDeposit } }).where(eq(companies.id, req.user.companyId));
    return estimateDeposit;
  });

  /** A new draft. Its due date follows the company's terms unless given. */
  app.post("/", async (req) => {
    const body = parse(invoiceSchema, req.body);
    const { companyId, sub } = req.user;
    const today = await companyToday(companyId);
    const settings = await billingSettings(companyId);
    const [payer] = await db.select({ custom: customers.custom, termsDays: customers.termsDays, invoiceNotes: customers.invoiceNotes }).from(customers).where(and(eq(customers.id, body.customerId), eq(customers.companyId, companyId)));
    const custom = await newRecordCustom(companyId, "invoice", (req.body as { custom?: unknown })?.custom, [{ target: "customer", values: payer?.custom }]);
    return db.transaction(async (tx) => {
      const { totals } = await prepare(tx, companyId, body);
      const issueDate = body.issueDate ?? today;
      const [inv] = await tx.insert(invoices).values({
        custom, companyId, customerId: body.customerId, propertyId: body.propertyId ?? null, issueDate, dueDate: body.dueDate ?? addDays(issueDate, payer?.termsDays ?? settings.termsDays),
        poNumber: body.poNumber ?? null, notes: body.notes ?? payer?.invoiceNotes ?? null, discountKind: body.discountKind, discountValue: body.discountValue, ...totals, createdById: sub,
      }).returning();
      await tx.insert(invoiceLines).values(body.lines.map((l, i) => ({ ...l, serviceTypeId: l.serviceTypeId ?? null, invoiceId: inv.id, amountCents: lineAmount(l), sortOrder: i })));
      return inv;
    });
  });

  /**
   * The sales tax report, for filing: invoices dated in the range (sent, not void), by month or
   * quarter: sales after discounts, the taxable and untaxed parts (and how much of that was to
   * tax-exempt customers), the tax by rate, and the tax charged.
   */
  app.get<{ Querystring: { from?: string; to?: string; by?: string } }>("/tax-report", async (req) => {
    const { companyId } = req.user;
    const today = await companyToday(companyId);
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const to = req.query.to && iso.test(req.query.to) ? req.query.to : today;
    const from = req.query.from && iso.test(req.query.from) ? req.query.from : `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new HttpError(400, "The start is after the end");
    const by = req.query.by === "quarter" ? "quarter" : "month";
    const rows = await db.select({ inv: invoices, exempt: customers.taxExempt }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(invoices.companyId, companyId), isNotNull(invoices.number), ne(invoices.status, "void"), sql`${invoices.issueDate} between ${from} and ${to}`))
      .orderBy(asc(invoices.issueDate));
    const lines = rows.length ? await db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, rows.map((r) => r.inv.id))) : [];
    type Bucket = { period: string; invoices: number; salesCents: number; taxableCents: number; untaxedCents: number; exemptCents: number; taxCents: number; rates: Map<number, { taxableCents: number; taxCents: number }> };
    const empty = (period: string): Bucket => ({ period, invoices: 0, salesCents: 0, taxableCents: 0, untaxedCents: 0, exemptCents: 0, taxCents: 0, rates: new Map() });
    const buckets = new Map<string, Bucket>();
    const total = empty("Total");
    const periodOf = (d: string) => (by === "quarter" ? `${d.slice(0, 4)} Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}` : d.slice(0, 7));
    for (const { inv, exempt } of rows) {
      const b = buckets.get(periodOf(inv.issueDate)) ?? empty(periodOf(inv.issueDate));
      buckets.set(b.period, b);
      const parts = taxBreakdown(lines.filter((l) => l.invoiceId === inv.id), inv.discountCents);
      for (const x of [b, total]) {
        x.invoices++;
        x.salesCents += inv.subtotalCents - inv.discountCents;
        x.untaxedCents += parts.untaxedCents;
        if (exempt) x.exemptCents += parts.untaxedCents;
        x.taxCents += inv.taxCents;
        for (const r of parts.rates) {
          x.taxableCents += r.taxableCents;
          const g = x.rates.get(r.rate) ?? { taxableCents: 0, taxCents: 0 };
          g.taxableCents += r.taxableCents; g.taxCents += r.taxCents;
          x.rates.set(r.rate, g);
        }
      }
    }
    const view = (b: Bucket) => ({ ...b, rates: [...b.rates.entries()].sort((a, c) => a[0] - c[0]).map(([rate, g]) => ({ rate, ...g })) });
    const settings = await billingSettings(companyId);
    return { from, to, by, taxEnabled: settings.taxEnabled, taxName: settings.taxName, periods: [...buckets.values()].map(view), total: view(total) };
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
    const paymentRows = await db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, row.inv.id)).orderBy(desc(invoicePayments.receivedOn), desc(invoicePayments.createdAt));
    const refunds = await db.select().from(paymentRefunds).where(eq(paymentRefunds.invoiceId, row.inv.id)).orderBy(asc(paymentRefunds.createdAt));
    const ppIds = [...new Set(paymentRows.map((p) => p.prepaymentId).filter((x): x is string => !!x))];
    const ppNumbers = new Map((ppIds.length ? await db.select({ id: prepayments.id, number: prepayments.number }).from(prepayments).where(inArray(prepayments.id, ppIds)) : []).map((x) => [x.id, x.number]));
    const payments = paymentRows.map((p) => ({ ...p, refunds: refunds.filter((r) => r.paymentId === p.id), prepaymentNumber: p.prepaymentId ? ppNumbers.get(p.prepaymentId) ?? null : null }));
    const copies = await db.select({ name: customerContacts.name, email: customerContacts.email }).from(customerContacts)
      .where(and(eq(customerContacts.customerId, row.cust.id), eq(customerContacts.getsInvoices, true), isNotNull(customerContacts.email)));
    const today = await companyToday(companyId);
    const { inv, cust, prop } = row;
    const sync = await syncStatus(companyId, inv.id, payments.map((p) => p.id));
    const appliedCredits = await db.select({ id: creditApplications.id, creditId: creditApplications.creditId, amountCents: creditApplications.amountCents, appliedOn: creditApplications.appliedOn, number: customerCredits.number, description: customerCredits.description, reason: customerCredits.reason })
      .from(creditApplications).innerJoin(customerCredits, eq(customerCredits.id, creditApplications.creditId))
      .where(and(eq(creditApplications.invoiceId, inv.id), isNull(creditApplications.removedAt))).orderBy(asc(creditApplications.createdAt));
    const openCredits = (await creditsFor(companyId, cust.id)).credits.filter((c) => c.leftCents > 0 && !c.prepaymentId);
    const lateFees = await db.select().from(invoiceLateFees).where(eq(invoiceLateFees.invoiceId, inv.id)).orderBy(asc(invoiceLateFees.days));
    return {
      ...inv, payToken: undefined, lateFees, balanceCents: invoiceBalance(inv), overdue: isOverdue(inv, today), lines, payments, sync, credits: appliedCredits,
      availableCreditCents: inv.status === "sent" || inv.status === "partial" ? openCredits.filter((c) => !c.propertyId || c.propertyId === inv.propertyId).reduce((sum, c) => sum + c.leftCents, 0) : 0,
      openCredits: inv.status === "sent" || inv.status === "partial" ? openCredits.filter((c) => !c.propertyId || c.propertyId === inv.propertyId).map((c) => ({ id: c.id, number: c.number, description: c.description, leftCents: c.leftCents })) : [],
      payLink: payLinkFor(inv), onlinePayments: !!(await stripeConfig(companyId)),
      customer: { id: cust.id, number: cust.number, name: customerName(cust), email: cust.email, delivery: cust.delivery, poRequired: cust.poRequired, status: cust.status,
        billTo: billToLines(cust, prop), copies },
      property: prop ? { id: prop.id, street: prop.street, name: prop.name, address: formatAddress(prop), lawnSqFt: prop.lawnSqFt } : null,
    };
  });

  /** Drafts can always change; sent invoices only while nothing has been paid on them. */
  app.put<{ Params: { id: string } }>("/:id", async (req) => {
    const body = parse(invoiceSchema, req.body);
    const { companyId } = req.user;
    const updated = await db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, companyId)));
      if (!inv) throw new HttpError(404, "Invoice not found");
      if (inv.status === "void") throw new HttpError(400, "A void invoice can't be changed");
      if (inv.paidCents > 0) throw new HttpError(400, "This invoice has payments, so it can't be changed. Void the payments first, or add a new invoice for the difference");
      if (inv.creditedCents > 0) throw new HttpError(400, "This invoice has credit on it. Take the credit off first (it goes back on the customer's account), then edit it");
      if (body.customerId !== inv.customerId && inv.number != null) throw new HttpError(400, "A sent invoice can't move to another customer; void it and make a new one");
      // Late fee lines stay as they are (only the late fee job adds them and "Waive" takes them off).
      const lateLines = await tx.select().from(invoiceLines).where(and(eq(invoiceLines.invoiceId, inv.id), eq(invoiceLines.isLateFee, true))).orderBy(invoiceLines.sortOrder);
      const lines = body.lines.filter((l) => !l.isLateFee);
      if (!lines.length) throw new HttpError(400, "Add at least one line");
      const { totals } = await prepare(tx, companyId, { ...body, lines: [...lines, ...lateLines.map((l) => ({ ...l, isLateFee: true }))] });
      const custom = await updatedCustom(companyId, "invoice", (req.body as { custom?: unknown })?.custom, inv.custom);
      const [u] = await tx.update(invoices).set({
        ...(custom ? { custom } : {}), customerId: body.customerId, propertyId: body.propertyId ?? null, issueDate: body.issueDate ?? inv.issueDate, dueDate: body.dueDate ?? inv.dueDate,
        poNumber: body.poNumber ?? null, notes: body.notes ?? null, discountKind: body.discountKind, discountValue: body.discountValue, ...totals, updatedAt: new Date(),
      }).where(eq(invoices.id, inv.id)).returning();
      await tx.delete(invoiceLines).where(and(eq(invoiceLines.invoiceId, inv.id), eq(invoiceLines.isLateFee, false)));
      await tx.insert(invoiceLines).values(lines.map((l, i) => ({ ...l, serviceTypeId: l.serviceTypeId ?? null, invoiceId: inv.id, amountCents: lineAmount(l), sortOrder: i })));
      for (const [j, l] of lateLines.entries()) await tx.update(invoiceLines).set({ sortOrder: lines.length + j }).where(eq(invoiceLines.id, l.id));
      return refreshInvoice(tx, u.id);
    });
    // A sent invoice that changed: update the Bigcapital copy.
    if (updated?.number != null) queueBillingSync(() => syncInvoice(companyId, updated.id, req.user.sub));
    return updated;
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
    return sendInvoice(req.user.companyId, req.params.id, body, req.user.sub);
  });

  /** Takes a late fee off the invoice (it won't be added again). */
  app.post<{ Params: { id: string; feeId: string } }>("/:id/late-fees/:feeId/waive", async (req) => {
    const fee = await waiveLateFee(req.user.companyId, req.params.id, req.params.feeId, req.user.sub);
    if (!fee) throw new HttpError(404, "Late fee not found");
    return { ok: true };
  });

  /** Charges what's owed to a card or bank account on file (the default one unless another is picked). */
  app.post<{ Params: { id: string } }>("/:id/charge", async (req) => {
    const body = parse(z.object({ methodId: z.string().uuid().optional() }), req.body ?? {});
    const result = await chargeInvoice(req.user.companyId, req.params.id, { methodId: body.methodId });
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, req.params.id));
    return { ...result, invoice: inv };
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
      const due = invoiceBalance(inv);
      if (body.amountCents > due) throw new HttpError(400, `That's more than the ${formatMoney(due)} still owed. Overpayments become credit in Phase 2`);
      const [p] = await tx.insert(invoicePayments).values({ ...body, receivedOn: body.receivedOn ?? today, companyId, invoiceId: inv.id, customerId: inv.customerId, recordedById: sub }).returning();
      const updated = await refreshInvoice(tx, inv.id);
      return { payment: p, invoice: updated };
    }).then((r) => { queueBillingSync(() => syncPayment(companyId, r.payment.id, sub)); return r; });
  });

  app.post<{ Params: { id: string; paymentId: string } }>("/:id/payments/:paymentId/void", async (req) => {
    const { companyId } = req.user;
    return db.transaction(async (tx) => {
      const [p] = await tx.select().from(invoicePayments).where(and(eq(invoicePayments.id, req.params.paymentId), eq(invoicePayments.invoiceId, req.params.id), eq(invoicePayments.companyId, companyId)));
      if (!p) throw new HttpError(404, "Payment not found");
      if (p.status === "void") throw new HttpError(400, "That payment is already void");
      if (p.method === "card" || p.method === "ach") throw new HttpError(400, "Card and bank payments are refunded, not voided");
      await tx.update(invoicePayments).set({ status: "void", voidedAt: new Date() }).where(eq(invoicePayments.id, p.id));
      // Paid from a prepayment: the money (and its discount on this invoice) goes back to the prepayment.
      const credits = p.method === "prepaid" ? await returnToPrepayment(tx, companyId, p) : [];
      return { invoice: await refreshInvoice(tx, req.params.id), paymentId: p.id, credits };
    }).then((r) => {
      queueBillingSync(() => syncPayment(companyId, r.paymentId, req.user.sub));
      for (const id of r.credits) queueBillingSync(() => syncCredit(companyId, id, req.user.sub));
      return r.invoice;
    });
  });

  /** Refunds a card or bank payment (all or part) through Stripe. Admins only: it sends money back. */
  app.post<{ Params: { id: string; paymentId: string } }>("/:id/payments/:paymentId/refund", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const body = parse(z.object({
      amountCents: z.number().int().positive().optional(),
      reason: z.enum(REFUND_REASONS).default("requested_by_customer"),
      note: z.string().trim().max(450).optional().nullable(),
      /** Don't let the invoice owe it again: add a credit for the refund and use it on this invoice. */
      writeOff: z.boolean().optional(),
    }), req.body);
    const [p] = await db.select({ id: invoicePayments.id }).from(invoicePayments)
      .where(and(eq(invoicePayments.id, req.params.paymentId), eq(invoicePayments.invoiceId, req.params.id), eq(invoicePayments.companyId, req.user.companyId)));
    if (!p) throw new HttpError(404, "Payment not found");
    const { writeOff, ...refund } = body;
    const result = await refundPayment(req.user.companyId, p.id, { ...refund, note: refund.note || null, by: req.user.sub });
    if (writeOff && result.status !== "failed" && result.status !== "canceled") {
      const { companyId, sub } = req.user;
      const [inv0] = await db.select().from(invoices).where(eq(invoices.id, req.params.id));
      const [row] = await db.select({ id: paymentRefunds.id }).from(paymentRefunds).where(eq(paymentRefunds.stripeRefundId, result.refundId));
      const credit = await db.transaction(async (tx) => {
        const [c] = await tx.insert(customerCredits).values({
          companyId, number: await nextCreditNumber(tx, companyId), customerId: inv0.customerId, propertyId: inv0.propertyId, amountCents: result.amountCents,
          reason: "refund_writeoff", description: `Refund of ${formatMoney(result.amountCents)} on invoice ${inv0.number}`, note: refund.note || null,
          issuedOn: await companyToday(companyId), refundId: row?.id ?? null, createdById: sub,
        }).returning();
        await applyCredit(tx, companyId, c.id, inv0.id, undefined, sub);
        return c;
      });
      queueBillingSync(() => syncCredit(companyId, credit.id, sub));
    }
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, req.params.id));
    return { ...result, invoice: { status: inv.status, paidCents: inv.paidCents, creditedCents: inv.creditedCents, balanceCents: invoiceBalance(inv) } };
  });

  /** Voids a sent invoice (reason kept). Payments must be voided or refunded first. */
  app.post<{ Params: { id: string } }>("/:id/void", async (req) => {
    const { reason } = parse(voidSchema, req.body);
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, req.user.companyId)));
    if (!inv) throw new HttpError(404, "Invoice not found");
    if (inv.status === "void") throw new HttpError(400, "It's already void");
    if (inv.status === "draft") throw new HttpError(400, "Drafts are deleted, not voided");
    if (inv.paidCents > 0) throw new HttpError(400, "Void or refund its payments first");
    // Any credit on it goes back on the customer's account (and comes off in Bigcapital before the invoice goes).
    const { u, credits } = await db.transaction(async (tx) => {
      const credits = await removeInvoiceCredits(tx, inv.id);
      const [u] = await tx.update(invoices).set({ status: "void", voidedAt: new Date(), voidReason: reason, needsMailing: false, updatedAt: new Date() }).where(eq(invoices.id, inv.id)).returning();
      return { u, credits };
    });
    for (const creditId of credits) queueBillingSync(() => syncCredit(req.user.companyId, creditId, req.user.sub));
    queueBillingSync(() => syncInvoice(req.user.companyId, inv.id, req.user.sub));
    return u;
  });

  /** "Send to Bigcapital" now: the invoice and its payments (also retries anything that failed). */
  app.post<{ Params: { id: string } }>("/:id/sync", async (req) => {
    const { companyId, sub } = req.user;
    const [inv] = await db.select({ id: invoices.id, number: invoices.number }).from(invoices).where(and(eq(invoices.id, req.params.id), eq(invoices.companyId, companyId)));
    if (!inv) throw new HttpError(404, "Invoice not found");
    if (inv.number == null) throw new HttpError(400, "Send the invoice first; drafts stay out of the books");
    const status = await syncInvoiceAndPayments(companyId, inv.id, sub);
    if (status === "not_connected") throw new HttpError(400, "Bigcapital isn't connected (Settings → Integrations)");
    const pays = await db.select({ id: invoicePayments.id }).from(invoicePayments).where(eq(invoicePayments.invoiceId, inv.id));
    return syncStatus(companyId, inv.id, pays.map((p) => p.id));
  });
};

export default routes;

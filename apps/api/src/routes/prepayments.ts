import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { customerName, formatAddress, formatMoney, prepaymentSchema, prepayTotals, splitIncome } from "@crewdesk/shared";
import { db } from "../db";
import { accountingPostings, companies, customers, employees, invoicePayments, invoices, prepayments, properties, propertyAssignments, serviceTypes } from "../db/schema";
import { authenticate, requireRole } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { customerInCompany } from "../lib/crm";
import { companyToday } from "../lib/payRates";
import { WEB_URL, emailTransport } from "../lib/channels";
import { randomToken } from "../lib/crypto";
import { applyPrepayments, cashLeft, discountLeft, nextPrepaymentNumber, reverseDiscount } from "../lib/prepayments";
import { recordPaymentIntent, refundPrepaymentRest, startPrepaymentPayment, stripeConfig } from "../lib/stripe";
import { queueBillingSync, syncCredit, syncPayment, syncPrepayment } from "../lib/billingSync";

const AREA = "customers" as const;
export const PREPAY_LINK_DAYS = 30;
const limited = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT ?? 20), timeWindow: "15 minutes" } } };
const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

type Row = typeof prepayments.$inferSelect;
const payLink = (p: Row) => (p.payToken && p.status === "requested" && p.payTokenExpiresAt && p.payTokenExpiresAt > new Date() ? `${WEB_URL}/prepay/${p.payToken}` : null);

/** A customer's prepayments, with what each has paid and what's left. */
export async function prepaymentsFor(companyId: string, customerId: string) {
  const rows = await db.select({ p: prepayments, street: properties.street, city: properties.city, state: properties.state, zip: properties.zip, by: employees.firstName, byLast: employees.lastName })
    .from(prepayments).leftJoin(properties, eq(properties.id, prepayments.propertyId)).leftJoin(employees, eq(employees.id, prepayments.createdById))
    .where(and(eq(prepayments.companyId, companyId), eq(prepayments.customerId, customerId))).orderBy(desc(prepayments.createdAt));
  const ids = rows.map((r) => r.p.id);
  const uses = ids.length ? await db.select({ id: invoicePayments.id, prepaymentId: invoicePayments.prepaymentId, invoiceId: invoicePayments.invoiceId, number: invoices.number, amountCents: invoicePayments.amountCents, receivedOn: invoicePayments.receivedOn })
    .from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
    .where(and(inArray(invoicePayments.prepaymentId, ids), eq(invoicePayments.status, "completed"))).orderBy(asc(invoicePayments.createdAt)) : [];
  const posts = ids.length ? await db.select().from(accountingPostings).where(and(eq(accountingPostings.companyId, companyId), eq(accountingPostings.kind, "prepayment"), inArray(accountingPostings.sourceId, ids))) : [];
  const list = rows.map(({ p, street, city, state, zip, by, byLast }) => ({
    ...p, payToken: undefined, cashLeftCents: cashLeft(p), discountLeftCents: discountLeft(p), payLink: payLink(p),
    property: p.propertyId ? { id: p.propertyId, address: formatAddress({ street, city, state, zip }) } : null,
    createdBy: by ? `${by} ${byLast ?? ""}`.trim() : null,
    uses: uses.filter((u) => u.prepaymentId === p.id).map(({ prepaymentId: _, ...u }) => u),
    books: (() => { const x = posts.find((b) => b.sourceId === p.id); return x ? { status: x.status, error: x.error } : null; })(),
  }));
  return { prepayments: list, prepaidCents: list.reduce((s, p) => s + p.cashLeftCents, 0) };
}

async function sendPrepayLink(companyId: string, p: Row, to: string) {
  const transport = emailTransport();
  if (!transport) throw new HttpError(400, "Email isn't set up on this server yet. Copy the link and send it yourself");
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId));
  const [cust] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  const url = payLink(p)!;
  const saved = p.discountCents ? ` (you save ${formatMoney(p.discountCents)})` : "";
  const text = `Hello ${customerName(cust)},\n\nYou can prepay ${p.description}: ${formatMoney(p.amountCents)}${saved}.\n\nPay by card or bank account here: ${url}\n\nThe link works for ${PREPAY_LINK_DAYS} days. Questions? Just reply to this email${co.phone ? ` or call ${co.phone}` : ""}.\n\nThank you,\n${co.name}`;
  const html = `<p>Hello ${esc(customerName(cust))},</p><p>You can prepay <strong>${esc(p.description)}</strong>: <strong>${formatMoney(p.amountCents)}</strong>${esc(saved)}.</p>`
    + `<p><a href="${esc(url)}" style="display:inline-block;background:#1f7a3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Prepay ${formatMoney(p.amountCents)}</a></p>`
    + `<p style="color:#667085;font-size:13px">Card or bank account. This link works for ${PREPAY_LINK_DAYS} days.</p><p>Thank you,<br>${esc(co.name)}</p>`;
  await transport.send({ to, subject: `Prepay ${p.description}: ${formatMoney(p.amountCents)} from ${co.name}`, text, html, fromName: co.name, replyTo: co.email ?? undefined });
}

/** Prepayments (staff): take one, send a pay link, take back its discount, refund the rest, void. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireRole("manager", AREA));

  app.get<{ Querystring: { customerId?: string } }>("/", async (req) => {
    if (!req.query.customerId) throw new HttpError(400, "Choose a customer");
    await customerInCompany(db, req.user.companyId, req.query.customerId);
    return prepaymentsFor(req.user.companyId, req.query.customerId);
  });

  /** Takes a prepayment (cash, check, other: received now) or sends a pay link (card or bank account). */
  app.post("/", async (req) => {
    const body = parse(prepaymentSchema, req.body);
    const { companyId, sub } = req.user;
    const cust = await customerInCompany(db, companyId, body.customerId);
    if (body.propertyId) {
      const [link] = await db.select({ id: propertyAssignments.id }).from(propertyAssignments)
        .where(and(eq(propertyAssignments.propertyId, body.propertyId), eq(propertyAssignments.customerId, body.customerId), eq(propertyAssignments.companyId, companyId)));
      if (!link) throw new HttpError(400, "That property isn't one of this customer's");
    }
    const t = prepayTotals(body.coversCents, body.discountKind, body.discountValue);
    // Where it counts as income when received: each price-list service's own account, otherwise the one chosen.
    const serviceIds = [...new Set(body.lines.map((l) => l.serviceTypeId).filter((x): x is string => !!x))];
    const accountOf = new Map((serviceIds.length ? await db.select({ id: serviceTypes.id, code: serviceTypes.incomeAccountCode }).from(serviceTypes)
      .where(and(eq(serviceTypes.companyId, companyId), inArray(serviceTypes.id, serviceIds))) : []).map((x) => [x.id, x.code]));
    const income = splitIncome(t.amountCents, body.lines.length
      ? body.lines.map((l) => [(l.serviceTypeId && accountOf.get(l.serviceTypeId)) || body.incomeAccountCode, Math.round(l.quantity * l.unitPriceCents)] as [string, number])
      : [[body.incomeAccountCode, t.coversCents]]);
    const online = body.how === "link";
    if (online && !(await stripeConfig(companyId))) throw new HttpError(400, "Online payments aren't set up (Settings → Integrations → Stripe). Record a check or cash prepayment instead");
    const to = body.emailTo ?? cust.email;
    const { p, made } = await db.transaction(async (tx) => {
      const [p] = await tx.insert(prepayments).values({
        companyId, number: await nextPrepaymentNumber(tx, companyId), customerId: body.customerId, propertyId: body.propertyId ?? null, description: body.description, lines: body.lines,
        coversCents: t.coversCents, discountCents: t.discountCents, amountCents: t.amountCents, income, note: body.note ?? null, useNow: body.useNow, createdById: sub,
        ...(online
          ? { status: "requested", payToken: randomToken(24), payTokenExpiresAt: new Date(Date.now() + PREPAY_LINK_DAYS * 86_400_000) }
          : { status: "open", method: body.how, reference: body.reference ?? null, receivedOn: await companyToday(companyId) }),
      }).returning();
      const made = !online && body.useNow ? await applyPrepayments(tx, companyId, body.customerId, { prepaymentIds: [p.id], by: sub }) : { paymentIds: [], creditIds: [] };
      return { p, made };
    });
    if (!online) queueBillingSync(() => syncPrepayment(companyId, p.id, sub));
    for (const id of made.paymentIds) queueBillingSync(() => syncPayment(companyId, id, sub));
    for (const id of made.creditIds) queueBillingSync(() => syncCredit(companyId, id, sub));
    let emailed: string | null = null;
    if (online && to) { try { await sendPrepayLink(companyId, p, to); emailed = to; } catch { /* the link can be copied */ } }
    const out = (await prepaymentsFor(companyId, body.customerId)).prepayments.find((x) => x.id === p.id);
    return { ...out, emailedTo: emailed };
  });

  /** Sends (or re-sends) the pay link; its 30 days start again. */
  app.post<{ Params: { id: string } }>("/:id/send-link", async (req) => {
    const { emailTo } = parse(z.object({ emailTo: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal("").transform(() => undefined)) }), req.body ?? {});
    const [p0] = await db.select().from(prepayments).where(and(eq(prepayments.id, req.params.id), eq(prepayments.companyId, req.user.companyId)));
    if (!p0) throw new HttpError(404, "Prepayment not found");
    if (p0.status !== "requested") throw new HttpError(400, "This prepayment is already paid (or void)");
    const [p] = await db.update(prepayments).set({ payToken: p0.payToken ?? randomToken(24), payTokenExpiresAt: new Date(Date.now() + PREPAY_LINK_DAYS * 86_400_000) }).where(eq(prepayments.id, p0.id)).returning();
    const [cust] = await db.select({ email: customers.email }).from(customers).where(eq(customers.id, p.customerId));
    const to = emailTo ?? cust.email;
    if (!to) throw new HttpError(400, "This customer has no email address. Copy the link and send it yourself");
    await sendPrepayLink(req.user.companyId, p, to);
    return { ok: true, emailedTo: to, payLink: payLink(p) };
  });

  /** The customer cancelled: take back the discount given with it (admins). */
  app.post<{ Params: { id: string } }>("/:id/reverse-discount", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const { companyId, sub } = req.user;
    const r = await db.transaction((tx) => reverseDiscount(tx, companyId, req.params.id, sub));
    for (const id of r.voidedCredits) queueBillingSync(() => syncCredit(companyId, id, sub));
    for (const id of r.paymentIds) queueBillingSync(() => syncPayment(companyId, id, sub));
    return r;
  });

  /** Refunds what's left and closes it (admins): to the card or bank, or recorded as paid back by check or cash. */
  app.post<{ Params: { id: string } }>("/:id/refund", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const { reference } = parse(z.object({ reference: z.string().trim().max(80).optional().nullable() }), req.body ?? {});
    return refundPrepaymentRest(req.user.companyId, req.params.id, { reference: reference || null });
  });

  /** Voids a pay link nobody used, or a cash/check prepayment entered by mistake (nothing used from it). */
  app.post<{ Params: { id: string } }>("/:id/void", { preHandler: requireRole("admin", AREA) }, async (req) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(1, "Give a reason").max(300) }), req.body);
    const [p] = await db.select().from(prepayments).where(and(eq(prepayments.id, req.params.id), eq(prepayments.companyId, req.user.companyId)));
    if (!p) throw new HttpError(404, "Prepayment not found");
    if (p.status === "void") throw new HttpError(400, "It's already void");
    if (p.status === "pending") throw new HttpError(400, "A bank payment for it is on its way; wait for it to clear, then refund it");
    if (p.appliedCents > 0 || p.appliedDiscountCents > 0) throw new HttpError(400, "It has paid invoices. Void those payments first, or refund what's left");
    if ((p.method === "card" || p.method === "ach") && p.status !== "requested") throw new HttpError(400, "It was paid online; refund it instead");
    const [u] = await db.update(prepayments).set({ status: "void", voidedAt: new Date(), voidReason: reason, payTokenExpiresAt: new Date() }).where(eq(prepayments.id, p.id)).returning();
    queueBillingSync(() => syncPrepayment(req.user.companyId, p.id, req.user.sub));
    return u;
  });

  app.post<{ Params: { id: string } }>("/:id/sync", async (req) => {
    const [p] = await db.select({ id: prepayments.id }).from(prepayments).where(and(eq(prepayments.id, req.params.id), eq(prepayments.companyId, req.user.companyId)));
    if (!p) throw new HttpError(404, "Prepayment not found");
    const r = await syncPrepayment(req.user.companyId, p.id, req.user.sub);
    if (r === "not_connected") throw new HttpError(400, "Bigcapital isn't connected (Settings → Integrations)");
    return { result: r };
  });
};

/** What a prepayment page (pay link or portal) shows. */
export async function prepaymentView(p: Row) {
  const [cust] = await db.select().from(customers).where(eq(customers.id, p.customerId));
  const [prop] = p.propertyId ? await db.select().from(properties).where(eq(properties.id, p.propertyId)) : [];
  return {
    id: p.id, number: p.number, description: p.description, lines: p.lines, coversCents: p.coversCents, discountCents: p.discountCents, amountCents: p.amountCents,
    status: p.status, receivedOn: p.receivedOn, methodDetail: p.methodDetail, cashLeftCents: cashLeft(p),
    customer: { id: cust.id, number: cust.number, name: customerName(cust) }, serviceAddress: prop ? formatAddress(prop) : null,
  };
}

/** The prepay link: /prepay/<token>, no sign-in, for 30 days. */
export const prepayLinkRoutes: FastifyPluginAsync = async (app) => {
  async function byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "This link isn't right. Check the link in your email");
    const [p] = await db.select().from(prepayments).where(eq(prepayments.payToken, token));
    if (!p) throw new HttpError(404, "This link isn't right. Check the link in your email");
    if (p.status === "void") throw new HttpError(410, "This prepayment offer was cancelled. Please call the office with any questions");
    if (p.status === "requested" && (!p.payTokenExpiresAt || p.payTokenExpiresAt < new Date())) throw new HttpError(410, "This prepay link has expired. Please call the office for a new one");
    return p;
  }
  const info = async (companyId: string) => {
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    const s = await stripeConfig(companyId);
    return {
      company: { id: c.id, name: c.name, phone: c.phone, email: c.email, website: c.website, hasLogo: !!c.logoKey, isTest: !!c.testOfCompanyId },
      payments: s ? { enabled: true, publishableKey: s.publishableKey, testMode: s.mode === "test" } : { enabled: false as const },
    };
  };
  app.get<{ Params: { token: string } }>("/:token", limited, async (req) => {
    const p = await byToken(req.params.token);
    return { ...(await info(p.companyId)), prepayment: await prepaymentView(p) };
  });
  app.post<{ Params: { token: string } }>("/:token/pay", limited, async (req) => {
    const p = await byToken(req.params.token);
    return startPrepaymentPayment(p.companyId, p.id);
  });
  app.post<{ Params: { token: string } }>("/:token/confirm", limited, async (req) => {
    const p = await byToken(req.params.token);
    const { paymentIntentId } = parse(z.object({ paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/) }), req.body);
    const result = await recordPaymentIntent(p.companyId, paymentIntentId);
    const [fresh] = await db.select().from(prepayments).where(eq(prepayments.id, p.id));
    return { ...result, prepayment: await prepaymentView(fresh) };
  });
};

export default routes;

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { customerName, formatAddress, isInactive, isOverdue } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customerContacts, customers, employees, invoiceLines, invoicePayments, invoices, portalCodes, properties, propertyAssignments } from "../db/schema";
import { authenticate, requireRole, WEB_CLIENT_HEADER, type AuthUser } from "../lib/auth";
import { HttpError, parse } from "../lib/errors";
import { WEB_URL, sendSystemEmail } from "../lib/channels";
import { randomToken, sha256 } from "../lib/crypto";
import { companyToday } from "../lib/payRates";
import { invoicePdf } from "../lib/invoicePdf";
import { queueBillingSync, syncCustomer } from "../lib/billingSync";
import { recordPaymentIntent, startInvoicePayment, stripeConfig } from "../lib/stripe";
import { companyForPdf, pdfInvoice, sendPdf } from "./invoices";

/**
 * The customer portal: customers sign in with a code emailed to the address on their account (no
 * password), see their invoices and balance, download PDFs, and pay by card or bank account. Staff
 * can open it read-only for one customer ("View as customer").
 *
 * Also the pay link in invoice emails (/pay/<token>): one invoice, no sign-in, for 30 days.
 */

export const PORTAL_COOKIE = "crewdesk_portal";
const PORTAL_DAYS = 30;
const STAFF_VIEW_MINUTES = 60;
const CODE_MINUTES = 15;
const MAX_TRIES = 5;

const limited = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT ?? 20), timeWindow: "15 minutes" } } };
const uuidRe = /^[0-9a-f-]{36}$/i;
const emailSchema = z.string().trim().toLowerCase().email("Enter the email address we send your invoices to").max(200);
const codeHash = (companyId: string, email: string, code: string) => sha256(`portal-code:${companyId}:${email}:${code}`);
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The company a customer is signing in to: the one named, or the only real company on this server. */
async function portalCompany(companyId?: string | null) {
  if (companyId) {
    if (!uuidRe.test(companyId)) throw new HttpError(404, "Not found");
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!c) throw new HttpError(404, "Not found");
    return c;
  }
  const real = await db.select().from(companies).where(isNull(companies.testOfCompanyId)).limit(2);
  if (real.length !== 1) throw new HttpError(400, "Please use the sign-in link from your invoice email");
  return real[0];
}

/** Customers this email may see: the account's own email, or a contact set to get its invoices. */
async function customerIdsFor(companyId: string, email: string) {
  const direct = await db.select({ id: customers.id }).from(customers)
    .where(and(eq(customers.companyId, companyId), sql`lower(${customers.email}) = ${email}`));
  const contacts = await db.select({ id: customerContacts.customerId }).from(customerContacts)
    .where(and(eq(customerContacts.companyId, companyId), eq(customerContacts.getsInvoices, true), sql`lower(${customerContacts.email}) = ${email}`));
  return [...new Set([...direct, ...contacts].map((r) => r.id))];
}

interface Viewer { companyId: string; email: string; customerIds: string[]; staff: string | null }

function setPortalCookie(reply: FastifyReply, token: string, maxAge: number) {
  reply.setCookie(PORTAL_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge });
}

function signIn(app: FastifyInstance, reply: FastifyReply, companyId: string, email: string) {
  const token = app.jwt.sign({ sub: email, companyId, role: "employee", purpose: "portal" }, { expiresIn: `${PORTAL_DAYS}d` });
  setPortalCookie(reply, token, PORTAL_DAYS * 86400);
}

/** Who is looking at the portal (a customer, or staff viewing as one), from the portal cookie. */
async function viewer(app: FastifyInstance, req: FastifyRequest): Promise<Viewer> {
  const raw = req.cookies[PORTAL_COOKIE];
  if (!raw) throw new HttpError(401, "Please sign in");
  let claims: AuthUser;
  try { claims = app.jwt.verify<AuthUser>(raw); } catch { throw new HttpError(401, "Please sign in again"); }
  if (claims.purpose !== "portal" || !claims.companyId) throw new HttpError(401, "Please sign in");
  // A form on another site can't add this header, so changes only come from the portal itself.
  if (!["GET", "HEAD"].includes(req.method) && req.headers[WEB_CLIENT_HEADER] !== "web") throw new HttpError(403, "Request blocked: missing the Crewdesk client header");
  if (claims.staff) {
    const [e] = await db.select().from(employees).where(eq(employees.id, claims.staff));
    if (!e || e.companyId !== claims.companyId || isInactive(e.status)) throw new HttpError(401, "Please open the portal again from Crewdesk");
    const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, claims.cust ?? ""), eq(customers.companyId, claims.companyId)));
    if (!c) throw new HttpError(404, "That customer no longer exists");
    return { companyId: claims.companyId, email: claims.sub, customerIds: [c.id], staff: e.id };
  }
  const ids = await customerIdsFor(claims.companyId, claims.sub);
  if (!ids.length) throw new HttpError(401, "We can't find an account with this email any more. Please call the office.");
  return { companyId: claims.companyId, email: claims.sub, customerIds: ids, staff: null };
}

function noStaff(v: Viewer, what: string) {
  if (v.staff) throw new HttpError(403, `You're viewing as the customer, so you can't ${what} here. The customer can, from their own sign-in.`);
}

/** An invoice the viewer may see (sent, partial, paid or void; never a draft). */
async function viewerInvoice(v: Viewer, id: string) {
  if (!uuidRe.test(id)) throw new HttpError(404, "Invoice not found");
  const [inv] = await db.select().from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.companyId, v.companyId), inArray(invoices.customerId, v.customerIds), ne(invoices.status, "draft")));
  if (!inv) throw new HttpError(404, "Invoice not found");
  return inv;
}

async function companyInfo(companyId: string) {
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  const stripe = await stripeConfig(companyId);
  return {
    company: { id: c.id, name: c.name, phone: c.phone, email: c.email, website: c.website, hasLogo: !!c.logoKey, isTest: !!c.testOfCompanyId },
    payments: stripe ? { enabled: true, publishableKey: stripe.publishableKey, testMode: stripe.mode === "test" } : { enabled: false as const },
  };
}

/** One invoice for the portal or a pay link: lines, payments made, and what's left to pay. */
async function invoiceDetail(companyId: string, inv: typeof invoices.$inferSelect) {
  const [cust] = await db.select().from(customers).where(eq(customers.id, inv.customerId));
  const [prop] = inv.propertyId ? await db.select().from(properties).where(eq(properties.id, inv.propertyId)) : [];
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.sortOrder));
  const pays = await db.select().from(invoicePayments).where(and(eq(invoicePayments.invoiceId, inv.id), inArray(invoicePayments.status, ["completed", "pending"])))
    .orderBy(asc(invoicePayments.createdAt));
  const pendingCents = pays.filter((p) => p.status === "pending").reduce((s, p) => s + p.amountCents, 0);
  const today = await companyToday(companyId);
  return {
    id: inv.id, number: inv.number, status: inv.status, issueDate: inv.issueDate, dueDate: inv.dueDate, poNumber: inv.poNumber, notes: inv.notes,
    subtotalCents: inv.subtotalCents, discountCents: inv.discountCents, totalCents: inv.totalCents, paidCents: inv.paidCents,
    balanceCents: inv.status === "void" ? 0 : inv.totalCents - inv.paidCents, pendingCents, overdue: isOverdue(inv, today),
    customer: { id: cust.id, number: cust.number, name: customerName(cust) },
    serviceAddress: prop ? formatAddress(prop) : null,
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
    payments: pays.map((p) => ({ id: p.id, amountCents: p.amountCents, method: p.method, methodDetail: p.methodDetail, receivedOn: p.receivedOn, status: p.status })),
  };
}

async function sendCode(company: typeof companies.$inferSelect, email: string) {
  // One code at a time, and no more than one email every 30 seconds.
  const [recent] = await db.select({ createdAt: portalCodes.createdAt }).from(portalCodes)
    .where(and(eq(portalCodes.companyId, company.id), eq(portalCodes.email, email), gt(portalCodes.createdAt, new Date(Date.now() - 30_000))));
  if (recent) return;
  await db.delete(portalCodes).where(and(eq(portalCodes.companyId, company.id), eq(portalCodes.email, email)));
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  const link = randomToken(24);
  await db.insert(portalCodes).values({ companyId: company.id, email, codeHash: codeHash(company.id, email, code), linkHash: sha256(link), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) });
  const url = `${WEB_URL}/portal/sign-in?link=${encodeURIComponent(link)}`;
  try {
    await sendSystemEmail(
      email,
      `${code} is your ${company.name} sign-in code`,
      `Your code to see your ${company.name} account is ${code}\n\nOr open this link: ${url}\n\nBoth work for ${CODE_MINUTES} minutes. If you didn't ask for this, you can ignore this email.\n`,
      `<p>Your code to see your ${esc(company.name)} account is</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>`
        + `<p>Or <a href="${esc(url)}">click here to sign in</a>.</p><p style="color:#667085">Both work for ${CODE_MINUTES} minutes. If you didn't ask for this, you can ignore this email.</p>`,
    );
  } catch (e) {
    console.error(`Couldn't email a portal code: ${(e as Error).message}`);
  }
}

const portalRoutes: FastifyPluginAsync = async (app) => {
  /** Public: the company's name (and whether it takes online payments) for the sign-in page. */
  app.get<{ Querystring: { c?: string } }>("/company", async (req) => {
    const c = await portalCompany(req.query.c);
    return companyInfo(c.id);
  });

  /** Emails a 6-digit code and a sign-in link. Always says "sent" so it can't be used to test addresses. */
  app.post("/start", limited, async (req) => {
    const body = parse(z.object({ email: emailSchema, companyId: z.string().optional().nullable() }), req.body);
    const company = await portalCompany(body.companyId);
    if ((await customerIdsFor(company.id, body.email)).length) await sendCode(company, body.email);
    return { ok: true, companyId: company.id };
  });

  app.post("/verify", limited, async (req, reply) => {
    const body = parse(z.object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email"), companyId: z.string().optional().nullable() }), req.body);
    const company = await portalCompany(body.companyId);
    const [row] = await db.select().from(portalCodes)
      .where(and(eq(portalCodes.companyId, company.id), eq(portalCodes.email, body.email), isNull(portalCodes.usedAt), gt(portalCodes.expiresAt, new Date())))
      .orderBy(desc(portalCodes.createdAt)).limit(1);
    if (!row) throw new HttpError(400, "That code has expired. Ask for a new one");
    if (row.attempts >= MAX_TRIES) throw new HttpError(400, "Too many tries. Ask for a new code");
    if (row.codeHash !== codeHash(company.id, body.email, body.code)) {
      await db.update(portalCodes).set({ attempts: row.attempts + 1 }).where(eq(portalCodes.id, row.id));
      throw new HttpError(400, "That code isn't right. Check the newest email from us");
    }
    const [used] = await db.update(portalCodes).set({ usedAt: new Date() }).where(and(eq(portalCodes.id, row.id), isNull(portalCodes.usedAt))).returning();
    if (!used) throw new HttpError(400, "That code was already used. Ask for a new one");
    signIn(app, reply, company.id, body.email);
    return { ok: true };
  });

  /** The link in the code email. */
  app.post("/link", limited, async (req, reply) => {
    const { link } = parse(z.object({ link: z.string().min(10).max(200) }), req.body);
    const [used] = await db.update(portalCodes).set({ usedAt: new Date() })
      .where(and(eq(portalCodes.linkHash, sha256(link)), isNull(portalCodes.usedAt), gt(portalCodes.expiresAt, new Date()))).returning();
    if (!used) throw new HttpError(400, "That sign-in link has expired or was already used. Ask for a new code");
    signIn(app, reply, used.companyId, used.email);
    return { ok: true };
  });

  app.post("/sign-out", async (_req, reply) => {
    reply.clearCookie(PORTAL_COOKIE, { path: "/" });
    return { ok: true };
  });

  /** Staff: opens the portal as one customer (read-only), for an hour. */
  app.post("/view-as", { preHandler: [authenticate, requireRole("manager", "customers")] }, async (req, reply) => {
    const { customerId } = parse(z.object({ customerId: z.string().uuid() }), req.body);
    const [c] = await db.select({ id: customers.id, email: customers.email }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, req.user.companyId)));
    if (!c) throw new HttpError(404, "Customer not found");
    const token = app.jwt.sign({ sub: c.email ?? "", companyId: req.user.companyId, role: "employee", purpose: "portal", staff: req.user.sub, cust: c.id }, { expiresIn: `${STAFF_VIEW_MINUTES}m` });
    setPortalCookie(reply, token, STAFF_VIEW_MINUTES * 60);
    return { ok: true };
  });

  /** Everything on the portal's home page. */
  app.get("/me", async (req) => {
    const v = await viewer(app, req);
    const info = await companyInfo(v.companyId);
    const today = await companyToday(v.companyId);
    const custs = await db.select().from(customers).where(inArray(customers.id, v.customerIds)).orderBy(asc(customers.number));
    // Properties they're currently on (as bill-to or resident).
    const props = (await db.select({ p: properties, customerId: propertyAssignments.customerId }).from(propertyAssignments)
      .innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
      .where(and(inArray(propertyAssignments.customerId, v.customerIds), isNull(propertyAssignments.endDate), eq(properties.status, "active"))))
      .map((r) => ({ ...r.p, customerId: r.customerId }));
    const invs = await db.select().from(invoices)
      .where(and(eq(invoices.companyId, v.companyId), inArray(invoices.customerId, v.customerIds), inArray(invoices.status, ["sent", "partial", "paid"])))
      .orderBy(desc(invoices.issueDate), desc(invoices.number)).limit(200);
    const pend = invs.length ? await db.select({ invoiceId: invoicePayments.invoiceId, cents: sql<number>`sum(${invoicePayments.amountCents})::int` }).from(invoicePayments)
      .where(and(inArray(invoicePayments.invoiceId, invs.map((i) => i.id)), eq(invoicePayments.status, "pending"))).groupBy(invoicePayments.invoiceId) : [];
    const pendingBy = new Map(pend.map((p) => [p.invoiceId, Number(p.cents)]));
    const invPropIds = [...new Set(invs.map((i) => i.propertyId).filter((x): x is string => !!x))];
    const invProps = invPropIds.length ? await db.select().from(properties).where(inArray(properties.id, invPropIds)) : [];
    const propAddr = new Map(invProps.map((p) => [p.id, formatAddress(p)]));
    const pays = await db.select({ p: invoicePayments, number: invoices.number }).from(invoicePayments).innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
      .where(and(inArray(invoicePayments.customerId, v.customerIds), inArray(invoicePayments.status, ["completed", "pending"])))
      .orderBy(desc(invoicePayments.receivedOn), desc(invoicePayments.createdAt)).limit(50);
    const list = invs.map((i) => ({
      id: i.id, number: i.number, customerId: i.customerId, status: i.status, issueDate: i.issueDate, dueDate: i.dueDate,
      totalCents: i.totalCents, paidCents: i.paidCents, balanceCents: i.totalCents - i.paidCents, pendingCents: pendingBy.get(i.id) ?? 0,
      overdue: isOverdue(i, today), serviceAddress: i.propertyId ? propAddr.get(i.propertyId) ?? null : null,
    }));
    return {
      ...info,
      viewer: { email: v.email, staff: !!v.staff },
      customers: custs.map((c) => {
        const open = list.filter((i) => i.customerId === c.id && i.status !== "paid");
        return {
          id: c.id, number: c.number, name: customerName(c), email: c.email, phone: c.phone,
          billing: { street: c.billingStreet, city: c.billingCity, state: c.billingState, zip: c.billingZip },
          balanceCents: open.reduce((s, i) => s + i.balanceCents, 0),
          overdueCents: open.filter((i) => i.overdue).reduce((s, i) => s + i.balanceCents, 0),
          properties: props.filter((p) => p.customerId === c.id).map((p) => ({ id: p.id, address: formatAddress(p) })),
        };
      }),
      invoices: list,
      paymentHistory: pays.map(({ p, number }) => ({ id: p.id, invoiceId: p.invoiceId, invoiceNumber: number, amountCents: p.amountCents, method: p.method, methodDetail: p.methodDetail, receivedOn: p.receivedOn, status: p.status })),
    };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (req) => {
    const v = await viewer(app, req);
    const inv = await viewerInvoice(v, req.params.id);
    return { ...(await companyInfo(v.companyId)), viewer: { email: v.email, staff: !!v.staff }, invoice: await invoiceDetail(v.companyId, inv) };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id/pdf", async (req, reply) => {
    const v = await viewer(app, req);
    const inv = await viewerInvoice(v, req.params.id);
    const data = await pdfInvoice(v.companyId, inv.id);
    return sendPdf(reply, await invoicePdf(await companyForPdf(v.companyId), data), `Invoice-${data.number}.pdf`);
  });

  /** Starts paying the invoice's balance; the browser then shows Stripe's card / bank form. */
  app.post<{ Params: { id: string } }>("/invoices/:id/pay", async (req) => {
    const v = await viewer(app, req);
    noStaff(v, "pay");
    const inv = await viewerInvoice(v, req.params.id);
    return startInvoicePayment(v.companyId, inv.id);
  });

  /** After Stripe's form: record what happened (the webhook does this too). */
  app.post<{ Params: { id: string } }>("/invoices/:id/pay/confirm", async (req) => {
    const v = await viewer(app, req);
    const inv = await viewerInvoice(v, req.params.id);
    const { paymentIntentId } = parse(z.object({ paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/) }), req.body);
    const result = await recordPaymentIntent(v.companyId, paymentIntentId);
    return { ...result, invoice: await invoiceDetail(v.companyId, (await viewerInvoice(v, inv.id))) };
  });

  /** Customers can fix their phone number and billing address. */
  app.put<{ Params: { customerId: string } }>("/customers/:customerId", async (req) => {
    const v = await viewer(app, req);
    noStaff(v, "change the customer's details");
    if (!v.customerIds.includes(req.params.customerId)) throw new HttpError(404, "Not found");
    const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((s) => s || null);
    const body = parse(z.object({ phone: opt(40), billingStreet: opt(200), billingCity: opt(100), billingState: z.string().trim().regex(/^([A-Za-z]{2})?$/, "State is 2 letters").optional().nullable(), billingZip: z.string().trim().regex(/^(\d{5}(-\d{4})?)?$/, "ZIP is 5 digits").optional().nullable().transform((s) => s || null) }), req.body);
    const [u] = await db.update(customers).set({ ...body, billingState: body.billingState ? body.billingState.toUpperCase() : undefined, updatedAt: new Date() })
      .where(and(eq(customers.id, req.params.customerId), eq(customers.companyId, v.companyId))).returning();
    if (u.bigcapitalCustomerId) queueBillingSync(() => syncCustomer(v.companyId, u.id));
    return { ok: true };
  });
};

/** The pay link from an invoice email: /pay/<token>. Works for 30 days after the invoice was last sent. */
const payLinkRoutes: FastifyPluginAsync = async (app) => {
  async function byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "This link isn't right. Check the link in your email");
    const [inv] = await db.select().from(invoices).where(eq(invoices.payToken, token));
    if (!inv || inv.status === "draft") throw new HttpError(404, "This link isn't right. Check the link in your email");
    if (inv.status === "void") throw new HttpError(410, "This invoice was cancelled. Please call the office with any questions");
    if (!inv.payTokenExpiresAt || inv.payTokenExpiresAt < new Date()) throw new HttpError(410, "This pay link has expired. Sign in to see and pay your invoices");
    return inv;
  }

  app.get<{ Params: { token: string } }>("/:token", limited, async (req) => {
    const inv = await byToken(req.params.token);
    return { ...(await companyInfo(inv.companyId)), invoice: await invoiceDetail(inv.companyId, inv) };
  });

  app.get<{ Params: { token: string } }>("/:token/pdf", limited, async (req, reply) => {
    const inv = await byToken(req.params.token);
    const data = await pdfInvoice(inv.companyId, inv.id);
    return sendPdf(reply, await invoicePdf(await companyForPdf(inv.companyId), data), `Invoice-${data.number}.pdf`);
  });

  app.post<{ Params: { token: string } }>("/:token/pay", limited, async (req) => {
    const inv = await byToken(req.params.token);
    return startInvoicePayment(inv.companyId, inv.id);
  });

  app.post<{ Params: { token: string } }>("/:token/confirm", limited, async (req) => {
    const inv = await byToken(req.params.token);
    const { paymentIntentId } = parse(z.object({ paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/) }), req.body);
    const result = await recordPaymentIntent(inv.companyId, paymentIntentId);
    const [fresh] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    return { ...result, invoice: await invoiceDetail(inv.companyId, fresh) };
  });
};

export { portalRoutes, payLinkRoutes };

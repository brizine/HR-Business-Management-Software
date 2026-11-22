import Stripe from "stripe";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { customerName, formatMoney } from "@crewdesk/shared";
import { db } from "../db";
import { companies, customers, invoicePayments, invoices } from "../db/schema";
import { decrypt, encrypt } from "./crypto";
import { HttpError } from "./errors";
import { companyToday } from "./payRates";
import { refreshInvoice } from "./invoices";
import { emailTransport } from "./channels";
import { queueBillingSync, syncPayment } from "./billingSync";

/**
 * Stripe for customer payments (card and US bank account). Each company has its own Stripe keys
 * (test keys in the test company, live keys in the real one), saved encrypted. Card and bank details
 * are typed into Stripe's own form in the browser and never reach Crewdesk; Crewdesk only keeps
 * Stripe's ids and display details ("Visa ·· 4242").
 */

const PURPOSE = "stripe-secret";
export const WEBHOOK_EVENTS = ["payment_intent.succeeded", "payment_intent.processing", "payment_intent.payment_failed", "payment_intent.canceled"] as const;

/** Tests point the SDK at a pretend Stripe (STRIPE_API_HOST/PORT/PROTOCOL). */
function client(secret: string) {
  const host = process.env.STRIPE_API_HOST;
  return new Stripe(secret, {
    ...(host ? { host, port: Number(process.env.STRIPE_API_PORT ?? 443), protocol: (process.env.STRIPE_API_PROTOCOL as "http" | "https") ?? "https" } : {}),
    maxNetworkRetries: 1,
    timeout: 20_000,
    appInfo: { name: "Crewdesk" },
  });
}

export async function stripeConfig(companyId: string) {
  const [c] = await db.select({ stripe: companies.stripe, secret: companies.stripeSecret, webhook: companies.stripeWebhookSecret, testOf: companies.testOfCompanyId, name: companies.name })
    .from(companies).where(eq(companies.id, companyId));
  if (!c?.stripe || !c.secret) return null;
  return { ...c.stripe, secret: decrypt(c.secret, PURPOSE), webhookSecret: c.webhook ? decrypt(c.webhook, PURPOSE) : null, isTestCompany: !!c.testOf, companyName: c.name };
}

/** The company's Stripe client, or a clear error when payments aren't set up. */
export async function stripeFor(companyId: string) {
  const cfg = await stripeConfig(companyId);
  if (!cfg) throw new HttpError(400, "Online payments aren't set up yet. Please pay by check, or call the office.");
  return { cfg, stripe: client(cfg.secret) };
}

const keyMode = (k: string) => (/^(sk|rk|pk)_live_/.test(k) ? "live" : /^(sk|rk|pk)_test_/.test(k) ? "test" : null);

/**
 * Saves the company's Stripe keys after checking them with Stripe, and creates the webhook Stripe
 * uses to tell Crewdesk about payments (replacing one Crewdesk made before).
 */
export async function connectStripe(companyId: string, publishableKey: string, secretKey: string, publicApiUrl: string | null) {
  const pm = keyMode(publishableKey), sm = keyMode(secretKey);
  if (!pm || !publishableKey.startsWith("pk_")) throw new HttpError(400, "The publishable key starts with pk_test_ or pk_live_");
  if (!sm || publishableKey.startsWith("pk_") === false || !/^(sk|rk)_/.test(secretKey)) throw new HttpError(400, "The secret key starts with sk_test_ or sk_live_");
  if (pm !== sm) throw new HttpError(400, "Both keys must be test keys, or both live keys");
  const [company] = await db.select({ testOf: companies.testOfCompanyId, stripe: companies.stripe, secret: companies.stripeSecret }).from(companies).where(eq(companies.id, companyId));
  if (company.testOf && pm === "live") throw new HttpError(400, "The test company only takes Stripe test keys (pk_test_ / sk_test_), so no real money moves");
  const stripe = client(secretKey);
  let accountName: string | null = null;
  try {
    const acct = await stripe.accounts.retrieveCurrent();
    accountName = acct.business_profile?.name ?? acct.settings?.dashboard?.display_name ?? acct.email ?? null;
  } catch (e) {
    throw new HttpError(400, `Stripe didn't accept that secret key (${(e as Error).message})`);
  }
  let webhookEndpointId: string | null = null, webhookSecret: string | null = null;
  // Stripe can only send webhooks to a public https address; on a test machine, payments are confirmed when the customer returns.
  if (publicApiUrl && /^https:\/\//.test(publicApiUrl)) {
    const url = `${publicApiUrl}/stripe/webhook/${companyId}`;
    const old = company.stripe?.webhookEndpointId;
    if (old && company.secret) { try { await client(decrypt(company.secret, PURPOSE)).webhookEndpoints.del(old); } catch { /* already gone */ } }
    const existing = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const w of existing.data.filter((w) => w.url === url)) { try { await stripe.webhookEndpoints.del(w.id); } catch { /* ignore */ } }
    const made = await stripe.webhookEndpoints.create({ url, enabled_events: [...WEBHOOK_EVENTS], description: "Crewdesk: customer payments" });
    webhookEndpointId = made.id;
    webhookSecret = made.secret ?? null;
  }
  await db.update(companies).set({
    stripe: { publishableKey, mode: pm, webhookEndpointId, accountName, connectedAt: new Date().toISOString() },
    stripeSecret: encrypt(secretKey, PURPOSE),
    stripeWebhookSecret: webhookSecret ? encrypt(webhookSecret, PURPOSE) : null,
  }).where(eq(companies.id, companyId));
  return { mode: pm, accountName, webhook: !!webhookEndpointId };
}

export async function disconnectStripe(companyId: string) {
  const cfg = await stripeConfig(companyId);
  if (cfg?.webhookEndpointId) { try { await client(cfg.secret).webhookEndpoints.del(cfg.webhookEndpointId); } catch { /* already gone */ } }
  await db.update(companies).set({ stripe: null, stripeSecret: null, stripeWebhookSecret: null }).where(eq(companies.id, companyId));
}

/** The customer's Stripe customer id, creating it the first time they pay. */
async function stripeCustomerId(stripe: Stripe, c: typeof customers.$inferSelect) {
  if (c.stripeCustomerId) return c.stripeCustomerId;
  const made = await stripe.customers.create({ name: customerName(c), email: c.email ?? undefined, phone: c.phone ?? undefined, metadata: { crewdeskCustomerId: c.id, customerNumber: String(c.number) } });
  await db.update(customers).set({ stripeCustomerId: made.id }).where(eq(customers.id, c.id));
  return made.id;
}

/** Starts paying an invoice's balance: a PaymentIntent for card or bank account. */
export async function startInvoicePayment(companyId: string, invoiceId: string) {
  const { cfg, stripe } = await stripeFor(companyId);
  const [row] = await db.select({ inv: invoices, cust: customers }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!row) throw new HttpError(404, "Invoice not found");
  const { inv, cust } = row;
  if (inv.status === "void") throw new HttpError(400, "This invoice was cancelled, so there's nothing to pay");
  if (inv.status === "draft") throw new HttpError(400, "This invoice isn't ready yet");
  const pending = await db.select().from(invoicePayments).where(and(eq(invoicePayments.invoiceId, inv.id), eq(invoicePayments.status, "pending")));
  const pendingCents = pending.reduce((s, p) => s + p.amountCents, 0);
  const due = inv.totalCents - inv.paidCents - pendingCents;
  if (due <= 0) throw new HttpError(400, pendingCents ? "A bank payment for this invoice is already on its way" : "This invoice is already paid. Thank you!");
  if (due < 50) throw new HttpError(400, "The amount left is too small to pay online; please call the office");
  const pi = await stripe.paymentIntents.create({
    amount: due, currency: "usd", customer: await stripeCustomerId(stripe, cust),
    allowed_payment_method_types: ["card", "us_bank_account"],
    // The statement shows the account's descriptor (e.g. PROSPRAY LAWN). Crewdesk emails its own receipt, so Stripe's isn't asked for.
    description: `Invoice ${inv.number} from ${cfg.companyName}`,
    metadata: { crewdeskCompanyId: companyId, crewdeskInvoiceId: inv.id, invoiceNumber: String(inv.number) },
  }, { idempotencyKey: `inv-${inv.id}-${due}-${inv.updatedAt.getTime()}-${pending.length}` });
  return { clientSecret: pi.client_secret, publishableKey: cfg.publishableKey, amountCents: due, paymentIntentId: pi.id };
}

function describeMethod(pm: Stripe.PaymentMethod | string | null | undefined): { method: "card" | "ach"; detail: string | null } {
  if (!pm || typeof pm === "string") return { method: "card", detail: null };
  if (pm.type === "us_bank_account" && pm.us_bank_account) return { method: "ach", detail: `${pm.us_bank_account.bank_name ?? "Bank"} ${pm.us_bank_account.account_type ?? "account"} ·· ${pm.us_bank_account.last4}` };
  if (pm.card) return { method: "card", detail: `${pm.card.brand[0].toUpperCase()}${pm.card.brand.slice(1)} ·· ${pm.card.last4}` };
  return { method: "card", detail: null };
}

/**
 * Records what Stripe says about a PaymentIntent (from the webhook, or when the customer comes
 * back from paying): paid, a bank payment on its way, or failed. Safe to call more than once.
 */
export async function recordPaymentIntent(companyId: string, paymentIntentId: string) {
  const { stripe } = await stripeFor(companyId);
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method", "latest_charge.balance_transaction"] });
  return applyPaymentIntent(companyId, pi);
}

export async function applyPaymentIntent(companyId: string, pi: Stripe.PaymentIntent) {
  const invoiceId = pi.metadata?.crewdeskInvoiceId;
  if (!invoiceId || pi.metadata?.crewdeskCompanyId !== companyId) return { ignored: true };
  const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!inv) return { ignored: true };
  const status = pi.status === "succeeded" ? "completed" : pi.status === "processing" ? "pending" : ["requires_payment_method", "canceled"].includes(pi.status) ? "failed" : null;
  if (!status) return { ignored: true };
  const { method, detail } = describeMethod(pi.payment_method as Stripe.PaymentMethod);
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const bt = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const [existing] = await db.select().from(invoicePayments).where(eq(invoicePayments.stripePaymentId, pi.id));
  if (existing?.status === "completed" || existing?.status === "void") return { status: existing.status, paymentId: existing.id };
  if (status === "failed" && !existing) return { status: "failed" };
  const amount = pi.amount_received || pi.amount;
  const values = {
    status, method, methodDetail: detail, amountCents: amount, feeCents: bt?.fee ?? null,
    receivedOn: await companyToday(companyId), stripePaymentId: pi.id,
  };
  let paymentId: string;
  if (existing) {
    await db.update(invoicePayments).set(values).where(eq(invoicePayments.id, existing.id));
    paymentId = existing.id;
  } else {
    const [p] = await db.insert(invoicePayments).values({ ...values, companyId, invoiceId: inv.id, customerId: inv.customerId, note: "Paid online" })
      .onConflictDoNothing({ target: invoicePayments.stripePaymentId }).returning();
    if (!p) return recordAgain(companyId, pi.id);
    paymentId = p.id;
  }
  const updated = await refreshInvoice(db, inv.id);
  if (status === "completed") {
    queueBillingSync(() => syncPayment(companyId, paymentId));
    await sendReceipt(companyId, inv.id, amount, detail, updated ? updated.totalCents - updated.paidCents : 0).catch((e) => console.error("Receipt email failed:", (e as Error).message));
  }
  return { status, paymentId };
}

async function recordAgain(companyId: string, piId: string) {
  const [p] = await db.select().from(invoicePayments).where(eq(invoicePayments.stripePaymentId, piId));
  return { status: p?.status ?? "unknown", paymentId: p?.id };
}

/** A short "payment received" email to the bill-to customer. */
async function sendReceipt(companyId: string, invoiceId: string, amountCents: number, detail: string | null, balanceCents: number) {
  const transport = emailTransport();
  if (!transport) return;
  const [row] = await db.select({ inv: invoices, cust: customers, co: companies }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(companies, eq(companies.id, invoices.companyId)).where(eq(invoices.id, invoiceId));
  const to = row?.cust.email;
  if (!row || !to) return;
  const { inv, cust, co } = row;
  const lines = [`Thank you, ${customerName(cust)}.`, "", `We received your payment of ${formatMoney(amountCents)} for invoice ${inv.number}${detail ? ` (${detail})` : ""}.`,
    balanceCents > 0 ? `Remaining balance on this invoice: ${formatMoney(balanceCents)}.` : "This invoice is now paid in full.", "", co.name];
  await transport.send({
    to, subject: `Payment received: invoice ${inv.number} from ${co.name}`, text: lines.join("\n"), fromName: co.name, replyTo: co.email ?? undefined,
    html: lines.map((l) => (l ? `<p>${l.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)}</p>` : "")).join(""),
  });
}

/** Checks a webhook really came from Stripe (signed with this company's webhook secret). */
export async function verifyWebhook(companyId: string, raw: Buffer, signature: string | undefined) {
  const cfg = await stripeConfig(companyId);
  if (!cfg?.webhookSecret || !signature) throw new HttpError(400, "Not set up for webhooks");
  try {
    return client(cfg.secret).webhooks.constructEvent(raw, signature, cfg.webhookSecret);
  } catch {
    throw new HttpError(400, "Bad signature");
  }
}

/**
 * Bank payments take a few days to clear. The webhook normally reports the result; this hourly
 * check catches any update that didn't arrive (a missed webhook, or a server Stripe can't reach).
 */
export async function checkPendingStripePayments(now = new Date()) {
  const rows = await db.select({ companyId: invoicePayments.companyId, pi: invoicePayments.stripePaymentId }).from(invoicePayments)
    .where(and(eq(invoicePayments.status, "pending"), isNotNull(invoicePayments.stripePaymentId), lt(invoicePayments.createdAt, new Date(now.getTime() - 10 * 60_000))))
    .limit(500);
  for (const r of rows) {
    try { await recordPaymentIntent(r.companyId, r.pi!); } catch (e) { console.error(`Stripe check for ${r.pi} failed:`, (e as Error).message); }
  }
  return rows.length;
}

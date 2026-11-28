import Stripe from "stripe";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { customerName, formatMoney, systemTemplate } from "@crewdesk/shared";
import { db } from "../db";
import { recordAutomationEvent } from "./automationEvents";
import { companies, customers, invoicePayments, invoices, paymentRefunds, prepayments } from "../db/schema";
import { localDate } from "./tz";
import { decrypt, encrypt } from "./crypto";
import { HttpError } from "./errors";
import { companyToday } from "./payRates";
import { refreshInvoice } from "./invoices";
import { emailTransport } from "./channels";
import { queueBillingSync, syncCredit, syncPayment, syncPrepayment } from "./billingSync";
import { applyPrepayments, cashLeft, closeRefunded } from "./prepayments";

/**
 * Stripe for customer payments (card and US bank account). Each company has its own Stripe keys
 * (test keys in the test company, live keys in the real one), saved encrypted. Card and bank details
 * are typed into Stripe's own form in the browser and never reach Crewdesk; Crewdesk only keeps
 * Stripe's ids and display details ("Visa ·· 4242").
 */

const PURPOSE = "stripe-secret";
export const WEBHOOK_EVENTS = [
  "payment_intent.succeeded", "payment_intent.processing", "payment_intent.payment_failed", "payment_intent.canceled",
  "charge.refunded", "refund.created", "refund.updated", "refund.failed",
  "setup_intent.succeeded", "payment_method.detached",
] as const;
/** Bumped when WEBHOOK_EVENTS changes; older webhooks are updated by updateWebhookEvents(). */
export const WEBHOOK_EVENTS_VERSION = 3;

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
    stripe: { publishableKey, mode: pm, webhookEndpointId, accountName, connectedAt: new Date().toISOString(), webhookEvents: WEBHOOK_EVENTS_VERSION },
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
export async function stripeCustomerId(stripe: Stripe, c: typeof customers.$inferSelect) {
  if (c.stripeCustomerId) return c.stripeCustomerId;
  const made = await stripe.customers.create({ name: customerName(c), email: c.email ?? undefined, phone: c.phone ?? undefined, metadata: { crewdeskCustomerId: c.id, customerNumber: String(c.number) } });
  await db.update(customers).set({ stripeCustomerId: made.id }).where(eq(customers.id, c.id));
  return made.id;
}

/**
 * Starts paying an invoice's balance: a PaymentIntent for card or bank account. With `save`, the
 * card or bank account is kept on file for next time (and autopay).
 */
export async function startInvoicePayment(companyId: string, invoiceId: string, o: { save?: boolean } = {}) {
  const { cfg, stripe } = await stripeFor(companyId);
  const [row] = await db.select({ inv: invoices, cust: customers }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!row) throw new HttpError(404, "Invoice not found");
  const { inv, cust } = row;
  if (inv.status === "void") throw new HttpError(400, "This invoice was cancelled, so there's nothing to pay");
  if (inv.status === "draft") throw new HttpError(400, "This invoice isn't ready yet");
  const pending = await db.select().from(invoicePayments).where(and(eq(invoicePayments.invoiceId, inv.id), eq(invoicePayments.status, "pending")));
  const pendingCents = pending.reduce((s, p) => s + p.amountCents, 0);
  const due = inv.totalCents - inv.paidCents - inv.creditedCents - pendingCents;
  if (due <= 0) throw new HttpError(400, pendingCents ? "A bank payment for this invoice is already on its way" : "This invoice is already paid. Thank you!");
  if (due < 50) throw new HttpError(400, "The amount left is too small to pay online; please call the office");
  const pi = await stripe.paymentIntents.create({
    amount: due, currency: "usd", customer: await stripeCustomerId(stripe, cust),
    allowed_payment_method_types: ["card", "us_bank_account"],
    // The statement shows the account's descriptor (e.g. PROSPRAY LAWN). Crewdesk emails its own receipt, so Stripe's isn't asked for.
    description: `Invoice ${inv.number} from ${cfg.companyName}`,
    metadata: { crewdeskCompanyId: companyId, crewdeskInvoiceId: inv.id, invoiceNumber: String(inv.number) },
    ...(o.save ? { setup_future_usage: "off_session" as const } : {}),
  }, { idempotencyKey: `inv-${inv.id}-${due}-${inv.updatedAt.getTime()}-${pending.length}${o.save ? "-save" : ""}` });
  return { clientSecret: pi.client_secret, publishableKey: cfg.publishableKey, amountCents: due, paymentIntentId: pi.id };
}

/** The most invoices one payment can cover (their ids and amounts have to fit in what Stripe keeps with a payment). */
export const MAX_INVOICES_PER_PAYMENT = 10;
const and2 = (list: (string | number)[]) => (list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

/**
 * Starts one payment for several of a customer's invoices: a single charge for the sum of their
 * balances. When it's paid it is recorded as a payment on each invoice (that invoice's share), so
 * every invoice still has its own payment to see, refund and post to the books.
 */
export async function startAccountPayment(companyId: string, invoiceIds: string[], o: { save?: boolean } = {}) {
  const ids = [...new Set(invoiceIds)];
  if (!ids.length) throw new HttpError(400, "Pick at least one invoice to pay");
  if (ids.length === 1) return startInvoicePayment(companyId, ids[0], o);
  if (ids.length > MAX_INVOICES_PER_PAYMENT) throw new HttpError(400, `Up to ${MAX_INVOICES_PER_PAYMENT} invoices can be paid at once. Untick some and pay the rest after`);
  const { cfg, stripe } = await stripeFor(companyId);
  const rows = await db.select().from(invoices).where(and(eq(invoices.companyId, companyId), inArray(invoices.id, ids))).orderBy(asc(invoices.issueDate), asc(invoices.number));
  if (rows.length !== ids.length) throw new HttpError(404, "One of those invoices wasn't found");
  if (new Set(rows.map((r) => r.customerId)).size !== 1) throw new HttpError(400, "Those invoices aren't all for the same customer");
  const pending = await db.select().from(invoicePayments).where(and(inArray(invoicePayments.invoiceId, ids), eq(invoicePayments.status, "pending")));
  const parts = rows.map((inv) => {
    if (inv.status === "void" || inv.status === "draft") throw new HttpError(400, `Invoice ${inv.number ?? ""} can't be paid`.replace("  ", " "));
    const due = inv.totalCents - inv.paidCents - inv.creditedCents - pending.filter((p) => p.invoiceId === inv.id).reduce((s, p) => s + p.amountCents, 0);
    if (due <= 0) throw new HttpError(400, `Invoice ${inv.number} is already paid or has a bank payment on its way. Untick it and try again`);
    return { inv, due };
  });
  const total = parts.reduce((s, p) => s + p.due, 0);
  if (total < 50) throw new HttpError(400, "The amount left is too small to pay online; please call the office");
  const [cust] = await db.select().from(customers).where(eq(customers.id, rows[0].customerId));
  const split = parts.map((p) => `${p.inv.id}:${p.due}`).join(",");
  const stamp = createHash("sha256").update(`${split}|${rows.map((r) => r.updatedAt.getTime()).join(",")}|${pending.length}`).digest("hex").slice(0, 40);
  const pi = await stripe.paymentIntents.create({
    amount: total, currency: "usd", customer: await stripeCustomerId(stripe, cust),
    allowed_payment_method_types: ["card", "us_bank_account"],
    description: `Invoices ${and2(parts.map((p) => p.inv.number ?? "?"))} from ${cfg.companyName}`.slice(0, 500),
    // `crewdeskSplit` is how the charge divides: each invoice and the cents of it that are its.
    metadata: { crewdeskCompanyId: companyId, crewdeskInvoiceId: parts[0].inv.id, crewdeskSplit: split, invoiceNumber: parts.map((p) => p.inv.number).join(",") },
    ...(o.save ? { setup_future_usage: "off_session" as const } : {}),
  }, { idempotencyKey: `acct-${stamp}${o.save ? "-save" : ""}` });
  return { clientSecret: pi.client_secret, publishableKey: cfg.publishableKey, amountCents: total, paymentIntentId: pi.id };
}

/** "id:cents,id:cents" as kept with a payment for several invoices; nothing when it isn't one. */
function parseSplit(s: string | undefined): { invoiceId: string; cents: number }[] {
  const out = (s ?? "").split(",").map((x) => { const [invoiceId, cents] = x.split(":"); return { invoiceId, cents: Number(cents) }; });
  return out.length > 1 && out.every((x) => /^[0-9a-f-]{36}$/i.test(x.invoiceId ?? "") && Number.isInteger(x.cents) && x.cents > 0) ? out : [];
}

/**
 * Records a payment made for several invoices at once: a payment on each invoice for its share,
 * all carrying the one charge's id, Stripe's fee divided between them in proportion. One receipt
 * goes out for the lot.
 */
async function applySplitIntent(companyId: string, pi: Stripe.PaymentIntent, split: { invoiceId: string; cents: number }[]) {
  if (pi.metadata?.crewdeskCompanyId !== companyId) return { ignored: true };
  const invs = await db.select().from(invoices).where(and(eq(invoices.companyId, companyId), inArray(invoices.id, split.map((s) => s.invoiceId))));
  if (invs.length !== split.length || new Set(invs.map((i) => i.customerId)).size !== 1) return { ignored: true };
  const total = split.reduce((s, x) => s + x.cents, 0);
  // The shares have to add up to what was charged, or something isn't what it says it is.
  if (total !== pi.amount) { console.error(`Stripe payment ${pi.id}: its invoices add up to ${total}, not the ${pi.amount} charged. Not recorded.`); return { ignored: true }; }
  const status = pi.status === "succeeded" ? "completed" : pi.status === "processing" ? "pending" : ["requires_payment_method", "canceled"].includes(pi.status) ? "failed" : null;
  if (!status) return { ignored: true };
  const { method, detail } = describeMethod(pi.payment_method as Stripe.PaymentMethod);
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const bt = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const numbers = and2(split.map((s) => invs.find((i) => i.id === s.invoiceId)!.number ?? "?"));
  const receivedOn = await companyToday(companyId);
  let feeLeft = bt?.fee ?? null;
  const written = await db.transaction(async (tx) => {
    // The webhook and the customer coming back from paying can arrive together: one at a time per charge.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stripe:${pi.id}`}))`);
    const existing = await tx.select().from(invoicePayments).where(eq(invoicePayments.stripePaymentId, pi.id));
    if (existing.length === split.length && existing.every((e) => e.status === "completed" || e.status === "void")) return { done: true as const, ids: existing.map((e) => e.id) };
    if (status === "failed" && !existing.length) return { failed: true as const, ids: [] as string[] };
    const ids: string[] = [];
    for (const [i, part] of split.entries()) {
      // The fee follows the money: each invoice carries its share, and the last one takes what rounding left.
      const fee = feeLeft == null ? null : i === split.length - 1 ? feeLeft : Math.floor((bt!.fee * part.cents) / total);
      if (feeLeft != null && fee != null) feeLeft -= fee;
      const values = { status, method, methodDetail: detail, amountCents: part.cents, feeCents: fee, receivedOn, stripePaymentId: pi.id, note: `Paid online with invoices ${numbers}, in one payment of ${formatMoney(total)}` };
      const had = existing.find((e) => e.invoiceId === part.invoiceId);
      if (had) { if (had.status !== "completed" && had.status !== "void") await tx.update(invoicePayments).set(values).where(eq(invoicePayments.id, had.id)); ids.push(had.id); }
      else ids.push((await tx.insert(invoicePayments).values({ ...values, companyId, invoiceId: part.invoiceId, customerId: invs[0].customerId }).returning({ id: invoicePayments.id }))[0].id);
    }
    return { ids };
  });
  if ("failed" in written) return { status: "failed" };
  if ("done" in written) return { status: "completed", paymentId: written.ids[0] };
  for (const part of split) await refreshInvoice(db, part.invoiceId);
  const customerId = invs[0].customerId;
  if (status === "failed") await recordAutomationEvent(companyId, customerId, "payment_declined", { type: "invoice", id: split[0].invoiceId });
  if (pi.setup_future_usage === "off_session" && pi.payment_method && typeof pi.payment_method === "object" && status !== "failed") {
    const { saveMethod } = await import("./paymentMethods");
    await saveMethod(companyId, customerId, pi.payment_method as Stripe.PaymentMethod, "customer").catch((e) => console.error("Saving the payment method failed:", (e as Error).message));
  }
  if (status === "completed") {
    for (const id of written.ids) queueBillingSync(() => syncPayment(companyId, id));
    const left = (await db.select().from(invoices).where(inArray(invoices.id, split.map((s) => s.invoiceId)))).reduce((s, i) => s + Math.max(0, i.totalCents - i.paidCents - i.creditedCents), 0);
    // One receipt for the whole payment, naming every invoice it paid.
    await sendReceipt(companyId, split[0].invoiceId, written.ids[0], { invoiceIds: split.map((s) => s.invoiceId), vars: { INVOICE_NUMBER: numbers, PAYMENT_AMOUNT: formatMoney(total), INVOICE_BALANCE: formatMoney(left) } })
      .catch((e) => console.error("Receipt email failed:", (e as Error).message));
  }
  return { status, paymentId: written.ids[0] };
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
  if (pi.metadata?.crewdeskPrepaymentId) return applyPrepaymentIntent(companyId, pi);
  const split = parseSplit(pi.metadata?.crewdeskSplit);
  if (split.length) return applySplitIntent(companyId, pi, split);
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
      .onConflictDoNothing({ target: [invoicePayments.stripePaymentId, invoicePayments.invoiceId] }).returning();
    if (!p) return recordAgain(companyId, pi.id);
    paymentId = p.id;
  }
  const updated = await refreshInvoice(db, inv.id);
  if (status === "failed") await recordAutomationEvent(companyId, inv.customerId, "payment_declined", { type: "invoice", id: inv.id });
  // "Save for next time": keep the card or bank account on file.
  if (pi.setup_future_usage === "off_session" && pi.payment_method && typeof pi.payment_method === "object" && status !== "failed") {
    const { saveMethod } = await import("./paymentMethods");
    await saveMethod(companyId, inv.customerId, pi.payment_method as Stripe.PaymentMethod, "customer").catch((e) => console.error("Saving the payment method failed:", (e as Error).message));
  }
  if (status === "completed") {
    queueBillingSync(() => syncPayment(companyId, paymentId));
    await sendReceipt(companyId, inv.id, paymentId).catch((e) => console.error("Receipt email failed:", (e as Error).message));
  }
  return { status, paymentId };
}

async function recordAgain(companyId: string, piId: string) {
  const [p] = await db.select().from(invoicePayments).where(eq(invoicePayments.stripePaymentId, piId));
  return { status: p?.status ?? "unknown", paymentId: p?.id };
}

/** The "payment received" email (and text, for customers who get texts), from the receipt template in Resources → Templates. */
async function sendReceipt(companyId: string, invoiceId: string, paymentId: string | undefined, o: { invoiceIds?: string[]; vars?: Record<string, string> } = {}) {
  if (!paymentId) return;
  const [row] = await db.select({ inv: invoices, cust: customers }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId)).where(eq(invoices.id, invoiceId));
  if (!row) return;
  const { messageTemplates, sendTemplateEmail, sendTemplateText } = await import("./templates");
  const chosen = await messageTemplates(companyId, "receipt");
  const tpl = chosen.email ?? { id: null, subject: systemTemplate("receipt_email")!.subject!, body: systemTemplate("receipt_email")!.body };
  if (row.cust.email && emailTransport()) {
    let attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    if (chosen.attachPdf) {
      const { companyForPdf, pdfInvoice } = await import("../routes/invoices");
      const { invoicePdf } = await import("./invoicePdf");
      // A payment for several invoices attaches each of them.
      const company = await companyForPdf(companyId);
      for (const id of o.invoiceIds ?? [invoiceId]) {
        const data = await pdfInvoice(companyId, id);
        attachments.push({ filename: `Invoice-${data.number}.pdf`, content: Buffer.from(await invoicePdf(company, data)), contentType: "application/pdf" });
      }
    }
    await sendTemplateEmail({ companyId, template: tpl, to: row.cust.email, ctx: { invoiceId, paymentId }, transactional: true, attachments, vars: o.vars });
  }
  // The text keeps to the first invoice's own wording (a text has no room for a list).
  if ((row.cust.delivery ?? []).includes("text") && chosen.text) await sendTemplateText({ companyId, template: chosen.text, ctx: { invoiceId, paymentId }, by: null });
  await recordAutomationEvent(companyId, row.cust.id, "receipt_sent", { type: "payment", id: paymentId });
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
  const rows = [
    ...(await db.select({ companyId: invoicePayments.companyId, pi: invoicePayments.stripePaymentId }).from(invoicePayments)
      .where(and(eq(invoicePayments.status, "pending"), isNotNull(invoicePayments.stripePaymentId), lt(invoicePayments.createdAt, new Date(now.getTime() - 10 * 60_000))))
      .limit(500)),
    // Prepayments paid by bank account, still clearing.
    ...(await db.select({ companyId: prepayments.companyId, pi: prepayments.stripePaymentId }).from(prepayments)
      .where(and(eq(prepayments.status, "pending"), isNotNull(prepayments.stripePaymentId))).limit(500)),
  ];
  // A payment for several invoices has a row for each: ask Stripe about it once.
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.pi!)) continue;
    seen.add(r.pi!);
    try { await recordPaymentIntent(r.companyId, r.pi!); } catch (e) { console.error(`Stripe check for ${r.pi} failed:`, (e as Error).message); }
  }
  return rows.length;
}

/* ── Refunds ── */

/** Refund statuses that count as money going back to the customer (a failed or canceled refund doesn't). */
const REFUNDING = ["pending", "requires_action", "succeeded"];
export const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent"] as const;

/**
 * Makes Crewdesk's refunds for a card or bank payment match Stripe's (refunds made in Crewdesk or in
 * Stripe's dashboard), then updates the invoice balance and the books, and emails the customer
 * about each new refund. Safe to call more than once.
 */
export async function syncRefunds(companyId: string, paymentIntentId: string) {
  // One payment, or one for each invoice a combined charge paid.
  const pays = await db.select().from(invoicePayments).where(and(eq(invoicePayments.companyId, companyId), eq(invoicePayments.stripePaymentId, paymentIntentId)))
    .orderBy(asc(invoicePayments.createdAt), asc(invoicePayments.id));
  if (!pays.length) return syncPrepaymentRefunds(companyId, paymentIntentId);
  const { stripe } = await stripeFor(companyId);
  const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const payIds = pays.map((p) => p.id);
  const refundRows = () => db.select().from(paymentRefunds).where(inArray(paymentRefunds.paymentId, payIds));
  for await (const r of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    const status = r.status ?? "pending";
    const known = await db.select().from(paymentRefunds).where(eq(paymentRefunds.stripeRefundId, r.id));
    if (known.length) {
      // Already put against a payment: only how it's going can change (and, when it's all on one payment, the amount).
      await db.update(paymentRefunds).set({ status, reason: r.reason ?? null, ...(known.length === 1 ? { amountCents: r.amount } : {}) }).where(eq(paymentRefunds.stripeRefundId, r.id));
      continue;
    }
    // Whose refund it is: the payment Crewdesk made it for. One made in Stripe's own dashboard goes on the
    // only payment, or, for a charge that paid several invoices, is shared out across them (oldest first,
    // each up to what's left on it).
    const named = pays.find((p) => p.id === r.metadata?.crewdeskPaymentId);
    let shares: { p: (typeof pays)[number]; cents: number }[];
    if (named) shares = [{ p: named, cents: r.amount }];
    else if (pays.length === 1) shares = [{ p: pays[0], cents: r.amount }];
    else {
      const have = await refundRows();
      let left = r.amount;
      shares = [];
      for (const [i, p] of pays.entries()) {
        const room = p.amountCents - have.filter((x) => x.paymentId === p.id && REFUNDING.includes(x.status)).reduce((s, x) => s + x.amountCents, 0);
        const cents = i === pays.length - 1 ? left : Math.min(left, Math.max(0, room));
        if (cents > 0) shares.push({ p, cents });
        left -= cents;
      }
    }
    for (const { p, cents } of shares) {
      await db.insert(paymentRefunds).values({
        companyId, paymentId: p.id, invoiceId: p.invoiceId, stripeRefundId: r.id, amountCents: cents, status, reason: r.reason ?? null,
        note: r.metadata?.crewdeskNote ?? null, refundedOn: localDate(new Date(r.created * 1000), co?.tz ?? "America/Chicago"),
      }).onConflictDoUpdate({ target: [paymentRefunds.stripeRefundId, paymentRefunds.paymentId], set: { status, reason: r.reason ?? null } });
    }
  }
  const all = await refundRows();
  let total = 0;
  for (const p of pays) {
    const rows = all.filter((x) => x.paymentId === p.id);
    const refunded = Math.min(p.amountCents, rows.filter((r) => REFUNDING.includes(r.status)).reduce((s, r) => s + r.amountCents, 0));
    total += refunded;
    if (refunded !== p.refundedCents) {
      await db.update(invoicePayments).set({ refundedCents: refunded }).where(eq(invoicePayments.id, p.id));
      await refreshInvoice(db, p.invoiceId);
      queueBillingSync(() => syncPayment(companyId, p.id));
    }
    for (const r of rows.filter((x) => !x.notifiedAt && (x.status === "succeeded" || x.status === "pending"))) {
      // Claim it first, so two updates arriving together send one email.
      const [claimed] = await db.update(paymentRefunds).set({ notifiedAt: new Date() }).where(and(eq(paymentRefunds.id, r.id), isNull(paymentRefunds.notifiedAt))).returning();
      if (claimed) await sendRefundEmail(companyId, p, r.amountCents).catch((e) => console.error("Refund email failed:", (e as Error).message));
    }
  }
  return { refundedCents: total };
}

/**
 * Refunds part or all of a card or bank payment through Stripe (staff, from the invoice page). For
 * an invoice paid together with others in one charge, this refunds that invoice's share of the
 * charge (a partial refund of it); the other invoices' payments aren't touched.
 */
export async function refundPayment(companyId: string, paymentId: string, o: { amountCents?: number; reason: (typeof REFUND_REASONS)[number]; note?: string | null; by: string }) {
  const [p] = await db.select().from(invoicePayments).where(and(eq(invoicePayments.id, paymentId), eq(invoicePayments.companyId, companyId)));
  if (!p) throw new HttpError(404, "Payment not found");
  if (!p.stripePaymentId) throw new HttpError(400, "Only card and bank payments made online are refunded here. Void a cash or check payment instead");
  if (p.status === "pending") throw new HttpError(400, "This bank payment hasn't cleared yet. Refund it once it clears (about 4 business days)");
  if (p.status !== "completed") throw new HttpError(400, "Only completed payments can be refunded");
  const left = p.amountCents - p.refundedCents;
  if (left <= 0) throw new HttpError(400, "This payment is already fully refunded");
  const amount = o.amountCents ?? left;
  if (amount > left) throw new HttpError(400, `That's more than the ${formatMoney(left)} left to refund on this payment`);
  if (amount < 1) throw new HttpError(400, "Enter an amount to refund");
  const { stripe } = await stripeFor(companyId);
  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create({
      payment_intent: p.stripePaymentId, amount, reason: o.reason,
      metadata: { crewdeskCompanyId: companyId, crewdeskPaymentId: p.id, ...(o.note ? { crewdeskNote: o.note.slice(0, 450) } : {}) },
    }, { idempotencyKey: `refund-${p.id}-${p.refundedCents}-${amount}` });
  } catch (e) {
    throw new HttpError(400, `Stripe didn't make the refund: ${(e as Error).message}`);
  }
  const [co] = await db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  await db.insert(paymentRefunds).values({
    companyId, paymentId: p.id, invoiceId: p.invoiceId, stripeRefundId: refund.id, amountCents: refund.amount, status: refund.status ?? "pending",
    reason: refund.reason ?? o.reason, note: o.note ?? null, createdById: o.by, refundedOn: localDate(new Date(refund.created * 1000), co?.tz ?? "America/Chicago"),
  }).onConflictDoUpdate({ target: [paymentRefunds.stripeRefundId, paymentRefunds.paymentId], set: { createdById: o.by, note: o.note ?? null } });
  await syncRefunds(companyId, p.stripePaymentId);
  return { refundId: refund.id, status: refund.status, amountCents: refund.amount };
}

async function sendRefundEmail(companyId: string, p: typeof invoicePayments.$inferSelect, amountCents: number) {
  const transport = emailTransport();
  if (!transport) return;
  const [row] = await db.select({ inv: invoices, cust: customers, co: companies }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(companies, eq(companies.id, invoices.companyId)).where(eq(invoices.id, p.invoiceId));
  const to = row?.cust.email;
  if (!row || !to) return;
  const { inv, cust, co } = row;
  const where = p.methodDetail ? ` to your ${p.methodDetail}` : p.method === "ach" ? " to your bank account" : " to your card";
  const lines = [`Hello ${customerName(cust)},`, "", `We've refunded ${formatMoney(amountCents)}${where} for invoice ${inv.number}.`,
    p.method === "ach" ? "Bank refunds usually arrive within 5 business days." : "Card refunds usually show up within 5 to 10 business days, depending on your bank.",
    "", `Questions? Just reply to this email${co.phone ? ` or call ${co.phone}` : ""}.`, "", co.name];
  await transport.send({
    to, subject: `Refund of ${formatMoney(amountCents)} from ${co.name}`, text: lines.join("\n"), fromName: co.name, replyTo: co.email ?? undefined,
    html: lines.map((l) => (l ? `<p>${l.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)}</p>` : "")).join(""),
  });
}

/**
 * Hourly: refunds made in Stripe in the last day, in case Stripe's update didn't arrive (one list
 * call per connected company).
 */
export async function checkRecentRefunds(now = new Date()) {
  const connected = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.stripeSecret));
  let checked = 0;
  for (const c of connected) {
    try {
      const { stripe } = await stripeFor(c.id);
      const pis = new Set<string>();
      for await (const r of stripe.refunds.list({ created: { gte: Math.floor(now.getTime() / 1000) - 26 * 3600 }, limit: 100 })) {
        const pi = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id;
        if (pi) pis.add(pi);
      }
      for (const pi of pis) { await syncRefunds(c.id, pi); checked++; }
    } catch (e) {
      console.error(`Stripe refund check failed for company ${c.id}:`, (e as Error).message);
    }
  }
  return checked;
}

/** Webhooks made before refunds were handled: subscribe them to the refund events too. */
export async function updateWebhookEvents() {
  const rows = await db.select({ id: companies.id, stripe: companies.stripe }).from(companies)
    .where(and(isNotNull(companies.stripeSecret), sql`${companies.stripe}->>'webhookEndpointId' is not null`, sql`coalesce((${companies.stripe}->>'webhookEvents')::int, 1) < ${WEBHOOK_EVENTS_VERSION}`));
  for (const r of rows) {
    try {
      const { stripe } = await stripeFor(r.id);
      await stripe.webhookEndpoints.update(r.stripe!.webhookEndpointId!, { enabled_events: [...WEBHOOK_EVENTS] });
      await db.update(companies).set({ stripe: { ...r.stripe!, webhookEvents: WEBHOOK_EVENTS_VERSION } }).where(eq(companies.id, r.id));
    } catch (e) {
      console.error(`Couldn't update the Stripe webhook for company ${r.id}:`, (e as Error).message);
    }
  }
  return rows.length;
}

/* ── Prepayments ── */

/** Starts paying a prepayment by card or bank account. */
export async function startPrepaymentPayment(companyId: string, prepaymentId: string) {
  const { cfg, stripe } = await stripeFor(companyId);
  const [row] = await db.select({ p: prepayments, cust: customers }).from(prepayments).innerJoin(customers, eq(customers.id, prepayments.customerId))
    .where(and(eq(prepayments.id, prepaymentId), eq(prepayments.companyId, companyId)));
  if (!row) throw new HttpError(404, "Prepayment not found");
  const { p, cust } = row;
  if (p.status === "open" || p.status === "closed") throw new HttpError(400, "This prepayment is already paid. Thank you!");
  if (p.status === "pending") throw new HttpError(400, "A bank payment for this prepayment is already on its way");
  if (p.status === "void") throw new HttpError(400, "This prepayment request was cancelled. Please call the office");
  const pi = await stripe.paymentIntents.create({
    amount: p.amountCents, currency: "usd", customer: await stripeCustomerId(stripe, cust),
    allowed_payment_method_types: ["card", "us_bank_account"],
    description: `Prepayment PP-${p.number} to ${cfg.companyName}: ${p.description}`.slice(0, 900),
    metadata: { crewdeskCompanyId: companyId, crewdeskPrepaymentId: p.id, prepaymentNumber: String(p.number) },
  }, { idempotencyKey: `pp-${p.id}-${p.amountCents}` });
  return { clientSecret: pi.client_secret, publishableKey: cfg.publishableKey, amountCents: p.amountCents, paymentIntentId: pi.id };
}

async function applyPrepaymentIntent(companyId: string, pi: Stripe.PaymentIntent) {
  if (pi.metadata?.crewdeskCompanyId !== companyId) return { ignored: true };
  const [p] = await db.select().from(prepayments).where(and(eq(prepayments.id, pi.metadata.crewdeskPrepaymentId), eq(prepayments.companyId, companyId)));
  if (!p) return { ignored: true };
  const next = pi.status === "succeeded" ? "open" : pi.status === "processing" ? "pending" : ["requires_payment_method", "canceled"].includes(pi.status) ? "failed" : null;
  if (!next) return { ignored: true, prepaymentId: p.id };
  if (p.status === "open" || p.status === "closed" || p.status === "void") return { status: p.status === "void" ? "void" : "completed", prepaymentId: p.id };
  if (next === "failed") {
    // A bank payment that was clearing came back: it can be paid again.
    if (p.status === "pending") await db.update(prepayments).set({ status: "requested", note: [p.note, "A bank payment for it failed"].filter(Boolean).join(" · ") }).where(eq(prepayments.id, p.id));
    return { status: "failed", prepaymentId: p.id };
  }
  const { method, detail } = describeMethod(pi.payment_method as Stripe.PaymentMethod);
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const bt = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const [u] = await db.update(prepayments).set({
    status: next, method, methodDetail: detail, stripePaymentId: pi.id, feeCents: next === "open" ? bt?.fee ?? null : null, receivedOn: await companyToday(companyId),
  }).where(and(eq(prepayments.id, p.id), inArray(prepayments.status, ["requested", "pending"]))).returning();
  if (!u) return { status: "completed", prepaymentId: p.id };
  // A deposit on an estimate: paying it (or a bank payment for it starting) accepts the estimate.
  if (u.estimateId) {
    const { acceptAfterDeposit } = await import("./estimateResponses");
    await acceptAfterDeposit(u.id).catch((e) => console.error("Accepting the estimate after its deposit failed:", (e as Error).message));
  }
  if (next === "open") {
    queueBillingSync(() => syncPrepayment(companyId, u.id));
    if (u.useNow) {
      const made = await db.transaction((tx) => applyPrepayments(tx, companyId, u.customerId, { prepaymentIds: [u.id], by: null }));
      for (const id of made.paymentIds) queueBillingSync(() => syncPayment(companyId, id));
      for (const id of made.creditIds) queueBillingSync(() => syncCredit(companyId, id));
    }
    await sendPrepayReceipt(companyId, u.id).catch((e) => console.error("Prepayment receipt failed:", (e as Error).message));
  }
  return { status: next === "open" ? "completed" : "pending", prepaymentId: u.id };
}

/** Refunds made in Stripe's dashboard on a prepayment: the rest is refunded (closed) once nothing is left. */
async function syncPrepaymentRefunds(companyId: string, paymentIntentId: string) {
  const [p] = await db.select().from(prepayments).where(and(eq(prepayments.companyId, companyId), eq(prepayments.stripePaymentId, paymentIntentId)));
  if (!p) return { ignored: true as const };
  const { stripe } = await stripeFor(companyId);
  let total = 0;
  for await (const r of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) if (REFUNDING.includes(r.status ?? "pending")) total += r.amount;
  // Only what hasn't paid invoices can be refunded from it.
  const refunded = Math.min(total, p.amountCents - p.appliedCents);
  if (refunded !== p.refundedCents) {
    const left = p.amountCents - p.appliedCents - refunded;
    await db.update(prepayments).set({ refundedCents: refunded, ...(left <= 0 && p.status === "open" ? { status: "closed", closedAt: new Date() } : {}) }).where(eq(prepayments.id, p.id));
    queueBillingSync(() => syncPrepayment(companyId, p.id));
  }
  return { refundedCents: refunded };
}

/**
 * Refunds what's left of a prepayment and closes it: back to the card or bank account through
 * Stripe, or (cash, check) recorded as paid back by the office.
 */
export async function refundPrepaymentRest(companyId: string, prepaymentId: string, o: { reference?: string | null }) {
  const [p] = await db.select().from(prepayments).where(and(eq(prepayments.id, prepaymentId), eq(prepayments.companyId, companyId)));
  if (!p) throw new HttpError(404, "Prepayment not found");
  if (p.status !== "open") throw new HttpError(400, p.status === "closed" ? "It's already closed" : "Only a paid prepayment can be refunded");
  const left = cashLeft(p);
  if (left <= 0) throw new HttpError(400, "Nothing is left on this prepayment to refund");
  let reference = o.reference || null;
  if ((p.method === "card" || p.method === "ach") && p.stripePaymentId) {
    const { stripe } = await stripeFor(companyId);
    try {
      const r = await stripe.refunds.create({ payment_intent: p.stripePaymentId, amount: left, reason: "requested_by_customer", metadata: { crewdeskCompanyId: companyId, crewdeskPrepaymentId: p.id } },
        { idempotencyKey: `pp-refund-${p.id}-${p.refundedCents}-${left}` });
      reference = reference ?? `Stripe refund ${r.id}`;
    } catch (e) {
      throw new HttpError(400, `Stripe didn't make the refund: ${(e as Error).message}`);
    }
  }
  const u = await db.transaction((tx) => closeRefunded(tx, p.id, left, reference));
  queueBillingSync(() => syncPrepayment(companyId, p.id));
  await sendPrepayEmail(companyId, p.id, "refund", left).catch((e) => console.error("Prepayment refund email failed:", (e as Error).message));
  return u;
}

const escHtml = (l: string) => l.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);

async function sendPrepayReceipt(companyId: string, prepaymentId: string) {
  return sendPrepayEmail(companyId, prepaymentId, "receipt", 0);
}

async function sendPrepayEmail(companyId: string, prepaymentId: string, kind: "receipt" | "refund", refundCents: number) {
  const transport = emailTransport();
  if (!transport) return;
  const [row] = await db.select({ p: prepayments, cust: customers, co: companies }).from(prepayments).innerJoin(customers, eq(customers.id, prepayments.customerId))
    .innerJoin(companies, eq(companies.id, prepayments.companyId)).where(eq(prepayments.id, prepaymentId));
  const to = row?.cust.email;
  if (!row || !to) return;
  const { p, cust, co } = row;
  const lines = kind === "receipt"
    ? [`Thank you, ${customerName(cust)}.`, "", `We received your prepayment of ${formatMoney(p.amountCents)} for ${p.description}${p.methodDetail ? ` (${p.methodDetail})` : ""}.`,
      p.discountCents ? `You saved ${formatMoney(p.discountCents)} by paying ahead.` : "", "It pays your invoices as the work is done; you can see what's left any time when you sign in to see your bills.", "", co.name]
    : [`Hello ${customerName(cust)},`, "", `We've refunded ${formatMoney(refundCents)}, what was left of your prepayment for ${p.description}${p.methodDetail ? `, to your ${p.methodDetail}` : ""}.`,
      p.method === "card" ? "Card refunds usually show up within 5 to 10 business days." : p.method === "ach" ? "Bank refunds usually arrive within 5 business days." : "",
      "", `Questions? Just reply to this email${co.phone ? ` or call ${co.phone}` : ""}.`, "", co.name];
  const kept = lines.filter((l, i) => l !== "" || lines[i - 1] !== "");
  await transport.send({
    to, subject: kind === "receipt" ? `Prepayment received: ${formatMoney(p.amountCents)} for ${p.description}` : `Refund of ${formatMoney(refundCents)} from ${co.name}`,
    text: kept.join("\n"), fromName: co.name, replyTo: co.email ?? undefined, html: kept.map((l) => (l ? `<p>${escHtml(l)}</p>` : "")).join(""),
  });
}

import type Stripe from "stripe";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { cardExpired, customerName, invoiceBalance, paymentMethodLabel } from "@crewdesk/shared";
import { db } from "../db";
import { customerPaymentMethods, customers, invoicePayments, invoices } from "../db/schema";
import { HttpError } from "./errors";
import { companyToday } from "./payRates";
import { applyPaymentIntent, stripeCustomerId, stripeFor } from "./stripe";
import { recordAutomationEvent } from "./automationEvents";

/**
 * Cards and bank accounts on file. Customers save them in the portal (a card or bank account, or
 * "save for next time" when paying); the office can add a card while on the phone. The details
 * stay at Stripe; Crewdesk keeps Stripe's id and what to show. They're used to charge an invoice
 * from the office, and for autopay (charging the default one when an invoice is sent).
 */

type Row = typeof customerPaymentMethods.$inferSelect;

/** What a Stripe payment method shows as (type, brand, last 4, expiry, bank). */
function details(pm: Stripe.PaymentMethod) {
  if (pm.type === "us_bank_account" && pm.us_bank_account) {
    return { type: "ach", brand: null, last4: pm.us_bank_account.last4 ?? null, expMonth: null, expYear: null, bankName: pm.us_bank_account.bank_name ?? null, accountType: pm.us_bank_account.account_type ?? null };
  }
  if (pm.type === "card" && pm.card) {
    return { type: "card", brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year, bankName: null, accountType: null };
  }
  return null;
}

/** For API responses: the saved method with its label. */
export const methodView = (r: Row, today?: string) => ({
  id: r.id, type: r.type, brand: r.brand, last4: r.last4, expMonth: r.expMonth, expYear: r.expYear, bankName: r.bankName, accountType: r.accountType,
  isDefault: r.isDefault, addedBy: r.addedBy, createdAt: r.createdAt, label: paymentMethodLabel(r), expired: today ? cardExpired(r, today) : false,
});

export async function methodsFor(customerId: string) {
  return db.select().from(customerPaymentMethods).where(eq(customerPaymentMethods.customerId, customerId))
    .orderBy(desc(customerPaymentMethods.isDefault), asc(customerPaymentMethods.createdAt));
}

/** Saves (or refreshes) a method Stripe has attached to the customer; the first one becomes the default. */
export async function saveMethod(companyId: string, customerId: string, pm: Stripe.PaymentMethod, addedBy: "customer" | "office") {
  const d = details(pm);
  if (!d) return null;
  return db.transaction(async (tx) => {
    const others = await tx.select({ id: customerPaymentMethods.id }).from(customerPaymentMethods)
      .where(and(eq(customerPaymentMethods.customerId, customerId), eq(customerPaymentMethods.isDefault, true), ne(customerPaymentMethods.stripePaymentMethodId, pm.id)));
    const [row] = await tx.insert(customerPaymentMethods)
      .values({ ...d, companyId, customerId, stripePaymentMethodId: pm.id, addedBy, isDefault: others.length === 0 })
      .onConflictDoUpdate({ target: customerPaymentMethods.stripePaymentMethodId, set: d })
      .returning();
    return row;
  });
}

/** Starts saving a card (office) or a card or bank account (portal): Stripe's form, in "save" mode. */
export async function startSetup(companyId: string, customerId: string, who: "customer" | "office") {
  const { cfg, stripe } = await stripeFor(companyId);
  const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!c) throw new HttpError(404, "Customer not found");
  const si = await stripe.setupIntents.create({
    customer: await stripeCustomerId(stripe, c), usage: "off_session",
    // Bank accounts need the customer's own authorization, so only they can add one (in the portal).
    allowed_payment_method_types: who === "office" ? ["card"] : ["card", "us_bank_account"],
    description: `Saved for payments to ${cfg.companyName}`,
    metadata: { crewdeskCompanyId: companyId, crewdeskCustomerId: c.id, addedBy: who },
  });
  return { clientSecret: si.client_secret, publishableKey: cfg.publishableKey, setupIntentId: si.id };
}

/** After Stripe's form (or from the webhook): saves the method if the setup went through. */
export async function finishSetup(companyId: string, setupIntentId: string, customerId?: string) {
  const { stripe } = await stripeFor(companyId);
  const si = await stripe.setupIntents.retrieve(setupIntentId, { expand: ["payment_method"] });
  if (si.metadata?.crewdeskCompanyId !== companyId || (customerId && si.metadata?.crewdeskCustomerId !== customerId)) throw new HttpError(404, "Not found");
  if (si.status !== "succeeded") return { status: si.status, method: null };
  const pm = si.payment_method as Stripe.PaymentMethod | null;
  if (!pm || typeof pm === "string") return { status: si.status, method: null };
  const row = await saveMethod(companyId, si.metadata.crewdeskCustomerId, pm, si.metadata.addedBy === "office" ? "office" : "customer");
  return { status: si.status, method: row ? methodView(row) : null };
}

async function methodInCompany(companyId: string, customerId: string, id: string) {
  const [m] = await db.select().from(customerPaymentMethods)
    .where(and(eq(customerPaymentMethods.id, id), eq(customerPaymentMethods.customerId, customerId), eq(customerPaymentMethods.companyId, companyId)));
  if (!m) throw new HttpError(404, "Payment method not found");
  return m;
}

/** Removes a saved method (and from Stripe); another one becomes the default. Autopay stops when none are left. */
export async function removeMethod(companyId: string, customerId: string, id: string) {
  const m = await methodInCompany(companyId, customerId, id);
  const { stripe } = await stripeFor(companyId);
  try { await stripe.paymentMethods.detach(m.stripePaymentMethodId); } catch (e) {
    if ((e as { code?: string }).code !== "resource_missing" && !/not attached|No such/i.test((e as Error).message)) throw new HttpError(400, `Stripe couldn't remove it (${(e as Error).message})`);
  }
  await forgetMethod(m);
  return { ok: true };
}

/** Takes a method off the customer here (it's gone from Stripe already). */
export async function forgetMethod(m: Row) {
  await recordAutomationEvent(m.companyId, m.customerId, m.type === "ach" ? "bank_removed" : "card_removed");
  await db.transaction(async (tx) => {
    await tx.delete(customerPaymentMethods).where(eq(customerPaymentMethods.id, m.id));
    const rest = await tx.select().from(customerPaymentMethods).where(eq(customerPaymentMethods.customerId, m.customerId)).orderBy(asc(customerPaymentMethods.createdAt));
    if (!rest.length) await tx.update(customers).set({ autopay: false }).where(eq(customers.id, m.customerId));
    else if (m.isDefault) await tx.update(customerPaymentMethods).set({ isDefault: true }).where(eq(customerPaymentMethods.id, rest[0].id));
  });
}

/** The method was detached in Stripe (dashboard, or the customer's bank): forget it here too. */
export async function methodDetached(companyId: string, stripePaymentMethodId: string) {
  const [m] = await db.select().from(customerPaymentMethods)
    .where(and(eq(customerPaymentMethods.companyId, companyId), eq(customerPaymentMethods.stripePaymentMethodId, stripePaymentMethodId)));
  if (m) await forgetMethod(m);
}

export async function makeDefault(companyId: string, customerId: string, id: string) {
  const m = await methodInCompany(companyId, customerId, id);
  await db.transaction(async (tx) => {
    await tx.update(customerPaymentMethods).set({ isDefault: false }).where(eq(customerPaymentMethods.customerId, customerId));
    await tx.update(customerPaymentMethods).set({ isDefault: true }).where(eq(customerPaymentMethods.id, m.id));
  });
  return { ok: true };
}

/** Turns autopay on (needs a method on file) or off. */
export async function setAutopay(companyId: string, customerId: string, on: boolean) {
  if (on && !(await methodsFor(customerId)).length) throw new HttpError(400, "Save a card or bank account first");
  await db.update(customers).set({ autopay: on, updatedAt: new Date() }).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  return { ok: true, autopay: on };
}

/** Plain words for why Stripe turned a charge down. */
function chargeError(e: unknown): string {
  const err = e as { code?: string; decline_code?: string; message?: string };
  if (err.code === "authentication_required") return "The card's bank wants the customer to approve this payment. Send them the invoice so they can pay it themselves";
  if (err.code === "expired_card") return "The card has expired";
  if (err.decline_code === "insufficient_funds") return "Declined: not enough funds";
  if (err.code === "card_declined") return `Declined by the card's bank${err.decline_code && err.decline_code !== "generic_decline" ? ` (${err.decline_code.replace(/_/g, " ")})` : ""}`;
  return err.message ?? "The charge didn't go through";
}

/**
 * Charges what's still owed on an invoice to a saved card or bank account (the default one unless
 * another is picked). Cards are paid at once; bank payments take about 4 business days to clear.
 */
export async function chargeInvoice(companyId: string, invoiceId: string, o: { methodId?: string; autopay?: boolean } = {}) {
  const { cfg, stripe } = await stripeFor(companyId);
  const [row] = await db.select({ inv: invoices, cust: customers }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!row) throw new HttpError(404, "Invoice not found");
  const { inv, cust } = row;
  if (inv.status === "void") throw new HttpError(400, "That invoice is void");
  if (inv.status === "draft" || inv.number == null) throw new HttpError(400, "Send the invoice before charging it");
  const pending = await db.select().from(invoicePayments).where(and(eq(invoicePayments.invoiceId, inv.id), eq(invoicePayments.status, "pending")));
  const due = invoiceBalance(inv) - pending.reduce((s, p) => s + p.amountCents, 0);
  if (due <= 0) throw new HttpError(400, pending.length ? "A bank payment for this invoice is already on its way" : "Nothing is owed on this invoice");
  if (due < 50) throw new HttpError(400, "Stripe can't charge less than $0.50");
  const methods = await methodsFor(cust.id);
  const m = o.methodId ? methods.find((x) => x.id === o.methodId) : methods.find((x) => x.isDefault) ?? methods[0];
  if (!m) throw new HttpError(400, "There's no card or bank account on file for this customer");
  if (cardExpired(m, await companyToday(companyId))) throw new HttpError(400, `${paymentMethodLabel(m)} has expired`);
  try {
    const pi = await stripe.paymentIntents.create({
      amount: due, currency: "usd", customer: await stripeCustomerId(stripe, cust), payment_method: m.stripePaymentMethodId,
      allowed_payment_method_types: [m.type === "ach" ? "us_bank_account" : "card"], off_session: true, confirm: true,
      description: `Invoice ${inv.number} from ${cfg.companyName}${o.autopay ? " (autopay)" : ""}`,
      metadata: { crewdeskCompanyId: companyId, crewdeskInvoiceId: inv.id, invoiceNumber: String(inv.number), onFile: "1", ...(o.autopay ? { autopay: "1" } : {}) },
      expand: ["payment_method", "latest_charge.balance_transaction"],
    }, { idempotencyKey: `onfile-${inv.id}-${due}-${m.id}-${inv.updatedAt.getTime()}-${pending.length}` });
    const result = await applyPaymentIntent(companyId, pi);
    if (o.autopay) await db.update(invoices).set({ autopayError: null, autopayFailedAt: null }).where(eq(invoices.id, inv.id));
    return { ...result, amountCents: due, method: paymentMethodLabel(m), customer: customerName(cust) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const why = chargeError(e);
    if (o.autopay) await db.update(invoices).set({ autopayError: `${paymentMethodLabel(m)}: ${why}`.slice(0, 300), autopayFailedAt: new Date() }).where(eq(invoices.id, inv.id));
    await recordAutomationEvent(companyId, inv.customerId, "payment_declined", { type: "invoice", id: inv.id });
    throw new HttpError(400, `${paymentMethodLabel(m)}: ${why}`);
  }
}

/**
 * Autopay, right after an invoice is sent: charges the customer's default method if they're on
 * autopay and something is owed. A failure is noted on the invoice (the invoice itself still went).
 */
export async function autopayInvoice(companyId: string, invoiceId: string) {
  const [row] = await db.select({ inv: invoices, autopay: customers.autopay }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!row?.autopay || invoiceBalance(row.inv) <= 0 || row.inv.status === "void") return null;
  try {
    return { ok: true as const, ...(await chargeInvoice(companyId, invoiceId, { autopay: true })) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

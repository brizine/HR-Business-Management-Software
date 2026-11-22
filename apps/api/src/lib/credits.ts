import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { formatMoney, invoiceBalance } from "@crewdesk/shared";
import { creditApplications, customerCredits, invoicePayments, invoices } from "../db/schema";
import type { Tx } from "./crm";
import { HttpError } from "./errors";
import { refreshInvoice } from "./invoices";
import { companyToday } from "./payRates";

/**
 * Customer credit: given once (a missed service, goodwill, a correction, a refund written off),
 * then used on invoices. What isn't used stays on the customer's account. A credit for one
 * property is only used on that property's invoices.
 *
 * Every change here runs in a transaction and takes the customer's credit lock, so two people (or
 * an automatic use when an invoice is sent) can't use the same credit twice.
 */

type Credit = typeof customerCredits.$inferSelect;
type Invoice = typeof invoices.$inferSelect;

const lockCustomer = (tx: Tx, customerId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credits:${customerId}`}))`);

/** CR-1, CR-2… per company. */
export async function nextCreditNumber(tx: Tx, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit-numbers:${companyId}`}))`);
  const [{ n }] = await tx.select({ n: sql<number | null>`max(${customerCredits.number})` }).from(customerCredits).where(eq(customerCredits.companyId, companyId));
  return (n ?? 0) + 1;
}

export const creditLeft = (c: Pick<Credit, "amountCents" | "appliedCents" | "status">) => (c.status === "void" ? 0 : c.amountCents - c.appliedCents);
export const lockCustomerCredit = (tx: Tx, customerId: string) => lockCustomer(tx, customerId);

async function refreshCredit(tx: Tx, creditId: string) {
  const [{ applied }] = await tx.select({ applied: sql<number>`coalesce(sum(${creditApplications.amountCents}), 0)::int` }).from(creditApplications)
    .where(and(eq(creditApplications.creditId, creditId), isNull(creditApplications.removedAt)));
  const [c] = await tx.update(customerCredits).set({ appliedCents: applied }).where(eq(customerCredits.id, creditId)).returning();
  return c;
}

/** What credit can still go on an invoice: what's owed, less bank payments still clearing. */
export async function roomOn(tx: Tx, inv: Invoice) {
  const [{ pending }] = await tx.select({ pending: sql<number>`coalesce(sum(${invoicePayments.amountCents}), 0)::int` }).from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, inv.id), eq(invoicePayments.status, "pending")));
  return invoiceBalance(inv) - pending;
}

const fits = (c: Credit, inv: Invoice) => !c.propertyId || c.propertyId === inv.propertyId;

async function insertApplication(tx: Tx, c: Credit, inv: Invoice, amountCents: number, by: string | null, today: string) {
  const [a] = await tx.insert(creditApplications).values({ companyId: c.companyId, creditId: c.id, invoiceId: inv.id, amountCents, appliedOn: today, createdById: by }).returning();
  await refreshCredit(tx, c.id);
  await refreshInvoice(tx, inv.id);
  return a;
}

/** Uses a credit on one invoice: the amount given, or as much as both allow. */
export async function applyCredit(tx: Tx, companyId: string, creditId: string, invoiceId: string, amountCents: number | undefined, by: string | null, opts: { forPrepayment?: boolean } = {}) {
  const [c0] = await tx.select().from(customerCredits).where(and(eq(customerCredits.id, creditId), eq(customerCredits.companyId, companyId)));
  if (!c0) throw new HttpError(404, "Credit not found");
  await lockCustomer(tx, c0.customerId);
  const [c] = await tx.select().from(customerCredits).where(eq(customerCredits.id, creditId)).for("update");
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId))).for("update");
  if (!inv) throw new HttpError(404, "Invoice not found");
  if (c.status === "void") throw new HttpError(400, "That credit was voided");
  if (c.prepaymentId && !opts.forPrepayment) throw new HttpError(400, "That's a prepayment's discount; it's used with its prepayment");
  if (inv.customerId !== c.customerId) throw new HttpError(400, "That credit belongs to a different customer");
  if (!fits(c, inv)) throw new HttpError(400, "That credit is for a different property than this invoice");
  if (inv.status === "draft") throw new HttpError(400, "Send the invoice first; credit goes on sent invoices");
  if (inv.status === "void") throw new HttpError(400, "That invoice is void");
  const left = creditLeft(c);
  const room = await roomOn(tx, inv);
  if (left <= 0) throw new HttpError(400, "That credit is used up");
  if (room <= 0) throw new HttpError(400, inv.status === "paid" ? "That invoice is already paid" : "Nothing is left to pay on that invoice (a bank payment may be clearing)");
  const amount = amountCents ?? Math.min(left, room);
  if (amount > left) throw new HttpError(400, `Only ${formatMoney(left)} of that credit is left`);
  if (amount > room) throw new HttpError(400, `Only ${formatMoney(room)} is owed on that invoice`);
  return insertApplication(tx, c, inv, amount, by, await companyToday(companyId, tx as never));
}

/**
 * Uses a customer's open credit on their open invoices, oldest invoice and oldest credit first.
 * Limit it to some invoices (e.g. one just sent) or some credits (e.g. one just added).
 */
export async function autoApplyCredits(tx: Tx, companyId: string, customerId: string, o: { invoiceIds?: string[]; creditIds?: string[]; by: string | null }) {
  await lockCustomer(tx, customerId);
  const credits = (await tx.select().from(customerCredits)
    .where(and(eq(customerCredits.companyId, companyId), eq(customerCredits.customerId, customerId), eq(customerCredits.status, "open"),
      // A prepayment's discount is only used with that prepayment.
      isNull(customerCredits.prepaymentId),
      sql`${customerCredits.appliedCents} < ${customerCredits.amountCents}`, ...(o.creditIds ? [inArray(customerCredits.id, o.creditIds)] : [])))
    .orderBy(asc(customerCredits.issuedOn), asc(customerCredits.number))).filter((c) => creditLeft(c) > 0);
  if (!credits.length) return [];
  const invs = await tx.select().from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.customerId, customerId), inArray(invoices.status, ["sent", "partial"]),
      ...(o.invoiceIds ? [inArray(invoices.id, o.invoiceIds)] : [])))
    .orderBy(asc(invoices.dueDate), asc(invoices.number));
  const today = await companyToday(companyId, tx as never);
  const made: (typeof creditApplications.$inferSelect)[] = [];
  for (const inv0 of invs) {
    for (const c0 of credits) {
      const [c] = await tx.select().from(customerCredits).where(eq(customerCredits.id, c0.id)).for("update");
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, inv0.id)).for("update");
      if (!fits(c, inv) || inv.status === "paid") continue;
      const amount = Math.min(creditLeft(c), await roomOn(tx, inv));
      if (amount > 0) made.push(await insertApplication(tx, c, inv, amount, o.by, today));
    }
  }
  return made;
}

/** Takes credit off an invoice; it goes back on the customer's account. */
export async function removeApplication(tx: Tx, companyId: string, applicationId: string) {
  const [a] = await tx.select().from(creditApplications).where(and(eq(creditApplications.id, applicationId), eq(creditApplications.companyId, companyId)));
  if (!a || a.removedAt) throw new HttpError(404, "That credit isn't on the invoice");
  await tx.update(creditApplications).set({ removedAt: new Date() }).where(eq(creditApplications.id, a.id));
  await refreshCredit(tx, a.creditId);
  await refreshInvoice(tx, a.invoiceId);
  return a;
}

/** Takes all credit off an invoice (it's being voided). Returns the credits touched. */
export async function removeInvoiceCredits(tx: Tx, invoiceId: string) {
  const apps = await tx.select().from(creditApplications).where(and(eq(creditApplications.invoiceId, invoiceId), isNull(creditApplications.removedAt)));
  if (!apps.length) return [];
  await tx.update(creditApplications).set({ removedAt: new Date() }).where(inArray(creditApplications.id, apps.map((a) => a.id)));
  const ids = [...new Set(apps.map((a) => a.creditId))];
  for (const id of ids) await refreshCredit(tx, id);
  await refreshInvoice(tx, invoiceId);
  return ids;
}

/** Voids a credit: it comes off any invoices it was used on (they owe it again). */
export async function voidCredit(tx: Tx, companyId: string, creditId: string, reason: string) {
  const [c] = await tx.select().from(customerCredits).where(and(eq(customerCredits.id, creditId), eq(customerCredits.companyId, companyId)));
  if (!c) throw new HttpError(404, "Credit not found");
  if (c.status === "void") throw new HttpError(400, "It's already void");
  await lockCustomer(tx, c.customerId);
  const apps = await tx.select().from(creditApplications).where(and(eq(creditApplications.creditId, c.id), isNull(creditApplications.removedAt)));
  if (apps.length) await tx.update(creditApplications).set({ removedAt: new Date() }).where(inArray(creditApplications.id, apps.map((a) => a.id)));
  const [u] = await tx.update(customerCredits).set({ status: "void", voidedAt: new Date(), voidReason: reason, appliedCents: 0 }).where(eq(customerCredits.id, c.id)).returning();
  for (const invId of new Set(apps.map((a) => a.invoiceId))) await refreshInvoice(tx, invId);
  return u;
}

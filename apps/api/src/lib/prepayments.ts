import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { formatMoney, prepaySplit } from "@crewdesk/shared";
import { customerCredits, invoicePayments, invoices, prepayments } from "../db/schema";
import type { Tx } from "./crm";
import { HttpError } from "./errors";
import { refreshInvoice } from "./invoices";
import { companyToday } from "./payRates";
import { applyCredit, lockCustomerCredit, nextCreditNumber, roomOn, voidCredit } from "./credits";

/**
 * Prepayments: money a customer paid ahead, used on their invoices as they're sent. Each invoice
 * gets a "prepaid" payment for the cash share and, when there's a prepay discount, a credit for the
 * discount share (so the discount is spread over the services it covers). A property's prepayment
 * only pays that property's invoices.
 *
 * Changes run in a transaction under the customer's credit lock (the same lock credits use), so
 * credit and prepayments are never used twice at once.
 */

type Prepayment = typeof prepayments.$inferSelect;

/** PP-1, PP-2… per company. */
export async function nextPrepaymentNumber(tx: Tx, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prepayment-numbers:${companyId}`}))`);
  const [{ n }] = await tx.select({ n: sql<number | null>`max(${prepayments.number})` }).from(prepayments).where(eq(prepayments.companyId, companyId));
  return (n ?? 0) + 1;
}

/** Cash still to use (only once it's paid). */
export const cashLeft = (p: Pick<Prepayment, "status" | "amountCents" | "appliedCents" | "refundedCents">) =>
  p.status === "open" ? Math.max(0, p.amountCents - p.appliedCents - p.refundedCents) : 0;
/** Discount still to give with it (none once reversed). */
export const discountLeft = (p: Pick<Prepayment, "status" | "discountCents" | "appliedDiscountCents" | "discountReversed">) =>
  p.status === "open" && !p.discountReversed ? Math.max(0, p.discountCents - p.appliedDiscountCents) : 0;

/** Re-adds what it has paid (prepaid payments) and the discount it has given (its credits). */
export async function refreshPrepayment(tx: Tx, prepaymentId: string) {
  const [{ applied }] = await tx.select({ applied: sql<number>`coalesce(sum(${invoicePayments.amountCents} - ${invoicePayments.refundedCents}), 0)::int` }).from(invoicePayments)
    .where(and(eq(invoicePayments.prepaymentId, prepaymentId), eq(invoicePayments.status, "completed")));
  const [{ disc }] = await tx.select({ disc: sql<number>`coalesce(sum(${customerCredits.appliedCents}), 0)::int` }).from(customerCredits)
    .where(and(eq(customerCredits.prepaymentId, prepaymentId), eq(customerCredits.status, "open")));
  const [p] = await tx.update(prepayments).set({ appliedCents: applied, appliedDiscountCents: disc }).where(eq(prepayments.id, prepaymentId)).returning();
  return p;
}

/**
 * Uses a customer's paid prepayments on their open invoices, oldest invoice and oldest prepayment
 * first. Returns the payments and credits made, for the Bigcapital sync.
 */
export async function applyPrepayments(tx: Tx, companyId: string, customerId: string, o: { invoiceIds?: string[]; prepaymentIds?: string[]; by: string | null }) {
  const made = { paymentIds: [] as string[], creditIds: [] as string[] };
  await lockCustomerCredit(tx, customerId);
  const pps = (await tx.select().from(prepayments)
    .where(and(eq(prepayments.companyId, companyId), eq(prepayments.customerId, customerId), eq(prepayments.status, "open"), ...(o.prepaymentIds ? [inArray(prepayments.id, o.prepaymentIds)] : [])))
    .orderBy(asc(prepayments.receivedOn), asc(prepayments.number))).filter((p) => cashLeft(p) > 0);
  if (!pps.length) return made;
  const invs = await tx.select().from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.customerId, customerId), inArray(invoices.status, ["sent", "partial"]), ...(o.invoiceIds ? [inArray(invoices.id, o.invoiceIds)] : [])))
    .orderBy(asc(invoices.dueDate), asc(invoices.number));
  const today = await companyToday(companyId, tx as never);
  for (const inv0 of invs) {
    for (const p0 of pps) {
      const [p] = await tx.select().from(prepayments).where(eq(prepayments.id, p0.id)).for("update");
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, inv0.id)).for("update");
      if ((p.propertyId && p.propertyId !== inv.propertyId) || inv.status === "paid" || cashLeft(p) <= 0) continue;
      const { cashCents, discountCents } = prepaySplit(await roomOn(tx, inv), cashLeft(p), discountLeft(p));
      if (cashCents <= 0) continue;
      const [pay] = await tx.insert(invoicePayments).values({
        companyId, invoiceId: inv.id, customerId, amountCents: cashCents, method: "prepaid", receivedOn: today, status: "completed",
        prepaymentId: p.id, note: `Prepayment PP-${p.number}`, recordedById: o.by,
      }).returning();
      made.paymentIds.push(pay.id);
      await refreshInvoice(tx, inv.id);
      if (discountCents > 0) {
        const [c] = await tx.insert(customerCredits).values({
          companyId, number: await nextCreditNumber(tx, companyId), customerId, propertyId: inv.propertyId, amountCents: discountCents, reason: "prepay_discount",
          description: `Prepay discount (PP-${p.number})`, issuedOn: today, prepaymentId: p.id, createdById: o.by,
        }).returning();
        await applyCredit(tx, companyId, c.id, inv.id, discountCents, o.by, { forPrepayment: true });
        made.creditIds.push(c.id);
      }
      await refreshPrepayment(tx, p.id);
    }
  }
  return made;
}

/**
 * A prepaid payment taken off an invoice (voided): the cash goes back to the prepayment, and so does
 * the discount it gave that invoice. Returns the credits voided.
 */
export async function returnToPrepayment(tx: Tx, companyId: string, payment: typeof invoicePayments.$inferSelect) {
  if (!payment.prepaymentId) return [];
  const credits = await tx.select().from(customerCredits)
    .where(and(eq(customerCredits.prepaymentId, payment.prepaymentId), eq(customerCredits.status, "open"), sql`exists (select 1 from credit_applications ca where ca.credit_id = ${customerCredits.id} and ca.invoice_id = ${payment.invoiceId} and ca.removed_at is null)`));
  for (const c of credits) await voidCredit(tx, companyId, c.id, "Its prepaid payment was voided");
  await refreshPrepayment(tx, payment.prepaymentId);
  return credits.map((c) => c.id);
}

/**
 * The customer cancelled: the discount given with this prepayment is taken back (its invoices are
 * paid from the prepayment's cash at the full price instead, as far as it goes) and no more discount
 * is given. What's still owed after that shows on the invoices.
 */
export async function reverseDiscount(tx: Tx, companyId: string, prepaymentId: string, by: string | null) {
  const [p] = await tx.select().from(prepayments).where(and(eq(prepayments.id, prepaymentId), eq(prepayments.companyId, companyId)));
  if (!p) throw new HttpError(404, "Prepayment not found");
  if (p.discountReversed) throw new HttpError(400, "Its discount was already taken back");
  if (!p.discountCents) throw new HttpError(400, "This prepayment has no discount");
  if (p.status !== "open" && p.status !== "closed") throw new HttpError(400, "It hasn't been paid yet; void it instead");
  await lockCustomerCredit(tx, p.customerId);
  await tx.update(prepayments).set({ discountReversed: true }).where(eq(prepayments.id, p.id));
  const credits = await tx.select().from(customerCredits).where(and(eq(customerCredits.prepaymentId, p.id), eq(customerCredits.status, "open")));
  const invoiceIds = new Set<string>();
  for (const c of credits) {
    const apps = await tx.execute<{ invoice_id: string }>(sql`select invoice_id from credit_applications where credit_id = ${c.id} and removed_at is null`);
    for (const r of apps.rows) invoiceIds.add(r.invoice_id);
    await voidCredit(tx, companyId, c.id, "Prepay discount taken back (cancelled)");
  }
  await refreshPrepayment(tx, p.id);
  const made = invoiceIds.size ? await applyPrepayments(tx, companyId, p.customerId, { invoiceIds: [...invoiceIds], prepaymentIds: [p.id], by }) : { paymentIds: [], creditIds: [] };
  return { voidedCredits: credits.map((c) => c.id), ...made, discountTakenBackCents: credits.reduce((s, c) => s + c.appliedCents, 0) };
}

/** Records the rest as refunded (the caller has sent the money back) and closes the prepayment. */
export async function closeRefunded(tx: Tx, prepaymentId: string, refundCents: number, reference: string | null) {
  const [p] = await tx.select().from(prepayments).where(eq(prepayments.id, prepaymentId)).for("update");
  const note = [p.note, `Refunded ${formatMoney(refundCents)}${reference ? ` (${reference})` : ""}`].filter(Boolean).join(" · ");
  const [u] = await tx.update(prepayments).set({ refundedCents: p.refundedCents + refundCents, status: "closed", closedAt: new Date(), note }).where(eq(prepayments.id, p.id)).returning();
  return u;
}

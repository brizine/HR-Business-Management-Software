import { WEB_URL } from "./channels";
import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_BILLING_SETTINGS, type BillingSettings } from "@crewdesk/shared";
import { db } from "../db";
import { companies, invoicePayments, invoices } from "../db/schema";
import type { Tx } from "./crm";

export async function billingSettings(companyId: string, tx: Tx = db): Promise<BillingSettings> {
  const [c] = await tx.select({ billing: companies.billing }).from(companies).where(eq(companies.id, companyId));
  return { ...DEFAULT_BILLING_SETTINGS, ...(c?.billing ?? {}) };
}

/**
 * The next invoice number: the settings' next number, or one past the highest used if that's
 * bigger. One at a time per company, so two invoices sent at once never share a number.
 */
export async function takeInvoiceNumber(tx: Tx, companyId: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invoices:${companyId}`}))`);
  const settings = await billingSettings(companyId, tx);
  const [{ max }] = await tx.select({ max: sql<number | null>`max(${invoices.number})` }).from(invoices).where(eq(invoices.companyId, companyId));
  const n = Math.max(settings.nextInvoiceNumber, (max ?? 0) + 1);
  await tx.update(companies).set({ billing: { ...settings, nextInvoiceNumber: n + 1 } }).where(eq(companies.id, companyId));
  return n;
}

/** Re-adds the payments and sets the status: paid, partly paid or unpaid (drafts and void invoices keep theirs). */
export async function refreshInvoice(tx: Tx, invoiceId: string) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return null;
  // Completed payments, less anything refunded.
  const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(${invoicePayments.amountCents} - ${invoicePayments.refundedCents}), 0)::int` }).from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.status, "completed")));
  let status = inv.status;
  if (status !== "draft" && status !== "void") status = paid >= inv.totalCents ? "paid" : paid > 0 ? "partial" : "sent";
  // Paid in full before it went out in the mail: no need to mail it any more.
  const needsMailing = status === "paid" && inv.status !== "paid" ? false : inv.needsMailing;
  const [u] = await tx.update(invoices).set({ paidCents: paid, status, needsMailing, updatedAt: new Date() }).where(eq(invoices.id, invoiceId)).returning();
  return u;
}

export function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Pay links in invoice emails work for this long after the invoice was last sent. */
export const PAY_LINK_DAYS = 30;

/** The invoice's live pay link (for the email and "Copy pay link"), or null once it has expired. */
export function payLinkFor(inv: { payToken: string | null; payTokenExpiresAt: Date | null }) {
  if (!inv.payToken || !inv.payTokenExpiresAt || inv.payTokenExpiresAt < new Date()) return null;
  return { url: `${WEB_URL}/pay/${inv.payToken}`, expiresAt: inv.payTokenExpiresAt.toISOString() };
}

/** The portal's sign-in page for a company's customers. */
export const portalUrl = (companyId: string) => `${WEB_URL}/portal?c=${companyId}`;

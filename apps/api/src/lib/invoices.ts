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
  const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(${invoicePayments.amountCents}), 0)::int` }).from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, invoiceId), eq(invoicePayments.status, "completed")));
  let status = inv.status;
  if (status !== "draft" && status !== "void") status = paid >= inv.totalCents ? "paid" : paid > 0 ? "partial" : "sent";
  const [u] = await tx.update(invoices).set({ paidCents: paid, status, updatedAt: new Date() }).where(eq(invoices.id, invoiceId)).returning();
  return u;
}

export function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

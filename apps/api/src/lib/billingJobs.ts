import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  DEFAULT_BILLING_SETTINGS, customerName, dueLateFeeRules, effectiveSchedule, formatMoney, invoiceBalance, invoiceTotals, lateFeeAmount, sendsOn,
  type LateFeeRule,
} from "@crewdesk/shared";
import { db } from "../db";
import { companies, customers, invoiceLateFees, invoiceLines, invoicePayments, invoices, notificationLog, visits } from "../db/schema";
import { emailTransport } from "./channels";
import { queueBillingSync, syncInvoice } from "./billingSync";
import { billingSettings, PAY_LINK_DAYS, payLinkFor, portalUrl, refreshInvoice } from "./invoices";
import { notify, staffWithRole } from "./notify";
import { stripeConfig } from "./stripe";
import { localParts } from "./tz";
import { HttpError } from "./errors";
import { randomToken } from "./crypto";

/**
 * Billing jobs the scheduler runs: late fees (each step once, the day it comes due) and
 * auto-sending invoices on each customer's schedule.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
async function once(companyId: string, key: string) {
  return (await db.insert(notificationLog).values({ key, companyId }).onConflictDoNothing().returning()).length > 0;
}

/* ── Late fees ── */

/** Recomputes an invoice's totals from its lines (after a late fee is added or waived) and its status. */
async function retotal(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], invoiceId: string) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const t = invoiceTotals(lines, inv.discountKind, inv.discountValue);
  await tx.update(invoices).set({ ...t, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  return refreshInvoice(tx, invoiceId);
}

/**
 * Adds the late fees that have come due: on open invoices that got late fee rules when they were
 * sent, each step once (a "Late fee" line), worked out from the original total. The customer gets an
 * email with the new balance (if the company wants that), and the office a summary.
 */
export async function applyLateFees(now = new Date()) {
  const open = await db.select({ inv: invoices, tz: companies.timezone }).from(invoices).innerJoin(companies, eq(companies.id, invoices.companyId))
    .where(and(inArray(invoices.status, ["sent", "partial"]), isNotNull(invoices.lateFeeRules)));
  const added: Record<string, { invoiceId: string; number: number | null; cents: number; customer: string }[]> = {};
  for (const { inv, tz } of open) {
    const rules = (inv.lateFeeRules ?? []) as LateFeeRule[];
    if (!rules.length) continue;
    const today = localParts(now, tz).date;
    const done = await db.select().from(invoiceLateFees).where(eq(invoiceLateFees.invoiceId, inv.id));
    const due = dueLateFeeRules(rules, inv.sentOn ?? inv.issueDate, today, done.map((d) => d.days));
    if (!due.length) continue;
    // Nothing owed (or a bank payment on its way covers it): no fee.
    const [{ pending }] = await db.select({ pending: sql<number>`coalesce(sum(${invoicePayments.amountCents}), 0)::int` }).from(invoicePayments)
      .where(and(eq(invoicePayments.invoiceId, inv.id), eq(invoicePayments.status, "pending")));
    if (invoiceBalance(inv) - pending <= 0) continue;
    const original = inv.totalCents - done.filter((d) => !d.waivedAt).reduce((s, d) => s + d.amountCents, 0);
    let addedHere = 0;
    for (const rule of due) {
      const cents = lateFeeAmount(rule, original);
      const made = await db.transaction(async (tx) => {
        await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, inv.id)).for("update");
        const [row] = await tx.insert(invoiceLateFees).values({ companyId: inv.companyId, invoiceId: inv.id, days: rule.days, amountCents: Math.max(0, cents) })
          .onConflictDoNothing().returning();
        if (!row || cents <= 0) return false;
        const [{ last }] = await tx.select({ last: sql<number>`coalesce(max(${invoiceLines.sortOrder}), -1)::int` }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
        const [line] = await tx.insert(invoiceLines).values({
          invoiceId: inv.id, description: `Late fee: ${rule.days} days after the invoice was sent`, quantity: 1, unitPriceCents: cents, amountCents: cents,
          incomeAccountCode: "4950", taxRate: 0, isLateFee: true, sortOrder: last + 1,
        }).returning();
        await tx.update(invoiceLateFees).set({ lineId: line.id }).where(eq(invoiceLateFees.id, row.id));
        await retotal(tx, inv.id);
        return true;
      });
      if (made) addedHere += cents;
    }
    if (!addedHere) continue;
    queueBillingSync(() => syncInvoice(inv.companyId, inv.id));
    const [cust] = await db.select().from(customers).where(eq(customers.id, inv.customerId));
    (added[inv.companyId] ??= []).push({ invoiceId: inv.id, number: inv.number, cents: addedHere, customer: customerName(cust) });
    const settings = await billingSettings(inv.companyId);
    if ((settings.lateFees ?? DEFAULT_BILLING_SETTINGS.lateFees!).emailCustomer && cust.email && cust.delivery.includes("email")) {
      await emailLateFee(inv.id, addedHere).catch((e) => console.error("Late fee email failed:", (e as Error).message));
    }
  }
  for (const [companyId, list] of Object.entries(added)) {
    const total = list.reduce((s, x) => s + x.cents, 0);
    notify(companyId, await staffWithRole(companyId, "manager", "customers"), {
      category: "billing", title: `Late fees added to ${list.length} invoice${list.length === 1 ? "" : "s"} (${formatMoney(total)})`,
      body: list.slice(0, 6).map((x) => `Invoice ${x.number} (${x.customer}): ${formatMoney(x.cents)}`).join("; ") + (list.length > 6 ? "; …" : ""),
      link: { screen: "invoices" },
    });
  }
  return Object.values(added).reduce((s, l) => s + l.length, 0);
}

/** "A late fee was added" email, with the new balance and a pay link. */
async function emailLateFee(invoiceId: string, cents: number) {
  const transport = emailTransport();
  if (!transport) return;
  const [row] = await db.select({ inv: invoices, cust: customers, co: companies }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(companies, eq(companies.id, invoices.companyId)).where(eq(invoices.id, invoiceId));
  if (!row?.cust.email) return;
  const { cust, co } = row;
  let inv = row.inv;
  let payUrl: string | null = null;
  if (await stripeConfig(inv.companyId)) {
    [inv] = await db.update(invoices).set({ payToken: inv.payToken ?? randomToken(24), payTokenExpiresAt: new Date(Date.now() + PAY_LINK_DAYS * 86_400_000) }).where(eq(invoices.id, inv.id)).returning();
    payUrl = payLinkFor(inv)?.url ?? null;
  }
  const balance = formatMoney(invoiceBalance(inv));
  const text = [`Hello ${customerName(cust)},`, "", `A late fee of ${formatMoney(cents)} was added to invoice ${inv.number}, which is past due. The balance is now ${balance}.`, "",
    payUrl ? `Pay online (card or bank account): ${payUrl}` : `See and pay your invoices at ${portalUrl(inv.companyId)}`, "",
    `Already paid? Thank you, and please ignore this. Questions? Just reply${co.phone ? ` or call ${co.phone}` : ""}.`, "", co.name].join("\n");
  const html = `<p>Hello ${esc(customerName(cust))},</p><p>A late fee of <strong>${formatMoney(cents)}</strong> was added to invoice ${inv.number}, which is past due. The balance is now <strong>${balance}</strong>.</p>
${payUrl ? `<p><a href="${esc(payUrl)}" style="display:inline-block;background:#1f7a3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Pay online</a></p>` : `<p>See and pay your invoices at <a href="${esc(portalUrl(inv.companyId))}">${esc(portalUrl(inv.companyId))}</a>.</p>`}
<p>Already paid? Thank you, and please ignore this. Questions? Just reply${co.phone ? ` or call ${esc(co.phone)}` : ""}.</p><p>${esc(co.name)}</p>`;
  await transport.send({ to: cust.email!, subject: `Late fee added: invoice ${inv.number} from ${co.name}`, text, html, fromName: co.name, replyTo: co.email ?? undefined });
}

/** The office takes a late fee off (the line goes; it won't be added again). */
export async function waiveLateFee(companyId: string, invoiceId: string, feeId: string, by: string) {
  const [fee] = await db.select().from(invoiceLateFees).where(and(eq(invoiceLateFees.id, feeId), eq(invoiceLateFees.invoiceId, invoiceId), eq(invoiceLateFees.companyId, companyId)));
  if (!fee) return null;
  if (fee.waivedAt) return fee;
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (inv.status === "void") throw new HttpError(400, "This invoice is void");
    if (inv.totalCents - fee.amountCents < inv.paidCents + inv.creditedCents)
      throw new HttpError(400, "The customer already paid this fee. To give it back, refund the payment or add a credit");
    if (fee.lineId) await tx.delete(invoiceLines).where(eq(invoiceLines.id, fee.lineId));
    await tx.update(invoiceLateFees).set({ waivedAt: new Date(), waivedById: by, lineId: null }).where(eq(invoiceLateFees.id, fee.id));
    await retotal(tx, invoiceId);
  });
  queueBillingSync(() => syncInvoice(companyId, invoiceId, by));
  return fee;
}

/* ── Auto-sending invoices ── */

/**
 * Once a day per company, from the hour it picked: for each customer whose schedule says today,
 * turn their finished work orders into invoices (if the company wants that) and send their draft
 * invoices the way they get invoices (email and/or paper). The office gets a summary.
 */
export async function runAutoSend(now = new Date()) {
  const rows = await db.select({ id: companies.id, tz: companies.timezone, billing: companies.billing, testOf: companies.testOfCompanyId }).from(companies)
    .where(or(sql`(${companies.billing}->'autoSend'->>'enabled')::boolean is true`, sql`exists (select 1 from customers c where c.company_id = ${companies.id} and c.auto_send_mode = 'custom')`));
  let sent = 0;
  for (const co of rows) {
    const settings = { ...DEFAULT_BILLING_SETTINGS.autoSend!, ...(co.billing?.autoSend ?? {}) };
    const local = localParts(now, co.tz);
    if (local.minutes < settings.hour * 60) continue;
    const custs = await db.select().from(customers).where(and(eq(customers.companyId, co.id), or(eq(customers.autoSendMode, "custom"), settings.enabled ? eq(customers.autoSendMode, "default") : sql`false`)));
    const due = custs.filter((c) => (!c.sample || co.testOf) && (() => { const s = effectiveSchedule(settings, c.autoSendMode, c.autoSendSchedule); return !!s && sendsOn(s, local.date); })());
    if (!due.length || !(await once(co.id, `autosend:${co.id}:${local.date}`))) continue;
    sent += await sendFor(co.id, due, settings.invoiceWorkOrders);
  }
  return sent;
}

async function sendFor(companyId: string, due: (typeof customers.$inferSelect)[], invoiceWorkOrders: boolean) {
  const { invoiceVisitsFor } = await import("../routes/visits");
  const { sendInvoice } = await import("../routes/invoices");
  const ids = due.map((c) => c.id);
  const problems: string[] = [];
  if (invoiceWorkOrders) {
    // Finished work orders with line items that aren't on a live invoice yet.
    const done = await db.select({ id: visits.id, customerId: visits.customerId }).from(visits)
      .where(and(inArray(visits.customerId, ids), eq(visits.status, "completed"), eq(visits.billing, "invoice"),
        or(isNull(visits.invoiceId), sql`exists (select 1 from invoices i where i.id = ${visits.invoiceId} and i.status = 'void')`),
        sql`exists (select 1 from visit_lines l where l.visit_id = ${visits.id})`));
    for (const cid of new Set(done.map((v) => v.customerId))) {
      try { await invoiceVisitsFor(companyId, null, done.filter((v) => v.customerId === cid).map((v) => v.id)); } catch (e) {
        problems.push(`${customerName(due.find((c) => c.id === cid)!)}: ${(e as Error).message}`);
      }
    }
  }
  const drafts = await db.select().from(invoices).where(and(eq(invoices.companyId, companyId), inArray(invoices.customerId, ids), eq(invoices.status, "draft"))).orderBy(asc(invoices.createdAt));
  let sent = 0, cents = 0;
  for (const inv of drafts) {
    const c = due.find((x) => x.id === inv.customerId)!;
    if (inv.totalCents <= 0) continue;
    const email = c.delivery.includes("email") && !!c.email;
    const via = [...(email ? ["email" as const] : []), ...(c.delivery.includes("paper") || !email ? ["paper" as const] : [])];
    try {
      await sendInvoice(companyId, inv.id, { via }, null, { auto: true });
      sent++; cents += inv.totalCents;
    } catch (e) {
      problems.push(`${customerName(c)}: ${(e as Error).message}`);
    }
  }
  if (sent || problems.length) {
    notify(companyId, await staffWithRole(companyId, "manager", "customers"), {
      category: "billing",
      title: sent ? `Sent ${sent} invoice${sent === 1 ? "" : "s"} automatically (${formatMoney(cents)})` : "Some invoices couldn't be sent automatically",
      body: problems.length ? `Not sent: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; …" : ""}` : "On their customers' auto-send schedules.",
      link: { screen: "invoices" },
    });
  }
  return sent;
}

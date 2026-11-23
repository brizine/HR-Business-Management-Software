import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
  customerName, depositCents, depositRuleFor, describeDepositRule, estimateTotals, formatMoney, splitIncome, type EstimateResponse,
} from "@crewdesk/shared";
import { db } from "../db";
import { customers, estimateLines, estimates, invoices, prepayments } from "../db/schema";
import type { Tx } from "./crm";
import { HttpError } from "./errors";
import { billingSettings } from "./invoices";
import { notify, staffWithRole } from "./notify";
import { nextPrepaymentNumber } from "./prepayments";
import { startPrepaymentPayment, stripeConfig } from "./stripe";
import { randomToken } from "./crypto";

/**
 * An estimate's answer (accepted with the options chosen, declined, or changes asked for) and its
 * deposit: when one is needed the customer pays it online as they accept (a prepayment on their
 * account), and the estimate is accepted once it's paid.
 */

type Estimate = typeof estimates.$inferSelect;
type Line = typeof estimateLines.$inferSelect;
const AREA = "customers" as const;

export const chosenSet = (e: Pick<Estimate, "chosenLineIds" | "respondedAt" | "status">) => (e.status === "accepted" && e.chosenLineIds ? new Set(e.chosenLineIds) : null);

export async function updateTotals(tx: Tx, id: string, lines: Line[], discountPercent: number, chosen: Set<string> | null) {
  const t = estimateTotals(lines, discountPercent, chosen);
  await tx.update(estimates).set({ subtotalCents: t.subtotalCents, discountCents: t.discountCents, taxCents: t.taxCents, totalCents: t.totalCents, updatedAt: new Date() }).where(eq(estimates.id, id));
}

/** The optional lines they ticked that are really on it, and the total with them. */
async function choice(e: Estimate, selectedLineIds: string[]) {
  const lines = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id));
  const optionalIds = new Set(lines.filter((l) => l.optional).map((l) => l.id));
  const chosen = selectedLineIds.filter((id) => optionalIds.has(id));
  return { lines, chosen, totalCents: estimateTotals(lines, e.discountPercent, new Set(chosen)).totalCents };
}

/** A customer with no sent invoices yet counts as new. */
async function isNewCustomer(customerId: string) {
  const [x] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.customerId, customerId), isNotNull(invoices.number), ne(invoices.status, "void"))).limit(1);
  return !x;
}

/** The deposit rule for this estimate (or null), and its latest deposit prepayment. */
export async function depositFor(e: Estimate) {
  const settings = await billingSettings(e.companyId);
  const rule = depositRuleFor(settings.estimateDeposit, e, await isNewCustomer(e.customerId));
  const [pp] = await db.select().from(prepayments).where(and(eq(prepayments.estimateId, e.id), ne(prepayments.status, "void"))).orderBy(desc(prepayments.createdAt)).limit(1);
  return { rule, prepayment: pp ?? null };
}

/** For the estimate's page (office and customer): the rule, what it comes to, and whether it's paid. */
export async function depositView(e: Estimate, totalCents: number) {
  const { rule, prepayment: pp } = await depositFor(e);
  const paid = !!pp && ["open", "pending", "closed"].includes(pp.status);
  // Paid, or asked for (with what they chose): its own amount. Otherwise what it comes to now.
  const cents = paid || pp?.status === "requested" ? pp!.amountCents : depositCents(rule, totalCents);
  if (!rule && !pp) return null;
  return {
    rule, words: rule ? describeDepositRule(rule) : null, cents,
    status: paid ? (pp!.status === "pending" ? "clearing" : "paid") : pp?.status === "requested" ? "requested" : cents > 0 ? "due" : "none",
    prepayment: pp ? { id: pp.id, number: pp.number, status: pp.status, amountCents: pp.amountCents, receivedOn: pp.receivedOn, methodDetail: pp.methodDetail } : null,
    online: !!(await stripeConfig(e.companyId)),
  };
}

/**
 * Records an answer (the customer's online, or one the office took by phone): accepted (with the
 * optional lines chosen), declined, or changes requested. The office is told when it's the customer.
 */
export async function recordResponse(e: Estimate, r: EstimateResponse, by: { customer: true } | { employeeId: string }, o: { depositPaid?: { cents: number; number: number }; depositDue?: number } = {}) {
  const { lines, chosen: picked } = await choice(e, r.selectedLineIds);
  const chosen = r.action === "accept" ? picked : null;
  const status = r.action === "accept" ? "accepted" : r.action === "decline" ? "declined" : "changes";
  const [u] = await db.update(estimates).set({
    status, respondedAt: new Date(), responseName: r.name ?? null, responseComment: r.comment ?? null, chosenLineIds: chosen,
    respondedBy: "customer" in by ? "customer" : "office", respondedById: "employeeId" in by ? by.employeeId : null, pendingResponse: null, updatedAt: new Date(),
  }).where(eq(estimates.id, e.id)).returning();
  await updateTotals(db, u.id, lines, u.discountPercent, chosen ? new Set(chosen) : null);
  if ("customer" in by) {
    const [cust] = await db.select().from(customers).where(eq(customers.id, e.customerId));
    const [fresh] = await db.select().from(estimates).where(eq(estimates.id, e.id));
    const who = customerName(cust);
    const words = status === "accepted" ? `accepted (${formatMoney(fresh.totalCents)})` : status === "declined" ? "declined" : "asked for changes to";
    const deposit = o.depositPaid ? ` and paid a ${formatMoney(o.depositPaid.cents)} deposit (PP-${o.depositPaid.number})` : "";
    const managers = await staffWithRole(e.companyId, "manager", AREA);
    const body = [
      r.comment ? `"${r.comment.slice(0, 200)}"` : null,
      o.depositDue ? `A ${formatMoney(o.depositDue)} deposit is due. Online payments aren't set up, so collect it (add a prepayment on their page).` : null,
      !r.comment && !o.depositDue ? (status === "accepted" ? "Make it a work order or an invoice from the estimate." : "Open the estimate to follow up.") : null,
    ].filter(Boolean).join(" ");
    notify(e.companyId, [...managers, e.createdById], {
      category: "estimates", title: `${who} ${words} estimate ${e.number}${deposit}`, body, link: { screen: "estimate", id: e.id },
    });
  }
  return u;
}

/** The deposit the customer would pay to accept with these options (0: none needed). */
export async function depositNeeded(e: Estimate, selectedLineIds: string[]) {
  const { rule, prepayment } = await depositFor(e);
  const paid = !!prepayment && ["open", "pending", "closed"].includes(prepayment.status);
  if (paid) return { cents: 0, rule, prepayment, paid };
  const { totalCents, lines, chosen } = await choice(e, selectedLineIds);
  return { cents: depositCents(rule, totalCents), rule, prepayment, paid, lines, chosen };
}

/**
 * The customer accepts and pays the deposit: keeps what they chose, makes (or updates) the deposit
 * prepayment, and starts the card or bank payment. Paying it accepts the estimate.
 */
export async function startDeposit(e: Estimate, r: { selectedLineIds: string[]; name: string; comment: string | null }) {
  const need = await depositNeeded(e, r.selectedLineIds);
  if (need.paid) return { accepted: await recordResponse(e, { action: "accept", ...r }, { customer: true }) };
  if (need.cents <= 0) throw new HttpError(400, "No deposit is needed. Accept the estimate instead");
  if (!(await stripeConfig(e.companyId))) throw new HttpError(400, "Online payments aren't set up. Accept the estimate, and we'll contact you about the deposit");
  const values = await depositValues(e, need.cents, need.rule!, need.chosen!);
  const pp = await db.transaction(async (tx) => {
    await tx.update(estimates).set({ pendingResponse: { selectedLineIds: need.chosen!, name: r.name, comment: r.comment }, updatedAt: new Date() }).where(eq(estimates.id, e.id));
    if (need.prepayment?.status === "requested") {
      const [u] = await tx.update(prepayments).set(values).where(eq(prepayments.id, need.prepayment.id)).returning();
      return u;
    }
    const [p] = await tx.insert(prepayments).values({
      ...values, companyId: e.companyId, number: await nextPrepaymentNumber(tx, e.companyId), customerId: e.customerId, propertyId: e.propertyId,
      status: "requested", useNow: false, estimateId: e.id,
    }).returning();
    return p;
  });
  return { payment: await startPrepaymentPayment(e.companyId, pp.id), prepaymentId: pp.id };
}

/** The prepayment values for a deposit of `cents` on what the estimate covers. */
async function depositValues(e: Estimate, cents: number, rule: { kind: "amount" | "percent"; value: number }, chosenIds: string[]) {
  const lines = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, e.id));
  const included = lines.filter((l) => !l.optional || chosenIds.includes(l.id));
  return {
    description: `Deposit for estimate ${e.number}${e.title ? `: ${e.title}` : ""}`.slice(0, 200),
    lines: [{ description: `Deposit (${describeDepositRule(rule)})`, quantity: 1, unitPriceCents: cents }],
    coversCents: cents, discountCents: 0, amountCents: cents,
    income: splitIncome(cents, included.map((l) => [l.incomeAccountCode, l.amountCents] as [string, number])),
  };
}

/** Accepted by phone: a prepay link for the deposit (reusing an unpaid one). */
export async function startDepositLink(e: Estimate, cents: number, by: string, days = 30) {
  const { rule, prepayment } = await depositFor(e);
  const values = { ...(await depositValues(e, cents, rule!, e.chosenLineIds ?? [])), payToken: randomToken(24), payTokenExpiresAt: new Date(Date.now() + days * 86_400_000) };
  return db.transaction(async (tx) => {
    if (prepayment?.status === "requested") {
      const [u] = await tx.update(prepayments).set({ ...values, payToken: prepayment.payToken ?? values.payToken }).where(eq(prepayments.id, prepayment.id)).returning();
      return u;
    }
    const [p] = await tx.insert(prepayments).values({
      ...values, companyId: e.companyId, number: await nextPrepaymentNumber(tx, e.companyId), customerId: e.customerId, propertyId: e.propertyId,
      status: "requested", useNow: false, estimateId: e.id, createdById: by,
    }).returning();
    return p;
  });
}

/** A deposit prepayment was paid (or a bank payment for it started): accept the estimate with what they chose. */
export async function acceptAfterDeposit(prepaymentId: string) {
  const [pp] = await db.select().from(prepayments).where(eq(prepayments.id, prepaymentId));
  if (!pp?.estimateId) return null;
  const [e] = await db.select().from(estimates).where(eq(estimates.id, pp.estimateId));
  if (!e || e.status === "accepted" || !e.pendingResponse) return null;
  const p = e.pendingResponse;
  return recordResponse(e, { action: "accept", selectedLineIds: p.selectedLineIds, name: p.name, comment: p.comment ?? undefined }, { customer: true },
    { depositPaid: { cents: pp.amountCents, number: pp.number } });
}

/** Estimates with a deposit paid, by id (for lists). */
export async function depositsPaid(estimateIds: string[]) {
  if (!estimateIds.length) return new Map<string, number>();
  const rows = await db.select({ id: prepayments.estimateId, cents: prepayments.amountCents }).from(prepayments)
    .where(and(inArray(prepayments.estimateId, estimateIds), inArray(prepayments.status, ["open", "pending", "closed"])));
  return new Map(rows.map((r) => [r.id!, r.cents]));
}

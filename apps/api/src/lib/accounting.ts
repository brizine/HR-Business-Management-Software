import { and, eq } from "drizzle-orm";
import { DEFAULT_ACCOUNTING_SETTINGS, payrollJournalLines, type AccountingSettings, type PostingKind } from "@crewdesk/shared";
import { db } from "../db";
import { accountingPostings, assets, companies, payPeriods, workOrders } from "../db/schema";
import { decrypt } from "./crypto";
import { bigcapital, BigcapitalError } from "./bigcapital";
import { buildPayrollLines } from "./payroll";
import { localParts } from "./tz";

const PURPOSE = "accounting-key-v1";

export async function accountingConfig(companyId: string) {
  const [c] = await db.select({ settings: companies.accounting, key: companies.accountingKey, timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
  const settings: AccountingSettings = { ...DEFAULT_ACCOUNTING_SETTINGS, ...(c?.settings ?? {}) };
  return { settings, hasKey: !!c?.key, key: c?.key ? decrypt(c.key, PURPOSE) : null, timezone: c?.timezone ?? "America/Chicago" };
}
export const ACCOUNTING_KEY_PURPOSE = PURPOSE;

/** A client for the company's Bigcapital, or an error saying what's missing. */
export async function clientFor(companyId: string) {
  const cfg = await accountingConfig(companyId);
  if (!cfg.settings.enabled || !cfg.settings.baseUrl || !cfg.key) throw new BigcapitalError("Connect Bigcapital first (the Accounting page).");
  return { cfg, bc: bigcapital(cfg.settings.baseUrl, cfg.key) };
}

async function record(companyId: string, kind: PostingKind, sourceId: string, r: { status: "posted" | "failed"; externalId?: string | null; amountCents: number; error?: string | null; by?: string | null }) {
  const values = { companyId, kind, sourceId, status: r.status, externalId: r.externalId ?? null, amountCents: r.amountCents, error: r.error ?? null, postedById: r.by ?? null, updatedAt: new Date() };
  const [row] = await db.insert(accountingPostings).values(values).onConflictDoUpdate({ target: [accountingPostings.companyId, accountingPostings.kind, accountingPostings.sourceId], set: values }).returning();
  return row;
}

async function alreadyPosted(companyId: string, kind: PostingKind, sourceId: string) {
  const [p] = await db.select().from(accountingPostings).where(and(eq(accountingPostings.companyId, companyId), eq(accountingPostings.kind, kind), eq(accountingPostings.sourceId, sourceId)));
  return p?.status === "posted" ? p : null;
}

/** Sends an approved pay period to Bigcapital as a journal entry (once). */
export async function postPayPeriod(companyId: string, periodId: string, by: string | null) {
  const done = await alreadyPosted(companyId, "payroll", periodId);
  if (done) return done;
  const [period] = await db.select().from(payPeriods).where(and(eq(payPeriods.id, periodId), eq(payPeriods.companyId, companyId)));
  if (!period) throw new BigcapitalError("Pay period not found");
  let amount = 0;
  try {
    if (period.status !== "approved") throw new BigcapitalError("Approve the pay period first");
    const { cfg, bc } = await clientFor(companyId);
    if (!cfg.settings.wagesAccountId || !cfg.settings.payrollLiabilityAccountId) throw new BigcapitalError("Choose the wages and payroll liability accounts first (the Accounting page).");
    const lines = await buildPayrollLines(db, companyId, { periodStart: period.periodStart, periodEnd: period.periodEnd });
    const j = payrollJournalLines(lines, cfg.settings);
    amount = j.totalCents;
    if (!j.lines.length) throw new BigcapitalError("No hourly wages to post for this period");
    const externalId = await bc.createJournal({
      date: period.periodEnd,
      reference: `Payroll ${period.periodStart} to ${period.periodEnd}`,
      description: `Estimated gross wages from Crewdesk for ${period.periodStart} to ${period.periodEnd} (payday ${period.payday}), before taxes and deductions.${j.salaried ? ` ${j.salaried} salaried ${j.salaried === 1 ? "person is" : "people are"} not included.` : ""}`,
      lines: j.lines,
    });
    return await record(companyId, "payroll", periodId, { status: "posted", externalId, amountCents: amount, by });
  } catch (e) {
    await record(companyId, "payroll", periodId, { status: "failed", amountCents: amount, error: (e as Error).message, by });
    throw e;
  }
}

/** Sends a completed work order's parts and labor to Bigcapital as an expense (once). */
export async function postWorkOrder(companyId: string, workOrderId: string, by: string | null) {
  const done = await alreadyPosted(companyId, "work_order", workOrderId);
  if (done) return done;
  const [row] = await db.select({ wo: workOrders, assetName: assets.name }).from(workOrders).innerJoin(assets, eq(assets.id, workOrders.assetId))
    .where(and(eq(workOrders.id, workOrderId), eq(workOrders.companyId, companyId)));
  if (!row) throw new BigcapitalError("Work order not found");
  const { wo } = row;
  const amount = wo.partsCostCents + wo.laborCostCents;
  try {
    if (wo.status !== "completed") throw new BigcapitalError("Complete the work order first");
    if (!amount) throw new BigcapitalError("This work order has no parts or labor cost");
    const { cfg, bc } = await clientFor(companyId);
    const s = cfg.settings;
    if (!s.partsAccountId || !s.workOrderPaymentAccountId) throw new BigcapitalError("Choose the work order expense and payment accounts first (the Accounting page).");
    const date = localParts(wo.completedAt ?? new Date(), cfg.timezone).date;
    const label = `Work order #${wo.number}: ${row.assetName}, ${wo.title}`;
    const externalId = await bc.createExpense({
      paymentDate: date,
      referenceNo: `WO-${wo.number}`,
      description: `${label}${wo.vendor ? ` (${wo.vendor})` : ""}`,
      paymentAccountId: s.workOrderPaymentAccountId,
      categories: [
        { accountId: s.partsAccountId, amountCents: wo.partsCostCents, description: `Parts: ${label}` },
        { accountId: s.laborAccountId ?? s.partsAccountId, amountCents: wo.laborCostCents, description: `Labor: ${label}` },
      ],
    });
    return await record(companyId, "work_order", workOrderId, { status: "posted", externalId, amountCents: amount, by });
  } catch (e) {
    await record(companyId, "work_order", workOrderId, { status: "failed", amountCents: amount, error: (e as Error).message, by });
    throw e;
  }
}

/** Fire-and-forget for automatic posting (failures are recorded and shown on the Accounting page). */
const pending = new Set<Promise<void>>();
export function autoPost(fn: () => Promise<unknown>) {
  const p: Promise<void> = fn().then(() => {}, () => {}).finally(() => pending.delete(p));
  pending.add(p);
}
/** For tests: wait for automatic posts to finish. */
export const flushAccounting = () => Promise.all([...pending]);

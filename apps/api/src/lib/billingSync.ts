import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { customerName, type PostingKind } from "@crewdesk/shared";
import { db } from "../db";
import { accountingPostings, bigcapitalLinks, companies, customers, invoiceLines, invoicePayments, invoices, serviceTypes } from "../db/schema";
import { accountingConfig } from "./accounting";
import { bigcapital, BigcapitalError, type BigcapitalInvoice } from "./bigcapital";

/**
 * Keeps Bigcapital in step with Crewdesk's billing (see the plan's "Bigcapital sync"):
 * - A customer is created in Bigcapital the first time one of their invoices is sent, then kept up to date.
 * - A sent invoice becomes a Bigcapital sale invoice with the same number; each line goes to its income
 *   account (4000/4100/4200/4950) through a Bigcapital service item. Edits update it; voiding deletes it.
 * - A payment becomes a payment received against that invoice: cash, checks and other payments go to
 *   1020 Undeposited Funds, card and bank payments to 1030 Card Processor Clearing. Voiding deletes it.
 * Accounts are found by code, so the same setup works with the real books and the test books.
 * Bigcapital being down never blocks Crewdesk: each failure is recorded and retried.
 * Sample customers are only ever sent from the test company, so they can't reach the real books.
 */

type Client = ReturnType<typeof bigcapital>;
const dollars = (cents: number) => Math.round(cents) / 100;
const DEPOSIT_CODES: Record<string, string> = { cash: "1020", check: "1020", other: "1020", card: "1030", ach: "1030" };

/* ── Work queue: sync calls for the same company run one after another (no double-creating) ── */

const chains = new Map<string, Promise<unknown>>();
const pending = new Set<Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
  return next;
}

/** Runs a sync in the background (errors are recorded, never thrown at the person who clicked). */
export function queueBillingSync(fn: () => Promise<unknown>) {
  const p = fn().catch((e) => console.error("Bigcapital sync failed:", (e as Error).message));
  pending.add(p);
  p.finally(() => pending.delete(p));
}

/** Waits for queued syncs (tests, and before answering "is it in Bigcapital yet?"). */
export async function flushBillingSync() {
  while (pending.size) await Promise.all([...pending]);
}

/* ── Status records ── */

async function record(companyId: string, kind: PostingKind, sourceId: string, r: { status: "posted" | "failed" | "skipped"; externalId?: string | null; amountCents?: number; error?: string | null; by?: string | null }) {
  const values = { companyId, kind, sourceId, status: r.status, externalId: r.externalId ?? null, amountCents: r.amountCents ?? 0, error: r.error ?? null, postedById: r.by ?? null, updatedAt: new Date() };
  await db.insert(accountingPostings).values(values).onConflictDoUpdate({ target: [accountingPostings.companyId, accountingPostings.kind, accountingPostings.sourceId], set: values });
}

/** The connected Bigcapital client and account ids by code, or null when Bigcapital isn't connected. */
async function connection(companyId: string) {
  const cfg = await accountingConfig(companyId);
  if (!cfg.settings.enabled || !cfg.settings.baseUrl || !cfg.key) return null;
  const bc = bigcapital(cfg.settings.baseUrl, cfg.key);
  let byCode: Map<string, number> | null = null;
  const account = async (code: string) => {
    if (!byCode) byCode = new Map((await bc.accounts()).filter((a) => a.code).map((a) => [a.code!, a.id]));
    const id = byCode.get(code);
    if (!id) throw new BigcapitalError(`Bigcapital has no account with code ${code}. Add it there (or run Set up test books in the test company).`);
    return id;
  };
  return { bc, account };
}
type Conn = NonNullable<Awaited<ReturnType<typeof connection>>>;

async function isTestCompany(companyId: string) {
  const [c] = await db.select({ testOf: companies.testOfCompanyId }).from(companies).where(eq(companies.id, companyId));
  return !!c?.testOf;
}

/* ── Customers ── */

function customerBody(c: typeof customers.$inferSelect) {
  return {
    customerType: c.kind === "residential" ? "individual" as const : "business" as const,
    displayName: customerName(c),
    firstName: c.firstName ?? undefined, lastName: c.lastName ?? undefined, companyName: c.companyName ?? undefined,
    email: c.email ?? undefined, workPhone: c.phone ?? undefined, personalPhone: c.altPhone ?? undefined, code: String(c.number),
    active: c.status !== "cancelled",
    billingAddress1: c.billingStreet ?? undefined, billingAddressCity: c.billingCity ?? undefined, billingAddressState: c.billingState ?? undefined,
    billingAddressPostcode: c.billingZip ?? undefined, billingAddressCountry: c.billingStreet ? "US" : undefined,
  };
}

/** The customer's Bigcapital id, creating them there the first time. */
async function ensureCustomer(conn: Conn, companyId: string, customerId: string): Promise<number> {
  const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!c) throw new BigcapitalError("Customer not found");
  if (c.bigcapitalCustomerId) return c.bigcapitalCustomerId;
  const id = await conn.bc.createCustomer(customerBody(c));
  if (!id) throw new BigcapitalError("Bigcapital didn't return the new customer's id");
  await db.update(customers).set({ bigcapitalCustomerId: Number(id) }).where(eq(customers.id, c.id));
  await record(companyId, "customer", c.id, { status: "posted", externalId: id });
  return Number(id);
}

/** After a customer is edited: update them in Bigcapital (only if they're already there). */
export function syncCustomer(companyId: string, customerId: string) {
  return serialize(companyId, async () => {
    const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
    if (!c?.bigcapitalCustomerId) return;
    const conn = await connection(companyId);
    if (!conn) return;
    try {
      await conn.bc.updateCustomer(String(c.bigcapitalCustomerId), customerBody(c));
      await record(companyId, "customer", c.id, { status: "posted", externalId: String(c.bigcapitalCustomerId) });
    } catch (e) {
      await record(companyId, "customer", c.id, { status: "failed", externalId: String(c.bigcapitalCustomerId), error: (e as Error).message });
    }
  });
}

/* ── Items (one Bigcapital service item per price-list service, plus one for custom lines) ── */

async function ensureItem(conn: Conn, companyId: string, serviceTypeId: string | null, incomeCode: string): Promise<number> {
  const key = serviceTypeId ?? "custom";
  const [link] = await db.select().from(bigcapitalLinks).where(and(eq(bigcapitalLinks.companyId, companyId), eq(bigcapitalLinks.kind, "item"), eq(bigcapitalLinks.localKey, key)));
  if (link) return Number(link.externalId);
  let name = "Services (Crewdesk)", priceCents: number | undefined, description: string | undefined;
  if (serviceTypeId) {
    const [s] = await db.select().from(serviceTypes).where(eq(serviceTypes.id, serviceTypeId));
    if (s) { name = s.name; priceCents = s.pricing === "flat" ? s.priceCents : undefined; description = s.description ?? undefined; incomeCode = s.incomeAccountCode; }
  }
  const sellAccountId = await conn.account(incomeCode);
  let id: string | null = null;
  try {
    id = await conn.bc.createServiceItem({ name, sellAccountId, ...(priceCents != null ? { sellPrice: dollars(priceCents) } : {}), ...(description ? { sellDescription: description } : {}) });
  } catch (e) {
    // Already there by that name (e.g. made by hand): use it.
    if (!(e instanceof BigcapitalError) || !/ITEM_NAME_EXISTS|already exists|exists/i.test(e.message)) throw e;
    id = await conn.bc.findItemByName(name);
  }
  if (!id) throw new BigcapitalError(`Couldn't find or create the Bigcapital item "${name}"`);
  await db.insert(bigcapitalLinks).values({ companyId, kind: "item", localKey: key, externalId: id }).onConflictDoNothing();
  return Number(id);
}

/* ── Invoices ── */

async function invoiceBody(conn: Conn, companyId: string, inv: typeof invoices.$inferSelect, customerBcId: number): Promise<BigcapitalInvoice> {
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.sortOrder));
  const entries: BigcapitalInvoice["entries"] = [];
  for (const [i, l] of lines.entries()) {
    entries.push({
      index: i + 1, itemId: await ensureItem(conn, companyId, l.serviceTypeId, l.incomeAccountCode), rate: dollars(l.unitPriceCents),
      quantity: l.quantity, description: l.description, sellAccountId: await conn.account(l.incomeAccountCode),
    });
  }
  return {
    customerId: customerBcId, invoiceDate: inv.issueDate, dueDate: inv.dueDate, invoiceNo: String(inv.number), delivered: true,
    ...(inv.poNumber ? { referenceNo: inv.poNumber } : {}), ...(inv.notes ? { invoiceMessage: inv.notes } : {}),
    ...(inv.discountCents ? { discount: dollars(inv.discountCents), discountType: "amount" as const } : {}),
    entries,
  };
}

/** Makes Bigcapital match the invoice: created, updated, or (once void) deleted. Returns its status. */
export function syncInvoice(companyId: string, invoiceId: string, by: string | null = null) {
  return serialize(companyId, () => syncInvoiceNow(companyId, invoiceId, by));
}

async function syncInvoiceNow(companyId: string, invoiceId: string, by: string | null): Promise<"posted" | "failed" | "skipped" | "not_connected"> {
  const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)));
  if (!inv || inv.number == null) return "skipped";
  const conn = await connection(companyId);
  if (!conn) return "not_connected";
  try {
    const [cust] = await db.select({ sample: customers.sample }).from(customers).where(eq(customers.id, inv.customerId));
    if (cust?.sample && !(await isTestCompany(companyId))) {
      await record(companyId, "invoice", inv.id, { status: "skipped", amountCents: inv.totalCents, error: "Sample customer: kept out of the real books", by });
      return "skipped";
    }
    if (inv.status === "void") {
      if (inv.bigcapitalInvoiceId) {
        await conn.bc.deleteInvoice(inv.bigcapitalInvoiceId);
        await db.update(invoices).set({ bigcapitalInvoiceId: null }).where(eq(invoices.id, inv.id));
      }
      await record(companyId, "invoice", inv.id, { status: "posted", amountCents: 0, error: null, by });
      return "posted";
    }
    const customerBcId = await ensureCustomer(conn, companyId, inv.customerId);
    const body = await invoiceBody(conn, companyId, inv, customerBcId);
    let externalId = inv.bigcapitalInvoiceId;
    if (externalId) await conn.bc.updateInvoice(externalId, body);
    else {
      externalId = await conn.bc.createInvoice(body);
      if (!externalId) throw new BigcapitalError("Bigcapital didn't return the new invoice's id");
      await db.update(invoices).set({ bigcapitalInvoiceId: externalId }).where(eq(invoices.id, inv.id));
    }
    await record(companyId, "invoice", inv.id, { status: "posted", externalId, amountCents: inv.totalCents, by });
    return "posted";
  } catch (e) {
    await record(companyId, "invoice", inv.id, { status: "failed", externalId: inv.bigcapitalInvoiceId, amountCents: inv.totalCents, error: (e as Error).message, by });
    return "failed";
  }
}

/* ── Payments ── */

/** Makes Bigcapital match the payment (its invoice is sent first if it isn't there yet). */
export function syncPayment(companyId: string, paymentId: string, by: string | null = null) {
  return serialize(companyId, () => syncPaymentNow(companyId, paymentId, by));
}

async function syncPaymentNow(companyId: string, paymentId: string, by: string | null): Promise<"posted" | "failed" | "skipped" | "not_connected"> {
  const [p] = await db.select().from(invoicePayments).where(and(eq(invoicePayments.id, paymentId), eq(invoicePayments.companyId, companyId)));
  if (!p) return "skipped";
  // A bank payment still clearing isn't money in yet; it goes to the books when it clears.
  if (p.status === "pending" && !p.bigcapitalPaymentId) return "skipped";
  const conn = await connection(companyId);
  if (!conn) return "not_connected";
  // What belongs in the books: a completed payment, less anything refunded.
  const net = p.status === "completed" ? p.amountCents - p.refundedCents : 0;
  try {
    if (net <= 0) {
      // Void, failed (the bank returned it) or fully refunded: take it out of the books.
      if (p.bigcapitalPaymentId) {
        await conn.bc.deletePayment(p.bigcapitalPaymentId);
        await db.update(invoicePayments).set({ bigcapitalPaymentId: null }).where(eq(invoicePayments.id, p.id));
      } else if (p.status === "failed") {
        return "skipped";
      }
      await record(companyId, "payment", p.id, { status: "posted", amountCents: 0, error: null, by });
      return "posted";
    }
    if (p.bigcapitalPaymentId) {
      const [posted] = await db.select({ amountCents: accountingPostings.amountCents, status: accountingPostings.status }).from(accountingPostings)
        .where(and(eq(accountingPostings.companyId, companyId), eq(accountingPostings.kind, "payment"), eq(accountingPostings.sourceId, p.id)));
      // Already right (a failed replacement is tried again).
      if (!posted || (posted.status === "posted" && posted.amountCents === net)) return "posted";
      // Part of it was refunded (or a refund failed): replace the Bigcapital payment with one for what's left.
      await conn.bc.deletePayment(p.bigcapitalPaymentId);
      await db.update(invoicePayments).set({ bigcapitalPaymentId: null }).where(eq(invoicePayments.id, p.id));
    }
    let [inv] = await db.select().from(invoices).where(eq(invoices.id, p.invoiceId));
    if (!inv.bigcapitalInvoiceId) {
      const r = await syncInvoiceNow(companyId, inv.id, by);
      if (r === "skipped") { await record(companyId, "payment", p.id, { status: "skipped", amountCents: net, error: "Its invoice isn't sent to Bigcapital (sample customer)", by }); return "skipped"; }
      [inv] = await db.select().from(invoices).where(eq(invoices.id, p.invoiceId));
      if (!inv.bigcapitalInvoiceId) throw new BigcapitalError("Its invoice couldn't be sent to Bigcapital yet");
    }
    const customerBcId = await ensureCustomer(conn, companyId, p.customerId);
    const refundNote = p.refundedCents > 0 ? `${dollarsText(p.amountCents)} paid, ${dollarsText(p.refundedCents)} refunded` : null;
    const externalId = await conn.bc.createPayment({
      customerId: customerBcId, paymentDate: p.receivedOn, depositAccountId: await conn.account(DEPOSIT_CODES[p.method] ?? "1020"),
      ...(p.reference ? { referenceNo: p.method === "check" ? `Check ${p.reference}` : p.reference } : {}),
      statement: [`Invoice ${inv.number}`, p.note, refundNote].filter(Boolean).join(" · "),
      entries: [{ invoiceId: Number(inv.bigcapitalInvoiceId), paymentAmount: dollars(net) }],
    });
    if (!externalId) throw new BigcapitalError("Bigcapital didn't return the new payment's id");
    await db.update(invoicePayments).set({ bigcapitalPaymentId: externalId }).where(eq(invoicePayments.id, p.id));
    await record(companyId, "payment", p.id, { status: "posted", externalId, amountCents: net, by });
    return "posted";
  } catch (e) {
    // Read it again: a step above may already have taken the old payment out of Bigcapital.
    const [now] = await db.select({ bc: invoicePayments.bigcapitalPaymentId }).from(invoicePayments).where(eq(invoicePayments.id, p.id));
    await record(companyId, "payment", p.id, { status: "failed", externalId: now?.bc ?? null, amountCents: net, error: (e as Error).message, by });
    return "failed";
  }
}

const dollarsText = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** An invoice and its payments, now (the "Send to Bigcapital" button). */
export async function syncInvoiceAndPayments(companyId: string, invoiceId: string, by: string | null) {
  const result = await syncInvoice(companyId, invoiceId, by);
  const pays = await db.select({ id: invoicePayments.id }).from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
  for (const p of pays) await syncPayment(companyId, p.id, by);
  return result;
}

/**
 * Scheduled retry (every few minutes): failed syncs, plus sent invoices and payments that never
 * reached Bigcapital (e.g. made while it was disconnected). A few per company per run.
 */
export async function retryBillingSyncs(limit = 25) {
  const stale = new Date(Date.now() - 2 * 60_000);
  const failed = await db.select({ companyId: accountingPostings.companyId, kind: accountingPostings.kind, sourceId: accountingPostings.sourceId }).from(accountingPostings)
    .where(and(inArray(accountingPostings.kind, ["invoice", "payment"]), eq(accountingPostings.status, "failed"), lt(accountingPostings.updatedAt, stale))).limit(limit);
  const neverSent = await db.select({ companyId: invoices.companyId, id: invoices.id }).from(invoices)
    .where(and(isNotNull(invoices.number), isNull(invoices.bigcapitalInvoiceId), sql`${invoices.status} <> 'void'`, lt(invoices.updatedAt, stale),
      sql`not exists (select 1 from accounting_postings ap where ap.source_id = ${invoices.id} and ap.kind = 'invoice')`)).limit(limit);
  const unpaidPayments = await db.select({ companyId: invoicePayments.companyId, id: invoicePayments.id }).from(invoicePayments)
    .where(and(eq(invoicePayments.status, "completed"), isNull(invoicePayments.bigcapitalPaymentId), lt(invoicePayments.createdAt, stale),
      sql`not exists (select 1 from accounting_postings ap where ap.source_id = ${invoicePayments.id} and ap.kind = 'payment')`)).limit(limit);
  let tried = 0;
  for (const f of failed) { tried++; await (f.kind === "invoice" ? syncInvoice(f.companyId, f.sourceId) : syncPayment(f.companyId, f.sourceId)); }
  for (const i of neverSent) { tried++; await syncInvoice(i.companyId, i.id); }
  for (const p of unpaidPayments) { tried++; await syncPayment(p.companyId, p.id); }
  return { tried };
}

/** The sync state of an invoice and its payments, for the invoice page. */
export async function syncStatus(companyId: string, invoiceId: string, paymentIds: string[]) {
  const ids = [invoiceId, ...paymentIds];
  const rows = await db.select().from(accountingPostings).where(and(eq(accountingPostings.companyId, companyId), inArray(accountingPostings.sourceId, ids), inArray(accountingPostings.kind, ["invoice", "payment"])));
  const of = (kind: string, id: string) => rows.find((r) => r.kind === kind && r.sourceId === id) ?? null;
  const cfg = await accountingConfig(companyId);
  return {
    connected: !!(cfg.settings.enabled && cfg.settings.baseUrl && cfg.key),
    invoice: of("invoice", invoiceId) && { status: of("invoice", invoiceId)!.status, error: of("invoice", invoiceId)!.error, at: of("invoice", invoiceId)!.updatedAt },
    payments: Object.fromEntries(paymentIds.map((id) => [id, of("payment", id) && { status: of("payment", id)!.status, error: of("payment", id)!.error }])),
  };
}

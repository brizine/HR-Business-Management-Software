import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  SAMPLE_TEMPLATE_VARS, cleanInvoiceLayout, formatCustomValue, isFieldKey, layoutFieldIds, layoutTags, propertyFieldValues, resolveInvoiceLayout, sameLayout,
  type CustomFieldDef, type CustomValues, type InvoiceLayout, type TemplateVars,
} from "@crewdesk/shared";
import { db } from "../db";
import { customFields, employees, invoiceLayoutVersions, invoiceLayouts, invoices, visits } from "../db/schema";
import { asDef, ensurePropertyFields } from "./customFields";
import { HttpError } from "./errors";
import { billingSettings } from "./invoices";
import type { PdfInvoice } from "./invoicePdf";
import { templateVars } from "./templates";

/**
 * Invoice layouts: the published one every invoice prints in, the draft the editor works on, and
 * the earlier published ones kept so any can be brought back.
 */

/** How many published layouts are kept. */
const KEEP_VERSIONS = 30;
/** Record types whose custom fields can be shown as a detail at the top of the invoice. */
const DETAIL_TARGETS = ["invoice", "customer", "property"] as const;

const mine = async (companyId: string) => (await db.select().from(invoiceLayouts).where(and(eq(invoiceLayouts.companyId, companyId), eq(invoiceLayouts.isDefault, true))))[0];
/** The company's layout row, made the first time something is saved. */
async function ensureRow(companyId: string) {
  await db.insert(invoiceLayouts).values({ companyId }).onConflictDoNothing();
  return (await mine(companyId))!;
}

/** The layout invoices print in now: the published one, else Crewdesk's own with the footer from billing settings. */
export async function invoiceLayoutFor(companyId: string): Promise<InvoiceLayout> {
  const row = await mine(companyId);
  return resolveInvoiceLayout(row?.layout ?? null, row?.layout ? {} : await billingSettings(companyId));
}

/** The custom fields that can be a detail on the invoice, with the record each belongs to. */
async function detailFields(companyId: string): Promise<CustomFieldDef[]> {
  await ensurePropertyFields(companyId);
  const rows = await db.select().from(customFields).where(and(eq(customFields.companyId, companyId), inArray(customFields.appliesTo, [...DETAIL_TARGETS])))
    .orderBy(asc(customFields.appliesTo), asc(customFields.sortOrder), asc(customFields.name));
  return rows.map(asDef);
}

const names = async (ids: (string | null)[]) => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = list.length ? await db.select({ id: employees.id, f: employees.firstName, l: employees.lastName }).from(employees).where(inArray(employees.id, list)) : [];
  return new Map(rows.map((r) => [r.id, `${r.f} ${r.l}`]));
};

/** Everything the editor opens with. */
export async function layoutState(companyId: string) {
  const row = await mine(companyId);
  const published = await invoiceLayoutFor(companyId);
  const versions = row ? await db.select({ id: invoiceLayoutVersions.id, publishedAt: invoiceLayoutVersions.publishedAt, by: invoiceLayoutVersions.publishedById }).from(invoiceLayoutVersions)
    .where(eq(invoiceLayoutVersions.layoutId, row.id)).orderBy(desc(invoiceLayoutVersions.publishedAt)).limit(KEEP_VERSIONS) : [];
  const who = await names([row?.publishedById ?? null, row?.draftById ?? null, ...versions.map((v) => v.by)]);
  return {
    published,
    /** The changes not yet on invoices, if any. */
    draft: row?.draft ? cleanInvoiceLayout(row.draft) : null,
    draftAt: row?.draftAt ?? null, draftBy: row?.draftById ? who.get(row.draftById) ?? null : null,
    /** False until the first Publish: invoices are in Crewdesk's own layout. */
    everPublished: !!row?.layout,
    publishedAt: row?.publishedAt ?? null, publishedBy: row?.publishedById ? who.get(row.publishedById) ?? null : null,
    versions: versions.map((v) => ({ id: v.id, publishedAt: v.publishedAt, by: v.by ? who.get(v.by) ?? null : null })),
    fields: (await detailFields(companyId)).map((f) => ({ key: `cf:${f.id}`, name: f.name, appliesTo: f.appliesTo })),
  };
}

/** A detail can only be one of the company's own fields. */
async function checked(companyId: string, layout: InvoiceLayout): Promise<InvoiceLayout> {
  const ok = new Set((await detailFields(companyId)).map((f) => `cf:${f.id}`));
  return { ...layout, header: { ...layout.header, details: layout.header.details.filter((d) => !isFieldKey(d.key) || ok.has(d.key)) } };
}

/** Keeps the editor's work without touching what invoices print. Work that matches the published layout is no draft at all. */
export async function saveDraft(companyId: string, by: string, raw: InvoiceLayout) {
  const layout = await checked(companyId, raw);
  const row = await ensureRow(companyId);
  const same = sameLayout(layout, await invoiceLayoutFor(companyId));
  await db.update(invoiceLayouts).set(same ? { draft: null, draftAt: null, draftById: null } : { draft: layout, draftAt: new Date(), draftById: by }).where(eq(invoiceLayouts.id, row.id));
}

export async function discardDraft(companyId: string) {
  await db.update(invoiceLayouts).set({ draft: null, draftAt: null, draftById: null }).where(and(eq(invoiceLayouts.companyId, companyId), eq(invoiceLayouts.isDefault, true)));
}

/** Invoices print in this layout from now on. The one it replaces stays in the history. */
export async function publishLayout(companyId: string, by: string, raw: InvoiceLayout) {
  const layout = await checked(companyId, raw);
  const row = await ensureRow(companyId);
  await db.transaction(async (tx) => {
    // The first time, the layout invoices were in until now is kept too, so it can be gone back to.
    if (!row.layout) await tx.insert(invoiceLayoutVersions).values({ companyId, layoutId: row.id, layout: resolveInvoiceLayout(null, await billingSettings(companyId, tx)), publishedAt: row.createdAt, publishedById: null });
    await tx.update(invoiceLayouts).set({ layout, draft: null, draftAt: null, draftById: null, publishedAt: new Date(), publishedById: by }).where(eq(invoiceLayouts.id, row.id));
    await tx.insert(invoiceLayoutVersions).values({ companyId, layoutId: row.id, layout, publishedById: by });
    const keep = (await tx.select({ id: invoiceLayoutVersions.id }).from(invoiceLayoutVersions).where(eq(invoiceLayoutVersions.layoutId, row.id)).orderBy(desc(invoiceLayoutVersions.publishedAt)).limit(KEEP_VERSIONS)).map((v) => v.id);
    await tx.delete(invoiceLayoutVersions).where(and(eq(invoiceLayoutVersions.layoutId, row.id), notInArray(invoiceLayoutVersions.id, keep)));
  });
}

/** An earlier published layout, to open in the editor. */
export async function layoutVersion(companyId: string, versionId: string): Promise<InvoiceLayout> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new HttpError(404, "That version wasn't found");
  const [v] = await db.select({ layout: invoiceLayoutVersions.layout }).from(invoiceLayoutVersions).where(and(eq(invoiceLayoutVersions.id, versionId), eq(invoiceLayoutVersions.companyId, companyId)));
  if (!v) throw new HttpError(404, "That version wasn't found");
  return cleanInvoiceLayout(v.layout);
}

/* ───────────── What a layout needs from an invoice ───────────── */

type Records = {
  invoiceId: string; customerId: string; issueDate: string; createdAt: Date;
  invoiceCustom?: CustomValues | null; customerCustom?: CustomValues | null; property?: Parameters<typeof propertyFieldValues>[1];
};

/**
 * What a customer still owes on the invoices before this one: sent invoices (not drafts or void
 * ones) dated earlier, or the same day and made earlier. Worked out when the invoice is printed,
 * so it goes down as those invoices are paid.
 */
export async function previousBalance(companyId: string, r: Pick<Records, "invoiceId" | "customerId" | "issueDate" | "createdAt">): Promise<number> {
  const [row] = await db.select({ cents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents}), 0)::int` }).from(invoices)
    .where(and(
      eq(invoices.companyId, companyId), eq(invoices.customerId, r.customerId), ne(invoices.id, r.invoiceId), notInArray(invoices.status, ["draft", "void"]),
      sql`(${invoices.issueDate} < ${r.issueDate} or (${invoices.issueDate} = ${r.issueDate} and ${invoices.createdAt} < ${r.createdAt.toISOString()}::timestamptz))`,
    ));
  return Math.max(0, row?.cents ?? 0);
}

/**
 * The extras a layout asks for, looked up only when it shows them: the previous balance, the
 * service dates, the custom fields used as details, and the values for fill-ins in the footer and
 * text blocks.
 */
export async function layoutExtras(companyId: string, layout: InvoiceLayout, r: Records): Promise<Pick<PdfInvoice, "previousBalanceCents" | "serviceDates" | "fields" | "vars">> {
  const out: Pick<PdfInvoice, "previousBalanceCents" | "serviceDates" | "fields" | "vars"> = {};
  if (layout.totals.balance.show) out.previousBalanceCents = await previousBalance(companyId, r);
  if (layout.header.details.some((d) => d.key === "serviceDate" && d.show)) {
    const rows = await db.select({ on: sql<string | null>`coalesce(${visits.date}, (${visits.completedAt} at time zone 'UTC')::date)::text` }).from(visits)
      .where(and(eq(visits.companyId, companyId), eq(visits.invoiceId, r.invoiceId)));
    out.serviceDates = rows.map((x) => x.on).filter((x): x is string => !!x).sort();
  }
  const ids = layoutFieldIds(layout);
  if (ids.length) {
    const defs = (await db.select().from(customFields).where(and(eq(customFields.companyId, companyId), inArray(customFields.id, ids)))).map(asDef);
    out.fields = {};
    for (const f of defs) {
      const values = f.appliesTo === "invoice" ? r.invoiceCustom : f.appliesTo === "customer" ? r.customerCustom : f.appliesTo === "property" ? propertyFieldValues([f], r.property) : null;
      const text = formatCustomValue(f, values?.[f.id]);
      if (text) out.fields[`cf:${f.id}`] = text;
    }
  }
  if (layoutTags(layout).length) out.vars = await templateVars(companyId, { invoiceId: r.invoiceId });
  return out;
}

/* ───────────── The editor's sample invoice ───────────── */

const line = (description: string, quantity: number, unitPriceCents: number, taxRate = 0) => ({ description, quantity, unitPriceCents, amountCents: Math.round(quantity * unitPriceCents), taxRate });

/**
 * A made-up invoice that uses every part of the page (a discount, a credit, a payment, notes, a PO
 * and, when the company charges it, sales tax), for the preview before a real one is picked.
 */
export async function sampleInvoice(companyId: string, layout: InvoiceLayout): Promise<PdfInvoice> {
  const settings = await billingSettings(companyId);
  const rate = settings.taxEnabled ? settings.defaultTaxRate || 8.75 : 0;
  const lines = [
    line("Fertilizer & weed control, round 5", 1, 6500, rate),
    line("Flea & tick yard spray, back lawn only, including the dog run and along the fence where the pets spend their time", 1, 4500, rate),
    line("Core aeration", 1, 9500),
  ];
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0), discountCents = 1000;
  const taxCents = Math.round(lines.filter((l) => l.taxRate).reduce((s, l) => s + l.amountCents, 0) * rate / 100);
  const fields = Object.fromEntries((await detailFields(companyId)).filter((f) => layoutFieldIds(layout).includes(f.id)).map((f) => [`cf:${f.id}`, f.type === "integer" || f.type === "decimal" ? "12" : f.type === "checkbox" ? "Yes" : f.type === "date" ? "11/20/2026" : "Sample"]));
  // The company's own name, phone and so on are real; the customer is made up.
  const own = Object.fromEntries(Object.entries(layoutTags(layout).length ? await templateVars(companyId, {}) : {}).filter(([, v]) => v));
  const vars: TemplateVars = { ...SAMPLE_TEMPLATE_VARS, ...own, CUSTOMER_NAME: "Jane Sample", CUSTOMER_FIRST_NAME: "Jane", CUSTOMER_LAST_NAME: "Sample", INVOICE_NUMBER: "1042" };
  return {
    number: 1042, status: "partial", issueDate: "2026-11-20", dueDate: "2026-12-20", poNumber: "PO-7781", notes: "Gate was locked on the first try, so we came back Thursday.\nPlease leave the side gate unlatched for the winter round.",
    subtotalCents, discountCents, taxCents, taxName: settings.taxName, totalCents: subtotalCents - discountCents + taxCents, paidCents: 5000, termsDays: 30,
    creditedCents: 2000, credits: [{ number: 12, amountCents: 2000 }],
    customerName: "Jane Sample", customerNumber: 1007, billTo: ["12 Sample St", "Norman, OK 73069"], serviceAddress: "12 Sample St, Norman, OK 73069",
    lines, payOnline: "your-portal.example/pay", serviceDates: ["2026-11-18", "2026-11-19"], previousBalanceCents: 4000, fields, vars, layout,
  };
}

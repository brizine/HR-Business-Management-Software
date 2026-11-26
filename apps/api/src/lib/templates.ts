import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import {
  DESIGN_CSS, EMPTY_TEMPLATE_DEFAULTS, MESSAGE_KINDS, PAYMENT_METHOD_LABELS, SYSTEM_TEMPLATES, beeToDesign, customerName, designHasContent, fillTags, formatAddress, formatMoney, formatPhone,
  htmlToDesign, htmlToText, isDesignedBody, renderDesign, withSavedRows,
  type EmailDesign, type MessageKind, type PaymentMethod, type Row, type SavedRow, type TemplateDefaults, type TemplateVars,
} from "@crewdesk/shared";
import { db } from "../db";
import { assets, companies, customerNotes, customers, emailSavedRows, employees, estimates, invoicePayments, invoices, properties, propertyAssignments, templates, todos, visitAssignees, visits, workOrders } from "../db/schema";
import { PUBLIC_API_URL, WEB_URL, emailTransport, type EmailMessage } from "./channels";
import { customerUnsubscribeToken } from "./customerMessages";
import { payLinkFor, portalUrl } from "./invoices";
import { stripeConfig } from "./stripe";
import { sendCustomerText } from "./texting";
import { localParts } from "./tz";

export type TemplateRow = typeof templates.$inferSelect;

/* ───────────── Cleaning what's saved ───────────── */

/** An email body as saved: formatting, lists and links only (no scripts, styles or outside images). */
export function cleanEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "hr"],
    allowedAttributes: { a: ["href", "target", "rel"], p: ["style"], h1: ["style"], h2: ["style"], h3: ["style"], li: ["style"] },
    allowedStyles: { "*": { "text-align": [/^(left|right|center|justify)$/] } },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    // {{TAG}} as a link address is filled in when sent.
    allowedSchemesAppliedToAttributes: ["href"],
    transformTags: { h1: "h2", b: "strong", i: "em" },
    exclusiveFilter: (f) => f.tag === "a" && !f.attribs.href,
  }).replace(/href="%7B%7B([A-Z0-9_]+)%7D%7D"/g, 'href="{{$1}}"').trim();
}

/* ───────────── Designs (emails made in the builder) ───────────── */

const SAFE_COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)$/, /^transparent$/];
const tagHrefs = (html: string) => html.replace(/href="%7B%7B([A-Z0-9_]+)%7D%7D"/g, 'href="{{$1}}"');
/** The words in a title, paragraph or list block: formatting, colours and links only. */
function cleanBlockText(html: string): string {
  return tagHrefs(sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "strike", "sup", "sub", "span", "a", "ul", "ol", "li", "font"],
    allowedAttributes: { a: ["href"], span: ["style"], p: ["style"], li: ["style"], font: ["color"] },
    allowedStyles: { "*": {
      color: SAFE_COLOR, "background-color": SAFE_COLOR, "font-weight": [/^(bold|normal|[1-9]00)$/], "font-style": [/^(italic|normal)$/], "font-size": [/^\d{1,2}px$/],
      "text-decoration": [/^(underline|line-through|none)( (underline|line-through))?$/], "text-decoration-line": [/^(underline|line-through|none)( (underline|line-through))?$/], "text-align": [/^(left|right|center|justify)$/],
    } },
    allowedSchemes: ["http", "https", "mailto", "tel"], allowedSchemesAppliedToAttributes: ["href"],
    exclusiveFilter: (f) => f.tag === "a" && !f.attribs.href,
  })).trim();
}
/** An HTML block ("HTML experts only"): tables, pictures and inline styles are fine; anything that runs isn't. */
function cleanRawHtml(html: string): string {
  return tagHrefs(sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "center", "font", "u", "s"],
    allowedAttributes: {
      "*": ["style", "align", "valign", "width", "height", "bgcolor", "dir"], a: ["href", "target", "title"], img: ["src", "alt", "width", "height", "border"],
      table: ["cellpadding", "cellspacing", "border", "role"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], font: ["color", "face", "size"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"], allowedSchemesByTag: { img: ["http", "https"] },
  })).replace(/(position\s*:\s*(fixed|sticky|absolute)|expression\s*\(|behavior\s*:|javascript:|@import)/gi, "").trim();
}
/** A design as saved: every block's words cleaned (the settings are read safely when it's turned into an email). */
export function cleanDesign(d: EmailDesign): EmailDesign {
  return {
    ...d,
    rows: d.rows.map((r) => ({ ...r, columns: r.columns.map((c) => ({ ...c, blocks: c.blocks.map((b) => (typeof b.p.html === "string"
      ? { ...b, p: { ...b.p, html: b.type === "html" ? cleanRawHtml(b.p.html) : b.type === "title" ? cleanBlockText(b.p.html).replace(/<\/?(p|ul|ol|li)[^>]*>/g, " ").trim() : cleanBlockText(b.p.html) } }
      : b)) })) })),
  };
}
/** What a template is saved as when it was made in the builder: the cleaned design, and the email HTML made from it. */
export function designedTemplate(design: EmailDesign) {
  const clean = cleanDesign(design);
  return { design: clean, body: renderDesign(clean) };
}
/** A row as saved (its blocks' words cleaned). */
export const cleanRow = (row: Row): Row => cleanDesign({ v: 1, p: {}, rows: [row] }).rows[0];
/** The company's saved rows (headers, footers…), by id. */
export async function savedRows(companyId: string): Promise<Map<string, SavedRow>> {
  return new Map((await db.select().from(emailSavedRows).where(eq(emailSavedRows.companyId, companyId)).orderBy(asc(emailSavedRows.name))).map((r) => [r.id, { id: r.id, name: r.name, row: r.row }]));
}
/** What a template made in the builder is saved as, with its saved rows brought up to date first. */
export async function designedTemplateFor(companyId: string, design: EmailDesign) {
  return designedTemplate(withSavedRows(design, await savedRows(companyId)).design);
}
/**
 * After a saved row changes (or is deleted): every template that uses it is brought up to date,
 * and its email made again. Returns how many templates changed.
 */
export async function refreshSavedRowUse(companyId: string): Promise<number> {
  const saved = await savedRows(companyId);
  let n = 0;
  for (const t of await db.select({ id: templates.id, design: templates.design }).from(templates).where(and(eq(templates.companyId, companyId), isNotNull(templates.design)))) {
    if (!t.design || !t.design.rows.some((r) => typeof r.p.saved === "string")) continue;
    const next = withSavedRows(t.design, saved);
    if (!next.changed) continue;
    await db.update(templates).set(designedTemplate(next.design)).where(eq(templates.id, t.id));
    n++;
  }
  return n;
}

/** A template's design for the builder: the one saved, or its plain wording turned into blocks (with the company's logo on top, as those emails were framed). */
export async function templateDesign(t: { companyId: string; design: EmailDesign | null; body: string }): Promise<EmailDesign> {
  if (t.design) return t.design;
  const [co] = await db.select({ id: companies.id, logoKey: companies.logoKey }).from(companies).where(eq(companies.id, t.companyId));
  return htmlToDesign(t.body, { logoUrl: co?.logoKey ? `${PUBLIC_API_URL}/public/company/${co.id}/logo` : null });
}

/* ───────────── Crewdesk's own templates and the chosen ones ───────────── */

/** Makes sure the company has its copy of each of Crewdesk's own templates. */
export async function ensureSystemTemplates(companyId: string) {
  const have = new Set((await db.select({ key: templates.systemKey }).from(templates).where(and(eq(templates.companyId, companyId), sql`${templates.systemKey} is not null`))).map((r) => r.key));
  const missing = SYSTEM_TEMPLATES.filter((t) => !have.has(t.key));
  if (missing.length) {
    await db.insert(templates).values(missing.map((t) => ({ companyId, channel: t.channel, audience: "customer", name: t.name, subject: t.subject ?? null, body: t.body, systemKey: t.key })))
      .onConflictDoNothing();
  }
}

/** The templates chosen for invoices, estimates and receipts (Crewdesk's own when none was picked). */
export async function templateDefaults(companyId: string): Promise<TemplateDefaults> {
  await ensureSystemTemplates(companyId);
  const [c] = await db.select({ d: companies.templateDefaults }).from(companies).where(eq(companies.id, companyId));
  const saved = c?.d ?? {};
  const system = new Map((await db.select({ id: templates.id, key: templates.systemKey }).from(templates).where(and(eq(templates.companyId, companyId), sql`${templates.systemKey} is not null`))).map((r) => [r.key!, r.id]));
  const out = { ...EMPTY_TEMPLATE_DEFAULTS, reviewUrl: saved.reviewUrl ?? null } as TemplateDefaults;
  for (const k of MESSAGE_KINDS) {
    const s = { ...EMPTY_TEMPLATE_DEFAULTS[k], ...(saved[k] ?? {}) };
    out[k] = { email: s.email ?? system.get(`${k}_email`) ?? null, text: s.text ?? system.get(`${k}_text`) ?? null, attachPdf: s.attachPdf };
  }
  return out;
}

/** The email and text template for one kind of message, and whether the PDF goes with it. */
export async function messageTemplates(companyId: string, kind: MessageKind) {
  const d = (await templateDefaults(companyId))[kind];
  const ids = [d.email, d.text].filter((x): x is string => !!x);
  const rows = ids.length ? await db.select().from(templates).where(and(eq(templates.companyId, companyId), inArray(templates.id, ids))) : [];
  return { email: rows.find((r) => r.id === d.email && r.channel === "email") ?? null, text: rows.find((r) => r.id === d.text && r.channel === "text") ?? null, attachPdf: d.attachPdf };
}

/* ───────────── Filling in the tags ───────────── */

export type TemplateContext = {
  customerId?: string | null; invoiceId?: string | null; estimateId?: string | null; visitId?: string | null; paymentId?: string | null;
  /** Automations: a to-do or an equipment repair order (their title and date fill the EVENT tags). */
  todoId?: string | null; maintenanceId?: string | null;
  message?: string | null;
};

const longDate = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
const time12 = (t: string | null | undefined) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

/** The company's own tags and the date ones. */
async function companyVars(companyId: string): Promise<TemplateVars> {
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId));
  const now = localParts(new Date(), co.timezone);
  const [owner] = await db.select({ first: employees.firstName, last: employees.lastName }).from(employees)
    .where(and(eq(employees.companyId, companyId), eq(employees.role, "owner"))).orderBy(asc(employees.createdAt)).limit(1);
  const defaults = co.templateDefaults ?? {};
  return {
    COMPANY_NAME: co.name, COMPANY_PHONE: co.phone ? formatPhone(co.phone) : "", COMPANY_EMAIL: co.email ?? "", COMPANY_WEBSITE: co.website ?? "",
    COMPANY_ADDRESS: [co.addressLine1, co.addressLine2, [co.city, co.state].filter(Boolean).join(", ") + (co.zip ? ` ${co.zip}` : "")].filter((x) => x && x.trim()).join(", "),
    COMPANY_OWNER_FIRST_NAME: owner?.first ?? "", COMPANY_OWNER_LAST_NAME: owner?.last ?? "",
    REVIEW_PAGE: defaults.reviewUrl ?? "",
    TODAY: longDate(now.date), CURRENT_MONTH: new Date(`${now.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }), CURRENT_YEAR: now.date.slice(0, 4),
  };
}

/** One customer's tags: their name, how to reach them, where they are (billing address, else their first property) and what they owe. */
function customerVars(companyId: string, c: typeof customers.$inferSelect, prop: typeof properties.$inferSelect | undefined, balanceCents: number, callNote: string | null): TemplateVars {
  const street = c.billingStreet ?? prop?.street ?? "";
  const city = c.billingCity ?? prop?.city ?? "";
  const state = c.billingState ?? prop?.state ?? "";
  const zip = c.billingZip ?? prop?.zip ?? "";
  const name = customerName(c);
  return {
    CUSTOMER_NAME: name, CUSTOMER_FIRST_NAME: c.firstName?.trim() || name, CUSTOMER_LAST_NAME: c.lastName ?? "", CUSTOMER_COMPANY_NAME: c.companyName ?? "",
    CUSTOMER_NUMBER: String(c.number ?? ""), CUSTOMER_EMAIL: c.email ?? "", CUSTOMER_PHONE: c.phone ? formatPhone(c.phone) : "", CUSTOMER_CELL: c.altPhone ? formatPhone(c.altPhone) : c.phone ? formatPhone(c.phone) : "",
    CUSTOMER_ADDRESS: [street, [city, state].filter(Boolean).join(", ") + (zip ? ` ${zip}` : "")].filter((x) => x && x.trim()).join(", "),
    CUSTOMER_CITY: city, CUSTOMER_STATE: state, CUSTOMER_ZIP: zip, CUSTOMER_ACCOUNT_BALANCE: formatMoney(Math.max(0, balanceCents)),
    CLIENT_PORTAL_LINK: portalUrl(companyId), CLIENT_PORTAL_ADD_CREDIT_CARD_LINK: portalUrl(companyId), CALL_NOTES: callNote ?? "",
    UNSUBSCRIBE: `${WEB_URL}/unsubscribe?customer=${encodeURIComponent(customerUnsubscribeToken(c.id))}`,
  };
}

/**
 * The company and customer tags for many customers at once (letters for a whole list), by customer
 * id. The same values `templateVars` gives one customer; customers of another company are left out.
 */
export async function customerTemplateVars(companyId: string, customerIds: string[]): Promise<Map<string, TemplateVars>> {
  const out = new Map<string, TemplateVars>();
  if (!customerIds.length) return out;
  const base = { ...(await companyVars(companyId)), MESSAGE: "" };
  for (let i = 0; i < customerIds.length; i += 500) {
    const rows = await db.select().from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds.slice(i, i + 500))));
    const ids = rows.map((c) => c.id);
    if (!ids.length) continue;
    const props = await db.select({ customerId: propertyAssignments.customerId, p: properties }).from(propertyAssignments).innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
      .where(and(inArray(propertyAssignments.customerId, ids), sql`${propertyAssignments.endDate} is null`)).orderBy(asc(propertyAssignments.startDate));
    const firstProp = new Map<string, typeof properties.$inferSelect>();
    for (const r of props) if (!firstProp.has(r.customerId)) firstProp.set(r.customerId, r.p);
    const bals = new Map((await db.select({ customerId: invoices.customerId, cents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents}), 0)::int` }).from(invoices)
      .where(and(inArray(invoices.customerId, ids), notInArray(invoices.status, ["draft", "void"]))).groupBy(invoices.customerId)).map((r) => [r.customerId, r.cents]));
    const calls = new Map((await db.selectDistinctOn([customerNotes.customerId], { customerId: customerNotes.customerId, body: customerNotes.body }).from(customerNotes)
      .where(and(inArray(customerNotes.customerId, ids), eq(customerNotes.kind, "call"))).orderBy(customerNotes.customerId, desc(customerNotes.createdAt))).map((r) => [r.customerId, r.body]));
    for (const c of rows) out.set(c.id, { ...base, ...customerVars(companyId, c, firstProp.get(c.id), bals.get(c.id) ?? 0, calls.get(c.id) ?? null) });
  }
  return out;
}

/** Every tag's value for a customer (and the invoice, estimate, work order or payment the message is about). */
export async function templateVars(companyId: string, ctx: TemplateContext): Promise<TemplateVars> {
  const v: TemplateVars = { ...(await companyVars(companyId)), MESSAGE: ctx.message?.trim() ?? "" };
  // Work out the customer from whatever the message is about.
  let customerId = ctx.customerId ?? null;
  const [inv] = ctx.invoiceId ? await db.select().from(invoices).where(and(eq(invoices.id, ctx.invoiceId), eq(invoices.companyId, companyId))) : [];
  const [est] = ctx.estimateId ? await db.select().from(estimates).where(and(eq(estimates.id, ctx.estimateId), eq(estimates.companyId, companyId))) : [];
  const [visit] = ctx.visitId ? await db.select().from(visits).where(and(eq(visits.id, ctx.visitId), eq(visits.companyId, companyId))) : [];
  const [pay] = ctx.paymentId ? await db.select().from(invoicePayments).where(eq(invoicePayments.id, ctx.paymentId)) : [];
  const [todo] = ctx.todoId ? await db.select().from(todos).where(and(eq(todos.id, ctx.todoId), eq(todos.companyId, companyId))) : [];
  const [fix] = ctx.maintenanceId ? await db.select({ w: workOrders, asset: assets.name }).from(workOrders).innerJoin(assets, eq(assets.id, workOrders.assetId))
    .where(and(eq(workOrders.id, ctx.maintenanceId), eq(workOrders.companyId, companyId))) : [];
  customerId ??= inv?.customerId ?? est?.customerId ?? visit?.customerId ?? pay?.customerId ?? todo?.customerId ?? null;
  if (customerId) {
    const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
    if (c) {
      const [prop] = await db.select({ p: properties }).from(propertyAssignments).innerJoin(properties, eq(properties.id, propertyAssignments.propertyId))
        .where(and(eq(propertyAssignments.customerId, c.id), sql`${propertyAssignments.endDate} is null`)).orderBy(asc(propertyAssignments.startDate)).limit(1);
      const [bal] = await db.select({ cents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents} - ${invoices.creditedCents}), 0)::int` }).from(invoices)
        .where(and(eq(invoices.customerId, c.id), notInArray(invoices.status, ["draft", "void"])));
      const [call] = await db.select({ body: customerNotes.body }).from(customerNotes).where(and(eq(customerNotes.customerId, c.id), eq(customerNotes.kind, "call"))).orderBy(desc(customerNotes.createdAt)).limit(1);
      Object.assign(v, customerVars(companyId, c, prop?.p, bal?.cents ?? 0, call?.body ?? null));
    }
  }
  if (inv) {
    const pay = (await stripeConfig(companyId)) ? payLinkFor(inv)?.url ?? null : null;
    Object.assign(v, {
      INVOICE_NUMBER: inv.number != null ? String(inv.number) : "(draft)", INVOICE_TOTAL: formatMoney(inv.totalCents), INVOICE_TAX: formatMoney(inv.taxCents),
      INVOICE_BALANCE: formatMoney(Math.max(0, inv.totalCents - inv.paidCents - inv.creditedCents)), INVOICE_DUE_DATE: longDate(inv.dueDate),
      INVOICES_LINKS: pay ?? portalUrl(companyId), RECEIPT_ADMIN_LINK: `${WEB_URL}/invoices/${inv.id}`,
    });
  }
  if (est) {
    Object.assign(v, {
      ESTIMATE_NUMBER: String(est.number ?? ""), ESTIMATE_TITLE: est.title ?? "", ESTIMATE_TOTAL: formatMoney(est.totalCents), ESTIMATE_VALID_UNTIL: longDate(est.validUntil),
      ESTIMATE_LINK: est.token ? `${WEB_URL}/estimate/${est.token}` : "", ESTIMATE_EDIT_LINK: `${WEB_URL}/estimates/${est.id}`,
      ESTIMATE_CHANGES: est.status === "changes" ? est.responseComment ?? "" : "",
    });
  }
  if (visit) {
    const [p] = visit.propertyId ? await db.select().from(properties).where(eq(properties.id, visit.propertyId)) : [];
    Object.assign(v, {
      EVENT_TITLE: visit.title, EVENT_DATE: visit.date ? new Date(`${visit.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "not scheduled yet",
      EVENT_SCHEDULED_TIME: time12(visit.startTime), EVENT_PROPERTY_ADDRESS: p ? formatAddress(p) : visit.location ?? "", NOTES_TO_DISPATCHER: visit.notes ?? "",
      EVENT_NOTES: visit.completionNotes ?? "", PROPERTY_NOT_SERVICED_REASON: visit.skipReason ?? "",
    });
    // The employee: whoever finished or skipped it, else the first person it's given to.
    const [who] = visit.finishedById
      ? await db.select({ first: employees.firstName, last: employees.lastName }).from(employees).where(eq(employees.id, visit.finishedById))
      : await db.select({ first: employees.firstName, last: employees.lastName }).from(visitAssignees).innerJoin(employees, eq(employees.id, visitAssignees.employeeId))
        .where(eq(visitAssignees.visitId, visit.id)).orderBy(asc(employees.firstName), asc(employees.lastName)).limit(1);
    if (who) Object.assign(v, { EMPLOYEE_FIRST_NAME: who.first, EMPLOYEE_LAST_NAME: who.last });
  }
  if (todo) {
    Object.assign(v, {
      EVENT_TITLE: todo.title, EVENT_DATE: new Date(`${todo.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }),
      EVENT_SCHEDULED_TIME: time12(todo.startTime),
    });
    const [who] = todo.doneById ? await db.select({ first: employees.firstName, last: employees.lastName }).from(employees).where(eq(employees.id, todo.doneById)) : [];
    if (who) Object.assign(v, { EMPLOYEE_FIRST_NAME: who.first, EMPLOYEE_LAST_NAME: who.last });
  }
  if (fix) {
    Object.assign(v, {
      EVENT_TITLE: `${fix.asset}: ${fix.w.title}`,
      EVENT_DATE: fix.w.dueDate ? new Date(`${fix.w.dueDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "",
      NOTES_TO_DISPATCHER: fix.w.description ?? "",
    });
  }
  if (pay) {
    Object.assign(v, {
      PAYMENT_AMOUNT: formatMoney(pay.amountCents), PAYMENT_DATE: longDate(pay.receivedOn),
      PAYMENT_METHOD: pay.methodDetail ?? PAYMENT_METHOD_LABELS[pay.method as PaymentMethod] ?? pay.method, RECEIPT_LINK: portalUrl(companyId),
    });
  }
  return v;
}

/* ───────────── The email around the message ───────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The email: the template filled in, inside the company's letterhead (logo, name) and footer. A
 * link on a line by itself becomes a button. Customer emails that aren't about a bill get an
 * unsubscribe link (invoices, estimates and receipts always go).
 */
export async function renderTemplateEmail(companyId: string, tpl: { subject: string | null; body: string }, vars: TemplateVars, o: { unsubscribeCustomerId?: string | null } = {}) {
  const [co] = await db.select().from(companies).where(eq(companies.id, companyId));
  const subject = fillTags(tpl.subject ?? "", vars).replace(/\s+/g, " ").trim() || co.name;
  if (isDesignedBody(tpl.body)) return renderDesignedEmail(co, subject, tpl.body, vars, o);
  const body = fillTags(tpl.body, vars, { html: true })
    .replace(/<p>(\s|<br>)*<\/p>/g, "")
    .replace(/<p([^>]*)>\s*<a href="([^"]+)" data-cd-link="1">([^<]*)<\/a>\s*<\/p>/g, (_, attrs: string, href: string, label: string) =>
      `<p${attrs}><a href="${href}" style="display:inline-block;background:#1f7a3a;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`)
    .replace(/ data-cd-link="1"/g, ' style="color:#1f7a3a;font-weight:600"');
  const token = o.unsubscribeCustomerId ? customerUnsubscribeToken(o.unsubscribeCustomerId) : null;
  const unsubscribe = token ? `${WEB_URL}/unsubscribe?customer=${encodeURIComponent(token)}` : null;
  const footer = [co.name, vars.COMPANY_ADDRESS, vars.COMPANY_PHONE, co.website].filter(Boolean).join(" · ");
  const logo = co.logoKey ? `<img src="${PUBLIC_API_URL}/public/company/${co.id}/logo?size=small" alt="${esc(co.name)}" style="max-height:64px;max-width:240px;margin:0 0 12px">` : `<div style="font-size:18px;font-weight:700;margin:0 0 12px">${esc(co.name)}</div>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f5f6f8">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1d2939">
${logo}
${body}
<hr style="border:0;border-top:1px solid #eaecf0;margin:24px 0 12px">
<p style="color:#667085;font-size:12px;margin:0">${esc(footer)}${unsubscribe ? `<br>Don't want these emails? <a href="${esc(unsubscribe)}" style="color:#667085">Unsubscribe</a>. You'll still get your invoices and receipts.` : ""}</p>
</div></body></html>`;
  const text = `${htmlToText(body)}\n\n--\n${footer}${unsubscribe ? `\nDon't want these emails? Unsubscribe: ${unsubscribe}` : ""}\n`;
  const headers: Record<string, string> = token ? { "List-Unsubscribe": `<${PUBLIC_API_URL}/public/unsubscribe/customer?token=${encodeURIComponent(token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  return { subject, html, text, headers, fromName: co.name, replyTo: co.email ?? undefined };
}

/**
 * An email made in the builder: sent as designed (no letter frame around it), with the company's
 * details and the unsubscribe link underneath.
 */
function renderDesignedEmail(co: typeof companies.$inferSelect, subject: string, designed: string, vars: TemplateVars, o: { unsubscribeCustomerId?: string | null }) {
  const body = fillTags(designed, vars, { html: true })
    .replace(/<p([^>]*)>\s*<a href="([^"]+)" data-cd-link="1">([^<]*)<\/a>\s*<\/p>/g, (_, attrs: string, href: string, label: string) =>
      `<p${attrs}><a href="${href}" style="display:inline-block;background:#1f7a3a;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`)
    .replace(/ data-cd-link="1"/g, ' style="color:#0068a5;font-weight:600"');
  const token = o.unsubscribeCustomerId ? customerUnsubscribeToken(o.unsubscribeCustomerId) : null;
  const unsubscribe = token ? `${WEB_URL}/unsubscribe?customer=${encodeURIComponent(token)}` : null;
  const footer = [co.name, vars.COMPANY_ADDRESS, vars.COMPANY_PHONE, co.website].filter(Boolean).join(" · ");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${DESIGN_CSS}</style></head><body style="margin:0;padding:0">
${body}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:14px 12px 24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:12px;line-height:1.5;color:#667085">
${esc(footer)}${unsubscribe ? `<br>Don't want these emails? <a href="${esc(unsubscribe)}" style="color:#667085">Unsubscribe</a>. You'll still get your invoices and receipts.` : ""}
</td></tr></table></body></html>`;
  const text = `${htmlToText(body)}\n\n--\n${footer}${unsubscribe ? `\nDon't want these emails? Unsubscribe: ${unsubscribe}` : ""}\n`;
  const headers: Record<string, string> = token ? { "List-Unsubscribe": `<${PUBLIC_API_URL}/public/unsubscribe/customer?token=${encodeURIComponent(token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  return { subject, html, text, headers, fromName: co.name, replyTo: co.email ?? undefined };
}

/**
 * Sends a template by email: filled in for the customer (and what it's about), logged in
 * Sent / History with the message, and opens counted. `transactional` (invoices, estimates,
 * receipts) goes even to customers who unsubscribed from other email.
 */
export async function sendTemplateEmail(o: {
  companyId: string; template: { id?: string | null; subject: string | null; body: string }; to: string; cc?: string[]; ctx: TemplateContext; transactional?: boolean;
  attachments?: EmailMessage["attachments"];
  /** To the owner or an employee (no unsubscribe link, and not logged as sent to the customer). */
  internal?: boolean;
  /** Tags only this email knows (a visit form's name). */
  vars?: TemplateVars;
}) {
  const transport = emailTransport();
  if (!transport) throw new Error("Email isn't set up on this server yet");
  const vars = { ...(await templateVars(o.companyId, o.ctx)), ...(o.vars ?? {}) };
  const customerId = await customerFor(o.companyId, o.ctx);
  const m = await renderTemplateEmail(o.companyId, o.template, vars, { unsubscribeCustomerId: o.transactional || o.internal ? null : customerId });
  await transport.send({
    to: o.to, cc: o.cc, subject: m.subject, text: m.text, html: m.html, headers: m.headers, fromName: m.fromName, replyTo: m.replyTo, attachments: o.attachments,
    track: { companyId: o.companyId, customerId: o.internal ? null : customerId, templateId: o.template.id ?? null, keepBody: true, opens: !o.internal },
  });
  return m;
}

/** Sends a template by text, when texting is connected and the customer can get texts. */
export async function sendTemplateText(o: { companyId: string; template: Pick<TemplateRow, "body">; ctx: TemplateContext; by: string | null; source?: "office" | "automation" }) {
  const customerId = await customerFor(o.companyId, o.ctx);
  if (!customerId) return { sent: false, skipped: "No customer" };
  const body = fillTemplateText(o.template.body, await templateVars(o.companyId, o.ctx));
  const r = await sendCustomerText(o.companyId, customerId, body, { by: o.by, source: o.source ?? "office" });
  return { sent: !!r.text && r.text.status !== "failed", skipped: r.skipped, phone: r.text?.phone ?? null, error: r.text?.status === "failed" ? r.text.error ?? "Not sent" : null };
}

/** A text template filled in (tidied blank lines). */
export const fillTemplateText = (body: string, vars: TemplateVars) => fillTags(body, vars).replace(/\n{3,}/g, "\n\n").trim();

async function customerFor(companyId: string, ctx: TemplateContext) {
  if (ctx.customerId) return ctx.customerId;
  if (ctx.invoiceId) return (await db.select({ c: invoices.customerId }).from(invoices).where(and(eq(invoices.id, ctx.invoiceId), eq(invoices.companyId, companyId))))[0]?.c ?? null;
  if (ctx.estimateId) return (await db.select({ c: estimates.customerId }).from(estimates).where(and(eq(estimates.id, ctx.estimateId), eq(estimates.companyId, companyId))))[0]?.c ?? null;
  if (ctx.visitId) return (await db.select({ c: visits.customerId }).from(visits).where(and(eq(visits.id, ctx.visitId), eq(visits.companyId, companyId))))[0]?.c ?? null;
  if (ctx.paymentId) return (await db.select({ c: invoicePayments.customerId }).from(invoicePayments).where(eq(invoicePayments.id, ctx.paymentId)))[0]?.c ?? null;
  if (ctx.todoId) return (await db.select({ c: todos.customerId }).from(todos).where(and(eq(todos.id, ctx.todoId), eq(todos.companyId, companyId))))[0]?.c ?? null;
  return null;
}

/**
 * Brings in templates from another system (Homeworks). An email that comes with its design from
 * Homeworks' builder is saved as that design, so it opens as the same blocks. One already here from
 * the same place is brought up to date when nobody has changed it in Crewdesk (so a newer file with
 * the designs replaces the first, plain import) and left alone when someone has; an empty one is skipped.
 */
export async function importTemplates(companyId: string, by: string, source: string, list: { channel: "email" | "text"; name: string; audience: "customer" | "internal"; subject?: string | null; body?: string; bee?: unknown; homeworksId?: string | number | null }[]) {
  const here = new Map((await db.select().from(templates).where(and(eq(templates.companyId, companyId), isNotNull(templates.importedFrom)))).map((t) => [t.importedFrom!, t]));
  let added = 0, updated = 0, kept = 0, skipped = 0;
  for (const t of list) {
    const importedFrom = t.homeworksId != null ? `${source}:${t.homeworksId}` : null;
    let design: EmailDesign | null = null;
    let body: string;
    if (t.channel === "email" && t.bee) {
      const made = designedTemplate(beeToDesign(typeof t.bee === "string" ? safeJson(t.bee) : t.bee).design);
      if (!designHasContent(made.design)) { skipped++; continue; }
      design = made.design; body = made.body;
    } else {
      body = t.channel === "email" ? cleanEmailHtml(t.body ?? "") : (t.body ?? "").replace(/\r/g, "").trim();
      if (!body.trim() || (t.channel === "email" && !htmlToText(body).trim())) { skipped++; continue; }
    }
    const subject = t.channel === "email" ? (t.subject?.trim() || t.name) : null;
    const have = importedFrom ? here.get(importedFrom) : undefined;
    if (!have) {
      const [row] = await db.insert(templates).values({ companyId, channel: t.channel, audience: t.audience, name: t.name, subject, body, design, importedFrom, createdById: by, updatedById: by })
        .onConflictDoNothing().returning({ id: templates.id });
      if (row) added++; else skipped++;
    } else if (have.channel !== t.channel || (have.body === body && have.name === t.name && (have.subject ?? null) === subject)) skipped++;
    else if (have.updatedAt.getTime() === have.createdAt.getTime()) {
      // Never edited here: take the file's version (and keep it marked as not edited).
      await db.update(templates).set({ name: t.name, subject, body, design }).where(eq(templates.id, have.id));
      updated++;
    } else kept++;
  }
  return { added, updated, kept, skipped };
}
function safeJson(s: string): unknown {
  try { const v: unknown = JSON.parse(s); return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
}

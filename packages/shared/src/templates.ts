import { z } from "zod";

/**
 * Message templates (Marketing → Templates), like Homeworks' email and text templates: one library
 * of emails and texts with merge tags such as {{CUSTOMER_FIRST_NAME}} (the same names Homeworks
 * uses, so imported templates work unchanged). Invoices, estimates and receipts are sent with the
 * template chosen for them; automations and the bulk Send pick from the same list.
 */

export const TEMPLATE_CHANNELS = ["email", "text"] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];
export const TEMPLATE_AUDIENCES = ["customer", "internal"] as const;
export type TemplateAudience = (typeof TEMPLATE_AUDIENCES)[number];
export const TEMPLATE_AUDIENCE_LABELS: Record<TemplateAudience, string> = { customer: "To customers", internal: "To your team" };

/** What a tag needs to have a value: a customer is always there; the rest only when sending about one. */
export type TagNeeds = "invoice" | "estimate" | "visit" | "payment";
export type TemplateTag = { tag: string; label: string; group: string; needs?: TagNeeds; link?: string; example: string };

/** Every merge tag, by group. `link` is the words shown for a link in an email. */
export const TEMPLATE_TAGS: TemplateTag[] = [
  { tag: "CUSTOMER_NAME", label: "Customer name", group: "Customer", example: "Jane Smith" },
  { tag: "CUSTOMER_FIRST_NAME", label: "First name", group: "Customer", example: "Jane" },
  { tag: "CUSTOMER_LAST_NAME", label: "Last name", group: "Customer", example: "Smith" },
  { tag: "CUSTOMER_COMPANY_NAME", label: "Customer's company", group: "Customer", example: "Smith Rentals LLC" },
  { tag: "CUSTOMER_NUMBER", label: "Customer #", group: "Customer", example: "1042" },
  { tag: "CUSTOMER_EMAIL", label: "Email", group: "Customer", example: "jane@example.com" },
  { tag: "CUSTOMER_PHONE", label: "Phone", group: "Customer", example: "(405) 555-0100" },
  { tag: "CUSTOMER_CELL", label: "Cell phone", group: "Customer", example: "(405) 555-0101" },
  { tag: "CUSTOMER_ADDRESS", label: "Address", group: "Customer", example: "123 Main St, Norman, OK 73069" },
  { tag: "CUSTOMER_CITY", label: "City", group: "Customer", example: "Norman" },
  { tag: "CUSTOMER_STATE", label: "State", group: "Customer", example: "OK" },
  { tag: "CUSTOMER_ZIP", label: "ZIP", group: "Customer", example: "73069" },
  { tag: "CUSTOMER_ACCOUNT_BALANCE", label: "Account balance", group: "Customer", example: "$120.00" },
  { tag: "CLIENT_PORTAL_LINK", label: "Customer portal link", group: "Links", link: "Your customer portal", example: "Your customer portal" },
  { tag: "CLIENT_PORTAL_ADD_CREDIT_CARD_LINK", label: "Add a card or bank account link", group: "Links", link: "Add a card or bank account", example: "Add a card or bank account" },
  { tag: "REVIEW_PAGE", label: "Review link", group: "Links", link: "Leave us a review", example: "Leave us a review" },
  { tag: "COMPANY_NAME", label: "Your company name", group: "Company", example: "Pro Spray Lawn & Pest" },
  { tag: "COMPANY_PHONE", label: "Your phone", group: "Company", example: "(405) 555-0199" },
  { tag: "COMPANY_EMAIL", label: "Your email", group: "Company", example: "office@example.com" },
  { tag: "COMPANY_WEBSITE", label: "Your website", group: "Company", example: "www.example.com" },
  { tag: "COMPANY_ADDRESS", label: "Your address", group: "Company", example: "1 Main St, Norman, OK 73069" },
  { tag: "COMPANY_OWNER_FIRST_NAME", label: "Owner's first name", group: "Company", example: "Brian" },
  { tag: "COMPANY_OWNER_LAST_NAME", label: "Owner's last name", group: "Company", example: "Henderson" },
  { tag: "INVOICE_NUMBER", label: "Invoice #", group: "Invoice", needs: "invoice", example: "1042" },
  { tag: "INVOICE_TOTAL", label: "Invoice total", group: "Invoice", needs: "invoice", example: "$85.00" },
  { tag: "INVOICE_BALANCE", label: "Amount still due", group: "Invoice", needs: "invoice", example: "$85.00" },
  { tag: "INVOICE_DUE_DATE", label: "Due date", group: "Invoice", needs: "invoice", example: "December 10, 2026" },
  { tag: "INVOICES_LINKS", label: "View and pay link", group: "Invoice", needs: "invoice", link: "View and pay your invoice", example: "View and pay your invoice" },
  { tag: "ESTIMATE_NUMBER", label: "Estimate #", group: "Estimate", needs: "estimate", example: "1007" },
  { tag: "ESTIMATE_TITLE", label: "Estimate title", group: "Estimate", needs: "estimate", example: "Core aeration and overseeding" },
  { tag: "ESTIMATE_TOTAL", label: "Estimate total", group: "Estimate", needs: "estimate", example: "$240.00" },
  { tag: "ESTIMATE_VALID_UNTIL", label: "Good until", group: "Estimate", needs: "estimate", example: "December 31, 2026" },
  { tag: "ESTIMATE_LINK", label: "View and accept link", group: "Estimate", needs: "estimate", link: "View and accept your estimate", example: "View and accept your estimate" },
  { tag: "ESTIMATE_CHANGES", label: "Changes the customer asked for", group: "Estimate", needs: "estimate", example: "Can you skip the back yard?" },
  { tag: "ESTIMATE_EDIT_LINK", label: "Office link to the estimate", group: "Estimate", needs: "estimate", link: "Open the estimate", example: "Open the estimate" },
  { tag: "EVENT_TITLE", label: "Work order title", group: "Work order", needs: "visit", example: "Round 3: fertilizer & weed control" },
  { tag: "EVENT_DATE", label: "Scheduled date", group: "Work order", needs: "visit", example: "Tuesday, December 1, 2026" },
  { tag: "EVENT_SCHEDULED_TIME", label: "Scheduled time", group: "Work order", needs: "visit", example: "9:00 AM" },
  { tag: "EVENT_PROPERTY_ADDRESS", label: "Property address", group: "Work order", needs: "visit", example: "123 Main St, Norman, OK 73069" },
  { tag: "NOTES_TO_DISPATCHER", label: "Work order notes", group: "Work order", needs: "visit", example: "Back gate code 1234" },
  { tag: "PAYMENT_AMOUNT", label: "Payment amount", group: "Payment", needs: "payment", example: "$85.00" },
  { tag: "PAYMENT_DATE", label: "Payment date", group: "Payment", needs: "payment", example: "November 25, 2026" },
  { tag: "PAYMENT_METHOD", label: "Paid by", group: "Payment", needs: "payment", example: "Visa ·· 4242" },
  { tag: "RECEIPT_LINK", label: "Receipt link (portal)", group: "Payment", needs: "payment", link: "See your payments", example: "See your payments" },
  { tag: "RECEIPT_ADMIN_LINK", label: "Office link to the invoice", group: "Payment", needs: "payment", link: "Open the invoice", example: "Open the invoice" },
  { tag: "MESSAGE", label: "Note typed when sending", group: "Other", example: "Thanks for your business this season!" },
  { tag: "CALL_NOTES", label: "Latest call note", group: "Other", example: "Called about a missed spot by the fence" },
  { tag: "TODAY", label: "Today's date", group: "Other", example: "November 25, 2026" },
  { tag: "CURRENT_MONTH", label: "This month", group: "Other", example: "November" },
  { tag: "CURRENT_YEAR", label: "This year", group: "Other", example: "2026" },
];
const TAG = new Map(TEMPLATE_TAGS.map((t) => [t.tag, t]));
export const templateTag = (tag: string) => TAG.get(tag);
export const TAG_GROUPS = [...new Set(TEMPLATE_TAGS.map((t) => t.group))];

const TAG_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;
/** Tags used in a template (subject and body). */
export const usedTags = (...texts: (string | null | undefined)[]) => [...new Set(texts.flatMap((t) => [...(t ?? "").matchAll(TAG_RE)].map((m) => m[1])))];
/** {{WORDS}} that aren't tags (probably typos). */
export const unknownTags = (...texts: (string | null | undefined)[]) => usedTags(...texts).filter((t) => !TAG.has(t));
/** What the template needs to be sent with (an invoice, an estimate…). */
export const tagNeeds = (...texts: (string | null | undefined)[]) => [...new Set(usedTags(...texts).map((t) => TAG.get(t)?.needs).filter((x): x is TagNeeds => !!x))];

export type TemplateVars = Record<string, string>;
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Fills the tags in. In an email body (`html`), values are escaped and link tags become links with
 * friendly words ("View and pay your invoice"); a link tag used as an href gives the bare address.
 * Tags with no value (or unknown ones) become nothing.
 */
export function fillTags(text: string, vars: TemplateVars, o: { html?: boolean } = {}): string {
  if (!o.html) return text.replace(TAG_RE, (_, t: string) => vars[t] ?? "");
  const hrefFilled = text.replace(/href=(["'])\s*\{\{\s*([A-Z0-9_]+)\s*\}\}\s*\1/g, (_, q: string, t: string) => `href=${q}${escHtml(vars[t] ?? "")}${q}`);
  return hrefFilled.replace(TAG_RE, (_, t: string) => {
    const v = vars[t];
    if (!v) return "";
    const def = TAG.get(t);
    return def?.link && /^https?:\/\//.test(v) ? `<a href="${escHtml(v)}" data-cd-link="1">${escHtml(def.link)}</a>` : escHtml(v).replace(/\n/g, "<br>");
  });
}

/** Example values, for previews before a customer is picked. */
export const SAMPLE_TEMPLATE_VARS: TemplateVars = Object.fromEntries(TEMPLATE_TAGS.map((t) => [t.tag, t.link ? "https://example.com" : t.example]));

/* ───────────── Text messages ───────────── */

const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";
/**
 * How many text segments a message takes: plain characters fit 160 in one (153 each when split);
 * one emoji or other special character switches the whole text to 70 (67 each when split).
 */
export function smsSegments(text: string): { encoding: "GSM-7" | "Unicode"; units: number; segments: number; perSegment: number } {
  let units = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else { unicode = true; break; }
  }
  if (unicode) {
    const n = [...text].reduce((s, ch) => s + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return { encoding: "Unicode", units: n, segments: n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67), perSegment: n <= 70 ? 70 : 67 };
  }
  return { encoding: "GSM-7", units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), perSegment: units <= 160 ? 160 : 153 };
}

/** An email body as plain text (the text part of an email, and imported texts). */
export function htmlToText(html: string): string {
  return html
    .replace(/\r/g, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && l !== href ? `${l}: ${href}` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|div|ul|ol)>\s*/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ───────────── Saving and sending ───────────── */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
export const TEMPLATE_TEXT_MAX = 1600;

export const templateSchema = z.object({
  channel: z.enum(TEMPLATE_CHANNELS),
  audience: z.enum(TEMPLATE_AUDIENCES).default("customer"),
  name: z.string().trim().min(1, "Name the template").max(120),
  subject: z.preprocess(blankToNull, z.string().trim().max(250).nullable()).optional(),
  body: z.string().max(60_000),
}).superRefine((v, ctx) => {
  if (v.channel === "email" && !v.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "Enter the subject" });
  const empty = v.channel === "email" ? !htmlToText(v.body).trim() : !v.body.trim();
  if (empty) ctx.addIssue({ code: "custom", path: ["body"], message: "Write the message" });
  if (v.channel === "text" && v.body.length > TEMPLATE_TEXT_MAX) ctx.addIssue({ code: "custom", path: ["body"], message: `Keep texts under ${TEMPLATE_TEXT_MAX} characters` });
});
export type TemplateInput = z.infer<typeof templateSchema>;

/** Preview or test: the template as typed, filled in for a customer (and an invoice, estimate…). */
export const templatePreviewSchema = z.object({
  channel: z.enum(TEMPLATE_CHANNELS),
  subject: z.string().max(250).nullable().optional(),
  body: z.string().max(60_000),
  customerId: z.string().uuid().nullable().optional(),
  invoiceId: z.string().uuid().nullable().optional(),
  estimateId: z.string().uuid().nullable().optional(),
  visitId: z.string().uuid().nullable().optional(),
  paymentId: z.string().uuid().nullable().optional(),
});

/** The messages Crewdesk sends that use a chosen template (like Homeworks' default invoice, estimate and receipt templates). */
export const MESSAGE_KINDS = ["invoice", "estimate", "receipt"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = { invoice: "Invoices", estimate: "Estimates", receipt: "Payment receipts" };
export const MESSAGE_KIND_NEEDS: Record<MessageKind, TagNeeds[]> = { invoice: ["invoice"], estimate: ["estimate"], receipt: ["invoice", "payment"] };

const uuidOrNull = z.preprocess(blankToNull, z.string().uuid().nullable());
const kindDefaults = z.object({ email: uuidOrNull, text: uuidOrNull, attachPdf: z.boolean().default(true) });
export const templateDefaultsSchema = z.object({
  invoice: kindDefaults, estimate: kindDefaults, receipt: kindDefaults,
  /** For {{REVIEW_PAGE}}: your Google (or other) review page. */
  reviewUrl: z.preprocess(blankToNull, z.string().trim().url("Enter the whole address, starting with https://").max(500).nullable()).optional(),
});
export type TemplateDefaults = z.infer<typeof templateDefaultsSchema>;

/** Templates from another system (Homeworks), as Crewdesk's import file has them. */
export const templateImportSchema = z.object({
  source: z.string().max(40).default("homeworks"),
  templates: z.array(z.object({
    channel: z.enum(TEMPLATE_CHANNELS),
    name: z.string().trim().min(1).max(120),
    audience: z.enum(TEMPLATE_AUDIENCES).default("customer"),
    subject: z.string().max(250).nullable().optional(),
    body: z.string().max(60_000),
    system: z.boolean().optional(),
    homeworksId: z.union([z.number(), z.string()]).optional(),
  })).min(1, "The file has no templates").max(1000),
});

/**
 * Crewdesk's own templates for what it sends (one per kind and channel). Every company gets a
 * copy it can change; "Reset" puts this wording back.
 */
export type SystemTemplate = { key: string; kind: MessageKind; channel: TemplateChannel; name: string; subject?: string; body: string };
export const SYSTEM_TEMPLATES: SystemTemplate[] = [
  {
    key: "invoice_email", kind: "invoice", channel: "email", name: "Invoice (Crewdesk)",
    subject: "Invoice {{INVOICE_NUMBER}} from {{COMPANY_NAME}}: {{INVOICE_BALANCE}} due {{INVOICE_DUE_DATE}}",
    body: `<p>Hello {{CUSTOMER_NAME}},</p>
<p>{{MESSAGE}}</p>
<p>Your invoice <strong>{{INVOICE_NUMBER}}</strong> from {{COMPANY_NAME}} is attached.</p>
<p>Amount due: <strong>{{INVOICE_BALANCE}}</strong><br>Due: {{INVOICE_DUE_DATE}}</p>
<p>{{INVOICES_LINKS}}</p>
<p>To pay by check, mail it with the bottom part of the invoice. Questions? Just reply to this email or call {{COMPANY_PHONE}}.</p>
<p>Thank you,<br>{{COMPANY_NAME}}</p>`,
  },
  { key: "invoice_text", kind: "invoice", channel: "text", name: "Invoice text (Crewdesk)", body: "Hi {{CUSTOMER_FIRST_NAME}}, your invoice {{INVOICE_NUMBER}} from {{COMPANY_NAME}} for {{INVOICE_BALANCE}} is ready: {{INVOICES_LINKS}}" },
  {
    key: "estimate_email", kind: "estimate", channel: "email", name: "Estimate (Crewdesk)",
    subject: "Estimate {{ESTIMATE_NUMBER}} from {{COMPANY_NAME}}",
    body: `<p>Hello {{CUSTOMER_NAME}},</p>
<p>{{MESSAGE}}</p>
<p>Here's your estimate {{ESTIMATE_NUMBER}} ({{ESTIMATE_TITLE}}) from {{COMPANY_NAME}}: <strong>{{ESTIMATE_TOTAL}}</strong>.</p>
<p>{{ESTIMATE_LINK}}</p>
<p>See it, choose any options, and accept it online. The PDF is attached too. Questions? Just reply to this email or call {{COMPANY_PHONE}}.</p>
<p>Thank you,<br>{{COMPANY_NAME}}</p>`,
  },
  { key: "estimate_text", kind: "estimate", channel: "text", name: "Estimate text (Crewdesk)", body: "Hi {{CUSTOMER_FIRST_NAME}}, here's your estimate from {{COMPANY_NAME}} for {{ESTIMATE_TOTAL}}. See it and accept it here: {{ESTIMATE_LINK}}" },
  {
    key: "receipt_email", kind: "receipt", channel: "email", name: "Payment receipt (Crewdesk)",
    subject: "Payment received: invoice {{INVOICE_NUMBER}} from {{COMPANY_NAME}}",
    body: `<p>Thank you, {{CUSTOMER_NAME}}.</p>
<p>We received your payment of <strong>{{PAYMENT_AMOUNT}}</strong> for invoice {{INVOICE_NUMBER}} ({{PAYMENT_METHOD}}).</p>
<p>Remaining balance on this invoice: {{INVOICE_BALANCE}}</p>
<p>{{COMPANY_NAME}}</p>`,
  },
  { key: "receipt_text", kind: "receipt", channel: "text", name: "Payment receipt text (Crewdesk)", body: "Thank you, {{CUSTOMER_FIRST_NAME}}! We received your payment of {{PAYMENT_AMOUNT}} for invoice {{INVOICE_NUMBER}}. - {{COMPANY_NAME}}" },
];
export const systemTemplate = (key: string) => SYSTEM_TEMPLATES.find((t) => t.key === key);

/** Out of the box: Crewdesk's own templates, PDFs attached, no review link yet (template ids are filled in per company). */
export const EMPTY_TEMPLATE_DEFAULTS: TemplateDefaults = {
  invoice: { email: null, text: null, attachPdf: true },
  estimate: { email: null, text: null, attachPdf: true },
  receipt: { email: null, text: null, attachPdf: false },
  reviewUrl: null,
};

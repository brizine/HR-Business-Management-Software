import { z } from "zod";
import { TEMPLATE_TAGS, usedTags, type TemplateTag } from "./templates";

/**
 * The invoice layout: what the invoice layout editor changes. It says which parts of the invoice
 * show, what they're called, the order of the middle sections and the look. It never moves the two
 * address blocks: they stay where a #10 double-window envelope shows them, and the tear-off stub
 * stays on the bottom third of the first page.
 *
 * `DEFAULT_INVOICE_LAYOUT` is the invoice exactly as it was before the editor existed. Anything
 * saved is cleaned by `cleanInvoiceLayout`, so a layout can only ever hold its own words, colours
 * and choices, and a layout saved by an older version gains whatever was added since.
 */

export const LAYOUT_FONTS = ["helvetica", "times", "courier"] as const;
export type LayoutFont = (typeof LAYOUT_FONTS)[number];
export const LAYOUT_FONT_LABELS: Record<LayoutFont, string> = { helvetica: "Helvetica (plain, modern)", times: "Times (classic)", courier: "Courier (typewriter)" };

export const LAYOUT_SIZES = ["small", "normal", "large"] as const;
export type LayoutSize = (typeof LAYOUT_SIZES)[number];
export const LAYOUT_SIZE_LABELS: Record<LayoutSize, string> = { small: "Small", normal: "Normal", large: "Large" };
/** How much the invoice's words grow or shrink. */
export const LAYOUT_SIZE_SCALE: Record<LayoutSize, number> = { small: 0.92, normal: 1, large: 1.08 };

export const LOGO_PLACES = ["left", "right"] as const;
export type LogoPlace = (typeof LOGO_PLACES)[number];
export const LOGO_PLACE_LABELS: Record<LogoPlace, string> = { left: "Left, above your address", right: "Right, above the title" };
/** The most room a logo gets, in points (72 to the inch). */
export const LOGO_BOX: Record<LayoutSize, { w: number; h: number }> = { small: { w: 130, h: 24 }, normal: { w: 187.2, h: 34 }, large: { w: 216, h: 46 } };

/** The facts at the top right. Custom fields are added as `cf:<field id>`. */
export const DETAIL_KEYS = ["number", "date", "due", "terms", "customerNumber", "po", "serviceDate"] as const;
export type DetailKey = (typeof DETAIL_KEYS)[number];
export const DETAIL_LABELS: Record<DetailKey, string> = { number: "Invoice #", date: "Date", due: "Due", terms: "Terms", customerNumber: "Customer #", po: "PO #", serviceDate: "Service date" };
/** What each detail is, for the editor. */
export const DETAIL_HELP: Record<DetailKey, string> = {
  number: "The invoice number (\"Draft\" until it's sent).",
  date: "The invoice date.",
  due: "The due date. The terms follow it in brackets unless Terms has its own line.",
  terms: "Due on receipt, Net 30 and so on, on its own line.",
  customerNumber: "The customer's number.",
  po: "The customer's PO number. Left off invoices that have none.",
  serviceDate: "When the work was done: the dates of the work orders on the invoice. Left off invoices made by hand.",
};
export const isFieldKey = (key: string) => /^cf:[0-9a-f-]{36}$/i.test(key);

export const COLUMN_KEYS = ["description", "qty", "price", "tax", "amount"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export const COLUMN_LABELS: Record<ColumnKey, string> = { description: "Description", qty: "Qty", price: "Price", tax: "Tax", amount: "Amount" };
/** Description always leads and Amount is always there; the rest can be hidden. */
export const COLUMN_LOCKED: readonly ColumnKey[] = ["description", "amount"];

export const TOTAL_KEYS = ["subtotal", "discount", "tax", "total", "credit", "paid", "due"] as const;
export type TotalKey = (typeof TOTAL_KEYS)[number];
/** Tax is blank: it uses the name sales tax has in Settings unless one is typed here. */
export const TOTAL_LABELS: Record<TotalKey, string> = { subtotal: "Subtotal", discount: "Discount", tax: "", total: "Total", credit: "Credit", paid: "Paid", due: "Amount due" };
export const TOTAL_NAMES: Record<TotalKey, string> = { subtotal: "Subtotal", discount: "Discount", tax: "Sales tax", total: "Total", credit: "Credit used", paid: "Paid", due: "Amount due" };
/** Rows that can be left off. The others show whenever they apply. */
export const TOTAL_HIDEABLE: readonly TotalKey[] = ["subtotal", "credit", "paid"];

export const TABLE_HEADS = ["line", "bar"] as const;
export const TABLE_HEAD_LABELS: Record<(typeof TABLE_HEADS)[number], string> = { line: "A line under the headings", bar: "A colored bar" };
export const NOTE_PLACES = ["beside", "below"] as const;
export const NOTE_PLACE_LABELS: Record<(typeof NOTE_PLACES)[number], string> = { beside: "Beside the totals", below: "Under the totals" };
export const TEXT_ALIGNS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const MAX_TEXT_BLOCKS = 6;
export const MAX_DETAILS = 16;
/** The ink the invoice was always printed in: the accent until another colour is picked. */
export const LAYOUT_INK = "#1a1f29";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((v) => v.toLowerCase());
/** A label or a line of wording: one line, trimmed. */
const word = (max: number, fallback: string) => z.string().max(5000).transform((v) => v.replace(/\s+/g, " ").trim().slice(0, max)).catch(fallback).default(fallback);
const flag = (fallback: boolean) => z.boolean().catch(fallback).default(fallback);
const pick = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) => z.enum(values).catch(fallback).default(fallback);
const para = (max: number) => z.string().max(50_000).transform((v) => v.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max)).catch("").default("");

/** A list that keeps its good entries: one that isn't right is dropped, not the whole list. */
const listOf = <S extends z.ZodTypeAny>(item: S) => z.array(z.unknown()).max(200).catch([]).default([])
  .transform((list) => list.flatMap((x) => { const r = item.safeParse(x); return r.success ? [r.data as z.infer<S>] : []; }));

const detailSchema = z.object({ key: z.string().max(40), label: word(40, ""), show: flag(true) });
const columnSchema = z.object({ key: z.enum(COLUMN_KEYS), label: word(24, ""), show: flag(true) });
const totalSchema = z.object({ key: z.enum(TOTAL_KEYS), label: word(40, ""), show: flag(true) });
const textBlockSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{4,16}$/),
  text: para(1500),
  align: pick(TEXT_ALIGNS, "left"),
  size: pick(LAYOUT_SIZES, "normal"),
  bold: flag(false),
  /** A thin box around it. */
  box: flag(false),
});
export type LayoutTextBlock = z.infer<typeof textBlockSchema>;

const layoutSchema = z.object({
  v: z.literal(1).catch(1).default(1),
  page: z.object({
    /** The title, the amount due and the table's heading bar. */
    accent: hex.catch(LAYOUT_INK).default(LAYOUT_INK),
    font: pick(LAYOUT_FONTS, "helvetica"),
    size: pick(LAYOUT_SIZES, "normal"),
  }).default({}),
  header: z.object({
    logo: z.object({ show: flag(true), size: pick(LAYOUT_SIZES, "normal"), place: pick(LOGO_PLACES, "left") }).default({}),
    /** Which of the company's own lines show at the top left. */
    company: z.object({ address: flag(true), phone: flag(true), email: flag(true), website: flag(false) }).default({}),
    title: word(30, "INVOICE"),
    details: listOf(detailSchema),
    amountDue: z.object({ show: flag(true), label: word(30, "Amount due") }).default({}),
  }).default({}),
  serviceAddress: z.object({ show: flag(true), label: word(40, "Service address") }).default({}),
  table: z.object({
    columns: listOf(columnSchema),
    head: pick(TABLE_HEADS, "line"),
    /** Every other line lightly shaded. */
    stripes: flag(false),
  }).default({}),
  totals: z.object({ rows: listOf(totalSchema) }).default({}),
  notes: z.object({ show: flag(true), label: word(40, ""), place: pick(NOTE_PLACES, "beside") }).default({}),
  footer: z.object({ show: flag(true), text: para(1000), align: pick(TEXT_ALIGNS, "left") }).default({}),
  blocks: listOf(textBlockSchema),
  /** The middle sections, top to bottom: "lines", "totals", "footer" and each text block as "text:<id>". */
  order: listOf(z.string().max(30)),
  stub: z.object({
    show: flag(true),
    detach: word(90, "Please detach and return this part with your payment"),
    payableLabel: word(40, "Make checks payable to"),
    /** Blank: the company's legal name, else its name. */
    payableTo: word(160, ""),
    mailLabel: word(40, "Mail to"),
    payOnline: flag(true),
    payOnlineLabel: word(60, "Or pay online (card or bank account)"),
    enclosed: flag(true),
    enclosedLabel: word(40, "Amount enclosed"),
  }).default({}),
});
export type InvoiceLayout = z.infer<typeof layoutSchema>;
export type LayoutDetail = InvoiceLayout["header"]["details"][number];
export type LayoutColumn = InvoiceLayout["table"]["columns"][number];
export type LayoutTotal = InvoiceLayout["totals"]["rows"][number];

const FIXED_SECTIONS = ["lines", "totals", "footer"] as const;
export const SECTION_NAMES: Record<(typeof FIXED_SECTIONS)[number], string> = { lines: "The lines (what was done)", totals: "Totals and notes", footer: "Footer" };

/**
 * Puts the lists right: every detail, column and total row there once (new ones added hidden, or
 * shown when they always were), Description first, each text block in the order once.
 */
function tidy(l: InvoiceLayout): InvoiceLayout {
  const seen = new Set<string>();
  const once = <T extends { key: string }>(list: T[], ok: (k: string) => boolean) => list.filter((x) => ok(x.key) && !seen.has(x.key) && !!seen.add(x.key));

  const details = once(l.header.details, (k) => (DETAIL_KEYS as readonly string[]).includes(k) || isFieldKey(k)).slice(0, MAX_DETAILS);
  for (const k of DETAIL_KEYS) if (!details.some((d) => d.key === k)) details.push({ key: k, label: DETAIL_LABELS[k], show: k !== "terms" && k !== "serviceDate" });
  for (const d of details) if (!d.label) d.label = (DETAIL_LABELS as Record<string, string>)[d.key] ?? "Field";

  seen.clear();
  const cols = once(l.table.columns, () => true);
  for (const k of COLUMN_KEYS) if (!cols.some((c) => c.key === k)) cols.push({ key: k, label: COLUMN_LABELS[k], show: true });
  for (const c of cols) { if (!c.label) c.label = COLUMN_LABELS[c.key]; if (COLUMN_LOCKED.includes(c.key)) c.show = true; }
  const columns = [...cols.filter((c) => c.key === "description"), ...cols.filter((c) => c.key !== "description")];

  // Totals keep their own order: a total before its subtotal would be wrong on any invoice.
  const rows = TOTAL_KEYS.map((k) => {
    const mine = l.totals.rows.find((r) => r.key === k);
    return { key: k, label: mine?.label || TOTAL_LABELS[k], show: TOTAL_HIDEABLE.includes(k) ? mine?.show ?? true : true };
  });

  seen.clear();
  const blocks = l.blocks.filter((b) => !seen.has(b.id) && !!seen.add(b.id)).slice(0, MAX_TEXT_BLOCKS);
  const sections = new Set<string>([...FIXED_SECTIONS, ...blocks.map((b) => `text:${b.id}`)]);
  seen.clear();
  const order = l.order.filter((s) => sections.has(s) && !seen.has(s) && !!seen.add(s));
  for (const s of sections) if (!seen.has(s)) order.push(s);

  return { ...l, header: { ...l.header, details, title: l.header.title || "INVOICE" }, table: { ...l.table, columns }, totals: { rows }, blocks, order };
}

/** Anything saved or sent as a layout, made safe and whole. Something that isn't a layout at all comes back as the default. */
export function cleanInvoiceLayout(raw: unknown): InvoiceLayout {
  const r = layoutSchema.safeParse(raw ?? {});
  return tidy(r.success ? r.data : layoutSchema.parse({}));
}
/** For what the editor sends: cleaned the same way. */
export const invoiceLayoutSchema = z.unknown().transform((v) => cleanInvoiceLayout(v));

/** The invoice as Crewdesk has always printed it. */
export const DEFAULT_INVOICE_LAYOUT: InvoiceLayout = cleanInvoiceLayout({});

/**
 * The layout an invoice uses: the published one, or (until one is published) the default with the
 * footer and "payable to" the company typed in its billing settings before the editor existed.
 */
export function resolveInvoiceLayout(published: unknown, settings: { footer?: string | null; payableTo?: string | null } = {}): InvoiceLayout {
  if (published) return cleanInvoiceLayout(published);
  const l = cleanInvoiceLayout({});
  return { ...l, footer: { ...l.footer, text: settings.footer ?? "" }, stub: { ...l.stub, payableTo: settings.payableTo ?? "" } };
}

export const newTextBlock = (): LayoutTextBlock => ({ id: Math.random().toString(36).slice(2, 10).padEnd(8, "0"), text: "", align: "left", size: "normal", bold: false, box: false });

/** Whether two layouts print the same (the editor's "you have changes"). */
export const sameLayout = (a: unknown, b: unknown) => JSON.stringify(cleanInvoiceLayout(a)) === JSON.stringify(cleanInvoiceLayout(b));

/* ───────────── Fill-ins in the footer and text blocks ───────────── */

/** The fill-ins that mean something on a printed invoice (not the estimate, work order or payment ones, and no unsubscribe link). */
export const INVOICE_LAYOUT_TAGS: TemplateTag[] = TEMPLATE_TAGS.filter((t) => (!t.needs || t.needs === "invoice") && !["UNSUBSCRIBE", "MESSAGE", "CALL_NOTES"].includes(t.tag));
/** The fill-ins a layout uses, so their values are only looked up when needed. */
export const layoutTags = (l: InvoiceLayout) => usedTags(l.footer.show ? l.footer.text : "", ...l.blocks.map((b) => b.text));
/** Fill-ins typed into a layout that an invoice can't fill (they'd print as nothing). */
export function unknownLayoutTags(l: InvoiceLayout): string[] {
  const ok = new Set(INVOICE_LAYOUT_TAGS.map((t) => t.tag));
  return layoutTags(l).filter((t) => !ok.has(t));
}

/** The custom-field details a layout shows, by field id. */
export const layoutFieldIds = (l: InvoiceLayout) => l.header.details.filter((d) => d.show && isFieldKey(d.key)).map((d) => d.key.slice(3));

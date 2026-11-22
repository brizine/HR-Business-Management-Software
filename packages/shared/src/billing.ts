import { z } from "zod";

/**
 * Billing (Phase 1): the services price list, invoices and the payments recorded against them.
 * Money is whole cents everywhere. ProSpray sells services only, so there's no sales tax.
 */

/* ───────────── Price list ───────────── */

export const PRICING_KINDS = ["flat", "per_thousand", "bracket"] as const;
export type PricingKind = (typeof PRICING_KINDS)[number];
export const PRICING_LABELS: Record<PricingKind, string> = { flat: "Flat price", per_thousand: "Per 1,000 sq ft", bracket: "By lawn size" };

/** Income accounts a service can post to (codes in the books; the same in the real and test books). */
export const INCOME_ACCOUNTS = [
  { code: "4000", name: "Lawn Treatment Programs" },
  { code: "4100", name: "Pest Control Services" },
  { code: "4200", name: "One-Time Lawn Services" },
  { code: "4950", name: "Other Income" },
] as const;

const cents = z.number().int().nonnegative().max(100_000_000);

export const bracketSchema = z.object({
  /** Lawns up to this size (sq ft) pay `priceCents`; the last bracket can leave it empty for "anything bigger". */
  upToSqFt: z.number().int().positive().max(10_000_000).nullable(),
  priceCents: cents,
});
export type Bracket = z.infer<typeof bracketSchema>;

export const serviceTypeSchema = z.object({
  name: z.string().trim().min(1, "Enter the service name").max(120),
  description: z.string().trim().max(1000).optional().transform((v) => v || undefined),
  pricing: z.enum(PRICING_KINDS).default("flat"),
  /** Flat: the price. Per 1,000 sq ft: the rate per 1,000. */
  priceCents: cents.default(0),
  /** Per 1,000 sq ft: never less than this. */
  minimumCents: cents.default(0),
  brackets: z.array(bracketSchema).max(30).default([]),
  incomeAccountCode: z.string().trim().regex(/^\d{3,6}$/, "Choose an income account").default("4000"),
  active: z.boolean().default(true),
}).superRefine((s, ctx) => {
  if (s.pricing === "bracket") {
    if (!s.brackets.length) ctx.addIssue({ code: "custom", path: ["brackets"], message: "Add at least one lawn-size bracket" });
    const sizes = s.brackets.map((b) => b.upToSqFt);
    sizes.forEach((v, i) => {
      if (v == null && i !== sizes.length - 1) ctx.addIssue({ code: "custom", path: ["brackets", i, "upToSqFt"], message: "Only the last bracket can be open-ended" });
      if (i > 0 && v != null && sizes[i - 1] != null && v <= (sizes[i - 1] as number)) ctx.addIssue({ code: "custom", path: ["brackets", i, "upToSqFt"], message: "Each bracket must be bigger than the one before" });
    });
  }
});
export type ServiceTypeInput = z.infer<typeof serviceTypeSchema>;

export interface PricedService { pricing: string; priceCents: number; minimumCents: number; brackets: Bracket[] }

/**
 * The price of one visit of a service for a lawn of `sqFt` (null when the size is unknown and the
 * price depends on it). Per-1,000 prices are rounded to the cent and never below the minimum.
 */
export function priceFor(s: PricedService, sqFt: number | null | undefined): number | null {
  if (s.pricing === "flat") return s.priceCents;
  if (sqFt == null || !Number.isFinite(sqFt) || sqFt <= 0) return null;
  if (s.pricing === "per_thousand") return Math.max(Math.round((s.priceCents * sqFt) / 1000), s.minimumCents);
  const hit = s.brackets.find((b) => b.upToSqFt == null || sqFt <= b.upToSqFt);
  return hit ? hit.priceCents : null;
}

/** "$45.00", "$1,250.50" (no cents shown as .00). */
export function formatMoney(c: number | null | undefined): string {
  if (c == null) return "—";
  const sign = c < 0 ? "-" : "";
  return `${sign}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How a service is priced, in words: "$45.00", "$4.25 per 1,000 sq ft (min $40.00)", "By lawn size: up to 5,000 sq ft $40.00, …". */
export function describePricing(s: PricedService): string {
  if (s.pricing === "flat") return formatMoney(s.priceCents);
  if (s.pricing === "per_thousand") return `${formatMoney(s.priceCents)} per 1,000 sq ft${s.minimumCents ? ` (min ${formatMoney(s.minimumCents)})` : ""}`;
  return s.brackets.map((b) => (b.upToSqFt == null ? `larger ${formatMoney(b.priceCents)}` : `up to ${b.upToSqFt.toLocaleString("en-US")} sq ft ${formatMoney(b.priceCents)}`)).join(" · ");
}

/* ───────────── Invoices ───────────── */

export const INVOICE_STATUSES = ["draft", "sent", "partial", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = { draft: "Draft", sent: "Unpaid", partial: "Partly paid", paid: "Paid", void: "Void" };

export const PAYMENT_METHODS = ["cash", "check", "card", "ach", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { cash: "Cash", check: "Check", card: "Card", ach: "Bank (ACH)", other: "Other" };
/** Recorded by hand in Phase 1; card and bank payments come through the portal (Stripe). */
export const MANUAL_PAYMENT_METHODS = ["cash", "check", "other"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const invoiceLineSchema = z.object({
  serviceTypeId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1, "Describe the line").max(500),
  /** Up to 2 decimals (e.g. 1.5 hours). */
  quantity: z.number().positive().max(100_000).multipleOf(0.01),
  unitPriceCents: z.number().int().min(-100_000_000).max(100_000_000),
  incomeAccountCode: z.string().trim().regex(/^\d{3,6}$/).default("4000"),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

export const DISCOUNT_KINDS = ["none", "amount", "percent"] as const;

export const invoiceSchema = z.object({
  customerId: z.string().uuid({ message: "Choose a customer" }),
  propertyId: z.string().uuid().nullable().optional(),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  poNumber: z.string().trim().max(60).optional().transform((v) => v || undefined),
  /** Shown on the invoice. */
  notes: z.string().trim().max(2000).optional().transform((v) => v || undefined),
  discountKind: z.enum(DISCOUNT_KINDS).default("none"),
  /** Cents for "amount"; percent (0–100, up to 2 decimals) for "percent". */
  discountValue: z.number().nonnegative().max(100_000_000).default(0),
  lines: z.array(invoiceLineSchema).min(1, "Add at least one line").max(100),
}).superRefine((v, ctx) => {
  if (v.discountKind === "percent" && v.discountValue > 100) ctx.addIssue({ code: "custom", path: ["discountValue"], message: "A percent discount can't be over 100" });
  if (v.issueDate && v.dueDate && v.dueDate < v.issueDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "The due date is before the invoice date" });
});
export type InvoiceInput = z.infer<typeof invoiceSchema>;

export interface InvoiceTotals { subtotalCents: number; discountCents: number; totalCents: number }

/** Line amounts, the discount (never more than the subtotal) and the total. */
export function invoiceTotals(lines: { quantity: number; unitPriceCents: number }[], discountKind: string, discountValue: number): InvoiceTotals {
  const subtotalCents = lines.reduce((s, l) => s + lineAmount(l), 0);
  let discountCents = 0;
  if (discountKind === "amount") discountCents = Math.round(discountValue);
  else if (discountKind === "percent") discountCents = Math.round((subtotalCents * discountValue) / 100);
  discountCents = Math.max(0, Math.min(discountCents, Math.max(subtotalCents, 0)));
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

export const lineAmount = (l: { quantity: number; unitPriceCents: number }) => Math.round(l.quantity * l.unitPriceCents);

export const sendInvoiceSchema = z.object({
  /** How to deliver it this time (defaults to the customer's preference). Text arrives in Phase 2. */
  via: z.array(z.enum(["email", "paper"])).min(1, "Choose email or paper").max(2),
  /** Send the email to this address instead of the customer's (contacts marked "copy on invoices" still get it). */
  emailTo: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal("").transform(() => undefined)),
  message: z.string().trim().max(2000).optional().transform((v) => v || undefined),
});

export const paymentSchema = z.object({
  amountCents: z.number().int().positive("Enter the amount").max(100_000_000),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  receivedOn: isoDate.optional(),
  /** Check number or other reference. */
  reference: z.string().trim().max(60).optional().transform((v) => v || undefined),
  note: z.string().trim().max(500).optional().transform((v) => v || undefined),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

export const voidSchema = z.object({ reason: z.string().trim().min(1, "Say why it's being voided").max(500) });

/** Company billing settings (Settings → Billing). */
export const billingSettingsSchema = z.object({
  /** The number the next invoice gets (continue from Service Autopilot at switch-over). */
  nextInvoiceNumber: z.number().int().positive().max(99_999_999),
  /** 0 = due on receipt. */
  termsDays: z.number().int().min(0).max(120),
  /** Printed at the bottom of every invoice (thank-you, guarantee, how to pay). */
  footer: z.string().trim().max(1000).default(""),
  /** "Make checks payable to" (defaults to the company name). */
  payableTo: z.string().trim().max(160).default(""),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;
export const DEFAULT_BILLING_SETTINGS: BillingSettings = { nextInvoiceNumber: 1001, termsDays: 0, footer: "", payableTo: "" };

export function termsLabel(days: number) {
  return days === 0 ? "Due on receipt" : `Net ${days}`;
}

/** An unpaid invoice past its due date. */
export const isOverdue = (i: { status: string; dueDate: string }, today: string) => (i.status === "sent" || i.status === "partial") && i.dueDate < today;

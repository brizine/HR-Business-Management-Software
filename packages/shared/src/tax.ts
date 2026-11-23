import { z } from "zod";

/**
 * Sales tax, like Homeworks': off until the company turns it on (Settings → Customers & billing).
 * Then a price-list item marked taxable gets the tax rate on each line it's on. The rate comes from
 * the property, else the customer, else the company default; a tax-exempt customer pays none. Each
 * line keeps its own rate (changeable), and the invoice's tax is the lines' tax added up and rounded
 * once (as Bigcapital does). An invoice discount is spread across the lines in proportion, so tax is
 * charged on what the customer actually pays.
 */

export const TAX_RATE_MAX = 30;
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const threeDecimals = (v: number) => Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6;

/** A rate in percent: 0 to 30, up to 3 decimals (8.625). */
export const taxRateSchema = z.coerce.number({ invalid_type_error: "Enter the tax rate as a number" })
  .min(0, "A tax rate can't be negative").max(TAX_RATE_MAX, `That's over ${TAX_RATE_MAX}%`).refine(threeDecimals, "Use up to 3 decimals (8.625)");
/** A rate that can be left blank (use the next one in line). */
export const optionalTaxRateSchema = z.preprocess(blankToNull, taxRateSchema.nullable()).optional();

/** "8.625%", "0%". */
export const formatTaxRate = (r: number | null | undefined) => `${Number((r ?? 0).toFixed(3))}%`;

export interface TaxSettings { taxEnabled?: boolean; defaultTaxRate?: number | null }

/**
 * The rate for a taxable line: 0 with sales tax off or for a tax-exempt customer; otherwise the
 * property's rate, else the customer's, else the company default (Homeworks' order).
 */
export function taxRateFor(o: { settings: TaxSettings; customer?: { taxExempt?: boolean | null; taxRate?: number | null } | null; property?: { taxRate?: number | null } | null }) {
  if (!o.settings.taxEnabled || o.customer?.taxExempt) return 0;
  return o.property?.taxRate ?? o.customer?.taxRate ?? o.settings.defaultTaxRate ?? 0;
}
/** A new line's rate: the rate when its price-list item is taxable, else 0. */
export const lineTaxRate = (taxable: boolean | null | undefined, rate: number) => (taxable ? rate : 0);

type TaxLine = { quantity: number; unitPriceCents: number; taxRate?: number | null };
const amountOf = (l: TaxLine) => Math.round(l.quantity * l.unitPriceCents);

/** Each line's taxable amount after its share of the invoice discount (unrounded cents). */
export function taxableAmounts(lines: TaxLine[], discountCents = 0) {
  const subtotal = lines.reduce((s, l) => s + amountOf(l), 0);
  return lines.map((l) => {
    const amount = amountOf(l);
    const share = discountCents > 0 && subtotal > 0 ? (discountCents * amount) / subtotal : 0;
    return { amount: amount - share, rate: l.taxRate ?? 0 };
  });
}

/** The tax on the lines: each line's taxable amount × its rate, added up, rounded once to the cent. */
export function taxFor(lines: TaxLine[], discountCents = 0) {
  const raw = taxableAmounts(lines, discountCents).reduce((s, l) => s + (l.amount * l.rate) / 100, 0);
  return Math.round(raw + 1e-9);
}

/**
 * Taxable and tax by rate, for the invoice and the sales tax report: the taxed lines grouped by rate
 * (each rounded), plus what wasn't taxed.
 */
export function taxBreakdown(lines: TaxLine[], discountCents = 0) {
  const groups = new Map<number, number>();
  let untaxed = 0;
  for (const l of taxableAmounts(lines, discountCents)) {
    if (l.rate > 0) groups.set(l.rate, (groups.get(l.rate) ?? 0) + l.amount);
    else untaxed += l.amount;
  }
  return {
    untaxedCents: Math.round(untaxed),
    rates: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([rate, amount]) => ({ rate, taxableCents: Math.round(amount), taxCents: Math.round((amount * rate) / 100 + 1e-9) })),
  };
}

import { z } from "zod";
import { MIX_UNITS } from "./sprayMix";

/**
 * Products: the chemicals and fertilizers the company applies, each listed once with what
 * budgeting and chemical records need. (The Spray Mix Calculator stays the techs' tank tool.)
 *
 * Amounts are kept in the product's "use unit" (ounces liquid, pounds dry …). It is bought in a
 * purchase unit (a 2.5 gal jug = 320 ounces liquid) at a cost that changes over time, so:
 *   cost per use unit     = cost per purchase unit ÷ purchase unit size
 *   cost per 1,000 sq ft  = rate amount per 1,000 × cost per use unit
 */

export const PRODUCT_TYPES = ["herbicide", "insecticide", "fungicide", "fertilizer", "growth_regulator", "adjuvant", "soil_amendment", "colorant", "other"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  herbicide: "Herbicide", insecticide: "Insecticide", fungicide: "Fungicide", fertilizer: "Fertilizer", growth_regulator: "Growth regulator",
  adjuvant: "Adjuvant / surfactant", soil_amendment: "Soil amendment", colorant: "Colorant / dye", other: "Other",
};

export const FORMULATIONS = ["liquid", "flowable", "ec", "wg", "wp", "sp", "granular", "other"] as const;
export type Formulation = (typeof FORMULATIONS)[number];
export const FORMULATION_LABELS: Record<Formulation, string> = {
  liquid: "Liquid", flowable: "Flowable (FL / SC)", ec: "Emulsifiable concentrate (EC)", wg: "Water-dispersible granule (WG / WDG)",
  wp: "Wettable powder (WP)", sp: "Soluble powder (SP)", granular: "Granular", other: "Other",
};

export const SIGNAL_WORDS = ["none", "caution", "warning", "danger"] as const;
export const SIGNAL_WORD_LABELS: Record<(typeof SIGNAL_WORDS)[number], string> = { none: "None", caution: "Caution", warning: "Warning", danger: "Danger" };

export const APPLICATION_METHODS = ["truck_spray", "backpack", "push_spreader", "ride_on_spreader", "other"] as const;
export type ApplicationMethod = (typeof APPLICATION_METHODS)[number];
export const APPLICATION_METHOD_LABELS: Record<ApplicationMethod, string> = {
  truck_spray: "Spray – truck", backpack: "Spray – backpack", push_spreader: "Spreader – push", ride_on_spreader: "Spreader – ride-on", other: "Other",
};

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const amount = z.number().nonnegative().max(1_000_000);

export const activeIngredientSchema = z.object({
  name: text(120).min(1, "Name the active ingredient"),
  percent: z.number().min(0).max(100).nullable().default(null),
});
export type ActiveIngredient = z.infer<typeof activeIngredientSchema>;

export const productRateSchema = z.object({
  /** Kept when editing so links to this rate (services, records) survive. */
  id: z.string().uuid().optional(),
  name: text(60).min(1, "Name the rate (e.g. High, Round 1)"),
  /** Product per 1,000 sq ft, in the product's use unit. */
  amountPer1000: amount.refine((n) => n > 0, "Enter the amount per 1,000 sq ft"),
  method: z.enum(APPLICATION_METHODS).default("truck_spray"),
  /** Spray volume (water + product) per 1,000 sq ft, in gallons; null for dry products. */
  carrierGalPer1000: amount.nullable().default(null),
});
export type ProductRateInput = z.infer<typeof productRateSchema>;

export const productSchema = z
  .object({
    name: text(120).min(1, "Name the product"),
    manufacturer: optText(120),
    productType: z.enum(PRODUCT_TYPES).default("other"),
    formulation: z.enum(FORMULATIONS).nullable().default(null),
    activeIngredients: z.array(activeIngredientSchema).max(10).default([]),
    epaRegNo: optText(40),
    restrictedUse: z.boolean().default(false),
    signalWord: z.enum(SIGNAL_WORDS).default("none"),
    /** Re-entry interval, in hours ("until dry" products: 0 with a note in the label instructions). */
    reiHours: z.number().nonnegative().max(1000).nullable().default(null),
    /** Weeds, pests or diseases it controls. */
    targets: optText(1000),
    /** The unit rates, costs and amounts used are kept in. */
    useUnit: z.enum(MIX_UNITS),
    /** What it's bought in, e.g. "2.5 gal jug", and how many use units that holds (320). */
    purchaseUnitName: optText(60),
    purchaseUnitSize: amount.refine((n) => n > 0, "Enter how much one purchase unit holds").nullable().default(null),
    /** Label maximum per application, per 1,000 sq ft, in the use unit. */
    labelMaxPer1000: amount.nullable().default(null),
    /** Label maximum per year, per 1,000 sq ft, in the use unit. */
    labelMaxPerYearPer1000: amount.nullable().default(null),
    labelInstructions: optText(10_000),
    /** Printed on the route sheet and the after-visit message (watering-in, keep pets off …). */
    customerNote: optText(2000),
    incomeAccountCode: optText(20),
    cogsAccountCode: optText(20),
    taxable: z.boolean().default(false),
    /** Record every application of it (state chemical records). */
    trackRecords: z.boolean().default(true),
    active: z.boolean().default(true),
    rates: z.array(productRateSchema).max(20).default([]),
  })
  .superRefine((p, ctx) => {
    const names = new Set<string>();
    p.rates.forEach((r, i) => {
      const key = r.name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", path: ["rates", i, "name"], message: "Two rates have the same name" });
      names.add(key);
      if (p.labelMaxPer1000 != null && r.amountPer1000 > p.labelMaxPer1000) ctx.addIssue({ code: "custom", path: ["rates", i, "amountPer1000"], message: "Above the label maximum per application" });
    });
  });
export type ProductInput = z.infer<typeof productSchema>;

export const productCostSchema = z.object({
  /** What one purchase unit costs, in cents. */
  costPerPurchaseUnitCents: z.number().int().nonnegative().max(100_000_000),
  vendor: optText(120),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
});
export type ProductCostInput = z.infer<typeof productCostSchema>;

/** The cost in force on a day: the latest one that started on or before it. */
export function costOn<C extends { effectiveFrom: string }>(costs: C[], day: string): C | null {
  let best: C | null = null;
  for (const c of costs) if (c.effectiveFrom <= day && (!best || c.effectiveFrom > best.effectiveFrom)) best = c;
  return best;
}

/** Cents per use unit (can have fractions), or null without a cost or a purchase size. */
export function costPerUseUnitCents(costPerPurchaseUnitCents: number | null | undefined, purchaseUnitSize: number | null | undefined) {
  if (costPerPurchaseUnitCents == null || !purchaseUnitSize || purchaseUnitSize <= 0) return null;
  return costPerPurchaseUnitCents / purchaseUnitSize;
}

/** Cents of product per 1,000 sq ft at a rate (can have fractions), or null without a unit cost. */
export function rateCostPer1000Cents(amountPer1000: number, perUseUnitCents: number | null) {
  return perUseUnitCents == null ? null : amountPer1000 * perUseUnitCents;
}

/** "1.17 oz liquid" style: amounts with up to 3 decimals and a short unit. */
export function formatRateAmount(n: number, unit: string) {
  const short = unit.replace(/^ounces/, "oz").replace(/^pounds/, "lb").replace(/^gallons$/, "gal").replace(/^quarts$/, "qt").replace(/^pints$/, "pt").replace(/^grams$/, "g").replace(/^milliliters$/, "mL");
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${short}`;
}

/** A product a service applies, at one of its rates, optionally only between two dates (a seasonal swap). */
export const serviceProductSchema = z
  .object({
    productId: z.string().uuid(),
    productRateId: z.string().uuid(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  })
  .refine((s) => !s.startDate || !s.endDate || s.startDate <= s.endDate, { message: "The end date is before the start date", path: ["endDate"] });
export const serviceProductsSchema = z.object({ products: z.array(serviceProductSchema).max(30) });
export type ServiceProductInput = z.infer<typeof serviceProductSchema>;

/** Whether a service's product applies on a day (no dates = always). */
export const appliesOn = (s: { startDate: string | null; endDate: string | null }, day: string) =>
  (!s.startDate || s.startDate <= day) && (!s.endDate || day <= s.endDate);

/**
 * Budgeted material (product cost) for a line, from the service's products and the lawn, rounded to
 * the cent; null when the service has no products or the lawn has no size. Budgeted hours are not
 * worked out here: they come from the service and the property's own clock history (waiting list).
 */
export function lineMaterialCents(s: { materialPer1000Cents?: number | null }, sqFt: number | null | undefined, quantity = 1) {
  const size = sqFt != null && Number.isFinite(sqFt) && sqFt > 0 ? sqFt : null;
  return size != null && s.materialPer1000Cents != null ? Math.round((s.materialPer1000Cents * size * quantity) / 1000) : null;
}

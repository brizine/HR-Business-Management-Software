import { z } from "zod";

/**
 * Fuel log: each fill-up for an asset (gas, diesel, CNG, propane, DEF…), with cost and the meter
 * reading, giving fuel economy (MPG or gallons per engine hour), cost per mile, and with
 * maintenance and the purchase price, total cost of ownership.
 */
export const FUEL_TYPES = ["gasoline", "diesel", "cng", "propane", "def", "other"] as const;
export type FuelType = (typeof FUEL_TYPES)[number];
export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  gasoline: "Gasoline",
  diesel: "Diesel",
  cng: "CNG",
  propane: "Propane",
  def: "DEF",
  other: "Other",
};
/** CNG is sold and measured in gasoline gallon equivalents (GGE); everything else in gallons. */
export const fuelUnit = (t: string) => (t === "cng" ? "GGE" : "gal");
/** DEF (diesel exhaust fluid) costs money but isn't fuel, so it's left out of fuel economy. */
export const countsForEconomy = (t: string) => t !== "def";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const fuelEntrySchema = z.object({
  assetId: z.string().uuid(),
  date: isoDate,
  fuelType: z.enum(FUEL_TYPES),
  /** Gallons (GGE for CNG). */
  quantity: z.number().positive("Enter how much").max(10_000),
  totalCostCents: z.number().int().nonnegative().max(10_000_000),
  odometer: z.number().nonnegative().nullable().optional(),
  hours: z.number().nonnegative().nullable().optional(),
  /** Filled to full: needed to work out fuel economy between fill-ups. */
  fullTank: z.boolean().default(true),
  vendor: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type FuelEntryInput = z.infer<typeof fuelEntrySchema>;
export const fuelEntryUpdateSchema = fuelEntrySchema.omit({ assetId: true });

export interface FuelLike {
  id: string;
  date: string;
  fuelType: string;
  quantity: number;
  totalCostCents: number;
  odometer: number | null;
  hours: number | null;
  fullTank: boolean;
}

export interface Economy {
  /** Miles (or engine hours) covered by complete full-tank-to-full-tank stretches. */
  distance: number;
  /** Fuel used over those stretches (gallons / GGE). */
  quantity: number;
  costCents: number;
  /** distance ÷ quantity: MPG, or hours per gallon (use quantity ÷ distance for gallons per hour). */
  perUnit: number | null;
  /** Fuel cost per mile (or per hour) over those stretches. */
  costPerDistanceCents: number | null;
  /** The economy of the stretch each full fill-up closed, by entry id. */
  byEntry: Record<string, number>;
}

/**
 * Fuel economy by the full-tank method: from one full fill-up to the next, distance on the meter
 * ÷ fuel put in after the first (inclusive of the closing fill). Partial fills add to the stretch;
 * DEF is ignored; a fill without a meter reading, or a meter going backwards, restarts.
 */
export function fuelEconomy(entries: FuelLike[], meter: "odometer" | "hours"): Economy {
  const list = entries.filter((e) => countsForEconomy(e.fuelType))
    .sort((a, b) => a.date.localeCompare(b.date) || (a[meter] ?? 0) - (b[meter] ?? 0));
  let last: number | null = null;
  let qty = 0, cost = 0, distance = 0, totalQty = 0, totalCost = 0;
  const byEntry: Record<string, number> = {};
  for (const e of list) {
    const m = e[meter];
    if (last == null) {
      if (e.fullTank && m != null && m > 0) last = m;
      continue;
    }
    qty += e.quantity;
    cost += e.totalCostCents;
    if (!e.fullTank) continue;
    if (m == null || m <= last) { last = m != null && m > 0 ? m : null; qty = 0; cost = 0; continue; }
    const d = m - last;
    byEntry[e.id] = d / qty;
    distance += d; totalQty += qty; totalCost += cost;
    last = m; qty = 0; cost = 0;
  }
  return {
    distance,
    quantity: totalQty,
    costCents: totalCost,
    perUnit: totalQty > 0 && distance > 0 ? distance / totalQty : null,
    costPerDistanceCents: distance > 0 ? totalCost / distance : null,
    byEntry,
  };
}

/** Totals for a list of fill-ups: fuel (not DEF) gallons, all spending, average price. */
export function fuelTotals(entries: FuelLike[]) {
  const fuel = entries.filter((e) => countsForEconomy(e.fuelType));
  const quantity = fuel.reduce((t, e) => t + e.quantity, 0);
  const fuelCost = fuel.reduce((t, e) => t + e.totalCostCents, 0);
  const defQuantity = entries.filter((e) => e.fuelType === "def").reduce((t, e) => t + e.quantity, 0);
  return {
    fills: entries.length,
    quantity,
    defQuantity,
    costCents: entries.reduce((t, e) => t + e.totalCostCents, 0),
    avgPriceCents: quantity > 0 ? fuelCost / quantity : null,
  };
}

/**
 * Total cost of ownership: purchase price + maintenance + fuel, and per mile / engine hour since
 * purchase (operating cost leaves out the purchase price).
 */
export function totalCostOfOwnership(a: {
  purchasePriceCents: number | null; maintenanceCents: number; fuelCents: number;
  odometer: number; engineHours: number; purchaseOdometer: number | null; purchaseHours: number | null; purchaseDate: string | null;
}, today = new Date().toISOString().slice(0, 10)) {
  const total = (a.purchasePriceCents ?? 0) + a.maintenanceCents + a.fuelCents;
  const operating = a.maintenanceCents + a.fuelCents;
  const miles = a.odometer - (a.purchaseOdometer ?? 0);
  const hours = a.engineHours - (a.purchaseHours ?? 0);
  const years = a.purchaseDate ? Math.max((Date.parse(today) - Date.parse(a.purchaseDate)) / (365.25 * 86_400_000), 0) : null;
  return {
    totalCents: total,
    operatingCents: operating,
    miles: miles > 0 ? miles : 0,
    hours: hours > 0 ? hours : 0,
    perMileCents: miles > 0 ? total / miles : null,
    operatingPerMileCents: miles > 0 ? operating / miles : null,
    perHourCents: hours > 0 ? total / hours : null,
    operatingPerHourCents: hours > 0 ? operating / hours : null,
    perYearCents: years && years >= 0.08 ? total / years : null,
    years,
  };
}

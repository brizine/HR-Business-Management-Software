import { z } from "zod";

/**
 * Spray Mix Calculator, from ProSpray's "Spray Tank Fill" spreadsheet.
 *
 * Each mix sheet sprays water at a fixed rate (gallons per acre). For each
 * product, with its rate per acre:
 *   rate per 1,000 ft²  = rate per acre ÷ 43.56          (43,560 ft² per acre)
 *   product for a tank  = rate per acre × tank gallons ÷ gallons per acre
 * e.g. Truck Mix at 87.12 gal/acre: a 75-gal tank covers 0.86 acre, so it
 * gets 0.86 × each product's per-acre rate.
 */
export const SQFT_PER_ACRE = 43_560;

export const MIX_UNITS = ["ounces liquid", "ounces dry", "pounds dry", "pounds liquid", "gallons", "quarts", "pints", "grams", "milliliters"] as const;

export interface MixProductLike {
  id?: string;
  name: string;
  ratePerAcre: number;
  unit: string;
}

export interface MixResultRow<P extends MixProductLike> {
  product: P;
  ratePer1000: number;
  needed: number;
}

export function computeMix<P extends MixProductLike>(sheet: { gallonsPerAcre: number; products: P[] }, tankGallons: number) {
  const gpa = sheet.gallonsPerAcre > 0 ? sheet.gallonsPerAcre : NaN;
  const tank = Number.isFinite(tankGallons) && tankGallons > 0 ? tankGallons : 0;
  const acres = tank / gpa;
  return {
    acres,
    squareFeet: acres * SQFT_PER_ACRE,
    gallonsPer1000: gpa / (SQFT_PER_ACRE / 1000),
    rows: sheet.products.map((p): MixResultRow<P> => ({
      product: p,
      ratePer1000: p.ratePerAcre / (SQFT_PER_ACRE / 1000),
      needed: (p.ratePerAcre * tank) / gpa,
    })),
  };
}

/** Numbers someone typed in (rates, gallons per acre, tank size): shown exactly, up to 3 decimals. */
export const formatEntered = (n: number) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "—");

/** Calculated amounts as people measure them: more decimals for small amounts. */
export function formatAmount(n: number) {
  if (!Number.isFinite(n)) return "—";
  const digits = n === 0 ? 0 : Math.abs(n) < 1 ? 3 : Math.abs(n) < 10 ? 2 : 1;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const mixSheetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  gallonsPerAcre: z.number().positive().max(10_000),
  defaultTankGallons: z.number().positive().max(100_000),
  notes: z.string().trim().max(500).optional(),
});

export const mixProductSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ratePerAcre: z.number().min(0).max(1_000_000),
  unit: z.string().trim().min(1).max(40),
});

/** The two mixes from the original spreadsheet, as a starting point. */
export const SPRAY_MIX_TEMPLATE: { name: string; gallonsPerAcre: number; defaultTankGallons: number; notes?: string; products: MixProductLike[] }[] = [
  {
    name: "Truck Mix",
    gallonsPerAcre: 87.12,
    defaultTankGallons: 75,
    products: [
      ["Flumioxazin 51%", 15, "ounces dry"],
      ["Specticle Flo", 5, "ounces liquid"],
      ["Aquacap", 47.9, "ounces liquid"],
      ["Resolute 65WG DRY", 19, "ounces dry"],
      ["Resolute 4FL Liquid", 24, "ounces liquid"],
      ["Ranger Pro 41%", 48, "ounces liquid"],
      ["90/10 Surfactant", 28, "ounces liquid"],
      ["Ranger Pro 53%", 37, "ounces liquid"],
      ["Vessel/Acid Blue 9 Dye", 64, "ounces liquid"],
      ["SensiPro Dye", 8.71, "ounces dry"],
      ["Monument 75WG", 0.25, "ounces dry"],
      ["Celcius WG High rate", 4.9, "ounces dry"],
      ["Celsius WG Med. rate", 3.7, "ounces dry"],
      ["MSM", 0.25, "ounces dry"],
      ["46-0-0", 95, "pounds dry"],
      ["15-1-1 Fish Protien", 6, "ounces dry"],
    ].map(([name, ratePerAcre, unit]) => ({ name: name as string, ratePerAcre: ratePerAcre as number, unit: unit as string })),
  },
  {
    name: "Z spray Mix",
    gallonsPerAcre: 11.1,
    defaultTankGallons: 12,
    notes: "Green Tips/4MPH",
    products: [
      ["Flumioxazin 51%", 15, "ounces dry"],
      ["Specticle Flo", 6, "ounces liquid"],
      ["Aquacap", 12, "ounces liquid"],
      ["Resolute 65WG DRY", 19, "ounces dry"],
      ["Resolute 4FL Liquid", 10, "ounces liquid"],
      ["Ranger Pro 41%", 37, "ounces liquid"],
      ["90/10 Surfactant", 28, "ounces liquid"],
      ["Ranger Pro 53%", 12.3, "ounces liquid"],
      ["Vessel", 64, "ounces liquid"],
      ["Acid Blue 9 Dye", 80, "ounces liquid"],
      ["Monument 75WG", 0.53, "ounces dry"],
      ["Celcius WG High rate", 4.9, "ounces dry"],
      ["Celsius WG Med. rate", 3.7, "ounces dry"],
      ["MSM", 0.33, "ounces dry"],
    ].map(([name, ratePerAcre, unit]) => ({ name: name as string, ratePerAcre: ratePerAcre as number, unit: unit as string })),
  },
];

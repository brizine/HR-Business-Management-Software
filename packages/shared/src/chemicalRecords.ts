import { z } from "zod";

/**
 * Chemical application records for Oklahoma (ODAFF): OAC 35:30-17-21(a) lists what a commercial
 * applicator's record must show, at a minimum. CrewDesk fills a record from the completed work order
 * and lists anything missing as an issue for the office to fix. Items 20–21 (contracts and wood
 * infestation reports) are for structural / termite work and aren't kept here.
 */
export const ODAFF_RULE = "OAC 35:30-17-21(a)";

/** The 22 items of 35:30-17-21(a), in the rule's order (numbers as in the rule). */
export const ODAFF_ITEMS: { n: number; text: string }[] = [
  { n: 1, text: "Start and stop time of application" },
  { n: 2, text: "Total amount of pesticide used" },
  { n: 3, text: "Name and address of the company" },
  { n: 4, text: "Certified applicator's name, certification number and expiration date" },
  { n: 5, text: "Name and address of the person for whom applied" },
  { n: 6, text: "Legal description of the land (street address, not a PO Box)" },
  { n: 7, text: "Date of application" },
  { n: 8, text: "Application rate" },
  { n: 9, text: "Dilution rate for mixing" },
  { n: 10, text: "Total quantity tank mix used" },
  { n: 11, text: "Complete trade name of the product" },
  { n: 12, text: "EPA registration number" },
  { n: 13, text: "Adjuvants, when the label requires specific ones" },
  { n: 14, text: "Drift agents, when the label requires specific ones" },
  { n: 15, text: "Target pest" },
  { n: 16, text: "Site where applied" },
  { n: 17, text: "Size of the area treated" },
  { n: 18, text: "Restricted entry interval from the label" },
  { n: 19, text: "Copy of the product label" },
  { n: 20, text: "Copies of contracts issued (structural only)" },
  { n: 21, text: "Copies of wood infestation reports (structural only)" },
  { n: 22, text: "Other information as the Board requires" },
];

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** An employee's applicator certification. */
export const applicatorCertSchema = z.object({
  certNo: z.string().trim().min(1, "Enter the certification number").max(40),
  expiresOn: isoDate,
  categories: z.preprocess(blankToNull, z.string().trim().max(120).nullable()).optional(),
});
export type ApplicatorCertInput = z.infer<typeof applicatorCertSchema>;

export const chemicalSettingsSchema = z.object({
  pesticideLicenseNo: z.preprocess(blankToNull, z.string().trim().max(40).nullable()),
});

/** A correction to a record: only the fields sent change; every change is logged with the reason. */
export const recordCorrectionSchema = z.object({
  reason: z.string().trim().min(3, "Say why it's being corrected").max(500),
  startedAt: z.string().datetime({ offset: true }).nullable().optional(),
  stoppedAt: z.string().datetime({ offset: true }).nullable().optional(),
  site: z.preprocess(blankToNull, z.string().trim().max(200).nullable()).optional(),
  areaSqFt: z.number().positive().max(100_000_000).nullable().optional(),
  tankMixGal: z.number().nonnegative().max(1_000_000).nullable().optional(),
  products: z.array(z.object({
    id: z.string().uuid(),
    amount: z.number().nonnegative().max(1_000_000).optional(),
    targets: z.preprocess(blankToNull, z.string().trim().max(500).nullable()).optional(),
  })).max(30).optional(),
}).refine((c) => !c.startedAt || !c.stoppedAt || c.startedAt <= c.stoppedAt, { message: "The stop time is before the start time", path: ["stoppedAt"] });
export type RecordCorrection = z.infer<typeof recordCorrectionSchema>;

/** "PO Box 12", "P.O. Box", "Post Office Box": not a legal description (item 6). */
export const isPoBox = (address: string | null | undefined) => !!address && /\b(p\.?\s*o\.?|post\s+office)\s*box\s*#?\s*\d/i.test(address);

/** Product per gallon of spray (item 9), or null when it's applied dry. */
export const dilutionPerGal = (ratePer1000: number, carrierGalPer1000: number | null | undefined) =>
  carrierGalPer1000 && carrierGalPer1000 > 0 ? ratePer1000 / carrierGalPer1000 : null;

/** Spray gallons used (item 10): the largest spray volume among the mixed products × the area (one tank mix). */
export function tankMixGallons(products: { carrierGalPer1000: number | null }[], areaSqFt: number | null) {
  const carriers = products.map((p) => p.carrierGalPer1000).filter((c): c is number => c != null && c > 0);
  if (!carriers.length || !areaSqFt) return null;
  return (Math.max(...carriers) * areaSqFt) / 1000;
}

export interface RecordForCheck {
  companyName: string | null; companyAddress: string | null;
  applicatorName: string | null; applicatorCertNo: string | null; applicatorCertExpires: string | null;
  customerName: string | null; customerAddress: string | null; siteAddress: string | null;
  appliedOn: string; startedAt: string | Date | null; stoppedAt: string | Date | null;
  site: string | null; areaSqFt: number | null;
  products: { tradeName: string; epaRegNo: string | null; productType: string | null; amount: number; targets: string | null; reiHours: number | null; labelId: string | null; carrierGalPer1000: number | null; requiredAdjuvant?: string | null; requiredDriftAgent?: string | null }[];
}

/** What a record is missing or has wrong, each with the rule's item number. Empty = complete. */
export function recordIssues(r: RecordForCheck): string[] {
  const out: string[] = [];
  const pesticides = r.products.filter((p) => p.productType !== "adjuvant" && p.productType !== "fertilizer");
  if (!r.startedAt || !r.stoppedAt) out.push("1: Start or stop time missing (the work order wasn't started with Start)");
  if (!r.products.length) out.push("2: No products recorded (add products to the service on Items & services)");
  if (!r.companyName || !r.companyAddress) out.push("3: Company address missing (Settings → Company)");
  if (!r.applicatorCertNo || !r.applicatorCertExpires) out.push(`4: ${r.applicatorName ?? "The applicator"} has no certification on file`);
  else if (r.applicatorCertExpires < r.appliedOn) out.push(`4: ${r.applicatorName}'s certification expired ${r.applicatorCertExpires}`);
  if (!r.customerName || !r.customerAddress) out.push("5: Customer address missing");
  if (!r.siteAddress) out.push("6: Property street address missing");
  else if (isPoBox(r.siteAddress)) out.push("6: The property address is a PO Box; it needs the street address");
  if (!r.site) out.push("16: Site where applied missing (set it on the service)");
  if (!r.areaSqFt) out.push("17: Area treated missing (the property has no lawn size)");
  for (const p of pesticides) {
    if (!p.epaRegNo) out.push(`12: ${p.tradeName} has no EPA registration number`);
    if (!p.targets) out.push(`15: ${p.tradeName} has no target pest`);
    if (p.reiHours == null) out.push(`18: ${p.tradeName} has no restricted entry interval`);
    if (!p.labelId) out.push(`19: ${p.tradeName} has no label on file`);
  }
  const names = r.products.map((p) => p.tradeName.toLowerCase());
  const has = (want: string) => names.some((n) => n.includes(want.toLowerCase()));
  for (const p of r.products) {
    if (p.requiredAdjuvant && !has(p.requiredAdjuvant)) out.push(`13: ${p.tradeName}'s label requires ${p.requiredAdjuvant}, which isn't on this application`);
    if (p.requiredDriftAgent && !has(p.requiredDriftAgent)) out.push(`14: ${p.tradeName}'s label requires ${p.requiredDriftAgent}, which isn't on this application`);
  }
  return out;
}

/** A CSV cell: quoted when needed, and guarded against spreadsheet formulas. */
export function csvCell(v: unknown) {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

/** An application method (Chemical Tracking): its name and spray volume; no volume = applied dry. */
export const applicationMethodSchema = z.object({
  name: z.string().trim().min(1, "Name the method").max(80),
  galPer1000: z.number().positive().max(1000).nullable(),
  active: z.boolean().default(true),
});
/** A starting list, like the Spray Mix Calculator's sheets, plus a spreader for dry products. */
export const DEFAULT_APPLICATION_METHODS: { name: string; galPer1000: number | null }[] = [
  { name: "Truck 2gal/1000ft", galPer1000: 2 },
  { name: "Truck 1.5gal/1000ft", galPer1000: 1.5 },
  { name: "Backpack 1gal/1000ft", galPer1000: 1 },
  { name: "ZSpray (Green Tips)", galPer1000: 0.2548 },
  { name: "Spreader (not mixed)", galPer1000: null },
];

/** A mix: products that go in one tank together, each at its rate, applied one way. */
export const chemicalMixSchema = z.object({
  name: z.string().trim().min(1, "Name the mix").max(80),
  applicationMethodId: z.string().uuid("Pick how the mix is applied"),
  notes: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).optional(),
  active: z.boolean().default(true),
  items: z.array(z.object({
    productId: z.string().uuid("Pick a product"),
    ratePer1000: z.number().positive("Enter the rate").max(1_000_000),
  })).min(1, "Add at least one product").max(20),
});
export type ChemicalMixInput = z.infer<typeof chemicalMixSchema>;

/** "How it was applied" for a dry product: no spray mix. */
export const DRY_METHOD = "dry";
export const DRY_METHOD_LABEL = "Spreader (not mixed)";

/** Gallons of spray per 1,000 sq ft for a Spray Mix sheet's gallons per acre (87.12 → 2). */
export const galPer1000FromAcre = (gallonsPerAcre: number) => gallonsPerAcre / 43.56;
/** A Spray Mix sheet's product rate per acre as a rate per 1,000 sq ft. */
export const per1000FromAcre = (ratePerAcre: number) => ratePerAcre / 43.56;

/**
 * What the tech confirms when completing a chemical work order: for each product, whether it was
 * used, how it was applied (an application method), the rate and the amount, and the mix it came in (if any); and the area and
 * site, when they differ from the property and the service.
 */
export const chemicalCompletionSchema = z.object({
  areaSqFt: z.number().positive().max(100_000_000).nullable().optional(),
  site: z.preprocess(blankToNull, z.string().trim().max(200).nullable()).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    used: z.boolean().default(true),
    methodId: z.string().uuid("Pick how it was applied"),
    ratePer1000: z.number().nonnegative().max(1_000_000),
    amount: z.number().nonnegative().max(1_000_000),
    /** Added as part of a mix (Chemical Tracking → Mixes): its name, kept on the record. */
    mixName: z.preprocess(blankToNull, z.string().trim().max(80).nullable()).optional(),
  })).max(40),
});
export type ChemicalCompletion = z.infer<typeof chemicalCompletionSchema>;

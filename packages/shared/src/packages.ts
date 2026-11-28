import { z } from "zod";
import { lineAmount, priceFor, type PricedService } from "./billing";
import { lineSqFt, type LawnSizes, type ServiceLawnArea } from "./lawnArea";

/**
 * Packages: a season program (like Service Autopilot's master packages). A package is a list of
 * rounds, each a price-list service with the window it's done in (start to end), the fewest days
 * since the property's last service, and a default rate and hours. Putting a package on a property
 * makes one waiting-list work order per round, priced for that lawn unless the round sets a rate.
 */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-04-15");

export const PACKAGE_ROUNDS_MAX = 30;

export const packageRoundSchema = z.object({
  /** An existing round keeps its id, so the work orders made from it stay linked. */
  id: z.string().uuid().optional(),
  /** What the round is called on the work order ("Early Spring"). */
  name: z.string().trim().min(1, "Name the round").max(120),
  serviceTypeId: z.string({ required_error: "Pick the round's service", invalid_type_error: "Pick the round's service" }).uuid({ message: "Pick the round's service" }),
  /** The window: on the waiting list from the start, due by the end. */
  startDate: z.preprocess(blankToNull, isoDate.nullable().refine((d) => d != null, "Give the round a start date")),
  endDate: z.preprocess(blankToNull, isoDate.nullable().refine((d) => d != null, "Give the round an end date")),
  /** At least this many days after the property's last service (blank or 0: no minimum). */
  minDays: z.preprocess(blankToNull, z.coerce.number().int().min(0).max(365).nullable()).optional(),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(999).nullable()).optional(),
  /** Blank: the service's price for the property's lawn. */
  unitPriceCents: z.preprocess(blankToNull, z.coerce.number().int().min(0, "Prices can't be negative").max(100_000_000).nullable()).optional(),
  /** For the crew: goes on the round's work order. */
  notes: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()).optional(),
});
export type PackageRoundInput = z.infer<typeof packageRoundSchema>;

export const packageSchema = z.object({
  name: z.string().trim().min(1, "Name the package").max(120),
  description: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).optional(),
  /** When the season ends and the package is renewed for the next one. */
  renewalDate: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  rounds: z.array(packageRoundSchema).min(1, "Add at least one round").max(PACKAGE_ROUNDS_MAX),
  active: z.boolean().default(true),
}).superRefine((p, ctx) => {
  p.rounds.forEach((r, i) => {
    if (r.startDate && r.endDate && r.endDate < r.startDate) ctx.addIssue({ code: "custom", path: ["rounds", i, "endDate"], message: `${r.name || "A round"} ends before it starts` });
  });
});
export type PackageInput = z.infer<typeof packageSchema>;

/** What happens to a property's package when the season ends. */
export const PACKAGE_RENEWALS = ["auto", "call", "none"] as const;
export type PackageRenewal = (typeof PACKAGE_RENEWALS)[number];
export const PACKAGE_RENEWAL_LABELS: Record<PackageRenewal, string> = { auto: "Auto renew", call: "Call to renew", none: "Do not renew" };

export const PROPERTY_PACKAGE_STATUSES = ["active", "paused", "cancelled"] as const;
export type PropertyPackageStatus = (typeof PROPERTY_PACKAGE_STATUSES)[number];
export const PROPERTY_PACKAGE_STATUS_LABELS: Record<PropertyPackageStatus, string> = { active: "Running", paused: "Paused", cancelled: "Cancelled" };

export const propertyPackageRoundSchema = z.object({
  roundId: z.string().uuid(),
  /** Unticked: this property doesn't get the round. */
  include: z.boolean().default(true),
  quantity: z.coerce.number().positive("The quantity must be more than 0").max(100_000).multipleOf(0.01).default(1),
  unitPriceCents: z.preprocess(blankToNull, z.coerce.number().int().min(0, "Prices can't be negative").max(100_000_000).nullable()).optional(),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(999).nullable()).optional(),
  /** A round whose window has already ended is left out unless this is ticked ("Schedule anyway"). */
  scheduleMissed: z.boolean().default(false),
});

/** Putting a package on a property. */
export const propertyPackageSchema = z.object({
  propertyId: z.string({ required_error: "Pick the property" }).uuid({ message: "Pick the property" }),
  packageId: z.string({ required_error: "Pick the package" }).uuid({ message: "Pick the package" }),
  renewal: z.enum(PACKAGE_RENEWALS).default("auto"),
  crewId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  notes: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()).optional(),
  rounds: z.array(propertyPackageRoundSchema).min(1).max(PACKAGE_ROUNDS_MAX),
}).superRefine((p, ctx) => {
  if (!p.rounds.some((r) => r.include)) ctx.addIssue({ code: "custom", path: ["rounds"], message: "Include at least one round" });
  p.rounds.forEach((r, i) => {
    if (r.include && r.unitPriceCents == null) ctx.addIssue({ code: "custom", path: ["rounds", i, "unitPriceCents"], message: "Give every included round a rate" });
  });
});
export type PropertyPackageInput = z.infer<typeof propertyPackageSchema>;

/** Changing a property's package afterwards: how it renews, who does it, its notes. */
export const propertyPackageUpdateSchema = z.object({
  renewal: z.enum(PACKAGE_RENEWALS),
  crewId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  notes: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()).optional(),
});

/** A round is missed once its window has ended: it isn't made unless somebody asks for it. */
export const roundMissed = (round: { endDate: string | null }, today: string) => !!round.endDate && round.endDate < today;

/**
 * A package's rounds (or any saved lines) as work order line items for a lawn: a set price wins,
 * otherwise the service's price for that lawn (null when it can't be worked out, e.g. no lawn size
 * yet). Give the property's sizes (not just a number) and each line is priced from the part of the
 * lawn its service covers.
 */
export function packageToLines(
  lines: { serviceTypeId?: string | null; description: string; quantity: number; budgetedHours?: number | null; unitPriceCents?: number | null }[],
  services: (PricedService & { id: string; defaultLawnArea?: string | null })[],
  lawn: number | LawnSizes | null | undefined,
) {
  const sizes: LawnSizes | null = typeof lawn === "number" ? { lawnSqFt: lawn } : lawn ?? null;
  return lines.map((l) => {
    const s = l.serviceTypeId ? services.find((x) => x.id === l.serviceTypeId) : undefined;
    // Only a whole property's sizes can say what "front" or "back" is; a bare number is the whole lawn.
    const lawnArea = (typeof lawn === "number" || !s?.defaultLawnArea ? "whole" : s.defaultLawnArea) as ServiceLawnArea;
    const price = l.unitPriceCents ?? (s ? priceFor(s, lineSqFt({ lawnArea }, sizes)) : null);
    return { serviceTypeId: l.serviceTypeId ?? null, description: l.description, quantity: l.quantity, budgetedHours: l.budgetedHours ?? null, unitPriceCents: price, lawnArea };
  });
}

/** What a package comes to for a lawn (null if any line can't be priced). */
export function packageTotal(lines: { quantity: number; unitPriceCents: number | null }[]) {
  return lines.some((l) => l.unitPriceCents == null) ? null : lines.reduce((s, l) => s + lineAmount({ quantity: l.quantity, unitPriceCents: l.unitPriceCents! }), 0);
}

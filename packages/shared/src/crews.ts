import { z } from "zod";
import { lineAmount, priceFor, type PricedService } from "./billing";

/**
 * Crews and packages (like Homeworks'). A crew is a named team (a lead, members and the truck they
 * take) that work orders go to. A package is a saved bundle of line items added to a work order in one
 * go; services in it are priced for each property's lawn unless the package sets a price.
 */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const crewSchema = z.object({
  name: z.string().trim().min(1, "Name the crew").max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color").default("#2563eb"),
  leadId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  memberIds: z.array(z.string().uuid()).max(50).default([]),
  /** Hours a day it can work (the waiting list's workload strip). */
  dailyHours: z.coerce.number().min(1).max(24).default(8),
  /** The truck or equipment the crew takes. */
  assetId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  notes: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).optional(),
  active: z.boolean().default(true),
  /** Editing: also give this crew's open work orders (today on) the new members. */
  updateOpenWorkOrders: z.boolean().default(false),
});
export type CrewInput = z.infer<typeof crewSchema>;

/** Everyone on the crew: the lead (if any) first, then the members, no repeats. */
export const crewPeople = (c: { leadId?: string | null; memberIds: string[] }) => [...new Set([...(c.leadId ? [c.leadId] : []), ...c.memberIds])];

export const packageLineSchema = z.object({
  serviceTypeId: z.preprocess(blankToNull, z.string().uuid().nullable()).optional(),
  description: z.string().trim().min(1, "Name the item").max(500),
  quantity: z.coerce.number().positive("The quantity must be more than 0").max(100_000).multipleOf(0.01).default(1),
  budgetedHours: z.preprocess(blankToNull, z.coerce.number().min(0).max(999).nullable()).optional(),
  /** Blank on a price list service: priced for the property's lawn when added. */
  unitPriceCents: z.preprocess(blankToNull, z.coerce.number().int().min(0, "Prices can't be negative").max(100_000_000).nullable()).optional(),
});
export type PackageLineInput = z.infer<typeof packageLineSchema>;

export const packageSchema = z.object({
  name: z.string().trim().min(1, "Name the package").max(120),
  description: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).optional(),
  lines: z.array(packageLineSchema).min(1, "Add at least one item").max(50),
  active: z.boolean().default(true),
}).superRefine((p, ctx) => {
  p.lines.forEach((l, i) => {
    if (!l.serviceTypeId && l.unitPriceCents == null) ctx.addIssue({ code: "custom", path: ["lines", i, "unitPriceCents"], message: "Give a custom item a price" });
  });
});
export type PackageInput = z.infer<typeof packageSchema>;

/**
 * A package's lines as work order line items for a lawn of `sqFt`: a set price wins, otherwise the
 * service's price for that lawn (null when it can't be worked out, e.g. no lawn size yet).
 */
export function packageToLines(
  lines: { serviceTypeId?: string | null; description: string; quantity: number; budgetedHours?: number | null; unitPriceCents?: number | null }[],
  services: (PricedService & { id: string })[],
  sqFt: number | null | undefined,
) {
  return lines.map((l) => {
    const s = l.serviceTypeId ? services.find((x) => x.id === l.serviceTypeId) : undefined;
    const price = l.unitPriceCents ?? (s ? priceFor(s, sqFt) : null);
    return { serviceTypeId: l.serviceTypeId ?? null, description: l.description, quantity: l.quantity, budgetedHours: l.budgetedHours ?? null, unitPriceCents: price };
  });
}

/** What a package comes to for a lawn (null if any line can't be priced). */
export function packageTotal(lines: { quantity: number; unitPriceCents: number | null }[]) {
  return lines.some((l) => l.unitPriceCents == null) ? null : lines.reduce((s, l) => s + lineAmount({ quantity: l.quantity, unitPriceCents: l.unitPriceCents! }), 0);
}

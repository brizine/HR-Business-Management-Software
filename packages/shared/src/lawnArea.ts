import { z } from "zod";

/**
 * Which part of the lawn a line item covers. A customer may only want flea & tick in the back yard
 * where the dog is, so every priced line says where its square feet come from: the whole lawn, the
 * front, the back, or a size typed in. The price, the time estimate and the product amounts for the
 * line are all worked out from that size.
 */
export const LAWN_AREAS = ["whole", "front", "back", "custom"] as const;
export type LawnArea = (typeof LAWN_AREAS)[number];
export const LAWN_AREA_LABELS: Record<LawnArea, string> = { whole: "Whole lawn", front: "Front lawn only", back: "Back lawn only", custom: "A size you type" };
/** What a service starts its lines on (a typed size belongs to one customer's line, not to a service). */
export const SERVICE_LAWN_AREAS = ["whole", "front", "back"] as const;
export type ServiceLawnArea = (typeof SERVICE_LAWN_AREAS)[number];

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/** The two fields a line carries (work order, estimate and invoice lines). */
export const lawnAreaFields = {
  lawnArea: z.enum(LAWN_AREAS).default("whole"),
  /** The typed size, for "custom" only. */
  lawnAreaSqFt: z.preprocess(blankToNull, z.coerce.number().positive("Enter the size in sq ft").max(100_000_000).nullable()).optional(),
};

export type LineArea = { lawnArea?: string | null; lawnAreaSqFt?: number | null };
export type LawnSizes = { lawnSqFt?: number | null; frontSqFt?: number | null; backSqFt?: number | null };

/** What gets saved for a line: the typed size only when the area is "custom". */
export function lineAreaValues(l: LineArea): { lawnArea: LawnArea; lawnAreaSqFt: number | null } {
  const lawnArea = (LAWN_AREAS as readonly string[]).includes(l.lawnArea ?? "") ? (l.lawnArea as LawnArea) : "whole";
  return { lawnArea, lawnAreaSqFt: lawnArea === "custom" ? l.lawnAreaSqFt ?? null : null };
}

/**
 * The square feet a line covers at a property. Null when it isn't known: no lawn size yet, or
 * "front"/"back" at a property that only has a total.
 */
export function lineSqFt(line: LineArea | null | undefined, property: LawnSizes | null | undefined): number | null {
  switch (line?.lawnArea ?? "whole") {
    case "front": return property?.frontSqFt ?? null;
    case "back": return property?.backSqFt ?? null;
    case "custom": return line?.lawnAreaSqFt ?? null;
    default: return property?.lawnSqFt ?? null;
  }
}

/** "back lawn only", "3,000 sq ft only"; empty for the whole lawn. */
export function lawnAreaNote(line: LineArea | null | undefined): string {
  switch (line?.lawnArea ?? "whole") {
    case "front": return "front lawn only";
    case "back": return "back lawn only";
    case "custom": return line?.lawnAreaSqFt ? `${Math.round(line.lawnAreaSqFt).toLocaleString("en-US")} sq ft only` : "";
    default: return "";
  }
}

/** A line's wording with its area, so the crew and the customer both see it: "Flea & tick (back lawn only)". */
export function withAreaNote(text: string, line: LineArea | null | undefined): string {
  const note = lawnAreaNote(line);
  return note ? `${text} (${note})` : text;
}

/**
 * The wording after a line's area changes: a line still carrying its automatic wording (with or
 * without the old area's note) gets the new note; one somebody reworded keeps its words. `bases`
 * are the wordings the service gives a line (its name, its invoice description); the first is used
 * for an empty line.
 */
export function rewordForArea(description: string, bases: string | (string | null | undefined)[], before: LineArea | null | undefined, after: LineArea | null | undefined): string {
  const d = description.trim();
  const list = (Array.isArray(bases) ? bases : [bases]).map((b) => b?.trim()).filter((b): b is string => !!b);
  if (!d) return list[0] ? withAreaNote(list[0], after) : description;
  const base = list.find((b) => d === b || d === withAreaNote(b, before));
  return base ? withAreaNote(base, after) : description;
}

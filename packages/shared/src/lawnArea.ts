import { z } from "zod";
import { isNumberField, type CustomFieldDef, type CustomValues } from "./customFields";

/**
 * Which size a line item is priced from. A property's sizes are custom fields (Total ft, Front Lawn
 * ft, Back Lawn ft, Other ft, and any number field the company adds, such as a bed or a side yard),
 * and each service says which one its price comes from. A line can use another one, or a size typed
 * in, for a single customer: flea & tick only in the back yard where the dog is. The price, the time
 * estimate and the product amounts for the line are all worked out from that size.
 *
 * A line stores a short key: Crewdesk's own four sizes are "whole", "front", "back" and "other"; a
 * field the company added is "cf:<its id>"; "custom" is a size typed on the line.
 */
export const LAWN_AREAS = ["whole", "front", "back", "other", "custom"] as const;
/** One of LAWN_AREAS, or "cf:<custom field id>". */
export type LawnArea = string;
/** What a service's lines start on: any of them except a typed size (that belongs to one customer's line). */
export type ServiceLawnArea = string;

const FIELD_KEY = /^cf:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAreaKey = (v: unknown): v is string => typeof v === "string" && ((LAWN_AREAS as readonly string[]).includes(v) || FIELD_KEY.test(v));
/** The custom field a "cf:…" key points at (null for Crewdesk's own sizes and typed ones). */
export const areaFieldId = (area: string | null | undefined) => (area && FIELD_KEY.test(area) ? area.slice(3) : null);

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const areaKey = z.string().refine(isAreaKey, "Pick which size it's priced from");

/** The two fields a line carries (work order, estimate and invoice lines). */
export const lawnAreaFields = {
  lawnArea: areaKey.default("whole"),
  /** The typed size, for "custom" only. */
  lawnAreaSqFt: z.preprocess(blankToNull, z.coerce.number().positive("Enter the size in sq ft").max(100_000_000).nullable()).optional(),
};
/** A service's own choice (never a typed size). */
export const serviceLawnArea = areaKey.refine((v) => v !== "custom", "A service is priced from one of the property's sizes");

export type LineArea = { lawnArea?: string | null; lawnAreaSqFt?: number | null };
/** A property's sizes: Crewdesk's own four, and its custom values for the company's number fields. */
export type LawnSizes = { lawnSqFt?: number | null; frontSqFt?: number | null; backSqFt?: number | null; otherSqFt?: number | null; custom?: CustomValues | null };

/** What gets saved for a line: the typed size only when the area is "custom". */
export function lineAreaValues(l: LineArea): { lawnArea: LawnArea; lawnAreaSqFt: number | null } {
  const lawnArea = isAreaKey(l.lawnArea) ? l.lawnArea : "whole";
  return { lawnArea, lawnAreaSqFt: lawnArea === "custom" ? l.lawnAreaSqFt ?? null : null };
}

/**
 * The size a line is priced from at a property. Null when it isn't known: nothing measured yet,
 * "front" or "back" at a property that only has a total, or a field with nothing in it.
 */
export function lineSqFt(line: LineArea | null | undefined, property: LawnSizes | null | undefined): number | null {
  const area = line?.lawnArea ?? "whole";
  switch (area) {
    case "front": return property?.frontSqFt ?? null;
    case "back": return property?.backSqFt ?? null;
    case "other": return property?.otherSqFt ?? null;
    case "custom": return line?.lawnAreaSqFt ?? null;
    case "whole": return property?.lawnSqFt ?? null;
  }
  const id = areaFieldId(area);
  if (!id) return property?.lawnSqFt ?? null;
  const v = property?.custom?.[id];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The size key a property field is priced under (null: not a size, e.g. Gate Code or a text field). */
export function areaKeyOf(f: Pick<CustomFieldDef, "id" | "type" | "builtin">): string | null {
  if (!isNumberField(f)) return null;
  switch (f.builtin) {
    case "lawnSqFt": return "whole";
    case "frontSqFt": return "front";
    case "backSqFt": return "back";
    case "otherSqFt": return "other";
  }
  return f.builtin ? null : `cf:${f.id}`;
}

/** The property's sizes a service or a line can be priced from, by the names the company gave them, total first. */
export function sizeChoices(fields: CustomFieldDef[]): { key: string; name: string }[] {
  const list = fields.map((f) => ({ key: areaKeyOf(f), name: f.name })).filter((c): c is { key: string; name: string } => !!c.key);
  return [...list.filter((c) => c.key === "whole"), ...list.filter((c) => c.key !== "whole")];
}

/** A field's name without its unit, for a sentence: "Side Yard ft" → "side yard". */
const plainName = (name: string) => name.replace(/\s*\(?\b(sq\.?\s*)?(ft|feet|foot)\.?\)?\s*$/i, "").trim().toLowerCase();

/**
 * "back lawn only", "side yard only", "3,000 sq ft only"; empty for the whole lawn. `names` gives
 * the company's field names by key, for the fields it added.
 */
export function lawnAreaNote(line: LineArea | null | undefined, names?: Record<string, string> | null): string {
  const area = line?.lawnArea ?? "whole";
  switch (area) {
    case "whole": return "";
    case "front": return "front lawn only";
    case "back": return "back lawn only";
    case "other": return "other area only";
    case "custom": return line?.lawnAreaSqFt ? `${Math.round(line.lawnAreaSqFt).toLocaleString("en-US")} sq ft only` : "";
  }
  const name = names?.[area] ? plainName(names[area]) : "";
  return name ? `${name} only` : "";
}

/** A line's wording with its area, so the crew and the customer both see it: "Flea & tick (back lawn only)". */
export function withAreaNote(text: string, line: LineArea | null | undefined, names?: Record<string, string> | null): string {
  const note = lawnAreaNote(line, names);
  return note ? `${text} (${note})` : text;
}

/**
 * The wording after a line's area changes: a line still carrying its automatic wording (with or
 * without the old area's note) gets the new note; one somebody reworded keeps its words. `bases`
 * are the wordings the service gives a line (its name, its invoice description); the first is used
 * for an empty line.
 */
export function rewordForArea(
  description: string, bases: string | (string | null | undefined)[], before: LineArea | null | undefined, after: LineArea | null | undefined,
  names?: Record<string, string> | null,
): string {
  const d = description.trim();
  const list = (Array.isArray(bases) ? bases : [bases]).map((b) => b?.trim()).filter((b): b is string => !!b);
  if (!d) return list[0] ? withAreaNote(list[0], after, names) : description;
  const base = list.find((b) => d === b || d === withAreaNote(b, before, names));
  return base ? withAreaNote(base, after, names) : description;
}

/** Field names by size key, for the notes above. */
export const areaNames = (fields: CustomFieldDef[]): Record<string, string> => Object.fromEntries(sizeChoices(fields).map((c) => [c.key, c.name]));

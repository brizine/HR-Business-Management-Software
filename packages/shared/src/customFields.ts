import { z } from "zod";

/**
 * Custom fields, like Homeworks': the company adds its own fields (a name, a type, a default value)
 * to customers, properties, work orders, to-dos, invoices or equipment. A "transferable" field copies
 * its value from the record it's made for (a work order's property or customer, an invoice's work
 * order), matching fields by name: Front Yard Sq Ft on a property fills Front Yard Sq Ft on its jobs.
 */

export const CUSTOM_FIELD_TARGETS = ["customer", "property", "workorder", "todo", "invoice", "asset"] as const;
export type CustomFieldTarget = (typeof CUSTOM_FIELD_TARGETS)[number];
export const CUSTOM_FIELD_TARGET_LABELS: Record<CustomFieldTarget, string> = {
  customer: "Customers",
  property: "Properties",
  workorder: "Work orders",
  todo: "To-dos",
  invoice: "Invoices",
  asset: "Equipment",
};

/** Homeworks' five kinds, plus a dropdown of choices. */
export const CUSTOM_FIELD_TYPES = ["text", "checkbox", "date", "decimal", "integer", "select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text", checkbox: "Checkbox", date: "Date", decimal: "Decimal", integer: "Integer", select: "Dropdown",
};
export const CUSTOM_FIELDS_MAX = 50;

/** A stored value: text, a number, true/false, or a date as YYYY-MM-DD. */
export type CustomValue = string | number | boolean;
export type CustomValues = Record<string, CustomValue>;

export interface CustomFieldDef {
  id: string; appliesTo: CustomFieldTarget; name: string; type: CustomFieldType; options: string[];
  defaultValue: string | null; transferable: boolean;
}

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/**
 * A value for a field from whatever a form or the API sent: null for blank, the cleaned value, or
 * an error message ("Enter a whole number").
 */
export function coerceCustomValue(f: Pick<CustomFieldDef, "type" | "options">, raw: unknown): { value: CustomValue | null } | { error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { value: f.type === "checkbox" ? false : null };
  switch (f.type) {
    case "text": {
      const s = String(raw).trim();
      return s.length > 2000 ? { error: "Keep it under 2,000 characters" } : { value: s };
    }
    case "checkbox":
      if (typeof raw === "boolean") return { value: raw };
      if (raw === "true" || raw === "1" || raw === 1 || raw === "yes" || raw === "on") return { value: true };
      if (raw === "false" || raw === "0" || raw === 0 || raw === "no" || raw === "off") return { value: false };
      return { error: "Tick it or leave it blank" };
    case "date": {
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) return { error: "Pick a date" };
      return { value: s };
    }
    case "decimal":
    case "integer": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
      if (!Number.isFinite(n)) return { error: f.type === "integer" ? "Enter a whole number" : "Enter a number" };
      if (f.type === "integer" && !Number.isInteger(n)) return { error: "Enter a whole number" };
      if (Math.abs(n) > 1e12) return { error: "That number is too big" };
      return { value: f.type === "decimal" ? Math.round(n * 10_000) / 10_000 : n };
    }
    case "select": {
      const s = String(raw).trim();
      const hit = f.options.find((o) => o.toLowerCase() === s.toLowerCase());
      return hit ? { value: hit } : { error: `Pick one of: ${f.options.join(", ")}` };
    }
  }
}

const fieldBase = z.object({
  name: z.string().trim().min(1, "Name the field").max(60, "Keep the name under 60 characters"),
  options: z.array(z.string().trim().min(1, "A choice can't be blank").max(60)).max(30, "Up to 30 choices").default([]),
  defaultValue: z.preprocess(blankToNull, z.union([z.string(), z.number(), z.boolean()]).nullable()).optional(),
  transferable: z.boolean().default(false),
});
function checkField(v: { type?: CustomFieldType; options?: string[]; defaultValue?: unknown }, ctx: z.RefinementCtx) {
  if (!v.type) return;
  const options = v.options ?? [];
  if (v.type === "select") {
    if (!options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "Add the choices for the dropdown" });
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "Each choice only once" });
  }
  if (v.defaultValue !== null && v.defaultValue !== undefined) {
    const r = coerceCustomValue({ type: v.type, options }, v.defaultValue);
    if ("error" in r) ctx.addIssue({ code: "custom", path: ["defaultValue"], message: `Default value: ${r.error.charAt(0).toLowerCase()}${r.error.slice(1)}` });
  }
}

/** Homeworks' "Add New Field": applies to, name / label, type, transferable, default value. */
export const customFieldSchema = fieldBase.extend({
  appliesTo: z.enum(CUSTOM_FIELD_TARGETS, { errorMap: () => ({ message: "Pick what the field applies to" }) }),
  type: z.enum(CUSTOM_FIELD_TYPES, { errorMap: () => ({ message: "Pick the field type" }) }),
}).superRefine(checkField);
export type CustomFieldInput = z.infer<typeof customFieldSchema>;
/** Changing a field: its name, choices, default and transferable (what it applies to and its type stay). */
export const customFieldUpdateSchema = fieldBase.partial().superRefine((v, ctx) => {
  if (v.name !== undefined && !v.name) ctx.addIssue({ code: "custom", path: ["name"], message: "Name the field" });
});
export type CustomFieldUpdate = z.infer<typeof customFieldUpdateSchema>;

/** The default value stored the field's way ("1200" → 1200 for a number), or null. */
export function customDefault(f: Pick<CustomFieldDef, "type" | "options" | "defaultValue">): CustomValue | null {
  if (f.defaultValue === null || f.defaultValue === undefined || f.defaultValue === "") return null;
  const r = coerceCustomValue(f, f.defaultValue);
  return "value" in r ? r.value : null;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

/**
 * Cleans values sent for a record: only the company's fields for that kind of record, each checked
 * for its type. `before` is what the record has now (fields not sent keep their value; blank clears).
 */
export function cleanCustomValues(fields: CustomFieldDef[], input: unknown, before: CustomValues = {}): { values: CustomValues; errors: string[] } {
  const values: CustomValues = {};
  const errors: string[] = [];
  const sent = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const f of fields) {
    if (!(f.id in sent)) {
      if (!isBlank(before[f.id])) values[f.id] = before[f.id];
      continue;
    }
    const r = coerceCustomValue(f, sent[f.id]);
    if ("error" in r) errors.push(`${f.name}: ${r.error}`);
    else if (r.value !== null) values[f.id] = r.value;
  }
  return { values, errors };
}

/**
 * A new record's values. What was entered stays (a checkbox counts once it's sent, ticked or not);
 * other fields take, if transferable, the value of the same-named field on the records it's made for
 * (first source first), and otherwise the field's default.
 */
export function startingCustomValues(
  fields: CustomFieldDef[], entered: CustomValues,
  sources: { fields: Pick<CustomFieldDef, "id" | "name">[]; values: CustomValues | null | undefined }[] = [],
): CustomValues {
  const out: CustomValues = {};
  for (const f of fields) {
    const v = entered[f.id];
    if (f.type === "checkbox" ? typeof v === "boolean" : !isBlank(v)) { out[f.id] = v; continue; }
    let found: CustomValue | null = null;
    if (f.transferable) {
      for (const s of sources) {
        const match = s.fields.find((x) => x.name.trim().toLowerCase() === f.name.trim().toLowerCase());
        const sv = match ? s.values?.[match.id] : undefined;
        if (!match || isBlank(sv)) continue;
        const r = coerceCustomValue(f, sv);
        if ("value" in r && r.value !== null) { found = r.value; break; }
      }
    }
    const value = found ?? customDefault(f);
    if (value !== null) out[f.id] = value;
  }
  return out;
}

/** A value as people read it: "4,200", "Yes", "Nov 23, 2026", or "" when blank. */
export function formatCustomValue(f: Pick<CustomFieldDef, "type">, v: CustomValue | null | undefined): string {
  if (isBlank(v)) return "";
  switch (f.type) {
    case "checkbox": return v ? "Yes" : "No";
    case "date": return typeof v === "string" ? new Date(`${v}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : String(v);
    case "integer":
    case "decimal": return typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(v);
    default: return String(v);
  }
}

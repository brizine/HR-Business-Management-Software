import { and, asc, eq } from "drizzle-orm";
import { cleanCustomValues, startingCustomValues, type CustomFieldDef, type CustomFieldTarget, type CustomFieldType, type CustomValues } from "@crewdesk/shared";
import { db as defaultDb } from "../db";
import { customFields, customers, properties } from "../db/schema";
import { HttpError } from "./errors";

type DB = Pick<typeof defaultDb, "select">;

export const asDef = (f: typeof customFields.$inferSelect): CustomFieldDef => ({
  id: f.id, appliesTo: f.appliesTo as CustomFieldTarget, name: f.name, type: f.type as CustomFieldType, options: f.options,
  defaultValue: f.defaultValue, transferable: f.transferable,
});

/** The company's custom fields for one kind of record, in their order. */
export async function fieldsFor(companyId: string, target: CustomFieldTarget, db: DB = defaultDb): Promise<CustomFieldDef[]> {
  const rows = await db.select().from(customFields).where(and(eq(customFields.companyId, companyId), eq(customFields.appliesTo, target)))
    .orderBy(asc(customFields.sortOrder), asc(customFields.name));
  return rows.map(asDef);
}

/** Values sent for a record, checked against the company's fields (400 with each problem by name). */
export async function enteredCustom(companyId: string, target: CustomFieldTarget, input: unknown, before: CustomValues = {}, db: DB = defaultDb) {
  const fields = await fieldsFor(companyId, target, db);
  const { values, errors } = cleanCustomValues(fields, input, before);
  if (errors.length) throw new HttpError(400, errors.join("; "));
  return values;
}

/** Where a new record's transferable values can come from. */
export type CustomSource =
  | { target: CustomFieldTarget; values: CustomValues | null | undefined }
  | { fields: { id: string; name: string }[]; values: CustomValues };

/**
 * A property's built-in sizes as a source, so a transferable field named like "Front Yard Sq Ft"
 * fills from the measured front lawn (Homeworks keeps these as custom fields; Crewdesk has them built in).
 */
export function propertySizes(p: { frontSqFt?: number | null; backSqFt?: number | null; lawnSqFt?: number | null } | null | undefined): CustomSource {
  const names: [string, number | null | undefined][] = p ? [
    ["Front Yard Sq Ft", p.frontSqFt], ["Front Sq Ft", p.frontSqFt], ["Back Yard Sq Ft", p.backSqFt], ["Back Sq Ft", p.backSqFt],
    ["Total Yard Sq Ft", p.lawnSqFt], ["Total Sq Ft", p.lawnSqFt], ["Lawn Sq Ft", p.lawnSqFt],
  ] : [];
  const have = names.filter(([, v]) => v != null);
  return { fields: have.map(([name], i) => ({ id: `size${i}`, name })), values: Object.fromEntries(have.map(([, v], i) => [`size${i}`, Math.round(v!)])) };
}

/**
 * A new record's values: what was entered, then transferable values from the records it's made
 * for (e.g. a work order's property, then its customer), then each field's default.
 */
export async function newRecordCustom(
  companyId: string, target: CustomFieldTarget, input: unknown, sources: CustomSource[] = [], db: DB = defaultDb,
) {
  const fields = await fieldsFor(companyId, target, db);
  if (!fields.length) return {};
  const { values, errors } = cleanCustomValues(fields, input);
  if (errors.length) throw new HttpError(400, errors.join("; "));
  const withFields = await Promise.all(sources.filter((s) => s.values && Object.keys(s.values).length)
    .map(async (s) => ("fields" in s ? s : { fields: await fieldsFor(companyId, s.target, db), values: s.values })));
  // Only what was actually sent counts as entered (an unsent checkbox can still be transferred).
  const sent = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const entered = Object.fromEntries(Object.entries(values).filter(([k]) => k in sent));
  return startingCustomValues(fields, entered, withFields);
}

/** The custom values to keep on an update: unchanged when the form didn't send any. */
export async function updatedCustom(companyId: string, target: CustomFieldTarget, input: unknown, before: CustomValues | null | undefined, db: DB = defaultDb) {
  if (input === undefined) return undefined;
  return enteredCustom(companyId, target, input, before ?? {}, db);
}

/** Where a job's transferable values come from: its property (custom fields, then measured sizes), then its customer. */
export async function jobSources(companyId: string, propertyId: string | null | undefined, customerId: string | null | undefined, db: DB = defaultDb): Promise<CustomSource[]> {
  const [p] = propertyId ? await db.select({ custom: properties.custom, frontSqFt: properties.frontSqFt, backSqFt: properties.backSqFt, lawnSqFt: properties.lawnSqFt })
    .from(properties).where(and(eq(properties.id, propertyId), eq(properties.companyId, companyId))) : [];
  const [c] = customerId ? await db.select({ custom: customers.custom }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))) : [];
  return [{ target: "property", values: p?.custom }, propertySizes(p), { target: "customer", values: c?.custom }];
}

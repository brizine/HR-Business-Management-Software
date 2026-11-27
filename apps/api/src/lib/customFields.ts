import { and, asc, eq, sql } from "drizzle-orm";
import {
  PROPERTY_BUILTIN_FIELDS, cleanCustomValues, lawnTotal, propertyFieldValues, startingCustomValues,
  type CustomFieldDef, type CustomFieldTarget, type CustomFieldType, type CustomValues, type PropertyBuiltin, type PropertyBuiltinValues,
} from "@crewdesk/shared";
import { db as defaultDb } from "../db";
import { customFields, customers, properties } from "../db/schema";
import { HttpError } from "./errors";

type DB = Pick<typeof defaultDb, "select">;

export const asDef = (f: typeof customFields.$inferSelect): CustomFieldDef => ({
  id: f.id, appliesTo: f.appliesTo as CustomFieldTarget, name: f.name, type: f.type as CustomFieldType, options: f.options,
  defaultValue: f.defaultValue, transferable: f.transferable, builtin: f.builtin ?? null,
});

/** The property column each built-in field keeps its value in. */
const BUILTIN_COLUMN: Record<PropertyBuiltin, string> = {
  mapCode: "map_code", frontSqFt: "front_sq_ft", backSqFt: "back_sq_ft", otherSqFt: "other_sq_ft", lawnSqFt: "lawn_sq_ft",
  gateCode: "gate_code", pets: "pets", accessNotes: "access_notes", notes: "notes",
};
const ensured = new Set<string>();
/**
 * Makes sure the company has Crewdesk's own property fields (Map Code, the sizes, Gate Code, Pets,
 * the notes) as custom fields, once per company per server start. A field the company already made
 * under the same name and kind becomes the built-in one, and what was typed in it moves into the
 * property wherever the property had nothing; any other name clash gets "(property)" added.
 */
export async function ensurePropertyFields(companyId: string) {
  if (ensured.has(companyId)) return;
  await defaultDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`custom-fields:${companyId}`}))`);
    const rows = await tx.select().from(customFields).where(and(eq(customFields.companyId, companyId), eq(customFields.appliesTo, "property")));
    const have = new Set(rows.map((r) => r.builtin).filter(Boolean));
    if (PROPERTY_BUILTIN_FIELDS.every((b) => have.has(b.key))) return;
    const own = new Map(rows.filter((r) => !r.builtin).map((r) => [r.name.trim().toLowerCase(), r]));
    for (const [i, b] of PROPERTY_BUILTIN_FIELDS.entries()) {
      if (have.has(b.key)) continue;
      const same = own.get(b.name.toLowerCase());
      const fits = !!same && (b.type === "text" ? same.type === "text" : same.type === "decimal" || same.type === "integer");
      if (same && fits) {
        await tx.update(customFields).set({ builtin: b.key }).where(eq(customFields.id, same.id));
        const col = sql.raw(`"${BUILTIN_COLUMN[b.key]}"`);
        const typed = sql`custom->>${same.id}`;
        if (b.type === "text") await tx.execute(sql`update properties set ${col} = ${typed} where company_id = ${companyId} and ${col} is null and custom ? ${same.id}`);
        else await tx.execute(sql`update properties set ${col} = (${typed})::float8 where company_id = ${companyId} and ${col} is null and custom ? ${same.id} and ${typed} ~ '^-?[0-9]+(\.[0-9]+)?$'`);
        await tx.execute(sql`update properties set custom = custom - ${same.id}::text where company_id = ${companyId} and custom ? ${same.id}`);
      } else {
        await tx.insert(customFields).values({ companyId, appliesTo: "property", name: same ? `${b.name} (property)` : b.name, type: b.type, builtin: b.key, sortOrder: i - 100 }).onConflictDoNothing();
      }
    }
  });
  ensured.add(companyId);
}

/**
 * What changes on a property when built-in fields are saved: a Map Code typed by hand is marked as
 * set by hand, and a total left blank is worked out from front + back + other.
 */
export function propertyColumnChanges(
  p: { mapCode: string | null; mapCodeManual: boolean; frontSqFt: number | null; backSqFt: number | null; otherSqFt: number | null; lawnSqFt: number | null },
  c: PropertyBuiltinValues,
) {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(c)) out[k] = v === undefined || v === "" ? null : v;
  if ("mapCode" in c) out.mapCodeManual = (c.mapCode || null) !== (p.mapCode ?? null) ? !!c.mapCode : p.mapCodeManual;
  if (["frontSqFt", "backSqFt", "otherSqFt", "lawnSqFt"].some((k) => k in c)) {
    const next = { frontSqFt: p.frontSqFt, backSqFt: p.backSqFt, otherSqFt: p.otherSqFt, lawnSqFt: p.lawnSqFt, ...c };
    if (next.lawnSqFt == null) out.lawnSqFt = lawnTotal(next);
  }
  return out;
}

/** The company's custom fields for one kind of record, in their order (a property's include Crewdesk's own). */
export async function fieldsFor(companyId: string, target: CustomFieldTarget, db: DB = defaultDb): Promise<CustomFieldDef[]> {
  if (target === "property") await ensurePropertyFields(companyId);
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

/**
 * Where a job's transferable values come from: its property (every field, Crewdesk's own included, so a
 * work order field named like "Gate Code" or "Total ft" fills from the property), then the older size
 * names, then its customer.
 */
export async function jobSources(companyId: string, propertyId: string | null | undefined, customerId: string | null | undefined, db: DB = defaultDb): Promise<CustomSource[]> {
  const [p] = propertyId ? await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.companyId, companyId))) : [];
  const [c] = customerId ? await db.select({ custom: customers.custom }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))) : [];
  const fields = p ? await fieldsFor(companyId, "property", db) : [];
  return [{ fields, values: propertyFieldValues(fields, p) }, propertySizes(p), { target: "customer", values: c?.custom }];
}

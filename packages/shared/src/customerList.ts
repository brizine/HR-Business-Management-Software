import { z } from "zod";
import { PAYMENT_ON_FILE_OPTIONS } from "./paymentMethods";
import { ESTIMATE_FILTER_OPTIONS } from "./estimates";
import { CUSTOMER_KINDS, CUSTOMER_KIND_LABELS, DELIVERY_LABELS, DELIVERY_METHODS, LEAD_SOURCES } from "./customers";

/**
 * The Customers list (like Homeworks' Customers page): filters built from a field, a comparison and
 * a value ("Balance owed · more than · $50"), any number of them, all of which must match; and the
 * columns to show, picked and ordered by each person.
 */

export type FilterKind = "text" | "enum" | "number" | "money" | "date" | "bool" | "tags" | "service" | "presence";
export const FILTER_OPS = {
  text: [["contains", "Contains"], ["starts", "Starts with"], ["equals", "Is exactly"], ["blank", "Is blank"], ["notblank", "Isn't blank"]],
  enum: [["is", "Is"], ["isnot", "Is not"]],
  number: [["gt", "More than"], ["lt", "Less than"], ["eq", "Equal to"], ["between", "Between"]],
  money: [["gt", "More than"], ["lt", "Less than"], ["eq", "Equal to"], ["between", "Between"]],
  date: [["between", "Between"], ["after", "On or after"], ["before", "On or before"], ["never", "Never / none"]],
  bool: [["yes", "Yes"], ["no", "No"]],
  tags: [["any", "Has any of"], ["all", "Has all of"], ["none", "Has none of"]],
  service: [["completed", "Completed"], ["scheduled", "Scheduled"], ["invoiced", "Invoiced"], ["never", "Never had"]],
  presence: [["yes", "Scheduled"], ["no", "Nothing scheduled"]],
} as const satisfies Record<FilterKind, readonly (readonly [string, string])[]>;

export interface FilterField { key: string; label: string; group: string; kind: FilterKind; options?: readonly (readonly [string, string])[] }

/** Homeworks' filters (name, email, address, status, types, account credit, register date, tags, account
 *  number, ZIP, recurring and service filters) plus Crewdesk's own (balance, overdue, prepaid, last and
 *  next service, phone, city, lead source, delivery, tax exempt, PO, properties, billed this year). */
export const CUSTOMER_FILTER_FIELDS: readonly FilterField[] = [
  { key: "name", label: "Name", group: "Customer", kind: "text" },
  { key: "number", label: "Customer #", group: "Customer", kind: "number" },
  { key: "status", label: "Status", group: "Customer", kind: "enum", options: [["active", "Active"], ["lead", "Lead"], ["cancelled", "Inactive"]] },
  { key: "kind", label: "Type", group: "Customer", kind: "enum", options: CUSTOMER_KINDS.map((k) => [k, CUSTOMER_KIND_LABELS[k]] as const) },
  { key: "tags", label: "Tags", group: "Customer", kind: "tags" },
  { key: "source", label: "Lead source", group: "Customer", kind: "enum", options: LEAD_SOURCES.map((s) => [s, s] as const) },
  { key: "since", label: "Customer since", group: "Customer", kind: "date" },
  { key: "email", label: "Email", group: "Contact", kind: "text" },
  { key: "phone", label: "Phone", group: "Contact", kind: "text" },
  { key: "delivery", label: "Invoices sent by", group: "Contact", kind: "enum", options: DELIVERY_METHODS.map((d) => [d, DELIVERY_LABELS[d]] as const) },
  { key: "emailOptOut", label: "Unsubscribed from emails", group: "Contact", kind: "bool" },
  { key: "address", label: "Service address", group: "Address", kind: "text" },
  { key: "city", label: "City", group: "Address", kind: "text" },
  { key: "zip", label: "ZIP code", group: "Address", kind: "text" },
  { key: "properties", label: "Number of properties", group: "Address", kind: "number" },
  { key: "balance", label: "Balance owed", group: "Money", kind: "money" },
  { key: "overdue", label: "Has overdue invoices", group: "Money", kind: "bool" },
  { key: "credit", label: "Account credit", group: "Money", kind: "money" },
  { key: "prepaid", label: "Prepaid balance", group: "Money", kind: "money" },
  { key: "revenue", label: "Billed this year", group: "Money", kind: "money" },
  { key: "taxExempt", label: "Tax exempt", group: "Money", kind: "bool" },
  { key: "paymentOnFile", label: "Payment method on file", group: "Money", kind: "enum", options: PAYMENT_ON_FILE_OPTIONS },
  { key: "autopay", label: "Autopay", group: "Money", kind: "bool" },
  { key: "estimate", label: "Estimates", group: "Service", kind: "enum", options: ESTIMATE_FILTER_OPTIONS },
  { key: "po", label: "Needs a PO number", group: "Money", kind: "bool" },
  { key: "lastService", label: "Last service", group: "Service", kind: "date" },
  { key: "nextService", label: "Next service scheduled", group: "Service", kind: "presence" },
  { key: "service", label: "A service (completed, scheduled or invoiced)", group: "Service", kind: "service" },
];
export const filterField = (key: string, custom: { id: string; name: string; type: string; options: string[] }[] = []): FilterField | undefined => {
  if (key.startsWith("cf:")) {
    const f = custom.find((c) => `cf:${c.id}` === key);
    if (!f) return undefined;
    const kind: FilterKind = f.type === "checkbox" ? "bool" : f.type === "date" ? "date" : f.type === "integer" || f.type === "decimal" ? "number" : f.type === "select" ? "enum" : "text";
    return { key, label: f.name, group: "Custom fields", kind, options: f.type === "select" ? f.options.map((o) => [o, o] as const) : undefined };
  }
  return CUSTOMER_FILTER_FIELDS.find((f) => f.key === key);
};

const value = z.union([z.string().max(200), z.number(), z.array(z.string().max(200)).max(50)]).nullable().optional();
/** One filter rule: field, comparison, value (and a second value for "between", or a service's dates). */
export const customerFilterSchema = z.object({
  f: z.string().min(1).max(60),
  op: z.string().min(1).max(20),
  v: value,
  v2: value,
  /** Service filters: from and to dates (optional). */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type CustomerFilter = z.infer<typeof customerFilterSchema>;
export const customerFiltersSchema = z.array(customerFilterSchema).max(20);

/** Reads the filters from a query string (JSON); bad input is ignored rather than failing the page. */
export function parseCustomerFilters(raw: unknown): CustomerFilter[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const r = customerFiltersSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

const opLabel = (kind: FilterKind, op: string) => (FILTER_OPS[kind] as readonly (readonly [string, string])[]).find(([k]) => k === op)?.[1] ?? op;
const money = (v: unknown) => `$${Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : String(v ?? ""));

/** A filter in words, for its chip: "Balance owed more than $50", "Tags has any of MAP 100, MAP 200". */
export function describeFilter(r: CustomerFilter, o: { field?: FilterField; tagName?: (id: string) => string; serviceName?: (id: string) => string } = {}): string {
  const f = o.field;
  if (!f) return "Unknown filter";
  const op = opLabel(f.kind, r.op).toLowerCase();
  const list = (v: unknown, name?: (x: string) => string) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [String(v)]).map((x) => (name ? name(x) : f.options?.find(([k]) => k === x)?.[1] ?? x)).join(", ");
  switch (f.kind) {
    case "text": return r.op === "blank" || r.op === "notblank" ? `${f.label} ${op}` : `${f.label} ${op} "${r.v ?? ""}"`;
    case "enum": return `${f.label} ${op} ${list(r.v)}`;
    case "tags": return `Tags ${op} ${list(r.v, o.tagName)}`;
    case "number": return r.op === "between" ? `${f.label} between ${r.v} and ${r.v2}` : `${f.label} ${op} ${r.v}`;
    case "money": return r.op === "between" ? `${f.label} between ${money(r.v)} and ${money(r.v2)}` : `${f.label} ${op} ${money(r.v)}`;
    case "date":
      if (r.op === "never") return `${f.label}: never`;
      return r.op === "between" ? `${f.label} ${day(r.v)} – ${day(r.v2)}` : `${f.label} ${op} ${day(r.v)}`;
    case "bool": return `${f.label}: ${r.op === "yes" ? "yes" : "no"}`;
    case "presence": return r.op === "yes" ? "Has a service scheduled" : "Nothing scheduled";
    case "service": {
      const what = list(r.v, o.serviceName) || "any service";
      const when = r.from || r.to ? ` (${r.from ? day(r.from) : "any time"} – ${r.to ? day(r.to) : "now"})` : "";
      return r.op === "never" ? `Never had ${what}` : `${what} ${op}${when}`;
    }
  }
}

/** A filter rule is complete enough to apply. */
export function filterReady(r: CustomerFilter, f: FilterField | undefined): boolean {
  if (!f || !(FILTER_OPS[f.kind] as readonly (readonly [string, string])[]).some(([k]) => k === r.op)) return false;
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== "");
  switch (f.kind) {
    case "text": return r.op === "blank" || r.op === "notblank" || has(r.v);
    case "enum": case "tags": return has(r.v);
    case "number": case "money": return has(r.v) && !Number.isNaN(Number(r.v)) && (r.op !== "between" || (has(r.v2) && !Number.isNaN(Number(r.v2))));
    case "date": return r.op === "never" || (has(r.v) && (r.op !== "between" || has(r.v2)));
    case "bool": case "presence": case "service": return true;
  }
}

/* ───────────── Columns ───────────── */

export interface CustomerColumn { key: string; label: string; group: string; sort?: boolean; align?: "right"; default?: boolean }
/** Every column the list can show (Homeworks has 9; these are grouped, searchable and can be reordered). */
export const CUSTOMER_COLUMNS: readonly CustomerColumn[] = [
  { key: "number", label: "#", group: "Customer", sort: true, default: true },
  { key: "name", label: "Customer", group: "Customer", sort: true, default: true },
  { key: "type", label: "Type", group: "Customer", sort: true },
  { key: "status", label: "Status", group: "Customer", sort: true, default: true },
  { key: "contact", label: "Contact person", group: "Customer" },
  { key: "tags", label: "Tags", group: "Customer", default: true },
  { key: "source", label: "Lead source", group: "Customer", sort: true },
  { key: "since", label: "Customer since", group: "Customer", sort: true },
  { key: "phone", label: "Phone", group: "Contact", default: true },
  { key: "altPhone", label: "Other phone", group: "Contact" },
  { key: "email", label: "Email", group: "Contact", sort: true, default: true },
  { key: "delivery", label: "Invoices sent by", group: "Contact" },
  { key: "emailOptOut", label: "Unsubscribed", group: "Contact" },
  { key: "address", label: "Service address", group: "Address", sort: true, default: true },
  { key: "city", label: "City", group: "Address", sort: true },
  { key: "zip", label: "ZIP", group: "Address", sort: true },
  { key: "billing", label: "Billing address", group: "Address" },
  { key: "properties", label: "Properties", group: "Address", sort: true, align: "right", default: true },
  { key: "balance", label: "Balance owed", group: "Money", sort: true, align: "right", default: true },
  { key: "overdue", label: "Overdue", group: "Money", sort: true, align: "right" },
  { key: "credit", label: "Account credit", group: "Money", sort: true, align: "right" },
  { key: "prepaid", label: "Prepaid", group: "Money", sort: true, align: "right" },
  { key: "revenue", label: "Billed this year", group: "Money", sort: true, align: "right" },
  { key: "taxExempt", label: "Tax exempt", group: "Money" },
  { key: "onFile", label: "Card / bank on file", group: "Money" },
  { key: "autopay", label: "Autopay", group: "Money" },
  { key: "openEstimates", label: "Open estimates", group: "Money", sort: true, align: "right" },
  { key: "po", label: "PO required", group: "Money" },
  { key: "lastService", label: "Last service", group: "Service", sort: true },
  { key: "nextService", label: "Next scheduled", group: "Service", sort: true },
  { key: "notes", label: "Notes", group: "Other" },
];
export const DEFAULT_CUSTOMER_COLUMNS = CUSTOMER_COLUMNS.filter((c) => c.default).map((c) => c.key);
export const CUSTOMER_SORTS = CUSTOMER_COLUMNS.filter((c) => c.sort).map((c) => c.key);
export const CUSTOMER_PAGE_SIZES = [25, 50, 100, 250] as const;

/**
 * Which customers a bulk action is for: the ticked rows (ids), or everyone the list's tab, search
 * and filters match ("Select all 312 matching"), worked out again on the server when it runs.
 */
export const customerMatchSchema = z.object({
  status: z.enum(["active", "lead", "cancelled", "current", "all"]).default("current"),
  q: z.string().max(100).optional(),
  filters: customerFiltersSchema.default([]),
});
export type CustomerMatch = z.infer<typeof customerMatchSchema>;
export const customerIdsSchema = z.object({ ids: z.array(z.string().uuid(), { required_error: "Pick the customers" }).min(1, "Pick the customers").max(500, "Pick up to 500, or use Select all matching") });
export const customerSelectionSchema = z.union([customerIdsSchema, z.object({ match: customerMatchSchema })]);
export type CustomerSelection = z.infer<typeof customerSelectionSchema>;
/** The most customers one bulk action can touch. */
export const BULK_MAX = 5000;

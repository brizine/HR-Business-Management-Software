import { z } from "zod";
import { optionalTaxRateSchema } from "./tax";
import { normalizePhone } from "./phone";

/**
 * Customers and properties (Phase 1 of the customer system). A property is its own record, assigned
 * to customers by role: one bill-to who gets the invoices and pays, plus any residents (tenants) who
 * get reminders. Assignments carry start and end dates, so history survives a sale or a new manager.
 */

export const CUSTOMER_KINDS = ["residential", "commercial", "hoa"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];
export const CUSTOMER_KIND_LABELS: Record<CustomerKind, string> = { residential: "Residential", commercial: "Commercial", hoa: "HOA" };

/**
 * Leads haven't bought yet; inactive customers are hidden from everyday lists but never deleted.
 * On screen the status reads "Inactive"; it is stored as "cancelled".
 */
export const CUSTOMER_STATUSES = ["lead", "active", "cancelled"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = { lead: "Lead", active: "Active", cancelled: "Inactive" };
/** How a customer's or property's status reads in a badge or a sentence: "inactive" for a cancelled one. */
export const statusWord = (status: string | null | undefined) => (status === "cancelled" ? "inactive" : (status ?? "").replace(/_/g, " "));

/** How invoices and estimates reach the customer (any of them). */
export const DELIVERY_METHODS = ["email", "paper", "text"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export const DELIVERY_LABELS: Record<DeliveryMethod, string> = { email: "Email", paper: "Paper (mail)", text: "Text" };

export const PROPERTY_ROLES = ["bill_to", "resident"] as const;
export type PropertyRole = (typeof PROPERTY_ROLES)[number];
export const PROPERTY_ROLE_LABELS: Record<PropertyRole, string> = { bill_to: "Bill-to", resident: "Resident" };

/** Suggestions for "How did they hear about us?" (anything can be typed). */
export const LEAD_SOURCES = ["Google search", "Google map", "Facebook", "Website", "Referral", "Door hanger", "Yard sign", "Truck", "Repeat customer", "Other"] as const;

export const TAG_COLORS = ["gray", "green", "blue", "teal", "purple", "orange", "red", "yellow"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const CANCEL_INITIATORS = ["customer", "company"] as const;
export type CancelInitiator = (typeof CANCEL_INITIATORS)[number];

/** The starting reasons for a customer or property going inactive; admins can rename, reorder and add them, or make one inactive. */
export const DEFAULT_CANCEL_REASONS: { label: string; initiatedBy: CancelInitiator; commentRequired?: boolean }[] = [
  { label: "Moved or sold the home", initiatedBy: "customer" },
  { label: "Price", initiatedBy: "customer" },
  { label: "Switched to another company", initiatedBy: "customer" },
  { label: "Doing it themselves", initiatedBy: "customer" },
  { label: "Not happy with results", initiatedBy: "customer" },
  { label: "Scheduling or communication", initiatedBy: "customer" },
  { label: "Financial hardship", initiatedBy: "customer" },
  { label: "Non-payment", initiatedBy: "company" },
  { label: "Other", initiatedBy: "customer", commentRequired: true },
];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const optEmail = z.string().trim().toLowerCase().max(254).email("Enter a valid email").optional().or(z.literal("").transform(() => undefined));
const optPhone = z.string().trim().max(40).optional().transform((v) => (v ? normalizePhone(v) : undefined));
const state = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use the 2-letter state").default("OK");
const zip = z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP").optional().or(z.literal("").transform(() => undefined));
const sqFt = z.number().nonnegative().max(50_000_000).nullable().optional();

export const customerContactSchema = z.object({
  name: z.string().trim().min(1, "Enter the contact's name").max(120),
  /** e.g. "Spouse", "Property manager", "Accounts payable". */
  relation: optText(60),
  email: optEmail,
  phone: optPhone,
  /** Copied on invoices and estimates. */
  getsInvoices: z.boolean().default(false),
});
export type CustomerContactInput = z.infer<typeof customerContactSchema>;

const customerFields = z.object({
  kind: z.enum(CUSTOMER_KINDS).default("residential"),
  firstName: optText(80),
  lastName: optText(80),
  companyName: optText(160),
  email: optEmail,
  phone: optPhone,
  altPhone: optPhone,
  billingStreet: optText(200),
  billingCity: optText(100),
  billingState: state,
  billingZip: zip,
  delivery: z.array(z.enum(DELIVERY_METHODS)).min(1, "Choose how invoices are sent").max(3).default(["email"]),
  /** How they heard about ProSpray. */
  source: optText(100),
  /** Commercial accounts that need a PO number on every invoice. */
  poRequired: z.boolean().default(false),
  /** Sales tax: an exempt customer (an HOA, a church, a school) pays none; or their own rate. */
  taxExempt: z.boolean().default(false),
  taxExemptNumber: z.preprocess((v) => (typeof v === "string" && !v.trim() ? null : v), z.string().trim().max(60).nullable()).optional(),
  taxRate: optionalTaxRateSchema,
  notes: optText(5000),
  /** Mr., Mrs., Dr. ... */
  title: optText(20),
  county: optText(60),
  /** Defaults for their new invoices and estimates. */
  discountPercent: z.coerce.number().min(0).max(100).multipleOf(0.01).default(0),
  invoiceNotes: optText(2000),
  /** Days to pay (blank: the company's usual terms). */
  termsDays: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.coerce.number().int().min(0).max(365).nullable()).optional(),
  status: z.enum(["lead", "active"]).default("active"),
  tagIds: z.array(z.string().uuid()).max(50).default([]),
  contacts: z.array(customerContactSchema).max(20).default([]),
});

/** A customer needs a name, and whatever delivery methods are chosen need an address to send to. */
function checkCustomer(c: z.infer<typeof customerFields>, ctx: z.RefinementCtx) {
  if (!c.firstName && !c.lastName && !c.companyName) ctx.addIssue({ code: "custom", path: ["lastName"], message: "Enter a name or a company name" });
  if (c.kind !== "residential" && !c.companyName) ctx.addIssue({ code: "custom", path: ["companyName"], message: "Enter the company or HOA name" });
  if (c.delivery.includes("email") && !c.email) ctx.addIssue({ code: "custom", path: ["email"], message: "Email delivery needs an email address" });
  if (c.delivery.includes("text") && !c.phone) ctx.addIssue({ code: "custom", path: ["phone"], message: "Text delivery needs a phone number" });
  if (c.delivery.includes("paper") && !c.billingStreet) ctx.addIssue({ code: "custom", path: ["billingStreet"], message: "Paper delivery needs a billing address" });
}

const propertyFields = z.object({
  /** Optional label, e.g. "Rental on Elm" or "Clubhouse". */
  name: optText(120),
  street: z.string().trim().min(1, "Enter the street address").max(200),
  city: optText(100),
  state,
  zip,
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  mapCode: optText(20),
  frontSqFt: sqFt,
  backSqFt: sqFt,
  /** Any measured area that is neither front nor back. */
  otherSqFt: sqFt,
  /** Total lawn size: as entered, or front + back + other when left blank. */
  lawnSqFt: sqFt,
  measurementId: z.string().uuid().nullable().optional(),
  gateCode: optText(60),
  pets: optText(200),
  accessNotes: optText(2000),
  notes: optText(5000),
  tagIds: z.array(z.string().uuid()).max(50).default([]),
  /** Sales tax rate where the property is (blank: the customer's, else the company default). */
  taxRate: optionalTaxRateSchema,
});

export const propertySchema = propertyFields;
export type PropertyInput = z.infer<typeof propertySchema>;

/** A new customer, optionally with their first service address (assigned to them as bill-to). */
export const customerSchema = customerFields.extend({ property: propertyFields.optional() }).superRefine(checkCustomer);
export type CustomerInput = z.infer<typeof customerSchema>;
export const customerUpdateSchema = customerFields.superRefine(checkCustomer);
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

/** A new property, optionally assigned straight away to a bill-to customer and residents. */
export const propertyCreateSchema = propertyFields.extend({
  billToCustomerId: z.string().uuid().optional(),
  residentIds: z.array(z.string().uuid()).max(20).default([]),
});
export type PropertyCreateInput = z.infer<typeof propertyCreateSchema>;

/** Puts a customer on a property. A new bill-to ends the current one the day before it starts. */
export const assignmentSchema = z.object({
  customerId: z.string().uuid(),
  role: z.enum(PROPERTY_ROLES),
  startDate: isoDate.optional(),
});
export const endAssignmentSchema = z.object({ endDate: isoDate.optional() });

/**
 * A contact on a property who isn't a customer: a tenant, a property manager's on-site person, a
 * neighbor with the gate key. They don't get invoices and have no account; they're who the office
 * or the crew reaches about that address, and (when ticked) who gets the property's service
 * notifications. The fields follow Service Autopilot's Add Contact form.
 */
/** The contact types a company starts with (the list can be edited: Edit drop-down menus on a property page). */
export const PROPERTY_CONTACT_TYPES = ["Tenant", "Property manager", "Owner", "Spouse", "Family member", "Neighbor", "Other"] as const;
/** How they'd rather be reached; also how a service notification goes to them. */
export const FORMS_OF_CONTACT = ["call", "text", "email"] as const;
export type FormOfContact = (typeof FORMS_OF_CONTACT)[number];
export const FORM_OF_CONTACT_LABELS: Record<FormOfContact, string> = { call: "Phone call", text: "Text", email: "Email" };
/** The phone boxes, in the order the best number to show is picked. */
export const CONTACT_PHONES = [["cellPhone", "Cell"], ["homePhone", "Home"], ["workPhone", "Work"], ["otherPhone", "Other"]] as const;

const optDate = isoDate.optional().or(z.literal("").transform(() => undefined));
export const propertyContactSchema = z.object({
  firstName: optText(80),
  lastName: optText(80),
  nickname: optText(80),
  /** Contact type: who they are to the property; "Tenant" unless something else is picked. */
  relation: z.string().trim().max(60).optional().transform((v) => v || "Tenant"),
  email: optEmail,
  homePhone: optPhone,
  workPhone: optPhone,
  cellPhone: optPhone,
  otherPhone: optPhone,
  fax: optPhone,
  formOfContact: z.preprocess((v) => (v === "" ? null : v), z.enum(FORMS_OF_CONTACT).nullable()).optional(),
  birthday: optDate,
  notes: optText(1000),
  /** Receives this property's service notifications (the pre-visit notice and the after-application notice). */
  notify: z.boolean().default(false),
  /** When they moved in or started (optional). */
  startDate: optDate,
}).superRefine((c, ctx) => {
  if (!c.firstName && !c.lastName) ctx.addIssue({ code: "custom", path: ["firstName"], message: "Enter the contact's first or last name" });
  const anyPhone = c.cellPhone || c.homePhone || c.workPhone || c.otherPhone;
  if (c.formOfContact === "email" && !c.email) ctx.addIssue({ code: "custom", path: ["formOfContact"], message: "Form of contact is Email, so enter their email address" });
  if (c.formOfContact === "text" && !c.cellPhone) ctx.addIssue({ code: "custom", path: ["formOfContact"], message: "Form of contact is Text, so enter their cell phone" });
  if (c.formOfContact === "call" && !anyPhone) ctx.addIssue({ code: "custom", path: ["formOfContact"], message: "Form of contact is Phone call, so enter a phone number" });
  if (c.notify && !c.email && !anyPhone) ctx.addIssue({ code: "custom", path: ["notify"], message: "To get service notifications they need an email address or a phone number" });
});
export type PropertyContactInput = z.infer<typeof propertyContactSchema>;

type ContactReach = { email?: string | null; cellPhone?: string | null; homePhone?: string | null; workPhone?: string | null; otherPhone?: string | null; formOfContact?: string | null };
/** "Tina Tenant", or the nickname when that's all there is. */
export const contactName = (c: { firstName?: string | null; lastName?: string | null; nickname?: string | null }) =>
  [c.firstName, c.lastName].map((x) => x?.trim()).filter(Boolean).join(" ") || c.nickname?.trim() || "";
/** The number to show or call first: cell, then home, work, other. */
export const contactPhone = (c: ContactReach) => c.cellPhone || c.homePhone || c.workPhone || c.otherPhone || null;
/**
 * How a service notification reaches a contact: their form of contact when they have what it needs
 * (a cell phone for a text, an email address for an email, any phone for a call), else the next
 * thing they do have: email, then a text, then a call from the office. Null: no way to reach them.
 */
export function contactChannel(c: ContactReach): FormOfContact | null {
  const can: Record<FormOfContact, boolean> = { email: !!c.email, text: !!c.cellPhone, call: !!contactPhone(c) };
  const wanted = c.formOfContact as FormOfContact | null | undefined;
  if (wanted && can[wanted]) return wanted;
  return (["email", "text", "call"] as const).find((k) => can[k]) ?? null;
}

export const cancelSchema = z.object({
  reasonId: z.string().uuid({ message: "Choose a reason" }),
  effectiveDate: isoDate.optional(),
  comment: optText(2000),
});
export type CancelInput = z.infer<typeof cancelSchema>;

export const cancelReasonSchema = z.object({
  label: z.string().trim().min(1, "Enter the reason").max(100),
  initiatedBy: z.enum(CANCEL_INITIATORS).default("customer"),
  commentRequired: z.boolean().default(false),
  retired: z.boolean().default(false),
});

export const tagSchema = z.object({
  name: z.string().trim().min(1, "Enter the tag name").max(40),
  color: z.enum(TAG_COLORS).default("gray"),
  description: optText(200),
  archived: z.boolean().default(false),
});
export type TagInput = z.infer<typeof tagSchema>;

/** Adds or removes one tag on many customers and/or properties at once. */
export const bulkTagSchema = z.object({
  tagId: z.string().uuid(),
  action: z.enum(["add", "remove"]),
  customerIds: z.array(z.string().uuid()).max(1000).default([]),
  propertyIds: z.array(z.string().uuid()).max(1000).default([]),
});

/** How a customer is shown in lists: the company for commercial and HOA accounts, else "First Last". */
export function customerName(c: { kind?: string | null; firstName?: string | null; lastName?: string | null; companyName?: string | null }): string {
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
  if (c.companyName && (c.kind !== "residential" || !person)) return c.companyName;
  return person || c.companyName || "Unnamed customer";
}

/** "1234 Elm St, Norman, OK 73069" (parts left out when missing). */
export function formatAddress(a: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string {
  const cityState = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.street, cityState].filter(Boolean).join(", ");
}

/**
 * A property's total size: the total as entered (so it can be overridden by hand), or front + back +
 * other when it's left blank and any of those is given.
 */
export function lawnTotal(p: { frontSqFt?: number | null; backSqFt?: number | null; otherSqFt?: number | null; lawnSqFt?: number | null }): number | null {
  if (p.lawnSqFt != null) return Math.round(p.lawnSqFt);
  if (p.frontSqFt != null || p.backSqFt != null || p.otherSqFt != null) return Math.round((p.frontSqFt ?? 0) + (p.backSqFt ?? 0) + (p.otherSqFt ?? 0));
  return null;
}

/** The day before an ISO date (a replaced bill-to's last day). */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** A call or note on a customer (like Homeworks' Call Notes): who to tell, and an optional follow-up to-do. */
export const customerNoteSchema = z.object({
  kind: z.enum(["call", "note"]).default("call"),
  body: z.string().trim().min(1, "Write the note").max(5000),
  notifyIds: z.array(z.string().uuid()).max(20).default([]),
  todoId: z.string().uuid().optional(),
});
export type CustomerNoteInput = z.infer<typeof customerNoteSchema>;

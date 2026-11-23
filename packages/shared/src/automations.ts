import { z } from "zod";
import { MESSAGE_FIELDS, SAMPLE_MESSAGE_VARS } from "./customerMessages";

/**
 * Automations, like Homeworks' automations and sequences: when something happens (an estimate is
 * sent, an invoice goes past due, a tag is added…), run steps one after another, each after a
 * wait: email or text the customer from a template, tell the office, tag the customer, or make a
 * to-do. A run stops early when its "stop when" happens (e.g. the estimate is answered).
 */

export const AUTOMATION_TRIGGERS = {
  estimate_sent: { label: "Estimate is sent", group: "Estimates", subject: "estimate", stop: ["estimate_answered"] },
  estimate_accepted: { label: "Estimate is accepted", group: "Estimates", subject: "estimate", stop: [] },
  estimate_declined: { label: "Estimate is declined", group: "Estimates", subject: "estimate", stop: [] },
  estimate_changes: { label: "Estimate changes are requested", group: "Estimates", subject: "estimate", stop: [] },
  invoice_sent: { label: "Invoice is sent", group: "Invoices", subject: "invoice", stop: ["invoice_paid"] },
  invoice_past_due: { label: "Invoice becomes past due", group: "Invoices", subject: "invoice", stop: ["invoice_paid"] },
  invoice_paid: { label: "Invoice is paid in full", group: "Invoices", subject: "invoice", stop: [] },
  payment_received: { label: "Payment is made on an account", group: "Invoices", subject: "payment", stop: [] },
  visit_added: { label: "Work order is added", group: "Work orders", subject: "visit", stop: ["visit_closed"] },
  visit_upcoming: { label: "Before a work order happens", group: "Work orders", subject: "visit", stop: ["visit_closed"] },
  visit_completed: { label: "Work order is completed", group: "Work orders", subject: "visit", stop: [] },
  visit_skipped: { label: "Work order is skipped", group: "Work orders", subject: "visit", stop: [] },
  customer_added: { label: "New customer is added", group: "Customers", subject: "customer", stop: [] },
  tag_added: { label: "A tag is added to a customer", group: "Customers", subject: "customer", stop: ["tag_removed"] },
  tag_removed: { label: "A tag is taken off a customer", group: "Customers", subject: "customer", stop: [] },
} as const;
export type AutomationTrigger = keyof typeof AUTOMATION_TRIGGERS;
export const TRIGGER_KEYS = Object.keys(AUTOMATION_TRIGGERS) as AutomationTrigger[];

export const STOP_CONDITIONS = {
  estimate_answered: "The estimate is accepted, declined or changes are asked for",
  invoice_paid: "The invoice is paid (or voided)",
  visit_closed: "The work order is done, skipped or cancelled",
  tag_removed: "The tag comes off the customer",
  customer_cancelled: "The customer is cancelled",
} as const;
export type StopCondition = keyof typeof STOP_CONDITIONS;
/** The stop conditions that make sense for a trigger (customer cancelled always does). */
export const stopsFor = (t: AutomationTrigger): StopCondition[] => {
  const s = AUTOMATION_TRIGGERS[t].subject;
  return [...(s === "estimate" ? ["estimate_answered"] : s === "invoice" ? ["invoice_paid"] : s === "visit" ? ["visit_closed"] : []), ...(t === "tag_added" ? ["tag_removed"] : []), "customer_cancelled"] as StopCondition[];
};

export const AUTOMATION_ACTIONS = {
  email_customer: "Email the customer",
  text_customer: "Text the customer",
  email_staff: "Email people in the office",
  notify_staff: "Notify people in the office (app notification)",
  add_tag: "Add a tag to the customer",
  remove_tag: "Take a tag off the customer",
  create_todo: "Make a to-do (due 8 AM the next day)",
} as const;
export type AutomationAction = keyof typeof AUTOMATION_ACTIONS;
/** Actions that reach the customer (they wait for approval when an automation is set to review first). */
export const CUSTOMER_FACING: AutomationAction[] = ["email_customer", "text_customer"];

const uuid = z.string().uuid();
export const automationStepSchema = z.object({
  /** Minutes to wait after the trigger (first step) or the step before. */
  waitMinutes: z.coerce.number().int().min(0).max(60 * 24 * 120).default(0),
  action: z.enum(Object.keys(AUTOMATION_ACTIONS) as [AutomationAction, ...AutomationAction[]]),
  templateId: uuid.nullable().optional(),
  employeeIds: z.array(uuid).max(20).default([]),
  tagId: uuid.nullable().optional(),
  todoTitle: z.string().trim().max(200).nullable().optional(),
}).superRefine((s, ctx) => {
  const need = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (["email_customer", "text_customer", "email_staff", "notify_staff"].includes(s.action) && !s.templateId) need("templateId", "Choose a template");
  if (["email_staff", "notify_staff"].includes(s.action) && !s.employeeIds.length) need("employeeIds", "Choose who in the office");
  if (["add_tag", "remove_tag"].includes(s.action) && !s.tagId) need("tagId", "Choose the tag");
  if (s.action === "create_todo" && !s.todoTitle) need("todoTitle", "Name the to-do");
  if (s.action === "create_todo" && !s.employeeIds.length) need("employeeIds", "Choose who it's for");
});
export type AutomationStep = z.infer<typeof automationStepSchema>;

export const automationSchema = z.object({
  name: z.string().trim().min(1, "Name it").max(120),
  description: z.string().trim().max(500).nullable().optional(),
  enabled: z.boolean().default(false),
  trigger: z.enum(TRIGGER_KEYS as [AutomationTrigger, ...AutomationTrigger[]]),
  /** "Before a work order happens": how many days before (at 8 AM). */
  daysBefore: z.coerce.number().int().min(1).max(14).nullable().optional(),
  /** "A tag is added/taken off": which tag. */
  tagId: uuid.nullable().optional(),
  /** Only customers with any of these tags; never customers with any of those. */
  onlyTagIds: z.array(uuid).max(20).default([]),
  exceptTagIds: z.array(uuid).max(20).default([]),
  stopWhen: z.array(z.enum(Object.keys(STOP_CONDITIONS) as [StopCondition, ...StopCondition[]])).default([]),
  /** Customer emails and texts wait for someone to approve them (Automations → Review). */
  review: z.boolean().default(false),
  steps: z.array(automationStepSchema).min(1, "Add at least one step").max(12),
}).superRefine((a, ctx) => {
  if (a.trigger === "visit_upcoming" && !a.daysBefore) ctx.addIssue({ code: "custom", path: ["daysBefore"], message: "How many days before?" });
  if ((a.trigger === "tag_added" || a.trigger === "tag_removed") && !a.tagId) ctx.addIssue({ code: "custom", path: ["tagId"], message: "Which tag?" });
});
export type AutomationInput = z.infer<typeof automationSchema>;

export const messageTemplateSchema = z.object({
  kind: z.enum(["email", "text"]),
  name: z.string().trim().min(1, "Name it").max(120),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1, "Write the message").max(10000),
}).superRefine((t, ctx) => {
  if (t.kind === "email" && !t.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "Write the subject" });
  if (t.kind === "text" && t.body.length > 1000) ctx.addIssue({ code: "custom", path: ["body"], message: "Keep texts under 1,000 characters" });
});
export type MessageTemplateInput = z.infer<typeof messageTemplateSchema>;

/** Fill-in fields for automation templates: the customer's, plus what the automation is about. */
export const AUTOMATION_FIELDS: readonly (readonly [string, string, string])[] = [
  ...MESSAGE_FIELDS,
  ["estimate_number", "Estimate #", ""],
  ["estimate_title", "Estimate title", ""],
  ["estimate_total", "Estimate total", ""],
  ["estimate_link", "Estimate link", "Where they see and accept it"],
  ["invoice_number", "Invoice #", ""],
  ["invoice_total", "Invoice total", ""],
  ["invoice_balance", "Invoice balance", "What's still owed"],
  ["invoice_due", "Invoice due date", ""],
  ["pay_link", "Pay link", "Pay the invoice online"],
  ["visit_title", "Work order", "e.g. Round 2 fertilizer"],
  ["visit_date", "Work order date", ""],
  ["visit_address", "Service address", ""],
  ["payment_amount", "Payment amount", ""],
  ["portal_link", "Customer portal link", ""],
];
export const SAMPLE_AUTOMATION_VARS: Record<string, string> = {
  ...(SAMPLE_MESSAGE_VARS as Record<string, string>), estimate_number: "1042", estimate_title: "Spring program", estimate_total: "$480.00", estimate_link: "https://…/estimate/abc",
  invoice_number: "2107", invoice_total: "$65.00", invoice_balance: "$65.00", invoice_due: "Apr 30, 2027", pay_link: "https://…/pay/abc",
  visit_title: "Round 2 fertilizer", visit_date: "Tue, Apr 13", visit_address: "1 Oak St, Norman", payment_amount: "$65.00", portal_link: "https://…/portal",
};

const FIELD_RE = /\{\s*([a-z_]+)\s*\}/gi;
/** The template with each {field} filled from `vars` ({fields} without a value are left blank; unknown words stay). */
export function fillTemplate(template: string, vars: Record<string, string | undefined>): string {
  const known = new Set(AUTOMATION_FIELDS.map(([k]) => k));
  return template.replace(FIELD_RE, (all, name: string) => {
    const k = name.toLowerCase();
    return known.has(k) ? vars[k] ?? "" : all;
  });
}

/** "Instantly", "after 15 minutes", "after 3 days"… */
export function describeWait(minutes: number): string {
  if (!minutes) return "Instantly";
  const [n, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  return `After ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Texts only go out between these hours (company time), like Homeworks. */
export const TEXT_HOURS = { start: 9, end: 18 } as const;

import { z } from "zod";
import { templateImportSchema } from "./templates";

/**
 * Automations, laid out and worded like Homeworks' Marketing → Automations. Two kinds, one engine:
 *
 * - Automations: when the Trigger Condition happens, at the Run Time (instantly, minutes or days
 *   after, or days before a work order / due date), do one Action: text or email the customer, the
 *   company owner or an employee, push a reminder, or add or remove a tag. A Sub Action can then
 *   run another automation, or stop this one.
 * - Sequence Automations: IF a trigger happens AND its conditions are true (OR another group of
 *   conditions is), do the actions, each after its Waiting Period. ELSE Trigger blocks catch other
 *   triggers. It stops for that customer when a Stop When happens, and can do Stop Actions then.
 *
 * Messages come from Templates. Texts only go out 9 AM to 6 PM (company time); "before" triggers
 * fire at 9 AM. With "Review Before Execution", each action waits in Review Sequence.
 *
 * Triggers keep Homeworks' own keys and wording (a Homeworks "Visit" is a Crewdesk work order), so
 * their automations import as they are.
 */

export const AUTOMATION_KINDS = ["simple", "sequence"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** What a trigger is about (and so what its messages can fill in). "none": nothing (a set time). */
export type AutomationSubject = "visit" | "todo" | "maintenance" | "estimate" | "invoice" | "payment" | "customer" | "none";

/**
 * Where a trigger works in Crewdesk: "simple" (an automation's Trigger Condition), "if" (a
 * sequence's IF and ELSE triggers: something that happens), "and" (a sequence's Conditions:
 * something that's true when it starts), "stop" (a sequence's Stop When).
 */
export type TriggerUse = "simple" | "if" | "and" | "stop";
export type TriggerParam = "tags" | "categories" | "services" | "datetime";

export type TriggerDef = {
  /** Homeworks' wording in sequences. */
  label: string;
  /** Homeworks' wording in the Automations tab, where it differs. */
  simpleLabel?: string;
  /** Homeworks' wording in Stop When, where it differs. */
  stopLabel?: string;
  subject: AutomationSubject;
  use: readonly TriggerUse[];
  /** What else to pick: tags, to-do categories, price-list services, or a date and time. */
  param?: TriggerParam;
  /** "Before" triggers: the days before (at 9 AM) it can run. */
  before?: readonly number[];
  /** Not in Crewdesk (yet): kept so Homeworks automations import, but they can't run. */
  na?: string;
};

const NA_MEETINGS = "Crewdesk doesn't have meetings. Use a to-do (with a category) instead.";
const NA_REVIEWS = "Crewdesk doesn't collect customer reviews yet.";

/** Every trigger, keyed by Homeworks' own names. */
export const TRIGGERS = {
  certain_time: { label: "Run at a Certain Time", subject: "none", use: ["simple"], param: "datetime" },

  add_visit: { label: "Work Order is Added", subject: "visit", use: ["simple", "if", "stop"] },
  before_visit: { label: "Before a Work Order Happens", subject: "visit", use: ["simple"], before: [1, 2, 3] },
  complete_visit: { label: "Work Order is Completed", subject: "visit", use: ["simple", "if", "stop"] },
  visit_skipped: { label: "Work Order is Skipped", subject: "visit", use: ["simple", "if", "stop"] },
  property_not_serviced: { label: "Property is Not Serviced", subject: "visit", use: ["simple"] },
  start_timer: { label: "Job Timer Started", subject: "visit", use: ["simple", "if"] },
  stop_timer: { label: "Job Timer Stopped", subject: "visit", use: ["simple", "if"] },
  has_no_recurring_job: { label: "Customer Does Not Have Recurring Service", subject: "customer", use: ["and", "stop"] },

  todo_created: { label: "To-do is Added", subject: "todo", use: ["simple", "if"] },
  before_todo: { label: "Before a To-do Happens", subject: "todo", use: ["simple"], before: [1, 2, 3] },
  complete_task: { label: "To-do is Completed", subject: "todo", use: ["simple", "if", "stop"] },
  todo_has_category: { label: "To-do has Category", subject: "todo", use: ["and"], param: "categories" },

  add_maintenance: { label: "Equipment Maintenance Added", subject: "maintenance", use: ["simple", "if"] },
  before_maintenance: { label: "Before an Equipment Maintenance Happens", subject: "maintenance", use: ["simple"], before: [1, 2, 3] },
  complete_maintenance: { label: "Maintenance is completed", subject: "maintenance", use: ["simple", "if"] },

  customer_added: { label: "New Customer is Added", subject: "customer", use: ["simple", "if"] },
  customer_inactive: { label: "Customer Marked as Inactive", subject: "customer", use: ["simple", "if", "and", "stop"] },
  tag_added: { label: "Tag has been Added", simpleLabel: "A Tag is Added", subject: "customer", use: ["simple", "if", "stop"], param: "tags" },
  tag_removed: { label: "Tag has been Removed", subject: "customer", use: ["simple", "if", "stop"], param: "tags" },
  customer_has_tag: { label: "Customer has a Tag", subject: "customer", use: ["and", "stop"], param: "tags" },
  customer_does_not_have_tag: { label: "Customer does not have a Tag", subject: "customer", use: ["and", "stop"], param: "tags" },

  estimate_create: { label: "Estimate is Created", subject: "estimate", use: ["simple", "if"] },
  estimate_draft: { label: "Estimate Status Draft", subject: "estimate", use: ["and"] },
  estimate_sent: { label: "Estimate is Sent", subject: "estimate", use: ["simple", "if"] },
  estimate_service: { label: "Estimate has Service", subject: "estimate", use: ["and"], param: "services" },
  estimate_accept: { label: "Estimate is Accepted", subject: "estimate", use: ["simple", "if", "and", "stop"] },
  estimate_declined: { label: "Estimate is Declined", subject: "estimate", use: ["simple", "if", "and", "stop"] },
  estimate_changes: { label: "Estimate Changes are Requested", subject: "estimate", use: ["simple", "if", "and", "stop"] },
  estimate_responded: { label: "Estimate is Accepted or Declined", simpleLabel: "If an Estimate is Accepted or Declined", subject: "estimate", use: ["simple", "if", "stop"] },
  estimate_not_responded: { label: "Estimate is not Accepted or Declined (3 days after sent)", simpleLabel: "If an Estimate is not Accepted or Declined", subject: "estimate", use: ["simple", "if"] },

  invoice_sent: { label: "Invoice is Sent", subject: "invoice", use: ["simple", "if"] },
  invoice_past_due: { label: "Invoice Becomes Past Due", subject: "invoice", use: ["simple", "if"] },
  before_invoice_past_due: { label: "Before Invoice Becomes Past Due", subject: "invoice", use: ["simple"], before: [1, 2, 3, 5, 7, 15, 30] },
  invoice_paid_in_full: { label: "Invoice is Paid in Full", subject: "invoice", use: ["simple", "if", "and", "stop"] },
  invoice_partially_paid: { label: "Invoice is Partially Paid", subject: "invoice", use: ["simple", "if", "and", "stop"] },
  invoice_write_off: { label: "Invoice is Written Off", subject: "invoice", use: ["simple", "if", "stop"] },

  payment_to_account: { label: "Payment Made on an Account", subject: "payment", use: ["simple", "if", "stop"] },
  customer_payment_declined: { label: "Customer Payment was declined", subject: "invoice", use: ["simple", "if"] },
  payment_receipt: { label: "Payment Receipt Sent", subject: "payment", use: ["simple", "if"] },
  customer_added_a_credit_card: { label: "Customer Added a Credit Card", stopLabel: "Customer has a Credit/Debit Card on File", subject: "customer", use: ["simple", "if", "and", "stop"] },
  customer_added_bank_account: { label: "Customer Added Bank Account", subject: "customer", use: ["simple", "if", "and", "stop"] },
  customer_does_not_have_card_on_file: { label: "Customer has no Credit Card on File", subject: "customer", use: ["and", "stop"] },
  customer_removed_credit_card: { label: "Customer Removed Credit Card", subject: "customer", use: ["simple", "if"] },
  customer_removed_bank_account: { label: "Customer Removed Bank Account", subject: "customer", use: ["simple", "if"] },
  customer_added_bank_account_not_verified: { label: "Customer Added Bank Account But ACH not Verified", subject: "customer", use: ["simple", "if"], na: "Crewdesk only saves a bank account once it's verified." },
  tip_added: { label: "Tip Added on Payment", subject: "payment", use: ["if", "and"], na: "Crewdesk doesn't take tips yet." },
  expense_added: { label: "New Expense", subject: "none", use: ["if"], na: "Crewdesk doesn't track expenses here." },

  meeting_created: { label: "Meeting is Added", subject: "customer", use: ["simple", "if"], na: NA_MEETINGS },
  before_meeting: { label: "Before a Meeting Happens", subject: "customer", use: ["simple"], before: [1, 2, 3], na: NA_MEETINGS },
  complete_meeting: { label: "Meeting is Completed", subject: "customer", use: ["simple", "if"], na: NA_MEETINGS },
  meeting_has_category: { label: "Meeting has Category", subject: "customer", use: ["and"], na: NA_MEETINGS },

  add_work_request: { label: "Work Request Submitted", simpleLabel: "Work Request is Received", subject: "customer", use: ["simple", "if"], na: "Crewdesk doesn't take work requests online yet." },
  customer_has_not_give_rating: { label: "A Customer Has Not Left a Review", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
  customer_give_a_rating: { label: "A Customer Left a Review of Any Rating (0-5 Stars)", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
  customer_give_average_rating: { label: "A Customer Left a Review With a Rating of 0 to 3.5 Stars", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
  customer_give_awesome_rating: { label: "A Customer Left a Review With a Rating of 4 to 5 Stars", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
} as const satisfies Record<string, TriggerDef>;
export type TriggerKey = keyof typeof TRIGGERS;
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as TriggerKey[];
export const triggerDef = (k: string): TriggerDef | undefined => (TRIGGERS as Record<string, TriggerDef>)[k];

/** The Automations tab's Trigger Condition list, in Homeworks' order. */
export const SIMPLE_TRIGGER_ORDER: readonly TriggerKey[] = [
  "certain_time", "add_visit", "todo_created", "meeting_created", "add_maintenance", "before_visit", "before_todo", "before_meeting", "before_maintenance",
  "complete_visit", "complete_task", "complete_meeting", "complete_maintenance", "estimate_sent", "estimate_accept", "estimate_declined", "estimate_changes",
  "estimate_responded", "estimate_not_responded", "customer_added", "tag_added", "add_work_request", "property_not_serviced", "invoice_past_due",
  "before_invoice_past_due", "invoice_sent", "payment_to_account", "payment_receipt", "start_timer", "stop_timer", "customer_added_a_credit_card",
  "customer_added_bank_account", "customer_added_bank_account_not_verified", "customer_removed_bank_account", "customer_removed_credit_card",
  "customer_has_not_give_rating", "customer_give_a_rating", "customer_give_average_rating", "customer_give_awesome_rating",
];
/** A sequence's trigger, condition and Stop When lists (the same list in Homeworks), in its order. */
export const SEQUENCE_TRIGGER_ORDER: readonly TriggerKey[] = [
  "add_visit", "complete_visit", "visit_skipped", "has_no_recurring_job", "meeting_created", "meeting_has_category", "complete_meeting", "todo_created",
  "todo_has_category", "complete_task", "add_maintenance", "complete_maintenance", "start_timer", "stop_timer", "add_work_request", "customer_has_tag",
  "customer_does_not_have_tag", "tag_added", "tag_removed", "customer_has_not_give_rating", "customer_give_a_rating", "customer_give_average_rating",
  "customer_give_awesome_rating", "customer_added", "customer_inactive", "estimate_create", "estimate_draft", "estimate_sent", "estimate_service",
  "estimate_accept", "estimate_declined", "estimate_changes", "estimate_responded", "estimate_not_responded", "invoice_past_due", "invoice_sent",
  "invoice_paid_in_full", "invoice_partially_paid", "invoice_write_off", "customer_does_not_have_card_on_file", "customer_added_a_credit_card",
  "customer_added_bank_account", "customer_added_bank_account_not_verified", "customer_removed_bank_account", "customer_removed_credit_card",
  "customer_payment_declined", "payment_to_account", "payment_receipt", "tip_added", "expense_added",
];
export const triggerListFor = (use: TriggerUse): readonly TriggerKey[] => (use === "simple" ? SIMPLE_TRIGGER_ORDER : SEQUENCE_TRIGGER_ORDER);
/** Whether a trigger works in that place in Crewdesk (the lists show all of Homeworks'; the rest are greyed out). */
export const triggerWorksAs = (k: string, use: TriggerUse) => { const d = triggerDef(k); return !!d && (d.use as readonly TriggerUse[]).includes(use); };
export const triggersFor = (use: TriggerUse) => TRIGGER_KEYS.filter((k) => triggerWorksAs(k, use));
/** The trigger's wording where it's used. */
export const triggerLabel = (k: string, use: TriggerUse = "if") => {
  const d = triggerDef(k);
  if (!d) return k;
  return (use === "simple" && d.simpleLabel) || (use === "stop" && d.stopLabel) || d.label;
};

/** Homeworks' other names for the same triggers (its Automations tab and sequences differ a little). */
export const TRIGGER_ALIASES: Record<string, TriggerKey> = {
  add_meeting: "meeting_created", add_task: "todo_created", before_task: "before_todo", visit_added: "add_visit", visit_completed: "complete_visit",
  todo_completed: "complete_task", complete_todo: "complete_task", before_equipment_maintenance: "before_maintenance", estimate_accepted: "estimate_accept",
  before_invoice_due: "before_invoice_past_due",
};
export const triggerKeyFor = (k: string): TriggerKey | null => (k in TRIGGERS ? (k as TriggerKey) : TRIGGER_ALIASES[k] ?? null);

/** Triggers with nobody to message (the owner, employees, pushes and to-dos still work). */
export const triggerHasCustomer = (k: string) => { const s = triggerDef(k)?.subject; return !!s && s !== "none" && s !== "maintenance"; };

/* ───────────── Actions ───────────── */

export type ActionDef = {
  /** Homeworks' wording in sequences. */
  label: string;
  /** Homeworks' wording in the Automations tab, where it differs. */
  simpleLabel?: string;
  channel?: "email" | "text";
  /** Who it's for. "assigned": whoever the work order or to-do is given to (else the owner). */
  to: "customer" | "owner" | "employee" | "assigned";
  needs?: "tag" | "todo";
};
export const AUTOMATION_ACTIONS = {
  text_admin: { label: "Text Company Owner", channel: "text", to: "owner" },
  email_admin: { label: "Email Company Owner", channel: "email", to: "owner" },
  text_customer: { label: "Text Customer", channel: "text", to: "customer" },
  email_customer: { label: "Email Customer", channel: "email", to: "customer" },
  text_employee: { label: "Text Employee", channel: "text", to: "employee" },
  email_employee: { label: "Email Employee", channel: "email", to: "employee" },
  push_notification: { label: "Push Notification Reminder", to: "assigned" },
  add_tag: { label: "Add a Tag to Customer", simpleLabel: "Add a Tag", to: "customer", needs: "tag" },
  remove_tag: { label: "Remove a Tag from Customer", simpleLabel: "Remove a Tag", to: "customer", needs: "tag" },
  create_assign_todo: { label: "Create & Assigned To-do (Due 8AM Next Day From Waiting Period )", to: "employee", needs: "todo" },
} as const satisfies Record<string, ActionDef>;
export type ActionKey = keyof typeof AUTOMATION_ACTIONS;
export const ACTION_KEYS = Object.keys(AUTOMATION_ACTIONS) as ActionKey[];
/** The Automations tab offers these (sequences add the to-do). */
export const SIMPLE_ACTION_KEYS = ACTION_KEYS.filter((k) => k !== "create_assign_todo");
export const actionDef = (k: string): ActionDef | undefined => (AUTOMATION_ACTIONS as Record<string, ActionDef>)[k];
export const actionLabel = (k: string, simple = false) => { const d = actionDef(k); return d ? (simple && d.simpleLabel) || d.label : k; };
/** Whether an action sends a text (so it waits for 9 AM–6 PM). */
export const isTextAction = (k: string) => actionDef(k)?.channel === "text";

/* ───────────── Times ───────────── */

/** Texts only go out between these hours (company time), like Homeworks. */
export const TEXT_HOURS = { start: 9, end: 18 } as const;
/** "Before" triggers fire at this hour, the set number of days before. */
export const BEFORE_HOUR = 9;
/** A to-do from a sequence is due at 8 AM the day after its waiting period. */
export const TODO_DUE_TIME = "08:00";
/** "Estimate is not accepted or declined" fires this many days after it's sent. */
export const NOT_ANSWERED_DAYS = 3;

export type RunTime = { delayMinutes: number; daysBefore: number | null };
export type RunTimeOption = RunTime & { value: string; label: string };
const days = (n: number) => `${n} Day${n === 1 ? "" : "s"}`;
/** Homeworks' Run Time list, in its order. */
export const RUN_TIMES: readonly RunTimeOption[] = [
  { value: "after:0", label: "Instantly", delayMinutes: 0, daysBefore: null },
  ...[1, 2, 3].map((n) => ({ value: `before:${n}`, label: `${days(n)} Before The Event Happens`, delayMinutes: 0, daysBefore: n })),
  { value: "after:2", label: "2 Minutes After Trigger Condition", delayMinutes: 2, daysBefore: null },
  { value: "after:15", label: "15 Minutes After Trigger Condition", delayMinutes: 15, daysBefore: null },
  ...[1, 3, 5, 7, 15, 30].map((n) => ({ value: `after:${n * 1440}`, label: `${days(n)} After Trigger Condition`, delayMinutes: n * 1440, daysBefore: null })),
];
/** "Before Invoice Becomes Past Due" adds these (Homeworks does too). */
export const RUN_TIMES_BEFORE_DUE: readonly RunTimeOption[] = [1, 3, 5, 7, 15, 30].map((n) => ({ value: `beforedue:${n}`, label: `${days(n)} Before Trigger Condition`, delayMinutes: 0, daysBefore: n }));
/** The Run Time list for a trigger (the same list for every trigger, as in Homeworks). */
export const runTimeOptions = (trigger: string): readonly RunTimeOption[] => (trigger === "before_invoice_past_due" ? [...RUN_TIMES, ...RUN_TIMES_BEFORE_DUE] : RUN_TIMES);
/** Whether a run time makes sense for a trigger: "before" ones only for "before" triggers, and the other way round. */
export const runTimeFits = (trigger: string, o: RunTime) => (triggerDef(trigger)?.before ? o.daysBefore != null : o.daysBefore == null);
/** The option matching an automation's run time (the first that fits). */
export function runTimeValue(trigger: string, t: RunTime): string {
  const list = runTimeOptions(trigger);
  const hit = t.daysBefore != null
    ? (trigger === "before_invoice_past_due" && ![1, 2, 3].includes(t.daysBefore) ? RUN_TIMES_BEFORE_DUE : list).find((o) => o.daysBefore === t.daysBefore)
    : list.find((o) => o.daysBefore == null && o.delayMinutes === t.delayMinutes);
  return hit?.value ?? (t.daysBefore != null ? `before:${t.daysBefore}` : `after:${t.delayMinutes}`);
}
/** A run time from its option value ("after:15", "before:1", "beforedue:7"). */
export function parseRunTime(value: string): RunTime | null {
  const m = /^(after|before|beforedue):(\d+)$/.exec(value);
  if (!m) return null;
  return m[1] === "after" ? { delayMinutes: Number(m[2]), daysBefore: null } : { delayMinutes: 0, daysBefore: Number(m[2]) };
}

/** "When To Run The Next Automation", in minutes after the first runs. */
export const SUB_DELAYS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "Instantly" },
  { minutes: 15, label: "15 Minutes After First Automation Runs" },
  ...[1, 3, 5, 7, 15, 30].map((n) => ({ minutes: n * 1440, label: `${days(n)} After First Automation Runs` })),
];
const MAX_WAIT = 366 * 1440;

/** "Instantly", "After 2 days", "After 1 day 3 hours", "After 30 minutes". */
export function describeWait(minutes: number): string {
  if (!minutes) return "Instantly";
  return `After ${waitText(minutes)}`;
}
/** "1 day", "2 days 3 hours", "30 minutes"; instantly reads "1 second", as Homeworks shows it. */
export function waitText(minutes: number): string {
  if (!minutes) return "1 second";
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(d, "day"), part(h, "hour"), part(m, "minute")].filter(Boolean).join(" ");
}
/** Days, hours and minutes of a wait (for the sequence editor). */
export const splitWait = (minutes: number) => ({ days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 });

/* ───────────── Schemas ───────────── */

const uuid = z.string().uuid();
const ids = z.array(uuid).max(50).default([]);

/** A trigger or condition, with what it needs picked (tags, categories, services). */
export const automationCondSchema = z.object({
  key: z.string().refine((k) => k in TRIGGERS, "Choose a trigger"),
  tagIds: ids,
  categoryIds: ids,
  serviceIds: ids,
});
export type AutomationCond = z.infer<typeof automationCondSchema>;

/** One action: what to do, when (minutes after the trigger, or after it stops for a Stop Action), and with which template. */
export const automationActionSchema = z.object({
  waitMinutes: z.coerce.number().int().min(0).max(MAX_WAIT).default(0),
  action: z.enum(ACTION_KEYS as [ActionKey, ...ActionKey[]]),
  templateId: uuid.nullable().default(null),
  employeeIds: z.array(uuid).max(20).default([]),
  tagId: uuid.nullable().default(null),
  todoTitle: z.string().trim().max(200).nullable().default(null),
});
export type AutomationAction = z.infer<typeof automationActionSchema>;

const base = {
  name: z.string().trim().min(1, "Name it").max(150),
  description: z.string().trim().max(2000).nullable().default(null),
  /** The automation's own Tags box (for finding it), not customer tags. */
  labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  enabled: z.boolean().default(true),
  /** Review Before Execution: each action waits in Review until someone approves it. */
  review: z.boolean().default(false),
};

export const SUB_ACTIONS = { none: "Nothing", run_automation: "Run Another Automation", stop_automation: "Stop Automation" } as const;
export type SubAction = keyof typeof SUB_ACTIONS;

export const simpleAutomationSchema = z.object({
  ...base,
  kind: z.literal("simple"),
  trigger: automationCondSchema,
  /** "Run at a Certain Time": the date and time (company time), "YYYY-MM-DDTHH:mm". */
  runAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable().default(null),
  /** Minutes after the trigger (0: instantly). */
  delayMinutes: z.coerce.number().int().min(0).max(MAX_WAIT).default(0),
  /** "Before" triggers: days before (at 9 AM). */
  daysBefore: z.coerce.number().int().min(1).max(60).nullable().default(null),
  action: automationActionSchema,
  subAction: z.enum(Object.keys(SUB_ACTIONS) as [SubAction, ...SubAction[]]).default("none"),
  subAutomationId: uuid.nullable().default(null),
  subDelayMinutes: z.coerce.number().int().min(0).max(MAX_WAIT).default(0),
});
export type SimpleAutomationInput = z.infer<typeof simpleAutomationSchema>;

export const sequenceBlockSchema = z.object({
  /** IF (or ELSE) this happens… */
  trigger: automationCondSchema,
  /**
   * …and its conditions are true: groups of AND conditions, and any one group being true is
   * enough (Homeworks' "OR Condition" starts another group). No groups: always.
   */
  when: z.array(z.array(automationCondSchema).min(1).max(10)).max(6).default([]),
  actions: z.array(automationActionSchema).min(1, "Add an action").max(30),
});
export type SequenceBlock = z.infer<typeof sequenceBlockSchema>;

export const sequenceSchema = z.object({
  ...base,
  kind: z.literal("sequence"),
  /** The IF block, then ELSE Trigger blocks (the first whose trigger and conditions match runs). */
  blocks: z.array(sequenceBlockSchema).min(1).max(10),
  /** Stop When: it stops (for that customer) when any of these happens. */
  stops: z.array(automationCondSchema).max(10).default([]),
  /** Stop Actions: done when it stops, each after its waiting period. */
  stopActions: z.array(automationActionSchema).max(10).default([]),
  /** Protect the sequence with a password: set a new one, or "" to take it off. Never sent back. */
  password: z.string().max(100).nullable().optional(),
});
export type SequenceInput = z.infer<typeof sequenceSchema>;

export const automationSchema = z.discriminatedUnion("kind", [simpleAutomationSchema, sequenceSchema]);
export type AutomationInput = z.infer<typeof automationSchema>;
type Meta = "name" | "description" | "labels" | "enabled" | "review" | "password";
/** What's stored: everything but the columns (name, description, labels, enabled, review). */
export type AutomationDef = Omit<SimpleAutomationInput, Meta> | Omit<SequenceInput, Meta>;

/** Every action an automation can do (a sequence's, then its stop actions). */
export function allActions(def: AutomationDef): AutomationAction[] {
  return def.kind === "simple" ? [def.action] : [...def.blocks.flatMap((b) => b.actions), ...def.stopActions];
}
/** Every trigger and condition it uses. */
export function allConds(def: AutomationDef): { cond: AutomationCond; use: TriggerUse }[] {
  if (def.kind === "simple") return [{ cond: def.trigger, use: "simple" }];
  return [
    ...def.blocks.flatMap((b) => [{ cond: b.trigger, use: "if" as const }, ...b.when.flat().map((cond) => ({ cond, use: "and" as const }))]),
    ...def.stops.map((cond) => ({ cond, use: "stop" as const })),
  ];
}

const USE_WORDS: Record<TriggerUse, string> = { simple: "as an automation's trigger", if: "as a sequence trigger (use it as a Condition)", and: "as a Condition (use it as a trigger)", stop: "as a Stop When" };

/**
 * What's wrong with an automation (so it can't be saved or run): missing picks, a trigger used
 * where it can't be, a customer action on a trigger with no customer. Template kinds and ids are
 * checked by the server.
 */
export function automationProblems(a: AutomationInput | AutomationDef): string[] {
  const out: string[] = [];
  const simple = a.kind === "simple";
  for (const { cond, use } of allConds(a as AutomationDef)) {
    const d = triggerDef(cond.key);
    if (!d) { out.push(`"${cond.key}" isn't a trigger`); continue; }
    const name = triggerLabel(cond.key, use);
    if (!(d.use as readonly TriggerUse[]).includes(use)) out.push(`"${name}" can't be used ${USE_WORDS[use]}`);
    if (d.param === "tags" && !cond.tagIds.length) out.push(`"${name}": choose the tag`);
    if (d.param === "categories" && !cond.categoryIds.length) out.push(`"${name}": choose the category`);
    if (d.param === "services" && !cond.serviceIds.length) out.push(`"${name}": choose the service`);
  }
  const noCustomer = a.kind === "simple" ? !triggerHasCustomer(a.trigger.key) : a.blocks.every((b) => !triggerHasCustomer(b.trigger.key));
  if (a.kind === "simple") {
    const d = triggerDef(a.trigger.key);
    if (d?.param === "datetime" && !a.runAt) out.push("Choose the date and time to run it");
    if (d && d.param !== "datetime" && !runTimeFits(a.trigger.key, a)) out.push(d.before ? `Run Time: choose how many days before ("${triggerLabel(a.trigger.key, "simple")}" runs at 9 AM that many days ahead)` : `Run Time: "Days Before" only works with the "Before…" triggers`);
    if (d?.before && a.daysBefore != null && !d.before.includes(a.daysBefore)) out.push("Run Time: choose one of the listed days before");
    if (a.subAction === "run_automation" && !a.subAutomationId) out.push("Next Automation: choose the automation to run next");
  }
  for (const [i, act] of allActions(a as AutomationDef).entries()) {
    const ad = AUTOMATION_ACTIONS[act.action] as ActionDef;
    const where = simple ? actionLabel(act.action, true) : `Action ${i + 1} (${ad.label.replace(/\s*\(.*$/, "")})`;
    if (ad.channel && !act.templateId) out.push(`${where}: choose the ${ad.channel === "email" ? "Email" : "Text"} Template`);
    if (ad.to === "employee" && !act.employeeIds.length) out.push(`${where}: choose the Employee`);
    if (ad.needs === "tag" && !act.tagId) out.push(`${where}: choose the Tag`);
    if (ad.needs === "todo" && !act.todoTitle) out.push(`${where}: enter the Title`);
    if (ad.to === "customer" && noCustomer) out.push(`${where}: this trigger has no customer, so it can only message the owner or employees`);
  }
  return out;
}

const naOf = (c: AutomationCond, use: TriggerUse) => { const d = triggerDef(c.key); return d && "na" in d && d.na ? `"${triggerLabel(c.key, use)}": ${d.na}` : null; };

/** The sequence blocks that can never run in Crewdesk (a trigger or condition it doesn't have), with why. */
export function deadBlocks(def: AutomationDef): { index: number; why: string }[] {
  if (def.kind !== "sequence") return [];
  const out: { index: number; why: string }[] = [];
  def.blocks.forEach((b, index) => {
    // A block is dead when its trigger can't happen, or every group of conditions has one that can't be true.
    const groupWhy = b.when.length && b.when.every((g) => g.some((c) => naOf(c, "and"))) ? b.when.flat().map((c) => naOf(c, "and")).find(Boolean) : null;
    const why = naOf(b.trigger, "if") ?? groupWhy;
    if (why) out.push({ index, why });
  });
  return out;
}

/**
 * Why it can't be turned on (it can only start on triggers Crewdesk doesn't have), or null. A
 * sequence with some blocks Crewdesk can't run can still be turned on: those blocks just never run.
 */
export function cannotTurnOn(def: AutomationDef): string | null {
  if (def.kind === "simple") { const why = naOf(def.trigger, "simple"); return why ? `Can't run: ${why}` : null; }
  const dead = deadBlocks(def);
  return dead.length === def.blocks.length ? `Can't run: ${dead[0].why}` : null;
}

/** The Run Time column: "Instantly", "1 Day Before The Event Happens", "15 Minutes After Trigger Condition", or the set date and time. */
export function describeRunTime(def: AutomationDef): string {
  if (def.kind !== "simple") return "";
  const d = triggerDef(def.trigger.key);
  if (d?.param === "datetime") {
    if (!def.runAt) return "";
    const [date, time] = def.runAt.split("T");
    const [h, m] = time.split(":").map(Number);
    return `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  }
  const value = runTimeValue(def.trigger.key, def);
  const known = runTimeOptions(def.trigger.key).find((o) => o.value === value);
  if (known) return known.label;
  return def.daysBefore != null ? `${days(def.daysBefore)} Before The Event Happens` : `${waitText(def.delayMinutes).replace(/\b[a-z]/g, (c) => c.toUpperCase())} After Trigger Condition`;
}

/* ───────────── Homeworks import ───────────── */

const hwPick = z.object({ value: z.string().nullable().optional(), text: z.string().nullable().optional() }).nullable().optional();
const hwCond = z.object({ value: z.string(), text: z.string().nullable().optional(), attrs: z.array(z.string()).default([]) });
const hwAction = z.object({
  instant: z.boolean().optional(), days: z.coerce.number().default(0), hours: z.coerce.number().default(0), minutes: z.coerce.number().default(0),
  action: hwPick, email: hwPick, text: hwPick, employee: hwPick, tag: hwPick, title: z.string().nullable().optional(),
});
const hwId = z.union([z.string(), z.number()]);
/**
 * The file Crewdesk's Homeworks export makes: their automations and sequences as they are there,
 * and (so it's one file) the email and text templates they use.
 */
export const automationImportSchema = z.object({
  source: z.literal("homeworks"),
  /** The same templates Templates → Import takes. */
  templates: z.array(templateImportSchema.shape.templates.element).max(1000).default([]),
  automations: z.array(z.object({
    id: hwId, on: z.boolean().nullable().optional(), review: z.boolean().nullable().optional(), title: z.string(),
    trigger: hwPick, tag: hwPick, date: z.string().nullable().optional(), time: z.string().nullable().optional(), delay: hwPick, action: hwPick, employee: hwPick,
    textTemplate: hwPick, emailTemplate: hwPick, actionTag: hwPick, subAction: hwPick, subAutomation: hwPick, subDelay: hwPick,
    notes: z.string().nullable().optional(), tags: z.array(z.string()).default([]),
  })).max(500).default([]),
  sequences: z.array(z.object({
    id: hwId, on: z.boolean().nullable().optional(), title: z.string(), description: z.string().nullable().optional(), review: z.boolean().nullable().optional(),
    blocks: z.array(z.object({ trigger: hwCond, when: z.array(z.array(hwCond)).default([]), actions: z.array(hwAction).default([]) })).max(20),
    stops: z.array(hwCond).default([]), stopActions: z.array(hwAction).default([]),
  })).max(200).default([]),
});
export type AutomationImport = z.infer<typeof automationImportSchema>;

/** Homeworks' run-time values for its automations (seconds; "before" ones end in 1). */
export function homeworksDelay(value: string | null | undefined): RunTime {
  const n = Number(value ?? 1);
  if (!Number.isFinite(n) || n <= 1) return { delayMinutes: 0, daysBefore: null };
  if (n % 86400 === 1) return { delayMinutes: 0, daysBefore: Math.round((n - 1) / 86400) };
  return { delayMinutes: Math.round(n / 60), daysBefore: null };
}

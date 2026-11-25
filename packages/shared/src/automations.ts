import { z } from "zod";

/**
 * Automations, like Homeworks' Marketing → Automations. Two kinds, one engine:
 *
 * - Automations: when something happens (the trigger), at a set time (instantly, minutes or days
 *   after, or days before a work order / due date), do one thing: email or text the customer,
 *   the owner or an employee, push a reminder, or add or remove a tag. Then, optionally, run
 *   another automation.
 * - Sequences: IF a trigger happens (OR another one), AND conditions hold, do a list of actions,
 *   each at a set time after the trigger. ELSE blocks catch other triggers. A sequence stops when
 *   any "stop when" happens (the estimate is answered, the invoice is paid…), and can do "stop
 *   actions" when it does.
 *
 * Messages come from Templates. Texts only go out 9 AM to 6 PM (company time); "before" triggers
 * fire at 9 AM. With "review before execution", each action waits in the Review list.
 */

export const AUTOMATION_KINDS = ["simple", "sequence"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** What a trigger is about (and so what its messages can fill in). "none": nothing (a set time). */
export type AutomationSubject = "visit" | "todo" | "maintenance" | "estimate" | "invoice" | "payment" | "customer" | "none";

/**
 * Where a trigger can be used: "simple" (an automation's trigger), "if" (a sequence's IF, OR and
 * ELSE triggers: something that happens), "and" (a sequence's AND conditions: something that's
 * true when it starts), "stop" (a sequence's Stop when).
 */
export type TriggerUse = "simple" | "if" | "and" | "stop";
export type TriggerParam = "tags" | "categories" | "services" | "datetime";

export type TriggerDef = {
  label: string;
  group: (typeof TRIGGER_GROUPS)[number];
  subject: AutomationSubject;
  use: readonly TriggerUse[];
  /** What else to pick: tags, to-do categories, price-list services, or a date and time. */
  param?: TriggerParam;
  /** "Before" triggers: how many days before (at 9 AM) an automation can run. */
  before?: readonly number[];
  /** Wording as an AND condition or Stop when, where it reads differently. */
  condLabel?: string;
  /** Not in Crewdesk (yet): kept so Homeworks automations import, but they can't be turned on. */
  na?: string;
};

export const TRIGGER_GROUPS = ["Time", "Work orders", "To-dos", "Equipment", "Customers & tags", "Estimates", "Invoices", "Payments & cards", "Meetings", "Reviews & requests"] as const;

const NA_MEETINGS = "Crewdesk doesn't have meetings. Use a to-do (with a category) instead.";
const NA_REVIEWS = "Crewdesk doesn't collect customer reviews yet.";

/** Every trigger, keyed by Homeworks' own names so their automations import as they are. */
export const TRIGGERS = {
  certain_time: { label: "Run at a certain time", group: "Time", subject: "none", use: ["simple"], param: "datetime" },

  add_visit: { label: "Work order is added", group: "Work orders", subject: "visit", use: ["simple", "if", "stop"], condLabel: "A new work order is added" },
  before_visit: { label: "Before a work order happens", group: "Work orders", subject: "visit", use: ["simple"], before: [1, 2, 3] },
  complete_visit: { label: "Work order is completed", group: "Work orders", subject: "visit", use: ["simple", "if", "stop"] },
  visit_skipped: { label: "Work order is skipped", group: "Work orders", subject: "visit", use: ["simple", "if", "stop"] },
  property_not_serviced: { label: "Property is not serviced (work order skipped)", group: "Work orders", subject: "visit", use: ["simple"] },
  start_timer: { label: "Job timer started (crew starts the work order)", group: "Work orders", subject: "visit", use: ["simple", "if"] },
  stop_timer: { label: "Job timer stopped (crew finishes the work order)", group: "Work orders", subject: "visit", use: ["simple", "if"] },
  has_no_recurring_job: { label: "Customer does not have recurring service", group: "Work orders", subject: "customer", use: ["and", "stop"] },

  todo_created: { label: "To-do is added", group: "To-dos", subject: "todo", use: ["simple", "if"] },
  before_todo: { label: "Before a to-do happens", group: "To-dos", subject: "todo", use: ["simple"], before: [1, 2, 3] },
  complete_task: { label: "To-do is completed", group: "To-dos", subject: "todo", use: ["simple", "if", "stop"] },
  todo_has_category: { label: "To-do has category", group: "To-dos", subject: "todo", use: ["and"], param: "categories" },

  add_maintenance: { label: "Equipment maintenance (repair order) is added", group: "Equipment", subject: "maintenance", use: ["simple", "if"] },
  before_maintenance: { label: "Before equipment maintenance is due", group: "Equipment", subject: "maintenance", use: ["simple"], before: [1, 2, 3] },
  complete_maintenance: { label: "Maintenance is completed", group: "Equipment", subject: "maintenance", use: ["simple", "if"] },

  customer_added: { label: "New customer is added", group: "Customers & tags", subject: "customer", use: ["simple", "if"] },
  customer_inactive: { label: "Customer is cancelled (marked inactive)", group: "Customers & tags", subject: "customer", use: ["simple", "if", "and", "stop"], condLabel: "Customer is cancelled" },
  tag_added: { label: "Tag is added", group: "Customers & tags", subject: "customer", use: ["simple", "if", "stop"], param: "tags" },
  tag_removed: { label: "Tag is removed", group: "Customers & tags", subject: "customer", use: ["simple", "if", "stop"], param: "tags" },
  customer_has_tag: { label: "Customer has a tag", group: "Customers & tags", subject: "customer", use: ["and", "stop"], param: "tags" },
  customer_does_not_have_tag: { label: "Customer does not have a tag", group: "Customers & tags", subject: "customer", use: ["and", "stop"], param: "tags" },

  estimate_create: { label: "Estimate is created", group: "Estimates", subject: "estimate", use: ["simple", "if"] },
  estimate_draft: { label: "Estimate is a draft", group: "Estimates", subject: "estimate", use: ["and"] },
  estimate_sent: { label: "Estimate is sent", group: "Estimates", subject: "estimate", use: ["simple", "if"] },
  estimate_service: { label: "Estimate has service", group: "Estimates", subject: "estimate", use: ["and"], param: "services" },
  estimate_accept: { label: "Estimate is accepted", group: "Estimates", subject: "estimate", use: ["simple", "if", "and", "stop"] },
  estimate_declined: { label: "Estimate is declined", group: "Estimates", subject: "estimate", use: ["simple", "if", "and", "stop"] },
  estimate_changes: { label: "Estimate changes are requested", group: "Estimates", subject: "estimate", use: ["simple", "if", "and", "stop"] },
  estimate_responded: { label: "Estimate is accepted or declined", group: "Estimates", subject: "estimate", use: ["simple", "if", "stop"] },
  estimate_not_responded: { label: "Estimate isn't accepted or declined (3 days after it's sent)", group: "Estimates", subject: "estimate", use: ["simple", "if"] },

  invoice_sent: { label: "Invoice is sent", group: "Invoices", subject: "invoice", use: ["simple", "if"] },
  invoice_past_due: { label: "Invoice becomes past due", group: "Invoices", subject: "invoice", use: ["simple", "if"] },
  before_invoice_past_due: { label: "Before an invoice becomes past due", group: "Invoices", subject: "invoice", use: ["simple"], before: [1, 3, 5, 7, 15, 30] },
  invoice_paid_in_full: { label: "Invoice is paid in full", group: "Invoices", subject: "invoice", use: ["simple", "if", "and", "stop"] },
  invoice_partially_paid: { label: "Invoice is partially paid", group: "Invoices", subject: "invoice", use: ["simple", "if", "and", "stop"] },
  invoice_write_off: { label: "Invoice is voided (written off)", group: "Invoices", subject: "invoice", use: ["simple", "if", "stop"] },

  payment_to_account: { label: "Payment is made on an account", group: "Payments & cards", subject: "payment", use: ["simple", "if", "stop"] },
  customer_payment_declined: { label: "Customer's payment was declined", group: "Payments & cards", subject: "invoice", use: ["simple", "if"] },
  payment_receipt: { label: "Payment receipt is sent", group: "Payments & cards", subject: "payment", use: ["simple", "if"] },
  customer_added_a_credit_card: { label: "Customer added a card", group: "Payments & cards", subject: "customer", use: ["simple", "if", "and", "stop"], condLabel: "Customer has a card on file" },
  customer_added_bank_account: { label: "Customer added a bank account", group: "Payments & cards", subject: "customer", use: ["simple", "if", "and", "stop"], condLabel: "Customer has a bank account on file" },
  customer_does_not_have_card_on_file: { label: "Customer has no card or bank account on file", group: "Payments & cards", subject: "customer", use: ["and", "stop"] },
  customer_removed_credit_card: { label: "Customer removed a card", group: "Payments & cards", subject: "customer", use: ["simple", "if"] },
  customer_removed_bank_account: { label: "Customer removed a bank account", group: "Payments & cards", subject: "customer", use: ["simple", "if"] },
  customer_added_bank_account_not_verified: { label: "Customer added a bank account but it isn't verified", group: "Payments & cards", subject: "customer", use: ["simple", "if"], na: "Crewdesk only saves a bank account once it's verified." },
  tip_added: { label: "Tip is added to a payment", group: "Payments & cards", subject: "payment", use: ["if", "and"], na: "Crewdesk doesn't take tips yet." },
  expense_added: { label: "New expense", group: "Payments & cards", subject: "none", use: ["if"], na: "Crewdesk doesn't track expenses here." },

  meeting_created: { label: "Meeting is added", group: "Meetings", subject: "customer", use: ["simple", "if"], na: NA_MEETINGS },
  before_meeting: { label: "Before a meeting happens", group: "Meetings", subject: "customer", use: ["simple"], before: [1, 2, 3], na: NA_MEETINGS },
  complete_meeting: { label: "Meeting is completed", group: "Meetings", subject: "customer", use: ["simple", "if"], na: NA_MEETINGS },
  meeting_has_category: { label: "Meeting has category", group: "Meetings", subject: "customer", use: ["and"], na: NA_MEETINGS },

  add_work_request: { label: "Work request is submitted", group: "Reviews & requests", subject: "customer", use: ["simple", "if"], na: "Crewdesk doesn't take work requests online yet." },
  customer_has_not_give_rating: { label: "A customer has not left a review", group: "Reviews & requests", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
  customer_give_a_rating: { label: "A customer left a review of any rating (0–5 stars)", group: "Reviews & requests", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
  customer_give_average_rating: { label: "A customer left a review of 0 to 3.5 stars", group: "Reviews & requests", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
  customer_give_awesome_rating: { label: "A customer left a review of 4 to 5 stars", group: "Reviews & requests", subject: "customer", use: ["simple", "if"], na: NA_REVIEWS },
} as const satisfies Record<string, TriggerDef>;
export type TriggerKey = keyof typeof TRIGGERS;
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as TriggerKey[];
export const triggerDef = (k: string): TriggerDef | undefined => (TRIGGERS as Record<string, TriggerDef>)[k];
export const triggersFor = (use: TriggerUse) => TRIGGER_KEYS.filter((k) => (TRIGGERS[k].use as readonly TriggerUse[]).includes(use));
/** The trigger's wording where it's used (conditions and stops read as states). */
export const triggerLabel = (k: string, use: TriggerUse = "if") => {
  const d = triggerDef(k);
  if (!d) return k;
  return (use === "and" || use === "stop") && d.condLabel ? d.condLabel : d.label;
};

/** Homeworks' other names for the same triggers (its simple automations and sequences differ a little). */
export const TRIGGER_ALIASES: Record<string, TriggerKey> = {
  add_meeting: "meeting_created", visit_added: "add_visit", visit_completed: "complete_visit", todo_completed: "complete_task", complete_todo: "complete_task",
  before_equipment_maintenance: "before_maintenance", estimate_accepted: "estimate_accept", before_invoice_due: "before_invoice_past_due",
};
export const triggerKeyFor = (k: string): TriggerKey | null => (k in TRIGGERS ? (k as TriggerKey) : TRIGGER_ALIASES[k] ?? null);

/** Triggers with nobody to message (the owner, employees, pushes and to-dos still work). */
export const triggerHasCustomer = (k: string) => { const s = triggerDef(k)?.subject; return !!s && s !== "none" && s !== "maintenance"; };

/* ───────────── Actions ───────────── */

export type ActionDef = { label: string; channel?: "email" | "text"; to: "customer" | "owner" | "employee" | "none"; needs?: "tag" | "todo" };
export const AUTOMATION_ACTIONS = {
  text_admin: { label: "Text company owner", channel: "text", to: "owner" },
  email_admin: { label: "Email company owner", channel: "email", to: "owner" },
  text_customer: { label: "Text customer", channel: "text", to: "customer" },
  email_customer: { label: "Email customer", channel: "email", to: "customer" },
  text_employee: { label: "Text employee", channel: "text", to: "employee" },
  email_employee: { label: "Email employee", channel: "email", to: "employee" },
  push_notification: { label: "Push notification reminder", channel: "text", to: "employee" },
  add_tag: { label: "Add a tag to customer", to: "customer", needs: "tag" },
  remove_tag: { label: "Remove a tag from customer", to: "customer", needs: "tag" },
  create_assign_todo: { label: "Create & assign to-do (due 8 AM the next day)", to: "employee", needs: "todo" },
} as const satisfies Record<string, ActionDef>;
export type ActionKey = keyof typeof AUTOMATION_ACTIONS;
export const ACTION_KEYS = Object.keys(AUTOMATION_ACTIONS) as ActionKey[];
/** Simple automations offer these (Homeworks' list; sequences add the to-do). */
export const SIMPLE_ACTION_KEYS = ACTION_KEYS.filter((k) => k !== "create_assign_todo");
export const actionDef = (k: string): ActionDef | undefined => (AUTOMATION_ACTIONS as Record<string, ActionDef>)[k];

/* ───────────── Times ───────────── */

/** Texts only go out between these hours (company time), like Homeworks. */
export const TEXT_HOURS = { start: 9, end: 18 } as const;
/** "Before" triggers fire at this hour, the set number of days before. */
export const BEFORE_HOUR = 9;
/** A to-do from an automation is due at 8 AM the next day. */
export const TODO_DUE_TIME = "08:00";
/** "Estimate isn't answered" fires this many days after it's sent. */
export const NOT_ANSWERED_DAYS = 3;

/** Homeworks' run times for an automation, in minutes after the trigger. */
export const RUN_TIMES: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "Instantly" },
  { minutes: 2, label: "2 minutes after" },
  { minutes: 15, label: "15 minutes after" },
  { minutes: 60, label: "1 hour after" },
  { minutes: 1440, label: "1 day after" },
  { minutes: 3 * 1440, label: "3 days after" },
  { minutes: 5 * 1440, label: "5 days after" },
  { minutes: 7 * 1440, label: "7 days after" },
  { minutes: 15 * 1440, label: "15 days after" },
  { minutes: 30 * 1440, label: "30 days after" },
];
const MAX_WAIT = 366 * 1440;

/** "Instantly", "After 2 days", "After 1 day 3 hours", "After 30 minutes". */
export function describeWait(minutes: number): string {
  if (!minutes) return "Instantly";
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return `After ${[part(d, "day"), part(h, "hour"), part(m, "minute")].filter(Boolean).join(" ")}`;
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

/** One action: what to do, when (minutes after the trigger), and with which template. */
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
  /** Labels for finding automations (Homeworks' "Tags" box), not customer tags. */
  labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  enabled: z.boolean().default(false),
  /** Each action waits in Review for someone to send or skip it. */
  review: z.boolean().default(false),
};

export const SUB_ACTIONS = { none: "Nothing", run_automation: "Run another automation", stop_automation: "Stop this automation (turn it off after it runs)" } as const;
export type SubAction = keyof typeof SUB_ACTIONS;

export const simpleAutomationSchema = z.object({
  ...base,
  kind: z.literal("simple"),
  trigger: automationCondSchema,
  /** "Run at a certain time": the date and time (company time), "YYYY-MM-DDTHH:mm". */
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
  /** IF this happens… */
  trigger: automationCondSchema,
  /** …OR any of these happen… */
  or: z.array(automationCondSchema).max(10).default([]),
  /** …AND all of these are true, do the actions. */
  and: z.array(automationCondSchema).max(10).default([]),
  actions: z.array(automationActionSchema).min(1, "Add an action").max(30),
});
export type SequenceBlock = z.infer<typeof sequenceBlockSchema>;

export const sequenceSchema = z.object({
  ...base,
  kind: z.literal("sequence"),
  /** The IF block, then ELSE blocks (the first whose trigger and conditions match runs). */
  blocks: z.array(sequenceBlockSchema).min(1).max(10),
  /** Stops (for that customer) when any of these happens. */
  stops: z.array(automationCondSchema).max(10).default([]),
  /** Done right away when it stops. */
  stopActions: z.array(automationActionSchema).max(10).default([]),
});
export type SequenceInput = z.infer<typeof sequenceSchema>;

export const automationSchema = z.discriminatedUnion("kind", [simpleAutomationSchema, sequenceSchema]);
export type AutomationInput = z.infer<typeof automationSchema>;
/** What's stored: everything but the columns (name, description, labels, enabled, review). */
export type AutomationDef =
  | Omit<SimpleAutomationInput, "name" | "description" | "labels" | "enabled" | "review">
  | Omit<SequenceInput, "name" | "description" | "labels" | "enabled" | "review">;

/** Every action an automation can do (a sequence's, then its stop actions). */
export function allActions(def: AutomationDef): AutomationAction[] {
  return def.kind === "simple" ? [def.action] : [...def.blocks.flatMap((b) => b.actions), ...def.stopActions];
}
/** Every trigger and condition it uses. */
export function allConds(def: AutomationDef): { cond: AutomationCond; use: TriggerUse }[] {
  if (def.kind === "simple") return [{ cond: def.trigger, use: "simple" }];
  return [
    ...def.blocks.flatMap((b) => [{ cond: b.trigger, use: "if" as const }, ...b.or.map((cond) => ({ cond, use: "if" as const })), ...b.and.map((cond) => ({ cond, use: "and" as const }))]),
    ...def.stops.map((cond) => ({ cond, use: "stop" as const })),
  ];
}

/**
 * What's wrong with an automation (so it can't be saved): missing picks, a trigger used where it
 * can't be, a customer action on a trigger with no customer. Template kinds and ids are checked by
 * the server.
 */
export function automationProblems(a: AutomationInput | (AutomationDef & { name?: string })): string[] {
  const out: string[] = [];
  const conds = allConds(a as AutomationDef);
  for (const { cond, use } of conds) {
    const d = triggerDef(cond.key);
    if (!d) { out.push(`"${cond.key}" isn't a trigger`); continue; }
    if (!(d.use as readonly TriggerUse[]).includes(use)) out.push(`"${d.label}" can't be used ${use === "and" ? "as an AND condition" : use === "stop" ? "as a stop condition" : use === "if" ? "as a sequence trigger" : "as an automation's trigger"}`);
    if (d.param === "tags" && !cond.tagIds.length) out.push(`"${d.label}": choose the tag`);
    if (d.param === "categories" && !cond.categoryIds.length) out.push(`"${d.label}": choose the category`);
    if (d.param === "services" && !cond.serviceIds.length) out.push(`"${d.label}": choose the service`);
  }
  const noCustomer = a.kind === "simple" ? !triggerHasCustomer(a.trigger.key) : (a as SequenceInput).blocks.every((b) => [b.trigger, ...b.or].every((c) => !triggerHasCustomer(c.key)));
  if (a.kind === "simple") {
    const d = triggerDef(a.trigger.key);
    if (d?.param === "datetime" && !a.runAt) out.push("Choose the date and time to run it");
    if (d?.before && !a.daysBefore) out.push("Choose how many days before");
    if (a.subAction === "run_automation" && !a.subAutomationId) out.push("Choose the automation to run next");
  }
  for (const [i, act] of allActions(a as AutomationDef).entries()) {
    const ad = AUTOMATION_ACTIONS[act.action];
    const where = a.kind === "sequence" ? `Action ${i + 1} (${ad.label})` : ad.label;
    if ("channel" in ad && !act.templateId) out.push(`${where}: choose the ${ad.channel} template`);
    if (ad.to === "employee" && !act.employeeIds.length && act.action !== "push_notification") out.push(`${where}: choose the employee`);
    if ("needs" in ad && ad.needs === "tag" && !act.tagId) out.push(`${where}: choose the tag`);
    if ("needs" in ad && ad.needs === "todo" && !act.todoTitle) out.push(`${where}: name the to-do`);
    if (ad.to === "customer" && noCustomer) out.push(`${where}: this trigger has no customer, so it can only message the owner or employees`);
  }
  return out;
}

const naOf = (c: AutomationCond) => { const d = triggerDef(c.key); return d && "na" in d && d.na ? `"${d.label}": ${d.na}` : null; };

/** The sequence blocks that can never run in Crewdesk (a trigger or condition it doesn't have), with why. */
export function deadBlocks(def: AutomationDef): { index: number; why: string }[] {
  if (def.kind !== "sequence") return [];
  const out: { index: number; why: string }[] = [];
  def.blocks.forEach((b, index) => {
    const starts = [b.trigger, ...b.or];
    const why = starts.every((c) => naOf(c)) ? naOf(b.trigger) : b.and.map(naOf).find(Boolean);
    if (why) out.push({ index, why });
  });
  return out;
}

/**
 * Why it can't be turned on (it can only start on triggers Crewdesk doesn't have), or null. A
 * sequence with some blocks Crewdesk can't run can still be turned on: those blocks just never run.
 */
export function cannotTurnOn(def: AutomationDef): string | null {
  if (def.kind === "simple") { const why = naOf(def.trigger); return why ? `Can't run: ${why}` : null; }
  const dead = deadBlocks(def);
  return dead.length === def.blocks.length ? `Can't run: ${dead[0].why}` : null;
}

/** "Instantly", "2 days after", "1 day before (9 AM)", "Nov 30, 2026 at 9:00 AM". */
export function describeRunTime(def: AutomationDef): string {
  if (def.kind !== "simple") return "";
  const d = triggerDef(def.trigger.key);
  if (d?.param === "datetime") {
    if (!def.runAt) return "";
    const [date, time] = def.runAt.split("T");
    const [h, m] = time.split(":").map(Number);
    return `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} at ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  if (d?.before) return def.daysBefore ? `${def.daysBefore} day${def.daysBefore === 1 ? "" : "s"} before (9 AM)` : "";
  const known = RUN_TIMES.find((r) => r.minutes === def.delayMinutes);
  return known?.label ?? describeWait(def.delayMinutes).replace(/^After (.*)$/, "$1 after");
}

/* ───────────── Homeworks import ───────────── */

const hwPick = z.object({ value: z.string().nullable().optional(), text: z.string().nullable().optional() }).nullable().optional();
const hwCond = z.object({ value: z.string(), text: z.string().optional(), attrs: z.array(z.string()).default([]) });
const hwAction = z.object({
  instant: z.boolean().optional(), days: z.coerce.number().default(0), hours: z.coerce.number().default(0), minutes: z.coerce.number().default(0),
  action: hwPick, email: hwPick, text: hwPick, employee: hwPick, tag: hwPick, title: z.string().nullable().optional(),
});
/** The file Crewdesk's Homeworks export makes: their automations and sequences, as they are there. */
export const automationImportSchema = z.object({
  source: z.literal("homeworks"),
  automations: z.array(z.object({
    id: z.union([z.string(), z.number()]), on: z.boolean().nullable().optional(), review: z.boolean().nullable().optional(), title: z.string(),
    trigger: hwPick, tag: hwPick, date: z.string().nullable().optional(), time: z.string().nullable().optional(), delay: hwPick, action: hwPick, employee: hwPick,
    textTemplate: hwPick, emailTemplate: hwPick, actionTag: hwPick, subAction: hwPick, subAutomation: hwPick, subDelay: hwPick,
    notes: z.string().nullable().optional(), tags: z.array(z.string()).default([]),
  })).max(500).default([]),
  sequences: z.array(z.object({
    id: z.union([z.string(), z.number()]), title: z.string(), description: z.string().nullable().optional(), review: z.boolean().nullable().optional(),
    blocks: z.array(z.object({ trigger: hwCond, when: z.array(z.array(hwCond)).default([]), actions: z.array(hwAction).default([]) })).max(20),
    stops: z.array(hwCond).default([]), stopActions: z.array(hwAction).default([]),
  })).max(200).default([]),
});
export type AutomationImport = z.infer<typeof automationImportSchema>;

/** Homeworks' run-time values for its simple automations (seconds; "before" ones end in 1). */
export function homeworksDelay(value: string | null | undefined): { delayMinutes: number; daysBefore: number | null } {
  const n = Number(value ?? 1);
  if (!Number.isFinite(n) || n <= 1) return { delayMinutes: 0, daysBefore: null };
  if (n % 86400 === 1) return { delayMinutes: 0, daysBefore: Math.round((n - 1) / 86400) };
  return { delayMinutes: Math.round(n / 60), daysBefore: null };
}

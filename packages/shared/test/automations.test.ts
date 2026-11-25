import { describe, expect, it } from "vitest";
import {
  RUN_TIMES, SEQUENCE_TRIGGER_ORDER, SIMPLE_TRIGGER_ORDER, SUB_DELAYS, TRIGGERS, actionLabel, automationProblems, automationSchema, cannotTurnOn, deadBlocks, describeRunTime,
  describeWait, homeworksDelay, parseRunTime, runTimeFits, runTimeOptions, runTimeValue, splitWait, triggerKeyFor, triggerLabel, triggerWorksAs, triggersFor, waitText,
  type SequenceInput, type SimpleAutomationInput,
} from "../src/automations";

const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const TAG = "33333333-3333-4333-8333-333333333333";
const cond = (key: string, tagIds: string[] = []) => ({ key, tagIds, categoryIds: [], serviceIds: [] });
const act = (action: string, more: Record<string, unknown> = {}) => ({ waitMinutes: 0, action, templateId: null, employeeIds: [], tagId: null, todoTitle: null, ...more }) as never;

const simple = (over: Partial<SimpleAutomationInput> = {}): SimpleAutomationInput => automationSchema.parse({
  kind: "simple", name: "Reminder", trigger: { key: "before_visit" }, daysBefore: 1, action: { action: "text_customer", templateId: T }, ...over,
}) as SimpleAutomationInput;

const sequence = (over: Partial<SequenceInput> = {}): SequenceInput => automationSchema.parse({
  kind: "sequence", name: "7 days to close",
  blocks: [{ trigger: { key: "estimate_sent" }, actions: [{ waitMinutes: 1440, action: "text_customer", templateId: T }, { waitMinutes: 7 * 1440, action: "email_admin", templateId: T }] }],
  stops: [{ key: "estimate_responded" }, { key: "estimate_changes" }],
  ...over,
}) as SequenceInput;

describe("triggers, as Homeworks lists them", () => {
  it("the Automations tab has Homeworks' 39 triggers in its order; sequences have its 50", () => {
    expect(SIMPLE_TRIGGER_ORDER).toHaveLength(39);
    expect(SIMPLE_TRIGGER_ORDER.slice(0, 5)).toEqual(["certain_time", "add_visit", "todo_created", "meeting_created", "add_maintenance"]);
    expect(SIMPLE_TRIGGER_ORDER.at(-1)).toBe("customer_give_awesome_rating");
    expect(SEQUENCE_TRIGGER_ORDER).toHaveLength(50);
    expect(SEQUENCE_TRIGGER_ORDER.slice(0, 4)).toEqual(["add_visit", "complete_visit", "visit_skipped", "has_no_recurring_job"]);
    expect(SEQUENCE_TRIGGER_ORDER.at(-1)).toBe("expense_added");
    expect(new Set(SIMPLE_TRIGGER_ORDER).size).toBe(39);
    expect(new Set(SEQUENCE_TRIGGER_ORDER).size).toBe(50);
    for (const k of [...SIMPLE_TRIGGER_ORDER, ...SEQUENCE_TRIGGER_ORDER]) expect(TRIGGERS[k], k).toBeTruthy();
  });
  it("words them as Homeworks does (a visit is a work order), differently per tab where it does", () => {
    expect(triggerLabel("complete_visit", "simple")).toBe("Work Order is Completed");
    expect(triggerLabel("tag_added", "simple")).toBe("A Tag is Added");
    expect(triggerLabel("tag_added", "if")).toBe("Tag has been Added");
    expect(triggerLabel("estimate_responded", "simple")).toBe("If an Estimate is Accepted or Declined");
    expect(triggerLabel("estimate_responded", "stop")).toBe("Estimate is Accepted or Declined");
    expect(triggerLabel("customer_added_a_credit_card", "stop")).toBe("Customer has a Credit/Debit Card on File");
    expect(actionLabel("add_tag", true)).toBe("Add a Tag");
    expect(actionLabel("add_tag")).toBe("Add a Tag to Customer");
  });
  it("knows where each works in Crewdesk", () => {
    expect(triggersFor("if")).toContain("estimate_sent");
    expect(triggerWorksAs("before_visit", "if")).toBe(false);
    expect(triggerWorksAs("customer_does_not_have_tag", "and")).toBe(true);
    expect(triggerWorksAs("estimate_sent", "and")).toBe(false);
    expect(triggerWorksAs("invoice_paid_in_full", "stop")).toBe(true);
  });
  it("maps Homeworks' other names", () => {
    expect(triggerKeyFor("add_meeting")).toBe("meeting_created");
    expect(triggerKeyFor("add_task")).toBe("todo_created");
    expect(triggerKeyFor("before_task")).toBe("before_todo");
    expect(triggerKeyFor("complete_visit")).toBe("complete_visit");
    expect(triggerKeyFor("nope")).toBeNull();
  });
});

describe("automation problems", () => {
  it("a complete automation and sequence are fine; new ones are on, like Homeworks", () => {
    expect(automationProblems(simple())).toEqual([]);
    expect(automationProblems(sequence())).toEqual([]);
    expect(simple().enabled).toBe(true);
  });
  it("needs templates, employees, tags, a run time that fits, a date", () => {
    expect(automationProblems(simple({ action: act("email_employee") }))).toEqual(["Email Employee: choose the Email Template", "Email Employee: choose the Employee"]);
    expect(automationProblems(simple({ daysBefore: null }))[0]).toMatch(/^Run Time: choose how many days before/);
    expect(automationProblems(simple({ trigger: cond("complete_visit"), daysBefore: 1 }))).toEqual(['Run Time: "Days Before" only works with the "Before…" triggers']);
    expect(automationProblems(simple({ trigger: cond("tag_added"), daysBefore: null }))).toEqual(['"A Tag is Added": choose the tag']);
    expect(automationProblems(simple({ trigger: cond("certain_time"), daysBefore: null, action: act("email_admin", { templateId: T }) }))).toEqual(["Choose the date and time to run it"]);
    expect(automationProblems(simple({ trigger: cond("complete_visit"), daysBefore: null, action: act("add_tag") }))).toEqual(["Add a Tag: choose the Tag"]);
    expect(automationProblems(simple({ trigger: cond("complete_visit"), daysBefore: null, subAction: "run_automation" }))).toEqual(["Next Automation: choose the automation to run next"]);
  });
  it("a push reminder needs nothing picked", () => {
    expect(automationProblems(simple({ action: act("push_notification") }))).toEqual([]);
  });
  it("won't message a customer when there's no customer", () => {
    expect(automationProblems(simple({ trigger: cond("add_maintenance"), daysBefore: null })))
      .toEqual(["Text Customer: this trigger has no customer, so it can only message the owner or employees"]);
  });
  it("triggers only where they fit", () => {
    const s = sequence({ blocks: [{ trigger: cond("customer_has_tag", [TAG]), when: [[cond("estimate_sent")]], actions: [act("add_tag", { tagId: TAG })] }] });
    expect(automationProblems(s)).toEqual(['"Customer has a Tag" can\'t be used as a sequence trigger (use it as a Condition)', '"Estimate is Sent" can\'t be used as a Condition (use it as a trigger)']);
  });
  it("a to-do needs a title and someone", () => {
    const s = sequence({ blocks: [{ trigger: cond("estimate_sent"), when: [], actions: [act("create_assign_todo", { employeeIds: [E] })] }] });
    expect(automationProblems(s)).toEqual(["Action 1 (Create & Assigned To-do): enter the Title"]);
  });
  it("triggers Crewdesk doesn't have can be kept but not turned on", () => {
    expect(cannotTurnOn(sequence())).toBeNull();
    expect(cannotTurnOn(sequence({ blocks: [{ trigger: cond("meeting_created"), when: [], actions: [act("email_admin", { templateId: T })] }] }))).toMatch(/meetings/);
    expect(cannotTurnOn(simple({ trigger: cond("before_meeting") }))).toMatch(/^Can't run: "Before a Meeting Happens"/);
  });
  it("a sequence with some blocks Crewdesk can't run can still run the others", () => {
    const blk = (key: string, when: string[][] = []) => ({ trigger: cond(key), when: when.map((g) => g.map((k) => cond(k))), actions: [act("email_admin", { templateId: T })] });
    const s = sequence({ blocks: [blk("payment_to_account"), blk("customer_payment_declined"), blk("payment_to_account", [["tip_added"]])] });
    expect(deadBlocks(s)).toEqual([{ index: 2, why: '"Tip Added on Payment": Crewdesk doesn\'t take tips yet.' }]);
    expect(cannotTurnOn(s)).toBeNull();
    // Another group of conditions that can be true keeps the block alive.
    expect(deadBlocks(sequence({ blocks: [blk("payment_to_account", [["tip_added"], ["customer_inactive"]])] }))).toEqual([]);
    expect(cannotTurnOn(sequence({ blocks: [blk("meeting_created"), blk("complete_meeting")] }))).toMatch(/^Can't run: "Meeting is Added"/);
  });
});

describe("run times, as Homeworks lists them", () => {
  it("the same list for every trigger, with the days before a due date added for that trigger", () => {
    expect(RUN_TIMES.map((r) => r.label)).toEqual([
      "Instantly", "1 Day Before The Event Happens", "2 Days Before The Event Happens", "3 Days Before The Event Happens", "2 Minutes After Trigger Condition",
      "15 Minutes After Trigger Condition", "1 Day After Trigger Condition", "3 Days After Trigger Condition", "5 Days After Trigger Condition", "7 Days After Trigger Condition",
      "15 Days After Trigger Condition", "30 Days After Trigger Condition",
    ]);
    expect(runTimeOptions("before_invoice_past_due").slice(12).map((r) => r.label)).toEqual([
      "1 Day Before Trigger Condition", "3 Days Before Trigger Condition", "5 Days Before Trigger Condition", "7 Days Before Trigger Condition", "15 Days Before Trigger Condition", "30 Days Before Trigger Condition",
    ]);
    expect(SUB_DELAYS.map((r) => r.label).slice(0, 3)).toEqual(["Instantly", "15 Minutes After First Automation Runs", "1 Day After First Automation Runs"]);
  });
  it("picks, parses and checks a run time", () => {
    expect(runTimeValue("complete_visit", { delayMinutes: 15, daysBefore: null })).toBe("after:15");
    expect(runTimeValue("before_visit", { delayMinutes: 0, daysBefore: 2 })).toBe("before:2");
    expect(runTimeValue("before_invoice_past_due", { delayMinutes: 0, daysBefore: 7 })).toBe("beforedue:7");
    expect(runTimeValue("before_invoice_past_due", { delayMinutes: 0, daysBefore: 1 })).toBe("before:1");
    expect(parseRunTime("after:1440")).toEqual({ delayMinutes: 1440, daysBefore: null });
    expect(parseRunTime("beforedue:15")).toEqual({ delayMinutes: 0, daysBefore: 15 });
    expect(parseRunTime("x")).toBeNull();
    expect(runTimeFits("before_visit", { delayMinutes: 0, daysBefore: 1 })).toBe(true);
    expect(runTimeFits("before_visit", { delayMinutes: 0, daysBefore: null })).toBe(false);
    expect(runTimeFits("complete_visit", { delayMinutes: 0, daysBefore: 1 })).toBe(false);
  });
  it("describes waits and run times", () => {
    expect(describeWait(0)).toBe("Instantly");
    expect(describeWait(1440 + 180)).toBe("After 1 day 3 hours");
    expect(waitText(0)).toBe("1 second");
    expect(waitText(35)).toBe("35 minutes");
    expect(splitWait(2 * 1440 + 61)).toEqual({ days: 2, hours: 1, minutes: 1 });
    expect(describeRunTime(simple())).toBe("1 Day Before The Event Happens");
    expect(describeRunTime(simple({ trigger: cond("complete_visit"), daysBefore: null, delayMinutes: 3 * 1440 }))).toBe("3 Days After Trigger Condition");
    expect(describeRunTime(simple({ trigger: cond("complete_visit"), daysBefore: null, delayMinutes: 90 }))).toBe("1 Hour 30 Minutes After Trigger Condition");
    expect(describeRunTime(simple({ trigger: cond("certain_time"), daysBefore: null, runAt: "2026-12-01T14:05" }))).toBe("Dec 1, 2026 2:05 pm");
  });
  it("reads Homeworks' run-time values", () => {
    expect(homeworksDelay("1")).toEqual({ delayMinutes: 0, daysBefore: null });
    expect(homeworksDelay("900")).toEqual({ delayMinutes: 15, daysBefore: null });
    expect(homeworksDelay("2592000")).toEqual({ delayMinutes: 43200, daysBefore: null });
    expect(homeworksDelay("86401")).toEqual({ delayMinutes: 0, daysBefore: 1 });
    expect(homeworksDelay("259201")).toEqual({ delayMinutes: 0, daysBefore: 3 });
  });
});

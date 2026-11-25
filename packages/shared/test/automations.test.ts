import { describe, expect, it } from "vitest";
import {
  TRIGGERS, automationProblems, automationSchema, cannotTurnOn, deadBlocks, describeRunTime, describeWait, homeworksDelay, splitWait, triggerKeyFor, triggerLabel, triggersFor,
  type SequenceInput, type SimpleAutomationInput,
} from "../src/automations";

const T = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const TAG = "33333333-3333-4333-8333-333333333333";

const simple = (over: Partial<SimpleAutomationInput> = {}): SimpleAutomationInput => automationSchema.parse({
  kind: "simple", name: "Reminder", trigger: { key: "before_visit" }, daysBefore: 1, action: { action: "text_customer", templateId: T }, ...over,
}) as SimpleAutomationInput;

const sequence = (over: Partial<SequenceInput> = {}): SequenceInput => automationSchema.parse({
  kind: "sequence", name: "7 days to close",
  blocks: [{ trigger: { key: "estimate_sent" }, actions: [{ waitMinutes: 1440, action: "text_customer", templateId: T }, { waitMinutes: 7 * 1440, action: "email_admin", templateId: T }] }],
  stops: [{ key: "estimate_responded" }, { key: "estimate_changes" }],
  ...over,
}) as SequenceInput;

describe("triggers", () => {
  it("every trigger is offered somewhere, and the lists split by use", () => {
    for (const [k, d] of Object.entries(TRIGGERS)) expect(d.use.length, k).toBeGreaterThan(0);
    expect(triggersFor("if")).toContain("estimate_sent");
    expect(triggersFor("if")).not.toContain("before_visit");
    expect(triggersFor("and")).toContain("customer_does_not_have_tag");
    expect(triggersFor("and")).not.toContain("estimate_sent");
    expect(triggersFor("stop")).toContain("invoice_paid_in_full");
  });
  it("reads as a state where it's a condition", () => {
    expect(triggerLabel("customer_added_a_credit_card", "if")).toBe("Customer added a card");
    expect(triggerLabel("customer_added_a_credit_card", "stop")).toBe("Customer has a card on file");
  });
  it("maps Homeworks' other names", () => {
    expect(triggerKeyFor("add_meeting")).toBe("meeting_created");
    expect(triggerKeyFor("complete_visit")).toBe("complete_visit");
    expect(triggerKeyFor("nope")).toBeNull();
  });
});

describe("automation problems", () => {
  it("a complete automation and sequence are fine", () => {
    expect(automationProblems(simple())).toEqual([]);
    expect(automationProblems(sequence())).toEqual([]);
  });
  it("needs templates, employees, tags, days before, a time", () => {
    expect(automationProblems(simple({ action: { action: "email_employee", templateId: null, employeeIds: [], tagId: null, todoTitle: null, waitMinutes: 0 } })))
      .toEqual(["Email employee: choose the email template", "Email employee: choose the employee"]);
    expect(automationProblems(simple({ daysBefore: null }))).toEqual(["Choose how many days before"]);
    expect(automationProblems(simple({ trigger: { key: "tag_added", tagIds: [], categoryIds: [], serviceIds: [] }, daysBefore: null }))).toEqual(['"Tag is added": choose the tag']);
    expect(automationProblems(simple({ trigger: { key: "certain_time", tagIds: [], categoryIds: [], serviceIds: [] }, daysBefore: null, action: { action: "email_admin", templateId: T, employeeIds: [], tagId: null, todoTitle: null, waitMinutes: 0 } })))
      .toEqual(["Choose the date and time to run it"]);
  });
  it("won't message a customer when there's no customer", () => {
    expect(automationProblems(simple({ trigger: { key: "add_maintenance", tagIds: [], categoryIds: [], serviceIds: [] }, daysBefore: null })))
      .toEqual(["Text customer: this trigger has no customer, so it can only message the owner or employees"]);
  });
  it("triggers only where they fit", () => {
    const s = sequence({ blocks: [{ trigger: { key: "customer_has_tag", tagIds: [TAG], categoryIds: [], serviceIds: [] }, or: [], and: [{ key: "estimate_sent", tagIds: [], categoryIds: [], serviceIds: [] }], actions: [{ waitMinutes: 0, action: "add_tag", tagId: TAG, templateId: null, employeeIds: [], todoTitle: null }] }] });
    expect(automationProblems(s)).toEqual(['"Customer has a tag" can\'t be used as a sequence trigger', '"Estimate is sent" can\'t be used as an AND condition']);
  });
  it("a to-do needs a title and someone", () => {
    const s = sequence({ blocks: [{ trigger: { key: "estimate_sent", tagIds: [], categoryIds: [], serviceIds: [] }, or: [], and: [], actions: [{ waitMinutes: 0, action: "create_assign_todo", tagId: null, templateId: null, employeeIds: [E], todoTitle: null }] }] });
    expect(automationProblems(s)).toEqual(["Action 1 (Create & assign to-do (due 8 AM the next day)): name the to-do"]);
  });
  it("triggers Crewdesk doesn't have can be kept but not turned on", () => {
    expect(cannotTurnOn(sequence())).toBeNull();
    expect(cannotTurnOn(sequence({ blocks: [{ trigger: { key: "meeting_created", tagIds: [], categoryIds: [], serviceIds: [] }, or: [], and: [], actions: [{ waitMinutes: 0, action: "email_admin", templateId: T, employeeIds: [], tagId: null, todoTitle: null }] }] })))
      .toMatch(/meetings/);
  });
  it("a sequence with some blocks Crewdesk can't run can still run the others", () => {
    const blk = (key: string, and: string[] = []) => ({ trigger: { key, tagIds: [], categoryIds: [], serviceIds: [] }, or: [], and: and.map((k) => ({ key: k, tagIds: [], categoryIds: [], serviceIds: [] })), actions: [{ waitMinutes: 0, action: "email_admin" as const, templateId: T, employeeIds: [], tagId: null, todoTitle: null }] });
    const s = sequence({ blocks: [blk("payment_to_account"), blk("customer_payment_declined"), blk("payment_to_account", ["tip_added"])] });
    expect(deadBlocks(s)).toEqual([{ index: 2, why: '"Tip is added to a payment": Crewdesk doesn\'t take tips yet.' }]);
    expect(cannotTurnOn(s)).toBeNull();
    expect(cannotTurnOn(sequence({ blocks: [blk("meeting_created"), blk("complete_meeting")] }))).toMatch(/^Can't run: "Meeting is added"/);
  });
});

describe("times", () => {
  it("describes waits and run times", () => {
    expect(describeWait(0)).toBe("Instantly");
    expect(describeWait(1440 + 180)).toBe("After 1 day 3 hours");
    expect(describeWait(35)).toBe("After 35 minutes");
    expect(splitWait(2 * 1440 + 61)).toEqual({ days: 2, hours: 1, minutes: 1 });
    expect(describeRunTime(simple())).toBe("1 day before (9 AM)");
    expect(describeRunTime(simple({ trigger: { key: "complete_visit", tagIds: [], categoryIds: [], serviceIds: [] }, daysBefore: null, delayMinutes: 3 * 1440 }))).toBe("3 days after");
    expect(describeRunTime(simple({ trigger: { key: "complete_visit", tagIds: [], categoryIds: [], serviceIds: [] }, daysBefore: null, delayMinutes: 90 }))).toBe("1 hour 30 minutes after");
    expect(describeRunTime(simple({ trigger: { key: "certain_time", tagIds: [], categoryIds: [], serviceIds: [] }, daysBefore: null, runAt: "2026-12-01T14:05" }))).toBe("Dec 1, 2026 at 2:05 PM");
  });
  it("reads Homeworks' run-time values", () => {
    expect(homeworksDelay("1")).toEqual({ delayMinutes: 0, daysBefore: null });
    expect(homeworksDelay("900")).toEqual({ delayMinutes: 15, daysBefore: null });
    expect(homeworksDelay("2592000")).toEqual({ delayMinutes: 43200, daysBefore: null });
    expect(homeworksDelay("86401")).toEqual({ delayMinutes: 0, daysBefore: 1 });
    expect(homeworksDelay("259201")).toEqual({ delayMinutes: 0, daysBefore: 3 });
  });
});

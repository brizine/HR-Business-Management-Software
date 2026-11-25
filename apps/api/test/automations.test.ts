/**
 * Automations v2 (like Homeworks): a sequence with timed actions that stops when the estimate is
 * answered (and does its stop actions), "before a work order" at 9 AM, ELSE blocks and AND
 * conditions, review before execution, turning one off for a customer, running another automation,
 * the checks on saving and turning on, the Homeworks import (all off), and quiet hours for texts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { automationRuns, automationSteps, automations, customers, estimates, templates, todos } from "../src/db/schema";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { runAutomations, _test } from "../src/lib/automations";
import { recordTagChanges } from "../src/lib/crm";
import { localParts, zonedTime } from "../src/lib/tz";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@auto.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const all: EmailMessage[] = [];
/** Emails to this run's people (other test companies may be running automations too). */
const sent = {
  get length() { return this.mine().length; },
  set length(_: number) { all.length = 0; },
  mine: () => all.filter((m) => m.to.includes(`-${suffix}@`)),
  find: (f: (m: EmailMessage) => boolean) => sent.mine().find(f),
  some: (f: (m: EmailMessage) => boolean) => sent.mine().some(f),
  map: <R>(f: (m: EmailMessage) => R) => sent.mine().map(f),
  get 0() { return sent.mine()[0]; },
};
const TZ = "America/Chicago";
let companyId = "";
const today = () => localParts(new Date(), TZ).date;
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A time company time, `days` from today. */
const at = (days: number, time = "10:00") => zonedTime(plus(today(), days), time, TZ);

async function call(method: string, url: string, who: string | null, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
const runsFor = (automationId: string) => db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
const stepsFor = (automationId: string) => db.select().from(automationSteps).where(eq(automationSteps.automationId, automationId)).orderBy(automationSteps.kind, automationSteps.idx);
const cond = (key: string, more: Record<string, unknown> = {}) => ({ key, tagIds: [], categoryIds: [], serviceIds: [], ...more });
const act = (action: string, more: Record<string, unknown> = {}) => ({ waitMinutes: 0, action, templateId: null, employeeIds: [], tagId: null, todoTitle: null, ...more });
async function template(channel: "email" | "text", name: string, subject: string | null, body: string, audience = "customer") {
  const r = await call("POST", "/templates", "owner", { channel, audience, name, subject, body });
  expect(r.status).toBe(200);
  return r.body.id as string;
}
async function sentEstimate(customerId: string) {
  const e = await call("POST", "/estimates", "office", { customerId, title: "Spring program", lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 30000 }] });
  expect((await call("POST", `/estimates/${e.body.id}/send`, "office", {})).status).toBe(200);
  return e.body.id as string;
}
async function tag(customerId: string, tagId: string, add = true) {
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId));
  const after = add ? [...c.tagIds, tagId] : c.tagIds.filter((t) => t !== tagId);
  await db.update(customers).set({ tagIds: after }).where(eq(customers.id, customerId));
  await recordTagChanges(db as never, { companyId, before: c.tagIds, after, customerId, source: "hand", byId: null });
}
/** Sets when an automation counts as turned on (so tests can place things before or after it). */
const onSince = (id: string, when: Date) => db.update(automations).set({ enabledAt: when }).where(eq(automations.id, id));

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { all.push(m); } });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Auto Co", firstName: "Ava", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token; companyId = s.company.id; ID.owner = s.user.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Auto Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@auto.test", phone: "(405) 555-0100", timezone: TZ });
  ID.office = (await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" })).body.id;
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  const mk = async (b: Record<string, unknown>) => (await call("POST", "/customers", "office", b)).body.id as string;
  ID.amy = await mk({ firstName: "Amy", lastName: "Aster", email: email("amy"), property: { street: "1 Oak St", city: "Norman", zip: "73069" } });
  ID.bob = await mk({ firstName: "Bob", lastName: "Birch", email: email("bob"), property: { street: "2 Elm St", city: "Norman", zip: "73069" } });
  ID.vip = (await call("POST", "/crm/tags", "owner", { name: `VIP ${suffix}`, color: "green" })).body.id;
  ID.asked = (await call("POST", "/crm/tags", "owner", { name: `Review Asked ${suffix}`, color: "blue" })).body.id;
  ID.tplFollow = await template("email", "Estimate follow-up", "About estimate {{ESTIMATE_NUMBER}}", "<p>Hi {{CUSTOMER_FIRST_NAME}}, any questions about {{ESTIMATE_TITLE}}?</p>");
  ID.tplText = await template("text", "Estimate text", null, "Hi {{CUSTOMER_FIRST_NAME}}, it's {{COMPANY_NAME}}.");
  ID.tplOwner = await template("email", "Estimate news (internal)", "{{CUSTOMER_NAME}}: estimate {{ESTIMATE_NUMBER}}", "<p>Check on it.</p>", "internal");
  ID.tplReminder = await template("email", "Visit reminder", "See you {{EVENT_DATE}}", "<p>We'll be at {{EVENT_PROPERTY_ADDRESS}}.</p>");
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("automations v2", () => {
  it("checks on saving: templates, picks, triggers where they fit; only admins save", async () => {
    const base = { kind: "simple", name: "X", trigger: cond("complete_visit"), action: act("email_customer") };
    expect((await call("POST", "/automations", "office", { ...base, action: act("email_customer", { templateId: ID.tplFollow }) })).status).toBe(403);
    expect((await call("POST", "/automations", "owner", base)).body.error).toMatch(/choose the email template/);
    expect((await call("POST", "/automations", "owner", { ...base, action: act("email_customer", { templateId: ID.tplText }) })).body.error).toMatch(/choose an email template/);
    expect((await call("POST", "/automations", "owner", { ...base, trigger: cond("tag_added") , action: act("email_customer", { templateId: ID.tplFollow }) })).body.error).toMatch(/choose the tag/);
    expect((await call("POST", "/automations", "owner", { ...base, trigger: cond("add_maintenance"), action: act("email_customer", { templateId: ID.tplFollow }) })).body.error).toMatch(/no customer/);
    // A trigger Crewdesk doesn't have can be kept, but not turned on.
    const meet = await call("POST", "/automations", "owner", { ...base, trigger: cond("meeting_created"), action: act("email_admin", { templateId: ID.tplOwner }) });
    expect(meet.status).toBe(200);
    expect(meet.body.cannotTurnOn).toMatch(/meetings/);
    expect((await call("POST", `/automations/${meet.body.id}/enabled`, "owner", { enabled: true })).body.error).toMatch(/meetings/);
    expect((await call("DELETE", `/automations/${meet.body.id}`, "owner")).status).toBe(200);
  });

  it("a sequence: timed actions from the trigger; texts skip when texting is off; stops when the estimate is answered, then does its stop actions", async () => {
    const a = await call("POST", "/automations", "owner", {
      kind: "sequence", name: "7 days to close", enabled: true,
      blocks: [{ trigger: cond("estimate_sent"), actions: [
        act("email_owner_wrong"),
      ] }],
    });
    expect(a.status).toBe(400);
    const seq = await call("POST", "/automations", "owner", {
      kind: "sequence", name: "7 days to close", enabled: true,
      blocks: [{ trigger: cond("estimate_sent"), actions: [
        act("email_admin", { waitMinutes: 7 * 1440, templateId: ID.tplOwner }),
        act("text_customer", { waitMinutes: 1440, templateId: ID.tplText }),
        act("email_customer", { waitMinutes: 2 * 1440, templateId: ID.tplFollow }),
      ] }],
      stops: [cond("estimate_responded"), cond("estimate_changes")],
      stopActions: [act("email_admin", { templateId: ID.tplOwner })],
    });
    expect(seq.status).toBe(200);
    expect(seq.body.number).toBeGreaterThan(0);
    // Actions come back in time order.
    expect(seq.body.def.blocks[0].actions.map((x: any) => x.action)).toEqual(["text_customer", "email_customer", "email_admin"]);
    await onSince(seq.body.id, at(-2));
    // Sent before it was turned on: doesn't start it.
    const before = await sentEstimate(ID.bob);
    await db.update(estimates).set({ sentAt: at(-3) }).where(eq(estimates.id, before));
    const est = await sentEstimate(ID.amy);
    await db.update(estimates).set({ sentAt: at(-1) }).where(eq(estimates.id, est));
    expect((await runAutomations(at(-1, "10:05"))).started).toBe(1);
    expect((await runAutomations(at(-1, "10:10"))).started).toBe(0);
    const [run] = await runsFor(seq.body.id);
    expect(run).toMatchObject({ customerId: ID.amy, subjectType: "estimate", subjectId: est, status: "running", blockIndex: 0 });
    // Day 1: the text (texting isn't connected, so it's skipped).
    await runAutomations(at(0, "10:01"));
    let steps = await stepsFor(seq.body.id);
    expect(steps[0]).toMatchObject({ status: "skipped" });
    expect(steps[0].detail).toMatch(/Texting isn't connected/);
    // Day 2: the email to the customer, filled in.
    sent.length = 0;
    await runAutomations(at(1, "10:01"));
    const mail = sent.find((m) => m.to === email("amy"))!;
    expect(mail.subject).toMatch(/^About estimate \d+$/);
    expect(mail.html).toContain("Hi Amy, any questions about Spring program?");
    // The customer accepts: at day 7 it stops instead of emailing the owner, and does its stop action.
    await db.update(estimates).set({ status: "accepted", respondedAt: at(3) }).where(eq(estimates.id, est));
    sent.length = 0;
    await runAutomations(at(6, "10:01"));
    await runAutomations(at(6, "10:02"));
    const [after] = await runsFor(seq.body.id);
    expect(after.status).toBe("stopped");
    expect(after.reason).toBe("Stopped: Estimate is accepted or declined");
    steps = await stepsFor(seq.body.id);
    expect(steps.find((s) => s.kind === "action" && s.idx === 2)).toMatchObject({ status: "stopped" });
    expect(steps.find((s) => s.kind === "stop")).toMatchObject({ status: "done" });
    expect(sent.map((m) => m.to)).toEqual([email("owner")]);
    expect(sent[0].subject).toMatch(/^Amy Aster: estimate \d+$/);
    // History: the run with its actions; the automation history lists what was done.
    const hist = (await call("GET", `/automations/runs?automationId=${seq.body.id}`, "office")).body;
    expect(hist.runs[0].steps).toHaveLength(4);
    const done = (await call("GET", `/automations/history?automationId=${seq.body.id}`, "office")).body.rows;
    expect(done.map((r: any) => r.status).sort()).toEqual(["done", "done", "skipped"]);
  });

  it("before a work order: at 9 AM the set days before, once; skipped if the work order is done by then", async () => {
    const a = await call("POST", "/automations", "owner", {
      kind: "simple", name: "Reminder: your job is on the schedule", enabled: true, trigger: cond("before_visit"), daysBefore: 1, action: act("email_customer", { templateId: ID.tplReminder }),
    });
    expect(a.status).toBe(200);
    const prop = (await call("GET", `/customers/${ID.bob}`, "office")).body.properties[0].id;
    const wo = await call("POST", "/visits", "office", { title: "Round 2", customerId: ID.bob, propertyId: prop, date: plus(today(), 1), lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 6000 }] });
    expect(wo.status).toBe(200);
    sent.length = 0;
    expect((await runAutomations(at(0, "08:30"))).started).toBe(0);
    expect((await runAutomations(at(0, "09:30"))).started).toBe(1);
    expect((await runAutomations(at(0, "11:00"))).started).toBe(0);
    const mail = sent.find((m) => m.to === email("bob"))!;
    expect(mail.subject).toMatch(/^See you /);
    expect(mail.html).toContain("2 Elm St");
    const hist = (await call("GET", `/automations/history?automationId=${a.body.id}`, "office")).body.rows;
    expect(hist).toHaveLength(1);
    expect(hist[0].detail).toMatch(/^Emailed Bob Birch/);
    await call("POST", `/automations/${a.body.id}/enabled`, "owner", { enabled: false });
  });

  it("ELSE blocks and AND conditions: the first block that matches runs; none matching is kept as skipped", async () => {
    const seq = await call("POST", "/automations", "owner", {
      kind: "sequence", name: "Pulse check", enabled: true,
      blocks: [
        { trigger: cond("complete_visit"), and: [cond("customer_does_not_have_tag", { tagIds: [ID.asked] }), cond("customer_has_tag", { tagIds: [ID.vip] })], actions: [act("add_tag", { tagId: ID.asked })] },
        { trigger: cond("visit_skipped"), actions: [act("email_admin", { templateId: ID.tplOwner })] },
      ],
    });
    expect(seq.status).toBe(200);
    await tag(ID.amy, ID.vip);
    const propA = (await call("GET", `/customers/${ID.amy}`, "office")).body.properties[0].id;
    const propB = (await call("GET", `/customers/${ID.bob}`, "office")).body.properties[0].id;
    const woA = (await call("POST", "/visits", "office", { title: "Round 3", customerId: ID.amy, propertyId: propA, date: today(), lines: [{ description: "Fert", quantity: 1, unitPriceCents: 5000 }] })).body.id;
    const woB = (await call("POST", "/visits", "office", { title: "Round 3", customerId: ID.bob, propertyId: propB, date: today(), lines: [{ description: "Fert", quantity: 1, unitPriceCents: 5000 }] })).body.id;
    expect((await call("POST", `/visits/${woA}/complete`, "office", {})).status).toBe(200);
    expect((await call("POST", `/visits/${woB}/complete`, "office", {})).status).toBe(200);
    await runAutomations(new Date(Date.now() + 60_000));
    const runs = await runsFor(seq.body.id);
    expect(runs.find((r) => r.customerId === ID.amy)).toMatchObject({ status: "done", blockIndex: 0 });
    expect(runs.find((r) => r.customerId === ID.bob)).toMatchObject({ status: "skipped", reason: "Its conditions weren't met" });
    const [amy] = await db.select().from(customers).where(eq(customers.id, ID.amy));
    expect(amy.tagIds).toContain(ID.asked);
    // Skipped runs only show when asked for.
    expect((await call("GET", `/automations/runs?automationId=${seq.body.id}`, "office")).body.runs).toHaveLength(1);
    expect((await call("GET", `/automations/runs?automationId=${seq.body.id}&skipped=1`, "office")).body.runs).toHaveLength(2);
    await call("POST", `/automations/${seq.body.id}/enabled`, "owner", { enabled: false });
  });

  it("review before execution: actions wait in Review; send, skip, or stop the run; managers can review", async () => {
    const a = await call("POST", "/automations", "owner", {
      kind: "simple", name: "VIP welcome", enabled: true, review: true, trigger: cond("tag_added", { tagIds: [ID.vip] }), action: act("email_customer", { templateId: ID.tplFollow }),
    });
    expect(a.status).toBe(200);
    await tag(ID.bob, ID.vip);
    await runAutomations(new Date(Date.now() + 60_000));
    const review = (await call("GET", "/automations/review/list", "office")).body;
    const mine = review.filter((r: any) => r.automation.id === a.body.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].customer.name).toBe("Bob Birch");
    expect(mine[0].preview.channel).toBe("email");
    expect((await call("GET", "/automations", "office")).body.review).toBeGreaterThanOrEqual(1);
    sent.length = 0;
    const r = await call("POST", `/automations/steps/${mine[0].id}/review`, "office", { decision: "send" });
    expect(r.body.status).toBe("done");
    expect(sent.some((m) => m.to === email("bob"))).toBe(true);
    expect((await call("POST", `/automations/steps/${mine[0].id}/review`, "office", { decision: "send" })).body.error).toMatch(/isn't waiting/);
    // Another: skipped.
    await tag(ID.amy, ID.vip, false);
    await tag(ID.amy, ID.vip);
    await runAutomations(new Date(Date.now() + 2 * 60_000));
    const next = (await call("GET", "/automations/review/list", "office")).body.find((x: any) => x.automation.id === a.body.id);
    expect((await call("POST", `/automations/steps/${next.id}/review`, "office", { decision: "skip" })).body).toMatchObject({ status: "skipped", detail: "Skipped in review" });
    const [run] = (await runsFor(a.body.id)).filter((x) => x.customerId === ID.amy);
    expect(run.status).toBe("done");
    await call("POST", `/automations/${a.body.id}/enabled`, "owner", { enabled: false });
  });

  it("turned off for a customer: their runs are skipped; then run another automation, and stop after running", async () => {
    const second = await call("POST", "/automations", "owner", { kind: "simple", name: "Then a to-do-ish note", trigger: cond("customer_added"), action: act("email_admin", { templateId: ID.tplOwner }) });
    const first = await call("POST", "/automations", "owner", {
      kind: "simple", name: "Welcome", enabled: true, trigger: cond("customer_added"), action: act("email_customer", { templateId: ID.tplFollow }),
      subAction: "run_automation", subAutomationId: second.body.id, subDelayMinutes: 15,
    });
    expect(first.status).toBe(200);
    // The new customer, then one turned off for it.
    const cara = (await call("POST", "/customers", "office", { firstName: "Cara", lastName: "Cole", email: email("cara") })).body.id;
    const dan = (await call("POST", "/customers", "office", { firstName: "Dan", lastName: "Dale", email: email("dan") })).body.id;
    const tab = (await call("GET", `/automations/customer/${dan}`, "office")).body.automations;
    expect(tab.find((x: any) => x.id === first.body.id)).toMatchObject({ off: false });
    expect((await call("PUT", `/automations/customer/${dan}/${first.body.id}`, "office", { on: false })).body.off).toBe(true);
    sent.length = 0;
    const now = Date.now() + 60_000;
    await runAutomations(new Date(now));
    const runs = await runsFor(first.body.id);
    expect(runs.find((r) => r.customerId === dan)).toMatchObject({ status: "skipped", reason: "Turned off for this customer" });
    expect(runs.find((r) => r.customerId === cara)).toMatchObject({ status: "done" });
    expect(sent.some((m) => m.to === email("cara"))).toBe(true);
    // 15 minutes later the second one runs for Cara (though it's off: it was asked for).
    sent.length = 0;
    await runAutomations(new Date(now + 16 * 60_000));
    expect(sent.map((m) => m.to)).toContain(email("owner"));
    expect((await call("DELETE", `/automations/${second.body.id}`, "owner")).body.error).toMatch(/Welcome/);
    // "Stop this automation": turns itself off after it runs.
    const once = await call("POST", "/automations", "owner", { kind: "simple", name: "Once", enabled: true, trigger: cond("customer_added"), action: act("email_admin", { templateId: ID.tplOwner }), subAction: "stop_automation" });
    await onSince(once.body.id, new Date(Date.now() - 60_000));
    await call("POST", "/customers", "office", { firstName: "Eve", lastName: "East", email: email("eve") });
    await runAutomations(new Date(Date.now() + 60_000));
    const [row] = await db.select().from(automations).where(eq(automations.id, once.body.id));
    expect(row.enabled).toBe(false);
    await call("POST", `/automations/${first.body.id}/enabled`, "owner", { enabled: false });
  });

  it("a to-do action: due 8 AM the next day, for the chosen person", async () => {
    const seq = await call("POST", "/automations", "owner", {
      kind: "sequence", name: "Call about the estimate", enabled: true,
      blocks: [{ trigger: cond("estimate_changes"), actions: [act("create_assign_todo", { todoTitle: "Call {{CUSTOMER_NAME}} about estimate {{ESTIMATE_NUMBER}}", employeeIds: [ID.office] })] }],
    });
    expect(seq.status).toBe(200);
    const est = await sentEstimate(ID.bob);
    await db.update(estimates).set({ status: "changes", respondedAt: new Date() }).where(eq(estimates.id, est));
    const now = new Date(Date.now() + 60_000);
    await runAutomations(now);
    const [t] = await db.select().from(todos).where(and(eq(todos.companyId, companyId), eq(todos.customerId, ID.bob)));
    expect(t.title).toMatch(/^Call Bob Birch about estimate \d+$/);
    expect(t.startTime).toBe("08:00");
    expect(t.date).toBe(plus(localParts(now, TZ).date, 1));
  });

  it("turning one off stops its runs; a template in use can't be deleted", async () => {
    const seq = await call("POST", "/automations", "owner", {
      kind: "sequence", name: "Slow follow-up", enabled: true,
      blocks: [{ trigger: cond("estimate_sent"), actions: [act("email_customer", { waitMinutes: 3 * 1440, templateId: ID.tplFollow })] }],
    });
    await sentEstimate(ID.bob);
    await runAutomations(new Date(Date.now() + 60_000));
    expect((await runsFor(seq.body.id))[0].status).toBe("running");
    await call("POST", `/automations/${seq.body.id}/enabled`, "owner", { enabled: false });
    const [run] = await runsFor(seq.body.id);
    expect(run).toMatchObject({ status: "stopped", reason: "The automation was turned off" });
    expect((await call("DELETE", `/templates/${ID.tplFollow}`, "owner")).body.error).toMatch(/used by/);
  });

  it("imports Homeworks automations and sequences, all off, with their templates, tags and stops", async () => {
    // A template brought in from Homeworks earlier.
    await db.insert(templates).values({ companyId, channel: "email", audience: "internal", name: "Yellow Slip (Internal)", subject: "Yellow slip", body: "<p>x</p>", importedFrom: "homeworks:592701" });
    const file = {
      source: "homeworks",
      automations: [
        { id: 1, on: true, review: false, title: "Email me when a visit is complete", trigger: { value: "complete_visit", text: "Visit is Completed" }, delay: { value: "900" }, action: { value: "email_admin" }, emailTemplate: { value: "592701", text: "Yellow Slip (Internal)" }, subAction: { value: "none" }, tags: ["Ops"] },
        { id: 2, title: "Reminder of meeting", trigger: { value: "before_meeting" }, delay: { value: "86401" }, action: { value: "email_customer" }, emailTemplate: { value: "", text: "--- Please Select ---" } },
        { id: 3, title: "Weird", trigger: { value: "nope" }, action: { value: "email_admin" } },
      ],
      sequences: [{
        id: 16880, title: "Yellow Slip", description: "Tells the office", review: false,
        blocks: [{ trigger: { value: "tag_added", text: "Tag has been Added", attrs: [`Yellow Slip ${suffix}`] }, when: [], actions: [{ instant: true, days: 0, hours: 0, minutes: 0, action: { value: "email_admin" }, email: { value: "592701", text: "Yellow Slip (Internal)" } }] }],
        stops: [{ value: "tag_removed", text: "Tag has been Removed", attrs: [`Yellow Slip ${suffix}`] }], stopActions: [],
      }],
    };
    expect((await call("POST", "/automations/import", "office", file)).status).toBe(403);
    const r = await call("POST", "/automations/import", "owner", file);
    expect(r.body).toMatchObject({ added: 3, already: 0, tagsMade: 1 });
    expect(r.body.notes[0]).toMatch(/Weird/);
    const list = (await call("GET", "/automations", "owner")).body.automations.filter((x: any) => x.imported === "homeworks");
    expect(list).toHaveLength(3);
    expect(list.every((x: any) => !x.enabled)).toBe(true);
    const visit = list.find((x: any) => x.name === "Email me when a visit is complete");
    expect(visit.def).toMatchObject({ kind: "simple", delayMinutes: 15, action: { action: "email_admin" } });
    expect(visit.def.action.templateId).toBeTruthy();
    expect(visit.labels).toEqual(["Ops"]);
    expect(list.find((x: any) => x.name === "Reminder of meeting").cannotTurnOn).toMatch(/meetings/);
    const slip = list.find((x: any) => x.kind === "sequence");
    expect(slip.def.blocks[0].trigger.tagIds).toHaveLength(1);
    expect(slip.def.stops[0]).toMatchObject({ key: "tag_removed", tagIds: slip.def.blocks[0].trigger.tagIds });
    expect(slip.problems).toEqual([]);
    // Imported again: nothing new.
    expect((await call("POST", "/automations/import", "owner", file)).body).toMatchObject({ added: 0, already: 3 });
  });

  it("texts wait for daytime (9 AM to 6 PM)", () => {
    expect(_test.textTime(at(0, "10:00"), TZ)).toBeNull();
    expect(_test.textTime(at(0, "21:30"), TZ)!.getTime()).toBe(at(1, "09:00").getTime());
    expect(_test.textTime(at(0, "07:00"), TZ)!.getTime()).toBe(at(0, "09:00").getTime());
  });
});

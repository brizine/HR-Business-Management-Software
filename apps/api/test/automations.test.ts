/** Automations: the starter set, steps with waits, stop conditions, once per thing, review first, tags and to-dos, and quiet hours for texts. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { automationRuns, customers, todos } from "../src/db/schema";
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
const sent: EmailMessage[] = [];
const TZ = "America/Chicago";
let companyId = "";
const today = () => localParts(new Date(), TZ).date;
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 10 AM company time, `days` from today. */
const at = (days: number, time = "10:00") => zonedTime(plus(today(), days), time, TZ);

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
const runsFor = (automationId: string) => db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
async function sentEstimate(customerId: string) {
  const e = await call("POST", "/estimates", "office", { customerId, title: "Spring program", lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 30000 }] });
  expect((await call("POST", `/estimates/${e.body.id}/send`, "office", {})).status).toBe(200);
  return e.body.id as string;
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Auto Co", firstName: "Ava", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token; companyId = s.company.id; ID.owner = s.user.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Auto Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@auto.test", phone: "(405) 555-0100", timezone: TZ });
  ID.office = (await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" })).body.id;
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  const mk = async (b: Record<string, unknown>) => (await call("POST", "/customers", "office", b)).body.id as string;
  ID.amy = await mk({ firstName: "Amy", lastName: "Aster", email: email("amy") });
  ID.bob = await mk({ firstName: "Bob", lastName: "Birch", email: email("bob") });
  ID.vip = (await call("POST", "/crm/tags", "owner", { name: `VIP ${suffix}`, color: "green" })).body.id;
  ID.welcomed = (await call("POST", "/crm/tags", "owner", { name: `Welcomed ${suffix}`, color: "blue" })).body.id;
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("automations", () => {
  it("the starter set: admins add it once; all off", async () => {
    expect((await call("POST", "/automations/starter", "office")).status).toBe(403);
    expect((await call("POST", "/automations/starter", "owner")).body.added).toBe(5);
    expect((await call("POST", "/automations/starter", "owner")).body.added).toBe(0);
    const list = (await call("GET", "/automations", "office")).body;
    expect(list.automations).toHaveLength(5);
    expect(list.automations.every((a: any) => !a.enabled)).toBe(true);
    expect((await call("GET", "/automations/templates", "office")).body.length).toBe(8);
  });

  it("an estimate follow-up: steps with waits; a text with texting off is skipped; a to-do at the end", async () => {
    const tpls = (await call("GET", "/automations/templates", "owner")).body;
    const tpl = (name: string) => tpls.find((t: any) => t.name === name).id;
    // Sent before it's turned on: doesn't start it.
    await sentEstimate(ID.bob);
    const a = await call("POST", "/automations", "owner", {
      name: "Follow up", enabled: true, trigger: "estimate_sent", stopWhen: ["estimate_answered"],
      steps: [
        { waitMinutes: 0, action: "email_customer", templateId: tpl("Estimate follow-up (customer)") },
        { waitMinutes: 2 * 1440, action: "text_customer", templateId: tpl("Estimate follow-up (text)") },
        { waitMinutes: 0, action: "create_todo", todoTitle: "Call about estimate {estimate_number}", employeeIds: [ID.office] },
      ],
    });
    expect(a.status).toBe(200);
    ID.follow = a.body.id;
    // A text template where an email one belongs is refused.
    expect((await call("PUT", `/automations/${ID.follow}`, "owner", { ...a.body, steps: [{ waitMinutes: 0, action: "email_customer", templateId: tpl("Estimate follow-up (text)") }] })).status).toBe(400);
    ID.amyEst = await sentEstimate(ID.amy);
    sent.length = 0;
    expect(await runAutomations(new Date())).toMatchObject({ started: 1, steps: 1 });
    const mail = sent.find((m) => m.to === email("amy"))!;
    expect(mail.subject).toBe("Your estimate from Auto Co");
    expect(mail.text).toContain("/estimate/");
    expect(mail.text).toContain("$300.00");
    let [run] = await runsFor(ID.follow);
    expect(run).toMatchObject({ status: "running", stepIndex: 1 });
    // Once per estimate.
    expect((await runAutomations(new Date())).started).toBe(0);
    // Days later: the text (texting isn't connected), then the to-do.
    await runAutomations(at(3));
    await runAutomations(at(3, "10:05"));
    [run] = await runsFor(ID.follow);
    expect(run.status).toBe("done");
    expect(run.log.map((l) => [l.action, l.status])).toEqual([["email_customer", "done"], ["text_customer", "skipped"], ["create_todo", "done"]]);
    expect(run.log[1].detail).toMatch(/Texting isn't connected/);
    const [todo] = await db.select().from(todos).where(eq(todos.customerId, ID.amy));
    expect(todo.title).toMatch(/^Call about estimate \d+$/);
  });

  it("stops when the estimate is answered; turning it off stops its runs", async () => {
    const est = await sentEstimate(ID.bob);
    await runAutomations(new Date());
    expect((await call("POST", `/estimates/${est}/respond`, "office", { action: "accept", selectedLineIds: [] })).status).toBe(200);
    await runAutomations(at(3));
    const bobRun = (await runsFor(ID.follow)).find((r) => r.subjectId === est)!;
    expect(bobRun).toMatchObject({ status: "stopped", stoppedReason: "The estimate was accepted", stepIndex: 1 });
    const runs = (await call("GET", `/automations/runs?customerId=${ID.bob}`, "office")).body;
    expect(runs[0]).toMatchObject({ status: "stopped", automation: { name: "Follow up", trigger: "Estimate is sent" }, customer: { name: "Bob Birch" } });
    expect((await call("POST", `/automations/${ID.follow}/enabled`, "office", { enabled: false })).status).toBe(403);
    expect((await call("POST", `/automations/${ID.follow}/enabled`, "owner", { enabled: false })).body.enabled).toBe(false);
  });

  it("past-due invoices with review first: waits for approval, then sends", async () => {
    const tpls = (await call("GET", "/automations/templates", "owner")).body;
    const a = await call("POST", "/automations", "owner", {
      name: "Past due", enabled: true, trigger: "invoice_past_due", stopWhen: ["invoice_paid"], review: true,
      steps: [{ waitMinutes: 0, action: "email_customer", templateId: tpls.find((t: any) => t.name === "Invoice past due (customer)").id }],
    });
    const inv = await call("POST", "/invoices", "office", { customerId: ID.amy, issueDate: plus(today(), -1), dueDate: plus(today(), -1), lines: [{ description: "Mowing", quantity: 1, unitPriceCents: 6500 }] });
    await call("POST", `/invoices/${inv.body.id}/send`, "office", { via: ["paper"] });
    sent.length = 0;
    await runAutomations(new Date());
    expect(sent).toHaveLength(0);
    const review = (await call("GET", "/automations/runs?status=review", "office")).body;
    expect(review).toHaveLength(1);
    expect(review[0].preview.subject).toMatch(/^Invoice \d+ is past due$/);
    expect(review[0].preview.body).toContain("$65.00");
    expect((await call("GET", "/automations", "office")).body.review).toBe(1);
    const r = await call("POST", `/automations/runs/${review[0].id}/review`, "office", { decision: "send" });
    expect(r.body.status).toBe("done");
    expect(sent.find((m) => m.to === email("amy"))!.subject).toMatch(/is past due/);
    expect((await runsFor(a.body.id))[0].log[0]).toMatchObject({ status: "done" });
  });

  it("a tag added: tags the customer and tells the office; only customers without an excluded tag", async () => {
    const tpls = (await call("GET", "/automations/templates", "owner")).body;
    const note = await call("POST", "/automations/templates", "owner", { kind: "email", name: "VIP note", subject: "{name} is now a VIP", body: "Give {first_name} a call." });
    expect(note.status).toBe(200);
    const a = await call("POST", "/automations", "owner", {
      name: "VIP welcome", enabled: true, trigger: "tag_added", tagId: ID.vip, exceptTagIds: [ID.welcomed], stopWhen: ["tag_removed"],
      steps: [{ waitMinutes: 0, action: "notify_staff", templateId: note.body.id, employeeIds: [ID.office] }, { waitMinutes: 0, action: "add_tag", tagId: ID.welcomed }],
    });
    expect(a.status).toBe(200);
    expect(tpls.length).toBe(8);
    for (const id of [ID.amy, ID.bob]) {
      const [c] = await db.select().from(customers).where(eq(customers.id, id));
      const after = id === ID.bob ? [...c.tagIds, ID.vip, ID.welcomed] : [...c.tagIds, ID.vip];
      await db.update(customers).set({ tagIds: after }).where(eq(customers.id, id));
      await recordTagChanges(db as never, { companyId, before: c.tagIds, after, customerId: id, source: "hand", byId: null });
    }
    expect((await runAutomations(new Date())).started).toBe(1);
    await runAutomations(new Date(Date.now() + 60_000));
    const [run] = await runsFor(a.body.id);
    expect(run).toMatchObject({ customerId: ID.amy, status: "done" });
    const [amy] = await db.select().from(customers).where(eq(customers.id, ID.amy));
    expect(amy.tagIds).toContain(ID.welcomed);
    await flushNotifications();
    const items = (await call("GET", "/notifications", "office")).body;
    expect((items.items ?? items).some((n: any) => n.title === "Amy Aster is now a VIP")).toBe(true);
    // A template in use can't be deleted.
    expect((await call("DELETE", `/automations/templates/${note.body.id}`, "owner")).body.error).toMatch(/VIP welcome/);
  });

  it("texts wait for daytime (9 AM to 6 PM)", () => {
    expect(_test.textTime(at(0, "10:00"), TZ)).toBeNull();
    expect(_test.textTime(at(0, "21:30"), TZ)!.getTime()).toBe(at(1, "09:00").getTime());
    expect(_test.textTime(at(0, "07:00"), TZ)!.getTime()).toBe(at(0, "09:00").getTime());
  });
});

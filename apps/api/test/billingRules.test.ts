/** Late fees (rules copied at send, added once per step, not discounted, waived) and auto-sending invoices on schedules. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { invoices } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { applyLateFees, runAutoSend } from "../src/lib/billingJobs";
import { flushBillingSync } from "../src/lib/billingSync";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@brules.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
let today = "";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
async function sentInvoice(customerId: string, cents: number, issueDate: string, discountPct = 0) {
  const via = ["paper"];
  const r = await call("POST", "/invoices", "office", { customerId, issueDate, dueDate: plus(issueDate, 15), ...(discountPct ? { discountKind: "percent", discountValue: discountPct } : {}), lines: [{ description: "Lawn service", quantity: 1, unitPriceCents: cents }] });
  expect((await call("POST", `/invoices/${r.body.id}/send`, "office", { via })).status).toBe(200);
  // As if it was sent on its invoice date (late fee days count from the day it was sent).
  await db.update(invoices).set({ sentOn: issueDate }).where(eq(invoices.id, r.body.id));
  return r.body.id as string;
}
const inv = async (id: string) => (await call("GET", `/invoices/${id}`, "office")).body;

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Rules Co", firstName: "Rita", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Rules Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@brules.test", timezone: "America/Chicago" });
  ID.office = (await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" })).body.id;
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  const mk = async (b: Record<string, unknown>) => (await call("POST", "/customers", "office", b)).body.id as string;
  ID.ann = await mk({ firstName: "Ann", lastName: "Apple", email: email("ann"), discountPercent: 10, property: { street: "1 Oak St", city: "Norman", zip: "73069" } });
  ID.bob = await mk({ firstName: "Bob", lastName: "Berry", email: email("bob") });
  ID.cal = await mk({ firstName: "Cal", lastName: "Cole", email: email("cal") });
  ID.dee = await mk({ firstName: "Dee", lastName: "Dunn", delivery: ["paper"], billingStreet: "4 Elm St", billingCity: "Norman", billingZip: "73069" });
});

afterAll(async () => {
  setEmailTransport(null);
  await flushBillingSync();
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("late fees", () => {
  it("company rules: admins set them; the main billing settings keep them", async () => {
    const rules = { enabled: true, emailCustomer: true, rules: [{ days: 30, kind: "amount", value: 1500 }, { days: 60, kind: "percent", value: 2 }] };
    expect((await call("PUT", "/invoices/settings/late-fees", "office", rules)).status).toBe(403);
    expect((await call("PUT", "/invoices/settings/late-fees", "owner", { ...rules, rules: [] })).status).toBe(400);
    expect((await call("PUT", "/invoices/settings/late-fees", "owner", rules)).status).toBe(200);
    const s = (await call("GET", "/invoices/settings", "owner")).body;
    await call("PUT", "/invoices/settings", "owner", { nextInvoiceNumber: s.nextInvoiceNumber, termsDays: 15, footer: "", payableTo: "", autoApplyCredits: true, taxEnabled: false, taxName: "Sales tax", defaultTaxRate: 0 });
    expect((await call("GET", "/invoices/settings", "owner")).body.lateFees).toMatchObject({ enabled: true, rules: [{ days: 30 }, { days: 60 }] });
  });

  it("an invoice gets the rules in force when it's sent; customers can have none or their own", async () => {
    await call("PUT", `/customers/${ID.bob}/billing-rules`, "office", { lateFeeMode: "none", autoSendMode: "default" });
    await call("PUT", `/customers/${ID.cal}/billing-rules`, "office", { lateFeeMode: "custom", lateFeeRules: [{ days: 10, kind: "amount", value: 500 }], autoSendMode: "default" });
    expect((await call("PUT", `/customers/${ID.cal}/billing-rules`, "office", { lateFeeMode: "custom", lateFeeRules: [], autoSendMode: "default" })).status).toBe(400);
    ID.annInv = await sentInvoice(ID.ann, 20000, plus(today, -65), 10);
    ID.bobInv = await sentInvoice(ID.bob, 20000, plus(today, -65));
    ID.calInv = await sentInvoice(ID.cal, 8000, plus(today, -12));
    expect((await inv(ID.annInv)).lateFeeRules).toHaveLength(2);
    expect((await inv(ID.bobInv)).lateFeeRules).toBeNull();
    expect((await inv(ID.calInv)).lateFeeRules).toEqual([{ days: 10, kind: "amount", value: 500 }]);
  });

  it("adds each step once (not discounted), emails the customer, tells the office", async () => {
    sent.length = 0;
    const before = await inv(ID.annInv);
    // Ann's 10% discount: $200 less $20 = $180.
    expect(before.totalCents).toBe(18000);
    expect(await applyLateFees()).toBe(2);
    expect(await applyLateFees()).toBe(0);
    const a = await inv(ID.annInv);
    // $15 (30 days) + 2% of the original $180 = $3.60 (60 days); the discount doesn't touch them.
    expect(a.lines.filter((l: any) => l.isLateFee).map((l: any) => [l.description, l.unitPriceCents])).toEqual([["Late fee: 30 days after the invoice was sent", 1500], ["Late fee: 60 days after the invoice was sent", 360]]);
    expect(a).toMatchObject({ totalCents: 19860, discountCents: 2000 });
    expect(a.lateFees.map((f: any) => [f.days, f.amountCents])).toEqual([[30, 1500], [60, 360]]);
    expect((await inv(ID.bobInv)).totalCents).toBe(20000);
    expect((await inv(ID.calInv)).totalCents).toBe(8500);
    const mail = sent.find((m) => m.to === email("ann"))!;
    expect(mail.subject).toMatch(/Late fee added: invoice \d+ from Rules Co/);
    expect(mail.text).toContain("The balance is now $198.60");
    await flushNotifications();
    const items = (await call("GET", "/notifications", "office")).body;
    expect((items.items ?? items)[0].title).toMatch(/Late fees added to 2 invoices \(\$23\.60\)/);
  });

  it("editing an invoice keeps its late fee lines as they are; a fee that's been paid can't be waived", async () => {
    const a = await inv(ID.annInv);
    const lines = a.lines.map((l: any) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.isLateFee ? 99999 : 30000, incomeAccountCode: l.incomeAccountCode, isLateFee: l.isLateFee }));
    expect((await call("PUT", `/invoices/${ID.annInv}`, "office", { customerId: ID.ann, issueDate: a.issueDate, dueDate: a.dueDate, discountKind: "percent", discountValue: 10, lines })).status).toBe(200);
    const b = await inv(ID.annInv);
    expect(b.lines.map((l: any) => [l.description, l.unitPriceCents, l.isLateFee])).toEqual([["Lawn service", 30000, false], ["Late fee: 30 days after the invoice was sent", 1500, true], ["Late fee: 60 days after the invoice was sent", 360, true]]);
    // $300 less 10% = $270, plus the $18.60 in fees.
    expect(b.totalCents).toBe(28860);
    await call("POST", `/invoices/${ID.annInv}/payments`, "office", { amountCents: b.totalCents, method: "check" });
    const r = await call("POST", `/invoices/${ID.annInv}/late-fees/${b.lateFees[0].id}/waive`, "office");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already paid this fee/);
  });

  it("a paid invoice gets no fee; waiving takes the line off and it isn't added again", async () => {
    const paid = await sentInvoice(ID.ann, 5000, plus(today, -40));
    await call("POST", `/invoices/${paid}/payments`, "office", { amountCents: (await inv(paid)).totalCents, method: "check" });
    await applyLateFees();
    expect((await inv(paid)).lateFees).toEqual([]);
    const fee = (await inv(ID.calInv)).lateFees[0];
    expect((await call("POST", `/invoices/${ID.calInv}/late-fees/${fee.id}/waive`, "office")).status).toBe(200);
    expect(await inv(ID.calInv)).toMatchObject({ totalCents: 8000 });
    await applyLateFees();
    const c = await inv(ID.calInv);
    expect(c.totalCents).toBe(8000);
    expect(c.lateFees[0].waivedAt).toBeTruthy();
  });
});

describe("auto-sending invoices", () => {
  it("company schedule and hour; customers on default, off or their own schedule", async () => {
    expect((await call("PUT", "/invoices/settings/auto-send", "owner", { enabled: true, hour: 0, invoiceWorkOrders: true, schedule: { frequency: "daily" } })).status).toBe(200);
    // Bob: off; Cal: his own schedule, which isn't today; Ann and Dee: the company's (every day).
    await call("PUT", `/customers/${ID.bob}/billing-rules`, "office", { lateFeeMode: "none", autoSendMode: "off" });
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    await call("PUT", `/customers/${ID.cal}/billing-rules`, "office", { lateFeeMode: "default", autoSendMode: "custom", autoSendSchedule: { frequency: "weekly", days: [(dow + 1) % 7] } });
    const draft = async (customerId: string, cents: number) => (await call("POST", "/invoices", "office", { customerId, lines: [{ description: "Service", quantity: 1, unitPriceCents: cents }] })).body.id as string;
    ID.annDraft = await draft(ID.ann, 7000);
    ID.bobDraft = await draft(ID.bob, 7000);
    ID.calDraft = await draft(ID.cal, 7000);
    ID.deeDraft = await draft(ID.dee, 7000);
    // A finished work order for Ann that isn't invoiced yet.
    const annProp = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0].id;
    const wo = await call("POST", "/visits", "office", { title: "Round 4", customerId: ID.ann, propertyId: annProp, date: today, lines: [{ description: "Fertilizer", quantity: 1, unitPriceCents: 6000 }] });
    await call("POST", `/visits/${wo.body.id}/complete`, "office", {});
    sent.length = 0;
    expect(await runAutoSend()).toBeGreaterThanOrEqual(3);
    // Once a day: a draft made after today's run waits for the next one.
    const later = await draft(ID.ann, 1000);
    await runAutoSend();
    expect((await inv(later)).status).toBe("draft");
    const a = await inv(ID.annDraft);
    expect(a.status).toBe("sent");
    expect(a.autoSentAt).toBeTruthy();
    expect((await inv(ID.bobDraft)).status).toBe("draft");
    expect((await inv(ID.calDraft)).status).toBe("draft");
    const d = await inv(ID.deeDraft);
    expect(d).toMatchObject({ status: "sent", needsMailing: true });
    // Ann got two emails: the draft, and the invoice made from her work order.
    expect(sent.filter((m) => m.to === email("ann") && /^Invoice/.test(m.subject))).toHaveLength(2);
    const woInv = (await call("GET", `/visits/${wo.body.id}`, "office")).body;
    expect(woInv.invoiceId).toBeTruthy();
    await flushNotifications();
    const items = (await call("GET", "/notifications", "office")).body;
    expect((items.items ?? items)[0].title).toMatch(/Sent 3 invoices automatically/);
  });
});

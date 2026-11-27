/** Billing: the price list, invoices (drafts, numbering, email with PDF, print queue), payments, voiding and permissions. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@billing.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Billing Co", firstName: "Bea", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Billing Co", addressLine1: "1601 Deskin Dr", city: "Norman", state: "OK", zip: "73069", phone: "(405) 447-4390", email: "office@billing.test", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  await call("POST", "/crm/sample-customers", "owner");
  const jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0];
  ID.jane = jane.id;
  ID.janeProp = (await call("GET", `/customers/${jane.id}`, "office")).body.properties[0].id;
  ID.office = (await call("GET", "/customers?q=office%20park", "office")).body.rows[0].id;
  ID.paper = (await call("GET", "/customers?q=fields", "office")).body.rows[0].id;
  ID.pm = (await call("GET", "/customers?q=prairie", "office")).body.rows[0].id;
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("price list", () => {
  it("admins add services; managers read them; techs can't", async () => {
    expect((await call("POST", "/service-types", "office", { name: "X" })).status).toBe(403);
    expect((await call("GET", "/service-types", "tech")).status).toBe(403);
    const round = await call("POST", "/service-types", "owner", { name: "Fertilizer & weed control round", pricing: "per_thousand", priceCents: 425, minimumCents: 4000, incomeAccountCode: "4000" });
    expect(round.body).toMatchObject({ pricing: "per_thousand", priceCents: 425, sortOrder: 0 });
    ID.round = round.body.id;
    const aer = await call("POST", "/service-types", "owner", { name: "Core aeration", pricing: "bracket", brackets: [{ upToSqFt: 8000, priceCents: 7500 }, { upToSqFt: null, priceCents: 9500 }], incomeAccountCode: "4200" });
    ID.aer = aer.body.id;
    const old = await call("POST", "/service-types", "owner", { name: "Old service", priceCents: 100, active: false });
    expect((await call("GET", "/service-types", "office")).body.map((s: { name: string }) => s.name)).toEqual(["Fertilizer & weed control round", "Core aeration"]);
    expect((await call("GET", "/service-types?all=1", "office")).body).toHaveLength(3);
    expect((await call("PUT", "/service-types/order", "owner", { ids: [ID.aer, ID.round, old.body.id] })).status).toBe(200);
    expect((await call("GET", "/service-types", "office")).body[0].name).toBe("Core aeration");
  });

  it("saves a volume-discount rate card, tiers in order of size (a later rate may be higher)", async () => {
    const tiers = [{ fromSqFt: 3000, ratePer1000Cents: 650 }, { fromSqFt: 6000, ratePer1000Cents: 625 }, { fromSqFt: 10000, ratePer1000Cents: 575 }];
    const card = { name: "Early Spring (tiered)", pricing: "tiered", minimumCents: 3800, tiers, bandSizeSqFt: 500, bandPricePoint: 0.5, roundToCents: 50, maxAutoSqFt: 40000, targetCentsPerHour: 18000, setupMinutes: 4, minutesPer1000: 3, active: false };
    const made = await call("POST", "/service-types", "owner", card);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ pricing: "tiered", minimumCents: 3800, tiers, bandSizeSqFt: 500, bandPricePoint: 0.5, roundToCents: 50, maxAutoSqFt: 40000, targetCentsPerHour: 18000 });
    const rising = await call("PUT", `/service-types/${made.body.id}`, "owner", { ...card, tiers: [{ fromSqFt: 3000, ratePer1000Cents: 600 }, { fromSqFt: 6000, ratePer1000Cents: 700 }] });
    expect(rising.status).toBe(200);
    const backwards = await call("PUT", `/service-types/${made.body.id}`, "owner", { ...card, tiers: [{ fromSqFt: 6000, ratePer1000Cents: 600 }, { fromSqFt: 3000, ratePer1000Cents: 700 }] });
    expect(backwards.status).toBe(400);
    expect((await call("PUT", `/service-types/${made.body.id}`, "owner", card)).status).toBe(200);
    const exact = await call("PUT", `/service-types/${made.body.id}`, "owner", { ...card, bandSizeSqFt: null });
    expect(exact.body.bandSizeSqFt).toBeNull();
    expect(exact.body.tiers).toEqual(tiers);
  });
});

describe("invoices", () => {
  it("drafts have no number; due date follows the terms", async () => {
    await call("PUT", "/invoices/settings", "owner", { nextInvoiceNumber: 5001, termsDays: 15, footer: "Thank you! All applications are guaranteed.", payableTo: "" });
    const draft = await call("POST", "/invoices", "office", {
      customerId: ID.jane, propertyId: ID.janeProp, issueDate: "2026-03-02",
      lines: [{ serviceTypeId: ID.round, description: "Round 1: pre-emergent", quantity: 1, unitPriceCents: 4675, incomeAccountCode: "4000" }, { description: "Gate fix", quantity: 2, unitPriceCents: 1250, incomeAccountCode: "4950" }],
      discountKind: "percent", discountValue: 10, notes: "Thanks for being a customer",
    });
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ number: null, status: "draft", dueDate: "2026-03-17", subtotalCents: 7175, discountCents: 718, totalCents: 6457 });
    ID.draft = draft.body.id;
    const list = await call("GET", "/invoices?status=draft", "office");
    expect(list.body.rows[0]).toMatchObject({ customerName: "Jane Example", street: "1201 Bluestem Dr", balanceCents: 6457 });
    expect((await call("POST", `/invoices/${ID.draft}/payments`, "office", { amountCents: 100, method: "cash" })).status).toBe(400);
    expect((await call("POST", "/invoices", "office", { customerId: ID.jane, lines: [{ serviceTypeId: "00000000-0000-4000-8000-000000000000", description: "x", quantity: 1, unitPriceCents: 1 }] })).status).toBe(400);
    expect((await call("GET", "/invoices", "tech")).status).toBe(403);
  });

  it("sending by email numbers it, attaches the PDF and copies contacts marked for invoices", async () => {
    const r = await call("POST", `/invoices/${ID.draft}/send`, "office", { via: ["email"], message: "Round 1 is done." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: 5001, status: "sent", needsMailing: false });
    expect(r.body.emailedAt).toBeTruthy();
    const m = sent.at(-1)!;
    expect(m).toMatchObject({ to: "jane.example@example.com", fromName: "Billing Co", replyTo: "office@billing.test" });
    // Sent with the invoice template (Resources → Templates): Crewdesk's own unless another was picked.
    expect(m.subject).toBe("Invoice 5001 from Billing Co: $64.57 due March 17, 2026");
    expect(m.text).toContain("Round 1 is done.");
    expect(m.html).toContain("Amount due: <strong>$64.57</strong>");
    expect(m.attachments?.[0]).toMatchObject({ filename: "Invoice-5001.pdf", contentType: "application/pdf" });
    expect(m.attachments?.[0].content.subarray(0, 5).toString()).toBe("%PDF-");
    const pdf = await call("GET", `/invoices/${ID.draft}/pdf`, "office");
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.raw.length).toBeGreaterThan(1000);
    expect((await call("GET", `/invoices/settings`, "office")).body.nextInvoiceNumber).toBe(5002);

    // Accounts payable is copied for the property manager.
    const pm = await call("POST", "/invoices", "office", { customerId: ID.pm, lines: [{ description: "Spring cleanup", quantity: 1, unitPriceCents: 25000 }] });
    await call("POST", `/invoices/${pm.body.id}/send`, "office", { via: ["email"] });
    expect(sent.at(-1)).toMatchObject({ to: "dana@prairiepm.example.com", cc: ["ap@prairiepm.example.com"] });
  });

  it("PO-number accounts need one before sending; paper goes to the print queue, sorted by ZIP", async () => {
    const po = await call("POST", "/invoices", "office", { customerId: ID.office, lines: [{ description: "Grounds round 1", quantity: 1, unitPriceCents: 39000 }] });
    const refused = await call("POST", `/invoices/${po.body.id}/send`, "office", { via: ["email", "paper"] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/PO number/);
    const fixed = await call("PUT", `/invoices/${po.body.id}`, "office", { customerId: ID.office, poNumber: "PO-7781", lines: [{ description: "Grounds round 1", quantity: 1, unitPriceCents: 39000 }] });
    expect(fixed.body.poNumber).toBe("PO-7781");
    expect((await call("POST", `/invoices/${po.body.id}/send`, "office", { via: ["email", "paper"] })).body).toMatchObject({ number: 5003, needsMailing: true });
    const paper = await call("POST", "/invoices", "office", { customerId: ID.paper, lines: [{ description: "Round 1", quantity: 1, unitPriceCents: 4000 }] });
    expect((await call("POST", `/invoices/${paper.body.id}/send`, "office", { via: ["email"] })).body.error).toMatch(/no email address/);
    await call("POST", `/invoices/${paper.body.id}/send`, "office", { via: ["paper"] });
    ID.paperInv = paper.body.id;
    const queue = await call("GET", "/invoices/print-queue", "office");
    expect(queue.body).toEqual([ID.paperInv, po.body.id]); // 73071 before 73072
    const batch = await call("GET", `/invoices/print?ids=${queue.body.join(",")}`, "office");
    expect(batch.headers["content-type"]).toBe("application/pdf");
    expect((await call("POST", "/invoices/mark-mailed", "office", { ids: queue.body })).body.marked).toBe(2);
    expect((await call("GET", "/invoices/print-queue", "office")).body).toEqual([]);
    expect((await call("GET", "/invoices?status=mail", "office")).body.total).toBe(0);
  });

  it("cash and check payments: partly paid, then paid; overpaying is refused; voiding a payment reopens it", async () => {
    const pay = (amountCents: number, more = {}) => call("POST", `/invoices/${ID.draft}/payments`, "office", { amountCents, method: "check", reference: "1042", receivedOn: "2026-03-10", ...more });
    expect((await pay(7000)).status).toBe(400);
    const first = await pay(4000);
    expect(first.body.invoice).toMatchObject({ status: "partial", paidCents: 4000 });
    expect((await call("PUT", `/invoices/${ID.draft}`, "office", { customerId: ID.jane, lines: [{ description: "x", quantity: 1, unitPriceCents: 1 }] })).status).toBe(400);
    const second = await pay(2457, { method: "cash", reference: undefined });
    expect(second.body.invoice).toMatchObject({ status: "paid", paidCents: 6457 });
    const summary = await call("GET", `/invoices/customer-summary/${ID.jane}`, "office");
    expect(summary.body).toMatchObject({ outstandingCents: 0, paidThisYearCents: expect.any(Number) });
    const reopened = await call("POST", `/invoices/${ID.draft}/payments/${second.body.payment.id}/void`, "office");
    expect(reopened.body).toMatchObject({ status: "partial", paidCents: 4000 });
    const detail = await call("GET", `/invoices/${ID.draft}`, "office");
    // Newest first: the voided cash payment, then the check.
    expect(detail.body.payments.map((p: { status: string; method: string }) => `${p.method}:${p.status}`)).toEqual(["cash:void", "check:completed"]);
    expect(detail.body.customer).toMatchObject({ name: "Jane Example", billTo: ["1201 Bluestem Dr", "Norman, OK 73069"] });
  });

  it("void needs no payments and a reason; drafts are deleted instead; open totals and overdue", async () => {
    expect((await call("POST", `/invoices/${ID.draft}/void`, "office", { reason: "Wrong customer" })).status).toBe(400);
    expect((await call("POST", `/invoices/${ID.paperInv}/void`, "office", {})).status).toBe(400);
    const v = await call("POST", `/invoices/${ID.paperInv}/void`, "office", { reason: "Duplicate" });
    expect(v.body).toMatchObject({ status: "void", voidReason: "Duplicate" });
    const d = await call("POST", "/invoices", "office", { customerId: ID.jane, lines: [{ description: "x", quantity: 1, unitPriceCents: 100 }] });
    expect((await call("POST", `/invoices/${d.body.id}/void`, "office", { reason: "x" })).status).toBe(400);
    expect((await call("DELETE", `/invoices/${d.body.id}`, "office")).status).toBe(200);
    const open = await call("GET", "/invoices?status=open", "office");
    expect(open.body.rows.map((r: { number: number }) => r.number).sort()).toEqual([5001, 5002, 5003]);
    expect(open.body.dueCents).toBe(2457 + 25000 + 39000);
    const overdue = await call("GET", "/invoices?status=overdue", "office");
    expect(overdue.body.rows.map((r: { number: number }) => r.number)).toContain(5001);
    expect((await call("GET", "/invoices?q=5003", "office")).body.rows[0].poNumber).toBe("PO-7781");
  });

  it("the next number can't go backwards; sample customers can still be removed with their invoices", async () => {
    expect((await call("PUT", "/invoices/settings", "owner", { nextInvoiceNumber: 5002, termsDays: 0, footer: "", payableTo: "" })).status).toBe(400);
    expect((await call("PUT", "/invoices/settings", "office", { nextInvoiceNumber: 9000, termsDays: 0, footer: "", payableTo: "" })).status).toBe(403);
    expect((await call("DELETE", "/crm/sample-customers", "owner")).status).toBe(200);
    expect((await call("GET", "/invoices?status=all", "office")).body.total).toBe(0);
  });
});

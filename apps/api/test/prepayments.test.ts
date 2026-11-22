/** Prepayments: taking them (with a discount), paying invoices from them, voiding a use, taking back the discount, refunding the rest, and the Bigcapital entries (income when received). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ACCOUNTING_SETTINGS } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushBillingSync } from "../src/lib/billingSync";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

/* ── A pretend Bigcapital ── */
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let nextId = 900;
const ACCOUNTS: { id: number; code: string; name: string; account_type: string; active: boolean }[] =
  [["1020", 1002], ["1030", 1034], ["2400", 1029], ["4000", 1026], ["4900", 1031], ["4950", 1028]].map(([code, id]) => ({ id: id as number, code: code as string, name: `Acct ${code}`, account_type: "income", active: true }));
const applied: { id: number; creditNoteId: number; invoiceId: number; amount: number }[] = [];
let server: Server;
let baseUrl = "";

function fake() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/api/, "").split("?")[0];
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, path, body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== "Bearer bc_test_key") return send(401, { message: "Unauthorized" });
      const seg = path.split("/");
      if (req.method === "GET" && path.startsWith("/accounts")) return send(200, { accounts: ACCOUNTS });
      if (req.method === "POST" && path === "/accounts") { const id = nextId++; ACCOUNTS.push({ id, code: body.code, name: body.name, account_type: body.accountType, active: true }); return send(200, { id }); }
      if (req.method === "GET" && path.startsWith("/items")) return send(200, { items: [] });
      if (req.method === "POST" && path === "/items") return send(200, { id: nextId++ });
      if (req.method === "POST" && path === "/customers") return send(201, { id: nextId++ });
      if (path.startsWith("/sale-invoices") || path.startsWith("/payments-received") || path.startsWith("/manual-journals")) return send(req.method === "POST" ? 201 : 200, { id: req.method === "POST" ? nextId++ : Number(seg[2]) });
      if (path.startsWith("/credit-notes")) {
        if (req.method === "POST" && path === "/credit-notes") return send(201, { id: nextId++ });
        if (req.method === "POST" && seg[3] === "apply-invoices") { for (const e of body.entries) applied.push({ id: nextId++, creditNoteId: Number(seg[2]), invoiceId: e.invoiceId, amount: e.amount }); return send(200, {}); }
        if (req.method === "GET" && seg[3] === "applied-invoices") return send(200, applied.filter((a) => a.creditNoteId === Number(seg[2])).map((a) => ({ id: a.id, invoice_id: a.invoiceId, amount: a.amount })));
        if (req.method === "DELETE" && seg[2] === "applied-invoices") { const i = applied.findIndex((a) => a.id === Number(seg[3])); if (i >= 0) applied.splice(i, 1); return send(200, {}); }
        if (req.method === "DELETE") return send(200, {});
      }
      send(404, { message: `Cannot ${req.method} ${path}` });
    });
  });
}

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@prepay.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
const inv = async (id: string) => (await call("GET", `/invoices/${id}`, "office")).body;
const pp = async (id: string) => (await call("GET", `/prepayments?customerId=${ID.cust}`, "office")).body.prepayments.find((p: any) => p.id === id);
async function sentInvoice(cents: number, propertyId = ID.propA, customerId = ID.cust) {
  const r = await call("POST", "/invoices", "office", { customerId, propertyId, issueDate: "2027-04-01", dueDate: "2027-04-15", lines: [{ description: "Lawn round", quantity: 1, unitPriceCents: cents, incomeAccountCode: "4000" }] });
  expect((await call("POST", `/invoices/${r.body.id}/send`, "office", { via: ["paper"] })).status).toBe(200);
  return r.body.id as string;
}
const take = (body: Record<string, unknown>, who = "office") => call("POST", "/prepayments", who, { customerId: ID.cust, description: "2027 season: rounds 1-7", how: "check", reference: "2201", ...body });

beforeAll(async () => {
  server = fake();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Prepay Co", firstName: "Pru", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Prepay Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@prepay.test", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  ID.cust = (await call("POST", "/customers", "owner", { firstName: "Paige", lastName: "Prepay", email: email("paige"), property: { street: "3 Birch Ln", city: "Norman", zip: "73069", lawnSqFt: 10000 } })).body.id;
  ID.propA = (await call("GET", `/customers/${ID.cust}`, "owner")).body.properties[0].id;
  ID.propB = (await call("POST", "/properties", "owner", { street: "4 Cedar Ln", city: "Norman", zip: "73069", billToCustomerId: ID.cust })).body.id;
  expect((await call("PUT", "/accounting/settings", "owner", { ...DEFAULT_ACCOUNTING_SETTINGS, enabled: true, baseUrl, apiKey: "bc_test_key" })).status).toBe(200);
});

afterAll(async () => {
  setEmailTransport(null);
  await flushBillingSync();
  await app.close();
  await flushNotifications();
  await pool.end();
  server.close();
});

describe("Prepayments", () => {
  it("takes a season prepayment by check with a 5% discount, and books it into 2400", async () => {
    expect((await take({ coversCents: 50000 }, "tech")).status).toBe(403);
    expect((await take({ coversCents: 50000, discountKind: "percent", discountValue: 60 })).status).toBe(400);
    calls.length = 0;
    const r = await take({ coversCents: 50000, discountKind: "percent", discountValue: 5, lines: [{ description: "Fertilizer & weed control round", quantity: 7, unitPriceCents: 7143 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: 1, status: "open", method: "check", reference: "2201", coversCents: 50000, discountCents: 2500, amountCents: 47500, cashLeftCents: 47500, discountLeftCents: 2500 });
    expect((await call("GET", `/invoices/customer-summary/${ID.cust}`, "office")).body.prepaidCents).toBe(47500);
    await flushBillingSync();
    const journal = calls.find((c) => c.method === "POST" && c.path === "/manual-journals")!;
    expect(journal.body.reference).toBe("Prepayment PP-1");
    // Income when received: Undeposited Funds → 4000 Lawn Treatment Programs (nothing to 2400).
    expect(journal.body.entries).toEqual([
      expect.objectContaining({ accountId: 1002, debit: 475 }),
      expect.objectContaining({ accountId: 1026, credit: 475, contactId: expect.any(Number) }),
    ]);
    ID.pp1 = r.body.id;
  });

  it("pays invoices as they're sent: the cash share as a prepaid payment, the discount share as a credit", async () => {
    calls.length = 0;
    ID.i100 = await sentInvoice(10000);
    const a = await inv(ID.i100);
    expect(a).toMatchObject({ status: "paid", paidCents: 9500, creditedCents: 500, balanceCents: 0 });
    expect(a.payments[0]).toMatchObject({ method: "prepaid", amountCents: 9500, prepaymentNumber: 1 });
    expect(a.credits[0]).toMatchObject({ amountCents: 500, reason: "prepay_discount" });
    expect(await pp(ID.pp1)).toMatchObject({ appliedCents: 9500, appliedDiscountCents: 500, cashLeftCents: 38000, discountLeftCents: 2000 });
    // In Bigcapital: it already counted as income when received, so the invoice is closed by a credit note on
    // 4000 (no payment, so no second income on cash basis); the discount is a credit note in 4900.
    await flushBillingSync();
    const notes = calls.filter((c) => c.method === "POST" && c.path === "/credit-notes").map((c) => c.body);
    expect(notes.find((n) => n.entries[0].rate === 95)).toMatchObject({ referenceNo: "Prepayment PP-1", entries: [{ rate: 95, sellAccountId: 1026 }] });
    expect(notes.find((n) => n.entries[0].rate === 5)!.entries[0]).toMatchObject({ sellAccountId: 1031 });
    expect(calls.filter((c) => c.method === "POST" && /apply-invoices$/.test(c.path))).toHaveLength(2);
    expect(calls.some((c) => c.path.startsWith("/payments-received") || (c.method === "POST" && c.path === "/accounts"))).toBe(false);
    // A bigger invoice takes the rest: $380 cash + $20 discount; $50 still owed.
    ID.i450 = await sentInvoice(45000);
    expect(await inv(ID.i450)).toMatchObject({ status: "partial", paidCents: 38000, creditedCents: 2000, balanceCents: 5000 });
    expect(await pp(ID.pp1)).toMatchObject({ cashLeftCents: 0, discountLeftCents: 0 });
  });

  it("voiding a prepaid payment puts its cash and discount back on the prepayment", async () => {
    const a = await inv(ID.i100);
    calls.length = 0;
    expect((await call("POST", `/invoices/${ID.i100}/payments/${a.payments[0].id}/void`, "office")).status).toBe(200);
    expect(await inv(ID.i100)).toMatchObject({ status: "sent", paidCents: 0, creditedCents: 0, balanceCents: 10000 });
    expect(await pp(ID.pp1)).toMatchObject({ cashLeftCents: 9500, discountLeftCents: 500 });
    await flushBillingSync();
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path.replace(/\d+/g, "#"));
    expect(deletes).toEqual(expect.arrayContaining(["/credit-notes/applied-invoices/#", "/credit-notes/#"]));
    expect(deletes.filter((d) => d === "/credit-notes/#")).toHaveLength(2); // the prepaid credit note and the discount's
  });

  it("the customer cancels: the discount is taken back (paid from the prepayment at full price), and the rest refunded", async () => {
    // Before: invoice 450 has $20 discount; $95 cash and $5 discount left on the prepayment.
    expect((await call("POST", `/prepayments/${ID.pp1}/reverse-discount`, "office")).status).toBe(403);
    const r = await call("POST", `/prepayments/${ID.pp1}/reverse-discount`, "owner");
    expect(r.status).toBe(200);
    expect(r.body.discountTakenBackCents).toBe(2000);
    // Invoice 450 now owes $70 more than the cash paid, and the prepayment's $95 pays it at full price.
    expect(await inv(ID.i450)).toMatchObject({ creditedCents: 0, paidCents: 45000, status: "paid" });
    expect(await pp(ID.pp1)).toMatchObject({ discountReversed: true, cashLeftCents: 2500, discountLeftCents: 0 });
    expect((await call("POST", `/prepayments/${ID.pp1}/reverse-discount`, "owner")).body.error).toMatch(/already taken back/);
    calls.length = 0;
    sent.length = 0;
    const refund = await call("POST", `/prepayments/${ID.pp1}/refund`, "owner", { reference: "Check 3105" });
    expect(refund.body).toMatchObject({ status: "closed", refundedCents: 2500 });
    expect(await pp(ID.pp1)).toMatchObject({ cashLeftCents: 0, status: "closed" });
    expect(sent[0]?.subject).toMatch(/^Refund of \$25\.00/);
    await flushBillingSync();
    const back = calls.find((c) => c.method === "POST" && c.path === "/manual-journals")!;
    expect(back.body.entries).toEqual([expect.objectContaining({ accountId: 1026, debit: 25 }), expect.objectContaining({ accountId: 1002, credit: 25 })]);
    // Invoice 100 still owes: nothing is left to pay it.
    expect(await inv(ID.i100)).toMatchObject({ balanceCents: 10000 });
  });

  it("a property's prepayment only pays that property's invoices; 'use now' pays open invoices right away", async () => {
    const b = await sentInvoice(3000, ID.propB);
    const r = await take({ coversCents: 6000, propertyId: ID.propB, how: "cash", useNow: true, description: "Cedar Ln fall services" });
    expect(r.body).toMatchObject({ status: "open", appliedCents: 3000, cashLeftCents: 3000 });
    expect(await inv(b)).toMatchObject({ status: "paid" });
    expect(await inv(ID.i100)).toMatchObject({ balanceCents: 10000 }); // property A: not touched
    const next = await sentInvoice(2000, ID.propA);
    expect(await inv(next)).toMatchObject({ paidCents: 0 });
    const c = await sentInvoice(2000, ID.propB);
    expect(await inv(c)).toMatchObject({ paidCents: 2000, status: "paid" });
  });

  it("counts as income in each covered service's own account; an entered amount where it's told", async () => {
    const pest = (await call("POST", "/service-types", "owner", { name: "Quarterly pest control", pricing: "flat", priceCents: 9000, incomeAccountCode: "4100" })).body.id;
    const lawn = (await call("POST", "/service-types", "owner", { name: "Lawn round", pricing: "flat", priceCents: 6000, incomeAccountCode: "4000" })).body.id;
    calls.length = 0;
    const r = await take({ coversCents: 30000, discountKind: "percent", discountValue: 10, how: "cash", description: "Lawn + pest year", lines: [
      { serviceTypeId: lawn, description: "Lawn round", quantity: 2, unitPriceCents: 6000 }, { serviceTypeId: pest, description: "Quarterly pest control", quantity: 2, unitPriceCents: 9000 },
    ] });
    expect(r.body).toMatchObject({ amountCents: 27000, income: [{ code: "4000", cents: 10800 }, { code: "4100", cents: 16200 }] });
    const m = await take({ coversCents: 5000, how: "cash", description: "Toward one-time work", incomeAccountCode: "4200" });
    expect(m.body.income).toEqual([{ code: "4200", cents: 5000 }]);
    ACCOUNTS.push({ id: 1048, code: "4200", name: "Acct 4200", account_type: "income", active: true }, { id: 1047, code: "4100", name: "Acct 4100", account_type: "income", active: true });
    await call("POST", `/prepayments/${r.body.id}/sync`, "office");
    const j = calls.filter((c) => c.method === "POST" && c.path === "/manual-journals").map((c) => c.body).find((b) => b.reference === `Prepayment PP-${r.body.number}`)!;
    expect(j.entries).toEqual([
      expect.objectContaining({ accountId: 1002, debit: 270 }),
      expect.objectContaining({ accountId: 1026, credit: 108 }),
      expect.objectContaining({ accountId: 1047, credit: 162 }),
    ]);
  });

  it("anything booked the earlier way (into 2400) is redone as income", async () => {
    const r = await take({ coversCents: 4000, how: "cash", description: "Old style" });
    await flushBillingSync();
    // Pretend it was booked before this change.
    const { db } = await import("../src/db");
    const { prepayments } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(prepayments).set({ bigcapitalAsIncome: false }).where(eq(prepayments.id, r.body.id));
    calls.length = 0;
    // The regular retry pass picks it up on its own.
    const { retryBillingSyncs } = await import("../src/lib/billingSync");
    await retryBillingSyncs();
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(/\d+/g, "#")}`)).toEqual(["DELETE /manual-journals/#", "POST /manual-journals"]);
    expect(calls.find((c) => c.method === "POST")!.body.entries[1]).toMatchObject({ accountId: 1026, credit: 40 });
  });

  it("voids a mistake, but not one that paid invoices; a pay link needs Stripe", async () => {
    const m = await take({ coversCents: 1000, how: "cash" });
    expect((await call("POST", `/prepayments/${m.body.id}/void`, "owner", { reason: "Entered twice" })).body).toMatchObject({ status: "void" });
    const used = (await call("GET", `/prepayments?customerId=${ID.cust}`, "office")).body.prepayments.find((p: any) => p.description === "Cedar Ln fall services");
    expect((await call("POST", `/prepayments/${used.id}/void`, "owner", { reason: "x" })).body.error).toMatch(/has paid invoices/);
    expect((await take({ coversCents: 1000, how: "link" })).body.error).toMatch(/Online payments aren't set up/);
  });
});

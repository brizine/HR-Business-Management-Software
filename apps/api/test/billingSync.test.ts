/** Bigcapital sync for billing, against a pretend Bigcapital: customers, items, invoices, payments, voids, failures and retries. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { DEFAULT_ACCOUNTING_SETTINGS } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { accountingPostings, invoicePayments, invoices } from "../src/db/schema";
import { flushBillingSync, retryBillingSyncs, syncPayment } from "../src/lib/billingSync";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

/* ── A pretend Bigcapital ── */
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let failInvoices = false;
let nextId = 500;
const items: { id: number; name: string }[] = [{ id: 99, name: "Core aeration" }];
const ACCOUNTS = [["1020", 1002], ["1030", 1034], ["4000", 1026], ["4100", 1047], ["4200", 1048], ["4950", 1028]].map(([code, id]) => ({ id, code, name: `Acct ${code}`, account_type: "income", active: true }));
let server: Server;
let baseUrl = "";

function fake() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\/api/, "");
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, path, body });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== "Bearer bc_test_key") return send(401, { message: "Unauthorized" });
      if (req.method === "GET" && path.startsWith("/accounts")) return send(200, { accounts: ACCOUNTS });
      if (req.method === "GET" && path.startsWith("/items")) return send(200, { items });
      if (req.method === "POST" && path === "/items") {
        if (items.some((i) => i.name.toLowerCase() === body.name.toLowerCase())) return send(400, { errors: [{ type: "ITEM_NAME_EXISTS", code: 100 }] });
        const id = nextId++; items.push({ id, name: body.name });
        return send(200, { id, message: "The item has been successfully created." });
      }
      if (req.method === "POST" && path === "/customers") return send(201, { id: nextId++, displayName: body.displayName });
      if (req.method === "PUT" && path.startsWith("/customers/")) return send(200, { id: Number(path.split("/")[2]) });
      if (path.startsWith("/sale-invoices")) {
        if (failInvoices) return send(500, { message: "Bigcapital is restarting" });
        if (req.method === "POST") return send(201, { id: nextId++, invoiceNo: body.invoiceNo });
        return send(200, { id: Number(path.split("/")[2]) });
      }
      if (path.startsWith("/payments-received")) {
        if (req.method === "POST") return send(201, { id: nextId++ });
        return send(200, { id: Number(path.split("/")[2]) });
      }
      send(404, { message: `Cannot ${req.method} ${path}` });
    });
  });
}

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@bcsync.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const last = (method: string, prefix: string) => [...calls].reverse().find((c) => c.method === method && c.path.startsWith(prefix));
const count = (method: string, prefix: string) => calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length;

beforeAll(async () => {
  server = fake();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Sync Co", firstName: "Sy", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  const saved = await call("PUT", "/accounting/settings", "owner", { ...DEFAULT_ACCOUNTING_SETTINGS, enabled: true, baseUrl, apiKey: "bc_test_key" });
  expect(saved.status).toBe(200);
  ID.round = (await call("POST", "/service-types", "owner", { name: "Fertilizer & weed control round", pricing: "per_thousand", priceCents: 425, minimumCents: 4000, incomeAccountCode: "4000" })).body.id;
  ID.aer = (await call("POST", "/service-types", "owner", { name: "Core aeration", pricing: "flat", priceCents: 9500, incomeAccountCode: "4200" })).body.id;
  const c = await call("POST", "/customers", "owner", {
    firstName: "Rita", lastName: "Real", email: "rita@example.com", phone: "4055550199", billingStreet: "12 Oak St", billingCity: "Norman", billingZip: "73069",
    property: { street: "12 Oak St", city: "Norman", zip: "73069", lawnSqFt: 10000 },
  });
  ID.rita = c.body.id;
  await call("POST", "/crm/sample-customers", "owner");
  ID.sample = (await call("GET", "/customers?q=jane", "owner")).body.rows[0].id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
  server.close();
});

async function sentInvoice(customerId: string, lines: unknown[], extra = {}) {
  const inv = await call("POST", "/invoices", "owner", { customerId, issueDate: "2026-03-02", dueDate: "2026-03-17", lines, ...extra });
  await call("POST", `/invoices/${inv.body.id}/send`, "owner", { via: ["paper"] });
  await flushBillingSync();
  return inv.body.id as string;
}

describe("Bigcapital billing sync", () => {
  it("drafts stay out; sending creates the customer, the items and the invoice with the same number", async () => {
    const draft = await call("POST", "/invoices", "owner", { customerId: ID.rita, lines: [{ description: "x", quantity: 1, unitPriceCents: 100 }] });
    await flushBillingSync();
    expect(calls.length).toBe(0);
    await call("DELETE", `/invoices/${draft.body.id}`, "owner");

    ID.inv = await sentInvoice(ID.rita, [
      { serviceTypeId: ID.round, description: "Round 1", quantity: 1, unitPriceCents: 4250, incomeAccountCode: "4000" },
      { serviceTypeId: ID.aer, description: "Core aeration", quantity: 1, unitPriceCents: 9500, incomeAccountCode: "4200" },
      { description: "Gate repair", quantity: 2, unitPriceCents: 1250, incomeAccountCode: "4950" },
    ], { discountKind: "amount", discountValue: 1000, poNumber: "PO-1", notes: "Thanks!" });
    expect(last("POST", "/customers")!.body).toMatchObject({ customerType: "individual", displayName: "Rita Real", email: "rita@example.com", workPhone: "(405) 555-0199", billingAddress1: "12 Oak St", billingAddressPostcode: "73069", currencyCode: "USD", code: "1001" });
    // The service item is made; the existing "Core aeration" item is reused by name; one item for custom lines.
    expect(calls.filter((c) => c.method === "POST" && c.path === "/items").map((c) => c.body.name)).toEqual(["Fertilizer & weed control round", "Core aeration", "Services (Crewdesk)"]);
    expect(last("POST", "/items")!.body).toMatchObject({ type: "service", sellable: true, sellAccountId: 1028 });
    const inv = last("POST", "/sale-invoices")!.body;
    expect(inv).toMatchObject({ invoiceNo: "1001", invoiceDate: "2026-03-02", dueDate: "2026-03-17", delivered: true, referenceNo: "PO-1", invoiceMessage: "Thanks!", discount: 10, discountType: "amount" });
    expect(inv.entries).toEqual([
      expect.objectContaining({ index: 1, rate: 42.5, quantity: 1, sellAccountId: 1026, description: "Round 1" }),
      expect.objectContaining({ index: 2, itemId: 99, rate: 95, sellAccountId: 1048 }),
      expect.objectContaining({ index: 3, rate: 12.5, quantity: 2, sellAccountId: 1028 }),
    ]);
    const detail = await call("GET", `/invoices/${ID.inv}`, "owner");
    expect(detail.body.sync).toMatchObject({ connected: true, invoice: { status: "posted", error: null } });
    expect(detail.body.bigcapitalInvoiceId).toBeTruthy();
  });

  it("a second invoice reuses the customer and items", async () => {
    const before = { items: count("POST", "/items"), customers: count("POST", "/customers") };
    await sentInvoice(ID.rita, [{ serviceTypeId: ID.round, description: "Round 2", quantity: 1, unitPriceCents: 4250, incomeAccountCode: "4000" }]);
    expect({ items: count("POST", "/items"), customers: count("POST", "/customers") }).toEqual(before);
    expect(last("POST", "/sale-invoices")!.body.invoiceNo).toBe("1002");
  });

  it("payments go to Undeposited Funds against the invoice; voiding one deletes it", async () => {
    const bcInvoice = (await call("GET", `/invoices/${ID.inv}`, "owner")).body.bigcapitalInvoiceId;
    const p = await call("POST", `/invoices/${ID.inv}/payments`, "owner", { amountCents: 5000, method: "check", reference: "1042", receivedOn: "2026-03-10" });
    await flushBillingSync();
    expect(last("POST", "/payments-received")!.body).toMatchObject({
      paymentDate: "2026-03-10", depositAccountId: 1002, referenceNo: "Check 1042", amount: 50, entries: [{ invoiceId: Number(bcInvoice), paymentAmount: 50 }],
    });
    const detail = await call("GET", `/invoices/${ID.inv}`, "owner");
    expect(detail.body.sync.payments[p.body.payment.id]).toMatchObject({ status: "posted" });
    await call("POST", `/invoices/${ID.inv}/payments/${p.body.payment.id}/void`, "owner");
    await flushBillingSync();
    expect(last("DELETE", "/payments-received")).toBeTruthy();
  });

  it("editing a sent invoice updates it; editing the customer updates them", async () => {
    await call("PUT", `/invoices/${ID.inv}`, "owner", { customerId: ID.rita, issueDate: "2026-03-02", dueDate: "2026-03-31", lines: [{ serviceTypeId: ID.round, description: "Round 1 (corrected)", quantity: 1, unitPriceCents: 4000, incomeAccountCode: "4000" }] });
    await flushBillingSync();
    expect(last("PUT", "/sale-invoices")!.body).toMatchObject({ invoiceNo: "1001", dueDate: "2026-03-31", entries: [expect.objectContaining({ rate: 40 })] });
    await call("PUT", `/customers/${ID.rita}`, "owner", { firstName: "Rita", lastName: "Real", email: "rita.new@example.com", delivery: ["email"] });
    await flushBillingSync();
    expect(last("PUT", "/customers")!.body).toMatchObject({ email: "rita.new@example.com", displayName: "Rita Real" });
  });

  it("when Bigcapital is down it's recorded, retried on schedule and by the button", async () => {
    failInvoices = true;
    const id = await sentInvoice(ID.rita, [{ description: "Spring cleanup", quantity: 1, unitPriceCents: 20000, incomeAccountCode: "4200" }]);
    let detail = await call("GET", `/invoices/${id}`, "owner");
    expect(detail.body.sync.invoice).toMatchObject({ status: "failed" });
    expect(detail.body.sync.invoice.error).toMatch(/restarting/);
    // The button while it's still down: still failed.
    expect((await call("POST", `/invoices/${id}/sync`, "owner")).body.invoice.status).toBe("failed");
    failInvoices = false;
    // The scheduled retry picks up failures older than a couple of minutes.
    await db.update(accountingPostings).set({ updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(accountingPostings.sourceId, id));
    await retryBillingSyncs();
    detail = await call("GET", `/invoices/${id}`, "owner");
    expect(detail.body.sync.invoice.status).toBe("posted");
    ID.retried = id;
  });

  it("voiding a sent invoice deletes the Bigcapital copy", async () => {
    const bcId = (await call("GET", `/invoices/${ID.retried}`, "owner")).body.bigcapitalInvoiceId;
    await call("POST", `/invoices/${ID.retried}/void`, "owner", { reason: "Duplicate" });
    await flushBillingSync();
    expect(last("DELETE", "/sale-invoices")!.path).toBe(`/sale-invoices/${bcId}`);
    expect((await call("GET", `/invoices/${ID.retried}`, "owner")).body.bigcapitalInvoiceId).toBeNull();
  });

  it("card payments go to Card Processor Clearing; a refund replaces the payment with what's left; clearing and failed bank payments stay out", async () => {
    const id = await sentInvoice(ID.rita, [{ description: "Round 2", quantity: 1, unitPriceCents: 9000, incomeAccountCode: "4000" }]);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    const base = { companyId: inv.companyId, invoiceId: id, customerId: inv.customerId, receivedOn: "2026-03-12", note: "Paid online" };
    const [card] = await db.insert(invoicePayments).values({ ...base, amountCents: 9000, method: "card", methodDetail: "Visa ·· 4242", stripePaymentId: `pi_bc_${suffix}_1` }).returning();
    await syncPayment(inv.companyId, card.id);
    const first = last("POST", "/payments-received")!;
    expect(first.body).toMatchObject({ depositAccountId: 1034, entries: [{ paymentAmount: 90 }] });
    // Part refunded: the old payment goes and one for $60 takes its place.
    const before = calls.length;
    await db.update(invoicePayments).set({ refundedCents: 3000 }).where(eq(invoicePayments.id, card.id));
    await syncPayment(inv.companyId, card.id);
    const after = calls.slice(before).filter((c) => c.method !== "GET");
    expect(after.map((c) => c.method)).toEqual(["DELETE", "POST"]);
    expect(after[1].body).toMatchObject({ depositAccountId: 1034, entries: [{ paymentAmount: 60 }] });
    expect(after[1].body.statement).toContain("$90.00 paid, $30.00 refunded");
    // Nothing changed: nothing sent.
    const again = calls.length;
    await syncPayment(inv.companyId, card.id);
    expect(calls.slice(again).filter((c) => c.method !== "GET")).toEqual([]);
    // Fully refunded: out of the books.
    await db.update(invoicePayments).set({ refundedCents: 9000 }).where(eq(invoicePayments.id, card.id));
    await syncPayment(inv.companyId, card.id);
    expect(calls.slice(again).filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["DELETE"]);
    const [row] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, card.id));
    expect(row.bigcapitalPaymentId).toBeNull();
    // A bank payment still clearing, or one the bank returned, never goes to the books.
    const quiet = calls.length;
    const [pending] = await db.insert(invoicePayments).values({ ...base, amountCents: 9000, method: "ach", status: "pending", stripePaymentId: `pi_bc_${suffix}_2` }).returning();
    const [failed] = await db.insert(invoicePayments).values({ ...base, amountCents: 9000, method: "ach", status: "failed", stripePaymentId: `pi_bc_${suffix}_3` }).returning();
    expect(await syncPayment(inv.companyId, pending.id)).toBe("skipped");
    expect(await syncPayment(inv.companyId, failed.id)).toBe("skipped");
    await call("POST", `/invoices/${id}/sync`, "owner");
    expect(calls.slice(quiet).filter((c) => c.path.startsWith("/payments-received"))).toEqual([]);
  });

  it("sample customers never reach the real books (outside the test company)", async () => {
    const before = calls.length;
    const id = await sentInvoice(ID.sample, [{ description: "Round 1", quantity: 1, unitPriceCents: 4000, incomeAccountCode: "4000" }]);
    const detail = await call("GET", `/invoices/${id}`, "owner");
    expect(detail.body.sync.invoice).toMatchObject({ status: "skipped" });
    expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    await call("POST", `/invoices/${id}/payments`, "owner", { amountCents: 4000, method: "cash" });
    await flushBillingSync();
    expect(calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
  });
});

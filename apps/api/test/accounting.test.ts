/**
 * Accounting: connecting to Bigcapital, and posting payroll and work order costs to it.
 * A stand-in Bigcapital server applies the same rules as the real one (see packages/server in
 * bigcapitalhq/bigcapital): Bearer API key, camelCase request bodies with numbered entries,
 * balanced journals, expense categories on expense accounts, payment from bank/card accounts,
 * snake_case top-level response keys.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { companies, payPeriods } from "../src/db/schema";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { flushAccounting } from "../src/lib/accounting";

let app: FastifyInstance;
let bc: Server;
let bcUrl = "";
const KEY = "bc_test_key_123";
const received: { path: string; body: any }[] = [];
const ACCOUNTS = [
  { id: 1, name: "Checking", code: "1000", accountType: "bank", active: true },
  { id: 2, name: "Company Card", code: "2100", accountType: "credit-card", active: true },
  { id: 3, name: "Payroll Liabilities", code: "2200", accountType: "other-current-liability", active: true },
  { id: 4, name: "Wages", code: "6000", accountType: "expense", active: true },
  { id: 5, name: "Vehicle Repairs", code: "6100", accountType: "expense", active: true },
  { id: 6, name: "Old account", code: "9999", accountType: "expense", active: false },
];
const fail = (res: any, status: number, message: string) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ errors: [{ statusCode: status, type: "ERROR", message }] })); };

const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@acct.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true, baseUrl: bcUrl, wagesAccountId: 4, timeOffAccountId: null, payrollLiabilityAccountId: 3, partsAccountId: 5, laborAccountId: null,
  workOrderPaymentAccountId: 2, autoPostPayroll: true, autoPostWorkOrders: true, ...over,
});

beforeAll(async () => {
  bc = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${KEY}`) return fail(res, 401, "Unauthorized");
      const body = raw ? JSON.parse(raw) : null;
      const ok = (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      const acct = (id: number) => ACCOUNTS.find((a) => a.id === id);
      if (req.method === "GET" && req.url === "/api/accounts") return ok({ accounts: ACCOUNTS, filter_meta: {} });
      if (req.method === "POST" && req.url === "/api/manual-journals") {
        received.push({ path: req.url, body });
        if (!body.date || !Array.isArray(body.entries) || body.entries.length < 2) return fail(res, 400, "Invalid journal");
        if (body.entries.some((e: any) => !Number.isInteger(e.index) || !Number.isInteger(e.accountId) || !acct(e.accountId))) return fail(res, 400, "ACCOUNTS_IDS_NOT_FOUND");
        const sum = (k: string) => Math.round(body.entries.reduce((s: number, e: any) => s + (e[k] ?? 0), 0) * 100);
        if (sum("debit") !== sum("credit")) return fail(res, 400, "CREDIT_DEBIT_NOT_EQUAL");
        return ok({ id: 100 + received.length, journal_number: "00001" });
      }
      if (req.method === "POST" && req.url === "/api/expenses") {
        received.push({ path: req.url, body });
        const pay = acct(body.paymentAccountId);
        if (!pay || !["cash", "bank", "credit-card", "other-current-asset", "non-current-asset", "fixed-asset"].includes(pay.accountType)) return fail(res, 400, "PAYMENT_ACCOUNT_HAS_INVALID_TYPE");
        if (body.categories.some((c: any) => !["expense", "other-expense", "cost-of-goods-sold"].includes(acct(c.expenseAccountId)?.accountType ?? ""))) return fail(res, 400, "EXPENSES_ACCOUNT_HAS_INVALID_TYPE");
        return ok({ id: 500 + received.length });
      }
      fail(res, 404, "Not found");
    });
  });
  await new Promise<void>((r) => bc.listen(0, "127.0.0.1", r));
  bcUrl = `http://127.0.0.1:${(bc.address() as AddressInfo).port}`;

  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Acct Co", firstName: "Ada", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  const me = (await call("GET", "/auth/me", "owner")).body;
  ID.owner = me.user.id;
  ID.company = me.company.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["admin", "admin"], ["crew", "employee"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role, payType: "hourly", payRateCents: 2000 });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await new Promise((r) => bc.close(r));
  await pool.end();
});

describe("accounting (Bigcapital)", () => {
  it("only payroll admins see it; only the owner connects; the key never comes back", async () => {
    expect((await call("GET", "/accounting/settings", "crew")).status).toBe(403);
    expect((await call("PUT", "/accounting/settings", "admin", settings({ apiKey: KEY }))).status).toBe(403);
    expect((await call("PUT", "/accounting/settings", "owner", settings())).status).toBe(400); // no key yet
    expect((await call("POST", "/accounting/test", "owner", { baseUrl: bcUrl, apiKey: "bc_wrong" })).body.error).toMatch(/refused the API key/);
    const test = await call("POST", "/accounting/test", "owner", { baseUrl: `${bcUrl}/api/`, apiKey: KEY });
    expect(test.body.accounts.map((a: any) => [a.id, a.type])).toEqual([[1, "bank"], [2, "credit-card"], [3, "other-current-liability"], [4, "expense"], [5, "expense"]]);
    const saved = await call("PUT", "/accounting/settings", "owner", settings({ apiKey: KEY }));
    expect(saved.body).toMatchObject({ hasKey: true, baseUrl: bcUrl, wagesAccountId: 4 });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(JSON.stringify((await call("GET", "/accounting/settings", "admin")).body)).not.toContain(KEY);
    const [c] = await db.select().from(companies).where(eq(companies.id, ID.company));
    expect(c.accountingKey).not.toContain(KEY); // encrypted at rest
    const me = (await call("GET", "/auth/me", "crew")).body;
    expect(me.company.accountingKey).toBeUndefined();
    expect(me.company.accounting).toBeUndefined();
    // Saving again without a key keeps it.
    expect((await call("PUT", "/accounting/settings", "owner", settings())).body.hasKey).toBe(true);
  });

  it("an approved pay period is posted as a balanced journal, once", async () => {
    // 10 hours at $20 in the week of Nov 2–8, 2026.
    await call("POST", "/time/clock-in", "crew", {});
    await call("POST", "/time/clock-out", "crew", {});
    const entry = ((await call("GET", "/time/entries", "crew")).body as any[])[0];
    await call("PATCH", `/time/entries/${entry.id}`, "owner", { clockIn: "2026-11-03T14:00:00.000Z", clockOut: "2026-11-04T00:00:00.000Z" });
    const [period] = await db.insert(payPeriods).values({ companyId: ID.company, periodStart: "2026-11-02", periodEnd: "2026-11-08", payday: "2026-11-13" }).returning();
    ID.period = period.id;
    expect((await call("POST", `/pay-periods/${period.id}/approve`, "owner", {})).status).toBe(200);
    await flushAccounting();
    const journal = received.find((r) => r.path === "/api/manual-journals")!;
    expect(journal.body).toMatchObject({ date: "2026-11-08", publish: true, reference: "Payroll 2026-11-02 to 2026-11-08" });
    expect(journal.body.entries).toEqual([
      { index: 1, accountId: 4, debit: 200, note: expect.any(String) },
      { index: 2, accountId: 3, credit: 200, note: expect.any(String) },
    ]);
    const status = (await call("GET", "/accounting/status", "admin")).body;
    expect(status.connected).toBe(true);
    expect(status.payroll[0]).toMatchObject({ id: period.id, posting: { status: "posted", amountCents: 20000, externalId: expect.any(String) }, changedSincePosting: false });
    // Sending again does nothing new.
    const again = await call("POST", `/accounting/payroll/${period.id}`, "admin");
    expect(again.body.status).toBe("posted");
    expect(received.filter((r) => r.path === "/api/manual-journals")).toHaveLength(1);
  });

  it("a completed work order's costs are posted as an expense; failures are recorded and can be retried", async () => {
    const asset = await call("POST", "/assets", "owner", { name: "Truck 7", type: "vehicle" });
    expect(asset.status).toBe(200);
    // Make the payment account wrong: Bigcapital refuses it.
    await call("PUT", "/accounting/settings", "owner", settings({ workOrderPaymentAccountId: 4 }));
    const wo = await call("POST", "/work-orders", "owner", { assetId: asset.body.id, title: "Brake pads", priority: "medium" });
    expect(wo.status).toBe(200);
    ID.wo = wo.body.id;
    await call("PATCH", `/work-orders/${ID.wo}`, "owner", { status: "completed", partsCostCents: 12345, laborCostCents: 8000, vendor: "Main St Garage" });
    await flushAccounting();
    let row = (await call("GET", "/accounting/status", "admin")).body.workOrders.find((w: any) => w.id === ID.wo);
    expect(row.posting).toMatchObject({ status: "failed", error: expect.stringContaining("PAYMENT_ACCOUNT_HAS_INVALID_TYPE") });
    // Fix it and send again.
    await call("PUT", "/accounting/settings", "owner", settings());
    const sent = await call("POST", `/accounting/work-orders/${ID.wo}`, "admin");
    expect(sent.body).toMatchObject({ status: "posted", amountCents: 20345 });
    const expense = received.filter((r) => r.path === "/api/expenses").at(-1)!;
    expect(expense.body).toMatchObject({ paymentAccountId: 2, referenceNo: `WO-${wo.body.number}`, publish: true });
    expect(expense.body.categories).toEqual([
      { index: 1, expenseAccountId: 5, amount: 123.45, description: expect.stringContaining("Parts: Work order") },
      { index: 2, expenseAccountId: 5, amount: 80, description: expect.stringContaining("Labor: Work order") },
    ]);
    expect(expense.body.description).toContain("Truck 7");
    expect(expense.body.description).toContain("Main St Garage");
    // Costs changed after it was sent: flagged.
    await call("PATCH", `/work-orders/${ID.wo}`, "owner", { partsCostCents: 15000 });
    row = (await call("GET", "/accounting/status", "admin")).body.workOrders.find((w: any) => w.id === ID.wo);
    expect(row.changedSincePosting).toBe(true);
  });

  it("nothing is sent when auto-posting is off, or when Bigcapital can't be reached", async () => {
    await call("PUT", "/accounting/settings", "owner", settings({ autoPostWorkOrders: false }));
    const before = received.length;
    const asset = await call("POST", "/assets", "owner", { name: "Mower 2", type: "small_equipment" });
    const wo = await call("POST", "/work-orders", "owner", { assetId: asset.body.id, title: "Blade", priority: "low" });
    await call("PATCH", `/work-orders/${wo.body.id}`, "owner", { status: "completed", partsCostCents: 3000 });
    await flushAccounting();
    expect(received.length).toBe(before);
    await call("PUT", "/accounting/settings", "owner", settings({ baseUrl: "http://127.0.0.1:1" }));
    const res = await call("POST", `/accounting/work-orders/${wo.body.id}`, "admin");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Couldn't reach Bigcapital/);
  });
});

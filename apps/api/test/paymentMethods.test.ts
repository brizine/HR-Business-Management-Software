/** Cards and bank accounts on file: saving (office and portal), default, remove, charging an invoice, autopay, the list filter, webhooks, against a pretend Stripe. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushBillingSync } from "../src/lib/billingSync";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

/* ── A pretend Stripe ── */
const WEBHOOK_SECRET = "whsec_pm_secret";
const suffix = Date.now();
let n = 0;
const calls: { method: string; path: string; form: URLSearchParams }[] = [];
type PM = { id: string; object: "payment_method"; type: string; card?: object; us_bank_account?: object; customer?: string | null };
const PMS: Record<string, PM> = {
  pm_visa: { id: "pm_visa", object: "payment_method", type: "card", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 } },
  pm_declines: { id: "pm_declines", object: "payment_method", type: "card", card: { brand: "mastercard", last4: "0341", exp_month: 1, exp_year: 2032 } },
  pm_bank: { id: "pm_bank", object: "payment_method", type: "us_bank_account", us_bank_account: { bank_name: "Arvest Bank", account_type: "checking", last4: "6789" } },
};
const setups = new Map<string, { id: string; status: string; metadata: Record<string, string>; pm: string | null; customer: string; types: string[] }>();
const intents = new Map<string, { id: string; amount: number; status: string; metadata: Record<string, string>; pm: string; setup_future_usage?: string }>();
let server: Server;

const meta = (form: URLSearchParams) => { const m: Record<string, string> = {}; for (const [k, v] of form) { const x = k.match(/^metadata\[(.+)\]$/); if (x) m[x[1]] = v; } return m; };
function piBody(pi: { id: string; amount: number; status: string; metadata: Record<string, string>; pm: string; setup_future_usage?: string }) {
  const charge = pi.status === "succeeded" ? { id: `ch_${pi.id}`, object: "charge", balance_transaction: { id: `txn_${pi.id}`, object: "balance_transaction", fee: 100 } } : null;
  return { id: pi.id, object: "payment_intent", amount: pi.amount, amount_received: pi.status === "succeeded" ? pi.amount : 0, status: pi.status, metadata: pi.metadata, payment_method: PMS[pi.pm] ?? null, latest_charge: charge, setup_future_usage: pi.setup_future_usage ?? null, client_secret: `${pi.id}_secret` };
}

function fakeStripe() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const form = new URLSearchParams(req.method === "GET" ? url.search : raw);
      calls.push({ method: req.method!, path: url.pathname, form });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "request-id": `req_${++n}` }); res.end(JSON.stringify(data)); };
      const p = url.pathname;
      if (req.method === "GET" && p === "/v1/account") return send(200, { id: "acct_1", object: "account", business_profile: { name: "Lawn (test)" } });
      if (req.method === "GET" && p === "/v1/webhook_endpoints") return send(200, { object: "list", data: [], has_more: false });
      if (req.method === "POST" && p === "/v1/webhook_endpoints") return send(200, { id: `we_${++n}`, object: "webhook_endpoint", secret: WEBHOOK_SECRET });
      if (req.method === "POST" && p === "/v1/customers") return send(200, { id: `cus_${suffix}_${++n}`, object: "customer" });
      if (req.method === "POST" && p === "/v1/setup_intents") {
        const si = { id: `seti_${suffix}x${++n}`, status: "requires_payment_method", metadata: meta(form), pm: null, customer: form.get("customer")!, types: [...form].filter(([k]) => k.startsWith("allowed_payment_method_types[")).map(([, v]) => v) };
        setups.set(si.id, si);
        return send(200, { id: si.id, object: "setup_intent", status: si.status, client_secret: `${si.id}_secret`, metadata: si.metadata });
      }
      if (req.method === "GET" && p.startsWith("/v1/setup_intents/")) {
        const si = setups.get(p.split("/")[3]);
        if (!si) return send(404, { error: { type: "invalid_request_error", message: "No such setup_intent" } });
        return send(200, { id: si.id, object: "setup_intent", status: si.status, metadata: si.metadata, payment_method: si.pm ? { ...PMS[si.pm], customer: si.customer } : null });
      }
      if (req.method === "POST" && /^\/v1\/payment_methods\/[^/]+\/detach$/.test(p)) {
        const id = p.split("/")[3];
        return PMS[id] ? send(200, { ...PMS[id], customer: null }) : send(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such PaymentMethod" } });
      }
      if (req.method === "POST" && p === "/v1/payment_intents") {
        const pm = form.get("payment_method") ?? "pm_visa";
        const pi = { id: `pi_${suffix}x${++n}`, amount: Number(form.get("amount")), status: "requires_payment_method", metadata: meta(form), pm, setup_future_usage: form.get("setup_future_usage") ?? undefined };
        if (form.get("confirm") === "true") {
          if (pm === "pm_declines") return send(402, { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.", payment_intent: { ...piBody({ ...pi, status: "requires_payment_method" }) } } });
          pi.status = PMS[pm]?.type === "us_bank_account" ? "processing" : "succeeded";
        }
        intents.set(pi.id, pi);
        return send(200, piBody(pi));
      }
      if (req.method === "GET" && p.startsWith("/v1/payment_intents/")) {
        const pi = intents.get(p.split("/")[3]);
        return pi ? send(200, piBody(pi)) : send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
      }
      send(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${req.method}: ${p})` } });
    });
  });
}

let app: FastifyInstance;
const email = (x: string) => `${x}-${suffix}@pm.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
let companyId = "";

async function call(method: string, url: string, who: string | null, payload?: unknown, cookie?: string) {
  const headers: Record<string, string> = cookie ? { "x-crewdesk-client": "web" } : {};
  if (who) headers.authorization = `Bearer ${T[who]}`;
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers, cookies: cookie ? { crewdesk_portal: cookie } : undefined });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, cookies: res.cookies };
}
async function webhook(type: string, object: unknown) {
  const payload = JSON.stringify({ id: `evt_${++n}`, object: "event", type, data: { object } });
  const header = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return (await app.inject({ method: "POST", url: `/stripe/webhook/${companyId}`, payload, headers: { "content-type": "application/json", "stripe-signature": header } })).statusCode;
}
async function signInPortal(addr: string) {
  sent.length = 0;
  await db.execute(sql`delete from portal_codes where email = ${addr}`);
  await call("POST", "/portal/start", null, { email: addr, companyId });
  const code = sent.find((m) => m.to === addr)!.subject.match(/^(\d{6})/)![1];
  const v = await call("POST", "/portal/verify", null, { email: addr, code, companyId });
  return v.cookies.find((c) => c.name === "crewdesk_portal")!.value;
}
async function sentInvoice(customerId: string, cents: number) {
  const inv = await call("POST", "/invoices", "owner", { customerId, lines: [{ description: "Lawn service", quantity: 1, unitPriceCents: cents }] });
  const s = await call("POST", `/invoices/${inv.body.id}/send`, "owner", { via: ["paper"] });
  return { id: inv.body.id as string, send: s.body };
}
const listNames = async (filters: unknown) => (await call("GET", `/customers?status=all&filters=${encodeURIComponent(JSON.stringify(filters))}`, "office")).body.rows.map((r: any) => r.name).sort();

beforeAll(async () => {
  server = fakeStripe();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  process.env.STRIPE_API_HOST = "127.0.0.1";
  process.env.STRIPE_API_PORT = String(typeof addr === "object" && addr ? addr.port : 0);
  process.env.STRIPE_API_PROTOCOL = "http";
  process.env.PUBLIC_API_URL = "https://crew.example.test/api";
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Card Co", firstName: "Cara", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Card Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@pm.test", timezone: "America/Chicago" });
  companyId = (await call("GET", "/auth/me", "owner")).body.company.id;
  await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" });
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  ID.ann = (await call("POST", "/customers", "owner", { firstName: "Ann", lastName: "Apple", email: email("ann") })).body.id;
  ID.bob = (await call("POST", "/customers", "owner", { firstName: "Bob", lastName: "Berry", email: email("bob") })).body.id;
  ID.cat = (await call("POST", "/customers", "owner", { firstName: "Cat", lastName: "Cole", email: email("cat") })).body.id;
});

afterAll(async () => {
  setEmailTransport(null);
  for (const k of ["STRIPE_API_HOST", "STRIPE_API_PORT", "STRIPE_API_PROTOCOL", "PUBLIC_API_URL"]) delete process.env[k];
  await flushBillingSync();
  await app.close();
  await flushNotifications();
  await pool.end();
  server.close();
});

describe("cards and bank accounts on file", () => {
  it("needs Stripe connected", async () => {
    expect((await call("GET", `/customers/${ID.ann}/payment-methods`, "office")).body).toMatchObject({ stripe: null, methods: [], autopay: false });
    expect((await call("POST", `/customers/${ID.ann}/payment-methods/setup`, "office")).status).toBe(400);
    expect((await call("PUT", "/stripe/settings", "owner", { publishableKey: "pk_test_abcdefghij", secretKey: "sk_test_good" })).status).toBe(200);
  });

  it("office saves a card (cards only); the first is the default; autopay needs one", async () => {
    expect((await call("PUT", `/customers/${ID.ann}/autopay`, "office", { on: true })).status).toBe(400);
    const s = await call("POST", `/customers/${ID.ann}/payment-methods/setup`, "office");
    expect(s.body.clientSecret).toMatch(/^seti_/);
    const si = setups.get(s.body.setupIntentId)!;
    expect(si.types).toEqual(["card"]);
    // Not finished yet: nothing saved.
    expect((await call("POST", `/customers/${ID.ann}/payment-methods/finish`, "office", { setupIntentId: si.id })).body).toMatchObject({ status: "requires_payment_method", method: null });
    si.status = "succeeded"; si.pm = "pm_visa";
    const f = await call("POST", `/customers/${ID.ann}/payment-methods/finish`, "office", { setupIntentId: si.id });
    expect(f.body.method).toMatchObject({ label: "Visa ·· 4242", isDefault: true, addedBy: "office", expMonth: 4, expYear: 2031 });
    // Someone else's setup can't be finished on this customer.
    expect((await call("POST", `/customers/${ID.bob}/payment-methods/finish`, "office", { setupIntentId: si.id })).status).toBe(404);
    expect((await call("PUT", `/customers/${ID.ann}/autopay`, "office", { on: true })).body).toEqual({ ok: true, autopay: true });
  });

  it("charges an invoice to the card on file; a decline says why", async () => {
    const { id } = await sentInvoice(ID.ann, 5000);
    // Autopay already paid it on send.
    const inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv.status).toBe("paid");
    const pi = calls.filter((c) => c.path === "/v1/payment_intents" && c.method === "POST").at(-1)!;
    expect(pi.form.get("off_session")).toBe("true");
    expect(pi.form.get("metadata[autopay]")).toBe("1");
    expect(sent.some((m) => /Payment received/.test(m.subject) && m.to === email("ann"))).toBe(true);
    // Nothing owed now.
    expect((await call("POST", `/invoices/${id}/charge`, "office", {})).status).toBe(400);
    // Bob: no card on file.
    const bob = await sentInvoice(ID.bob, 3000);
    expect((await call("POST", `/invoices/${bob.id}/charge`, "office", {})).body.error).toMatch(/no card or bank account on file/);
  });

  it("portal: save a bank account, save-for-next-time when paying, default, remove; staff viewing can't change them", async () => {
    const cookie = await signInPortal(email("bob"));
    const s = await call("POST", `/portal/customers/${ID.bob}/payment-methods/setup`, null, {}, cookie);
    const si = setups.get(s.body.setupIntentId)!;
    expect(si.types).toEqual(["card", "us_bank_account"]);
    expect((await call("POST", `/portal/customers/${ID.ann}/payment-methods/setup`, null, {}, cookie)).status).toBe(404);
    si.status = "succeeded"; si.pm = "pm_bank";
    // The webhook saves it even if the browser never comes back.
    expect(await webhook("setup_intent.succeeded", { id: si.id, object: "setup_intent", metadata: si.metadata })).toBe(200);
    let me = (await call("GET", "/portal/me", null, undefined, cookie)).body;
    expect(me.customers[0].paymentMethods).toMatchObject([{ label: "Arvest Bank checking ·· 6789", isDefault: true, type: "ach" }]);
    // Paying an invoice with "save for next time".
    const { id } = await sentInvoice(ID.bob, 2000);
    const pay = await call("POST", `/portal/invoices/${id}/pay`, null, { save: true }, cookie);
    const pi = intents.get(pay.body.paymentIntentId)!;
    expect(pi.setup_future_usage).toBe("off_session");
    pi.status = "succeeded"; pi.pm = "pm_declines";
    await call("POST", `/portal/invoices/${id}/pay/confirm`, null, { paymentIntentId: pi.id }, cookie);
    me = (await call("GET", "/portal/me", null, undefined, cookie)).body;
    expect(me.customers[0].paymentMethods.map((m: any) => m.label)).toEqual(["Arvest Bank checking ·· 6789", "Mastercard ·· 0341"]);
    const card = me.customers[0].paymentMethods[1];
    expect((await call("POST", `/portal/customers/${ID.bob}/payment-methods/${card.id}/default`, null, {}, cookie)).status).toBe(200);
    expect((await call("PUT", `/portal/customers/${ID.bob}/autopay`, null, { on: true }, cookie)).body.autopay).toBe(true);
    // A charge on the default (the card that declines) fails with the reason; the bank account works and is "on its way".
    const owed = await sentInvoice(ID.bob, 4500);
    expect(owed.send.autopay).toMatchObject({ ok: false });
    expect(owed.send.autopay.error).toMatch(/Mastercard ·· 0341: Declined: not enough funds/);
    const after = (await call("GET", `/invoices/${owed.id}`, "office")).body;
    expect(after.autopayError).toMatch(/not enough funds/);
    const methods = (await call("GET", `/customers/${ID.bob}/payment-methods`, "office")).body.methods;
    const bank = methods.find((m: any) => m.type === "ach");
    const charged = await call("POST", `/invoices/${owed.id}/charge`, "office", { methodId: bank.id });
    expect(charged.body).toMatchObject({ status: "pending", method: "Arvest Bank checking ·· 6789", amountCents: 4500 });
    expect((await call("POST", `/invoices/${owed.id}/charge`, "office", { methodId: bank.id })).body.error).toMatch(/already on its way/);
    // Remove the card: the bank account becomes the default again.
    expect((await call("DELETE", `/portal/customers/${ID.bob}/payment-methods/${card.id}`, null, undefined, cookie)).status).toBe(200);
    me = (await call("GET", "/portal/me", null, undefined, cookie)).body;
    expect(me.customers[0].paymentMethods).toMatchObject([{ type: "ach", isDefault: true }]);
  });

  it("detached in Stripe: forgotten here, and autopay stops with nothing left", async () => {
    expect(await webhook("payment_method.detached", { id: "pm_bank", object: "payment_method" })).toBe(200);
    const r = (await call("GET", `/customers/${ID.bob}/payment-methods`, "office")).body;
    expect(r).toMatchObject({ methods: [], autopay: false });
  });

  it("list filters and columns: payment method on file, autopay", async () => {
    expect(await listNames([{ f: "paymentOnFile", op: "is", v: ["card"] }])).toEqual(["Ann Apple"]);
    expect(await listNames([{ f: "paymentOnFile", op: "is", v: ["none"] }])).toEqual(["Bob Berry", "Cat Cole"]);
    expect(await listNames([{ f: "paymentOnFile", op: "isnot", v: ["none"] }])).toEqual(["Ann Apple"]);
    expect(await listNames([{ f: "autopay", op: "yes" }])).toEqual(["Ann Apple"]);
    const row = (await call("GET", "/customers?status=all&q=Apple", "office")).body.rows[0];
    expect(row).toMatchObject({ autopay: true, onFile: "card|visa|||4242" });
    // Office removes Ann's card.
    const m = (await call("GET", `/customers/${ID.ann}/payment-methods`, "office")).body.methods[0];
    expect((await call("DELETE", `/customers/${ID.ann}/payment-methods/${m.id}`, "office")).status).toBe(200);
    expect(await listNames([{ f: "autopay", op: "yes" }])).toEqual([]);
  });
});

/** Deposits on estimates: who needs one, paying it online as they accept (a prepayment), and the office's deposit link. Against a pretend Stripe. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { estimates, prepayments } from "../src/db/schema";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushBillingSync } from "../src/lib/billingSync";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

/* ── A pretend Stripe (just what deposits use) ── */
type PI = { id: string; amount: number; metadata: Record<string, string>; status: string; pmType: "card" | "us_bank_account" };
const intents = new Map<string, PI>();
let n = 0;
let server: Server;
const suffix = Date.now();
function fakeStripe() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const form = new URLSearchParams(req.method === "GET" ? url.search : raw);
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "request-id": `req_${++n}` }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== "Bearer sk_test_good") return send(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
      const p = url.pathname;
      if (req.method === "GET" && p === "/v1/account") return send(200, { id: "acct_1", object: "account", business_profile: { name: "Deposits (test)" } });
      if (req.method === "GET" && p === "/v1/webhook_endpoints") return send(200, { object: "list", data: [], has_more: false });
      if (req.method === "POST" && p === "/v1/webhook_endpoints") return send(200, { id: `we_${++n}`, object: "webhook_endpoint", url: form.get("url"), secret: "whsec_x" });
      if (req.method === "DELETE" && p.startsWith("/v1/webhook_endpoints/")) return send(200, { id: p.split("/")[3], deleted: true });
      if (req.method === "POST" && p === "/v1/customers") return send(200, { id: `cus_${++n}`, object: "customer" });
      if (req.method === "POST" && p === "/v1/payment_intents") {
        const metadata: Record<string, string> = {};
        for (const [k, v] of form) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const pi: PI = { id: `pi_${suffix}x${++n}`, amount: Number(form.get("amount")), metadata, status: "requires_payment_method", pmType: "card" };
        intents.set(pi.id, pi);
        return send(200, { ...pi, object: "payment_intent", client_secret: `${pi.id}_secret_x` });
      }
      if (req.method === "GET" && p.startsWith("/v1/payment_intents/")) {
        const pi = intents.get(p.split("/")[3]);
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        const pm = pi.pmType === "card" ? { id: "pm_1", object: "payment_method", type: "card", card: { brand: "visa", last4: "4242" } }
          : { id: "pm_2", object: "payment_method", type: "us_bank_account", us_bank_account: { bank_name: "Arvest Bank", last4: "6789" } };
        const charge = pi.status === "succeeded" ? { id: "ch_1", object: "charge", balance_transaction: { id: "txn_1", object: "balance_transaction", fee: 610 } } : null;
        return send(200, { ...pi, object: "payment_intent", amount_received: pi.status === "succeeded" ? pi.amount : 0, payment_method: pm, latest_charge: charge });
      }
      send(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${req.method}: ${p})` } });
    });
  });
}

let app: FastifyInstance;
const email = (x: string) => `${x}-${suffix}@deposit.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];

async function call(method: string, url: string, who: string | null, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
/** A sent estimate: $600 of work plus an optional $200 line. Returns its id, token and the optional line's id. */
async function sentEstimate(customerId: string, extra: Record<string, unknown> = {}) {
  const e = await call("POST", "/estimates", "office", {
    customerId, title: "Spring program", ...extra,
    lines: [{ description: "Fertilizer program", quantity: 1, unitPriceCents: 60000 }, { description: "Aeration", quantity: 1, unitPriceCents: 20000, optional: true, selected: false }],
  });
  expect(e.status).toBe(200);
  expect((await call("POST", `/estimates/${e.body.id}/send`, "office", {})).status).toBe(200);
  const [row] = await db.select().from(estimates).where(eq(estimates.id, e.body.id));
  return { id: e.body.id as string, token: row.token!, optional: e.body.lines[1].id as string };
}
const latestNote = async () => {
  await flushNotifications();
  const items = (await call("GET", "/notifications", "office")).body;
  return (items.items ?? items)[0];
};

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
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Deposit Co", firstName: "Dana", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Deposit Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@deposit.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" });
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  const mk = async (b: Record<string, unknown>) => (await call("POST", "/customers", "office", b)).body.id as string;
  ID.newbie = await mk({ firstName: "Nina", lastName: "New", email: email("nina") });
  ID.regular = await mk({ firstName: "Rob", lastName: "Regular", email: email("rob") });
  // Rob has had an invoice, so he isn't new.
  const inv = await call("POST", "/invoices", "office", { customerId: ID.regular, lines: [{ description: "Mowing", quantity: 1, unitPriceCents: 5000 }] });
  await call("POST", `/invoices/${inv.body.id}/send`, "office", { via: ["paper"] });
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

describe("estimate deposits", () => {
  it("admins set who needs one (here: new customers, 25% from $500)", async () => {
    const rule = { requireFor: "new", minTotalCents: 50000, kind: "percent", value: 25 };
    expect((await call("PUT", "/invoices/settings/estimate-deposit", "office", rule)).status).toBe(403);
    expect((await call("PUT", "/invoices/settings/estimate-deposit", "owner", { ...rule, value: 0 })).status).toBe(400);
    expect((await call("PUT", "/invoices/settings/estimate-deposit", "owner", rule)).status).toBe(200);
    expect((await call("GET", "/invoices/settings", "owner")).body.estimateDeposit).toMatchObject(rule);
  });

  it("without online payments, a new customer accepts and the office is told to collect it", async () => {
    const e = await sentEstimate(ID.newbie);
    const pub = (await call("GET", `/public/estimates/${e.token}`, null)).body;
    expect(pub.estimate.deposit).toMatchObject({ cents: 15000, status: "due", online: false, rule: { kind: "percent", value: 25 } });
    expect((await call("POST", `/public/estimates/${e.token}/deposit`, null, { name: "Nina New" })).status).toBe(400);
    const r = await call("POST", `/public/estimates/${e.token}/respond`, null, { action: "accept", name: "Nina New", selectedLineIds: [] });
    expect(r.status).toBe(200);
    expect((await latestNote()).body).toMatch(/A \$150\.00 deposit is due/);
  });

  it("with Stripe: accepting needs the deposit; paying it accepts with what they chose", async () => {
    expect((await call("PUT", "/stripe/settings", "owner", { publishableKey: "pk_test_abcdefghij", secretKey: "sk_test_good" })).status).toBe(200);
    const e = await sentEstimate(ID.newbie);
    const no = await call("POST", `/public/estimates/${e.token}/respond`, null, { action: "accept", name: "Nina New", selectedLineIds: [e.optional] });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/\$200\.00 deposit is needed/);
    // They add aeration: 25% of $800.
    const start = await call("POST", `/public/estimates/${e.token}/deposit`, null, { name: "Nina New", comment: "Gate code 1234", selectedLineIds: [e.optional] });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ amountCents: 20000, publishableKey: "pk_test_abcdefghij" });
    expect(start.body.clientSecret).toMatch(/_secret_/);
    const pi = intents.get(start.body.paymentIntentId)!;
    expect(pi.metadata.crewdeskPrepaymentId).toBe(start.body.prepaymentId);
    // Not accepted until it's paid.
    expect((await call("GET", `/estimates/${e.id}`, "office")).body).toMatchObject({ status: "sent", deposit: { status: "requested", cents: 20000 } });
    pi.status = "succeeded";
    const done = await call("POST", `/public/estimates/${e.token}/deposit/confirm`, null, { paymentIntentId: pi.id });
    expect(done.status).toBe(200);
    expect(done.body.estimate).toMatchObject({ status: "accepted", responseName: "Nina New", responseComment: "Gate code 1234", totalCents: 80000 });
    expect(done.body.estimate.deposit).toMatchObject({ status: "paid", cents: 20000 });
    const office = (await call("GET", `/estimates/${e.id}`, "office")).body;
    expect(office.chosenLineIds).toEqual([e.optional]);
    const [pp] = await db.select().from(prepayments).where(eq(prepayments.estimateId, e.id));
    expect(pp).toMatchObject({ status: "open", amountCents: 20000, customerId: ID.newbie, useNow: false, method: "card" });
    expect((await latestNote()).title).toMatch(/accepted \(\$800\.00\) estimate \d+ and paid a \$200\.00 deposit \(PP-\d+\)/);
    // Confirming again changes nothing.
    expect((await call("POST", `/public/estimates/${e.token}/deposit/confirm`, null, { paymentIntentId: pi.id })).body.estimate.status).toBe("accepted");
  });

  it("a bank payment that's clearing accepts it too; customers who aren't new, or small estimates, need none", async () => {
    const e = await sentEstimate(ID.newbie);
    const start = await call("POST", `/public/estimates/${e.token}/deposit`, null, { name: "Nina New", selectedLineIds: [] });
    expect(start.body.amountCents).toBe(15000);
    const pi = intents.get(start.body.paymentIntentId)!;
    pi.status = "processing"; pi.pmType = "us_bank_account";
    const done = await call("POST", `/public/estimates/${e.token}/deposit/confirm`, null, { paymentIntentId: pi.id });
    expect(done.body.estimate).toMatchObject({ status: "accepted", deposit: { status: "clearing" } });

    const rob = await sentEstimate(ID.regular);
    expect((await call("GET", `/public/estimates/${rob.token}`, null)).body.estimate.deposit).toBeNull();
    expect((await call("POST", `/public/estimates/${rob.token}/respond`, null, { action: "accept", name: "Rob", selectedLineIds: [] })).status).toBe(200);

    const small = await call("POST", "/estimates", "office", { customerId: ID.newbie, lines: [{ description: "Weed control", quantity: 1, unitPriceCents: 9000 }] });
    expect(small.body.deposit).toMatchObject({ cents: 0, status: "none" });
  });

  it("an estimate can have its own deposit or none; the office can send a deposit link after a phone yes", async () => {
    const own = await sentEstimate(ID.regular, { depositMode: "custom", depositKind: "amount", depositValue: 10000 });
    expect((await call("GET", `/estimates/${own.id}`, "office")).body).toMatchObject({ depositMode: "custom", depositKind: "amount", depositValue: 10000, deposit: { cents: 10000 } });
    expect((await call("POST", `/estimates/${own.id}/deposit-link`, "office", {})).status).toBe(400);
    expect((await call("POST", `/estimates/${own.id}/respond`, "office", { action: "accept", selectedLineIds: [] })).status).toBe(200);
    sent.length = 0;
    const link = await call("POST", `/estimates/${own.id}/deposit-link`, "office", {});
    expect(link.status).toBe(200);
    expect(link.body.emailedTo).toBe(email("rob"));
    expect(sent.find((m) => m.to === email("rob"))!.text).toMatch(/\/prepay\/[A-Za-z0-9_-]+/);
    const [pp] = await db.select().from(prepayments).where(eq(prepayments.id, link.body.prepaymentId));
    expect(pp).toMatchObject({ status: "requested", amountCents: 10000, estimateId: own.id });

    const none = await sentEstimate(ID.newbie, { depositMode: "none" });
    expect((await call("GET", `/public/estimates/${none.token}`, null)).body.estimate.deposit).toBeNull();
    expect((await call("POST", "/estimates", "office", { customerId: ID.newbie, depositMode: "custom", lines: [{ description: "x", quantity: 1, unitPriceCents: 100 }] })).status).toBe(400);
  });
});

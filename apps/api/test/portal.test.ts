/** Stripe keys, pay links, card and bank payments (webhook and return), and the customer portal, against a pretend Stripe. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { companies, invoicePayments, invoices, paymentRefunds } from "../src/db/schema";
import { WEBHOOK_EVENTS_VERSION, checkPendingStripePayments, checkRecentRefunds, updateWebhookEvents } from "../src/lib/stripe";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushBillingSync } from "../src/lib/billingSync";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

/* ── A pretend Stripe ── */
const WEBHOOK_SECRET = "whsec_pretend_secret";
type PI = { id: string; amount: number; metadata: Record<string, string>; status: string; customer?: string; pmType: "card" | "us_bank_account"; description?: string };
const intents = new Map<string, PI>();
const calls: { method: string; path: string; form: URLSearchParams }[] = [];
let n = 0;
let server: Server;

function fakeStripe() {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const form = new URLSearchParams(req.method === "GET" ? url.search : raw);
      calls.push({ method: req.method!, path: url.pathname, form });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "request-id": `req_${++n}` }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== "Bearer sk_test_good") return send(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
      const p = url.pathname;
      if (req.method === "GET" && p === "/v1/account") return send(200, { id: "acct_1", object: "account", business_profile: { name: "ProSpray (test)" }, email: "owner@example.com" });
      if (req.method === "GET" && p === "/v1/webhook_endpoints") return send(200, { object: "list", data: [], has_more: false });
      if (req.method === "POST" && p === "/v1/webhook_endpoints") return send(200, { id: `we_${++n}`, object: "webhook_endpoint", url: form.get("url"), secret: WEBHOOK_SECRET });
      if (req.method === "DELETE" && p.startsWith("/v1/webhook_endpoints/")) return send(200, { id: p.split("/")[3], deleted: true });
      if (req.method === "POST" && p === "/v1/customers") return send(200, { id: `cus_${++n}`, object: "customer", email: form.get("email") });
      if (req.method === "POST" && p === "/v1/payment_intents") {
        const metadata: Record<string, string> = {};
        for (const [k, v] of form) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const pi: PI = { id: `pi_${suffix}x${++n}`, amount: Number(form.get("amount")), metadata, status: "requires_payment_method", customer: form.get("customer") ?? undefined, pmType: "card", description: form.get("description") ?? undefined };
        intents.set(pi.id, pi);
        return send(200, { ...pi, object: "payment_intent", client_secret: `${pi.id}_secret_x` });
      }
      if (req.method === "GET" && p.startsWith("/v1/payment_intents/")) {
        const pi = intents.get(p.split("/")[3]);
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        const pm = pi.pmType === "card"
          ? { id: "pm_1", object: "payment_method", type: "card", card: { brand: "visa", last4: "4242" } }
          : { id: "pm_2", object: "payment_method", type: "us_bank_account", us_bank_account: { bank_name: "Arvest Bank", account_type: "checking", last4: "6789" } };
        const charge = pi.status === "succeeded" ? { id: "ch_1", object: "charge", balance_transaction: { id: "txn_1", object: "balance_transaction", fee: pi.pmType === "card" ? Math.round(pi.amount * 0.029) + 30 : 500 } } : null;
        return send(200, { ...pi, object: "payment_intent", amount_received: pi.status === "succeeded" ? pi.amount : 0, payment_method: pm, latest_charge: charge });
      }
      if (req.method === "POST" && p.startsWith("/v1/webhook_endpoints/")) return send(200, { id: p.split("/")[3], object: "webhook_endpoint", enabled_events: form.getAll("enabled_events[]") });
      if (req.method === "POST" && p === "/v1/refunds") {
        const pi = intents.get(form.get("payment_intent") ?? "");
        if (!pi) return send(404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
        const metadata: Record<string, string> = {};
        for (const [k, v] of form) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
        const done = [...refunds.values()].filter((r) => r.payment_intent === pi.id && r.status !== "failed").reduce((s, r) => s + r.amount, 0);
        const amount = Number(form.get("amount") ?? pi.amount - done);
        if (amount > pi.amount - done) return send(400, { error: { type: "invalid_request_error", message: "Refund amount is greater than unrefunded amount on charge" } });
        return send(200, addRefund(pi.id, amount, { reason: form.get("reason"), metadata }));
      }
      if (req.method === "GET" && p === "/v1/refunds") {
        const forPi = form.get("payment_intent"), since = Number(form.get("created[gte]") ?? 0);
        const data = [...refunds.values()].filter((r) => (!forPi || r.payment_intent === forPi) && r.created >= since);
        return send(200, { object: "list", url: "/v1/refunds", has_more: false, data });
      }
      send(404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${req.method}: ${p})` } });
    });
  });
}

type Refund = { id: string; object: "refund"; amount: number; payment_intent: string; status: string; reason: string | null; metadata: Record<string, string>; created: number };
const refunds = new Map<string, Refund>();
/** A refund as Stripe would hold it (card refunds succeed at once; bank refunds start pending). */
function addRefund(piId: string, amount: number, o: { reason?: string | null; metadata?: Record<string, string> } = {}) {
  const r: Refund = { id: `re_${suffix}x${++n}`, object: "refund", amount, payment_intent: piId, status: intents.get(piId)?.pmType === "us_bank_account" ? "pending" : "succeeded", reason: o.reason ?? null, metadata: o.metadata ?? {}, created: Math.floor(Date.now() / 1000) };
  refunds.set(r.id, r);
  return r;
}

let app: FastifyInstance;
const suffix = Date.now();
const email = (x: string) => `${x}-${suffix}@portal.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
let companyId = "";

async function call(method: string, url: string, who: string | null, payload?: unknown, extra: { cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(extra.headers ?? {}) };
  if (who) headers.authorization = `Bearer ${T[who]}`;
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers, cookies: extra.cookie ? { crewdesk_portal: extra.cookie } : undefined });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, headers: res.headers, cookies: res.cookies };
}
/** As a customer in the portal (cookie + the web client header). */
const portal = (method: string, url: string, cookie: string, payload?: unknown) => call(method, url, null, payload, { cookie, headers: { "x-crewdesk-client": "web" } });
const codeIn = (m: EmailMessage) => m.subject.match(/^(\d{6}) is your/)?.[1];

async function signInPortal(addr: string) {
  sent.length = 0;
  await db.execute(sql`delete from portal_codes where email = ${addr}`);
  const s = await call("POST", "/portal/start", null, { email: addr, companyId });
  expect(s.status).toBe(200);
  const code = codeIn(sent.find((m) => m.to === addr)!)!;
  const v = await call("POST", "/portal/verify", null, { email: addr, code, companyId });
  expect(v.status).toBe(200);
  return v.cookies.find((c) => c.name === "crewdesk_portal")!.value;
}

async function sentInvoice(customerId: string, cents: number, via: string[] = ["email"]) {
  const inv = await call("POST", "/invoices", "owner", { customerId, issueDate: "2026-03-02", dueDate: "2026-03-17", lines: [{ description: "Fertilizer & weed control", quantity: 1, unitPriceCents: cents }] });
  const s = await call("POST", `/invoices/${inv.body.id}/send`, "owner", { via });
  expect(s.status).toBe(200);
  return inv.body.id as string;
}
const tokenOf = async (invoiceId: string) => (await db.select({ t: invoices.payToken }).from(invoices).where(eq(invoices.id, invoiceId)))[0].t!;

async function webhook(type: string, piId: string, secret = WEBHOOK_SECRET, object?: unknown) {
  const payload = JSON.stringify({ id: `evt_${++n}`, object: "event", type, data: { object: object ?? { id: piId, object: "payment_intent" } } });
  const header = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload, secret });
  const res = await app.inject({ method: "POST", url: `/stripe/webhook/${companyId}`, payload, headers: { "content-type": "application/json", "stripe-signature": header } });
  return res.statusCode;
}

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
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Portal Co", firstName: "Pia", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Portal Co", addressLine1: "1601 Deskin Dr", city: "Norman", state: "OK", zip: "73069", phone: "(405) 447-4390", email: "office@portal.test", timezone: "America/Chicago" });
  companyId = (await call("GET", "/auth/me", "owner")).body.company.id;
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  ID.pat = (await call("POST", "/customers", "owner", {
    firstName: "Pat", lastName: "Payer", email: email("pat"), phone: "4055550111", billingStreet: "5 Elm St", billingCity: "Norman", billingZip: "73069",
    contacts: [{ name: "Sam Payer", relation: "Spouse", email: email("sam"), getsInvoices: true }, { name: "Neighbor", email: email("nope"), getsInvoices: false }],
    property: { street: "5 Elm St", city: "Norman", zip: "73069", lawnSqFt: 8000 },
  })).body.id;
  ID.other = (await call("POST", "/customers", "owner", { firstName: "Olive", lastName: "Other", email: email("olive"), property: { street: "9 Ash St", city: "Norman", zip: "73069" } })).body.id;
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

describe("Stripe keys", () => {
  it("checks the keys, saves them encrypted, makes the webhook, and never shows the secret", async () => {
    expect((await call("GET", "/stripe/settings", "owner")).body).toEqual({ connected: false });
    expect((await call("GET", "/stripe/settings", "office")).status).toBe(403);
    expect((await call("PUT", "/stripe/settings", "office", { publishableKey: "pk_test_abcdefghij", secretKey: "sk_test_good" })).status).toBe(403);
    const bad = [
      [{ publishableKey: "sk_test_good123", secretKey: "sk_test_good" }, /publishable key/],
      [{ publishableKey: "pk_test_abcdefghij", secretKey: "pk_test_abcdefghij" }, /secret key/],
      [{ publishableKey: "pk_live_abcdefghij", secretKey: "sk_test_good" }, /test keys, or both live/],
      [{ publishableKey: "pk_test_abcdefghij", secretKey: "sk_test_wrong" }, /didn't accept/],
    ] as const;
    for (const [body, msg] of bad) {
      const r = await call("PUT", "/stripe/settings", "owner", body);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const ok = await call("PUT", "/stripe/settings", "owner", { publishableKey: "pk_test_abcdefghij", secretKey: "sk_test_good" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ mode: "test", accountName: "ProSpray (test)", webhook: true });
    const made = calls.find((c) => c.method === "POST" && c.path === "/v1/webhook_endpoints")!;
    expect(made.form.get("url")).toBe(`https://crew.example.test/api/stripe/webhook/${companyId}`);
    expect(made.form.getAll("enabled_events[]").length + made.form.getAll("enabled_events[0]").length).toBeGreaterThan(0);
    const s = await call("GET", "/stripe/settings", "owner");
    expect(s.body).toMatchObject({ connected: true, mode: "test", publishableKey: "pk_test_abcdefghij", webhook: true });
    expect(JSON.stringify(s.body)).not.toContain("sk_test");
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row.stripeSecret).not.toContain("sk_test");
    expect(row.stripeWebhookSecret).not.toContain("whsec");
    const me = await call("GET", "/auth/me", "owner");
    expect(JSON.stringify(me.body)).not.toMatch(/sk_test|whsec|stripeSecret/);
  });
});

describe("Pay links and payments", () => {
  it("the invoice email has a pay link (and the PDF says where to pay online)", async () => {
    sent.length = 0;
    ID.inv1 = await sentInvoice(ID.pat, 8500);
    const mail = sent.find((m) => m.to === email("pat"))!;
    const token = await tokenOf(ID.inv1);
    expect(mail.text).toContain(`/pay/${token}`);
    expect(mail.html).toContain("Pay online");
    const staff = await call("GET", `/invoices/${ID.inv1}`, "office");
    expect(staff.body.payLink.url).toMatch(new RegExp(`/pay/${token}$`));
    expect(staff.body.payToken).toBeUndefined();
    expect(staff.body.onlinePayments).toBe(true);
  });

  it("pays by card through the pay link: recorded once, with the card and Stripe's fee, and a receipt", async () => {
    const token = await tokenOf(ID.inv1);
    const view = await call("GET", `/pay/${token}`, null);
    expect(view.status).toBe(200);
    expect(view.body.invoice).toMatchObject({ balanceCents: 8500, customer: { name: "Pat Payer" } });
    expect(view.body.payments).toEqual({ enabled: true, publishableKey: "pk_test_abcdefghij", testMode: true });
    expect((await call("GET", `/pay/${token}/pdf`, null)).headers["content-type"]).toBe("application/pdf");
    const start = await call("POST", `/pay/${token}/pay`, null);
    expect(start.status).toBe(200);
    expect(start.body.amountCents).toBe(8500);
    expect(start.body.clientSecret).toMatch(/_secret_/);
    const pi = intents.get(start.body.paymentIntentId)!;
    expect(pi.metadata).toMatchObject({ crewdeskCompanyId: companyId, crewdeskInvoiceId: ID.inv1 });
    const piCall = calls.find((c) => c.path === "/v1/payment_intents" && c.method === "POST")!;
    expect([...piCall.form.keys()].some((k) => k.startsWith("allowed_payment_method_types") || k.startsWith("payment_method_types"))).toBe(true);
    // Not paid yet: confirming changes nothing.
    expect((await call("POST", `/pay/${token}/confirm`, null, { paymentIntentId: pi.id })).body.status).toBe("failed");
    pi.status = "succeeded";
    sent.length = 0;
    const done = await call("POST", `/pay/${token}/confirm`, null, { paymentIntentId: pi.id });
    expect(done.body).toMatchObject({ status: "completed", invoice: { status: "paid", balanceCents: 0 } });
    expect(sent.find((m) => m.to === email("pat"))?.subject).toMatch(/^Payment received: invoice \d+/);
    // The webhook says the same thing later: still one payment.
    expect(await webhook("payment_intent.succeeded", pi.id)).toBe(200);
    const staff = await call("GET", `/invoices/${ID.inv1}`, "office");
    expect(staff.body.payments).toHaveLength(1);
    expect(staff.body.payments[0]).toMatchObject({ method: "card", methodDetail: "Visa ·· 4242", status: "completed", amountCents: 8500, feeCents: 277 });
    expect((await call("POST", `/pay/${token}/pay`, null)).body.error).toMatch(/already paid/);
  });

  it("a bank payment is pending until it clears (webhook), and a failed one leaves the balance", async () => {
    ID.inv2 = await sentInvoice(ID.pat, 12000, ["paper"]);
    const token = await tokenOf(ID.inv2);
    const start = await call("POST", `/pay/${token}/pay`, null);
    const pi = intents.get(start.body.paymentIntentId)!;
    pi.pmType = "us_bank_account";
    pi.status = "processing";
    const r = await call("POST", `/pay/${token}/confirm`, null, { paymentIntentId: pi.id });
    expect(r.body).toMatchObject({ status: "pending", invoice: { status: "sent", balanceCents: 12000, pendingCents: 12000 } });
    expect((await call("POST", `/pay/${token}/pay`, null)).body.error).toMatch(/already on its way/);
    // Forged webhooks are refused.
    expect(await webhook("payment_intent.succeeded", pi.id, "whsec_wrong")).toBe(400);
    pi.status = "succeeded";
    expect(await webhook("payment_intent.succeeded", pi.id)).toBe(200);
    let staff = await call("GET", `/invoices/${ID.inv2}`, "office");
    // Paid before it was mailed, so it's off the print queue.
    expect(staff.body).toMatchObject({ status: "paid", paidCents: 12000, needsMailing: false });
    expect(staff.body.payments[0]).toMatchObject({ method: "ach", methodDetail: "Arvest Bank checking ·· 6789", status: "completed", feeCents: 500 });

    ID.inv3 = await sentInvoice(ID.pat, 4000, ["paper"]);
    const t3 = await tokenOf(ID.inv3);
    const pi3 = intents.get((await call("POST", `/pay/${t3}/pay`, null)).body.paymentIntentId)!;
    pi3.pmType = "us_bank_account"; pi3.status = "processing";
    expect(await webhook("payment_intent.processing", pi3.id)).toBe(200);
    pi3.status = "requires_payment_method";
    expect(await webhook("payment_intent.payment_failed", pi3.id)).toBe(200);
    staff = await call("GET", `/invoices/${ID.inv3}`, "office");
    expect(staff.body).toMatchObject({ status: "sent", paidCents: 0 });
    expect(staff.body.payments[0].status).toBe("failed");
  });

  it("the hourly check clears a bank payment whose webhook never came", async () => {
    const id = await sentInvoice(ID.pat, 6000, ["paper"]);
    const token = await tokenOf(id);
    const pi = intents.get((await call("POST", `/pay/${token}/pay`, null)).body.paymentIntentId)!;
    pi.pmType = "us_bank_account"; pi.status = "processing";
    await call("POST", `/pay/${token}/confirm`, null, { paymentIntentId: pi.id });
    pi.status = "succeeded";
    await checkPendingStripePayments(); // too new to bother Stripe yet
    expect((await call("GET", `/invoices/${id}`, "office")).body.status).toBe("sent");
    await db.update(invoicePayments).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(invoicePayments.stripePaymentId, pi.id));
    expect(await checkPendingStripePayments()).toBeGreaterThanOrEqual(1);
    expect((await call("GET", `/invoices/${id}`, "office")).body.status).toBe("paid");
  });

  it("pay links stop working when expired or the invoice is void", async () => {
    const id = await sentInvoice(ID.pat, 3000, ["paper"]);
    const token = await tokenOf(id);
    await db.update(invoices).set({ payTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(invoices.id, id));
    expect((await call("GET", `/pay/${token}`, null)).status).toBe(410);
    await call("POST", `/invoices/${id}/send`, "owner", { via: ["paper"] });
    expect((await call("GET", `/pay/${token}`, null)).status).toBe(200);
    await call("POST", `/invoices/${id}/void`, "owner", { reason: "Duplicate" });
    expect((await call("GET", `/pay/${token}`, null)).body.error).toMatch(/cancelled/);
    expect((await call("GET", "/pay/not-a-real-token-at-all-xx", null)).status).toBe(404);
  });
});

describe("Customer portal", () => {
  it("signs in with an emailed code; unknown emails get nothing but the same answer", async () => {
    sent.length = 0;
    const unknown = await call("POST", "/portal/start", null, { email: email("stranger"), companyId });
    expect(unknown.body.ok).toBe(true);
    expect(sent).toHaveLength(0);
    // A contact who doesn't get invoices can't sign in either.
    await call("POST", "/portal/start", null, { email: email("nope"), companyId });
    expect(sent).toHaveLength(0);
    await call("POST", "/portal/start", null, { email: email("PAT").toUpperCase(), companyId });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/\/portal\/sign-in\?link=/);
    const code = codeIn(sent[0])!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await call("POST", "/portal/verify", null, { email: email("pat"), code: wrong, companyId })).body.error).toMatch(/isn't right/);
    expect((await call("POST", "/portal/verify", null, { email: email("pat"), code, companyId })).body.error).toMatch(/Too many tries/);
    ID.cookie = await signInPortal(email("pat"));
  });

  it("the sign-in link works once", async () => {
    sent.length = 0;
    await db.execute(sql`delete from portal_codes where email = ${email("sam")}`);
    await call("POST", "/portal/start", null, { email: email("sam"), companyId });
    const link = decodeURIComponent(sent[0].text.match(/link=([^\s]+)/)![1]);
    const first = await call("POST", "/portal/link", null, { link });
    expect(first.status).toBe(200);
    expect(first.cookies.some((c) => c.name === "crewdesk_portal")).toBe(true);
    expect((await call("POST", "/portal/link", null, { link })).status).toBe(400);
  });

  it("shows the customer's own invoices, balance and payments, and nothing else", async () => {
    const other = await sentInvoice(ID.other, 5000, ["paper"]);
    const draft = (await call("POST", "/invoices", "owner", { customerId: ID.pat, lines: [{ description: "Draft", quantity: 1, unitPriceCents: 100 }] })).body.id;
    const me = await portal("GET", "/portal/me", ID.cookie);
    expect(me.status).toBe(200);
    expect(me.body.company.name).toBe("Portal Co");
    expect(me.body.customers).toHaveLength(1);
    expect(me.body.customers[0]).toMatchObject({ name: "Pat Payer", balanceCents: 4000, properties: [{ address: "5 Elm St, Norman, OK 73069" }] });
    const ids = me.body.invoices.map((i: any) => i.id);
    expect(ids).toEqual(expect.arrayContaining([ID.inv1, ID.inv2, ID.inv3]));
    expect(ids).not.toContain(other);
    expect(ids).not.toContain(draft);
    expect(me.body.payments.enabled).toBe(true);
    expect(me.body.paymentHistory.map((p: any) => p.methodDetail)).toEqual(expect.arrayContaining(["Visa ·· 4242", "Arvest Bank checking ·· 6789"]));
    expect((await portal("GET", `/portal/invoices/${other}`, ID.cookie)).status).toBe(404);
    expect((await portal("GET", `/portal/invoices/${draft}`, ID.cookie)).status).toBe(404);
    const one = await portal("GET", `/portal/invoices/${ID.inv3}`, ID.cookie);
    expect(one.body.invoice).toMatchObject({ balanceCents: 4000, lines: [{ description: "Fertilizer & weed control" }] });
    expect((await portal("GET", `/portal/invoices/${ID.inv3}/pdf`, ID.cookie)).headers["content-type"]).toBe("application/pdf");
    // The spouse (a contact who gets invoices) sees the same account.
    const sam = await signInPortal(email("sam"));
    expect((await portal("GET", "/portal/me", sam)).body.customers[0].id).toBe(ID.pat);
  });

  it("pays from the portal and updates contact details; changes need the web client header", async () => {
    const start = await portal("POST", `/portal/invoices/${ID.inv3}/pay`, ID.cookie);
    expect(start.body.amountCents).toBe(4000);
    const pi = intents.get(start.body.paymentIntentId)!;
    pi.status = "succeeded";
    const done = await portal("POST", `/portal/invoices/${ID.inv3}/pay/confirm`, ID.cookie, { paymentIntentId: pi.id });
    expect(done.body.invoice.status).toBe("paid");
    const noHeader = await call("POST", `/portal/invoices/${ID.inv3}/pay`, null, undefined, { cookie: ID.cookie });
    expect(noHeader.status).toBe(403);
    const upd = await portal("PUT", `/portal/customers/${ID.pat}`, ID.cookie, { phone: "(405) 555-0123", billingStreet: "6 Elm St", billingCity: "Norman", billingState: "ok", billingZip: "73069" });
    expect(upd.status).toBe(200);
    const c = await call("GET", `/customers/${ID.pat}`, "office");
    expect(c.body).toMatchObject({ phone: "(405) 555-0123", billingStreet: "6 Elm St", billingState: "OK" });
    expect((await portal("PUT", `/portal/customers/${ID.other}`, ID.cookie, { phone: "1" })).status).toBe(404);
    expect((await portal("PUT", `/portal/customers/${ID.pat}`, ID.cookie, { billingZip: "7306" })).status).toBe(400);
  });

  it("portal and staff sign-ins can't stand in for each other", async () => {
    expect((await call("GET", "/employees", null, undefined, { headers: { authorization: `Bearer ${ID.cookie}` } })).status).toBe(401);
    expect((await call("GET", "/portal/me", "owner")).status).toBe(401);
    expect((await call("GET", "/portal/me", null, undefined, { cookie: "garbage" })).status).toBe(401);
    const out = await portal("POST", "/portal/sign-out", ID.cookie);
    expect(out.cookies.find((c) => c.name === "crewdesk_portal")?.value).toBe("");
  });

  it("staff can view as a customer (read-only, that customer only)", async () => {
    expect((await call("POST", "/portal/view-as", "tech", { customerId: ID.pat }, { headers: { "x-crewdesk-client": "web" } })).status).toBe(403);
    const r = await call("POST", "/portal/view-as", "office", { customerId: ID.other });
    expect(r.status).toBe(200);
    const cookie = r.cookies.find((c) => c.name === "crewdesk_portal")!.value;
    const me = await portal("GET", "/portal/me", cookie);
    expect(me.body.viewer.staff).toBe(true);
    expect(me.body.customers.map((c: any) => c.id)).toEqual([ID.other]);
    const inv = me.body.invoices[0].id;
    expect((await portal("POST", `/portal/invoices/${inv}/pay`, cookie)).status).toBe(403);
    expect((await portal("PUT", `/portal/customers/${ID.other}`, cookie, { phone: "1" })).status).toBe(403);
    expect((await portal("GET", `/portal/invoices/${ID.inv1}`, cookie)).status).toBe(404);
  });

  it("names the company on the sign-in page; an unknown company is not found", async () => {
    const c = await call("GET", `/portal/company?c=${companyId}`, null);
    expect(c.body).toMatchObject({ company: { name: "Portal Co" }, payments: { enabled: true, testMode: true } });
    expect((await call("GET", "/portal/company?c=00000000-0000-0000-0000-000000000000", null)).status).toBe(404);
  });
});

describe("Refunds", () => {
  /** An invoice paid online in full (card, or a bank payment that has cleared). */
  async function paidOnline(cents: number, pmType: "card" | "us_bank_account" = "card") {
    const id = await sentInvoice(ID.pat, cents, ["paper"]);
    const token = await tokenOf(id);
    const pi = intents.get((await call("POST", `/pay/${token}/pay`, null)).body.paymentIntentId)!;
    pi.pmType = pmType; pi.status = "succeeded";
    await call("POST", `/pay/${token}/confirm`, null, { paymentIntentId: pi.id });
    const inv = (await call("GET", `/invoices/${id}`, "owner")).body;
    expect(inv.status).toBe("paid");
    return { id, pi, paymentId: inv.payments[0].id as string };
  }
  const refundUrl = (id: string, paymentId: string) => `/invoices/${id}/payments/${paymentId}/refund`;

  it("refunds part, then the rest, from Crewdesk: the invoice owes it again and the customer is told", async () => {
    const { id, pi, paymentId } = await paidOnline(8500);
    expect((await call("POST", refundUrl(id, paymentId), "office", { amountCents: 3000 })).status).toBe(403);
    sent.length = 0;
    const r = await call("POST", refundUrl(id, paymentId), "owner", { amountCents: 3000, reason: "requested_by_customer", note: "Missed the back yard" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "succeeded", amountCents: 3000, invoice: { status: "partial", balanceCents: 3000 } });
    const made = [...calls].reverse().find((c) => c.method === "POST" && c.path === "/v1/refunds")!;
    expect(made.form.get("payment_intent")).toBe(pi.id);
    expect(made.form.get("amount")).toBe("3000");
    expect(made.form.get("metadata[crewdeskPaymentId]")).toBe(paymentId);
    expect(sent.filter((m) => m.to === email("pat"))).toHaveLength(1);
    expect(sent[0].subject).toBe("Refund of $30.00 from Portal Co");
    expect(sent[0].text).toContain("to your Visa ·· 4242 for invoice");
    let inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv.payments[0]).toMatchObject({ refundedCents: 3000, status: "completed" });
    expect(inv.payments[0].refunds).toHaveLength(1);
    expect(inv.payments[0].refunds[0]).toMatchObject({ amountCents: 3000, status: "succeeded", note: "Missed the back yard", reason: "requested_by_customer" });
    expect(inv.payments[0].refunds[0].createdById).toBeTruthy();
    // The webhook for the same refund changes nothing and sends no second email.
    expect(await webhook("refund.created", pi.id, WEBHOOK_SECRET, { id: inv.payments[0].refunds[0].stripeRefundId, object: "refund", payment_intent: pi.id })).toBe(200);
    expect(await webhook("charge.refunded", pi.id, WEBHOOK_SECRET, { id: "ch_1", object: "charge", payment_intent: pi.id })).toBe(200);
    expect(sent.filter((m) => m.to === email("pat"))).toHaveLength(1);
    expect((await call("POST", refundUrl(id, paymentId), "owner", { amountCents: 6000 })).body.error).toMatch(/more than the \$55\.00 left/);
    // The rest (no amount = all that's left); then the invoice can be voided.
    const rest = await call("POST", refundUrl(id, paymentId), "owner", {});
    expect(rest.body).toMatchObject({ amountCents: 5500, invoice: { status: "sent", paidCents: 0, balanceCents: 8500 } });
    expect((await call("POST", refundUrl(id, paymentId), "owner", {})).body.error).toMatch(/already fully refunded/);
    expect((await call("POST", `/invoices/${id}/void`, "owner", { reason: "Service cancelled" })).status).toBe(200);
    // The portal shows the refunds.
    const cookie = await signInPortal(email("pat"));
    const one = await portal("GET", `/portal/invoices/${id}`, cookie);
    expect(one.body.invoice.refunds.map((x: any) => x.amountCents)).toEqual([3000, 5500]);
    expect(one.body.invoice.payments[0].refundedCents).toBe(8500);
    inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv.status).toBe("void");
  });

  it("a refund can be written off: a credit for it goes on the invoice, so it isn't owed again", async () => {
    const { id, paymentId } = await paidOnline(8500);
    const r = await call("POST", refundUrl(id, paymentId), "owner", { amountCents: 2000, writeOff: true, note: "Goodwill: missed back yard" });
    expect(r.status).toBe(200);
    const inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv).toMatchObject({ status: "paid", paidCents: 6500, creditedCents: 2000, balanceCents: 0 });
    expect(inv.credits[0]).toMatchObject({ amountCents: 2000, reason: "refund_writeoff" });
    expect(inv.credits[0].description).toMatch(/^Refund of \$20\.00 on invoice \d+$/);
    const credits = (await call("GET", `/credits?customerId=${ID.pat}`, "office")).body.credits;
    expect(credits.find((c: any) => c.reason === "refund_writeoff")).toMatchObject({ amountCents: 2000, leftCents: 0, note: "Goodwill: missed back yard" });
    // The customer sees the refund and the credit on the invoice.
    const cookie = await signInPortal(email("pat"));
    const one = (await portal("GET", `/portal/invoices/${id}`, cookie)).body.invoice;
    expect(one).toMatchObject({ balanceCents: 0, creditedCents: 2000, status: "paid" });
    expect(one.credits[0].amountCents).toBe(2000);
    expect(one.refunds[0].amountCents).toBe(2000);
  });

  it("a refund made in Stripe's dashboard comes in by webhook; a failed one puts the payment back", async () => {
    const { id, pi } = await paidOnline(6000);
    const re = addRefund(pi.id, 2500, { reason: "duplicate" });
    sent.length = 0;
    expect(await webhook("refund.created", pi.id, WEBHOOK_SECRET, re)).toBe(200);
    let inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv).toMatchObject({ status: "partial", paidCents: 3500 });
    expect(inv.payments[0].refunds[0]).toMatchObject({ amountCents: 2500, reason: "duplicate", createdById: null });
    expect(sent).toHaveLength(1);
    re.status = "failed";
    expect(await webhook("refund.failed", pi.id, WEBHOOK_SECRET, re)).toBe(200);
    inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv).toMatchObject({ status: "paid", paidCents: 6000 });
    expect(inv.payments[0]).toMatchObject({ refundedCents: 0 });
    expect(inv.payments[0].refunds[0].status).toBe("failed");
  });

  it("the hourly check finds refunds whose webhook never came", async () => {
    const { id, pi } = await paidOnline(4000, "us_bank_account");
    addRefund(pi.id, 4000);
    expect(await checkRecentRefunds()).toBeGreaterThanOrEqual(1);
    const inv = (await call("GET", `/invoices/${id}`, "office")).body;
    expect(inv).toMatchObject({ status: "sent", paidCents: 0 });
    expect(inv.payments[0].refunds[0].status).toBe("pending");
    const [row] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.paymentId, inv.payments[0].id));
    expect(row.notifiedAt).toBeTruthy();
  });

  it("refuses refunds of cash, checks and bank payments still clearing", async () => {
    const id = await sentInvoice(ID.pat, 2000, ["paper"]);
    const cash = (await call("POST", `/invoices/${id}/payments`, "owner", { amountCents: 2000, method: "cash" })).body.payment;
    expect((await call("POST", refundUrl(id, cash.id), "owner", {})).body.error).toMatch(/Void a cash or check payment/);
    const id2 = await sentInvoice(ID.pat, 2000, ["paper"]);
    const token = await tokenOf(id2);
    const pi = intents.get((await call("POST", `/pay/${token}/pay`, null)).body.paymentIntentId)!;
    pi.pmType = "us_bank_account"; pi.status = "processing";
    await call("POST", `/pay/${token}/confirm`, null, { paymentIntentId: pi.id });
    const pay = (await call("GET", `/invoices/${id2}`, "owner")).body.payments[0];
    expect((await call("POST", refundUrl(id2, pay.id), "owner", {})).body.error).toMatch(/hasn't cleared yet/);
  });

  it("webhooks made before newer events were handled get them added", async () => {
    const [c] = await db.select({ stripe: companies.stripe }).from(companies).where(eq(companies.id, companyId));
    await db.update(companies).set({ stripe: { ...c.stripe!, webhookEvents: 1 } }).where(eq(companies.id, companyId));
    expect(await updateWebhookEvents()).toBeGreaterThanOrEqual(1);
    const upd = [...calls].reverse().find((x) => x.method === "POST" && x.path === `/v1/webhook_endpoints/${c.stripe!.webhookEndpointId}`)!;
    expect(upd.form.getAll("enabled_events[]").length || [...upd.form.keys()].filter((k) => k.startsWith("enabled_events")).length).toBeGreaterThanOrEqual(8);
    expect([...upd.form.values()]).toContain("refund.created");
    expect([...upd.form.values()]).toContain("setup_intent.succeeded");
    const [after] = await db.select({ stripe: companies.stripe }).from(companies).where(eq(companies.id, companyId));
    expect(after.stripe!.webhookEvents).toBe(WEBHOOK_EVENTS_VERSION);
  });
});

describe("Prepayments online", () => {
  it("the office sends a prepay link; the customer pays by card; it pays their next invoice", async () => {
    sent.length = 0;
    const r = await call("POST", "/prepayments", "office", { customerId: ID.other, description: "2027 season", coversCents: 40000, discountKind: "amount", discountValue: 2000, how: "link" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "requested", amountCents: 38000, emailedTo: email("olive") });
    const token = r.body.payLink.split("/prepay/")[1];
    expect(sent.find((m) => m.to === email("olive"))!.text).toContain(`/prepay/${token}`);
    const view = await call("GET", `/prepay/${token}`, null);
    expect(view.body.prepayment).toMatchObject({ amountCents: 38000, discountCents: 2000, status: "requested", customer: { name: "Olive Other" } });
    const start = await call("POST", `/prepay/${token}/pay`, null);
    expect(start.body.amountCents).toBe(38000);
    const pi = intents.get(start.body.paymentIntentId)!;
    expect(pi.metadata.crewdeskPrepaymentId).toBe(r.body.id);
    pi.status = "succeeded";
    sent.length = 0;
    const done = await call("POST", `/prepay/${token}/confirm`, null, { paymentIntentId: pi.id });
    expect(done.body).toMatchObject({ status: "completed", prepayment: { status: "open", methodDetail: "Visa ·· 4242", cashLeftCents: 38000 } });
    expect(sent.find((m) => m.to === email("olive"))!.subject).toMatch(/^Prepayment received: \$380\.00/);
    // The webhook says the same: nothing changes.
    expect(await webhook("payment_intent.succeeded", pi.id)).toBe(200);
    const inv = await sentInvoice(ID.other, 10000, ["paper"]);
    const i = (await call("GET", `/invoices/${inv}`, "office")).body;
    expect(i).toMatchObject({ status: "paid", paidCents: 9500, creditedCents: 500 });
    ID.ppOnline = r.body.id; ID.ppPi = pi.id;
  });

  it("refunding the rest goes back to the card; a refund made in Stripe's dashboard closes it too", async () => {
    const r = await call("POST", `/prepayments/${ID.ppOnline}/refund`, "owner", {});
    expect(r.body).toMatchObject({ status: "closed", refundedCents: 28500 });
    const made = [...calls].reverse().find((c) => c.method === "POST" && c.path === "/v1/refunds")!;
    expect(made.form.get("payment_intent")).toBe(ID.ppPi);
    expect(made.form.get("amount")).toBe("28500");
    // Another prepayment refunded in Stripe's dashboard.
    const pp2 = (await call("POST", "/prepayments", "office", { customerId: ID.other, description: "Fall aeration", coversCents: 9500, how: "link" })).body;
    const token = pp2.payLink.split("/prepay/")[1];
    const pi = intents.get((await call("POST", `/prepay/${token}/pay`, null)).body.paymentIntentId)!;
    pi.status = "succeeded";
    await call("POST", `/prepay/${token}/confirm`, null, { paymentIntentId: pi.id });
    const re = addRefund(pi.id, 9500);
    expect(await webhook("refund.created", pi.id, WEBHOOK_SECRET, re)).toBe(200);
    const list = (await call("GET", `/prepayments?customerId=${ID.other}`, "office")).body.prepayments;
    expect(list.find((x: any) => x.id === pp2.id)).toMatchObject({ status: "closed", refundedCents: 9500, cashLeftCents: 0 });
  });

  it("customers can prepay any amount in the portal, and see what they've prepaid", async () => {
    const cookie = await signInPortal(email("olive"));
    expect((await portal("POST", "/portal/prepay", cookie, { customerId: ID.pat, amountCents: 5000 })).status).toBe(404);
    const small = await portal("POST", "/portal/prepay", cookie, { customerId: ID.other, amountCents: 100 });
    expect(small.status).toBe(400);
    expect(JSON.stringify(small.body)).toMatch(/smallest prepayment/);
    const start = await portal("POST", "/portal/prepay", cookie, { customerId: ID.other, amountCents: 5000 });
    expect(start.body).toMatchObject({ amountCents: 5000 });
    const pi = intents.get(start.body.paymentIntentId)!;
    pi.pmType = "us_bank_account"; pi.status = "processing";
    const c = await portal("POST", `/portal/prepayments/${start.body.prepaymentId}/pay/confirm`, cookie, { paymentIntentId: pi.id });
    expect(c.body).toMatchObject({ status: "pending", prepayment: { status: "pending" } });
    pi.status = "succeeded";
    expect(await webhook("payment_intent.succeeded", pi.id)).toBe(200);
    const me = (await portal("GET", "/portal/me", cookie)).body;
    expect(me.customers[0].prepaidCents).toBe(5000);
    expect(me.prepayments.find((x: any) => x.id === start.body.prepaymentId)).toMatchObject({ status: "open", cashLeftCents: 5000, methodDetail: "Arvest Bank checking ·· 6789" });
  });
});

describe("Disconnecting Stripe", () => {
  it("turns online payments off (pay links still show the invoice)", async () => {
    const id = await sentInvoice(ID.pat, 2000, ["paper"]);
    expect((await call("DELETE", "/stripe/settings", "owner")).status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/v1/webhook_endpoints/"))).toBe(true);
    expect((await call("GET", "/stripe/settings", "owner")).body).toEqual({ connected: false });
    const token = await tokenOf(id);
    const view = await call("GET", `/pay/${token}`, null);
    expect(view.body.payments).toEqual({ enabled: false });
    expect((await call("POST", `/pay/${token}/pay`, null)).body.error).toMatch(/aren't set up/);
    expect(await webhook("payment_intent.succeeded", "pi_x")).toBe(400);
  });
});

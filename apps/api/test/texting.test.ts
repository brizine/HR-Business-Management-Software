/** Texting customers: connecting, sending, replies filed under the customer, STOP and START, and conversations. Against a pretend provider. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { pollInboundTexts, receiveText, setTextingProvider, type Inbound } from "../src/lib/texting";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

const suffix = Date.now();
const sentTexts: { to: string; body: string }[] = [];
let waiting: Inbound[] = [];
let failNext = false;
setTextingProvider({
  ready: true,
  async check(c) { if (c.key !== "good-key-123") throw new Error("Talkroute didn't accept that API key"); return { accountName: "ProSpray (test)" }; },
  async send(_c, to, body) { if (failNext) { failNext = false; throw new Error("Number can't receive texts"); } sentTexts.push({ to, body }); return { id: `msg_${suffix}_${sentTexts.length}` }; },
  async inbound() { const got = waiting; waiting = []; return got; },
});

let app: FastifyInstance;
const email = (x: string) => `${x}-${suffix}@texting.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let companyId = "";
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Text Co", firstName: "Tess", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token; companyId = s.company.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Text Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@texting.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" });
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  ID.amy = (await call("POST", "/customers", "office", { firstName: "Amy", lastName: "Aster", phone: "(405) 555-0101", email: email("amy") })).body.id;
  ID.nophone = (await call("POST", "/customers", "office", { firstName: "Ned", lastName: "Nophone", delivery: ["paper"], billingStreet: "4 Elm St", billingCity: "Norman", billingZip: "73069" })).body.id;
});

afterAll(async () => {
  setTextingProvider(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("texting", () => {
  it("only the owner connects it; a bad key is refused", async () => {
    expect((await call("GET", "/texting/settings", "office")).body).toMatchObject({ available: true, connected: false });
    expect((await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Hi" })).status).toBe(400);
    expect((await call("PUT", "/texting/settings", "office", { apiKey: "good-key-123", fromNumber: "405-555-0199" })).status).toBe(403);
    const bad = await call("PUT", "/texting/settings", "owner", { apiKey: "wrong-key-1", fromNumber: "405-555-0199" });
    expect(bad.body.error ?? bad.body.message).toMatch(/didn't accept/);
    expect((await call("PUT", "/texting/settings", "owner", { apiKey: "good-key-123", fromNumber: "405-555-0199" })).status).toBe(200);
    expect((await call("GET", "/texting/settings", "office")).body).toMatchObject({ connected: true, fromNumber: "+14055550199", accountName: "ProSpray (test)" });
  });

  it("sends from the office; failures and missing numbers are clear", async () => {
    const r = await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Hi Amy, we're out your way Tuesday." });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "sent", direction: "out" });
    expect(sentTexts.at(-1)).toEqual({ to: "+14055550101", body: "Hi Amy, we're out your way Tuesday." });
    failNext = true;
    const f = await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Second try" });
    expect(f.status).toBe(502);
    expect((await call("POST", `/texting/customers/${ID.nophone}`, "office", { body: "Hi" })).body.error).toMatch(/no mobile number/);
    const conv = (await call("GET", `/texting/customers/${ID.amy}`, "office")).body;
    expect(conv.texts.map((t: any) => [t.body, t.status])).toEqual([["Hi Amy, we're out your way Tuesday.", "sent"], ["Second try", "failed"]]);
  });

  it("replies are filed under the customer, unread until opened; STOP and START", async () => {
    waiting = [{ id: `in_${suffix}_1`, from: "+14055550101", body: "Thanks! Gate is open.", at: new Date() }];
    expect(await pollInboundTexts()).toBeGreaterThanOrEqual(1);
    // The same reply again is ignored.
    expect(await receiveText(companyId, { id: `in_${suffix}_1`, from: "+14055550101", body: "Thanks! Gate is open.", at: new Date() })).toBeNull();
    let inbox = (await call("GET", "/texting/conversations", "office")).body;
    expect(inbox.unread).toBe(1);
    expect(inbox.conversations[0]).toMatchObject({ customerId: ID.amy, name: "Amy Aster", unread: 1, last: { body: "Thanks! Gate is open." } });
    await call("GET", `/texting/customers/${ID.amy}`, "office");
    expect((await call("GET", "/texting/conversations", "office")).body.unread).toBe(0);
    await flushNotifications();
    const notes = (await call("GET", "/notifications", "office")).body;
    expect((notes.items ?? notes)[0].title).toBe("Text from Amy Aster");

    await receiveText(companyId, { id: `in_${suffix}_2`, from: "4055550101", body: "STOP", at: new Date() });
    expect((await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Hello?" })).body.error).toMatch(/replied STOP/);
    expect((await call("GET", `/texting/customers/${ID.amy}`, "office")).body.optedOut).toBeTruthy();
    await receiveText(companyId, { id: `in_${suffix}_3`, from: "+14055550101", body: "start", at: new Date() });
    expect((await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Welcome back" })).status).toBe(200);
  });

  it("a reply from an unknown number can be filed under a customer", async () => {
    await receiveText(companyId, { id: `in_${suffix}_4`, from: "+14055550777", body: "This is Ned's wife, new number", at: new Date() });
    const inbox = (await call("GET", "/texting/conversations", "office")).body;
    expect(inbox.conversations[0]).toMatchObject({ customerId: null, phone: "+14055550777", unread: 1 });
    expect((await call("POST", "/texting/assign", "office", { phone: "+14055550777", customerId: ID.nophone })).status).toBe(200);
    expect((await call("GET", `/texting/customers/${ID.nophone}`, "office")).body.texts).toHaveLength(1);
  });
});

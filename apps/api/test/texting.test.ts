/** Texting customers: connecting, sending, replies filed under the customer, STOP and START, and conversations. Against a pretend provider. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { TEXT_QUEUE, pollInboundTexts, receiveText, runTextQueue, setTextingProvider, type Inbound } from "../src/lib/texting";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

const suffix = Date.now();
const sentTexts: { to: string; body: string }[] = [];
let waiting: Inbound[] = [];
let failNext = false;
const GOOD = `good-key-${suffix}`;
TEXT_QUEUE.gapMs = 0;
setTextingProvider({
  ready: true,
  async check(c) { if (c.key !== GOOD) throw new Error("Talkroute didn't accept that API key"); return { accountName: "ProSpray (test)" }; },
  async numbers(key) { if (key !== GOOD) throw new Error("Talkroute didn't accept that API key"); return [{ number: "+14055550199", label: "Office", canSend: true }, { number: "+14055550188", label: "Fax line", canSend: false }]; },
  async send(_c, to, body) { if (failNext) { failNext = false; throw new Error("Number can't receive texts"); } sentTexts.push({ to, body }); return { id: `msg_${suffix}_${sentTexts.length}` }; },
  // Only this run's company is handed the waiting texts (companies left by earlier runs have other keys).
  async inbound(c) { if (c.key !== GOOD) return []; const got = waiting; waiting = []; return got; },
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
    expect((await call("PUT", "/texting/settings", "office", { apiKey: GOOD, fromNumber: "405-555-0199" })).status).toBe(403);
    expect((await call("POST", "/texting/settings/numbers", "owner", { apiKey: GOOD })).body.numbers.map((n: any) => [n.number, n.canSend])).toEqual([["+14055550199", true], ["+14055550188", false]]);
    expect((await call("POST", "/texting/settings/numbers", "owner", { apiKey: "wrong-key-1" })).body.error).toMatch(/didn't accept/);
    const bad = await call("PUT", "/texting/settings", "owner", { apiKey: "wrong-key-1", fromNumber: "405-555-0199" });
    expect(bad.body.error ?? bad.body.message).toMatch(/didn't accept/);
    expect((await call("PUT", "/texting/settings", "owner", { apiKey: GOOD, fromNumber: "405-555-0199" })).status).toBe(200);
    expect((await call("GET", "/texting/settings", "office")).body).toMatchObject({ connected: true, fromNumber: "+14055550199", accountName: "ProSpray (test)" });
    // The connection and its key never ride along with a signed-in person's company details.
    const me = (await call("GET", "/auth/me", "office")).body;
    expect(Object.keys(me.company).filter((k) => /texting|secret|key$/i.test(k))).toEqual([]);
    expect(JSON.stringify(me)).not.toContain(GOOD);
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
    let inbox = (await call("GET", "/texting/threads", "office")).body;
    expect(inbox.unread).toBe(1);
    expect(inbox.threads[0]).toMatchObject({ customerId: ID.amy, name: "Amy Aster", kind: "customer", unread: 1, last: { body: "Thanks! Gate is open.", direction: "in" } });
    ID.amyThread = inbox.threads[0].id;
    expect((await call("GET", "/texting/unread", "office")).body.unread).toBe(1);
    await call("GET", `/texting/customers/${ID.amy}`, "office");
    expect((await call("GET", "/texting/threads", "office")).body.unread).toBe(0);
    await flushNotifications();
    const notes = (await call("GET", "/notifications", "office")).body;
    expect((notes.items ?? notes)[0]).toMatchObject({ title: "Text from Amy Aster", category: "texts", link: { screen: "texts", threadId: ID.amyThread } });

    await receiveText(companyId, { id: `in_${suffix}_2`, from: "4055550101", body: "STOP", at: new Date() });
    expect((await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Hello?" })).body.error).toMatch(/replied STOP/);
    expect((await call("GET", `/texting/customers/${ID.amy}`, "office")).body.optedOut).toBeTruthy();
    await receiveText(companyId, { id: `in_${suffix}_3`, from: "+14055550101", body: "start", at: new Date() });
    expect((await call("POST", `/texting/customers/${ID.amy}`, "office", { body: "Welcome back" })).status).toBe(200);
  });

  it("a reply from an unknown number can be filed under a customer", async () => {
    await receiveText(companyId, { id: `in_${suffix}_4`, from: "+14055550777", body: "This is Ned's wife, new number", at: new Date() });
    const inbox = (await call("GET", "/texting/threads", "office")).body;
    expect(inbox.threads[0]).toMatchObject({ customerId: null, kind: "unknown", name: null, phone: "+14055550777", unread: 1 });
    expect((await call("POST", "/texting/assign", "office", { phone: "+14055550777", customerId: ID.nophone })).status).toBe(200);
    expect((await call("GET", `/texting/customers/${ID.nophone}`, "office")).body.texts).toHaveLength(1);
    expect((await call("GET", "/texting/threads?filter=unread", "office")).body.threads).toHaveLength(0);
  });

  it("the Text Messages list: search, a conversation, replying with tags, mark unread, open and done", async () => {
    const list = (await call("GET", "/texting/threads?q=gate", "office")).body;
    expect(list.threads.map((t: any) => t.name)).toEqual(["Amy Aster"]);
    expect((await call("GET", "/texting/threads?q=aster", "office")).body.total).toBe(1);
    expect((await call("GET", "/texting/threads?q=5550777", "office")).body.threads[0].name).toBe("Ned Nophone");
    const conv = (await call("GET", `/texting/threads/${ID.amyThread}`, "office")).body;
    expect(conv).toMatchObject({ name: "Amy Aster", phone: "+14055550101", connected: true, status: "open" });
    expect(conv.texts.at(-1)).toMatchObject({ body: "Welcome back", direction: "out", by: "Olive Office" });
    // A reply in the conversation, with a tag filled in for that customer.
    const r = await call("POST", `/texting/threads/${ID.amyThread}`, "office", { body: "Hi {{CUSTOMER_FIRST_NAME}}, see you Tuesday." });
    expect(r.status).toBe(200);
    expect(sentTexts.at(-1)).toEqual({ to: "+14055550101", body: "Hi Amy, see you Tuesday." });
    // Mark unread puts it back in Unread; opening it clears it; looking without opening (peek) doesn't.
    await call("POST", `/texting/threads/${ID.amyThread}/unread`, "office");
    expect((await call("GET", "/texting/threads?filter=unread", "office")).body.threads.map((t: any) => t.id)).toEqual([ID.amyThread]);
    await call("GET", `/texting/threads/${ID.amyThread}?peek=1`, "office");
    expect((await call("GET", "/texting/unread", "office")).body.unread).toBe(1);
    await call("GET", `/texting/threads/${ID.amyThread}`, "office");
    expect((await call("GET", "/texting/unread", "office")).body.unread).toBe(0);
    // Done takes it out of Open; a new reply opens it again.
    expect((await call("POST", `/texting/threads/${ID.amyThread}/status`, "office", { status: "done" })).status).toBe(200);
    expect((await call("GET", "/texting/threads?filter=done", "office")).body.threads.map((t: any) => t.id)).toEqual([ID.amyThread]);
    await receiveText(companyId, { id: `in_${suffix}_5`, from: "+14055550101", body: "Tuesday works", at: new Date() });
    expect((await call("GET", `/texting/threads/${ID.amyThread}?peek=1`, "office")).body).toMatchObject({ status: "open", unread: 1 });
  });

  it("picked employees hear about incoming texts and can answer them; nobody else on the crew can", async () => {
    await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tia"), password: "password123", role: "employee", phone: "405-555-0142" });
    await call("POST", "/employees", "owner", { firstName: "Cal", lastName: "Crew", email: email("cal"), password: "password123", role: "employee" });
    for (const who of ["tia", "cal"]) T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
    expect((await call("GET", "/texting/threads", "tia")).status).toBe(403);
    expect((await call("GET", "/auth/me", "tia")).body.access.texting).toBe(false);
    const people = (await call("GET", "/texting/settings/people", "owner")).body;
    expect(people.picked).toEqual([]);
    ID.tia = people.people.find((p: any) => p.name === "Tia Tech").id;
    // Nobody picked: the managers are told.
    expect((await call("GET", "/texting/settings", "office")).body.notify).toMatchObject({ picked: false });
    expect((await call("PUT", "/texting/settings/notify", "office", { employeeIds: [ID.tia] })).status).toBe(403);
    expect((await call("PUT", "/texting/settings/notify", "owner", { employeeIds: [ID.tia] })).body).toMatchObject({ ok: true, count: 1 });
    expect((await call("GET", "/texting/settings", "office")).body.notify).toEqual({ picked: true, people: [{ id: ID.tia, name: "Tia Tech" }] });
    expect((await call("GET", "/auth/me", "tia")).body.access.texting).toBe(true);
    await flushNotifications();
    const before = ((await call("GET", "/notifications", "office")).body.items ?? []).length;
    await receiveText(companyId, { id: `in_${suffix}_6`, from: "+14055550101", body: "Can you also do the back yard?", at: new Date() });
    await flushNotifications();
    // Tia is told (and Olive, a manager who wasn't picked, isn't any more).
    const tia = (await call("GET", "/notifications", "tia")).body;
    expect((tia.items ?? tia)[0]).toMatchObject({ title: "Text from Amy Aster", body: "Can you also do the back yard?", link: { screen: "texts", threadId: ID.amyThread } });
    expect(((await call("GET", "/notifications", "office")).body.items ?? []).length).toBe(before);
    // She can read and answer, but doesn't get a way into the customer's page, and can't change settings or delete.
    const conv = (await call("GET", `/texting/threads/${ID.amyThread}`, "tia")).body;
    expect(conv).toMatchObject({ name: "Amy Aster", customerId: null });
    expect((await call("POST", `/texting/threads/${ID.amyThread}`, "tia", { body: "Yes, we can add the back yard." })).status).toBe(200);
    expect((await call("GET", `/texting/customers/${ID.amy}`, "tia")).status).toBe(403);
    expect((await call("DELETE", `/texting/threads/${ID.amyThread}`, "tia")).status).toBe(403);
    expect((await call("GET", "/texting/threads", "cal")).status).toBe(403);
    // A text from someone on the team is filed under them.
    await receiveText(companyId, { id: `in_${suffix}_7`, from: "+14055550142", body: "Running 10 late", at: new Date() });
    const top = (await call("GET", "/texting/threads", "office")).body.threads[0];
    expect(top).toMatchObject({ kind: "employee", name: "Tia Tech", employeeId: ID.tia });
  });

  it("Send Text Messages: groups, the team and typed numbers; many go out in line, with who was left out and why", async () => {
    ID.bo = (await call("POST", "/customers", "office", { firstName: "Bo", lastName: "Birch", phone: "405-555-0102", email: email("bo") })).body.id;
    ID.cy = (await call("POST", "/customers", "office", { firstName: "Cy", lastName: "Cedar", phone: "405-555-0103", email: email("cy") })).body.id;
    await receiveText(companyId, { id: `in_${suffix}_8`, from: "+14055550103", body: "Stop", at: new Date() });
    const g = (await call("POST", "/texting/groups", "office", { name: "Spring specials" })).body;
    expect((await call("POST", "/texting/groups", "office", { name: "spring specials" })).body.error).toMatch(/already a group/);
    for (const id of [ID.amy, ID.bo, ID.cy, ID.nophone]) expect((await call("POST", `/texting/groups/${g.id}/members`, "office", { customerId: id })).status).toBe(200);
    expect((await call("POST", `/texting/groups/${g.id}/members`, "office", { employeeId: ID.tia })).status).toBe(200);
    const members = (await call("GET", `/texting/groups/${g.id}`, "office")).body.members;
    expect(members.map((m: any) => [m.name, m.detail])).toEqual([["Amy Aster", "(405) 555-0101"], ["Bo Birch", "(405) 555-0102"], ["Cy Cedar", "Replied STOP"], ["Ned Nophone", "No mobile number"], ["Tia Tech", "(405) 555-0142"]]);
    expect((await call("GET", "/texting/recipients?kind=groups", "office")).body.rows).toEqual([{ id: g.id, name: "Spring specials", detail: "5 members", ok: true }]);
    expect((await call("GET", "/texting/recipients?q=birch", "office")).body.rows).toEqual([{ id: ID.bo, name: "Bo Birch", detail: "(405) 555-0102", ok: true }]);
    expect((await call("GET", "/texting/recipients?kind=employees&q=tia", "office")).body.rows[0]).toMatchObject({ name: "Tia Tech", ok: true });

    const n = sentTexts.length;
    const sent = (await call("POST", "/texting/send", "office", { body: "Hi {{CUSTOMER_FIRST_NAME}}! Aeration is 10% off through April. - {{COMPANY_NAME}}", groupIds: [g.id], phones: ["405-555-0101", "4055550160"] })).body;
    expect(sent).toMatchObject({ sent: 0, queued: 4 });
    expect(sent.skipped).toEqual(expect.arrayContaining([{ name: "Cy Cedar", reason: "Replied STOP" }, { name: "Ned Nophone", reason: "No mobile number" }, { name: "(405) 555-0101", reason: "Same number as someone else on the list" }]));
    await runTextQueue();
    expect(sentTexts.slice(n).map((t) => [t.to, t.body]).sort()).toEqual([
      ["+14055550101", "Hi Amy! Aeration is 10% off through April. - Text Co"],
      ["+14055550102", "Hi Bo! Aeration is 10% off through April. - Text Co"],
      ["+14055550142", "Hi Tia! Aeration is 10% off through April. - Text Co"],
      ["+14055550160", "Hi ! Aeration is 10% off through April. - Text Co"],
    ]);
    const hist = (await call("GET", "/texting/batches", "office")).body.rows[0];
    expect(hist).toMatchObject({ label: "Group: Spring specials", total: 4, sent: 4, failed: 0, waiting: 0, by: "Olive Office" });
    // Each shows in its own conversation.
    expect((await call("GET", `/texting/threads/${ID.amyThread}`, "office")).body.texts.at(-1).body).toBe("Hi Amy! Aeration is 10% off through April. - Text Co");

    // One person goes right away; a failure is said plainly and lands in the Error Log.
    const one = await call("POST", "/texting/send", "office", { body: "Quick note", customerIds: [ID.bo] });
    expect(one.body).toMatchObject({ sent: 1, queued: 0 });
    failNext = true;
    expect((await call("POST", "/texting/send", "office", { body: "Won't go", customerIds: [ID.bo] })).status).toBe(502);
    expect((await call("GET", "/texting/errors", "office")).body.rows[0]).toMatchObject({ name: "Bo Birch", phone: "+14055550102", error: "Number can't receive texts" });
    expect((await call("POST", "/texting/send", "office", { body: "Hi", customerIds: [ID.cy] })).body.error).toMatch(/Nobody on it can be texted: Cy Cedar \(replied stop\)/);
    // From the Customers page: the rows ticked there.
    const ticked = (await call("POST", "/texting/send", "office", { body: "Rain delay today", ids: [ID.amy, ID.bo], audience: "2 customers picked" })).body;
    expect(ticked).toMatchObject({ queued: 2 });
    await runTextQueue();
    expect((await call("GET", "/texting/batches", "office")).body.rows[0]).toMatchObject({ label: "2 customers picked", sent: 2 });
    // Stopping a send drops what hasn't gone.
    TEXT_QUEUE.gapMs = 60_000;
    const slow = (await call("POST", "/texting/send", "office", { body: "Slow one", customerIds: [ID.amy, ID.bo] })).body;
    const stop = (await call("POST", `/texting/batches/${slow.batchId}/stop`, "office")).body;
    expect(stop.ok).toBe(true);
    TEXT_QUEUE.gapMs = 0;
  });

  it("a conversation can be started with a customer, someone on the team or a number, and deleted", async () => {
    expect((await call("POST", "/texting/threads/open", "office", { customerId: ID.nophone })).body.error).toMatch(/no mobile number/);
    const t = (await call("POST", "/texting/threads/open", "office", { phone: "(405) 555-0170" })).body;
    expect((await call("POST", `/texting/threads/${t.id}`, "office", { body: "Hello from Text Co" })).status).toBe(200);
    expect((await call("GET", "/texting/threads?q=5550170", "office")).body.threads[0]).toMatchObject({ kind: "unknown", last: { body: "Hello from Text Co", direction: "out" } });
    expect((await call("DELETE", `/texting/threads/${t.id}`, "office")).status).toBe(403);
    expect((await call("DELETE", `/texting/threads/${t.id}`, "owner")).status).toBe(200);
    expect((await call("GET", "/texting/threads?q=5550170", "office")).body.total).toBe(0);
  });
});

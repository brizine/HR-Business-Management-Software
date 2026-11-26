/**
 * The Talkroute connection itself, against a pretend Talkroute that answers the way its API
 * reference says: picking a number, connecting (which asks Talkroute to call Crewdesk about new
 * texts), sending, the signed "new text" calls, texts sent from Talkroute's own app, and catching up.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushTextJobs, flushTextLookups, pollInboundTexts, setTextingProvider } from "../src/lib/texting";
import { TALKROUTE_PACE } from "../src/lib/talkroute";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

const suffix = Date.now();
const KEY = `tr_live_${suffix}`;
const SECRET = `whsec_${crypto.randomBytes(32).toString("base64")}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const tr = {
  sends: [] as { conv: string; body: string; attachment?: { fileType: string; content: string; hash: string } }[], subs: [] as { id: string; hookUrl: string; type: string }[], deleted: [] as string[], planOff: false,
  convs: [] as any[], messages: {} as Record<string, any[]>, contacts: [] as any[], voicemails: [] as any[],
};
TALKROUTE_PACE.ms = 0;
let base = "";

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const send = (status: number, body?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
    const url = new URL(req.url!, "http://x");
    const page = { total: 1, currentPage: 1, totalPages: 1, nextPageUrl: null };
    // A picture's short-lived address (no key needed, like a signed link).
    if (req.method === "GET" && url.pathname.startsWith("/files/")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(png); }
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: "Unauthenticated." });
    const p = url.pathname, m = req.method;
    if (m === "GET" && p === "/v2/account") return send(200, { data: { id: "1", name: "ProSpray (pretend)" } });
    if (m === "GET" && p === "/v2/virtual-numbers") return send(200, { data: [
      { id: 1, phoneNumber: "+14055550199", description: "Main line", textMessagingAllowed: true, hasActiveCampaign: true, messagingActivated: true },
      { id: 2, phoneNumber: "+14055550188", description: "", textMessagingAllowed: false, hasActiveCampaign: false },
    ], pagination: page });
    if (m === "GET" && p === "/v2/subscriptions") return send(200, { data: tr.subs, pagination: page });
    if (m === "POST" && p === "/v2/subscriptions") { const b = JSON.parse(raw); const s = { id: crypto.randomUUID(), hookUrl: b.hookUrl, type: b.type }; tr.subs.push(s); return send(201, { data: { ...s, signingSecret: SECRET } }); }
    if (m === "DELETE" && p.startsWith("/v2/subscriptions/")) { const id = p.split("/").pop()!; tr.deleted.push(id); tr.subs = tr.subs.filter((s) => s.id !== id); return send(204); }
    if (m === "GET" && p === "/v2/text-conversations") return send(200, { data: tr.convs, pagination: page });
    const conv = /^\/v2\/text-conversations\/(\d+-\d+)(\/messages)?$/.exec(p);
    if (m === "GET" && conv?.[2]) return send(200, { data: tr.messages[conv[1]] ?? [], pagination: page });
    if (m === "POST" && conv && !conv[2]) {
      if (tr.planOff) return send(402, {});
      const b = JSON.parse(raw);
      tr.sends.push({ conv: conv[1], body: b.body, attachment: b.attachment });
      return send(200, { data: { id: crypto.randomUUID(), body: b.body, message_direction: "outgoing", talkroute_number: conv[1].split("-")[0], contact_number: conv[1].split("-")[1] } });
    }
    if (m === "POST" && p === "/v2/contacts/import") { const b = JSON.parse(raw); const fresh = b.contacts.filter((c: any) => !tr.contacts.some((x) => x.externalId === c.externalId)); tr.contacts.push(...fresh); return send(201, { data: { contactsImported: fresh.length, contactsSkipped: b.contacts.length - fresh.length } }); }
    if (m === "GET" && p === "/v2/voice-messages") return send(200, { data: tr.voicemails, pagination: page });
    const audio = /^\/v2\/voice-messages\/([^/]+)\/audio-url$/.exec(p);
    if (m === "GET" && audio) return send(200, { url: `https://media.talkroute.test/voicemessages/${audio[1]}` });
    send(404, { message: "Not Found" });
  });
});

let app: FastifyInstance;
const email = (x: string) => `${x}-${suffix}@talkroute.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let hookPath = "";
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body };
}
/** A "new text" call the way Talkroute signs it (Standard Webhooks). */
async function hook(event: Record<string, unknown>, o: { secret?: string; at?: number; path?: string; kind?: "call" | "voicemail" } = {}) {
  const body = JSON.stringify(event);
  const id = String(event.event_id), ts = String(o.at ?? Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", Buffer.from((o.secret ?? SECRET).replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return app.inject({ method: "POST", url: o.path ?? `${hookPath}${o.kind ? `/${o.kind}` : ""}`, payload: body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}`, "x-talkroute-event-id": id } });
}
const texts = async (id: string) => (await call("GET", `/texting/threads/${id}?peek=1`, "owner")).body.texts.map((t: any) => [t.direction, t.body, t.source]);

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.TALKROUTE_API_URL = base;
  setTextingProvider(null);
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Route Co", firstName: "Rae", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  ID.amy = (await call("POST", "/customers", "owner", { firstName: "Amy", lastName: "Aster", phone: "(405) 555-0101", email: email("amy") })).body.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await new Promise((r) => fake.close(r));
  delete process.env.TALKROUTE_API_URL;
  await pool.end();
});

describe("Talkroute", () => {
  it("lists the numbers that can text, and connects one (asking Talkroute to call about new texts)", async () => {
    expect((await call("POST", "/texting/settings/numbers", "owner", { apiKey: "tr_live_wrong" })).body.error).toBe("Talkroute didn't accept that API key");
    expect((await call("POST", "/texting/settings/numbers", "owner", { apiKey: KEY })).body.numbers).toEqual([
      { number: "+14055550199", label: "Main line", canSend: true, registered: true },
      { number: "+14055550188", label: null, canSend: false, registered: false },
    ]);
    expect((await call("PUT", "/texting/settings", "owner", { apiKey: KEY, fromNumber: "405-555-0000" })).body.error).toMatch(/isn't one of your Talkroute numbers/);
    expect((await call("PUT", "/texting/settings", "owner", { apiKey: KEY, fromNumber: "(405) 555-0199" })).body).toMatchObject({ ok: true, webhook: true });
    // Texts, calls and voicemails each get an address of their own.
    expect(tr.subs.map((x) => x.type)).toEqual(["new_text_message", "new_call_record", "new_voicemail"]);
    expect(tr.subs[0].hookUrl).toMatch(/\/texting\/hooks\/talkroute\/[0-9a-f]{48}$/);
    expect(tr.subs[1].hookUrl).toBe(`${tr.subs[0].hookUrl}/call`);
    expect(tr.subs[2].hookUrl).toBe(`${tr.subs[0].hookUrl}/voicemail`);
    hookPath = new URL(tr.subs[0].hookUrl).pathname;
    expect((await call("GET", "/texting/settings", "owner")).body).toMatchObject({ connected: true, fromNumber: "+14055550199", accountName: "ProSpray (pretend)", webhook: true, calls: true });
    // Connecting again replaces the subscriptions rather than adding more.
    expect((await call("PUT", "/texting/settings", "owner", { apiKey: KEY, fromNumber: "4055550199" })).body.webhook).toBe(true);
    expect(tr.subs).toHaveLength(3);
    expect(tr.deleted).toHaveLength(3);
    hookPath = new URL(tr.subs[0].hookUrl).pathname;
  });

  it("sends into the conversation between the two numbers; a plan without sending is said plainly", async () => {
    const r = await call("POST", `/texting/customers/${ID.amy}`, "owner", { body: "Hi Amy, we're out your way Tuesday." });
    expect(r.body).toMatchObject({ status: "sent", direction: "out", phone: "+14055550101" });
    expect(tr.sends.at(-1)).toEqual({ conv: "14055550199-14055550101", body: "Hi Amy, we're out your way Tuesday." });
    tr.planOff = true;
    const no = await call("POST", `/texting/customers/${ID.amy}`, "owner", { body: "Second" });
    expect(no.status).toBe(502);
    expect(no.body.error).toMatch(/bulk texting plan/);
    tr.planOff = false;
    ID.thread = (await call("GET", "/texting/threads", "owner")).body.threads[0].id;
  });

  it("a signed call about a text that came in is kept once, and the team is told; anything unsigned is refused", async () => {
    const event = { event_id: crypto.randomUUID(), datetime: new Date(Date.now() - 5000).toISOString(), direction: "incoming", from_number: "+14055550101", to_number: "+14055550199", body: "Thanks! Gate is open." };
    expect((await hook(event, { secret: `whsec_${crypto.randomBytes(32).toString("base64")}` })).statusCode).toBe(401);
    expect((await hook(event, { at: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect((await hook(event, { path: `/texting/hooks/talkroute/${"0".repeat(48)}` })).statusCode).toBe(404);
    expect((await call("GET", "/texting/unread", "owner")).body.unread).toBe(0);
    expect((await hook(event)).statusCode).toBe(200);
    // Talkroute tries again when it isn't sure the call arrived: the same event isn't kept twice.
    expect((await hook(event)).statusCode).toBe(200);
    expect((await texts(ID.thread)).filter((t: string[]) => t[1] === "Thanks! Gate is open.")).toEqual([["in", "Thanks! Gate is open.", "office"]]);
    expect((await call("GET", "/texting/unread", "owner")).body.unread).toBe(1);
    await flushNotifications();
    const notes = (await call("GET", "/notifications", "owner")).body;
    expect((notes.items ?? notes)[0]).toMatchObject({ title: "Text from Amy Aster", category: "texts", link: { screen: "texts", threadId: ID.thread } });
    // A text on another of the account's numbers isn't this company's texting number: left alone.
    expect((await hook({ ...event, event_id: crypto.randomUUID(), to_number: "+14055550188", body: "Wrong line" })).statusCode).toBe(200);
    expect((await texts(ID.thread)).some((t: string[]) => t[1] === "Wrong line")).toBe(false);
    // A picture with nothing typed still shows up.
    expect((await hook({ ...event, event_id: crypto.randomUUID(), datetime: new Date(Date.now() - 3000).toISOString(), body: "" })).statusCode).toBe(200);
    expect((await texts(ID.thread)).filter((t: string[]) => /Picture or attachment/.test(t[1]))).toHaveLength(1);
    expect((await call("GET", "/texting/settings", "owner")).body.hookAt).toBeTruthy();
  });

  it("texts sent from Talkroute's own app join the conversation; Crewdesk's own aren't doubled", async () => {
    await call("POST", `/texting/threads/${ID.thread}`, "owner", { body: "See you Tuesday." });
    // Talkroute reports every outgoing text, including the one Crewdesk just sent.
    await hook({ event_id: crypto.randomUUID(), datetime: new Date().toISOString(), direction: "outgoing", from_number: "+14055550199", to_number: "+14055550101", body: "See you Tuesday." });
    await hook({ event_id: crypto.randomUUID(), datetime: new Date().toISOString(), direction: "outgoing", from_number: "+14055550199", to_number: "+14055550101", body: "Sent from the Talkroute app" });
    const all = await texts(ID.thread);
    expect(all.filter((t: string[]) => t[1] === "See you Tuesday.")).toEqual([["out", "See you Tuesday.", "office"]]);
    expect(all.at(-1)).toEqual(["out", "Sent from the Talkroute app", "talkroute"]);
    // A reply sent from Talkroute's app isn't an unread text for the office.
    await call("GET", `/texting/threads/${ID.thread}`, "owner");
    expect((await call("GET", "/texting/unread", "owner")).body.unread).toBe(0);
  });

  it("asking Talkroute for anything missed adds only what isn't here yet", async () => {
    const now = Date.now();
    const msg = (body: string, dir: "incoming" | "outgoing", at: number) => ({ id: crypto.randomUUID(), body, message_direction: dir, talkroute_number: "14055550199", contact_number: "14055550101", created_at: new Date(at).toISOString(), created_at_micro_seconds: at / 1000, attachments: [] });
    tr.convs = [{ conversation_id: "14055550199-14055550101", talkroute_number: "14055550199", contact_number: "14055550101", messages_count: 4 }];
    tr.messages["14055550199-14055550101"] = [
      msg("Thanks! Gate is open.", "incoming", now - 2000),       // already here, from its webhook
      msg("See you Tuesday.", "outgoing", now - 1000),            // Crewdesk's own
      msg("Sent from the Talkroute app", "outgoing", now - 500),  // already here
      msg("One the webhook missed", "incoming", now + 1000),
      msg("Long before texting was connected", "incoming", now - 86_400_000),
    ];
    const before = (await texts(ID.thread)).length;
    expect(await pollInboundTexts(true)).toBeGreaterThanOrEqual(1);
    const after = await texts(ID.thread);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toEqual(["in", "One the webhook missed", "office"]);
    // Asked again, nothing new.
    await pollInboundTexts(true);
    expect((await texts(ID.thread)).length).toBe(before + 1);
  });

  it("a picture texted in is fetched after the webhook (which carries neither the picture nor the text's own id)", async () => {
    const at = new Date();
    const id = crypto.randomUUID();
    tr.messages["14055550199-14055550101"] = [
      { id, body: "", message_direction: "incoming", talkroute_number: "14055550199", contact_number: "14055550101", created_at: at.toISOString(), created_at_micro_seconds: +at / 1000,
        attachments: [{ id: "att-1", file_type: "image", content_type: "image/png", link: `${base}/files/att-1?X-Amz-Expires=300` }] },
    ];
    const before = (await texts(ID.thread)).length;
    expect((await hook({ event_id: crypto.randomUUID(), datetime: at.toISOString(), direction: "incoming", from_number: "+14055550101", to_number: "+14055550199", body: "" })).statusCode).toBe(200);
    await flushTextLookups();
    const withPictures = (await call("GET", `/texting/threads/${ID.thread}?peek=1`, "owner")).body.texts.filter((t: any) => t.media.length);
    expect(withPictures).toHaveLength(1);
    const last = withPictures[0];
    expect(last).toMatchObject({ direction: "in", body: "" });
    const img = await app.inject({ method: "GET", url: `/texting/media/${last.media[0].id}`, headers: { authorization: `Bearer ${T.owner}` } });
    expect(img.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(img.rawPayload, png)).toBe(0);
    // Asking Talkroute for anything missed knows this text by its own id now: it isn't added twice.
    await pollInboundTexts(true);
    expect((await texts(ID.thread)).length).toBe(before + 1);
  });

  it("a picture goes out as Talkroute's API takes it", async () => {
    const boundary = "----tr";
    const res = await app.inject({
      method: "POST", url: `/texting/threads/${ID.thread}/picture`, headers: { authorization: `Bearer ${T.owner}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="body"\r\n\r\nHere's what we found.\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="found.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    expect(res.statusCode).toBe(200);
    const sentPic = tr.sends.at(-1)!;
    expect(sentPic).toMatchObject({ conv: "14055550199-14055550101", body: "Here's what we found." });
    expect(sentPic.attachment).toEqual({ fileType: "image/png", content: `data:image/png;base64,${png.toString("base64")}`, hash: crypto.createHash("md5").update(png).digest("hex") });
  });

  it("calls and voicemails come to their own signed addresses and show on the customer's page", async () => {
    const now = new Date();
    const callEvent = { event_id: crypto.randomUUID(), datetime: now.toISOString(), call_result: "missed", direction: "inbound", duration: 0, caller_number: "+14055550101", called_number: "+14055550199", caller_cname: "ASTER AMY" };
    expect((await hook(callEvent, { kind: "call", secret: `whsec_${crypto.randomBytes(32).toString("base64")}` })).statusCode).toBe(401);
    expect((await hook(callEvent, { kind: "call" })).statusCode).toBe(200);
    expect((await hook(callEvent, { kind: "call" })).statusCode).toBe(200);
    const vm = { event_id: crypto.randomUUID(), datetime: new Date(+now + 20_000).toISOString(), call_result: "missed", duration: 9, called_number: "+14055550199", caller_number: "+14055550101", transcription: "Hi it's Amy, please call me back.", mailbox_name: "Default Mailbox" };
    expect((await hook(vm, { kind: "voicemail" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${hookPath}/fax`, payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
    const calls = (await call("GET", `/texting/calls?customerId=${ID.amy}`, "owner")).body;
    expect(calls.on).toBe(true);
    expect(calls.rows.map((c: any) => [c.kind, c.direction, c.result, c.seconds, c.callerName])).toEqual([["voicemail", "in", "missed", 9, null], ["call", "in", "missed", 0, "ASTER AMY"]]);
    expect(calls.rows[0].transcript).toBe("Hi it's Amy, please call me back.");
    // Its recording, found in Talkroute by who left it and when.
    tr.voicemails = [{ id: "vm-77", callerNumber: "+14055550101", createdAt: new Date(+now + 21_000).toISOString() }, { id: "vm-old", callerNumber: "+14055550101", createdAt: new Date(+now - 86_400_000).toISOString() }];
    expect((await call("GET", `/texting/calls/${calls.rows[0].id}/audio`, "owner")).body.url).toBe("https://media.talkroute.test/voicemessages/vm-77");
  });

  it("customers are copied into Talkroute's contacts once (by their Crewdesk id)", async () => {
    expect((await call("POST", "/texting/settings/contacts", "owner")).status).toBe(200);
    await flushTextJobs();
    expect(tr.contacts).toEqual([{ externalId: ID.amy, name: "Amy Aster", phones: [{ phoneNumber: "+14055550101", type: "Mobile" }], emails: [email("amy")], notes: expect.stringMatching(/^Crewdesk customer #\d+$/) }]);
    expect((await call("GET", "/texting/settings", "owner")).body.contacts).toMatchObject({ done: 1, total: 1, added: 1, error: null });
    // Again: Talkroute skips the one it has.
    await call("POST", "/texting/settings/contacts", "owner");
    await flushTextJobs();
    expect(tr.contacts).toHaveLength(1);
    expect((await call("GET", "/texting/settings", "owner")).body.contacts).toMatchObject({ added: 0 });
  });

  it("past conversations are brought in from Talkroute", async () => {
    const day = 86_400_000, now = Date.now();
    const msg = (body: string, dir: "incoming" | "outgoing", at: number, contact: string) => ({ id: crypto.randomUUID(), body, message_direction: dir, talkroute_number: "14055550199", contact_number: contact, created_at: new Date(at).toISOString(), created_at_micro_seconds: at / 1000, attachments: [] });
    tr.convs = [{ conversation_id: "14055550199-14055550150", talkroute_number: "14055550199", contact_number: "14055550150", messages_count: 2 }];
    tr.messages["14055550199-14055550150"] = [msg("Thanks, see you in spring!", "outgoing", now - 20 * day + 60_000, "14055550150"), msg("Please skip us until spring.", "incoming", now - 20 * day, "14055550150"), msg("From last year", "incoming", now - 300 * day, "14055550150")];
    expect((await call("POST", "/texting/settings/history", "owner", { days: 30 })).status).toBe(200);
    await flushTextJobs();
    expect((await call("GET", "/texting/settings", "owner")).body.history).toMatchObject({ done: 1, total: 1, added: 2, error: null });
    const t = (await call("GET", "/texting/threads?q=5550150", "owner")).body.threads[0];
    expect(t).toMatchObject({ unread: 0, last: { body: "Thanks, see you in spring!", direction: "out" } });
    expect(await texts(t.id)).toEqual([["in", "Please skip us until spring.", "office"], ["out", "Thanks, see you in spring!", "talkroute"]]);
  });

  it("disconnecting takes the webhook off, and its address stops answering", async () => {
    const ids = tr.subs.map((x) => x.id);
    expect((await call("DELETE", "/texting/settings", "owner")).status).toBe(200);
    expect(tr.deleted).toEqual(expect.arrayContaining(ids));
    expect((await hook({ event_id: crypto.randomUUID(), datetime: new Date().toISOString(), direction: "incoming", from_number: "+14055550101", to_number: "+14055550199", body: "Anyone there?" })).statusCode).toBe(404);
    expect((await call("GET", "/texting/settings", "owner")).body).toMatchObject({ connected: false });
  });
});

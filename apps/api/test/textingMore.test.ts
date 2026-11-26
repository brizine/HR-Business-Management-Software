/**
 * Texting, beyond the basics: pictures both ways, notes and handing a conversation to one person,
 * quiet hours, the after-hours reply and the missed-call text, texts written to go later, quick
 * replies, bringing in past conversations, copying customers to the phone service, calls on the
 * customer's page, and a to-do from a text. Against a pretend provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { clockIn } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { TEXT_QUEUE, flushTextJobs, receiveCall, receiveText, releaseScheduledTexts, runTextQueue, setTextingProvider, type Inbound } from "../src/lib/texting";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

const suffix = Date.now();
const GOOD = `more-key-${suffix}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const sent: { to: string; body: string; picture: { type: string; bytes: number } | null }[] = [];
let past: Inbound[] = [];
const copied: { id: string; name: string; phones: string[]; notes?: string | null }[] = [];
const pushes: PushMessage[] = [];
TEXT_QUEUE.gapMs = 0;
setTextingProvider({
  ready: true,
  async check() { return { accountName: "More Co (test)" }; },
  async numbers() { return [{ number: "+14055550299", label: "Office", canSend: true }]; },
  async send(_c, to, body, picture) { sent.push({ to, body, picture: picture ? { type: picture.contentType, bytes: picture.data.length } : null }); return { id: `m_${suffix}_${sent.length}` }; },
  async download(ref) { return { data: png, contentType: ref.contentType ?? "image/png" }; },
  async history(c, _since, each, progress) { if (c.key !== GOOD) return; await progress(0, 1); for (const m of past) await each(m); await progress(1, 1); },
  async addContacts(_c, people) { copied.push(...people); return { added: people.length, skipped: 0 }; },
  async voicemailAudio() { return "https://media.example.test/voicemail-1.mp3"; },
});

let app: FastifyInstance;
const email = (x: string) => `${x}-${suffix}@more.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let companyId = "";
async function call(method: string, url: string, who: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}`, ...headers } });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers };
}
const boundary = "----txt";
const picture = (who: string, threadId: string, type = "image/png", caption = "", data = png) => call("POST", `/texting/threads/${threadId}/picture`, who, Buffer.concat([
  ...(caption ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="body"\r\n\r\n${caption}\r\n`)] : []),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="weeds.png"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`),
]), { "content-type": `multipart/form-data; boundary=${boundary}` });
const thread = async (id: string, who = "office") => (await call("GET", `/texting/threads/${id}?peek=1`, who)).body;
const titles = async (who: string) => { await flushNotifications(); const r = (await call("GET", "/notifications", who)).body; return (r.items ?? r).map((n: any) => n.title) as string[]; };
/** "HH:MM" in the company's time zone, some minutes from now. */
const clock = (plusMinutes: number) => { const m = (clockIn(new Date(), "America/Chicago").minutes + plusMinutes + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

beforeAll(async () => {
  setPushTransport({ send: async (m) => { pushes.push(...m); return m.map(() => ({ status: "ok" as const, id: "x" })); } });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "More Co", firstName: "Mo", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token; companyId = s.company.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "More Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", email: "office@more.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" });
  await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tia"), password: "password123", role: "employee", phone: "405-555-0242" });
  for (const who of ["office", "tia"]) T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  ID.amy = (await call("POST", "/customers", "office", { firstName: "Amy", lastName: "Aster", phone: "(405) 555-0201", email: email("amy") })).body.id;
  ID.bo = (await call("POST", "/customers", "office", { firstName: "Bo", lastName: "Birch", phone: "405-555-0202", altPhone: "405-555-0203", email: email("bo") })).body.id;
  await call("POST", "/customers", "office", { firstName: "Ned", lastName: "Nophone", delivery: ["paper"], billingStreet: "4 Elm St", billingCity: "Norman", billingZip: "73069" });
  expect((await call("PUT", "/texting/settings", "owner", { apiKey: GOOD, fromNumber: "405-555-0299" })).status).toBe(200);
  const people = (await call("GET", "/texting/settings/people", "owner")).body.people;
  ID.tia = people.find((p: any) => p.name === "Tia Tech").id;
  ID.olive = people.find((p: any) => p.name === "Olive Office").id;
  await call("PUT", "/texting/settings/notify", "owner", { employeeIds: [ID.tia, ID.olive] });
  await call("POST", "/notifications/devices", "tia", { token: `ExponentPushToken[tia-${suffix}]`, platform: "ios" });
  await call("POST", "/notifications/devices", "office", { token: `ExponentPushToken[olive-${suffix}]`, platform: "ios" });
});

afterAll(async () => {
  setTextingProvider(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("texting, the additions", () => {
  it("a picture a customer texts is kept with the conversation and with the customer's photos; the office can text one back", async () => {
    await receiveText(companyId, { id: `p_${suffix}_1`, from: "+14055550201", body: "What is this weed?", at: new Date(), media: [{ id: "a1", contentType: "image/png", link: "https://files.example.test/a1" }] });
    ID.amyThread = (await call("GET", "/texting/threads", "office")).body.threads[0].id;
    const got = (await thread(ID.amyThread)).texts.at(-1);
    expect(got).toMatchObject({ body: "What is this weed?", direction: "in" });
    expect(got.media).toHaveLength(1);
    expect(got.media[0]).toMatchObject({ contentType: "image/png" });
    const img = await call("GET", `/texting/media/${got.media[0].id}`, "tia");
    expect(img.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(img.raw, png)).toBe(0);
    // It's also with Amy's photos and documents.
    const files = (await call("GET", `/customers/${ID.amy}/files`, "office")).body;
    expect(files.map((f: any) => [f.contentType, /^Texted to us /.test(f.caption)])).toEqual([["image/png", true]]);
    // A picture with nothing typed shows as a picture, not as words.
    await receiveText(companyId, { id: `p_${suffix}_2`, from: "+14055550201", body: "[Picture or attachment. Open Talkroute to see it.]", at: new Date(), media: [{ id: "a2", contentType: "image/png", link: "https://files.example.test/a2" }] });
    expect((await thread(ID.amyThread)).texts.at(-1)).toMatchObject({ body: "" });
    expect((await call("GET", "/texting/threads", "office")).body.threads[0].last.body).toBe("📷 Picture");
    await flushNotifications();
    expect(pushes.at(-1)).toMatchObject({ title: "Text from Amy Aster", body: "📷 Picture" });

    // Texting one back, with words.
    const out = await picture("office", ID.amyThread, "image/png", "That's nutsedge. We can treat it.");
    expect(out.status).toBe(200);
    expect(sent.at(-1)).toEqual({ to: "+14055550201", body: "That's nutsedge. We can treat it.", picture: { type: "image/png", bytes: png.length } });
    expect((await thread(ID.amyThread)).texts.at(-1).media).toHaveLength(1);
    expect((await picture("office", ID.amyThread, "application/pdf")).body.error).toMatch(/JPG, PNG or GIF/);
    expect((await picture("office", ID.amyThread, "image/png", "", Buffer.alloc(1_600_000, 1))).body.error).toMatch(/too big to text/);
  });

  it("a note stays in the office; a conversation given to one person tells only them", async () => {
    const n = sent.length;
    expect((await call("POST", `/texting/threads/${ID.amyThread}/note`, "office", { body: "Called her; she'll decide by Friday." })).status).toBe(200);
    expect(sent.length).toBe(n);
    const note = (await thread(ID.amyThread)).texts.at(-1);
    expect(note).toMatchObject({ direction: "note", status: "note", body: "Called her; she'll decide by Friday.", by: "Olive Office" });
    // The list still shows the last real text.
    expect((await call("GET", "/texting/threads", "office")).body.threads[0].last.body).toBe("That's nutsedge. We can treat it.");

    expect((await call("GET", "/texting/people", "office")).body.people.map((p: any) => p.name)).toEqual(["Mo Owner", "Olive Office", "Tia Tech"]);
    expect((await call("POST", `/texting/threads/${ID.amyThread}/assign`, "office", { employeeId: ID.tia })).status).toBe(200);
    expect((await titles("tia"))[0]).toBe("Olive Office gave you a text conversation");
    expect((await call("GET", "/texting/threads?filter=mine", "tia")).body.threads.map((t: any) => [t.name, t.assignedName])).toEqual([["Amy Aster", "Tia Tech"]]);
    expect((await call("GET", "/texting/threads?filter=mine", "office")).body.threads).toHaveLength(0);
    const before = (await titles("office")).length;
    pushes.length = 0;
    await receiveText(companyId, { id: `p_${suffix}_3`, from: "+14055550201", body: "Friday works", at: new Date() });
    expect((await titles("tia"))[0]).toBe("Text from Amy Aster");
    expect((await titles("office")).length).toBe(before);
    expect(pushes.map((p) => p.to)).toEqual([`ExponentPushToken[tia-${suffix}]`]);
    // Given back to everyone.
    await call("POST", `/texting/threads/${ID.amyThread}/assign`, "office", { employeeId: null });
    await receiveText(companyId, { id: `p_${suffix}_4`, from: "+14055550201", body: "See you then", at: new Date() });
    expect((await titles("office")).length).toBe(before + 1);
  });

  it("someone in their quiet hours gets it in their inbox, with no buzz on their phone", async () => {
    expect((await call("PUT", "/texting/settings/quiet", "tia", { quiet: { start: clock(-60), end: clock(60) } })).status).toBe(200);
    expect((await call("GET", "/texting/settings", "tia")).body.myQuiet).toBeTruthy();
    // Only an admin sets someone else's.
    expect((await call("PUT", "/texting/settings/quiet", "tia", { employeeId: ID.olive, quiet: null })).status).toBe(403);
    pushes.length = 0;
    const before = (await titles("tia")).length;
    await receiveText(companyId, { id: `p_${suffix}_5`, from: "+14055550201", body: "Are you open Saturday?", at: new Date() });
    expect((await titles("tia")).length).toBe(before + 1);
    expect(pushes.map((p) => p.to)).toEqual([`ExponentPushToken[olive-${suffix}]`]);
    // Outside them, her phone buzzes again.
    await call("PUT", "/texting/settings/quiet", "owner", { employeeId: ID.tia, quiet: { start: clock(120), end: clock(180) } });
    pushes.length = 0;
    await receiveText(companyId, { id: `p_${suffix}_6`, from: "+14055550201", body: "Never mind, found it", at: new Date() });
    await flushNotifications();
    expect(pushes.map((p) => p.to).sort()).toEqual([`ExponentPushToken[olive-${suffix}]`, `ExponentPushToken[tia-${suffix}]`]);
    await call("PUT", "/texting/settings/quiet", "tia", { quiet: null });
  });

  it("the after-hours reply answers a text when the office is closed, once", async () => {
    const closed = { sun: null, mon: null, tue: null, wed: null, thu: null, fri: null, sat: null };
    const options = { autoReply: { enabled: true, message: "Thanks {{CUSTOMER_FIRST_NAME}}! {{COMPANY_NAME}} is closed; we'll answer in the morning.", hours: closed }, missedCall: { enabled: false, message: "" } };
    expect((await call("PUT", "/texting/settings/options", "office", options)).status).toBe(403);
    expect((await call("PUT", "/texting/settings/options", "owner", { ...options, autoReply: { ...options.autoReply, message: "" } })).body.error).toBeTruthy();
    expect((await call("PUT", "/texting/settings/options", "owner", options)).status).toBe(200);
    expect((await call("GET", "/texting/settings", "office")).body.options.autoReply).toMatchObject({ enabled: true });
    let n = sent.length;
    await receiveText(companyId, { id: `p_${suffix}_7`, from: "+14055550202", body: "Do you do aeration?", at: new Date() });
    expect(sent.slice(n)).toEqual([{ to: "+14055550202", body: "Thanks Bo! More Co is closed; we'll answer in the morning.", picture: null }]);
    ID.boThread = (await call("GET", "/texting/threads?q=birch", "office")).body.threads[0].id;
    expect((await thread(ID.boThread)).texts.at(-1)).toMatchObject({ direction: "out", source: "auto" });
    // Not again for the same conversation, not for STOP, not to the team, and not for old news.
    n = sent.length;
    await receiveText(companyId, { id: `p_${suffix}_8`, from: "+14055550202", body: "Hello?", at: new Date() });
    await receiveText(companyId, { id: `p_${suffix}_9`, from: "+14055550242", body: "Running late", at: new Date() });
    await receiveText(companyId, { id: `p_${suffix}_10`, from: "+14055550288", body: "From yesterday", at: new Date(Date.now() - 86_400_000) });
    expect(sent.length).toBe(n);
    // With the office open, nothing is sent back.
    const open = { open: "00:00", close: "23:59" };
    await call("PUT", "/texting/settings/options", "owner", { ...options, autoReply: { ...options.autoReply, hours: { sun: open, mon: open, tue: open, wed: open, thu: open, fri: open, sat: open } } });
    await receiveText(companyId, { id: `p_${suffix}_11`, from: "+14055550277", body: "New here", at: new Date() });
    expect(sent.length).toBe(n);
  });

  it("calls and voicemails show on the customer's page; a missed call gets the text, if that's on", async () => {
    const options = (await call("GET", "/texting/settings", "owner")).body.options;
    await call("PUT", "/texting/settings/options", "owner", { ...options, missedCall: { enabled: true, message: "Sorry we missed your call! This is {{COMPANY_NAME}}. Text us here." } });
    let n = sent.length;
    await receiveCall(companyId, { id: `c_${suffix}_1`, kind: "call", phone: "+14055550201", direction: "in", result: "answered", durationSeconds: 95, callerName: "ASTER AMY", transcript: null, at: new Date() });
    expect(sent.length).toBe(n);
    // Amy's conversation hasn't had an automatic text yet: a missed call gets one.
    await receiveCall(companyId, { id: `c_${suffix}_2`, kind: "call", phone: "+14055550201", direction: "in", result: "missed", durationSeconds: 0, callerName: null, transcript: null, at: new Date() });
    expect(sent.slice(n)).toEqual([{ to: "+14055550201", body: "Sorry we missed your call! This is More Co. Text us here.", picture: null }]);
    // The voicemail right after doesn't send a second one; the same event twice is kept once.
    n = sent.length;
    const vm = { id: `c_${suffix}_3`, kind: "voicemail" as const, phone: "+14055550201", direction: "in" as const, result: "missed" as const, durationSeconds: 12, callerName: null, transcript: "Hi, it's Amy, call me back about the weeds.", at: new Date() };
    await receiveCall(companyId, vm);
    expect(await receiveCall(companyId, vm)).toBeNull();
    expect(sent.length).toBe(n);
    const calls = (await call("GET", `/texting/calls?customerId=${ID.amy}`, "office")).body.rows;
    expect(calls.map((c: any) => [c.kind, c.result, c.seconds])).toEqual([["voicemail", "missed", 12], ["call", "missed", 0], ["call", "answered", 95]]);
    expect(calls[0].transcript).toMatch(/call me back about the weeds/);
    expect((await call("GET", `/texting/calls/${calls[0].id}/audio`, "office")).body.url).toBe("https://media.example.test/voicemail-1.mp3");
    expect((await call("GET", `/texting/calls/${calls[1].id}/audio`, "office")).status).toBe(404);
    expect((await call("GET", `/texting/calls?customerId=${ID.amy}`, "tia")).status).toBe(403);
  });

  it("a text can be written to go later, and taken back before it does", async () => {
    const n = sent.length;
    const soon = new Date(Date.now() + 20 * 60_000).toISOString();
    expect((await call("POST", `/texting/threads/${ID.boThread}`, "office", { body: "Too soon", sendAt: new Date(Date.now() + 5000).toISOString() })).body.error).toMatch(/at least a minute/);
    const later = (await call("POST", `/texting/threads/${ID.boThread}`, "office", { body: "Reminder: we're there tomorrow at 9.", sendAt: soon })).body;
    expect(later).toMatchObject({ status: "scheduled" });
    const second = (await call("POST", `/texting/threads/${ID.boThread}`, "office", { body: "This one gets taken back", sendAt: soon })).body;
    expect(sent.length).toBe(n);
    expect((await thread(ID.boThread)).texts.slice(-2).map((t: any) => [t.body, t.status, !!t.sendAt])).toEqual([["Reminder: we're there tomorrow at 9.", "scheduled", true], ["This one gets taken back", "scheduled", true]]);
    expect((await call("DELETE", `/texting/texts/${second.id}`, "office")).status).toBe(200);
    // Not yet its time: nothing goes.
    expect(await releaseScheduledTexts(new Date())).toBe(0);
    expect(await releaseScheduledTexts(new Date(Date.now() + 30 * 60_000))).toBeGreaterThanOrEqual(1);
    await runTextQueue();
    expect(sent.slice(n)).toEqual([{ to: "+14055550202", body: "Reminder: we're there tomorrow at 9.", picture: null }]);
    expect((await thread(ID.boThread)).texts.at(-1)).toMatchObject({ body: "Reminder: we're there tomorrow at 9.", status: "sent" });
    expect((await call("DELETE", `/texting/texts/${later.id}`, "office")).body.error).toMatch(/already gone/);
    // A send to several can wait too.
    const many = (await call("POST", "/texting/send", "office", { body: "Closed Monday for the holiday.", customerIds: [ID.amy, ID.bo], sendAt: soon })).body;
    expect(many).toMatchObject({ queued: 2 });
    await runTextQueue();
    expect(sent.length).toBe(n + 1);
    expect((await call("GET", "/texting/batches", "office")).body.rows[0]).toMatchObject({ scheduled: 2, sent: 0 });
    expect((await call("POST", `/texting/batches/${many.batchId}/stop`, "office")).body).toMatchObject({ dropped: 2 });
  });

  it("quick replies are saved once and a click away", async () => {
    const q = (await call("POST", "/texting/quick-replies", "tia", { title: "On our way", body: "We're on our way, {{CUSTOMER_FIRST_NAME}}!" })).body;
    expect((await call("POST", "/texting/quick-replies", "tia", { title: "", body: "x" })).status).toBe(400);
    expect((await call("GET", "/texting/quick-replies", "office")).body.rows).toEqual([{ id: q.id, title: "On our way", body: "We're on our way, {{CUSTOMER_FIRST_NAME}}!" }]);
    expect((await call("DELETE", `/texting/quick-replies/${q.id}`, "office")).status).toBe(200);
    expect((await call("GET", "/texting/quick-replies", "office")).body.rows).toEqual([]);
  });

  it("past conversations come in as history: nobody is told and nothing is unread", async () => {
    const day = 86_400_000;
    past = [
      { id: `h_${suffix}_1`, from: "+14055550260", body: "Can I get a quote for mowing?", at: new Date(Date.now() - 45 * day), direction: "in" },
      { id: `h_${suffix}_2`, from: "+14055550260", body: "Sure, $45 a visit.", at: new Date(Date.now() - 45 * day + 60_000), direction: "out" },
      { id: `h_${suffix}_3`, from: "+14055550203", body: "Gate code is 4321", at: new Date(Date.now() - 3 * day), direction: "in" },
    ];
    expect((await call("POST", "/texting/settings/history", "office", { days: 90 })).status).toBe(403);
    expect((await call("POST", "/texting/settings/history", "owner", { days: 45 })).status).toBe(400);
    pushes.length = 0;
    const before = (await titles("office")).length;
    const n = sent.length;
    expect((await call("POST", "/texting/settings/history", "owner", { days: 90 })).status).toBe(200);
    await flushTextJobs();
    expect((await call("GET", "/texting/settings", "owner")).body.history).toMatchObject({ done: 1, total: 1, added: 3, error: null });
    const old = (await call("GET", "/texting/threads?q=5550260", "office")).body.threads[0];
    expect(old).toMatchObject({ kind: "unknown", unread: 0, status: "done", last: { body: "Sure, $45 a visit.", direction: "out" } });
    // Bo's other number: filed under Bo, still open (it's recent), nothing unread.
    expect((await call("GET", "/texting/threads?q=5550203", "office")).body.threads[0]).toMatchObject({ name: "Bo Birch", unread: 0, status: "open" });
    expect((await titles("office")).length).toBe(before);
    expect(pushes).toHaveLength(0);
    expect(sent.length).toBe(n);
    // Bringing it in again adds nothing.
    await call("POST", "/texting/settings/history", "owner", { days: 90 });
    await flushTextJobs();
    expect((await call("GET", "/texting/settings", "owner")).body.history.added).toBe(0);
  });

  it("customers with a number are copied into the phone service's contacts", async () => {
    expect((await call("POST", "/texting/settings/contacts", "owner")).status).toBe(200);
    await flushTextJobs();
    expect((await call("GET", "/texting/settings", "owner")).body.contacts).toMatchObject({ done: 2, total: 2, added: 2, error: null });
    expect(copied.map((p) => [p.name, p.phones]).sort()).toEqual([["Amy Aster", ["+14055550201"]], ["Bo Birch", ["+14055550202", "+14055550203"]]]);
    expect(copied.find((p) => p.name === "Amy Aster")).toMatchObject({ id: ID.amy });
    expect(copied[0].notes).toMatch(/^Crewdesk customer #\d+$/);
  });

  it("a to-do is made from a text in one go", async () => {
    await receiveText(companyId, { id: `p_${suffix}_12`, from: "+14055550202", body: "Can someone come look at the dead patch by the driveway?", at: new Date() });
    const made = (await call("POST", `/texting/threads/${ID.boThread}/todo`, "tia", {})).body;
    expect(made.title).toBe("Bo Birch: Can someone come look at the dead patch by the driveway?");
    const todo = (await call("GET", `/todos/${made.id}`, "tia")).body;
    expect(todo).toMatchObject({ title: made.title, customer: { id: ID.bo } });
    expect(todo.notes).toMatch(/From a text on .* \(\(405\) 555-0202\):\n"Can someone come look at the dead patch by the driveway\?"/);
    expect((todo.assignees ?? []).map((a: any) => a.id ?? a.employeeId)).toContain(ID.tia);
    expect((await thread(ID.boThread)).texts.at(-1)).toMatchObject({ direction: "note", body: `To-do made: ${made.title}` });
  });

  it("none of it rides along with a signed-in person's company details", async () => {
    const me = (await call("GET", "/auth/me", "tia")).body;
    expect(Object.keys(me.company).filter((k) => /texting/i.test(k))).toEqual([]);
  });
});

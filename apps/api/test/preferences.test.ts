/** Notification preferences and email/SMS delivery, with in-memory transports. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { SmsError, setEmailTransport, setSmsTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let pushes: PushMessage[] = [];
let emails: EmailMessage[] = [];
let texts: { to: string; body: string }[] = [];
let stopped = new Set<string>();
const suffix = Date.now();
const people: Record<"owner" | "app" | "noapp", { token: string; id: string; email: string }> = {} as never;
const device = `ExponentPushToken[app-${suffix}]`;

async function call(method: string, url: string, who?: keyof typeof people, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: { ...(who ? { authorization: `Bearer ${people[who].token}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.json() };
}

/** Triggers a "documents" notification to `who` (a document that needs their signature). */
async function sendDocTo(who: keyof typeof people) {
  const boundary = "----x";
  const payload = [
    `--${boundary}\r\nContent-Disposition: form-data; name="employeeId"\r\n\r\n${people[who].id}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="requiresSignature"\r\n\r\ntrue`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="handbook.txt"\r\nContent-Type: text/plain\r\n\r\nhello`,
    `--${boundary}--\r\n`,
  ].join("\r\n");
  const res = await call("POST", "/documents", "owner", payload, { "content-type": `multipart/form-data; boundary=${boundary}` });
  expect(res.status).toBe(200);
  await flushNotifications();
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => (pushes.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  setEmailTransport({ send: async (m) => void emails.push(m) });
  setSmsTransport({
    send: async (to, body) => {
      if (stopped.has(to)) throw new SmsError(21610, "Unsubscribed");
      texts.push({ to, body });
    },
  });
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Prefs Co", firstName: "Pat", lastName: "Owner", email: `pat-${suffix}@test.dev`, password: "password123",
  });
  people.owner = { token: signup.body.token, id: signup.body.user.id, email: `pat-${suffix}@test.dev` };
  for (const [key, phone] of [["app", "(512) 555-0100"], ["noapp", "512.555.0199"]] as const) {
    const email = `${key}-${suffix}@test.dev`;
    const e = await call("POST", "/employees", "owner", { firstName: key, lastName: "Person", email, phone, password: "password123" });
    const login = await call("POST", "/auth/login", undefined, { email, password: "password123" });
    people[key] = { token: login.body.token, id: e.body.id, email };
  }
  await call("POST", "/notifications/devices", "app", { token: device, platform: "android" });
});

beforeEach(async () => {
  await flushNotifications();
  pushes = [];
  emails = [];
  texts = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  setEmailTransport(null);
  setSmsTransport(null);
  await pool.end();
});

describe("defaults", () => {
  it("app users get push; people without the app get email instead", async () => {
    await sendDocTo("app");
    expect(pushes.map((p) => p.to)).toEqual([device]);
    expect(emails).toHaveLength(0);

    await sendDocTo("noapp");
    expect(emails.map((e) => e.to)).toEqual([people.noapp.email]);
    expect(emails[0].subject).toBe("Document ready for your signature");
    expect(emails[0].text).toContain("/documents");
    expect(emails[0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(texts).toHaveLength(0); // texts are off by default
  });

  it("reports defaults and which channels are available", async () => {
    const res = await call("GET", "/notifications/preferences", "noapp");
    expect(res.body.hasApp).toBe(false);
    expect(res.body.channels).toEqual({ email: true, sms: false });
    expect(res.body.preferences).toHaveLength(8);
    expect(res.body.preferences[0]).toEqual({ category: "pto", app: true, email: "no_app", sms: "never" });
  });
});

describe("muting and channels", () => {
  it("muting a category's app channel stops inbox and push for it only", async () => {
    await call("PUT", "/notifications/preferences", "app", { preferences: [{ category: "documents", app: false, email: "never", sms: "never" }] });
    const before = (await call("GET", "/notifications/unread-count", "app")).body.unread;
    await sendDocTo("app");
    expect(pushes).toHaveLength(0);
    expect(emails).toHaveLength(0);
    expect((await call("GET", "/notifications/unread-count", "app")).body.unread).toBe(before);
  });

  it("email 'always' sends even with the app installed", async () => {
    await call("PUT", "/notifications/preferences", "app", { preferences: [{ category: "documents", app: true, email: "always", sms: "never" }] });
    await sendDocTo("app");
    expect(pushes).toHaveLength(1);
    expect(emails.map((e) => e.to)).toEqual([people.app.email]);
  });

  it("texts need the company switch, opt-in and a valid number", async () => {
    const prefs = { preferences: [{ category: "documents", app: true, email: "never", sms: "no_app" }] };
    await call("PUT", "/notifications/preferences", "noapp", { ...prefs, smsOptIn: true });
    await sendDocTo("noapp");
    expect(texts).toHaveLength(0); // company hasn't enabled SMS

    expect((await call("PUT", "/notifications/company-settings", "noapp", { smsEnabled: true })).status).toBe(403);
    await call("PUT", "/notifications/company-settings", "owner", { smsEnabled: true });
    await sendDocTo("noapp");
    expect(texts).toEqual([{ to: "+15125550199", body: expect.stringContaining("Prefs Co: Document ready for your signature") }]);
    expect(texts[0].body).toMatch(/Reply STOP to opt out\.$/);
  });

  it("records an opt-out when the carrier says the number replied STOP", async () => {
    stopped.add("+15125550199");
    await sendDocTo("noapp");
    expect(texts).toHaveLength(0);
    expect((await call("GET", "/notifications/preferences", "noapp")).body.employee.smsOptIn).toBe(false);
    stopped.clear();
  });

  it("won't opt in to texts without a usable phone number", async () => {
    await call("PATCH", `/employees/${people.app.id}`, "owner", { phone: "123" });
    const res = await call("PUT", "/notifications/preferences", "app", { smsOptIn: true });
    expect(res.status).toBe(400);
  });
});

describe("permissions and unsubscribe", () => {
  it("employees can't change someone else's settings; admins can", async () => {
    expect((await call("GET", `/notifications/preferences?employeeId=${people.noapp.id}`, "app")).status).toBe(403);
    const res = await call("PUT", `/notifications/preferences?employeeId=${people.noapp.id}`, "owner", {
      preferences: [{ category: "hiring", app: false, email: "never", sms: "never" }],
    });
    expect(res.body.preferences.find((p: { category: string }) => p.category === "hiring").app).toBe(false);
  });

  it("one-click unsubscribe turns off that category's emails", async () => {
    await call("PUT", "/notifications/preferences", "noapp", { preferences: [{ category: "documents", app: true, email: "no_app", sms: "never" }] });
    await sendDocTo("noapp");
    const header = emails[0].headers!["List-Unsubscribe"];
    const url = new URL(header.slice(1, -1));

    // Mail clients POST "List-Unsubscribe=One-Click" as a form.
    const res = await app.inject({
      method: "POST",
      url: url.pathname + url.search,
      payload: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe("Documents");

    emails = [];
    await sendDocTo("noapp");
    expect(emails).toHaveLength(0);
  });

  it("rejects tampered tokens", async () => {
    const res = await call("POST", "/public/unsubscribe?token=abc.def");
    expect(res.status).toBe(400);
  });
});

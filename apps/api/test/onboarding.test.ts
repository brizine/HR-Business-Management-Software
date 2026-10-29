/** Hiring → invite → new hire uploads/signs → managers' tasks → active, with notifications and reminders. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, setSmsTransport, type EmailMessage } from "../src/lib/channels";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let emails: EmailMessage[] = [];
let pushes: PushMessage[] = [];
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@onb.test`;
const T: Record<string, string> = {}; // tokens
const ID: Record<string, string> = {}; // ids

async function call(method: string, url: string, who?: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: { ...(who ? { authorization: `Bearer ${T[who] ?? who}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.body };
}

function multipart(content: string, filename = "license.jpg") {
  const boundary = "----x";
  return {
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function pushTitles(who: string) {
  await flushNotifications();
  return pushes.filter((p) => p.to === `ExponentPushToken[${who}-${suffix}]`).map((p) => p.title);
}

const inviteToken = (m: EmailMessage) => m.text.match(/welcome\?token=([\w-]+)/)![1];

beforeAll(async () => {
  setEmailTransport({ send: async (m) => void emails.push(m) });
  setSmsTransport(null);
  setPushTransport({ send: async (m) => (pushes.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Onboard Co", firstName: "Olive", lastName: "Owner", email: email("owner"), password: "password123",
  });
  T.owner = signup.body.token;
  ID.owner = signup.body.user.id;
  const mgr = await call("POST", "/employees", "owner", {
    firstName: "Mo", lastName: "Manager", email: email("mgr"), role: "manager", password: "password123",
  });
  ID.mgr = mgr.body.id;
  T.mgr = (await call("POST", "/auth/login", undefined, { email: email("mgr"), password: "password123" })).body.token;
  await call("POST", "/notifications/devices", "mgr", { token: `ExponentPushToken[mgr-${suffix}]`, platform: "ios" });

  // A company-wide handbook every new hire signs.
  const boundary = "----h";
  const res = await app.inject({
    method: "POST",
    url: "/documents",
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nEmployee handbook\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="handbook.txt"\r\nContent-Type: text/plain\r\n\r\nBe safe. Be on time.\r\n--${boundary}--\r\n`,
    headers: { authorization: `Bearer ${T.owner}`, "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  ID.handbook = res.json().id;
});

beforeEach(async () => {
  await flushNotifications();
  emails = [];
  pushes = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("checklist templates", () => {
  const base = { assignee: "employee", dueInDays: 0 };

  it("validates task kinds", async () => {
    const bad = (task: object) => call("POST", "/onboarding/templates", "owner", { name: "x", tasks: [{ title: "t", ...base, ...task }] });
    expect((await bad({ action: "sign" })).status).toBe(400); // no document
    expect((await bad({ action: "upload", assignee: "manager" })).status).toBe(400); // only the new hire uploads
    expect((await bad({ action: "sign", documentId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400);
  });

  it("saves a template with check-off, upload, sign, manager and admin tasks", async () => {
    const res = await call("POST", "/onboarding/templates", "owner", {
      name: "Crew",
      tasks: [
        { title: "Fill out W-4 with payroll", ...base },
        { title: "Upload driver's license", ...base, dueInDays: 1, action: "upload" },
        { title: "Sign employee handbook", ...base, dueInDays: 1, action: "sign", documentId: ID.handbook },
        { title: "Safety walkthrough", assignee: "manager", dueInDays: 5 },
        { title: "Verify I-9 documents", assignee: "admin", dueInDays: 3 },
      ],
    });
    expect(res.status).toBe(200);
    ID.template = res.body.id;
  });
});

describe("hire → invite → onboarding", () => {
  it("the hire form sets details, starts the checklist and emails an invite", async () => {
    const job = await call("POST", "/jobs", "owner", { title: "Driver", department: "Field" });
    const applicant = await call("POST", `/jobs/${job.body.id}/applicants`, "owner", { firstName: "Nia", lastName: "New", email: email("nia") });
    const hired = await call("POST", `/applicants/${applicant.body.id}/hire`, "owner", {
      startDate: "2030-02-04", managerId: ID.mgr, payRateCents: 2250, templateId: undefined, onboardingTemplateId: ID.template,
    });
    expect(hired.status).toBe(200);
    ID.nia = hired.body.id;
    expect(hired.body).toMatchObject({ status: "onboarding", title: "Driver", department: "Field", managerId: ID.mgr, payRateCents: 2250, tasks: 5 });
    expect(hired.body.hasLogin).toBe(false);
    expect(hired.body.invite.emailed).toBe(true);
    expect((await call("POST", `/applicants/${applicant.body.id}/hire`, "owner", {})).status).toBe(409);

    // Just the invite: no separate "welcome" notification pointing at a page they can't open yet.
    expect(emails.filter((m) => m.to === email("nia"))).toHaveLength(1);
    const invite = emails.find((m) => m.to === email("nia"))!;
    expect(invite.subject).toBe("Welcome to Onboard Co: set up your Crewdesk account");
    expect(invite.text).toContain("Olive Owner has invited you to Crewdesk");
    T.niaInvite = inviteToken(invite);

    // The manager hears about their task; the hiring owner doesn't get pinged about their own action.
    expect(await pushTitles("mgr")).toEqual(["New hire Nia New (starts 2030-02-04): 1 task for you"]);
  });

  it("the new hire sets a password from the invite (once) and lands signed in", async () => {
    const info = await call("GET", `/auth/invite?token=${T.niaInvite}`);
    expect(info.body).toEqual({ firstName: "Nia", email: email("nia"), company: "Onboard Co", startDate: "2030-02-04" });
    expect((await call("POST", "/auth/reset-password", undefined, { token: T.niaInvite, password: "sneaky-pass-1" })).status).toBe(400);

    const accepted = await call("POST", "/auth/accept-invite", undefined, { token: T.niaInvite, password: "nia-password" });
    expect(accepted.status).toBe(200);
    T.nia = accepted.body.token;
    expect((await call("GET", "/auth/me", "nia")).body.user.email).toBe(email("nia"));
    expect((await call("POST", "/auth/accept-invite", undefined, { token: T.niaInvite, password: "again-pass-1" })).status).toBe(400);
  });

  it("upload and sign tasks can't just be checked off", async () => {
    const tasks = (await call("GET", "/onboarding/tasks", "nia")).body as any[];
    ID.w4 = tasks.find((t) => t.title.startsWith("Fill out W-4")).id;
    ID.license = tasks.find((t) => t.action === "upload").id;
    const sign = tasks.find((t) => t.action === "sign");
    ID.signTask = sign.id;
    ID.niaHandbook = sign.document.id;
    expect(sign.document).toMatchObject({ name: "Employee handbook", signedAt: null });
    expect(ID.niaHandbook).not.toBe(ID.handbook); // their own copy to sign

    expect((await call("POST", `/onboarding/tasks/${ID.license}/complete`, "nia")).body.error).toMatch(/Upload the document/);
    expect((await call("POST", `/onboarding/tasks/${ID.signTask}/complete`, "nia")).body.error).toMatch(/Sign the document/);
  });

  it("uploading or signing finishes the task; the manager hears when paperwork is done", async () => {
    const { payload, headers } = multipart("JPEG-BYTES");
    const up = await call("POST", `/onboarding/tasks/${ID.license}/upload`, "nia", payload, headers);
    expect(up.status).toBe(200);
    expect(up.body.completedAt).toBeTruthy();
    const docs = (await call("GET", `/documents?employeeId=${ID.nia}`, "owner")).body as any[];
    expect(docs.map((d) => d.name)).toContain("Upload driver's license: license.jpg");

    // Read the handbook through a short-lived view link (as the phone app does), then sign it.
    const link = await call("POST", `/documents/${ID.niaHandbook}/link`, "nia");
    expect((await call("GET", link.body.path)).body).toBe("Be safe. Be on time.");
    expect((await call("GET", "/auth/me", link.body.path.split("t=")[1])).status).toBe(401); // not a session
    expect((await call("POST", `/documents/${ID.niaHandbook}/sign`, "nia", { signedName: "Nia New" })).status).toBe(200);

    await call("POST", `/onboarding/tasks/${ID.w4}/complete`, "nia");
    const tasks = (await call("GET", "/onboarding/tasks", "nia")).body as any[];
    expect(tasks.filter((t) => t.assignee === "employee").every((t) => t.completedAt)).toBe(true);
    expect(await pushTitles("mgr")).toEqual(["Nia New finished their onboarding paperwork"]);
  });

  it("managers and admins see the tasks waiting on them; finishing everything makes the hire active", async () => {
    const mine = (await call("GET", "/onboarding/assigned", "mgr")).body as any[];
    expect(mine.map((t) => t.title)).toEqual(["Safety walkthrough"]);
    const owners = (await call("GET", "/onboarding/assigned", "owner")).body as any[];
    expect(owners.map((t) => t.title)).toEqual(["Verify I-9 documents"]);

    expect((await call("POST", `/onboarding/tasks/${owners[0].id}/complete`, "mgr")).status).toBe(403); // admin's task
    await call("POST", `/onboarding/tasks/${mine[0].id}/complete`, "mgr");
    await call("POST", `/onboarding/tasks/${owners[0].id}/complete`, "owner");
    expect((await call("GET", `/employees/${ID.nia}`, "owner")).body.status).toBe("active");
    expect(await pushTitles("mgr")).toContain("Nia New is fully onboarded");
  });
});

describe("invites without hiring", () => {
  it("adding someone without a password invites them by default", async () => {
    const res = await call("POST", "/employees", "owner", { firstName: "Ivy", lastName: "Invite", email: email("ivy") });
    expect(res.body.invite.emailed).toBe(true);
    expect(res.body.invitedAt).toBeTruthy();
    const quiet = await call("POST", "/employees", "owner", { firstName: "Quinn", lastName: "Q", email: email("quinn"), sendInvite: false });
    expect(quiet.body.invite).toBeNull();
    ID.ivy = res.body.id;
    ID.quinn = quiet.body.id;
  });

  it("resending replaces the old link; people with a login can't be re-invited", async () => {
    const old = inviteToken(emails.find((m) => m.to === email("ivy")) ?? (await call("POST", `/employees/${ID.ivy}/invite`, "owner"), emails.at(-1)!));
    emails = [];
    const again = await call("POST", `/employees/${ID.ivy}/invite`, "owner");
    expect(again.body.link).toContain("/welcome?token=");
    expect((await call("GET", `/auth/invite?token=${old}`)).status).toBe(400);
    expect((await call("GET", `/auth/invite?token=${inviteToken(emails[0])}`)).status).toBe(200);
    expect((await call("POST", `/employees/${ID.mgr}/invite`, "owner")).status).toBe(409);
    expect((await call("POST", `/employees/${ID.ivy}/invite`, "mgr")).status).toBe(403);
  });
});

describe("reminders", () => {
  it("sends one digest per person for due and overdue tasks, once", async () => {
    const res = await call("POST", "/employees", "owner", {
      firstName: "Lou", lastName: "Late", email: email("lou"), startDate: "2030-01-01", managerId: ID.mgr, password: "password123", status: "onboarding",
    });
    const lou = (await call("POST", "/auth/login", undefined, { email: email("lou"), password: "password123" })).body.token;
    await call("POST", "/notifications/devices", lou, { token: `ExponentPushToken[lou-${suffix}]`, platform: "android" });
    await call("POST", "/onboarding/assign", "owner", { employeeId: res.body.id, templateId: ID.template });
    await flushNotifications();
    pushes = [];

    // 9am Chicago on Jan 6 2030: W-4 (day 0) and license/handbook (day 1) are overdue; walkthrough (day 5) is due today.
    const at = new Date("2030-01-06T15:00:00Z");
    await runScheduledChecks(at);
    await flushNotifications();
    const louMsgs = pushes.filter((p) => p.to.includes(`lou-${suffix}`));
    expect(louMsgs).toHaveLength(1);
    expect(louMsgs[0].title).toBe("3 onboarding tasks need attention");
    expect(louMsgs[0].body).toContain("Overdue: Upload driver's license");
    const mgrMsgs = pushes.filter((p) => p.to.includes(`mgr-${suffix}`) && p.title.startsWith("Onboarding"));
    expect(mgrMsgs.map((m) => m.body)).toEqual(["Due today: Safety walkthrough (Lou Late)"]);

    pushes = [];
    await runScheduledChecks(at);
    await flushNotifications();
    expect(pushes.filter((p) => p.title.includes("onboarding task") || p.title.startsWith("Onboarding"))).toHaveLength(0);
  });

  it("doesn't remind people before 7am", async () => {
    pushes = [];
    await runScheduledChecks(new Date("2030-01-07T10:00:00Z")); // 4am Chicago; the walkthrough is overdue now
    await flushNotifications();
    expect(pushes.filter((p) => p.title.startsWith("Onboarding") || p.title.includes("onboarding task"))).toHaveLength(0);
  });
});

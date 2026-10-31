/** Account security: two-factor sign-in, lockout, sessions, admin limits and password resets. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db, pool } from "../src/db";
import { employees, pushTokens } from "../src/db/schema";
import { setEmailTransport, setSmsTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { codeAt, currentStep } from "../src/lib/totp";

let app: FastifyInstance;
let emails: EmailMessage[] = [];
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@sec.test`;
let ownerToken: string;
let ownerId: string;

async function call(method: string, url: string, token?: string, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.json() };
}

const login = (who: string, password = "password123") => call("POST", "/auth/login", undefined, { email: email(who), password });

/** Creates a staff member with a login and returns their id. */
async function hire(who: string, role = "employee") {
  const res = await call("POST", "/employees", ownerToken, { firstName: who, lastName: "Test", email: email(who), password: "password123", role });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

/** Walks the "two-factor required" setup flow and returns the secret, session and backup codes. */
async function setUpTwoFactor(setupToken: string) {
  const setup = await call("POST", "/auth/mfa/setup", setupToken);
  expect(setup.status).toBe(200);
  const enable = await call("POST", "/auth/mfa/enable", setupToken, { code: codeAt(setup.body.secret, currentStep()) });
  expect(enable.status).toBe(200);
  return { secret: setup.body.secret as string, token: enable.body.token as string, codes: enable.body.recoveryCodes as string[] };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "t" })) });
  setEmailTransport({ send: async (m) => void emails.push(m) });
  setSmsTransport(null);
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Secure Co", firstName: "Sky", lastName: "Owner", email: email("owner"), password: "password123",
  });
  ownerToken = signup.body.token;
  ownerId = signup.body.user.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("two-factor sign-in", () => {
  let secret: string;
  let codes: string[];

  it("owners and admins must set it up by default; a setup token can't do anything else", async () => {
    const first = await login("owner");
    expect(first.body).toMatchObject({ mfaSetupRequired: true });
    expect(first.body.token).toBeUndefined();
    expect((await call("GET", "/employees", first.body.setupToken)).status).toBe(401);

    expect((await call("POST", "/auth/mfa/enable", first.body.setupToken, { code: "000000" })).status).toBe(400); // not started
    const done = await setUpTwoFactor(first.body.setupToken);
    ({ secret, codes } = done);
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect((await call("GET", "/employees", done.token)).status).toBe(200);
    ownerToken = done.token;
  });

  it("then asks for a code after the password, and won't accept the same code twice", async () => {
    const step1 = await login("owner");
    expect(step1.body).toMatchObject({ mfaRequired: true });
    expect((await call("GET", "/employees", step1.body.mfaToken)).status).toBe(401);
    expect((await call("POST", "/auth/login/mfa", step1.body.mfaToken, { code: "123456" })).status).toBe(401);

    // The setup code used the current step; the next one is still within the drift window.
    const code = codeAt(secret, currentStep() + 1);
    const ok = await call("POST", "/auth/login/mfa", step1.body.mfaToken, { code });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodesLeft).toBe(10);
    ownerToken = ok.body.token;

    const again = await login("owner");
    expect((await call("POST", "/auth/login/mfa", again.body.mfaToken, { code })).status).toBe(401);
  });

  it("backup codes work once", async () => {
    const a = await login("owner");
    const ok = await call("POST", "/auth/login/mfa", a.body.mfaToken, { code: codes[0].toUpperCase() });
    expect(ok.body.recoveryCodesLeft).toBe(9);
    const b = await login("owner");
    expect((await call("POST", "/auth/login/mfa", b.body.mfaToken, { code: codes[0] })).status).toBe(401);
    ownerToken = ok.body.token;
  });

  it("can't be turned off while the company requires it", async () => {
    const res = await call("POST", "/auth/mfa/disable", ownerToken, { password: "password123", code: codes[1] });
    expect(res.status).toBe(403);
  });

  it("security status reports it", async () => {
    const res = await call("GET", "/auth/security", ownerToken);
    expect(res.body).toMatchObject({ twoFactorEnabled: true, twoFactorRequired: true, policy: "admin" });
  });
});

describe("lockout", () => {
  it("locks after 5 wrong passwords, even for the right one, until unlocked", async () => {
    const id = await hire("locky");
    for (let i = 0; i < 5; i++) expect((await login("locky", "wrong-password")).status).toBe(401);
    const locked = await login("locky");
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/Try again in 15 minutes/);
    expect((await call("GET", `/employees/${id}`, ownerToken)).body.locked).toBe(true);

    await call("POST", `/employees/${id}/unlock`, ownerToken);
    expect((await login("locky")).status).toBe(200);
  });

  it("doesn't reveal whether an email exists", async () => {
    const res = await call("POST", "/auth/login", undefined, { email: email("nobody"), password: "password123" });
    expect(res).toEqual({ status: 401, body: { error: "Invalid email or password" } });
  });
});

describe("sessions", () => {
  it("sign out everywhere ends every session and removes push devices", async () => {
    const id = await hire("phoney");
    const a = (await login("phoney")).body.token;
    const b = (await login("phoney")).body.token;
    await call("POST", "/notifications/devices", a, { token: `ExponentPushToken[phoney-${suffix}]`, platform: "ios" });
    expect((await call("POST", "/auth/logout-all", a)).status).toBe(200);
    expect((await call("GET", "/auth/me", a)).status).toBe(401);
    expect((await call("GET", "/auth/me", b)).status).toBe(401);
    expect(await db.select().from(pushTokens).where(eq(pushTokens.employeeId, id))).toHaveLength(0);
  });

  it("making someone inactive and role changes take effect immediately", async () => {
    const id = await hire("leaver", "manager");
    const token = (await login("leaver")).body.token;
    expect((await call("GET", "/time/timesheets", token)).status).toBe(200);

    // Demoted: the old session is ended, and a new one has employee rights.
    await call("PATCH", `/employees/${id}`, ownerToken, { role: "employee" });
    expect((await call("GET", "/time/timesheets", token)).status).toBe(401);
    const newToken = (await login("leaver")).body.token;
    expect((await call("GET", "/time/timesheets", newToken)).status).toBe(403);

    const updated = await call("PATCH", `/employees/${id}`, ownerToken, { status: "inactive" });
    expect(updated.body.status).toBe("inactive");
    expect((await call("GET", "/auth/me", newToken)).status).toBe(401);
    expect((await login("leaver")).status).toBe(401);
  });

  it("terminated people are locked out like inactive ones", async () => {
    const id = await hire("fired", "employee");
    const token = (await login("fired")).body.token;
    expect((await call("GET", "/auth/me", token)).status).toBe(200);

    const updated = await call("PATCH", `/employees/${id}`, ownerToken, { status: "terminated" });
    expect(updated.body.status).toBe("terminated");
    expect((await call("GET", "/auth/me", token)).status).toBe(401);
    expect((await login("fired")).status).toBe(401);
    expect((await call("POST", `/employees/${id}/invite`, ownerToken, {})).status).toBe(409);

    // Moving between inactive and terminated keeps them locked out; making them active lets them back in.
    expect((await call("PATCH", `/employees/${id}`, ownerToken, { status: "inactive" })).body.status).toBe("inactive");
    expect((await login("fired")).status).toBe(401);
    await call("PATCH", `/employees/${id}`, ownerToken, { status: "active" });
    expect((await login("fired")).status).toBe(200);
  });

  it("home address and emergency contact: set by admins or yourself, seen by managers and yourself", async () => {
    const id = await hire("homebody", "employee");
    await hire("nosy", "employee");
    await hire("lead2", "manager");
    const selfToken = (await login("homebody")).body.token;
    const nosyToken = (await login("nosy")).body.token;
    const leadToken = (await login("lead2")).body.token;

    const set = await call("PATCH", `/employees/${id}`, ownerToken, { addressLine1: "12 Elm St", city: "Austin", state: "tx", zip: "78701", emergencyName: "Pat Home", emergencyRelationship: "Spouse", emergencyPhone: "512-555-0100" });
    expect(set.status).toBe(200);
    expect(set.body.state).toBe("TX");
    expect((await call("PATCH", `/employees/${id}`, ownerToken, { zip: "7870" })).status).toBe(400);
    expect((await call("PATCH", `/employees/${id}`, ownerToken, { state: "Texas" })).status).toBe(400);

    expect((await call("GET", `/employees/${id}`, leadToken)).body.emergencyName).toBe("Pat Home");
    expect((await call("GET", `/employees/${id}`, selfToken)).body.addressLine1).toBe("12 Elm St");
    const nosy = (await call("GET", `/employees/${id}`, nosyToken)).body;
    for (const f of ["addressLine1", "city", "state", "zip", "emergencyName", "emergencyPhone"]) expect(nosy).not.toHaveProperty(f);
    expect((await call("GET", "/employees", nosyToken)).body.find((e: any) => e.id === id)).not.toHaveProperty("addressLine1");

    // Employees update their own; an empty value clears it; they can't touch anything else this way.
    // Date of birth: private like the address, and must be a real past date.
    expect((await call("PATCH", `/employees/${id}`, ownerToken, { dateOfBirth: "1990-04-23" })).body.dateOfBirth).toBe("1990-04-23");
    expect((await call("GET", `/employees/${id}`, nosyToken)).body).not.toHaveProperty("dateOfBirth");
    expect((await call("GET", `/employees/${id}`, leadToken)).body.dateOfBirth).toBe("1990-04-23");
    expect((await call("PATCH", "/employees/me/profile", selfToken, { dateOfBirth: "2999-01-01" })).status).toBe(400);
    expect((await call("PATCH", "/employees/me/profile", selfToken, { dateOfBirth: "1990-02-30" })).status).toBe(400);

    const mine = await call("PATCH", "/employees/me/profile", selfToken, { addressLine2: "Apt 4", emergencyPhone: "", payRateCents: 999999, role: "owner" });
    expect(mine.status).toBe(200);
    expect(mine.body.addressLine2).toBe("Apt 4");
    expect(mine.body.emergencyPhone).toBeNull();
    expect(mine.body.addressLine1).toBe("12 Elm St");
    expect(mine.body.dateOfBirth).toBe("1990-04-23");
    expect(mine.body.role).toBe("employee");
    expect(mine.body.payRateCents).not.toBe(999999);
  });

  it("profile photos: set by yourself or an admin, seen by coworkers, images only", async () => {
    const id = await hire("smiley", "employee");
    const otherId = await hire("bystander", "employee");
    const selfToken = (await login("smiley")).body.token;
    const otherToken = (await login("bystander")).body.token;
    const upload = (target: string, token: string, bytes: Buffer, type = "image/png") => {
      const boundary = "----crewdeskphoto";
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: ${type}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({ method: "PUT", url: `/employees/${target}/photo`, payload, headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

    expect((await upload(id, selfToken, png)).statusCode).toBe(200);
    expect((await upload(id, otherToken, png)).statusCode).toBe(403);
    expect((await upload(otherId, ownerToken, png)).statusCode).toBe(200);
    // Claims to be an image but isn't.
    const fake = await upload(id, selfToken, Buffer.from("<script>alert(1)</script>"), "image/png");
    expect(fake.statusCode).toBe(400);

    const me = (await call("GET", `/employees/${id}`, otherToken)).body;
    expect(me.hasPhoto).toBe(true);
    expect(me).not.toHaveProperty("photoKey");
    const img = await app.inject({ method: "GET", url: `/employees/${id}/photo`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(png)).toBe(true);
    // Other companies can't load it.
    const outsider = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Other", firstName: "O", lastName: "X", email: email("photo-outsider"), password: "password123" } });
    const outsiderImg = await app.inject({ method: "GET", url: `/employees/${id}/photo`, headers: { authorization: `Bearer ${outsider.json().token}` } });
    expect(outsiderImg.statusCode).toBe(404);

    expect((await call("DELETE", `/employees/${id}/photo`, selfToken)).body.hasPhoto).toBe(false);
    expect((await app.inject({ method: "GET", url: `/employees/${id}/photo`, headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(404);
  });

  it("only the owner sets the order of details on employee pages", async () => {
    await hire("arranger", "manager");
    const managerToken = (await login("arranger")).body.token;
    const def = (await call("GET", "/employees/field-order", managerToken)).body.order;
    expect(def.slice(0, 3)).toEqual(["email", "phone", "role"]);
    expect((await call("PUT", "/employees/field-order", managerToken, { order: ["address"] })).status).toBe(403);
    expect((await call("PUT", "/employees/field-order", ownerToken, { order: ["nope"] })).status).toBe(400);
    // A partial order keeps the rest after it.
    const saved = await call("PUT", "/employees/field-order", ownerToken, { order: ["address", "phone", "emergency"] });
    expect(saved.body.order.slice(0, 4)).toEqual(["address", "phone", "emergency", "email"]);
    expect(saved.body.order).toHaveLength(def.length);
    expect((await call("GET", "/employees/field-order", managerToken)).body.order).toEqual(saved.body.order);
  });

  it("keeps a reason for inactive or terminated, visible to managers only", async () => {
    const id = await hire("reasoned", "employee");
    await hire("peer", "employee");
    await hire("boss", "manager");
    const peerToken = (await login("peer")).body.token;
    const bossToken = (await login("boss")).body.token;

    const t = await call("PATCH", `/employees/${id}`, ownerToken, { status: "terminated", statusReason: "  No-call no-show 3 times  " });
    expect(t.body.statusReason).toBe("No-call no-show 3 times");
    expect(t.body.statusChangedAt).toBeTruthy();
    expect(t.body.statusChangedById).toBeTruthy();

    expect((await call("GET", `/employees/${id}`, bossToken)).body.statusReason).toBe("No-call no-show 3 times");
    const peerView = (await call("GET", `/employees/${id}`, peerToken)).body;
    expect(peerView.status).toBe("terminated");
    expect(peerView).not.toHaveProperty("statusReason");
    expect((await call("GET", "/employees", peerToken)).body.find((e: any) => e.id === id)).not.toHaveProperty("statusReason");

    // Editing other fields keeps the reason; making them active clears it.
    expect((await call("PATCH", `/employees/${id}`, ownerToken, { title: "Former crew" })).body.statusReason).toBe("No-call no-show 3 times");
    expect((await call("PATCH", `/employees/${id}`, ownerToken, { status: "active", statusReason: "ignored" })).body.statusReason).toBeNull();
    // Added straight in as inactive, with a reason.
    const created = await call("POST", "/employees", ownerToken, { firstName: "Old", lastName: "Hire", email: email("oldhire"), status: "inactive", statusReason: "Seasonal", sendInvite: false });
    expect(created.body.statusReason).toBe("Seasonal");
  });

  it("changing your password needs the current one and signs out other devices", async () => {
    await hire("changer");
    const a = (await login("changer")).body.token;
    const b = (await login("changer")).body.token;
    expect((await call("POST", "/auth/password", a, { currentPassword: "nope", newPassword: "new-password-1" })).status).toBe(401);
    const res = await call("POST", "/auth/password", a, { currentPassword: "password123", newPassword: "new-password-1" });
    expect(res.status).toBe(200);
    expect((await call("GET", "/auth/me", res.body.token)).status).toBe(200);
    expect((await call("GET", "/auth/me", b)).status).toBe(401);
    expect((await login("changer", "new-password-1")).status).toBe(200);
  });
});

describe("admin limits", () => {
  let adminToken: string;
  let adminId: string;

  beforeAll(async () => {
    adminId = await hire("adam", "admin");
    const first = await login("adam");
    adminToken = (await setUpTwoFactor(first.body.setupToken)).token;
  });

  it("admins can't take over the owner or other admins, or create admins", async () => {
    expect((await call("PATCH", `/employees/${ownerId}`, adminToken, { password: "hijacked-123" })).status).toBe(403);
    expect((await call("PATCH", `/employees/${ownerId}`, adminToken, { email: email("evil") })).status).toBe(403);
    expect((await call("POST", `/employees/${ownerId}/reset-two-factor`, adminToken)).status).toBe(403);
    expect((await call("POST", "/employees", adminToken, { firstName: "X", lastName: "Y", email: email("x"), role: "admin" })).status).toBe(403);
    expect((await call("PATCH", `/employees/${adminId}`, adminToken, { role: "owner" })).status).toBe(403);
  });

  it("admins can reset a crew member's two-factor; owners can reset an admin's", async () => {
    const id = await hire("crewmfa");
    const s = (await call("POST", "/auth/mfa/setup", (await login("crewmfa")).body.token)).body.secret;
    await call("POST", "/auth/mfa/enable", (await login("crewmfa")).body.token, { code: codeAt(s, currentStep()) });
    expect((await login("crewmfa")).body.mfaRequired).toBe(true);

    expect((await call("POST", `/employees/${id}/reset-two-factor`, adminToken)).status).toBe(200);
    expect((await login("crewmfa")).body.token).toBeDefined();

    expect((await call("POST", `/employees/${adminId}/reset-two-factor`, ownerToken)).status).toBe(200);
    expect((await login("adam")).body.mfaSetupRequired).toBe(true); // required for admins
  });

  it("never sends secrets to clients", async () => {
    const res = await call("GET", `/employees/${ownerId}`, ownerToken);
    for (const k of ["passwordHash", "totpSecret", "totpPendingSecret", "tokenVersion", "failedLoginCount"]) {
      expect(res.body).not.toHaveProperty(k);
    }
    expect(res.body.twoFactorEnabled).toBe(true);
  });
});

describe("company policy", () => {
  it("requiring it for everyone signs out people without it, who then set it up", async () => {
    await hire("crewpol");
    const before = (await login("crewpol")).body.token;
    expect((await call("PUT", "/auth/policy", before, { twoFactorRequiredFor: "employee" })).status).toBe(403);

    const res = await call("PUT", "/auth/policy", ownerToken, { twoFactorRequiredFor: "employee" });
    expect(res.body.signedOut).toBeGreaterThan(0);
    expect((await call("GET", "/auth/me", before)).status).toBe(401);
    expect((await login("crewpol")).body.mfaSetupRequired).toBe(true);
    await call("PUT", "/auth/policy", ownerToken, { twoFactorRequiredFor: "admin" });
  });
});

describe("password reset", () => {
  it("emails a one-time link that works once and signs out old sessions", async () => {
    await hire("forgetful");
    const old = (await login("forgetful")).body.token;
    emails = [];
    expect((await call("POST", "/auth/forgot-password", undefined, { email: email("forgetful") })).status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe("Reset your Crewdesk password");
    const token = emails[0].text.match(/reset-password\?token=([\w-]+)/)![1];

    expect((await call("POST", "/auth/reset-password", undefined, { token, password: "short" })).status).toBe(400);
    expect((await call("POST", "/auth/reset-password", undefined, { token, password: "brand-new-pass" })).status).toBe(200);
    expect((await call("POST", "/auth/reset-password", undefined, { token, password: "another-pass-1" })).status).toBe(400);
    expect((await call("GET", "/auth/me", old)).status).toBe(401);
    expect((await login("forgetful")).status).toBe(401);
    expect((await login("forgetful", "brand-new-pass")).status).toBe(200);
  });

  it("answers the same for unknown emails and sends nothing", async () => {
    emails = [];
    const res = await call("POST", "/auth/forgot-password", undefined, { email: email("ghost") });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(emails).toHaveLength(0);
  });

  it("still needs the second factor after a reset", async () => {
    emails = [];
    await call("POST", "/auth/forgot-password", undefined, { email: email("owner") });
    const token = emails[0].text.match(/reset-password\?token=([\w-]+)/)![1];
    await call("POST", "/auth/reset-password", undefined, { token, password: "owner-new-pass" });
    const res = await login("owner", "owner-new-pass");
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
  });
});

describe("stored secrets", () => {
  it("keeps authenticator secrets encrypted in the database", async () => {
    const [row] = await db.select().from(employees).where(eq(employees.id, ownerId));
    expect(row.totpSecret).toMatch(/^v1\./);
  });
});

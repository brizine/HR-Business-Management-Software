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

  it("termination and role changes take effect immediately", async () => {
    const id = await hire("leaver", "manager");
    const token = (await login("leaver")).body.token;
    expect((await call("GET", "/time/timesheets", token)).status).toBe(200);

    // Demoted: the old session is ended, and a new one has employee rights.
    await call("PATCH", `/employees/${id}`, ownerToken, { role: "employee" });
    expect((await call("GET", "/time/timesheets", token)).status).toBe(401);
    const newToken = (await login("leaver")).body.token;
    expect((await call("GET", "/time/timesheets", newToken)).status).toBe(403);

    await call("PATCH", `/employees/${id}`, ownerToken, { status: "terminated" });
    expect((await call("GET", "/auth/me", newToken)).status).toBe(401);
    expect((await login("leaver")).status).toBe(401);
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
    expect(emails[0].subject).toBe("Reset your Biz Management Software password");
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

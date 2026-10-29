import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { loginSchema, signupSchema, type Role } from "@crewdesk/shared";
import { z } from "zod";
import { db } from "../db";
import { companies, employees, passwordResets, recoveryCodes } from "../db/schema";
import {
  TWO_FACTOR_POLICIES,
  clearSessionCookie,
  deliverSession,
  signOutEverywhere,
  authenticate,
  companyPolicy,
  issueToken,
  requireRole,
  twoFactorRequired,
  verifyToken,
} from "../lib/auth";
import { WEB_URL, sendSystemEmail } from "../lib/channels";
import { decrypt, encrypt, randomToken, sha256 } from "../lib/crypto";
import { HttpError, parse } from "../lib/errors";
import { newTotpSecret, otpauthUri, verifyTotp } from "../lib/totp";
import { publicEmployee } from "./employees";

type EmployeeRow = typeof employees.$inferSelect;

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
const RESET_TTL_MINUTES = 60;
const RECOVERY_CODE_COUNT = 10;

const passwordSchema = z.string().min(8, "Use at least 8 characters").max(200);

// Compared against when the email doesn't exist, so response time doesn't reveal which emails do.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

/** Per-IP limit on sign-in endpoints (on top of per-account lockout). */
const limited = { config: { rateLimit: { max: Number(process.env.AUTH_RATE_LIMIT ?? 20), timeWindow: "15 minutes" } } };

function assertNotLocked(user: EmployeeRow) {
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or reset your password.`);
  }
}

/** Counts a wrong password or code; the fifth in a row locks the account for a while. */
async function recordFailure(user: EmployeeRow) {
  const n = user.failedLoginCount + 1;
  const lock = n >= MAX_FAILED_ATTEMPTS;
  await db
    .update(employees)
    .set({ failedLoginCount: lock ? 0 : n, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil })
    .where(eq(employees.id, user.id));
}

async function clearFailures(user: EmployeeRow) {
  if (user.failedLoginCount || user.lockedUntil) {
    await db.update(employees).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(employees.id, user.id));
  }
}

/** Accepts an authenticator code, or an unused backup code (which is then used up). */
async function checkSecondFactor(user: EmployeeRow, code: string) {
  if (!user.totpSecret) return false;
  const step = verifyTotp(decrypt(user.totpSecret), code);
  if (step !== null) {
    if (user.totpLastStep !== null && step <= user.totpLastStep) return false; // replayed code
    await db.update(employees).set({ totpLastStep: step }).where(eq(employees.id, user.id));
    return true;
  }
  const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length !== 10) return false;
  const [used] = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.employeeId, user.id), eq(recoveryCodes.codeHash, sha256(normalized)), isNull(recoveryCodes.usedAt)))
    .returning();
  return !!used;
}

async function newRecoveryCodes(employeeId: string) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await db.delete(recoveryCodes).where(eq(recoveryCodes.employeeId, employeeId));
  await db.insert(recoveryCodes).values(codes.map((c) => ({ employeeId, codeHash: sha256(c.replace("-", "")) })));
  return codes;
}

const routes: FastifyPluginAsync = async (app) => {
  const session = async (req: FastifyRequest, reply: FastifyReply, user: EmployeeRow) => {
    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    return { ...deliverSession(req, reply, issueToken(app, user)), user: publicEmployee(user), company };
  };

  /**
   * Creates a company and its owner account. A self-hosted install serves one
   * business, so after the first company exists sign-up closes unless
   * ALLOW_SIGNUP=true (e.g. if you run Crewdesk for several companies).
   */
  app.post("/signup", limited, async (req, reply) => {
    const body = parse(signupSchema, req.body);
    if (process.env.ALLOW_SIGNUP !== "true") {
      const [{ n }] = await db.select({ n: count() }).from(companies);
      if (n > 0) throw new HttpError(403, "Sign-ups are closed. Ask your company's Crewdesk admin to add you.");
    }
    const passwordHash = await bcrypt.hash(body.password, 10);
    const owner = await db.transaction(async (tx) => {
      const [company] = await tx.insert(companies).values({ name: body.companyName }).returning();
      const [owner] = await tx
        .insert(employees)
        .values({
          companyId: company.id,
          firstName: body.firstName,
          lastName: body.lastName,
          email: body.email.toLowerCase(),
          passwordHash,
          role: "owner",
          payType: "salary",
        })
        .returning();
      return owner;
    });
    // The owner is asked to set up two-factor from the Security page; requiring it
    // here would make the very first sign-in a two-step setup.
    return session(req, reply, owner);
  });

  /**
   * Step 1: email + password. Returns a session, or (if two-factor is on) a
   * short-lived token to submit the code with, or (if it's required but not
   * set up yet) a token that can only be used to set it up.
   */
  app.post("/login", limited, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const [user] = await db.select().from(employees).where(eq(employees.email, body.email.toLowerCase()));
    if (!user?.passwordHash || user.status === "terminated") {
      await bcrypt.compare(body.password, DUMMY_HASH);
      throw new HttpError(401, "Invalid email or password");
    }
    assertNotLocked(user);
    if (!(await bcrypt.compare(body.password, user.passwordHash))) {
      await recordFailure(user);
      throw new HttpError(401, "Invalid email or password");
    }

    if (user.totpSecret) return { mfaRequired: true, mfaToken: issueToken(app, user, "mfa") };
    await clearFailures(user);
    if (twoFactorRequired(await companyPolicy(user.companyId), user.role as Role)) {
      return { mfaSetupRequired: true, setupToken: issueToken(app, user, "mfa-setup") };
    }
    return session(req, reply, user);
  });

  /** Step 2: the authenticator (or backup) code. */
  app.post("/login/mfa", limited, async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().min(6).max(20) }), req.body);
    const user = await verifyToken(req, ["mfa"]);
    assertNotLocked(user);
    if (!(await checkSecondFactor(user, code))) {
      await recordFailure(user);
      throw new HttpError(401, "That code didn't work. Check the time on your phone, or use a backup code.");
    }
    await clearFailures(user);
    const [fresh] = await db.select().from(employees).where(eq(employees.id, user.id));
    const remaining = await db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.employeeId, user.id), isNull(recoveryCodes.usedAt)));
    return { ...(await session(req, reply, fresh)), recoveryCodesLeft: remaining[0].n };
  });

  app.get("/me", { preHandler: authenticate }, async (req) => {
    const [user] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    return { user: publicEmployee(user), company };
  });

  /** What the Security settings page shows. */
  app.get("/security", { preHandler: authenticate }, async (req) => {
    const [user] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    const [{ n }] = await db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.employeeId, user.id), isNull(recoveryCodes.usedAt)));
    const policy = await companyPolicy(user.companyId);
    return {
      twoFactorEnabled: !!user.totpSecret,
      twoFactorEnabledAt: user.totpEnabledAt,
      twoFactorRequired: twoFactorRequired(policy, user.role as Role),
      recoveryCodesLeft: n,
      policy,
    };
  });

  // ---- Two-factor setup ----

  /** Starts setup: a new secret to scan. Works signed in, or with a setup-required token. */
  app.post("/mfa/setup", async (req) => {
    const user = await verifyToken(req, ["session", "mfa-setup"]);
    const secret = newTotpSecret();
    await db.update(employees).set({ totpPendingSecret: encrypt(secret) }).where(eq(employees.id, user.id));
    const [company] = await db.select().from(companies).where(eq(companies.id, user.companyId));
    return { secret, otpauthUri: otpauthUri(secret, user.email, `Crewdesk (${company.name})`) };
  });

  /** Confirms setup with a first code; returns backup codes (shown once) and, in the setup-required flow, a session. */
  app.post("/mfa/enable", async (req, reply) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const user = await verifyToken(req, ["session", "mfa-setup"]);
    if (!user.totpPendingSecret) throw new HttpError(400, "Start two-factor setup first");
    const step = verifyTotp(decrypt(user.totpPendingSecret), code);
    if (step === null) throw new HttpError(400, "That code didn't match. Make sure your phone's clock is set automatically and try the newest code.");
    const [updated] = await db
      .update(employees)
      .set({ totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step })
      .where(eq(employees.id, user.id))
      .returning();
    const codes = await newRecoveryCodes(user.id);
    return { recoveryCodes: codes, ...(req.user.purpose === "mfa-setup" ? await session(req, reply, updated) : {}) };
  });

  /** Turns two-factor off (needs password and a current code), unless the company requires it. */
  app.post("/mfa/disable", { preHandler: authenticate }, async (req) => {
    const body = parse(z.object({ password: z.string(), code: z.string() }), req.body);
    const [user] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    if (twoFactorRequired(await companyPolicy(user.companyId), user.role as Role)) {
      throw new HttpError(403, "Your company requires two-factor sign-in for your role");
    }
    if (!user.passwordHash || !(await bcrypt.compare(body.password, user.passwordHash))) throw new HttpError(401, "Wrong password");
    if (!(await checkSecondFactor(user, body.code))) throw new HttpError(401, "That code didn't work");
    await db
      .update(employees)
      .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(employees.id, user.id));
    await db.delete(recoveryCodes).where(eq(recoveryCodes.employeeId, user.id));
    return { ok: true };
  });

  app.post("/mfa/recovery-codes", { preHandler: authenticate }, async (req) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const [user] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    if (!user.totpSecret) throw new HttpError(400, "Two-factor isn't turned on");
    if (!(await checkSecondFactor(user, code))) throw new HttpError(401, "That code didn't work");
    return { recoveryCodes: await newRecoveryCodes(user.id) };
  });

  // ---- Passwords and sessions ----

  /** Changes your own password. Other devices are signed out; this one gets a fresh session. */
  app.post("/password", { preHandler: authenticate }, async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
    const [user] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
    if (user.passwordHash && !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw new HttpError(401, "Your current password is wrong");
    }
    await db.update(employees).set({ passwordHash: await bcrypt.hash(body.newPassword, 10) }).where(eq(employees.id, user.id));
    const fresh = await signOutEverywhere(user.id);
    return deliverSession(req, reply, issueToken(app, fresh));
  });

  app.post("/logout-all", { preHandler: authenticate }, async (req, reply) => {
    await signOutEverywhere(req.user.sub);
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Signs out this browser (clears the session cookie). */
  app.post("/logout", async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Always answers the same way, so it can't be used to find out who has an account. */
  app.post("/forgot-password", limited, async (req) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    const [user] = await db.select().from(employees).where(eq(employees.email, email.toLowerCase()));
    if (user && user.status !== "terminated") {
      const token = randomToken();
      await db.insert(passwordResets).values({
        employeeId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      });
      const link = `${WEB_URL}/reset-password?token=${token}`;
      await sendSystemEmail(
        user.email,
        "Reset your Crewdesk password",
        `Someone asked to reset the password for ${user.email}.\n\nReset it here (the link works once, for ${RESET_TTL_MINUTES} minutes):\n${link}\n\nIf this wasn't you, ignore this email; your password hasn't changed.`,
        `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#1c2330">
<p>Someone asked to reset the password for <strong>${user.email}</strong>.</p>
<p><a href="${link}" style="background:#1f6feb;color:#fff;padding:9px 14px;border-radius:7px;text-decoration:none">Choose a new password</a></p>
<p style="color:#667085;font-size:13px">The link works once, for ${RESET_TTL_MINUTES} minutes. If this wasn't you, ignore this email; your password hasn't changed.</p></div>`,
      ).catch((err) => req.log.error(err, "password reset email failed"));
    }
    return { ok: true };
  });

  /** Sets a new password from an emailed link. Two-factor (if on) is still needed to sign in afterwards. */
  app.post("/reset-password", limited, async (req) => {
    const body = parse(z.object({ token: z.string().min(10), password: passwordSchema }), req.body);
    const [reset] = await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.tokenHash, sha256(body.token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
      .returning();
    if (!reset) throw new HttpError(400, "This reset link has expired or was already used. Ask for a new one.");
    await db
      .update(employees)
      .set({ passwordHash: await bcrypt.hash(body.password, 10), failedLoginCount: 0, lockedUntil: null })
      .where(eq(employees.id, reset.employeeId));
    await signOutEverywhere(reset.employeeId);
    return { ok: true };
  });

  // ---- Company policy ----

  app.get("/policy", { preHandler: [authenticate, requireRole("admin")] }, async (req) => ({ twoFactorRequiredFor: await companyPolicy(req.user.companyId) }));

  /**
   * Sets who must use two-factor. People newly covered who haven't set it up
   * are signed out, so their next sign-in walks them through setup.
   */
  app.put("/policy", { preHandler: [authenticate, requireRole("owner")] }, async (req: FastifyRequest) => {
    const { twoFactorRequiredFor } = parse(z.object({ twoFactorRequiredFor: z.enum(TWO_FACTOR_POLICIES) }), req.body);
    await db.update(companies).set({ twoFactorRequiredFor }).where(eq(companies.id, req.user.companyId));
    const staff = await db.select().from(employees).where(eq(employees.companyId, req.user.companyId));
    let signedOut = 0;
    for (const e of staff) {
      if (e.id !== req.user.sub && !e.totpSecret && e.passwordHash && twoFactorRequired(twoFactorRequiredFor, e.role as Role)) {
        await signOutEverywhere(e.id);
        signedOut++;
      }
    }
    return { twoFactorRequiredFor, signedOut };
  });
};

export default routes;

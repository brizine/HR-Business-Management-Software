import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { ROLES, hasRole, type Role } from "@crewdesk/shared";
import { db } from "../db";
import { companies, employees, pushTokens } from "../db/schema";
import { HttpError } from "./errors";

/**
 * - session: a normal signed-in session.
 * - mfa: password was right; only good for submitting a two-factor code.
 * - mfa-setup: password was right but two-factor is required and not set up;
 *   only good for setting it up.
 */
export type TokenPurpose = "session" | "mfa" | "mfa-setup";

export interface AuthUser {
  sub: string;
  companyId: string;
  role: Role;
  /** employees.token_version when issued; bumping it signs the person out everywhere. */
  ver?: number;
  purpose?: TokenPurpose | "view";
  /** For "view" tokens: the one document it opens. */
  doc?: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

type EmployeeRow = typeof employees.$inferSelect;

export const SESSION_TTL = "7d";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export const SESSION_COOKIE = "crewdesk_session";
/** The website sends this on every request; other sites can't (CORS blocks custom headers from them). */
export const WEB_CLIENT_HEADER = "x-crewdesk-client";

const isWebClient = (req: FastifyRequest) => req.headers[WEB_CLIENT_HEADER] === "web";

/**
 * Hands a new session to the client. The website gets an HttpOnly cookie
 * that page scripts can't read (so a script injected into a page can't steal
 * it); the phone app gets the token in the body to keep in its secure storage.
 */
export function deliverSession(req: FastifyRequest, reply: FastifyReply, token: string) {
  if (!isWebClient(req)) return { token };
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return {};
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function issueToken(app: FastifyInstance, e: EmployeeRow, purpose: TokenPurpose = "session") {
  return app.jwt.sign(
    { sub: e.id, companyId: e.companyId, role: e.role as Role, ver: e.tokenVersion, purpose },
    { expiresIn: purpose === "session" ? SESSION_TTL : purpose === "mfa" ? "5m" : "15m" },
  );
}

/**
 * Verifies the token and re-checks the person on every request, so being
 * terminated, signed out everywhere or having a role changed takes effect
 * immediately rather than when the token expires.
 */
export async function verifyToken(req: FastifyRequest, allowed: TokenPurpose[]) {
  try {
    await req.jwtVerify();
  } catch {
    throw new HttpError(401, "Not signed in");
  }
  // View links ("view") are never accepted here; they only open one document.
  if (!allowed.includes((req.user.purpose ?? "session") as TokenPurpose)) throw new HttpError(401, "Not signed in");
  // Cookie-authenticated changes must come from the website itself, not a form on another site.
  const viaCookie = !req.headers.authorization;
  if (viaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !isWebClient(req)) {
    throw new HttpError(403, "Request blocked: missing the Biz Management Software client header");
  }
  const [row] = await db.select().from(employees).where(eq(employees.id, req.user.sub));
  if (!row || row.status === "terminated" || row.tokenVersion !== (req.user.ver ?? 0)) {
    throw new HttpError(401, "Your session has ended. Please sign in again.");
  }
  req.user.role = row.role as Role;
  return row;
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  await verifyToken(req, ["session"]);
}

/** preHandler that rejects users below `min`. Must run after `authenticate`. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest) => {
    if (!hasRole(req.user.role, min)) throw new HttpError(403, "You do not have permission to do that");
  };
}

export function isManager(req: FastifyRequest) {
  return hasRole(req.user.role, "manager");
}

export const TWO_FACTOR_POLICIES = ["none", ...ROLES] as const;
export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number];

/** Whether the company's policy makes this role use two-factor sign-in. */
export function twoFactorRequired(policy: string, role: Role) {
  return policy !== "none" && hasRole(role, policy as Role);
}

export async function companyPolicy(companyId: string) {
  const [c] = await db.select({ p: companies.twoFactorRequiredFor }).from(companies).where(eq(companies.id, companyId));
  return c?.p ?? "admin";
}

/** Owners can manage anyone; admins only people ranked below them. */
export function canManageAccount(actor: Role, target: Role) {
  return actor === "owner" || (hasRole(actor, target) && actor !== target);
}

/** Signs the person out of every device and stops pushes to their phones. */
export async function signOutEverywhere(employeeId: string) {
  const [row] = await db
    .update(employees)
    .set({ tokenVersion: sql`${employees.tokenVersion} + 1` })
    .where(eq(employees.id, employeeId))
    .returning();
  await db.delete(pushTokens).where(eq(pushTokens.employeeId, employeeId));
  return row;
}

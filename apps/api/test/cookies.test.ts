/** Website sessions use an HttpOnly cookie; cookie-based changes need the client header. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const WEB = { "x-crewdesk-client": "web" };
let cookie: string;

function sessionCookie(setCookie: string | string[] | undefined) {
  const header = [setCookie ?? []].flat().find((c) => c.startsWith("crewdesk_session="));
  return header;
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "t" })) });
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("website sessions", () => {
  it("sign-up from the website sets an HttpOnly cookie and doesn't expose the token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      headers: WEB,
      payload: { companyName: "Cookie Co", firstName: "C", lastName: "K", email: `cookie-${suffix}@test.dev`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeUndefined();
    const header = sessionCookie(res.headers["set-cookie"])!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    cookie = header.split(";")[0];
  });

  it("the phone app still gets a bearer token", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `cookie-${suffix}@test.dev`, password: "password123" } });
    // Owner: two-factor setup is required, which hands back a setup token rather than a session.
    expect(res.json().setupToken ?? res.json().token).toBeTruthy();
    expect(sessionCookie(res.headers["set-cookie"])).toBeUndefined();
  });

  it("reads work with just the cookie", async () => {
    const res = await app.inject({ url: "/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(`cookie-${suffix}@test.dev`);
  });

  it("changes made with the cookie need the client header (blocks forged cross-site requests)", async () => {
    const asset = { name: "Cookie Truck", type: "vehicle" };
    const forged = await app.inject({ method: "POST", url: "/assets", headers: { cookie }, payload: asset });
    expect(forged.statusCode).toBe(403);
    const real = await app.inject({ method: "POST", url: "/assets", headers: { cookie, ...WEB }, payload: asset });
    expect(real.statusCode).toBe(200);
  });

  it("other sites can't send the client header (CORS only allows Biz Management Software's own origin)", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/assets",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-crewdesk-client" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sign out clears the cookie; sign out everywhere also ends copies of it", async () => {
    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: WEB });
    expect(sessionCookie(out.headers["set-cookie"])).toMatch(/crewdesk_session=;|Expires=Thu, 01 Jan 1970/);

    // A copied cookie stays valid until "sign out everywhere".
    expect((await app.inject({ url: "/auth/me", headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/auth/logout-all", headers: { cookie, ...WEB } });
    expect((await app.inject({ url: "/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });
});

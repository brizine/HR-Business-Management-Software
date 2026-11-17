/** The company logo is available without signing in (for the phone app's sign-in screen). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";

let app: FastifyInstance;
let token = "";
let companyId = "";
// A 1×1 PNG.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Logo Co", firstName: "Lo", lastName: "Go", email: `logo-${Date.now()}@logo.test`, password: "password123" } });
  token = signup.json().token;
  companyId = (await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).json().company.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("public company logo", () => {
  it("404 without a logo; the image once uploaded; no sign-in needed", async () => {
    expect((await app.inject({ method: "GET", url: `/public/company/${companyId}/logo` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/public/company/not-a-uuid/logo" })).statusCode).toBe(404);
    const boundary = "----logo";
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await app.inject({ method: "PUT", url: "/company/logo", payload: body, headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: `/public/company/${companyId}/logo` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.equals(png)).toBe(true);
  });
});

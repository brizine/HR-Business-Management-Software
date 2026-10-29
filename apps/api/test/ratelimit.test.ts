/** Per-IP rate limiting on sign-in endpoints (separate file: the limit is read at startup). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let pool: { end(): Promise<void> };

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT = "3";
  ({ pool } = await import("../src/db"));
  app = await (await import("../src/app")).buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("rate limiting", () => {
  it("slows down repeated sign-in attempts from one address", async () => {
    const attempt = () =>
      app.inject({ method: "POST", url: "/auth/login", payload: { email: "nobody@example.com", password: "x" } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt()).statusCode);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    // Other endpoints aren't limited.
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});

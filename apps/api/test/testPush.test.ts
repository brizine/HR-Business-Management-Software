/** "Send a test notification": pushes to your own phones and reports each result. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let token = "";
let sent: PushMessage[] = [];

beforeAll(async () => {
  // The second phone has uninstalled the app.
  setPushTransport({ send: async (m) => { sent.push(...m); return m.map((x) => x.to.includes("gone")
    ? { status: "error" as const, message: "not registered", details: { error: "DeviceNotRegistered" } }
    : { status: "ok" as const, id: "t" }); } });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Push Co", firstName: "Pu", lastName: "Sh", email: `push-${Date.now()}@push.test`, password: "password123" } });
  token = signup.json().token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
};

describe("test push", () => {
  it("says when no phone is registered", async () => {
    expect((await call("POST", "/notifications/test-push")).body).toEqual({ devices: 0, results: [] });
  });

  it("sends to each phone, reports results and forgets uninstalled ones", async () => {
    await call("POST", "/notifications/devices", { token: "ExponentPushToken[okphone1234]", platform: "ios" });
    await call("POST", "/notifications/devices", { token: "ExponentPushToken[gonephone99]", platform: "android" });
    const r = await call("POST", "/notifications/test-push");
    expect(r.body.devices).toBe(2);
    expect(r.body.results.map((x: any) => [x.platform, x.ok])).toEqual(expect.arrayContaining([["ios", true], ["android", false]]));
    expect(r.body.results.find((x: any) => !x.ok).error).toContain("DeviceNotRegistered");
    expect(sent.map((m) => m.title)).toEqual(["Test notification", "Test notification"]);
    sent = [];
    expect((await call("POST", "/notifications/test-push")).body.devices).toBe(1);
  });
});

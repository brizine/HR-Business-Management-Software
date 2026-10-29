/** Employee availability (recurring "can't work" times) and saved shift templates. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let sent: PushMessage[] = [];
const suffix = Date.now();
const people: Record<"owner" | "eli", { token: string; id: string; push: string }> = {} as never;

// Monday Jan 7 2030, midnight in the company's zone (America/Chicago, UTC-6).
const monday = Date.UTC(2030, 0, 7, 6);
const at = (day: number, hour: number) => new Date(monday + day * 86_400_000 + hour * 3_600_000).toISOString();

async function call(method: string, url: string, who?: keyof typeof people, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: who ? { authorization: `Bearer ${people[who].token}` } : {},
  });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  setEmailTransport(null);
  setSmsTransport(null);
  setPushTransport({ send: async (m) => (sent.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Avail Co", firstName: "Ola", lastName: "Owner", email: `ola-${suffix}@test.dev`, password: "password123",
  });
  people.owner = { token: signup.body.token, id: signup.body.user.id, push: `ExponentPushToken[ola-${suffix}]` };
  const e = await call("POST", "/employees", "owner", {
    firstName: "Eli", lastName: "Early", email: `eli-${suffix}@test.dev`, password: "password123", managerId: people.owner.id,
  });
  const login = await call("POST", "/auth/login", undefined, { email: `eli-${suffix}@test.dev`, password: "password123" });
  people.eli = { token: login.body.token, id: e.body.id, push: `ExponentPushToken[eli-${suffix}]` };
  await call("POST", "/notifications/devices", "owner", { token: people.owner.push, platform: "ios" });
});

beforeEach(async () => {
  await flushNotifications();
  sent = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("availability", () => {
  it("validates rules", async () => {
    expect((await call("PUT", "/availability", "eli", { rules: [{ weekday: 7 }] })).status).toBe(400);
    expect((await call("PUT", "/availability", "eli", { rules: [{ weekday: 1, startTime: "14:00", endTime: "09:00" }] })).status).toBe(400);
    expect((await call("PUT", "/availability", "eli", { rules: [{ weekday: 1, startTime: "2pm" }] })).status).toBe(400);
  });

  it("employees set their own and the manager hears about it", async () => {
    const res = await call("PUT", "/availability", "eli", {
      rules: [{ weekday: 2, note: "Class" }, { weekday: 5, endTime: "14:00" }],
    });
    expect(res.body).toHaveLength(2);
    await flushNotifications();
    const alert = sent.find((m) => m.to === people.owner.push)!;
    expect(alert.title).toBe("Eli Early updated their availability");
    expect(alert.body).toBe("Can't work: Tue all day, Fri before 2pm");
  });

  it("employees can't edit someone else's; managers can and can see everyone's", async () => {
    expect((await call("PUT", `/availability?employeeId=${people.owner.id}`, "eli", { rules: [] })).status).toBe(403);
    const all = await call("GET", "/availability", "owner");
    expect(all.body.map((r: { employeeId: string }) => r.employeeId)).toContain(people.eli.id);
    expect((await call("GET", "/availability", "eli")).body).toHaveLength(2);
  });

  it("warns when a shift runs into someone's unavailable time", async () => {
    const shift = (day: number, from: number, to: number) =>
      call("POST", "/shifts", "owner", { employeeId: people.eli.id, startsAt: at(day, from), endsAt: at(day, to) });

    expect((await shift(1, 9, 17)).body.warnings).toEqual(["Eli can't work Tuesdays all day (Class)"]);
    expect((await shift(4, 13, 18)).body.warnings).toEqual(["Eli can't work Fridays before 2pm"]);
    expect((await shift(11, 14, 20)).body.warnings).toEqual([]); // the next Friday, after 2pm: fine
    // Monday 10pm → Tuesday 4am crosses into Tuesday.
    expect((await shift(0, 22, 28)).body.warnings).toHaveLength(1);
  });

  it("clearing all rules means available any time", async () => {
    await call("PUT", "/availability", "eli", { rules: [] });
    await flushNotifications();
    expect(sent.find((m) => m.to === people.owner.push)?.body).toBe("Now available any time");
  });
});

describe("shift templates", () => {
  it("managers save, edit and delete templates; employees can't", async () => {
    const asset = await call("POST", "/assets", "owner", { name: "Truck 3", type: "vehicle" });
    expect((await call("POST", "/shifts/templates", "eli", { name: "x", startTime: "07:00", endTime: "15:30" })).status).toBe(403);
    expect((await call("POST", "/shifts/templates", "owner", { name: "Bad", startTime: "7am", endTime: "15:30" })).status).toBe(400);

    const tpl = await call("POST", "/shifts/templates", "owner", {
      name: "Morning crew", startTime: "07:00", endTime: "15:30", position: "Driver", assetId: asset.body.id,
    });
    expect(tpl.status).toBe(200);
    await call("POST", "/shifts/templates", "owner", { name: "Night watch", startTime: "22:00", endTime: "06:00" });

    const list = await call("GET", "/shifts/templates", "owner");
    expect(list.body.map((t: { name: string }) => t.name)).toEqual(["Morning crew", "Night watch"]);

    expect((await call("PATCH", `/shifts/templates/${tpl.body.id}`, "owner", { endTime: "16:00" })).body.endTime).toBe("16:00");
    expect((await call("DELETE", `/shifts/templates/${tpl.body.id}`, "owner")).status).toBe(200);
    expect((await call("GET", "/shifts/templates", "owner")).body).toHaveLength(1);
    expect((await call("GET", "/shifts/templates", "eli")).status).toBe(403);
  });
});

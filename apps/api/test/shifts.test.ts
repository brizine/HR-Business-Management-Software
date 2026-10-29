/** Shift scheduling: building a week, publishing, open shifts, drop requests and reminders. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { runScheduledChecks } from "../src/lib/jobs";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let sent: PushMessage[] = [];
const suffix = Date.now();
const people: Record<"owner" | "amy" | "ben", { token: string; id: string; push: string }> = {} as never;

// A week far enough ahead that every shift is in the future, starting at
// midnight Monday in the company's default zone (America/Chicago, UTC-6 in January).
const DAY = 86_400_000;
const monday = new Date(Date.UTC(2030, 0, 7, 6));
const week = { from: monday.toISOString(), to: new Date(monday.getTime() + 7 * DAY).toISOString() };
const at = (day: number, hour: number) => new Date(monday.getTime() + day * DAY + hour * 3_600_000).toISOString();

async function call(method: string, url: string, who?: keyof typeof people, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url,
    payload: payload as never,
    headers: who ? { authorization: `Bearer ${people[who].token}` } : {},
  });
  return { status: res.statusCode, body: res.json() };
}

async function titlesFor(who: keyof typeof people) {
  await flushNotifications();
  return sent.filter((m) => m.to === people[who].push).map((m) => m.title);
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => (sent.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  app = await buildApp({ logger: false });
  const signup = await call("POST", "/auth/signup", undefined, {
    companyName: "Shift Co", firstName: "Sam", lastName: "Owner", email: `sam-${suffix}@test.dev`, password: "password123",
  });
  people.owner = { token: signup.body.token, id: signup.body.user.id, push: `ExponentPushToken[owner-${suffix}]` };
  for (const name of ["amy", "ben"] as const) {
    const e = await call("POST", "/employees", "owner", {
      firstName: name, lastName: "Test", email: `${name}-${suffix}@test.dev`, password: "password123", managerId: people.owner.id,
    });
    const login = await call("POST", "/auth/login", undefined, { email: `${name}-${suffix}@test.dev`, password: "password123" });
    people[name] = { token: login.body.token, id: e.body.id, push: `ExponentPushToken[${name}-${suffix}]` };
  }
  for (const who of ["owner", "amy", "ben"] as const) {
    await call("POST", "/notifications/devices", who, { token: people[who].push, platform: "ios" });
  }
});

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("building a schedule", () => {
  it("only managers create shifts, and shifts must make sense", async () => {
    expect((await call("POST", "/shifts", "amy", { startsAt: at(0, 9), endsAt: at(0, 17) })).status).toBe(403);
    expect((await call("POST", "/shifts", "owner", { startsAt: at(0, 17), endsAt: at(0, 9) })).status).toBe(400);
    expect((await call("POST", "/shifts", "owner", { startsAt: at(0, 0), endsAt: at(1, 2) })).status).toBe(400);
  });

  it("rejects double-booking the same person", async () => {
    const ok = await call("POST", "/shifts", "owner", { employeeId: people.amy.id, startsAt: at(0, 9), endsAt: at(0, 17), position: "Driver" });
    expect(ok.status).toBe(200);
    expect(ok.body.warnings).toEqual([]);
    const clash = await call("POST", "/shifts", "owner", { employeeId: people.amy.id, startsAt: at(0, 16), endsAt: at(0, 20) });
    expect(clash.status).toBe(409);
    // Back-to-back is fine.
    expect((await call("POST", "/shifts", "owner", { employeeId: people.amy.id, startsAt: at(0, 17), endsAt: at(0, 19) })).status).toBe(200);
  });

  it("warns when someone has approved time off that day", async () => {
    const policy = await call("POST", "/pto/policies", "owner", { name: "PTO" });
    await call("POST", "/pto/adjustments", "owner", { employeeId: people.ben.id, policyId: policy.body.id, hours: 40 });
    const req = await call("POST", "/pto/requests", "ben", { policyId: policy.body.id, startDate: "2030-01-09", endDate: "2030-01-09", hours: 8 });
    await call("POST", `/pto/requests/${req.body.id}/decide`, "owner", { status: "approved" });
    const s = await call("POST", "/shifts", "owner", { employeeId: people.ben.id, startsAt: at(2, 14), endsAt: at(2, 20) });
    expect(s.body.warnings[0]).toMatch(/approved time off/);
  });

  it("hides drafts from employees until published, then notifies each person once", async () => {
    await call("POST", "/shifts", "owner", { startsAt: at(4, 9), endsAt: at(4, 13), position: "Open slot" });
    expect((await call("GET", `/shifts?from=${week.from}&to=${week.to}`, "amy")).body).toHaveLength(0);
    expect((await call("GET", `/shifts?from=${week.from}&to=${week.to}`, "owner")).body).toHaveLength(4);

    const pub = await call("POST", "/shifts/publish", "owner", week);
    expect(pub.body.published).toBe(4);
    expect(await titlesFor("amy")).toEqual(["Your schedule for the week of Jan 7 is posted", "An open shift is available"]);
    expect((await titlesFor("ben"))[0]).toMatch(/Your schedule for the week of/);
    expect((await call("GET", `/shifts?from=${week.from}&to=${week.to}`, "amy")).body).toHaveLength(4);

    sent = [];
    expect((await call("POST", "/shifts/publish", "owner", week)).body.published).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("tells people when a published shift changes hands", async () => {
    const list = await call("GET", `/shifts?from=${week.from}&to=${week.to}&employeeId=${people.ben.id}`, "owner");
    const shiftId = list.body[0].shift.id;
    await call("PATCH", `/shifts/${shiftId}`, "owner", { employeeId: people.amy.id });
    expect(await titlesFor("ben")).toEqual(["You were taken off a shift"]);
    expect(await titlesFor("amy")).toEqual(["New shift added to your schedule"]);
  });

  it("includes scheduled hours on timesheets", async () => {
    const sheets = await call("GET", `/time/timesheets?from=${week.from}&to=${week.to}`, "owner");
    const amy = sheets.body.find((r: { employeeId: string }) => r.employeeId === people.amy.id);
    expect(amy.scheduledHours).toBe(16); // 8 + 2 + 6 (taken over from Ben)
    expect(amy.totalHours).toBe(0);
  });
});

describe("open shifts and drop requests", () => {
  it("lets one employee claim an open shift", async () => {
    const mine = await call("GET", "/shifts/mine", "ben");
    // /mine only looks two weeks ahead, so find the open shift through the week view.
    expect(mine.status).toBe(200);
    const open = (await call("GET", `/shifts?from=${week.from}&to=${week.to}`, "ben")).body.find((r: any) => !r.shift.employeeId);
    const claim = await call("POST", `/shifts/${open.shift.id}/claim`, "ben");
    expect(claim.body.employeeId).toBe(people.ben.id);
    expect(await titlesFor("owner")).toEqual(["ben Test picked up an open shift"]);
    expect((await call("POST", `/shifts/${open.shift.id}/claim`, "amy")).status).toBe(409);
  });

  it("drop request → approval reopens the shift for everyone else", async () => {
    const amyShift = (await call("GET", `/shifts?from=${week.from}&to=${week.to}&employeeId=${people.amy.id}`, "amy")).body[0].shift;
    expect((await call("POST", `/shifts/${amyShift.id}/drop-request`, "ben", {})).status).toBe(403);
    await call("POST", `/shifts/${amyShift.id}/drop-request`, "amy", { reason: "Dentist" });
    expect(await titlesFor("owner")).toEqual(["amy Test wants to drop a shift"]);
    expect((await call("GET", "/shifts/drop-requests", "owner")).body).toHaveLength(1);

    sent = [];
    const decided = await call("POST", `/shifts/${amyShift.id}/drop-decision`, "owner", { approve: true });
    expect(decided.body.employeeId).toBeNull();
    expect(await titlesFor("amy")).toEqual(["You're off the hook: shift drop approved"]);
    expect(await titlesFor("ben")).toEqual(["An open shift is available"]);
  });
});

describe("copying and reminders", () => {
  it("copies a week forward as drafts, skipping clashes", async () => {
    const next = { from: week.to, to: new Date(monday.getTime() + 14 * DAY).toISOString() };
    // Amy's Wednesday shift (taken over from Ben) would land on top of this one.
    await call("POST", "/shifts", "owner", { employeeId: people.amy.id, startsAt: at(9, 14), endsAt: at(9, 16) });
    const res = await call("POST", "/shifts/copy-week", "owner", week);
    expect(res.body.skipped).toBe(1);
    const copied = (await call("GET", `/shifts?from=${next.from}&to=${next.to}`, "owner")).body;
    expect(copied.every((r: any) => r.shift.status === "draft")).toBe(true);
    expect(copied).toHaveLength(res.body.copied + 1);
  });

  it("reminds people an hour before their shift, once", async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    const s = await call("POST", "/shifts", "owner", {
      employeeId: people.amy.id, startsAt: soon.toISOString(), endsAt: new Date(soon.getTime() + 4 * 3_600_000).toISOString(), position: "Driver",
    });
    await call("POST", "/shifts/publish", "owner", { from: new Date(Date.now()).toISOString(), to: new Date(Date.now() + DAY).toISOString() });
    sent = [];
    await runScheduledChecks();
    expect((await titlesFor("amy")).filter((t) => t.startsWith("Your shift starts at"))).toHaveLength(1);
    sent = [];
    await runScheduledChecks();
    expect((await titlesFor("amy")).filter((t) => t.startsWith("Your shift starts at"))).toHaveLength(0);
    expect((await call("GET", "/shifts/mine", "amy")).body.mine.map((r: any) => r.shift.id)).toContain(s.body.shift.id);
  });
});

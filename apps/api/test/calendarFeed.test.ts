/** Calendar subscription: a private link per person, and the .ics feed phone calendars read. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { buildIcs } from "../src/lib/ics";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@cal.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inDays = (d: number, h: number) => { const x = new Date(Date.now() + d * 86_400_000); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };

beforeAll(async () => {
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Cal Co", firstName: "Cal", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  const e = await call("POST", "/employees", "owner", { firstName: "Cora", lastName: "Crew", email: email("crew"), password: "password123", role: "employee" });
  ID.crew = e.body.id;
  T.crew = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("crew"), password: "password123" } })).json().token;
  const s = await call("POST", "/shifts", "owner", { employeeId: ID.crew, startsAt: inDays(2, 13), endsAt: inDays(2, 21), position: "Mowing", location: "Elm St, Lot 4", notes: "Bring trimmer" });
  ID.shift = s.body.id ?? s.body.shift?.id;
  await call("POST", "/shifts", "owner", { employeeId: ID.crew, startsAt: inDays(3, 13), endsAt: inDays(3, 21) }); // draft until published
  await call("POST", "/shifts/publish", "owner", { from: inDays(1, 0), to: inDays(2, 23) });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("calendar subscription", () => {
  it("gives each person one private link until they reset it", async () => {
    const a = await call("POST", "/shifts/calendar-link", "crew");
    expect(a.body.url).toMatch(/\/calendar\/[A-Za-z0-9_-]{30,}\.ics$/);
    expect(a.body.webcal).toMatch(/^webcal:\/\//);
    expect((await call("POST", "/shifts/calendar-link", "crew")).body.url).toBe(a.body.url);
    ID.link = new URL(a.body.url).pathname.replace(/^.*\/calendar\//, "/calendar/");
  });

  it("serves published shifts as an .ics feed without signing in", async () => {
    const res = await app.inject({ method: "GET", url: ID.link });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/calendar");
    const ics = res.body;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:Cal Co shifts");
    expect(ics).toContain("SUMMARY:Work: Mowing @ Elm St\\, Lot 4");
    expect(ics).toContain("DESCRIPTION:Bring trimmer");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1); // the draft isn't included
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it("a reset link stops working; bad links are 404", async () => {
    await call("DELETE", "/shifts/calendar-link", "crew");
    expect((await app.inject({ method: "GET", url: ID.link })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/calendar/short.ics" })).statusCode).toBe(404);
    const fresh = (await call("POST", "/shifts/calendar-link", "crew")).body.url;
    expect(fresh).not.toContain(ID.link);
  });

  it("all-day events and line folding", () => {
    const ics = buildIcs("X", [{ uid: "a", summary: "Time off (Vacation)", allDayStart: "2026-12-24", allDayEndExclusive: "2026-12-27" },
      { uid: "b", summary: "Work", description: "x".repeat(200), start: new Date("2026-12-01T14:00:00Z"), end: new Date("2026-12-01T22:00:00Z") }]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261227");
    expect(ics).toContain("DTSTART:20261201T140000Z");
    expect(ics).toMatch(/DESCRIPTION:x+\r\n x+/);
  });
});

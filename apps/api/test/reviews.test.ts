/** Reviews & discipline: managers write drafts, share them; employees see their own and acknowledge. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@reviews.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const inbox = async (who: string) => (await call("GET", "/notifications", who)).body.items as any[];

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Review Co", firstName: "Rae", lastName: "Owner", email: email("owner"), password: "password123" } });
  T.owner = signup.json().token;
  ID.owner = (await call("GET", "/auth/me", "owner")).body.user.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["lead", "manager"], ["lead2", "manager"], ["crew", "employee"], ["other", "employee"], ["boss", "admin"]]) {
    const e = await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    ID[who] = e.body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
});

beforeEach(async () => {
  await flushNotifications();
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

const review = (employeeId: string) => ({ kind: "review", employeeId, type: "annual", date: "2026-11-01", periodStart: "2025-11-01", periodEnd: "2026-10-31", rating: 4, summary: "Strong year.", strengths: "Reliable", improvements: "", goals: "Get CDL" });
const warning = (employeeId: string) => ({ kind: "discipline", employeeId, type: "written_warning", date: "2026-11-03", reason: "attendance", incidentDate: "2026-11-02", summary: "No call, no show on Monday.", expectations: "Call in before shift starts.", followUpDate: "2026-12-03" });

describe("reviews & discipline", () => {
  it("managers write drafts the employee can't see until shared", async () => {
    const r = await call("POST", "/reviews", "lead", review(ID.crew));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "review", status: "draft", rating: 4, improvements: null, authorName: "lead Person", employee: { id: ID.crew } });
    ID.review = r.body.id;
    expect((await call("GET", "/reviews", "crew")).body).toEqual([]);
    expect((await call("GET", `/reviews/${ID.review}`, "crew")).status).toBe(404);
    // Employees can't write them; nobody writes their own or about someone at their level or above.
    expect((await call("POST", "/reviews", "crew", review(ID.other))).status).toBe(403);
    expect((await call("POST", "/reviews", "lead", review(ID.lead))).status).toBe(403);
    expect((await call("POST", "/reviews", "lead", review(ID.lead2))).status).toBe(403);
    expect((await call("POST", "/reviews", "lead", review(ID.boss))).status).toBe(403);
    const aboutLead = await call("POST", "/reviews", "boss", review(ID.lead));
    expect(aboutLead.status).toBe(200);
    // A manager never sees a draft about themselves.
    expect((await call("GET", `/reviews/${aboutLead.body.id}`, "lead")).status).toBe(404);
    expect((await call("GET", `/reviews?employeeId=${ID.lead}`, "lead")).body).toEqual([]);
    expect((await call("GET", "/reviews", "lead")).body.some((x: any) => x.id === aboutLead.body.id)).toBe(false);
    // Validation.
    expect((await call("POST", "/reviews", "lead", { ...review(ID.crew), summary: "" })).status).toBe(400);
    expect((await call("POST", "/reviews", "lead", { ...review(ID.crew), periodEnd: "2025-01-01" })).status).toBe(400);
    expect((await call("POST", "/reviews", "lead", { ...warning(ID.crew), type: "annual" })).status).toBe(400);
  });

  it("drafts: only the author or an admin edits them", async () => {
    expect((await call("PUT", `/reviews/${ID.review}`, "lead2", { ...review(ID.crew), rating: 1 })).status).toBe(403);
    const edited = await call("PUT", `/reviews/${ID.review}`, "lead", { ...review(ID.crew), rating: 5 });
    expect(edited.body.rating).toBe(5);
    expect((await call("PUT", `/reviews/${ID.review}`, "lead", { ...review(ID.other) })).status).toBe(400);
  });

  it("sharing notifies the employee, who acknowledges with a comment; the author hears back", async () => {
    expect((await call("POST", `/reviews/${ID.review}/share`, "lead2")).status).toBe(403);
    const shared = await call("POST", `/reviews/${ID.review}/share`, "lead");
    expect(shared.body.status).toBe("shared");
    expect((await call("POST", `/reviews/${ID.review}/share`, "lead")).status).toBe(409);
    await flushNotifications();
    const n = (await inbox("crew")).find((x) => x.title.startsWith("New review"));
    expect(n).toMatchObject({ category: "reviews", link: { screen: "reviews", id: ID.review } });

    const mine = (await call("GET", "/reviews", "crew")).body;
    expect(mine.map((x: any) => x.id)).toEqual([ID.review]);
    expect((await call("POST", `/reviews/${ID.review}/acknowledge`, "other")).status).toBe(404);
    const ack = await call("POST", `/reviews/${ID.review}/acknowledge`, "crew", { comment: "Thanks, working on the CDL." });
    expect(ack.body).toMatchObject({ status: "acknowledged", employeeComment: "Thanks, working on the CDL." });
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect((await call("POST", `/reviews/${ID.review}/acknowledge`, "crew", {})).status).toBe(409);
    await flushNotifications();
    expect((await inbox("lead")).some((x) => x.title.includes("acknowledged their review"))).toBe(true);
  });

  it("disciplinary actions; shared records are admin-only to change; the employee can't change theirs", async () => {
    const w = await call("POST", "/reviews", "lead", warning(ID.crew));
    expect(w.body).toMatchObject({ kind: "discipline", type: "written_warning", reason: "attendance", followUpDate: "2026-12-03", rating: null });
    await call("POST", `/reviews/${w.body.id}/share`, "lead");
    expect((await call("PUT", `/reviews/${w.body.id}`, "lead", { ...warning(ID.crew), summary: "Changed" })).status).toBe(403);
    expect((await call("DELETE", `/reviews/${w.body.id}`, "lead")).status).toBe(403);
    expect((await call("DELETE", `/reviews/${w.body.id}`, "crew")).status).toBe(403);
    expect((await call("PUT", `/reviews/${w.body.id}`, "boss", { ...warning(ID.crew), summary: "Corrected date." })).body.summary).toBe("Corrected date.");

    const list = (await call("GET", `/reviews?employeeId=${ID.crew}&kind=discipline`, "lead")).body;
    expect(list.map((x: any) => x.id)).toEqual([w.body.id]);
    expect((await call("DELETE", `/reviews/${w.body.id}`, "boss")).status).toBe(200);
    expect((await call("GET", `/reviews/${w.body.id}`, "lead")).status).toBe(404);
  });

  it("the Permissions page can give an employee access", async () => {
    expect((await call("GET", `/reviews?employeeId=${ID.crew}`, "other")).body.every((x: any) => x.employeeId === ID.other)).toBe(true);
    await call("PUT", `/permissions/${ID.other}`, "owner", { areas: { reviews: "manager" } });
    expect((await call("GET", `/reviews?employeeId=${ID.crew}`, "other")).body.length).toBeGreaterThan(0);
    // ...but still only about people below that level.
    expect((await call("POST", "/reviews", "other", review(ID.crew))).status).toBe(200);
    expect((await call("POST", "/reviews", "other", review(ID.lead))).status).toBe(403);
  });
});

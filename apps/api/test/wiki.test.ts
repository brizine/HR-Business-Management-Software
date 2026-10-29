/** Company wiki: per-page view/edit levels, who can create, history, search and notifications. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, setSmsTransport } from "../src/lib/channels";
import { flushNotifications, setPushTransport, type PushMessage } from "../src/lib/notify";

let app: FastifyInstance;
let pushes: PushMessage[] = [];
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@wiki.test`;
const T: Record<string, string> = {};
const P: Record<string, any> = {};

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
const titles = async (who: string, q = "") => ((await call("GET", `/wiki/pages${q ? `?q=${encodeURIComponent(q)}` : ""}`, who)).body as any[]).map((p) => p.title).sort();
const pushedTo = (who: string) => pushes.filter((p) => p.to === `ExponentPushToken[${who}-${suffix}]`).map((p) => p.title);

beforeAll(async () => {
  setEmailTransport(null);
  setSmsTransport(null);
  setPushTransport({ send: async (m) => (pushes.push(...m), m.map(() => ({ status: "ok" as const, id: "t" }))) });
  app = await buildApp({ logger: false });
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { companyName: "Wiki Co", firstName: "Ada", lastName: "Owner", email: email("owner"), password: "password123" },
  });
  T.owner = signup.json().token;
  // Admins must use two-factor by default; turn that off so this test can sign in with passwords.
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  for (const [who, role] of [["admin", "admin"], ["mgr", "manager"], ["crew", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Test", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  for (const who of ["owner", "admin", "mgr", "crew"]) {
    await call("POST", "/notifications/devices", who, { token: `ExponentPushToken[${who}-${suffix}]`, platform: "ios" });
  }
});

beforeEach(async () => {
  await flushNotifications();
  pushes = [];
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("creating pages", () => {
  it("only admins create pages by default; the setting can open it up", async () => {
    expect((await call("GET", "/wiki/settings", "crew")).body).toMatchObject({ createMin: "admin", canCreate: false });
    expect((await call("POST", "/wiki/pages", "crew", { title: "My page" })).status).toBe(403);
    expect((await call("PUT", "/wiki/settings", "mgr", { createMin: "employee" })).status).toBe(403);

    P.welcome = (await call("POST", "/wiki/pages", "admin", { title: "Welcome", body: "# Hello\nStart here.", pinned: true })).body;
    P.safety = (await call("POST", "/wiki/pages", "admin", { title: "Safety rules", body: "Wear **PPE** on every job site.", editMin: "manager" })).body;
    P.managers = (await call("POST", "/wiki/pages", "admin", { title: "Manager handbook", body: "How to approve timesheets.", viewMin: "manager", editMin: "manager" })).body;
    P.vendors = (await call("POST", "/wiki/pages", "admin", { title: "Vendor accounts", body: "Fuel card PIN process.", viewMin: "admin", editMin: "admin" })).body;
    P.tips = (await call("POST", "/wiki/pages", "admin", { title: "Crew tips", body: "Share what works.", editMin: "employee" })).body;
    expect(P.welcome.id).toBeTruthy();

    await call("PUT", "/wiki/settings", "admin", { createMin: "employee" });
    expect((await call("GET", "/wiki/settings", "crew")).body.canCreate).toBe(true);
  });

  it("nobody can make a page they couldn't see, and editors must be able to see", async () => {
    expect((await call("POST", "/wiki/pages", "crew", { title: "Secret", viewMin: "manager", editMin: "manager" })).status).toBe(403);
    expect((await call("POST", "/wiki/pages", "admin", { title: "Odd", viewMin: "admin", editMin: "employee" })).status).toBe(400);
    expect((await call("POST", "/wiki/pages", "crew", { title: "Pinned?", pinned: true })).status).toBe(403);
    const mine = await call("POST", "/wiki/pages", "crew", { title: "Crew carpool", editMin: "employee" });
    expect(mine.status).toBe(200);
  });
});

describe("seeing and editing", () => {
  it("each role sees only the pages its level allows", async () => {
    expect(await titles("crew")).toEqual(["Crew carpool", "Crew tips", "Safety rules", "Welcome"]);
    expect(await titles("mgr")).toEqual(["Crew carpool", "Crew tips", "Manager handbook", "Safety rules", "Welcome"]);
    expect((await titles("admin"))).toContain("Vendor accounts");
    // A hidden page looks like it doesn't exist.
    expect((await call("GET", `/wiki/pages/${P.vendors.id}`, "mgr")).status).toBe(404);
  });

  it("edit levels are enforced per page", async () => {
    expect((await call("PATCH", `/wiki/pages/${P.safety.id}`, "crew", { body: "No PPE needed" })).status).toBe(403);
    expect((await call("GET", `/wiki/pages/${P.safety.id}`, "crew")).body.canEdit).toBe(false);
    expect((await call("PATCH", `/wiki/pages/${P.safety.id}`, "mgr", { body: "Wear **PPE** and hearing protection.", note: "Added hearing" })).status).toBe(200);
    expect((await call("PATCH", `/wiki/pages/${P.tips.id}`, "crew", { body: "Bring water." })).status).toBe(200);
  });

  it("only admins change who can see or edit, pin, or move pages", async () => {
    expect((await call("PATCH", `/wiki/pages/${P.tips.id}`, "crew", { editMin: "admin" })).status).toBe(403);
    expect((await call("PATCH", `/wiki/pages/${P.safety.id}`, "mgr", { pinned: true })).status).toBe(403);
    expect((await call("PATCH", `/wiki/pages/${P.tips.id}`, "admin", { viewMin: "manager", editMin: "manager" })).status).toBe(200);
    expect(await titles("crew")).not.toContain("Crew tips");
    await call("PATCH", `/wiki/pages/${P.tips.id}`, "admin", { viewMin: "employee", editMin: "employee" });
  });

  it("stops a save that would overwrite someone else's changes", async () => {
    const before = (await call("GET", `/wiki/pages/${P.tips.id}`, "crew")).body;
    await call("PATCH", `/wiki/pages/${P.tips.id}`, "mgr", { body: "Bring water and sunscreen.", baseUpdatedAt: before.updatedAt });
    const stale = await call("PATCH", `/wiki/pages/${P.tips.id}`, "crew", { body: "Bring snacks.", baseUpdatedAt: before.updatedAt });
    expect(stale.status).toBe(409);
    expect((await call("GET", `/wiki/pages/${P.tips.id}`, "crew")).body.body).toBe("Bring water and sunscreen.");
  });
});

describe("structure, history and search", () => {
  it("nests pages, shows breadcrumbs, and refuses loops", async () => {
    const child = (await call("POST", "/wiki/pages", "admin", { title: "Ladder safety", parentId: P.safety.id, body: "Three points of contact." })).body;
    const grandchild = (await call("POST", "/wiki/pages", "admin", { title: "Extension ladders", parentId: child.id })).body;
    const view = (await call("GET", `/wiki/pages/${grandchild.id}`, "crew")).body;
    expect(view.breadcrumbs.map((c: any) => c.title)).toEqual(["Safety rules", "Ladder safety"]);
    expect((await call("GET", `/wiki/pages/${P.safety.id}`, "crew")).body.children.map((c: any) => c.title)).toEqual(["Ladder safety"]);
    expect((await call("PATCH", `/wiki/pages/${P.safety.id}`, "admin", { parentId: grandchild.id })).status).toBe(400);

    // A visible sub-page under a hidden parent shows at the top level instead of disappearing.
    const sub = (await call("POST", "/wiki/pages", "admin", { title: "Shared checklist", parentId: P.managers.id })).body;
    const crewList = (await call("GET", "/wiki/pages", "crew")).body as any[];
    expect(crewList.find((p) => p.id === sub.id).parentId).toBeNull();
  });

  it("keeps every version and lets editors restore one", async () => {
    const revs = (await call("GET", `/wiki/pages/${P.safety.id}/revisions`, "mgr")).body as any[];
    expect(revs.map((r) => r.note)).toEqual(["Added hearing", "Created"]);
    expect(revs[0].editedBy).toBe("mgr Test");
    expect((await call("GET", `/wiki/pages/${P.safety.id}/revisions`, "crew")).status).toBe(403);
    const restored = await call("POST", `/wiki/pages/${P.safety.id}/restore/${revs[1].id}`, "mgr");
    expect(restored.body.body).toBe("Wear **PPE** on every job site.");
    expect(((await call("GET", `/wiki/pages/${P.safety.id}/revisions`, "mgr")).body as any[])[0].note).toMatch(/^Restored the version from/);
  });

  it("searches titles and text, only within what you can see", async () => {
    const res = (await call("GET", "/wiki/pages?q=ppe", "crew")).body as any[];
    expect(res.map((p) => p.title)).toEqual(["Safety rules"]);
    expect(res[0].snippet).toContain("PPE");
    expect(await titles("crew", "fuel card")).toEqual([]);
    expect(await titles("admin", "fuel card")).toEqual(["Vendor accounts"]);
  });
});

describe("notifications and deleting", () => {
  it("'notify' reaches only people who can see the page", async () => {
    await call("PATCH", `/wiki/pages/${P.managers.id}`, "admin", { body: "New approval steps.", notify: true, note: "New approval steps" });
    await flushNotifications();
    expect(pushedTo("mgr")).toEqual(["Updated wiki page: Manager handbook"]);
    expect(pushedTo("crew")).toEqual([]);
    expect(pushedTo("admin")).toEqual([]); // not your own edit

    pushes = [];
    await call("PATCH", `/wiki/pages/${P.welcome.id}`, "admin", { body: "Welcome aboard!" });
    await flushNotifications();
    expect(pushes).toHaveLength(0); // no announcement unless asked
  });

  it("admins delete pages (sub-pages move up) and can restore them", async () => {
    expect((await call("DELETE", `/wiki/pages/${P.safety.id}`, "mgr")).status).toBe(403);
    await call("DELETE", `/wiki/pages/${P.safety.id}`, "admin");
    expect(await titles("crew")).not.toContain("Safety rules");
    const ladder = ((await call("GET", "/wiki/pages", "crew")).body as any[]).find((p) => p.title === "Ladder safety");
    expect(ladder.parentId).toBeNull();
    expect(((await call("GET", "/wiki/deleted", "admin")).body as any[]).map((p) => p.title)).toContain("Safety rules");
    await call("POST", `/wiki/pages/${P.safety.id}/undelete`, "admin");
    expect(await titles("crew")).toContain("Safety rules");
  });
});

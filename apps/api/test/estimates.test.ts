/** Estimates: numbering, totals with optional lines and visits, sending, the customer's link (accept / decline / changes), office answers, invoice and work order, the list filter. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotifications, setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@est.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];

async function call(method: string, url: string, who: string | null, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, headers: res.headers };
}
const tokenOf = (link: string) => link.split("/estimate/")[1];

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Quote Co", firstName: "Quinn", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Quote Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", phone: "(405) 555-0100", email: "office@est.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Olive", lastName: "Office", email: email("office"), password: "password123", role: "manager" });
  T.office = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("office"), password: "password123" } })).json().token;
  await call("POST", "/employees", "owner", { firstName: "Cal", lastName: "Crew", email: email("crew"), password: "password123", role: "employee" });
  T.crew = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("crew"), password: "password123" } })).json().token;
  const ann = await call("POST", "/customers", "office", { firstName: "Ann", lastName: "Apple", email: email("ann"), property: { street: "1 Oak St", city: "Norman", zip: "73069" } });
  ID.ann = ann.body.id;
  ID.annProp = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0].id;
  ID.bob = (await call("POST", "/customers", "office", { firstName: "Bob", lastName: "Berry", email: email("bob") })).body.id;
  ID.aer = (await call("POST", "/service-types", "owner", { name: "Core aeration", pricing: "flat", priceCents: 9500, incomeAccountCode: "4200" })).body.id;
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

const lines = () => [
  { description: "Fertilizer round", quantity: 1, unitPriceCents: 5000, visits: 6, costCents: 2000, budgetedHours: 0.25 },
  { serviceTypeId: ID.aer, description: "Core aeration", quantity: 1, unitPriceCents: 9500, optional: true, selected: true, recommended: true, incomeAccountCode: "4200" },
  { description: "Grub control", quantity: 1, unitPriceCents: 7500, optional: true, selected: false },
];

describe("estimates", () => {
  it("managers only; numbered from 1000; totals count the ticked optional lines", async () => {
    expect((await call("GET", "/estimates", "crew")).status).toBe(403);
    expect((await call("POST", "/estimates", "office", { customerId: ID.ann, lines: [] })).status).toBe(400);
    const r = await call("POST", "/estimates", "office", { customerId: ID.ann, propertyId: ID.annProp, title: "2027 lawn program", discountPercent: 10, terms: "Good for 30 days", internalNotes: "Big lawn", lines: lines() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: 1000, status: "draft", subtotalCents: 39500, discountCents: 3950, totalCents: 35550, serviceAddress: expect.stringContaining("1 Oak St") });
    expect(r.body.internal).toMatchObject({ costCents: 12000, hours: 1.5 });
    ID.est = r.body.id;
    ID.optAer = r.body.lines[1].id; ID.optGrub = r.body.lines[2].id;
    const second = await call("POST", "/estimates", "office", { customerId: ID.bob, lines: [{ description: "Cleanup", quantity: 2, unitPriceCents: 4000 }] });
    expect(second.body.number).toBe(1001);
    ID.bobEst = second.body.id;
    const list = await call("GET", "/estimates", "office");
    expect(list.body.counts).toMatchObject({ draft: 2, all: 2 });
    expect((await call("GET", "/estimates?q=apple", "office")).body.rows.map((e: any) => e.number)).toEqual([1000]);
  });

  it("editing keeps line ids; the PDF; sending emails a link and the PDF", async () => {
    const cur = (await call("GET", `/estimates/${ID.est}`, "office")).body;
    const upd = await call("PUT", `/estimates/${ID.est}`, "office", { customerId: ID.ann, propertyId: ID.annProp, title: "2027 lawn program", discountPercent: 10, terms: "Good for 30 days", lines: cur.lines.map((l: any) => ({ ...l })) });
    expect(upd.body.lines.map((l: any) => l.id)).toEqual(cur.lines.map((l: any) => l.id));
    const pdf = await call("GET", `/estimates/${ID.est}/pdf`, "office");
    expect(pdf.headers["content-type"]).toMatch(/pdf/);
    sent.length = 0;
    const s = await call("POST", `/estimates/${ID.est}/send`, "office", { message: "Thanks for having us out." });
    expect(s.body).toMatchObject({ status: "sent", emailedTo: email("ann") });
    expect(sent[0]).toMatchObject({ to: email("ann"), subject: "Estimate 1000 from Quote Co" });
    expect(sent[0].attachments?.[0].filename).toBe("Estimate-1000.pdf");
    expect(sent[0].text).toContain(s.body.link);
    ID.token = tokenOf(s.body.link);
  });

  it("the customer's link: no sign-in, no internal notes or costs; viewing is noted", async () => {
    expect((await call("GET", "/public/estimates/not-a-real-token-xxxxxxxx", null)).status).toBe(404);
    const v = await call("GET", `/public/estimates/${ID.token}`, null);
    expect(v.body).toMatchObject({ canRespond: true, company: { name: "Quote Co" }, estimate: { number: 1000, totalCents: 35550 } });
    expect(JSON.stringify(v.body)).not.toMatch(/internalNotes|costCents|Big lawn/);
    expect((await call("GET", `/estimates/${ID.est}`, "office")).body.viewedAt).toBeTruthy();
    expect((await call("GET", `/public/estimates/${ID.token}/pdf`, null)).headers["content-type"]).toMatch(/pdf/);
  });

  it("asks for changes (needs a comment), then accepts with their choice of options; the office is told", async () => {
    expect((await call("POST", `/public/estimates/${ID.token}/respond`, null, { action: "changes" })).status).toBe(400);
    const ch = await call("POST", `/public/estimates/${ID.token}/respond`, null, { action: "changes", comment: "Can you do grub control instead of aeration?" });
    expect(ch.body.estimate).toMatchObject({ status: "changes", responseComment: "Can you do grub control instead of aeration?" });
    expect(ch.body.canRespond).toBe(true);
    // Notifications go out in the background: wait for them before looking.
    await flushNotifications();
    expect((await call("GET", "/notifications", "office")).body.items?.[0]?.title ?? (await call("GET", "/notifications", "office")).body[0]?.title).toMatch(/asked for changes to estimate 1000/);
    expect((await call("POST", `/public/estimates/${ID.token}/respond`, null, { action: "accept" })).body.error).toMatch(/Type your name/);
    const ok = await call("POST", `/public/estimates/${ID.token}/respond`, null, { action: "accept", name: "Ann Apple", selectedLineIds: [ID.optGrub] });
    expect(ok.body.estimate).toMatchObject({ status: "accepted", responseName: "Ann Apple", subtotalCents: 37500, totalCents: 33750 });
    expect(ok.body.estimate.lines.map((l: any) => l.included)).toEqual([true, false, true]);
    expect(ok.body.canRespond).toBe(false);
    expect((await call("POST", `/public/estimates/${ID.token}/respond`, null, { action: "decline" })).body.error).toMatch(/already accepted/);
    expect((await call("PUT", `/estimates/${ID.est}`, "office", { customerId: ID.ann, lines: lines() })).body.error).toMatch(/make a copy/);
  });

  it("an accepted estimate becomes a draft invoice (visits as quantity) and links a work order", async () => {
    const inv = await call("POST", `/estimates/${ID.est}/invoice`, "office");
    expect(inv.status).toBe(200);
    const i = (await call("GET", `/invoices/${inv.body.invoiceId}`, "office")).body;
    expect(i).toMatchObject({ status: "draft", discountKind: "percent", discountValue: 10, subtotalCents: 37500, totalCents: 33750 });
    expect(i.lines.map((l: any) => [l.description, l.quantity])).toEqual([["Fertilizer round", 6], ["Grub control", 1]]);
    expect((await call("POST", `/estimates/${ID.est}/invoice`, "office")).body.error).toMatch(/already been invoiced/);
    const wo = await call("POST", "/visits", "office", { estimateId: ID.est, title: "2027 lawn program", customerId: ID.ann, propertyId: ID.annProp, scheduling: "waitlist", lines: [{ description: "Fertilizer round", quantity: 1, unitPriceCents: 5000 }] });
    expect(wo.status).toBe(200);
    const e = (await call("GET", `/estimates/${ID.est}`, "office")).body;
    expect(e).toMatchObject({ visitId: wo.body.id, invoiceId: inv.body.invoiceId });
    expect((await call("DELETE", `/estimates/${ID.est}`, "office")).body.error).toMatch(/kept/);
    expect((await call("POST", `/estimates/${ID.est}/reopen`, "office")).status).toBe(400);
  });

  it("the office records a phone answer, can undo it, copies an estimate, deletes a draft", async () => {
    const d = await call("POST", `/estimates/${ID.bobEst}/respond`, "office", { action: "decline", comment: "Too expensive" });
    expect(d.body).toMatchObject({ status: "declined", respondedBy: "office", respondedByName: "Olive Office" });
    const back = await call("POST", `/estimates/${ID.bobEst}/reopen`, "office");
    expect(back.body.status).toBe("draft");
    const copy = await call("POST", `/estimates/${ID.est}/copy`, "office");
    expect(copy.body.number).toBe(1002);
    const c = (await call("GET", `/estimates/${copy.body.id}`, "office")).body;
    expect(c).toMatchObject({ status: "draft", totalCents: 35550, title: "2027 lawn program" });
    expect((await call("DELETE", `/estimates/${copy.body.id}`, "office")).status).toBe(200);
  });

  it("Customers list: Estimates filter and Open estimates column", async () => {
    await call("POST", `/estimates/${ID.bobEst}/send`, "office", {});
    const q = async (v: string[]) => (await call("GET", `/customers?status=all&filters=${encodeURIComponent(JSON.stringify([{ f: "estimate", op: "is", v }]))}`, "office")).body.rows.map((r: any) => r.name).sort();
    expect(await q(["accepted"])).toEqual(["Ann Apple"]);
    expect(await q(["sent"])).toEqual(["Bob Berry"]);
    const row = (await call("GET", "/customers?status=all&q=Berry", "office")).body.rows[0];
    expect(row.openEstimates).toBe(8000);
  });
});

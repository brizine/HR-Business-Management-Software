/** Marketing → Templates: the library, Crewdesk's own templates, previews, the defaults, invoices sent with them, history and opens, import. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@templates.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
async function call(method: string, url: string, who: string | null, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, headers: res.headers };
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Template Co", firstName: "Tess", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Template Co", addressLine1: "1 Main", city: "Norman", state: "OK", zip: "73069", phone: "4055550199", email: "office@templates.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Mo", lastName: "Manager", email: email("mgr"), password: "password123", role: "manager" });
  T.mgr = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("mgr"), password: "password123" } })).json().token;
  await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" });
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  ID.cust = (await call("POST", "/customers", "owner", { firstName: "Ann", lastName: "Lee", email: email("ann"), property: { street: "9 Elm St", city: "Norman", state: "OK", zip: "73069" } })).body.id;
  const inv = await call("POST", "/invoices", "owner", { customerId: ID.cust, issueDate: "2026-03-02", dueDate: "2026-03-17", lines: [{ description: "Round 1", quantity: 1, unitPriceCents: 4500 }] });
  ID.inv = inv.body.id;
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await pool.end();
});

describe("templates", () => {
  it("every company has Crewdesk's own invoice, estimate and receipt templates; they can't be deleted, only reset", async () => {
    expect((await call("GET", "/templates", "tech")).status).toBe(403);
    const list = (await call("GET", "/templates", "mgr")).body;
    const own = list.filter((t: any) => t.system);
    expect(own.map((t: any) => t.systemKey).sort()).toEqual(["estimate_email", "estimate_text", "invoice_email", "invoice_text", "receipt_email", "receipt_text"]);
    const inv = own.find((t: any) => t.systemKey === "invoice_email");
    expect(inv).toMatchObject({ channel: "email", usedFor: ["invoice"], needs: ["invoice"] });
    ID.sysInvoice = inv.id;
    expect((await call("DELETE", `/templates/${inv.id}`, "mgr")).body.error).toMatch(/can't be deleted/);
    const changed = await call("PUT", `/templates/${inv.id}`, "mgr", { channel: "email", name: "Invoice", subject: "Your bill", body: "<p>Hi</p>" });
    expect(changed.body).toMatchObject({ subject: "Your bill", system: true });
    expect((await call("POST", `/templates/${inv.id}/reset`, "mgr")).body.subject).toMatch(/^Invoice \{\{INVOICE_NUMBER\}\}/);
  });

  it("saves emails cleaned (no scripts or outside images) and texts as plain text; clones and deletes", async () => {
    expect((await call("POST", "/templates", "mgr", { channel: "email", name: "No subject", body: "<p>Hi</p>" })).status).toBe(400);
    const e = await call("POST", "/templates", "mgr", {
      channel: "email", audience: "customer", name: "Spring special", subject: "Spring is here, {{CUSTOMER_FIRST_NAME}}",
      body: '<p style="text-align: center">Hi {{CUSTOMER_FIRST_NAME}}<script>alert(1)</script><img src="https://x.co/a.png"></p><h1>Big</h1><p><a href="{{REVIEW_PAGE}}">Review us</a> {{INVOICES_LINKS}}</p>',
    });
    expect(e.status).toBe(200);
    expect(e.body.body).toBe('<p style="text-align:center">Hi {{CUSTOMER_FIRST_NAME}}</p><h2>Big</h2><p><a href="{{REVIEW_PAGE}}">Review us</a> {{INVOICES_LINKS}}</p>');
    expect(e.body.needs).toEqual(["invoice"]);
    ID.spring = e.body.id;
    const t = await call("POST", "/templates", "mgr", { channel: "text", name: "Thanks", body: "Thanks {{CUSTOMER_FIRST_NAME}}! 🌱\r\n" });
    expect(t.body).toMatchObject({ channel: "text", subject: null, body: "Thanks {{CUSTOMER_FIRST_NAME}}! 🌱" });
    ID.thanks = t.body.id;
    expect((await call("PUT", `/templates/${t.body.id}`, "mgr", { channel: "email", name: "x", subject: "x", body: "<p>x</p>" })).status).toBe(400);
    const c = await call("POST", `/templates/${t.body.id}/clone`, "mgr");
    expect(c.body).toMatchObject({ name: "Copy of Thanks", channel: "text" });
    expect((await call("DELETE", `/templates/${c.body.id}`, "mgr")).status).toBe(200);
  });

  it("previews with example values, or filled in for a customer and their invoice (missing details are named)", async () => {
    const sample = await call("POST", "/templates/preview", "mgr", { channel: "text", body: "Hi {{CUSTOMER_FIRST_NAME}}, pay {{INVOICE_BALANCE}} {{OOPS}}" });
    expect(sample.body).toMatchObject({ sample: true, text: "Hi Jane, pay $85.00", unknown: ["OOPS"], segments: { segments: 1 } });
    const noInv = await call("POST", "/templates/preview", "mgr", { channel: "email", subject: "Hi {{CUSTOMER_FIRST_NAME}}", body: "<p>{{INVOICE_BALANCE}}</p>", customerId: ID.cust });
    expect(noInv.body).toMatchObject({ sample: false, subject: "Hi Ann", missing: ["invoice"] });
    const p = await call("POST", "/templates/preview", "mgr", { channel: "email", subject: "Invoice {{INVOICE_NUMBER}}", body: "<p>Hello {{CUSTOMER_NAME}}, you owe {{INVOICE_BALANCE}} due {{INVOICE_DUE_DATE}}.</p><p>{{INVOICES_LINKS}}</p><p>Call {{COMPANY_PHONE}}</p>", invoiceId: ID.inv });
    expect(p.body.subject).toBe("Invoice (draft)");
    expect(p.body.html).toContain("Hello Ann Lee, you owe $45.00 due March 17, 2026.");
    // A link alone on its line is a button; the company's details are in the footer.
    expect(p.body.html).toMatch(/<a href="[^"]+\/portal\?c=[^"]+" style="display:inline-block;background:#1f7a3a[^"]*">View and pay your invoice<\/a>/);
    expect(p.body.html).toContain("Call (405) 555-0199");
    expect(p.body.text).toContain("View and pay your invoice: http");
    const ctx = await call("GET", `/templates/context?customerId=${ID.cust}`, "mgr");
    expect(ctx.body.invoices).toHaveLength(1);
    expect((await call("POST", "/templates/test", "mgr", { channel: "email", subject: "Test {{CUSTOMER_FIRST_NAME}}", body: "<p>Hi</p>" })).body).toEqual({ to: email("mgr") });
    expect(sent.at(-1)).toMatchObject({ to: email("mgr"), subject: "[Test] Test Jane" });
  });

  it("the defaults say which template goes with invoices, estimates and receipts (admins choose)", async () => {
    const d = (await call("GET", "/templates/defaults/current", "mgr")).body;
    expect(d.invoice).toEqual({ email: ID.sysInvoice, text: expect.any(String), attachPdf: true });
    expect(d.receipt.attachPdf).toBe(false);
    const want = { ...d, invoice: { email: ID.spring, text: null, attachPdf: false }, reviewUrl: "https://g.page/r/template-co/review" };
    expect((await call("PUT", "/templates/defaults/current", "mgr", want)).status).toBe(403);
    expect((await call("PUT", "/templates/defaults/current", "owner", { ...want, invoice: { email: ID.thanks, text: null, attachPdf: true } })).body.error).toMatch(/Pick an email template/);
    const est = (await call("POST", "/templates", "mgr", { channel: "email", name: "Est", subject: "E", body: "<p>{{ESTIMATE_LINK}}</p>" })).body;
    expect((await call("PUT", "/templates/defaults/current", "owner", { ...want, invoice: { email: est.id, text: null, attachPdf: true } })).body.error).toMatch(/uses estimate details/);
    const ok = await call("PUT", "/templates/defaults/current", "owner", want);
    expect(ok.body.invoice).toEqual({ email: ID.spring, text: expect.any(String), attachPdf: false });
    // In use: can't be deleted.
    expect((await call("DELETE", `/templates/${ID.spring}`, "mgr")).body.error).toMatch(/goes out with invoice/);
  });

  it("invoices go out with the chosen template (no PDF when it's turned off), logged with opens", async () => {
    sent.length = 0;
    const r = await call("POST", `/invoices/${ID.inv}/send`, "owner", { via: ["email"] });
    expect(r.status).toBe(200);
    const m = sent.at(-1)!;
    expect(m).toMatchObject({ to: email("ann"), subject: "Spring is here, Ann", fromName: "Template Co" });
    expect(m.attachments ?? []).toEqual([]);
    expect(m.html).toContain('<a href="https://g.page/r/template-co/review">Review us</a>');
    // Bills always go: no unsubscribe link on them.
    expect(m.html).not.toContain("Unsubscribe");
    const pixel = m.html.match(/\/public\/t\/o\/([0-9a-f-]{36})\.gif/)!;
    expect(pixel).toBeTruthy();
    const hist = (await call("GET", "/templates/history/list", "mgr")).body;
    expect(hist[0]).toMatchObject({ to: email("ann"), subject: "Spring is here, Ann", status: "sent", openCount: 0, customer: { id: ID.cust, name: "Ann Lee" }, template: { id: ID.spring, name: "Spring special" } });
    // Opening it (the mail app loads the image) counts.
    const img = await call("GET", `/public/t/o/${pixel[1]}.gif`, null);
    expect(img.headers["content-type"]).toBe("image/gif");
    await call("GET", `/public/t/o/${pixel[1]}.gif`, null);
    expect((await call("GET", "/public/t/o/not-a-uuid.gif", null)).status).toBe(200);
    const opened = (await call("GET", "/templates/history/list?status=opened", "mgr")).body;
    expect(opened[0]).toMatchObject({ id: pixel[1], openCount: 2, openedAt: expect.any(String) });
    const one = (await call("GET", `/templates/history/${pixel[1]}`, "mgr")).body;
    expect(one.body).toContain("Hi Ann");
    expect((await call("GET", "/templates/history/list?status=unopened", "mgr")).body.map((x: any) => x.id)).not.toContain(pixel[1]);
  });

  it("imports templates from Homeworks once (admins)", async () => {
    const file = {
      source: "homeworks",
      templates: [
        { channel: "email", name: "New Invoice v4", audience: "customer", subject: "Your Invoice is Ready!", body: "<p>Dear {{CUSTOMER_FIRST_NAME}},</p><p>{{INVOICES_LINKS}}</p>", system: true, homeworksId: 592700 },
        { channel: "text", name: "On Our Way (Customer)", audience: "customer", body: "We're on our way to {{EVENT_PROPERTY_ADDRESS}}!", homeworksId: 109600 },
        { channel: "email", name: "Empty one", audience: "internal", subject: "x", body: "<p> </p>", homeworksId: 1 },
      ],
    };
    expect((await call("POST", "/templates/import", "mgr", file)).status).toBe(403);
    expect((await call("POST", "/templates/import", "owner", file)).body).toEqual({ added: 2, skipped: 1 });
    expect((await call("POST", "/templates/import", "owner", file)).body).toEqual({ added: 0, skipped: 3 });
    const list = (await call("GET", "/templates", "mgr")).body;
    expect(list.find((t: any) => t.name === "New Invoice v4")).toMatchObject({ imported: "homeworks", system: false, needs: ["invoice"] });
    expect(list.find((t: any) => t.name === "On Our Way (Customer)")).toMatchObject({ channel: "text", needs: ["visit"] });
  });
});

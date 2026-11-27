/** Resources → Templates: the library, Crewdesk's own templates, previews, the defaults, invoices sent with them, history and opens, import. */
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
    expect(own.map((t: any) => t.systemKey).sort()).toEqual(["estimate_email", "estimate_text", "invoice_email", "invoice_text", "receipt_email", "receipt_text", "visitform_email"]);
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
    expect(c.body).toMatchObject({ name: "Copy - Thanks", channel: "text" });
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
    expect((await call("POST", "/templates/import", "owner", file)).body).toEqual({ added: 2, updated: 0, kept: 0, skipped: 1 });
    expect((await call("POST", "/templates/import", "owner", file)).body).toEqual({ added: 0, updated: 0, kept: 0, skipped: 3 });
    const list = (await call("GET", "/templates", "mgr")).body;
    expect(list.find((t: any) => t.name === "New Invoice v4")).toMatchObject({ imported: "homeworks", system: false, needs: ["invoice"] });
    expect(list.find((t: any) => t.name === "On Our Way (Customer)")).toMatchObject({ channel: "text", needs: ["visit"] });
    ID.hwInvoice = list.find((t: any) => t.name === "New Invoice v4").id;
  });

  const block = (type: string, p: Record<string, unknown>, id = type) => ({ id, type, p });
  const oneRow = (...blocks: unknown[]) => ({ v: 1, p: { width: 600, bg: "#eeeeee", contentBg: "#ffffff", font: "Georgia", linkColor: "#0068a5" }, rows: [{ id: "r1", p: { bg: "transparent" }, columns: [{ id: "c1", span: 12, p: { padTop: 10 }, blocks }] }] });

  it("an email made in the builder is saved as its design; the email is made from it here, cleaned", async () => {
    const design = oneRow(
      block("title", { html: "Hi <b>{{CUSTOMER_FIRST_NAME}}</b><script>alert(1)</script>", level: "h1", size: 26, align: "center" }),
      block("paragraph", { html: '<p onclick="x()">Thanks from <span style="color: #ff0000; position: fixed">{{COMPANY_NAME}}</span>.</p><iframe src="https://evil.test"></iframe>' }),
      block("button", { text: "See your estimate", href: "{{ESTIMATE_LINK}}", bg: "#1f7a3a" }),
      block("html", { html: '<table><tr><td style="color:red" onmouseover="x()">Raw</td></tr></table><script>bad()</script>' }),
    );
    expect((await call("POST", "/templates", "mgr", { channel: "email", name: "Built", subject: "Hello", design: oneRow(block("divider", {})) })).body.issues[0].message).toMatch(/has no content/);
    const made = await call("POST", "/templates", "mgr", { channel: "email", name: "Built", subject: "Hello {{CUSTOMER_FIRST_NAME}}", body: "<p>ignored, the design is what counts</p>", design });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ designed: true, needs: ["estimate"] });
    expect(made.body.body.startsWith("<!--crewdesk-design-->")).toBe(true);
    expect(made.body.body).not.toMatch(/script|onclick|iframe|onmouseover|position|ignored/);
    expect(made.body.body).toContain('<span style="color:#ff0000">{{COMPANY_NAME}}</span>');
    expect(made.body.body).toContain('href="{{ESTIMATE_LINK}}"');
    expect(made.body.body).toContain('width="600"');
    ID.built = made.body.id;
    const got = (await call("GET", `/templates/${ID.built}`, "mgr")).body;
    expect(got.design.rows[0].columns[0].blocks.map((b: any) => b.type)).toEqual(["title", "paragraph", "button", "html"]);
    expect(got.design.rows[0].columns[0].blocks[0].p.html).toBe("Hi <b>{{CUSTOMER_FIRST_NAME}}</b>");
    // Changing it keeps it a design; a copy carries the design too.
    design.rows[0].columns[0].blocks.push(block("paragraph", { html: "<p>PS: thank you.</p>" }, "ps"));
    expect((await call("PUT", `/templates/${ID.built}`, "mgr", { channel: "email", name: "Built", subject: "Hello", design })).body.body).toContain("PS: thank you.");
    const copy = (await call("POST", `/templates/${ID.built}/clone`, "mgr")).body;
    expect(copy).toMatchObject({ name: "Copy - Built", designed: true });
    expect((await call("GET", `/templates/${copy.id}`, "mgr")).body.design.rows[0].columns[0].blocks).toHaveLength(5);
  });

  it("a designed email goes out as designed, with the company's details and unsubscribe underneath", async () => {
    const built = (await call("GET", `/templates/${ID.built}`, "mgr")).body;
    const p = (await call("POST", "/templates/preview", "mgr", { channel: "email", subject: built.subject, design: built.design, customerId: ID.cust })).body;
    expect(p.html).toContain("cd-design");
    expect(p.html).toContain("Hi <b>Ann</b>");
    expect(p.html).toContain("@media (max-width:620px)");
    expect(p.html).toContain("Template Co · 1 Main, Norman, OK 73069");
    expect(p.html).not.toContain("max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px");
    expect(p.missing).toEqual(["estimate"]);
    // A test goes to the address typed (or to you).
    sent.length = 0;
    expect((await call("POST", "/templates/test", "mgr", { channel: "email", subject: "Hello", design: built.design, to: "not an email" })).body.issues[0].message).toBe("Invalid email format.");
    expect((await call("POST", "/templates/test", "mgr", { channel: "email", subject: "Hello", design: built.design, to: email("elsewhere") })).body).toEqual({ to: email("elsewhere") });
    expect(sent[sent.length - 1]).toMatchObject({ to: email("elsewhere"), subject: "[Test] Hello" });
    expect(sent[sent.length - 1].html).toContain("Hi <b>Jane</b>");
    expect((await call("POST", "/templates/test", "mgr", { channel: "email", subject: "Hello", design: built.design })).body).toEqual({ to: email("mgr") });
  });

  it("an earlier plain template opens in the builder as blocks, and Crewdesk's own can be reset", async () => {
    const plain = (await call("POST", "/templates", "mgr", { channel: "email", name: "Plain", subject: "Hi", body: "<h2>Welcome</h2><p>One</p><p>Two</p><ul><li>A</li></ul>" })).body;
    expect(plain.designed).toBe(false);
    const d = (await call("GET", `/templates/${plain.id}`, "mgr")).body.design;
    expect(d.p.width).toBe(600);
    expect(d.rows[0].columns[0].blocks.map((b: any) => b.type)).toEqual(["title", "paragraph", "list"]);
    // Crewdesk's invoice email: its name can't be changed, and Reset puts the plain wording back.
    const own = await call("PUT", `/templates/${ID.sysInvoice}`, "mgr", { channel: "email", name: "Renamed", subject: "Your bill", design: d });
    expect(own.body).toMatchObject({ name: "Invoice (Crewdesk)", designed: true, system: true });
    expect((await call("POST", `/templates/${ID.sysInvoice}/reset`, "mgr")).body).toMatchObject({ designed: false });
    const text = (await call("GET", "/templates", "mgr")).body.find((t: any) => t.channel === "text");
    expect((await call("GET", `/templates/${text.id}`, "mgr")).body.design).toBeNull();
  });

  it("Homeworks' designs come in as designs; a newer file updates only templates nobody changed here", async () => {
    const bee = (text: string) => ({ page: { body: { container: { style: { "background-color": "#FFFFFF" } }, content: { computedStyle: { messageWidth: "500px", linkColor: "#0068A5" }, style: { "font-family": "Arial, sans-serif" } } }, rows: [{ container: { style: {} }, content: { computedStyle: {}, style: {} }, columns: [{ "grid-columns": 12, style: {}, modules: [
      { type: "mailup-bee-newsletter-modules-image", descriptor: { style: {}, computedStyle: { class: "center autowidth" }, image: { src: "https://img.test/invoice.png", alt: "" } } },
      { type: "mailup-bee-newsletter-modules-paragraph", descriptor: { style: { "padding-top": "10px" }, paragraph: { html: `<p>Dear <code data-bee-type="mergetag" data-bee-name="CUSTOMER FIRST NAME">{{CUSTOMER_FIRST_NAME}}</code>, ${text}</p>`, style: { "font-size": "14px" } } } },
    ] }] }] } });
    const file = (text: string) => ({ source: "homeworks", templates: [
      { channel: "email", name: "New Invoice v4", audience: "customer", subject: "Your Invoice is Ready!", bee: JSON.stringify(JSON.stringify(bee(text))), homeworksId: 592700 },
      { channel: "email", name: "Brand new", audience: "customer", subject: "Hi", bee: bee("welcome."), homeworksId: 592999 },
    ] });
    // The first, plain import of "New Invoice v4" was never changed here, so the design replaces it.
    expect((await call("POST", "/templates/import", "owner", file("your invoice is ready."))).body).toEqual({ added: 1, updated: 1, kept: 0, skipped: 0 });
    const t = (await call("GET", `/templates/${ID.hwInvoice}`, "mgr")).body;
    expect(t).toMatchObject({ designed: true, imported: "homeworks" });
    expect(t.design.rows[0].columns[0].blocks.map((b: any) => [b.type, b.p.src ?? b.p.html])).toEqual([["image", "https://img.test/invoice.png"], ["paragraph", "<p>Dear {{CUSTOMER_FIRST_NAME}}, your invoice is ready.</p>"]]);
    expect(t.body).toContain('<img src="https://img.test/invoice.png"');
    expect((await call("POST", "/templates/import", "owner", file("your invoice is ready."))).body).toEqual({ added: 0, updated: 0, kept: 0, skipped: 2 });
    // Once it's changed in Crewdesk, an import leaves it alone.
    await call("PUT", `/templates/${ID.hwInvoice}`, "mgr", { channel: "email", name: "New Invoice v4", subject: "Ours now", design: t.design });
    expect((await call("POST", "/templates/import", "owner", file("something else."))).body).toEqual({ added: 0, updated: 0, kept: 1, skipped: 1 });
    expect((await call("GET", `/templates/${ID.hwInvoice}`, "mgr")).body.subject).toBe("Ours now");
  });

  it("fills Homeworks' other tags: the employee, why a work order was skipped, the invoice's tax, an unsubscribe link", async () => {
    const tech = (await call("GET", "/employees", "owner")).body.find((e: any) => e.firstName === "Tia").id;
    const propertyId = (await pool.query("select property_id from property_assignments where customer_id = $1", [ID.cust])).rows[0].property_id;
    const visit = (await call("POST", "/visits", "owner", { customerId: ID.cust, propertyId, title: "Round 2", date: "2026-04-06", assigneeIds: [tech], notes: "Gate code 1234", lines: [{ description: "Round 2", quantity: 1, unitPriceCents: 4500 }] })).body;
    if (!visit.id) throw new Error(JSON.stringify(visit));
    const body = "{{EMPLOYEE_FIRST_NAME}} {{EMPLOYEE_LAST_NAME}} | {{PROPERTY_NOT_SERVICED_REASON}} | {{EVENT_NOTES}} | {{INVOICE_TAX}} | {{UNSUBSCRIBE}}";
    const text = async () => (await call("POST", "/templates/preview", "mgr", { channel: "text", body, customerId: ID.cust, visitId: visit.id, invoiceId: ID.inv })).body.text as string;
    // Before it's done: the person it's given to.
    expect(await text()).toMatch(/^Tia Tech \| +\| +\| \$0\.00 \| http\S+\/unsubscribe\?customer=\S+$/);
    // Skipped: who skipped it, and why.
    expect((await call("POST", `/visits/${visit.id}/skip`, "owner", { reason: "Gate locked" })).body.status).toBe("skipped");
    expect(await text()).toMatch(/^Tess Owner \| Gate locked \| +\| \$0\.00 \| http/);
    // In an email the unsubscribe tag is a link.
    const email = (await call("POST", "/templates/preview", "mgr", { channel: "email", subject: "x", body: "<p>{{UNSUBSCRIBE}}</p>", customerId: ID.cust })).body.html as string;
    expect(email).toMatch(/<a href="http[^"]+\/unsubscribe\?customer=[^"]+"[^>]*>Unsubscribe<\/a>/);
  });

  it("says which automations send a template", async () => {
    const tpl = (await call("POST", "/templates", "mgr", { channel: "email", name: "Thanks for paying", subject: "Thank you", body: "<p>Thanks {{CUSTOMER_FIRST_NAME}}</p>" })).body;
    expect(tpl.usedBy).toEqual([]);
    const made = await call("POST", "/automations", "owner", { kind: "simple", name: "Say thanks", enabled: false, trigger: { key: "complete_visit" }, action: { action: "email_customer", templateId: tpl.id } });
    expect(made.status).toBe(200);
    expect((await call("GET", "/templates", "mgr")).body.find((t: any) => t.id === tpl.id).usedBy).toEqual(["Say thanks"]);
    expect((await call("GET", `/templates/${tpl.id}`, "mgr")).body.usedBy).toEqual(["Say thanks"]);
  });

  it("saved rows: a header kept once, used in many templates, changed in one place", async () => {
    const h = (await call("POST", "/templates/brand-header", "mgr", { color: "#14532D" })).body;
    expect(h).toMatchObject({ name: "Header", made: true });
    expect(h.row.p.contentBg).toBe("#14532d");
    expect(h.row.columns[0].blocks[0]).toMatchObject({ type: "title", p: { html: "Template Co", color: "#ffffff" } });
    expect((await call("POST", "/templates/brand-header", "mgr", { color: "green" })).body.issues[0].message).toBe("Pick a color");
    expect((await call("GET", "/templates/rows", "mgr")).body).toMatchObject({ brandColor: "#14532d", rows: [{ id: h.id, name: "Header", usedIn: 0 }] });
    // Two templates use it. Whatever the browser sends for a tied row, the saved row is what's kept.
    const withHeader = (text: string) => ({ v: 1, p: { width: 600 }, rows: [
      { id: "top", p: { saved: h.id, contentBg: "#ff0000" }, columns: [{ id: "x", span: 12, p: {}, blocks: [block("paragraph", { html: "<p>stale</p>" }, "stale")] }] },
      { id: "body", p: {}, columns: [{ id: "c", span: 12, p: {}, blocks: [block("paragraph", { html: `<p>${text}</p>` })] }] },
    ] });
    const a = (await call("POST", "/templates", "mgr", { channel: "email", name: "With header A", subject: "A", design: withHeader("First") })).body;
    const b = (await call("POST", "/templates", "mgr", { channel: "email", name: "With header B", subject: "B", design: withHeader("Second") })).body;
    expect(a.body).toContain("background:#14532d");
    expect(a.body).toContain("Template Co");
    expect(a.body).not.toMatch(/stale|#ff0000/);
    expect((await call("GET", "/templates/rows", "mgr")).body.rows[0].usedIn).toBe(2);
    // A row of your own, saved by name.
    const footer = (await call("POST", "/templates/rows", "mgr", { name: "Footer", row: { id: "f", p: { bg: "#eeeeee" }, columns: [{ id: "fc", span: 12, p: {}, blocks: [block("paragraph", { html: '<p onclick="x()">Call {{COMPANY_PHONE}}</p>' })] }] } })).body;
    expect(footer.row.columns[0].blocks[0].p.html).toBe("<p>Call {{COMPANY_PHONE}}</p>");
    expect((await call("POST", "/templates/rows", "mgr", { name: "", row: footer.row })).body.issues[0].message).toBe("Name the row");
    // Change the header once: both templates follow.
    const blue = { ...h.row, p: { ...h.row.p, contentBg: "#1d4ed8" } };
    expect((await call("PUT", `/templates/rows/${h.id}`, "mgr", { name: "Header", row: blue })).body).toEqual({ ok: true, templates: 2 });
    for (const id of [a.id, b.id]) expect((await call("GET", `/templates/${id}`, "mgr")).body.body).toContain("background:#1d4ed8");
    // Choosing the company colour again changes the header everywhere too.
    expect((await call("POST", "/templates/brand-header", "mgr", { color: "#7c2d12" })).body).toMatchObject({ made: false, templates: 2 });
    expect((await call("GET", `/templates/${a.id}`, "mgr")).body.body).toContain("background:#7c2d12");
    // A background and an accent: the accent is the line under the header, and the company's colour for emails.
    expect((await call("POST", "/templates/brand-header", "mgr", { color: "#FFFFFF", accent: "#15803D" })).body).toMatchObject({ made: false, templates: 2 });
    const lined = (await call("GET", `/templates/${a.id}`, "mgr")).body.body;
    expect(lined).toContain("border-top:4px solid #15803d");
    expect(lined).toMatch(/color:#111111[^>]*>Template Co/);
    expect((await call("GET", "/templates/rows", "mgr")).body).toMatchObject({ brandColor: "#15803d", companyName: "Template Co", logoUrl: null });
    expect((await call("POST", "/templates/brand-header", "mgr", { color: "#7c2d12", accent: "#7c2d12" })).body).toMatchObject({ made: false, templates: 2 });
    // Deleting a saved row leaves it in each template, as that template's own.
    expect((await call("DELETE", `/templates/rows/${footer.id}`, "mgr")).body).toEqual({ ok: true, templates: 0 });
    expect((await call("PUT", `/templates/rows/${footer.id}`, "mgr", { name: "x", row: footer.row })).status).toBe(404);
    ID.header = h.id;
  });

  it("swaps Homeworks' pictures for the company's header in every template (admins)", async () => {
    const hw = "https://prod-beefree-images.s3.amazonaws.com/images/copilot-template-builder-/Internal%20Emails/Estimate%20Accepted.png";
    const made = (await call("POST", "/templates", "mgr", { channel: "email", name: "Old picture", subject: "x", design: oneRow(block("image", { src: hw }), block("paragraph", { html: "<p>Hello</p>" })) })).body;
    expect((await call("GET", "/templates", "mgr")).body.find((t: any) => t.id === made.id).homeworksPictures).toBe(1);
    expect((await call("POST", "/templates/replace-homeworks-pictures", "mgr", { rowId: ID.header })).status).toBe(403);
    expect((await call("POST", "/templates/replace-homeworks-pictures", "owner", { rowId: ID.header })).body).toEqual({ templates: 1, pictures: 1 });
    const after = (await call("GET", `/templates/${made.id}`, "mgr")).body;
    expect(after.homeworksPictures).toBe(0);
    expect(after.design.rows[0].p).toMatchObject({ saved: ID.header, savedName: "Header" });
    expect(after.design.rows[1].columns[0].blocks.map((b: any) => [b.type, b.p.html])).toEqual([["title", "Estimate Accepted"], ["paragraph", "<p>Hello</p>"]]);
    expect(after.body).not.toContain("prod-beefree-images");
    expect((await call("POST", "/templates/replace-homeworks-pictures", "owner", { rowId: ID.header })).body).toEqual({ templates: 0, pictures: 0 });
    // The header's row goes away: the templates keep it as their own.
    expect((await call("DELETE", `/templates/rows/${ID.header}`, "mgr")).body.templates).toBe(3);
    expect((await call("GET", `/templates/${made.id}`, "mgr")).body.design.rows[0].p.saved).toBeUndefined();
  });

  it("pictures for emails are uploaded once and served to anyone who opens the email", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const upload = async (buf: Buffer, name: string, who = "mgr") => {
      const boundary = "----cdtest";
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const res = await app.inject({ method: "POST", url: "/templates/images", payload, headers: { authorization: `Bearer ${T[who]}`, "content-type": `multipart/form-data; boundary=${boundary}` } });
      return { status: res.statusCode, body: res.json() };
    };
    expect((await upload(Buffer.from("<svg onload=alert(1)>"), "x.svg")).body.error).toMatch(/JPEG, PNG or GIF/);
    expect((await upload(png, "logo.png", "tech")).status).toBe(403);
    const up = await upload(png, "logo.png");
    expect(up.status).toBe(200);
    expect(up.body.url).toMatch(/\/public\/email-image\/[0-9a-f-]{36}$/);
    const img = await call("GET", `/public/email-image/${up.body.id}`, null);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(String(img.headers["cache-control"])).toContain("immutable");
    expect((await call("GET", "/public/email-image/00000000-0000-4000-8000-000000000000", null)).status).toBe(404);
  });
});
/** Marketing → Documents: document templates, documents and their history, the letter PDF, emailing to chosen customers, the Homeworks import. */
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { letterBlocks, lettersPdf } from "../src/lib/docPdf";
import { drainCustomerMessages, setMessageGap, setMessageQueueScope } from "../src/lib/customerMessages";
import { setPushTransport } from "../src/lib/notify";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@docs.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const sent: EmailMessage[] = [];
async function call(method: string, url: string, who: string | null, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  let body: any = null;
  try { body = res.json(); } catch { body = res.rawPayload; }
  return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
}

/** The words drawn on each page of a PDF (pdf-lib writes text as hex strings in compressed streams). */
function pdfText(pdf: Uint8Array | Buffer): string {
  const s = Buffer.from(pdf).toString("latin1");
  let out = "";
  // pdf-lib writes "stream\n", the bytes, "\nendstream" (the bytes themselves may end in \r, so don't trim one).
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) out += Buffer.from(t[1], "hex").toString("latin1") + " ";
    out += "\n";
  }
  return out.replace(/ +/g, " ");
}

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  setMessageGap(0);
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Letters Co", firstName: "Lena", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Letters Co", addressLine1: "1 Main St", city: "Norman", state: "OK", zip: "73069", phone: "4055550199", email: "office@docs.test", website: "www.letters.test", timezone: "America/Chicago" });
  await call("POST", "/employees", "owner", { firstName: "Mo", lastName: "Manager", email: email("mgr"), password: "password123", role: "manager" });
  T.mgr = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("mgr"), password: "password123" } })).json().token;
  await call("POST", "/employees", "owner", { firstName: "Tia", lastName: "Tech", email: email("tech"), password: "password123", role: "employee" });
  T.tech = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email("tech"), password: "password123" } })).json().token;
  ID.ann = (await call("POST", "/customers", "owner", { firstName: "Ann", lastName: "Lee", email: email("ann"), property: { street: "9 Elm St", city: "Norman", state: "OK", zip: "73069" } })).body.id;
  ID.bob = (await call("POST", "/customers", "owner", { firstName: "Bob", lastName: "Ray", email: email("bob"), billingStreet: "PO Box 12", billingCity: "Moore", billingState: "OK", billingZip: "73160", property: { street: "4 Oak Ave", city: "Moore", state: "OK", zip: "73160" } })).body.id;
  const cy = await call("POST", "/customers", "owner", { firstName: "Cy", lastName: "Noemail", delivery: ["paper"], billingStreet: "7 Pine Rd", billingCity: "Norman", billingState: "OK", billingZip: "73071", property: { street: "7 Pine Rd", city: "Norman", state: "OK", zip: "73071" } });
  if (cy.status !== 200) throw new Error(JSON.stringify(cy.body));
  ID.cy = cy.body.id;
  // Another company's customer and document, to prove they can't be reached.
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Other Letters", firstName: "Otto", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
  ID.otherCust = (await call("POST", "/customers", "other", { firstName: "Zed", lastName: "Else", email: email("zed") })).body.id;
  ID.otherDoc = (await call("POST", "/docs", "other", { name: "Theirs", content: "<p>Private</p>" })).body.id;
  // Other test files use the same email queue: this one sends only its own companies' emails.
  setMessageQueueScope((await pool.query("select distinct company_id from employees where email = any($1)", [[email("owner"), email("other")]])).rows.map((r) => r.company_id));
});

afterAll(async () => {
  setEmailTransport(null);
  await app.close();
  await pool.end();
});

describe("documents", () => {
  it("managers keep document templates: add, change, list by name, delete", async () => {
    expect((await call("GET", "/docs/templates", "tech")).status).toBe(403);
    expect((await call("POST", "/docs/templates", "mgr", { name: "", content: "<p>Hi</p>" })).body.issues[0].message).toMatch(/enter the name/);
    expect((await call("POST", "/docs/templates", "mgr", { name: "Empty", content: "<p> </p>" })).body.issues[0].message).toMatch(/enter the content/);
    const t = await call("POST", "/docs/templates", "mgr", { name: "Thank You", content: '<p onclick="x()">{{TODAY}}</p><script>alert(1)</script><p>Dear {{CUSTOMER_NAME}}, thank you from {{COMPANY_NAME}}. {{NOT_A_TAG}}</p>' });
    expect(t.status).toBe(200);
    expect(t.body.content).toBe("<p>{{TODAY}}</p><p>Dear {{CUSTOMER_NAME}}, thank you from {{COMPANY_NAME}}. {{NOT_A_TAG}}</p>");
    expect(t.body.unknown).toEqual(["NOT_A_TAG"]);
    ID.tpl = t.body.id;
    await call("POST", "/docs/templates", "mgr", { name: "cancel", content: "<p>Sorry to see you go</p>" });
    expect((await call("GET", "/docs/templates", "mgr")).body.map((x: any) => x.name)).toEqual(["cancel", "Thank You"]);
    const changed = await call("PUT", `/docs/templates/${ID.tpl}`, "mgr", { name: "Thank You!", content: "<p>Dear {{CUSTOMER_NAME}}, thank you.</p>" });
    expect(changed.body).toMatchObject({ name: "Thank You!", unknown: [] });
    expect((await call("GET", `/docs/templates/${ID.tpl}`, "mgr")).body.content).toBe("<p>Dear {{CUSTOMER_NAME}}, thank you.</p>");
    expect((await call("GET", `/docs/templates/${ID.tpl}`, "other")).status).toBe(404);
    const gone = (await call("POST", "/docs/templates", "mgr", { name: "Temp", content: "<p>x</p>" })).body.id;
    expect((await call("DELETE", `/docs/templates/${gone}`, "mgr")).body.ok).toBe(true);
    expect((await call("GET", `/docs/templates/${gone}`, "mgr")).status).toBe(404);
  });

  it("documents are saved with who made and changed them", async () => {
    const d = await call("POST", "/docs", "mgr", { name: "Spring letter", content: "<h2>Spring is here</h2><p>{{TODAY}}</p><p>Dear {{CUSTOMER_NAME}},</p><p>Your balance is <strong>{{CUSTOMER_ACCOUNT_BALANCE}}</strong>. See {{CUSTOMER_PORTAL_LINK}} or <a href=\"https://letters.test/spring\">our spring page</a>.</p><ul><li><p>Aeration</p></li><li><p>Overseeding</p></li></ul><p>Thank you,<br>{{COMPANY_NAME}}</p>" });
    expect(d.status).toBe(200);
    ID.doc = d.body.id;
    expect((await call("GET", "/docs", "mgr")).body).toEqual([{ id: ID.doc, name: "Spring letter" }]);
    await call("PUT", `/docs/${ID.doc}`, "owner", { name: "Spring letter 2027", content: d.body.content });
    const h = (await call("GET", `/docs/${ID.doc}/history`, "mgr")).body;
    expect(h.map((x: any) => [x.action, x.by])).toEqual([["updated", "Lena Owner"], ["created", "Mo Manager"]]);
    expect((await call("GET", `/docs/${ID.otherDoc}`, "mgr")).status).toBe(404);
    expect((await call("PUT", `/docs/${ID.otherDoc}`, "mgr", { name: "x", content: "<p>x</p>" })).status).toBe(404);
    expect((await call("DELETE", `/docs/${ID.otherDoc}`, "mgr")).status).toBe(404);
  });

  it("the header and the customer picker", async () => {
    expect((await call("GET", "/docs/letterhead", "mgr")).body).toEqual({ name: "Letters Co", lines: ["1 Main St", "Norman, OK 73069"], phone: "(405) 555-0199", email: "office@docs.test", website: "www.letters.test", logoUrl: null });
    const all = (await call("GET", "/docs/customers", "mgr")).body;
    expect(all.map((c: any) => c.name)).toEqual(["Ann Lee", "Bob Ray", "Cy Noemail"]);
    expect(all[0]).toMatchObject({ optedOut: false, sample: false });
    expect(all.find((c: any) => c.name === "Cy Noemail").email).toBeNull();
    expect((await call("GET", "/docs/customers?q=ray", "mgr")).body.map((c: any) => c.name)).toEqual(["Bob Ray"]);
    expect((await call("GET", "/docs/customers?q=ann%20lee", "mgr")).body.map((c: any) => c.name)).toEqual(["Ann Lee"]);
    expect((await call("GET", `/docs/customers?q=${encodeURIComponent(email("bob"))}`, "mgr")).body).toHaveLength(1);
    expect((await call("GET", "/docs/customers?q=zed", "mgr")).body).toEqual([]);
  });

  it("prints one letter per customer, filled in and addressed, on the letterhead", async () => {
    expect((await call("POST", `/docs/${ID.doc}/print`, "mgr", { customerIds: [] })).body.issues[0].message).toMatch(/at least one customer/);
    expect((await call("POST", `/docs/${ID.doc}/print`, "mgr", { customerIds: [ID.otherCust] })).body.error).toMatch(/at least one customer/);
    const r = await call("POST", `/docs/${ID.doc}/print`, "mgr", { customerIds: [ID.ann, ID.bob, ID.otherCust] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(String(r.headers["content-disposition"])).toContain("Spring letter 2027.pdf");
    const pdf = await PDFDocument.load(r.raw);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const [ann, bob] = pdfText(r.raw).split("\n").filter((p) => p.trim());
    expect(ann).toContain("Letters Co 1 Main St Norman, OK 73069 (405) 555-0199 office@docs.test www.letters.test");
    expect(ann).toContain("Ann Lee 9 Elm St Norman, OK 73069");
    expect(ann).toContain("Spring is here");
    expect(ann).toMatch(/Dear Ann Lee,/);
    expect(ann).toMatch(/Your balance is \$0\.00 \. See http:\/\/\S+\/portal\S* or our spring page \(https:\/\/letters\.test\/spring\) \./);
    expect(ann).toMatch(/Aeration .*Overseeding/);
    expect(ann).toMatch(/Thank you, Letters Co/);
    expect(ann).not.toContain("{{");
    // A billing address wins over the property.
    expect(bob).toContain("Bob Ray PO Box 12 Moore, OK 73160");
    expect(bob).toMatch(/Dear Bob Ray,/);
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body[0]).toMatchObject({ action: "printed", by: "Mo Manager", detail: { customers: 2 } });
  });

  it("emails the document as the email itself, skipping customers who can't get it", async () => {
    sent.length = 0;
    expect((await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [] })).body.issues[0].message).toMatch(/at least one customer/);
    expect((await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [ID.otherCust] })).body.error).toMatch(/at least one customer/);
    const r = await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [ID.ann, ID.cy, ID.otherCust], emailTemplateId: "", attachPdf: false });
    expect(r.body).toMatchObject({ sending: 1, attachPdf: false, skipped: [{ reason: "no_email", label: "No email address", n: 1 }], skippedNames: [{ name: "Cy Noemail", reason: "No email address" }] });
    ID.msg = r.body.messageId;
    await drainCustomerMessages();
    const mine = sent.filter((m) => m.to.endsWith(`${suffix}@docs.test`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ to: email("ann"), subject: "Spring letter 2027", fromName: "Letters Co" });
    expect(mine[0].html).toContain("Dear Ann Lee,");
    expect(mine[0].html).toContain("Your customer portal</a>");
    expect(mine[0].html).toContain("Unsubscribe");
    expect(mine[0].attachments ?? []).toHaveLength(0);
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body[0]).toMatchObject({ action: "emailed", detail: { messageId: ID.msg, customers: 1, sent: 1, failed: 0, skipped: 1, done: true, stopped: false, emailTemplate: null } });
    // It's in Customers → Sent messages with everyone on it, and on the customer's own page.
    const m = (await call("GET", `/customer-messages/${ID.msg}`, "mgr")).body;
    expect(m).toMatchObject({ subject: "Spring letter 2027", format: "template", status: "sent", audience: "Document: Spring letter 2027", docName: "Spring letter 2027", counts: { sent: 1, skipped: 1 } });
    expect(m.docContent).toBeUndefined();
    expect(m.recipients.map((x: any) => [x.name, x.status]).sort()).toEqual([["Ann Lee", "sent"], ["Cy Noemail", "skipped"]]);
    const timeline = (await call("GET", `/customers/${ID.ann}/timeline`, "mgr")).body;
    expect(JSON.stringify(timeline)).toContain("Spring letter 2027");
  });

  it("emails with the PDF attached, or with an email template and the document as the attachment", async () => {
    sent.length = 0;
    await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [ID.ann, ID.bob], attachPdf: true });
    await drainCustomerMessages();
    let mine = sent.filter((m) => m.to.endsWith(`${suffix}@docs.test`));
    expect(mine.map((m) => m.to).sort()).toEqual([email("ann"), email("bob")]);
    const toBob = mine.find((m) => m.to === email("bob"))!;
    expect(toBob.attachments).toHaveLength(1);
    expect(toBob.attachments![0]).toMatchObject({ filename: "Spring letter 2027.pdf", contentType: "application/pdf" });
    expect(pdfText(toBob.attachments![0].content)).toContain("Bob Ray PO Box 12");
    expect(pdfText(toBob.attachments![0].content)).not.toContain("Ann Lee");

    sent.length = 0;
    const tpl = (await call("POST", "/templates", "mgr", { channel: "email", name: "Cover note", subject: "A letter for {{CUSTOMER_FIRST_NAME}}", body: "<p>Hi {{CUSTOMER_FIRST_NAME}}, your letter is attached.</p>" })).body.id;
    const text = (await call("POST", "/templates", "mgr", { channel: "text", name: "A text", body: "Hi" })).body.id;
    expect((await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [ID.ann], emailTemplateId: text })).body.error).toMatch(/email template/);
    const r = await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [ID.ann], emailTemplateId: tpl, attachPdf: false });
    expect(r.body).toMatchObject({ sending: 1, attachPdf: true });
    await drainCustomerMessages();
    mine = sent.filter((m) => m.to.endsWith(`${suffix}@docs.test`));
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe("A letter for Ann");
    expect(mine[0].html).toContain("your letter is attached");
    expect(mine[0].html).not.toContain("Spring is here");
    expect(pdfText(mine[0].attachments![0].content)).toContain("Spring is here");
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body[0].detail).toMatchObject({ emailTemplate: "Cover note", attachPdf: true, sent: 1, done: true });
  });

  it("customers who unsubscribed are skipped; a failed send is counted", async () => {
    await pool.query("update customers set email_opt_out_at = now() where id = $1", [ID.bob]);
    sent.length = 0;
    setEmailTransport({ send: async (m) => { if (m.to === email("ann")) throw new Error("Mailbox full"); sent.push(m); } });
    const r = await call("POST", `/docs/${ID.doc}/email`, "mgr", { customerIds: [ID.ann, ID.bob] });
    expect(r.body).toMatchObject({ sending: 1, skippedNames: [{ name: "Bob Ray", reason: "Unsubscribed from these emails" }] });
    await drainCustomerMessages();
    expect(sent.filter((m) => m.to.endsWith(`${suffix}@docs.test`))).toHaveLength(0);
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body[0].detail).toMatchObject({ sent: 0, failed: 1, skipped: 1, done: true, error: "Mailbox full" });
    setEmailTransport({ send: async (m) => { sent.push(m); } });
    expect((await call("GET", "/docs/customers?q=ray", "mgr")).body[0].optedOut).toBe(true);
  });

  it("brings in Homeworks' document templates once (admins only)", async () => {
    const file = { source: "homeworks", documentTemplates: [
      { name: "Welcome To The Neighborhood", content: "{{TODAY}} RE: Welcome Dear {{CUSTOMER_NAME}}<br />\nwelcome from {{COMPANY_NAME}}", homeworksId: 2886 },
      { name: "Blank", content: "<br />", homeworksId: 2887 },
    ] };
    expect((await call("POST", "/docs/import", "mgr", file)).status).toBe(403);
    expect((await call("POST", "/docs/import", "owner", { source: "homeworks", templates: [], automations: [] })).body.error).toMatch(/no document templates/);
    expect((await call("POST", "/docs/import", "owner", file)).body).toEqual({ added: 1, updated: 0, kept: 0, skipped: 1 });
    expect((await call("POST", "/docs/import", "owner", file)).body).toEqual({ added: 0, updated: 0, kept: 0, skipped: 2 });
    const list = (await call("GET", "/docs/templates", "mgr")).body;
    const w = list.find((t: any) => t.name === "Welcome To The Neighborhood");
    expect(w.imported).toBe("homeworks");
    expect((await call("GET", `/docs/templates/${w.id}`, "mgr")).body.content).toContain("{{TODAY}} RE: Welcome Dear {{CUSTOMER_NAME}}<br />");
    ID.welcome = w.id;
  });

  it("a tidied file replaces templates nobody has changed here, and leaves the changed ones alone", async () => {
    const tidy = (text: string) => ({ source: "homeworks", documentTemplates: [{ name: "Welcome To The Neighborhood", content: `<p>{{TODAY}}</p><p>Dear {{CUSTOMER_NAME}},</p><p>${text}</p>`, homeworksId: 2886 }] });
    expect((await call("POST", "/docs/import", "owner", tidy("Welcome from {{COMPANY_NAME}}."))).body).toEqual({ added: 0, updated: 1, kept: 0, skipped: 0 });
    expect((await call("GET", `/docs/templates/${ID.welcome}`, "mgr")).body.content).toBe("<p>{{TODAY}}</p><p>Dear {{CUSTOMER_NAME}},</p><p>Welcome from {{COMPANY_NAME}}.</p>");
    // Still not edited here, so a newer file updates it again.
    expect((await call("POST", "/docs/import", "owner", tidy("Welcome to the street from {{COMPANY_NAME}}."))).body.updated).toBe(1);
    // Once someone changes it in Crewdesk, an import never overwrites it.
    await call("PUT", `/docs/templates/${ID.welcome}`, "mgr", { name: "Welcome To The Neighborhood", content: "<p>Our own welcome.</p>" });
    expect((await call("POST", "/docs/import", "owner", tidy("Welcome from {{COMPANY_NAME}}."))).body).toEqual({ added: 0, updated: 0, kept: 1, skipped: 0 });
    expect((await call("GET", `/docs/templates/${ID.welcome}`, "mgr")).body.content).toBe("<p>Our own welcome.</p>");
  });

  it("previews the email and the letter for one customer before anything is sent", async () => {
    sent.length = 0;
    const before = (await call("GET", `/docs/${ID.doc}/history`, "mgr")).body.length;
    const p = (await call("POST", `/docs/${ID.doc}/preview`, "mgr", { customerId: ID.ann })).body;
    expect(p.customer).toEqual({ id: ID.ann, name: "Ann Lee", email: email("ann") });
    expect(p.email.subject).toBe("Spring letter 2027");
    expect(p.email.html).toContain("Dear Ann Lee,");
    expect(p.letter).toMatchObject({ toName: "Ann Lee", toLines: ["9 Elm St", "Norman, OK 73069"] });
    expect(p.letter.html).toContain("Dear Ann Lee,");
    expect(p.letter.html).not.toContain("{{");
    expect(p.attachPdf).toBe(false);
    // With an email template, the preview is the cover note.
    const tpl = (await call("GET", "/templates", "mgr")).body.find((t: any) => t.name === "Cover note").id;
    const withTpl = (await call("POST", `/docs/${ID.doc}/preview`, "mgr", { customerId: ID.ann, emailTemplateId: tpl })).body;
    expect(withTpl.email.subject).toBe("A letter for Ann");
    expect(withTpl.attachPdf).toBe(true);
    expect((await call("POST", `/docs/${ID.doc}/preview`, "mgr", { customerId: ID.otherCust })).status).toBe(404);
    // The letter as a PDF, without it counting as printed.
    const pdf = await call("POST", `/docs/${ID.doc}/print`, "mgr", { customerIds: [ID.ann], preview: true });
    expect(pdfText(pdf.raw)).toContain("Ann Lee 9 Elm St");
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body).toHaveLength(before);
    expect(sent).toHaveLength(0);
  });

  it("from the Customers page: emails a ticked or filtered list, and prints letters for those email can't reach", async () => {
    // Ann can be emailed; Bob unsubscribed and Cy has no email address, so they'd need a letter.
    const everyone = { match: { status: "all", filters: [] } };
    const a = (await call("POST", `/docs/${ID.doc}/audience`, "mgr", everyone)).body;
    expect(a).toMatchObject({ total: 3, sending: 1, byMail: 2, emailReady: true, first: { id: ID.ann, name: "Ann Lee" } });
    expect(a.skipped.map((x: any) => [x.reason, x.n]).sort()).toEqual([["no_email", 1], ["unsubscribed", 1]]);
    expect((await call("POST", `/docs/${ID.doc}/audience`, "tech", everyone)).status).toBe(403);

    sent.length = 0;
    const r = await call("POST", `/docs/${ID.doc}/email`, "mgr", { ...everyone, audience: "All · Tagged VIP" });
    expect(r.body).toMatchObject({ sending: 1, attachPdf: false });
    await drainCustomerMessages();
    expect(sent.filter((m) => m.to.endsWith(`${suffix}@docs.test`)).map((m) => m.to)).toEqual([email("ann")]);
    expect((await call("GET", `/customer-messages/${r.body.messageId}`, "mgr")).body).toMatchObject({ audience: "All · Tagged VIP · Document: Spring letter 2027", counts: { sent: 1, skipped: 2 } });

    // Ticked rows work the same way.
    const ticked = (await call("POST", `/docs/${ID.doc}/audience`, "mgr", { ids: [ID.bob, ID.cy] })).body;
    expect(ticked).toMatchObject({ total: 2, sending: 0, byMail: 2 });

    // Letters for the two an email can't reach, in the list's order (by last name).
    const letters = await call("POST", `/docs/${ID.doc}/print`, "mgr", { ...everyone, only: "notEmailed" });
    expect(letters.status).toBe(200);
    const pages = pdfText(letters.raw).split("\n").filter((p) => p.trim());
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Cy Noemail 7 Pine Rd");
    expect(pages[1]).toContain("Bob Ray PO Box 12");
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body[0]).toMatchObject({ action: "printed", detail: { customers: 2 } });
    // Everyone on the list.
    const all = await PDFDocument.load((await call("POST", `/docs/${ID.doc}/print`, "mgr", everyone)).raw);
    expect(all.getPageCount()).toBe(3);
    expect((await call("POST", `/docs/${ID.doc}/print`, "mgr", { ids: [ID.ann], only: "notEmailed" })).body.error).toMatch(/can be emailed/);
  });

  it("a send that's stopped part-way shows as stopped in the document's history", async () => {
    // The queue sends in batches of ten, so a stop takes hold from the eleventh on.
    const many: string[] = [];
    for (let i = 0; i < 12; i++) many.push((await call("POST", "/customers", "owner", { firstName: "Bulk", lastName: `No${String(i).padStart(2, "0")}`, email: email(`bulk${i}`) })).body.id);
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    const got: string[] = [];
    setEmailTransport({ send: async (m) => { got.push(m.to); await hold; } });
    const r = await call("POST", `/docs/${ID.doc}/email`, "mgr", { ids: many, audience: "12 picked customers" });
    expect(r.body.sending).toBe(12);
    // The first one is on its way: stop the rest.
    while (!got.length) await new Promise((res) => setTimeout(res, 10));
    expect((await call("POST", `/customer-messages/${r.body.messageId}/stop`, "mgr")).body.ok).toBe(true);
    release();
    await drainCustomerMessages();
    expect(got).toHaveLength(10);
    expect((await call("GET", `/docs/${ID.doc}/history`, "mgr")).body[0].detail).toMatchObject({ customers: 12, sent: 10, skipped: 2, done: true, stopped: true });
    setEmailTransport({ send: async (m) => { sent.push(m); } });
  });

  it("deleting a document removes it and its history", async () => {
    const id = (await call("POST", "/docs", "mgr", { name: "Temp", content: "<p>x</p>" })).body.id;
    expect((await call("DELETE", `/docs/${id}`, "mgr")).body.ok).toBe(true);
    expect((await call("GET", `/docs/${id}`, "mgr")).status).toBe(404);
    expect((await pool.query("select count(*)::int n from marketing_doc_history where doc_id = $1", [id])).rows[0].n).toBe(0);
  });
});

describe("letter PDF", () => {
  it("reads the saved HTML as paragraphs, headings, lists, quotes and rules", () => {
    const b = letterBlocks('<h2 style="text-align:center">Title</h2><p>One <strong>bold <em>both</em></strong> <u>under</u> <s>gone</s><br>next &amp; last</p><p></p><ol><li><p>First</p></li><li><p>Second</p><ul><li><p>Inner</p></li></ul></li></ol><blockquote><p>Quoted</p></blockquote><hr><p style="text-align: right">Bye</p>loose words');
    expect(b.map((x) => [x.kind, x.align, x.indent, x.bullet, x.runs.map((r) => r.text).join("")])).toEqual([
      ["h2", "center", 0, null, "Title"],
      ["p", "left", 0, null, "One bold both under gone\nnext & last"],
      ["p", "left", 0, null, ""],
      ["p", "left", 1, "1.", "First"],
      ["p", "left", 1, "2.", "Second"],
      ["p", "left", 2, "•", "Inner"],
      ["p", "left", 1, null, "Quoted"],
      ["hr", "left", 0, null, ""],
      ["p", "right", 0, null, "Bye"],
      ["p", "left", 0, null, "loose words"],
    ]);
    expect(b[1].runs.find((r) => r.text === "both")).toMatchObject({ bold: true, italic: true });
    expect(b[1].runs.find((r) => r.text === "under")).toMatchObject({ underline: true, bold: false });
    expect(b[1].runs.find((r) => r.text === "gone")).toMatchObject({ strike: true });
    expect(b[6].quote).toBe(true);
  });

  it("long letters run onto more pages, numbered; odd characters don't break it", async () => {
    const para = `<p>${"Lawn care is steady work that pays off over a season. ".repeat(14)}</p>`;
    const pdf = await lettersPdf({ name: "Letters Co", addressLine1: "1 Main St", city: "Norman", state: "OK", zip: "73069" }, [
      { toName: "Ann Lee", toLines: ["9 Elm St", "Norman, OK 73069"], html: `${para.repeat(9)}<p>“Curly” – dashes… • bullets, café, 日本語 and 🙂</p><p>${"x".repeat(400)}</p>` },
      { toName: "Bob Ray", toLines: [], html: "<p>Short</p>" },
    ], { title: "Long" });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    const pages = pdfText(pdf).split("\n").filter((p) => p.trim());
    expect(pages[0]).toContain("Page 1 of");
    expect(pages[pages.length - 1]).toContain("Bob Ray");
    expect(pages[pages.length - 1]).not.toContain("Page 1");
  });
});

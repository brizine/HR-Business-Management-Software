/**
 * The invoice layout editor's server side: the draft nothing uses until it's published, publishing
 * and the history, the preview, and invoices printing in the published layout with the details,
 * custom fields and fill-ins it asks for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_INVOICE_LAYOUT, newTextBlock, type InvoiceLayout } from "@crewdesk/shared";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { addInvoicePages } from "../src/lib/invoicePdf";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { companyForPdf, pdfInvoice } from "../src/routes/invoices";
import { recordOps } from "./pdfOps";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@layout.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let companyId = "";
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body, raw: res.rawPayload, type: String(res.headers["content-type"] ?? "") };
}
const state = async (who = "owner") => (await call("GET", "/invoice-layout", who)).body;
/** The words an invoice's PDF would print. */
const printed = async (invoiceId: string) => {
  const data = await pdfInvoice(companyId, invoiceId);
  const company = await companyForPdf(companyId);
  const ops = await recordOps((doc) => addInvoicePages(doc, company, data));
  return ops.filter((o) => / text /.test(o)).map((o) => JSON.parse(o.slice(o.indexOf('"'), o.lastIndexOf('"') + 1)) as string);
};
const titled = (l: InvoiceLayout, title: string): InvoiceLayout => ({ ...l, header: { ...l.header, title } });

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Layout Co", firstName: "Lou", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token; companyId = s.company.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Layout Co", addressLine1: "1 Main St", city: "Norman", state: "OK", zip: "73069", phone: "(405) 555-0100", email: "office@layout.test", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role });
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Elsewhere Co", firstName: "Eli", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  // What the company typed in billing settings before the editor existed.
  const settings = (await call("GET", "/invoices/settings", "owner")).body;
  await call("PUT", "/invoices/settings", "owner", { ...settings, footer: "Thank you for your business!", payableTo: "Layout Co LLC" });
  // A custom field on invoices, one on customers, and a customer with a property and an invoice.
  ID.job = (await call("POST", "/custom-fields", "owner", { appliesTo: "invoice", name: "Job #", type: "text" })).body.id;
  ID.route = (await call("POST", "/custom-fields", "owner", { appliesTo: "customer", name: "Route", type: "text" })).body.id;
  ID.ann = (await call("POST", "/customers", "office", { firstName: "Ann", lastName: "Lee", email: email("ann"), custom: { [ID.route]: "North 4" }, property: { street: "1 Oak St", city: "Norman", zip: "73069", lawnSqFt: 8000 } })).body.id;
  ID.annProp = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0].id;
  ID.inv = (await call("POST", "/invoices", "office", { customerId: ID.ann, propertyId: ID.annProp, notes: "Thanks, Ann.", custom: { [ID.job]: "J-204" }, lines: [{ description: "Fertilizer round", quantity: 1, unitPriceCents: 6500 }] })).body.id;
  ID.otherField = (await call("POST", "/custom-fields", "other", { appliesTo: "invoice", name: "Theirs", type: "text" })).body.id;
});

afterAll(async () => {
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("invoice layout", () => {
  it("starts as Crewdesk's own layout, with the footer and payable-to from billing settings", async () => {
    const s = await state();
    expect(s).toMatchObject({ draft: null, draftAt: null, everPublished: false, publishedAt: null, versions: [] });
    expect(s.published).toEqual({ ...DEFAULT_INVOICE_LAYOUT, footer: { ...DEFAULT_INVOICE_LAYOUT.footer, text: "Thank you for your business!" }, stub: { ...DEFAULT_INVOICE_LAYOUT.stub, payableTo: "Layout Co LLC" } });
    // The fields that can be a detail: the invoice's, the customer's and the property's (Crewdesk's own included).
    expect(s.fields).toEqual(expect.arrayContaining([
      { key: `cf:${ID.job}`, name: "Job #", appliesTo: "invoice" }, { key: `cf:${ID.route}`, name: "Route", appliesTo: "customer" }, expect.objectContaining({ name: "Map Code", appliesTo: "property" }),
    ]));
    expect(await printed(ID.inv)).toEqual(expect.arrayContaining(["INVOICE", "Thank you for your business!", "Layout Co LLC"]));
  });

  it("is for admins in Customers & billing only", async () => {
    const body = { layout: DEFAULT_INVOICE_LAYOUT };
    for (const who of ["office", "tech"]) {
      expect((await call("GET", "/invoice-layout", who)).status).toBe(403);
      expect((await call("PUT", "/invoice-layout/draft", who, body)).status).toBe(403);
      expect((await call("POST", "/invoice-layout/publish", who, body)).status).toBe(403);
      expect((await call("POST", "/invoice-layout/preview", who, body)).status).toBe(403);
    }
  });

  it("a draft is kept for the editor and changes nothing on invoices", async () => {
    const base = (await state()).published as InvoiceLayout;
    const saved = await call("PUT", "/invoice-layout/draft", "owner", { layout: titled(base, "  STATEMENT  ") });
    expect(saved.status).toBe(200);
    expect(saved.body.draft.header.title).toBe("STATEMENT");
    expect(saved.body).toMatchObject({ everPublished: false, draftBy: "Lou Owner" });
    expect(saved.body.draftAt).toBeTruthy();
    expect(saved.body.published.header.title).toBe("INVOICE");
    expect(await printed(ID.inv)).toContain("INVOICE");
    // A draft that matches what's published is no draft; so is one thrown away.
    expect((await call("PUT", "/invoice-layout/draft", "owner", { layout: base })).body.draft).toBeNull();
    await call("PUT", "/invoice-layout/draft", "owner", { layout: titled(base, "BILL") });
    expect((await call("DELETE", "/invoice-layout/draft", "owner")).body.draft).toBeNull();
    // Nonsense is cleaned, not saved as sent.
    const odd = await call("PUT", "/invoice-layout/draft", "owner", { layout: { ...titled(base, "BILL"), page: { accent: "javascript:alert(1)", font: "wingdings", size: "normal" }, junk: true } });
    expect(odd.body.draft.page).toEqual({ accent: "#1a1f29", font: "helvetica", size: "normal" });
    expect(odd.body.draft).not.toHaveProperty("junk");
    await call("DELETE", "/invoice-layout/draft", "owner");
  });

  it("the preview is a PDF of the layout being worked on: a sample invoice, or a real one", async () => {
    const layout = titled((await state()).published, "PREVIEW");
    const sample = await call("POST", "/invoice-layout/preview", "owner", { layout });
    expect(sample.status).toBe(200);
    expect(sample.type).toBe("application/pdf");
    expect(sample.raw.subarray(0, 5).toString()).toBe("%PDF-");
    const real = await call("POST", "/invoice-layout/preview", "owner", { layout, invoiceId: ID.inv });
    expect(real.status).toBe(200);
    expect(real.raw.subarray(0, 5).toString()).toBe("%PDF-");
    // Not another company's invoice; and previewing saves nothing.
    expect((await call("POST", "/invoice-layout/preview", "other", { layout, invoiceId: ID.inv })).status).toBe(404);
    expect((await state()).draft).toBeNull();
    expect((await pdfInvoice(companyId, ID.inv, { layout })).layout?.header.title).toBe("PREVIEW");
  });

  it("publishing puts the layout on every invoice, and keeps what it replaced", async () => {
    const base = (await state()).published as InvoiceLayout;
    await call("PUT", "/invoice-layout/draft", "owner", { layout: titled(base, "DRAFTED") });
    const next: InvoiceLayout = {
      ...titled(base, "STATEMENT"), page: { ...base.page, accent: "#0A7A3B" },
      footer: { ...base.footer, text: "Thanks, {{CUSTOMER_FIRST_NAME}}! Questions? Call {{COMPANY_PHONE}}." },
      header: { ...base.header, title: "STATEMENT", details: [
        ...base.header.details.map((d) => (d.key === "serviceDate" ? { ...d, show: true } : d)),
        { key: `cf:${ID.job}`, label: "Job", show: true }, { key: `cf:${ID.route}`, label: "Route", show: true },
        // Not this company's field: it can't be a detail here.
        { key: `cf:${ID.otherField}`, label: "Theirs", show: true },
      ] },
    };
    const done = await call("POST", "/invoice-layout/publish", "owner", { layout: next });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ everPublished: true, draft: null, publishedBy: "Lou Owner" });
    expect(done.body.published.header.title).toBe("STATEMENT");
    expect(done.body.published.page.accent).toBe("#0a7a3b");
    expect(done.body.published.header.details.map((d: any) => d.label)).toEqual(expect.arrayContaining(["Job", "Route"]));
    expect(done.body.published.header.details.some((d: any) => d.key === `cf:${ID.otherField}`)).toBe(false);
    // The history: what invoices were in until now, then this one (newest first).
    expect(done.body.versions).toHaveLength(2);
    expect(done.body.versions[0].by).toBe("Lou Owner");
    expect(done.body.versions[1].by).toBeNull();

    // The invoice prints in it: the title, both custom fields, and the footer filled in for the customer.
    const words = await printed(ID.inv);
    expect(words).toEqual(expect.arrayContaining(["STATEMENT", "Job", "J-204", "Route", "North 4", "Thanks, Ann! Questions? Call (405) 555-0100."]));
    expect(words).not.toContain("INVOICE");
    // Made by hand, so it has no service date to show.
    expect(words).not.toContain("Service date");
    expect((await call("GET", `/invoices/${ID.inv}/pdf`, "office")).type).toBe("application/pdf");
    // The footer in billing settings no longer matters: the layout has its own.
    const settings = (await call("GET", "/invoices/settings", "owner")).body;
    await call("PUT", "/invoices/settings", "owner", { ...settings, footer: "Old footer" });
    expect((await state()).published.footer.text).toBe("Thanks, {{CUSTOMER_FIRST_NAME}}! Questions? Call {{COMPANY_PHONE}}.");
    expect(await printed(ID.inv)).not.toContain("Old footer");
  });

  it("an invoice made from work orders can show when the work was done", async () => {
    const wo = async (date: string) => {
      const id = (await call("POST", "/visits", "office", { title: "Round", customerId: ID.ann, propertyId: ID.annProp, date, lines: [{ description: "Fertilizer round", quantity: 1, unitPriceCents: 6500 }] })).body.id as string;
      expect((await call("POST", `/visits/${id}/complete`, "office", {})).status).toBe(200);
      return id;
    };
    const earlier = new Date(Date.parse(`${today}T12:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
    const made = await call("POST", "/visits/invoice", "office", { ids: [await wo(earlier), await wo(today)] });
    const us = (d: string) => { const [y, m, day] = d.split("-"); return `${Number(m)}/${Number(day)}/${y}`; };
    expect(await printed(made.body.invoices[0].id)).toEqual(expect.arrayContaining(["Service date", `${us(earlier)} - ${us(today)}`]));
  });

  it("the previous balance is what the customer still owes on earlier sent invoices, worked out when the invoice is printed", async () => {
    const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const make = async (issueDate: string, cents: number, customerId = ID.ann) =>
      (await call("POST", "/invoices", "office", { customerId, issueDate, lines: [{ description: "Round", quantity: 1, unitPriceCents: cents }] })).body.id as string;
    const send = async (id: string) => expect((await call("POST", `/invoices/${id}/send`, "office", { via: ["paper"] })).status).toBe(200);
    // Bea: two earlier invoices sent ($50 and $30), an earlier draft, a void one, this one, and a later one.
    ID.bea = (await call("POST", "/customers", "office", { firstName: "Bea", lastName: "Balance", email: email("bea"), property: { street: "9 Elm St", city: "Norman", zip: "73069" } })).body.id;
    const first = await make(day(-20), 5000, ID.bea), second = await make(day(-10), 3000, ID.bea);
    const draft = await make(day(-9), 7700, ID.bea), voided = await make(day(-8), 9900, ID.bea);
    const mine = await make(day(-2), 6500, ID.bea), later = await make(day(-1), 1200, ID.bea);
    for (const id of [first, second, voided, mine, later]) await send(id);
    expect((await call("POST", `/invoices/${voided}/void`, "office", { reason: "Entered twice" })).status).toBe(200);
    // Off (the layout published so far): no balance is looked up, and none prints.
    expect((await pdfInvoice(companyId, mine)).previousBalanceCents).toBeUndefined();
    expect(await printed(mine)).not.toContain("Previous Balance");

    const base = (await state()).published as InvoiceLayout;
    const on = await call("POST", "/invoice-layout/publish", "owner", { layout: { ...base, totals: { ...base.totals, balance: { ...base.totals.balance, show: true } } } });
    expect(on.body.published.totals.balance).toMatchObject({ show: true, previousLabel: "Previous Balance", todayLabel: "Today's Amount", totalLabel: "Total Amount Due", payTotal: true });
    // $50 + $30 from before. The draft, the void one and the later invoice don't count.
    expect((await pdfInvoice(companyId, mine)).previousBalanceCents).toBe(8000);
    const lines = async (id: string) => { const w = await printed(id); return w.slice(w.indexOf("Previous Balance"), w.indexOf("Total Amount Due") + 2); };
    expect(await lines(mine)).toEqual(["Previous Balance", "$80.00", "Today's Amount", "$65.00", "Total Amount Due", "$145.00"]);
    // The first invoice has nothing before it; the latest has everything.
    expect(await lines(first)).toEqual(["Previous Balance", "$0.00", "Today's Amount", "$50.00", "Total Amount Due", "$50.00"]);
    expect(await lines(later)).toEqual(["Previous Balance", "$145.00", "Today's Amount", "$12.00", "Total Amount Due", "$157.00"]);
    // A payment on an earlier invoice brings the previous balance down the next time this one is printed.
    expect((await call("POST", `/invoices/${first}/payments`, "office", { amountCents: 2000, method: "check", reference: "101" })).status).toBe(200);
    expect(await lines(mine)).toEqual(["Previous Balance", "$60.00", "Today's Amount", "$65.00", "Total Amount Due", "$125.00"]);
    // Another customer's invoices never count, and a draft of this customer's sees what was sent before it.
    expect((await pdfInvoice(companyId, ID.inv)).previousBalanceCents).toBe(0);
    expect((await pdfInvoice(companyId, draft)).previousBalanceCents).toBe(6000);
    // Back to the layout as it was, for the tests that follow.
    await call("POST", "/invoice-layout/publish", "owner", { layout: base });
  });

  it("an earlier layout can be opened again from the history; another company never sees any of it", async () => {
    const s = await state();
    // The oldest entry is what invoices were in before the first publish.
    const oldest = s.versions[s.versions.length - 1].id;
    const original = await call("GET", `/invoice-layout/versions/${oldest}`, "owner");
    expect(original.body.layout.header.title).toBe("INVOICE");
    expect(original.body.layout.footer.text).toBe("Thank you for your business!");
    expect((await call("GET", `/invoice-layout/versions/${oldest}`, "other")).status).toBe(404);
    expect((await call("GET", "/invoice-layout/versions/nope", "owner")).status).toBe(404);
    // Opening it changes nothing until it's published again.
    expect((await state()).published.header.title).toBe("STATEMENT");
    const back = await call("POST", "/invoice-layout/publish", "owner", { layout: { ...original.body.layout, blocks: [{ ...newTextBlock(), id: "aaaa1111", text: "Winter round is booking now." }] } });
    expect(back.body.versions).toHaveLength(s.versions.length + 1);
    expect(await printed(ID.inv)).toEqual(expect.arrayContaining(["INVOICE", "Thank you for your business!", "Winter round is booking now."]));
    // The other company is still on Crewdesk's own, with nothing of this one's.
    const theirs = await state("other");
    expect(theirs).toMatchObject({ everPublished: false, versions: [], draft: null });
    expect(theirs.published.blocks).toEqual([]);
    expect(theirs.fields.some((f: any) => f.name === "Job #")).toBe(false);
  });
});

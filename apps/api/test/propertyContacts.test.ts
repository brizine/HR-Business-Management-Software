/**
 * Contacts on a property who aren't customers (tenants and the like): the Add Contact form's
 * fields, moving out, where they show, and the service notifications the ticked ones get for that
 * property (the pre-visit notice and the notice after a chemical application).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushNotices } from "../src/lib/chemicalNotices";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { receiveText, setTextingProvider } from "../src/lib/texting";
import { flushWeather } from "../src/lib/weather";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@contacts.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";
let companyId = "";
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mail: EmailMessage[] = [];
/** Emails to one of the contacts (sign-up and invite emails go to the same transport). */
const mailTo = (who: string) => mail.filter((m) => m.to === email(who));
const texts: { to: string; body: string }[] = [];
// Each text gets its own id from the provider, even after the list above is emptied between checks.
let textNo = 0;
setTextingProvider({ ready: true, async check() { return { accountName: "test" }; }, async send(_c, to, body) { texts.push({ to, body }); return { id: `t${suffix}_${++textNo}` }; } });

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
const contacts = async () => (await call("GET", `/properties/${ID.rental}`, "office")).body.contacts as any[];
const contact = async (id: string) => (await contacts()).find((c) => c.id === id);
/** A work order's row on the waiting list (ones held for a later day included). */
const waiting = async (id: string) => (await call("GET", "/waitlist?upcoming=1", "office")).body.rows.find((r: any) => r.id === id);

beforeAll(async () => {
  setEmailTransport({ send: async (m) => { mail.push(m); } });
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  app = await buildApp({ logger: false });
  const s = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Rentals Co", firstName: "Rae", lastName: "Owner", email: email("owner"), password: "password123" } })).json();
  T.owner = s.token; companyId = s.company.id;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Rentals Co", addressLine1: "1 Main St", city: "Norman", state: "OK", zip: "73069", email: "office@contacts.test", phone: "(405) 555-0100", timezone: "America/Chicago" });
  await call("PUT", "/weather/settings", "owner", { mode: "off" });
  await call("PUT", "/texting/settings", "owner", { apiKey: "key-123456", fromNumber: "405-555-0188" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  T.other = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Elsewhere Co", firstName: "Eli", lastName: "Other", email: email("other"), password: "password123" } })).json().token;
  today = (await call("GET", "/todos?limit=1", "owner")).body.today;
  // A landlord with a rental: the landlord is the customer (and wants no notices), the tenant is not a customer.
  ID.landlord = (await call("POST", "/customers", "office", { firstName: "Lana", lastName: "Landlord", email: email("lana"), property: { street: "215 Elm St", city: "Norman", zip: "73069", lawnSqFt: 5000 } })).body.id;
  ID.rental = (await call("GET", `/customers/${ID.landlord}`, "office")).body.properties[0].id;
  // A chemical service with one product, so completing a work order makes an application record.
  const methods = (await call("GET", "/chemical-tracking/methods", "owner")).body as { id: string; name: string }[];
  const pre = (await call("POST", "/products", "owner", { name: "Sample Pre-Emergent", productType: "herbicide", epaRegNo: "0000-1", useUnit: "ounces liquid", reiHours: 12,
    customerNote: "Water in within 3 days.", rates: [{ name: "Truck", amountPer1000: 0.5, applicationMethodId: methods.find((x) => x.name === "Truck 2gal/1000ft")!.id }] })).body;
  ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer", pricing: "flat", priceCents: 5000, incomeAccountCode: "4000", chemical: true })).body.id;
  await call("PUT", `/chemical-tracking/services/${ID.fert}`, "owner", { applicationSite: "Turf" });
  await call("PUT", `/chemical-tracking/services/${ID.fert}/products`, "owner", { products: [{ productId: pre.id, productRateId: pre.rates[0].id }] });
});

afterAll(async () => {
  // Disconnect texting again: other test files poll every connected company for replies.
  await call("DELETE", "/texting/settings", "owner");
  setEmailTransport(null); setTextingProvider(null);
  await app.close();
  await flushNotifications();
  await pool.end();
});

describe("property contacts", () => {
  it("Add Contact: a tenant goes on the property, with every box of the form, without being made a customer", async () => {
    const before = (await call("GET", "/customers?status=all", "office")).body.total;
    const r = await call("POST", `/properties/${ID.rental}/contacts`, "office", {
      firstName: " Tina ", lastName: "Tenant", nickname: "T", email: email("TINA").toUpperCase(), homePhone: "405-555-0140", workPhone: "4055550141", cellPhone: "405-555-0142",
      otherPhone: "", fax: "405-555-0149", formOfContact: "", birthday: "1988-03-04", notes: "Works nights, text first", notify: true,
    });
    expect(r.status).toBe(200);
    // "Tenant" unless another type is picked; the name is put together; phones and the email are tidied like a customer's.
    expect(r.body).toMatchObject({
      firstName: "Tina", lastName: "Tenant", nickname: "T", name: "Tina Tenant", relation: "Tenant", email: email("tina"),
      homePhone: "(405) 555-0140", workPhone: "(405) 555-0141", cellPhone: "(405) 555-0142", otherPhone: null, fax: "(405) 555-0149",
      // The number shown first is the cell.
      phone: "(405) 555-0142", formOfContact: null, birthday: "1988-03-04", notes: "Works nights, text first", notify: true, textOptOutAt: null, startDate: null, endDate: null,
    });
    ID.tina = r.body.id;
    // A manager reached at work by phone, a spouse who wants texts, and a neighbor who isn't told anything.
    const pat = await call("POST", `/properties/${ID.rental}/contacts`, "office", { firstName: "Pat", lastName: "Manager", relation: "Property manager", workPhone: "405-555-0170", formOfContact: "call", notify: true, startDate: "2026-03-01" });
    expect(pat.body).toMatchObject({ name: "Pat Manager", relation: "Property manager", phone: "(405) 555-0170", cellPhone: null, email: null, formOfContact: "call", startDate: "2026-03-01" });
    ID.pat = pat.body.id;
    ID.sam = (await call("POST", `/properties/${ID.rental}/contacts`, "office", { firstName: "Sam", lastName: "Spouse", relation: "Spouse", email: email("sam"), cellPhone: "405-555-0143", formOfContact: "text", notify: true })).body.id;
    // A last name alone is enough; no tick, so nothing is ever sent.
    const ned = await call("POST", `/properties/${ID.rental}/contacts`, "office", { lastName: "Neighbor", relation: "Neighbor", email: email("ned") });
    expect(ned.body).toMatchObject({ name: "Neighbor", firstName: null, notify: false });
    ID.ned = ned.body.id;
    // No customer was made.
    expect((await call("GET", "/customers?status=all", "office")).body.total).toBe(before);
    const p = (await call("GET", `/properties/${ID.rental}`, "office")).body;
    expect(p.contacts.map((c: any) => [c.name, c.relation])).toEqual([["Tina Tenant", "Tenant"], ["Pat Manager", "Property manager"], ["Sam Spouse", "Spouse"], ["Neighbor", "Neighbor"]]);
    // The bill-to is still the landlord, and only the landlord.
    expect(p.assignments.map((a: any) => [a.name, a.role])).toEqual([["Lana Landlord", "bill_to"]]);
  });

  it("needs a name, a real email, a way to reach anyone ticked, Customers & billing access, and the right company", async () => {
    const add = (body: unknown, who = "office") => call("POST", `/properties/${ID.rental}/contacts`, who, body);
    /** The first thing wrong with what was sent, as the form shows it. */
    const why = (r: { status: number; body: any }) => (r.status === 400 ? r.body.issues?.[0]?.message : `status ${r.status}`);
    expect(why(await add({ firstName: " ", nickname: "Bud" }))).toBe("Enter the contact's first or last name");
    expect((await add({ firstName: "Bad", email: "nope" })).status).toBe(400);
    expect(why(await add({ firstName: "No", lastName: "Reach", fax: "405-555-0111", notify: true }))).toBe("To get service notifications they need an email address or a phone number");
    expect(why(await add({ firstName: "Texty", homePhone: "405-555-0111", formOfContact: "text" }))).toBe("Form of contact is Text, so enter their cell phone");
    expect(why(await add({ firstName: "Mailer", cellPhone: "405-555-0111", formOfContact: "email" }))).toBe("Form of contact is Email, so enter their email address");
    expect(why(await add({ firstName: "Caller", email: email("caller"), formOfContact: "call" }))).toBe("Form of contact is Phone call, so enter a phone number");
    expect((await add({ firstName: "Odd", formOfContact: "pigeon" })).status).toBe(400);
    expect((await add({ firstName: "Tom" }, "tech")).status).toBe(403);
    expect((await add({ firstName: "Tom" }, "other")).status).toBe(404);
    expect((await call("PUT", `/properties/${ID.rental}/contacts/${ID.tina}`, "other", { firstName: "Tom" })).status).toBe(404);
    expect((await call("DELETE", `/properties/${ID.rental}/contacts/${ID.tina}`, "other")).status).toBe(404);
  });

  it("Contact Type is the company's own drop-down list; renaming a type renames it on the contacts", async () => {
    const menus = (await call("GET", "/employees/menus", "office")).body;
    expect(menus.contactTypes).toEqual(["Tenant", "Property manager", "Owner", "Spouse", "Family member", "Neighbor", "Other"]);
    expect(menus.usage.contactTypes).toEqual({ Tenant: 1, "Property manager": 1, Spouse: 1, Neighbor: 1 });
    const renamed = await call("POST", "/employees/menus/lists/contactTypes/rename", "owner", { from: "Property manager", to: "Site manager" });
    expect(renamed.body.contactTypes).toContain("Site manager");
    expect((await contact(ID.pat)).relation).toBe("Site manager");
    await call("POST", "/employees/menus/lists/contactTypes/rename", "owner", { from: "Site manager", to: "Property manager" });
  });

  it("shows on the property's work orders for the office and the crew, and the search box finds the property by the contact", async () => {
    ID.wo = (await call("POST", "/visits", "office", { title: "Round 1", customerId: ID.landlord, propertyId: ID.rental, scheduling: "waitlist", lines: [{ serviceTypeId: ID.fert, description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }], assigneeIds: [ID.tech] })).body.id;
    const wo = (await call("GET", `/visits/${ID.wo}`, "office")).body;
    expect(wo.property.contacts[0]).toEqual({
      name: "Tina Tenant", nickname: "T", relation: "Tenant", phone: "(405) 555-0142", cellPhone: "(405) 555-0142", homePhone: "(405) 555-0140", workPhone: "(405) 555-0141", otherPhone: null,
      email: email("tina"), formOfContact: null, notes: "Works nights, text first",
    });
    // The crew on it sees who to knock for.
    expect((await call("GET", `/visits/${ID.wo}`, "tech")).body.property.contacts.map((c: any) => c.name)).toEqual(["Tina Tenant", "Pat Manager", "Sam Spouse", "Neighbor"]);

    // Search: by name, by nickname-free email, and by any of the phones, the property comes up.
    const byName = (await call("GET", "/search?q=tina", "office")).body.results;
    expect(byName.find((h: any) => h.kind === "property")).toMatchObject({ id: ID.rental, title: "215 Elm St", sub: "Tenant: Tina Tenant · (405) 555-0142 · Norman", href: `/properties/${ID.rental}` });
    expect(byName.some((h: any) => h.kind === "customer")).toBe(false);
    // Her work number, which isn't the one shown first.
    expect((await call("GET", "/search?q=555-0141", "office")).body.results.find((h: any) => h.kind === "property").sub).toMatch(/^Tenant: Tina Tenant/);
    // A search that finds the property by its street lists it once.
    expect((await call("GET", "/search?q=215%20Elm", "office")).body.results.filter((h: any) => h.kind === "property")).toHaveLength(1);
    // Another company never sees them.
    expect((await call("GET", "/search?q=tina", "other")).body.results.filter((h: any) => h.kind === "property")).toHaveLength(0);
  });

  it("ticked contacts get the pre-visit notice, each by their form of contact, whatever the customer chose", async () => {
    // The waiting list knows three contacts would be told (the landlord asked for nothing).
    expect(await waiting(ID.wo)).toMatchObject({ badges: [], customer: { notifyBefore: "none" }, property: { notifyContacts: 3 } });
    mail.length = 0; texts.length = 0;
    const r = await call("POST", "/waitlist/schedule", "office", { visitIds: [ID.wo], date: plus(today, 3), notify: true });
    // Tina by email (nothing picked, so email first), Sam by text, and Pat is called.
    expect(r.body).toMatchObject({ scheduled: 1, emailed: 1, notEmailed: 0, texted: 1, notTexted: 0, toCall: ["Pat Manager (property manager)"] });
    expect(mailTo("tina")).toHaveLength(1);
    expect(mailTo("tina")[0]).toMatchObject({ fromName: "Rentals Co", replyTo: "office@contacts.test" });
    expect(mailTo("tina")[0].subject).toMatch(/^Rentals Co: your fertilizer is scheduled for \w+day, \w+ \d+$/);
    expect(mailTo("tina")[0].text).toMatch(/Hello Tina,\n\nWe're scheduled for fertilizer at 215 Elm St on \w+day, \w+ \d+\.\n\nThank you,\nRentals Co/);
    expect(mailTo("tina")[0].text).not.toMatch(/unsubscribe/i);
    expect(texts).toEqual([{ to: "+14055550143", body: expect.stringMatching(/^Rentals Co: we're scheduled for fertilizer at 215 Elm St on .+\. Reply STOP to opt out\.$/) }]);
    // The landlord and the unticked neighbor heard nothing.
    expect(mailTo("lana")).toHaveLength(0);
    expect(mailTo("ned")).toHaveLength(0);

    // Not asked to notify: nothing goes out.
    mail.length = 0; texts.length = 0;
    await call("POST", "/dispatch/edit", "office", { visitIds: [ID.wo], to: "board", date: plus(today, 4), routeOrder: "keep", notify: false });
    expect(mail.length + texts.length).toBe(0);

    // Sam replies STOP: no more texts to Sam, and the office is told one wasn't sent.
    await receiveText(companyId, { id: `in_${suffix}_1`, from: "+14055550143", body: "STOP", at: new Date() });
    expect((await contact(ID.sam)).textOptOutAt).toBeTruthy();
    const moved = await call("POST", "/dispatch/edit", "office", { visitIds: [ID.wo], to: "board", date: plus(today, 5), routeOrder: "keep", notify: true });
    expect(moved.body).toMatchObject({ to: "board", emailed: 1, texted: 0, notTexted: 1, toCall: ["Pat Manager (property manager)"] });
    expect(texts).toHaveLength(0);
    // START turns them back on; so does a different cell phone.
    await receiveText(companyId, { id: `in_${suffix}_2`, from: "+14055550143", body: "Start", at: new Date() });
    expect((await contact(ID.sam)).textOptOutAt).toBeNull();
    await receiveText(companyId, { id: `in_${suffix}_3`, from: "+14055550143", body: "stop", at: new Date() });
    const sam = await call("PUT", `/properties/${ID.rental}/contacts/${ID.sam}`, "office", { firstName: "Sam", lastName: "Spouse", relation: "Spouse", email: email("sam"), cellPhone: "405-555-0144", formOfContact: "text", notify: true });
    expect(sam.body).toMatchObject({ cellPhone: "(405) 555-0144", textOptOutAt: null });

    // Sent back for the weather: told that too. Unticking Tina stops hers.
    await call("PUT", `/properties/${ID.rental}/contacts/${ID.tina}`, "office", { firstName: "Tina", lastName: "Tenant", nickname: "T", email: email("tina"), cellPhone: "405-555-0142", notify: false });
    mail.length = 0; texts.length = 0;
    const back = await call("POST", "/dispatch/edit", "office", { visitIds: [ID.wo], to: "waitlist", reason: "rain", notify: true });
    expect(back.body).toMatchObject({ to: "waitlist", emailed: 0, texted: 1 });
    expect(texts[0]).toMatchObject({ to: "+14055550144", body: expect.stringMatching(/because of rain, we couldn't get to your fertilizer/) });
    expect(mailTo("tina")).toHaveLength(0);
    expect((await waiting(ID.wo)).property.notifyContacts).toBe(2);
    await call("PUT", `/properties/${ID.rental}/contacts/${ID.tina}`, "office", { firstName: "Tina", lastName: "Tenant", nickname: "T", email: email("tina"), cellPhone: "405-555-0142", notify: true });
  });

  it("ticked contacts get the notice after a chemical application, even when the customer wants none", async () => {
    const s = (await call("GET", "/chemical-tracking/notice-settings", "owner")).body;
    await call("PUT", "/chemical-tracking/notice-settings", "owner", { ...s, on: true });
    // The landlord doesn't want it; the people living there do.
    await call("PUT", `/properties/${ID.rental}/chemical-notice`, "office", { chemicalNotice: "none" });
    expect((await call("POST", "/waitlist/schedule", "office", { visitIds: [ID.wo], date: today, earlyReason: "The rain cleared" })).body.scheduled).toBe(1);
    mail.length = 0; texts.length = 0;
    await call("POST", `/visits/${ID.wo}/start`, "tech", {});
    expect((await call("POST", `/visits/${ID.wo}/complete`, "tech", {})).status).toBe(200);
    await flushWeather(); await flushNotices();
    const record = (await call("GET", `/chemical-records?visitId=${ID.wo}`, "owner")).body[0];
    expect(record).toBeTruthy();

    // Tina's email is hers by name, with what was applied; Sam's is a text; nothing to the landlord or the neighbor.
    expect(mailTo("tina")).toHaveLength(1);
    expect(mailTo("tina")[0].subject).toMatch(/^Your lawn was treated on /);
    expect(mailTo("tina")[0].text).toContain("Hi Tina,");
    expect(mailTo("tina")[0].text).toContain("Sample Pre-Emergent: Water in within 3 days.");
    expect(mailTo("tina")[0].text).not.toMatch(/\{[a-z_]+\}/);
    expect(texts).toEqual([{ to: "+14055550144", body: expect.stringMatching(/^Rentals Co: we treated your lawn at 215 Elm St/) }]);
    expect(mailTo("lana")).toHaveLength(0);
    expect(mailTo("ned")).toHaveLength(0);

    // The log says who each went to; the one reached by phone is listed for the office to call.
    const log = (await call("GET", `/chemical-tracking/notices?recordId=${record.id}`, "owner")).body;
    expect(log.map((n: any) => [n.recipient, n.channel, n.status, n.to]).sort()).toEqual([
      ["Pat Manager (property manager)", "call", "skipped", "(405) 555-0170"],
      ["Sam Spouse (spouse)", "text", "sent", "(405) 555-0144"],
      ["Tina Tenant (tenant)", "email", "sent", email("tina")],
    ]);
    expect(log.find((n: any) => n.channel === "call").detail).toBe("Pat Manager is reached by phone: call (405) 555-0170");
    expect((await call("GET", "/chemical-tracking/notices?status=problems", "owner")).body.map((n: any) => n.recipient)).toEqual(["Pat Manager (property manager)"]);

    // The office emails the landlord a copy by hand: the contacts aren't sent theirs twice.
    const again = await call("POST", `/chemical-tracking/records/${record.id}/notice`, "owner", { channel: "email" });
    expect(again.body).toMatchObject({ channel: "email", status: "sent", to: email("lana"), recipient: null });
    expect(mailTo("lana")).toHaveLength(1);
    expect(mailTo("lana")[0].text).toContain("Hi Lana,");
    expect(mailTo("tina")).toHaveLength(1);
    expect(texts).toHaveLength(1);
    expect((await call("GET", `/chemical-tracking/notices?recordId=${record.id}`, "owner")).body).toHaveLength(4);
  });

  it("is changed, moves out into the history (and off the notifications), and can be brought back or deleted", async () => {
    const changed = await call("PUT", `/properties/${ID.rental}/contacts/${ID.tina}`, "office", { firstName: "Tina", lastName: "Renter", relation: "Tenant", cellPhone: "(405) 555-0199", email: "", notes: "", notify: true });
    // Boxes left empty are cleared; the name and the first number follow.
    expect(changed.body).toMatchObject({ name: "Tina Renter", nickname: null, phone: "(405) 555-0199", homePhone: null, email: null, notes: null, birthday: null, notify: true });
    expect((await call("POST", `/properties/${ID.rental}/contacts/${ID.pat}/end`, "office", { endDate: "2026-02-01" })).body.error).toBe("They can't move out before they moved in");
    const out = await call("POST", `/properties/${ID.rental}/contacts/${ID.pat}/end`, "office", {});
    expect(out.body.endDate).toBe(today);
    // Current first, then those who've moved out; someone who has moved out is off new work and isn't notified.
    expect((await contacts()).map((c) => [c.name, !!c.endDate])).toEqual([["Tina Renter", false], ["Sam Spouse", false], ["Neighbor", false], ["Pat Manager", true]]);
    const next = (await call("POST", "/visits", "office", { title: "Round 2", customerId: ID.landlord, propertyId: ID.rental, scheduling: "waitlist", lines: [{ serviceTypeId: ID.fert, description: "Fertilizer", quantity: 1, unitPriceCents: 5000 }] })).body.id;
    expect((await call("GET", `/visits/${next}`, "office")).body.property.contacts.map((c: any) => c.name)).toEqual(["Tina Renter", "Sam Spouse", "Neighbor"]);
    expect((await waiting(next)).property.notifyContacts).toBe(2);
    const r = await call("POST", "/waitlist/schedule", "office", { visitIds: [next], date: plus(today, 7), notify: true });
    // Tina has only a cell phone now, so hers is a text too; Pat isn't on the call list any more.
    expect(r.body).toMatchObject({ texted: 2, emailed: 0, toCall: [] });
    // The search box still finds a past contact, marked.
    expect((await call("GET", "/search?q=pat%20manager", "office")).body.results.find((h: any) => h.kind === "property").sub).toMatch(/^Property manager: Pat Manager \(moved out\)/);
    expect((await call("POST", `/properties/${ID.rental}/contacts/${ID.pat}/end`, "office", { back: true })).body.endDate).toBeNull();
    expect((await call("DELETE", `/properties/${ID.rental}/contacts/${ID.pat}`, "office")).body).toEqual({ ok: true });
    expect((await contacts()).map((c) => c.name)).toEqual(["Tina Renter", "Sam Spouse", "Neighbor"]);
  });
});

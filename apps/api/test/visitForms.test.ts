/** Resources → Visit Forms: building forms, putting them on work orders (picked, automatic, series), the crew filling them in, and what a change or a delete does. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { flushNotifications, setPushTransport } from "../src/lib/notify";
import { setEmailTransport, type EmailMessage } from "../src/lib/channels";
import { flushFormEmails } from "../src/lib/visitForms";

let app: FastifyInstance;
const suffix = Date.now();
const email = (n: string) => `${n}-${suffix}@forms.test`;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let today = "";

async function call(method: string, url: string, who: string, payload?: unknown) {
  const res = await app.inject({ method: method as never, url, payload: payload as never, headers: { authorization: `Bearer ${T[who]}` } });
  let body: any = null;
  try { body = res.json(); } catch { body = null; }
  return { status: res.statusCode, body };
}
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const order = (over: Record<string, unknown> = {}) => ({
  title: "Mow and edge", customerId: ID.jane, propertyId: ID.janeProp, date: today,
  lines: [{ description: "Mowing", quantity: 1, unitPriceCents: 4500 }], assigneeIds: [ID.tech], ...over,
});
const checklist = (over: Record<string, unknown> = {}) => ({
  name: "Lawn Care Checklist", autoAttach: false,
  def: {
    signature: true, signatureLabel: "Technician signature",
    sections: [{ id: "s1", name: "Checklist", fields: [
      { id: "tech", type: "text", label: "Technician name", options: [] },
      { id: "notes", type: "textarea", label: "Notes about the lawn", options: [] },
      { id: "done", type: "checkbox", label: "Work done", options: [{ id: "mow", label: "Mowed" }, { id: "edge", label: "Edged" }, { id: "blow", label: "Blown off" }, { id: "blank", label: "  " }] },
      { id: "cond", type: "dropdown", label: "Lawn condition", options: [{ id: "good", label: "Good" }, { id: "fair", label: "Fair" }, { id: "poor", label: "Poor" }] },
      { id: "empty", type: "text", label: "   ", options: [] },
    ] }, { id: "s2", name: "", fields: [] }],
  },
  ...over,
});
const sig = { w: 300, h: 120, d: "M10 60 L40 20 L70 90 L100 30 M120 60 L160 60" };
const sent: EmailMessage[] = [];
/** A 1x1 PNG. */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const boundary = "----vf";
const upload = (who: string, visitId: string, type = "image/png", name = "gate.png") => app.inject({
  method: "POST", url: `/visits/${visitId}/files`,
  payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  headers: { authorization: `Bearer ${T[who]}`, "content-type": `multipart/form-data; boundary=${boundary}` },
});

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
  setEmailTransport({ send: async (m) => { sent.push(m); } });
  app = await buildApp({ logger: false });
  T.owner = (await app.inject({ method: "POST", url: "/auth/signup", payload: { companyName: "Forms Co", firstName: "Fay", lastName: "Owner", email: email("owner"), password: "password123" } })).json().token;
  await call("PUT", "/auth/policy", "owner", { twoFactorRequiredFor: "none" });
  await call("PUT", "/company", "owner", { name: "Forms Co", timezone: "America/Chicago" });
  for (const [who, role] of [["office", "manager"], ["tech", "employee"], ["other", "employee"]] as const) {
    ID[who] = (await call("POST", "/employees", "owner", { firstName: who, lastName: "Person", email: email(who), password: "password123", role })).body.id;
    T[who] = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: email(who), password: "password123" } })).json().token;
  }
  await call("POST", "/crm/sample-customers", "owner");
  ID.jane = (await call("GET", "/customers?q=jane", "office")).body.rows[0].id;
  ID.janeProp = (await call("GET", `/customers/${ID.jane}`, "office")).body.properties[0].id;
  today = (await call("GET", "/visits", "office")).body.today;
  // A real customer (sample customers are never emailed), one with no email, a service and a tag.
  ID.ann = (await call("POST", "/customers", "owner", { firstName: "Ann", lastName: "Lee", email: email("ann"), property: { street: "9 Elm St", city: "Norman", state: "OK", zip: "73069" } })).body.id;
  ID.annProp = (await call("GET", `/customers/${ID.ann}`, "office")).body.properties[0].id;
  ID.cy = (await call("POST", "/customers", "owner", { firstName: "Cy", lastName: "Noemail", delivery: ["paper"], billingStreet: "7 Pine Rd", billingCity: "Norman", billingState: "OK", billingZip: "73071", property: { street: "7 Pine Rd", city: "Norman", state: "OK", zip: "73071" } })).body.id;
  ID.cyProp = (await call("GET", `/customers/${ID.cy}`, "office")).body.properties[0].id;
  ID.fert = (await call("POST", "/service-types", "owner", { name: "Fertilizer application", pricing: "flat", priceCents: 6500, incomeAccountCode: "4000" })).body.id;
  ID.tag = (await call("POST", "/crm/tags", "owner", { name: `Needs attention ${suffix}`, color: "red" })).body.id;
});
afterAll(async () => { setEmailTransport(null); await app.close(); await flushNotifications(); await pool.end(); });

describe("visit forms", () => {
  it("the office builds a form; empty questions and options are dropped; names are unique; no HTML", async () => {
    expect((await call("GET", "/visit-forms", "tech")).status).toBe(403);
    expect((await call("GET", "/visit-forms", "office")).body).toEqual([]);
    const made = await call("POST", "/visit-forms", "office", checklist());
    expect(made.status).toBe(200);
    ID.form = made.body.id;
    expect(made.body.def.sections).toHaveLength(1);
    expect(made.body.def.sections[0].fields.map((f: any) => f.id)).toEqual(["tech", "notes", "done", "cond"]);
    expect(made.body.def.sections[0].fields[2].options.map((o: any) => o.label)).toEqual(["Mowed", "Edged", "Blown off"]);
    expect(made.body.def).toMatchObject({ signature: true, signatureLabel: "Technician signature" });
    // Homeworks' message for a name that's taken (whatever the capitals).
    expect((await call("POST", "/visit-forms", "office", checklist({ name: "lawn care checklist" }))).body.error).toBe("Form name exists, please change");
    expect((await call("POST", "/visit-forms", "office", checklist({ name: "" }))).body.issues[0].message).toBe("Please enter a form name");
    expect((await call("POST", "/visit-forms", "office", checklist({ name: "Empty", def: { sections: [{ id: "a", name: "Nothing here", fields: [] }], signature: false } }))).body.issues[0].message).toBe("Add at least one field to the form");
    expect((await call("POST", "/visit-forms", "office", checklist({ name: "<b>Bold</b>" }))).body.issues[0].message).toBe("HTML is not allowed in Visit Form. Please remove any HTML before submitting.");
    const html = checklist({ name: "Sneaky" }) as any;
    html.def.sections[0].fields[0].label = "Name <script>alert(1)</script>";
    expect((await call("POST", "/visit-forms", "office", html)).body.issues[0].message).toMatch(/HTML is not allowed/);
    // A signature alone is a form.
    const sign = await call("POST", "/visit-forms", "office", { name: "Customer sign-off", def: { sections: [], signature: true }, autoAttach: false });
    expect(sign.status).toBe(200);
    ID.sign = sign.body.id;
    expect(sign.body.def.signatureLabel).toBe("Signature");
    const list = (await call("GET", "/visit-forms", "office")).body;
    expect(list.map((f: any) => [f.name, f.fields, f.linked, f.autoAttach])).toEqual([["Customer sign-off", 1, 0, false], ["Lawn Care Checklist", 5, 0, false]]);
  });

  it("duplicating a form makes \"Copy - …\", which doesn't attach itself", async () => {
    await call("PUT", `/visit-forms/${ID.sign}`, "office", { name: "Customer sign-off", def: { sections: [], signature: true }, autoAttach: true });
    const copy = (await call("POST", `/visit-forms/${ID.sign}/copy`, "office")).body;
    expect(copy.name).toBe("Copy - Customer sign-off");
    expect((await call("POST", `/visit-forms/${ID.sign}/copy`, "office")).body.name).toBe("Copy 2 - Customer sign-off");
    const all = (await call("GET", "/visit-forms", "office")).body;
    expect(all.filter((f: any) => f.autoAttach).map((f: any) => f.name)).toEqual(["Customer sign-off"]);
    for (const f of all.filter((x: any) => x.name.startsWith("Copy"))) expect((await call("DELETE", `/visit-forms/${f.id}`, "office")).body).toEqual({ ok: true, removed: 0 });
  });

  it("a work order gets the forms picked for it; with none said, the automatic ones", async () => {
    // Picked on the work order form.
    const picked = (await call("POST", "/visits", "office", order({ formIds: [ID.form] }))).body;
    ID.wo = picked.id;
    expect(picked.forms.map((f: any) => [f.name, f.submitted])).toEqual([["Lawn Care Checklist", false]]);
    ID.entry = picked.forms[0].id;
    // Said to have none.
    expect((await call("POST", "/visits", "office", order({ formIds: [] }))).body.forms).toEqual([]);
    // Not asked (made somewhere without the form list): the automatic one.
    const auto = (await call("POST", "/visits", "office", order())).body;
    expect(auto.forms.map((f: any) => f.name)).toEqual(["Customer sign-off"]);
    expect((await call("POST", "/visits", "office", order({ formIds: ["4f0c6b6e-1111-4222-8333-444455556666"] }))).body.error).toBe("One of those visit forms doesn't exist");
    // Every work order in a series gets it.
    const series = (await call("POST", "/visits", "office", order({ scheduling: "repeat", repeatEvery: 1, repeatUnit: "week", repeatUntil: plus(today, 21), formIds: [ID.form] }))).body;
    expect(series.created).toBe(4);
    ID.series = series.id;
    const later = (await call("GET", `/visits?from=${plus(today, 1)}&to=${plus(today, 30)}`, "office")).body.items.filter((v: any) => v.seriesId === series.seriesId);
    expect(later).toHaveLength(3);
    for (const v of later) expect(v.forms.map((f: any) => f.name)).toEqual(["Lawn Care Checklist"]);
    ID.seriesLater = later[0].id;
    const list = (await call("GET", "/visit-forms", "office")).body;
    expect(list.find((f: any) => f.id === ID.form)).toMatchObject({ linked: 5, submitted: 0 });
    expect((await call("GET", `/visit-forms/${ID.form}`, "office")).body).toMatchObject({ name: "Lawn Care Checklist", linked: 5, submitted: 0 });
  });

  it("the crew on the work order fills it in; others can't; answers are checked against the form", async () => {
    // The tech sees the form on their work order, blank.
    const mine = (await call("GET", `/visits/${ID.wo}`, "tech")).body;
    expect(mine.forms).toHaveLength(1);
    const blank = (await call("GET", `/visits/${ID.wo}/forms/${ID.entry}`, "tech")).body;
    expect(blank).toMatchObject({ name: "Lawn Care Checklist", submitted: false, answers: {}, signature: null, canFill: true, submittedBy: null });
    expect(blank.def.sections[0].fields).toHaveLength(4);
    // Someone not on it can't see the work order at all; a wrong form id isn't found.
    expect((await call("GET", `/visits/${ID.wo}/forms/${ID.entry}`, "other")).status).toBe(404);
    expect((await call("PUT", `/visits/${ID.wo}/forms/${ID.entry}`, "other", { answers: {} })).status).toBe(404);
    expect((await call("GET", `/visits/${ID.wo}/forms/${ID.sign}`, "tech")).status).toBe(404);
    // Submitted: answers that aren't on the form, or aren't one of a question's choices, are dropped.
    const sent = await call("PUT", `/visits/${ID.wo}/forms/${ID.entry}`, "tech", {
      answers: { tech: "  Tia Tech ", notes: "Lawn looked healthy.", done: ["mow", "edge", "nope"], cond: "fair", stray: "x" }, signature: sig,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ submitted: true, submittedBy: "tech Person", answers: { tech: "Tia Tech", notes: "Lawn looked healthy.", done: ["mow", "edge"], cond: "fair" }, signature: sig });
    expect(sent.body.answers.stray).toBeUndefined();
    expect((await call("PUT", `/visits/${ID.wo}/forms/${ID.entry}`, "tech", { answers: { cond: "excellent" } })).body.answers).toEqual({});
    // A signature has to be strokes and nothing else.
    expect((await call("PUT", `/visits/${ID.wo}/forms/${ID.entry}`, "tech", { answers: {}, signature: { w: 300, h: 120, d: "M0 0 <script>" } })).body.issues[0].message).toMatch(/can't be read/);
    // The office changes it later: who first submitted it stays, and the change is noted.
    const changed = (await call("PUT", `/visits/${ID.wo}/forms/${ID.entry}`, "office", { answers: { tech: "Tia Tech", done: ["mow", "edge", "blow"], cond: "good" }, signature: sig })).body;
    expect(changed).toMatchObject({ submittedBy: "tech Person", updatedBy: "office Person", answers: { done: ["mow", "edge", "blow"], cond: "good" } });
    const wo = (await call("GET", `/visits/${ID.wo}`, "office")).body;
    expect(wo.forms[0]).toMatchObject({ submitted: true, submittedBy: "tech Person" });
    // Nothing has to be filled in (as in Homeworks): an empty form can be submitted.
    const second = (await call("GET", `/visits/${ID.series}`, "tech")).body.forms[0];
    expect((await call("PUT", `/visits/${ID.series}/forms/${second.id}`, "tech", { answers: {} })).body).toMatchObject({ submitted: true, answers: {}, signature: null });
    expect((await call("GET", "/visit-forms", "office")).body.find((f: any) => f.id === ID.form)).toMatchObject({ linked: 5, submitted: 2 });
  });

  it("changing a form changes the copies not yet submitted; submitted ones stay as answered", async () => {
    const next = checklist({ name: "Lawn Checklist" }) as any;
    next.def.sections[0].fields.push({ id: "gate", type: "text", label: "Gate left as found?", options: [] });
    expect((await call("PUT", `/visit-forms/${ID.form}`, "office", next)).status).toBe(200);
    const open = (await call("GET", `/visits/${ID.seriesLater}`, "office")).body.forms[0];
    expect(open.name).toBe("Lawn Checklist");
    expect((await call("GET", `/visits/${ID.seriesLater}/forms/${open.id}`, "office")).body.def.sections[0].fields.map((f: any) => f.id)).toContain("gate");
    const done = (await call("GET", `/visits/${ID.wo}/forms/${ID.entry}`, "office")).body;
    expect(done.name).toBe("Lawn Care Checklist");
    expect(done.def.sections[0].fields.map((f: any) => f.id)).not.toContain("gate");
  });

  it("editing a work order: forms taken off go unless submitted; this and later ones follow", async () => {
    // Take the checklist off the submitted work order and add the sign-off: the submitted one stays.
    const kept = (await call("PUT", `/visits/${ID.wo}`, "office", order({ formIds: [ID.sign] }))).body;
    expect(kept.forms.map((f: any) => [f.name, f.submitted]).sort()).toEqual([["Customer sign-off", false], ["Lawn Care Checklist", true]]);
    // Left out of a change, the forms stay as they are.
    expect((await call("PUT", `/visits/${ID.wo}`, "office", order())).body.forms).toHaveLength(2);
    // Taken off this and the later ones in a series: the unfilled copies go.
    const one = (await call("GET", `/visits/${ID.seriesLater}`, "office")).body;
    await call("PUT", `/visits/${ID.seriesLater}?applyTo=following`, "office", order({ date: one.date, formIds: [] }));
    const later = (await call("GET", `/visits?from=${plus(today, 1)}&to=${plus(today, 30)}`, "office")).body.items.filter((v: any) => v.seriesId === one.seriesId);
    for (const v of later) expect(v.forms).toEqual([]);
    // The first of the series (already submitted, and not in "this and later") still has its form.
    expect((await call("GET", `/visits/${ID.series}`, "office")).body.forms).toHaveLength(1);
  });

  it("a form tied to services goes on work orders that have one of them", async () => {
    const made = await call("POST", "/visit-forms", "office", checklist({ name: "Application record", serviceTypeIds: [ID.fert] }));
    expect(made.status).toBe(200);
    ID.byService = made.body.id;
    expect(made.body.serviceTypeIds).toEqual([ID.fert]);
    expect((await call("POST", "/visit-forms", "office", checklist({ name: "Wrong service", serviceTypeIds: ["4f0c6b6e-1111-4222-8333-444455556666"] }))).body.error).toBe("One of those services isn't on the price list");
    const names = (v: any) => v.forms.map((f: any) => f.name).sort();
    // With the service on it (and nothing said about forms): it gets the form, with the every-work-order one.
    const fert = (await call("POST", "/visits", "office", order({ lines: [{ serviceTypeId: ID.fert, description: "Fertilizer application", quantity: 1, unitPriceCents: 6500 }] }))).body;
    expect(names(fert)).toEqual(["Application record", "Customer sign-off"]);
    // Without the service: only the every-work-order one. Saying which forms always wins.
    expect(names((await call("POST", "/visits", "office", order())).body)).toEqual(["Customer sign-off"]);
    expect(names((await call("POST", "/visits", "office", order({ formIds: [], lines: [{ serviceTypeId: ID.fert, description: "Fertilizer application", quantity: 1, unitPriceCents: 6500 }] }))).body)).toEqual([]);
    expect((await call("GET", "/visit-forms", "office")).body.find((f: any) => f.id === ID.byService)).toMatchObject({ serviceTypeIds: [ID.fert], mustSubmit: false, emailCopy: false, flags: false });
    expect((await call("GET", `/visit-forms/${ID.byService}`, "office")).body.serviceTypeIds).toEqual([ID.fert]);
  });

  it("required answers, new kinds of question, and a form that must be in before Completed", async () => {
    const def = {
      signature: true, signatureLabel: "Technician signature", signatureRequired: true, mustSubmit: true,
      sections: [{ id: "s", name: "Service check", fields: [
        { id: "gate", type: "yesno", label: "Gate latched?", options: [], required: true },
        { id: "gal", type: "number", label: "Gallons used", options: [], required: true },
        { id: "back", type: "date", label: "Come back on", options: [] },
        { id: "pic", type: "photo", label: "Photo of the gate", options: [] },
        { id: "cust", type: "signature", label: "Customer signature", options: [], required: true },
      ] }],
    };
    const form = (await call("POST", "/visit-forms", "office", { name: "Service check", def, autoAttach: false })).body;
    expect(form.def).toMatchObject({ mustSubmit: true, signatureRequired: true });
    expect(form.def.sections[0].fields[0].options.map((o: any) => o.label)).toEqual(["Yes", "No"]);
    const wo = (await call("POST", "/visits", "office", order({ formIds: [form.id] }))).body;
    const entry = wo.forms[0].id;
    // It can't be completed until the form is in.
    expect((await call("POST", `/visits/${wo.id}/complete`, "tech", {})).body.error).toBe("Submit the form before marking it Completed: Service check");
    // Required answers are named when they're missing.
    expect((await call("PUT", `/visits/${wo.id}/forms/${entry}`, "tech", { answers: { gate: "yes" } })).body.error).toBe("Still needed: Gallons used, Customer signature, Technician signature");
    // A photo question takes the work order's own photos; anything else is dropped. A number must be a number.
    const photo = (await upload("tech", wo.id)).json();
    const other = (await call("POST", "/visits", "office", order())).body;
    const elsewhere = (await upload("office", other.id)).json();
    const ok = await call("PUT", `/visits/${wo.id}/forms/${entry}`, "tech", {
      answers: { gate: "no", gal: "2.5", back: "2026-12-15", pic: [photo.id, elsewhere.id] }, signature: sig, signatures: { cust: sig, gate: sig },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ submitted: true, answers: { gate: "no", gal: "2.5", back: "2026-12-15", pic: [photo.id] }, signatures: { cust: sig }, locked: false });
    expect((await call("PUT", `/visits/${wo.id}/forms/${entry}`, "tech", { answers: { gate: "no", gal: "a lot" }, signature: sig, signatures: { cust: sig } })).body.error).toBe("Still needed: Gallons used");
    // The PDF carries the answers.
    const pdf = await app.inject({ method: "GET", url: `/visits/${wo.id}/forms/${entry}/pdf`, headers: { authorization: `Bearer ${T.tech}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(String(pdf.headers["content-disposition"])).toMatch(/Service-check-WO-\d+\.pdf/);
    // Now it can be completed.
    expect((await call("POST", `/visits/${wo.id}/complete`, "tech", {})).body.status).toBe("completed");
    ID.checkWo = wo.id; ID.checkEntry = entry;
  });

  it("flagged answers add a tag and make an office to-do, once; changes are kept in the form's history", async () => {
    const def = {
      signature: false,
      sections: [{ id: "s", name: "", fields: [
        { id: "cond", type: "dropdown", label: "Lawn condition", options: [{ id: "good", label: "Good" }, { id: "poor", label: "Poor", tagId: ID.tag, todo: true }] },
        { id: "note", type: "text", label: "Note", options: [] },
      ] }],
    };
    expect((await call("POST", "/visit-forms", "office", { name: "Bad tag", def: { ...def, sections: [{ ...def.sections[0], fields: [{ ...def.sections[0].fields[0], options: [{ id: "x", label: "X", tagId: "4f0c6b6e-1111-4222-8333-444455556666" }] }] }] } })).body.error).toBe("One of those tags doesn't exist");
    const form = (await call("POST", "/visit-forms", "office", { name: "Condition check", def })).body;
    expect((await call("GET", "/visit-forms", "office")).body.find((f: any) => f.id === form.id).flags).toBe(true);
    const wo = (await call("POST", "/visits", "office", order({ customerId: ID.ann, propertyId: ID.annProp, formIds: [form.id] }))).body;
    const entry = wo.forms[0].id;
    const first = (await call("PUT", `/visits/${wo.id}/forms/${entry}`, "tech", { answers: { cond: "good", note: "Fine" } })).body;
    expect(first.flagged).toEqual([]);
    expect((await call("GET", `/customers/${ID.ann}`, "office")).body.tagIds).not.toContain(ID.tag);
    // Changed to the flagged answer: the tag goes on the customer and the work order, and the office gets a to-do.
    const second = (await call("PUT", `/visits/${wo.id}/forms/${entry}`, "tech", { answers: { cond: "poor", note: "Fine" } })).body;
    expect(second.flagged).toEqual([expect.stringContaining("Tag \"Needs attention"), "To-do made: Condition check: Lawn condition: Poor"]);
    expect((await call("GET", `/customers/${ID.ann}`, "office")).body.tagIds).toContain(ID.tag);
    expect((await call("GET", `/visits/${wo.id}`, "office")).body.tagIds).toContain(ID.tag);
    const todos = (await call("GET", `/todos?customerId=${ID.ann}`, "office")).body.items;
    expect(todos.map((t: any) => t.title)).toEqual(["Condition check: Lawn condition: Poor"]);
    expect(todos[0].notes).toMatch(/From the visit form "Condition check" on WO-\d+ Mow and edge for Ann Lee, filled in by tech Person\./);
    expect(todos[0].assignees.map((a: any) => a.id)).toEqual([ID.office]);
    expect((await call("GET", `/crm/tags/history?customerId=${ID.ann}`, "office")).body[0]).toMatchObject({ tagId: ID.tag, action: "add", source: "form" });
    // Saved again with the same answer: nothing more happens.
    expect((await call("PUT", `/visits/${wo.id}/forms/${entry}`, "office", { answers: { cond: "poor", note: "Called her" } })).body.flagged).toEqual([]);
    expect((await call("GET", `/todos?customerId=${ID.ann}`, "office")).body.items).toHaveLength(1);
    // The history: submitted, then each change with what changed.
    const h = (await call("GET", `/visits/${wo.id}/forms/${entry}`, "office")).body.history;
    expect(h.map((x: any) => [x.action, x.by, x.changes])).toEqual([
      ["submitted", "tech Person", []],
      ["updated", "tech Person", [{ label: "Lawn condition", from: "Good", to: "Poor" }]],
      ["updated", "office Person", [{ label: "Note", from: "Fine", to: "Called her" }]],
    ]);
    ID.annWo = wo.id; ID.annEntry = entry;
  });

  it("the customer gets a copy by email only when the form says so, once the work order is completed", async () => {
    // (The crew's own notifications go through the same test mailbox; these are the customers' emails.)
    const mail = () => sent.filter((m) => !/@forms\.test$/.test(String(m.to)) || [email("ann")].includes(String(m.to)));
    sent.length = 0;
    // Not set to email: completing sends nothing.
    await call("POST", `/visits/${ID.annWo}/complete`, "tech", {});
    await flushFormEmails();
    expect(mail()).toHaveLength(0);
    // The office can still send it by hand.
    expect((await call("POST", `/visits/${ID.annWo}/forms/${ID.annEntry}/email`, "tech")).status).toBe(403);
    expect((await call("POST", `/visits/${ID.annWo}/forms/${ID.annEntry}/email`, "office")).body).toEqual({ sent: true, to: email("ann") });
    expect(mail()).toHaveLength(1);
    expect(mail()[0]).toMatchObject({ to: email("ann"), subject: "Condition check from Forms Co" });
    expect(mail()[0].html).toContain("copy of the Condition check from our visit to 9 Elm St");
    expect(mail()[0].attachments?.[0]).toMatchObject({ contentType: "application/pdf" });
    expect(mail()[0].attachments![0].filename).toMatch(/^Condition-check-WO-\d+\.pdf$/);
    expect(mail()[0].attachments![0].content.subarray(0, 5).toString()).toBe("%PDF-");
    const after = (await call("GET", `/visits/${ID.annWo}/forms/${ID.annEntry}`, "office")).body;
    expect(after.emailedTo).toBe(email("ann"));
    expect(after.history.at(-1)).toMatchObject({ action: "emailed", by: "office Person", detail: `Emailed to ${email("ann")}` });
    // Set to email a copy: it goes when the work order is completed, once.
    sent.length = 0;
    const def = { signature: false, emailCopy: true, sections: [{ id: "s", name: "", fields: [{ id: "n", type: "text", label: "What we did", options: [] }] }] };
    const form = (await call("POST", "/visit-forms", "office", { name: "Service summary", def })).body;
    expect(form.def.emailCopy).toBe(true);
    const wo = (await call("POST", "/visits", "office", order({ customerId: ID.ann, propertyId: ID.annProp, formIds: [form.id] }))).body;
    await call("PUT", `/visits/${wo.id}/forms/${wo.forms[0].id}`, "tech", { answers: { n: "Mowed and edged" } });
    await flushFormEmails();
    expect(mail()).toHaveLength(0);
    await call("POST", `/visits/${wo.id}/complete`, "tech", {});
    await flushFormEmails();
    expect(mail().map((m) => [m.to, m.subject])).toEqual([[email("ann"), "Service summary from Forms Co"]]);
    await call("PUT", `/visits/${wo.id}/forms/${wo.forms[0].id}`, "tech", { answers: { n: "Mowed, edged and blew off" } });
    await flushFormEmails();
    expect(mail()).toHaveLength(1);
    // Submitted after the work order was completed: it goes then.
    const late = (await call("POST", "/visits", "office", order({ customerId: ID.ann, propertyId: ID.annProp, formIds: [form.id] }))).body;
    await call("POST", `/visits/${late.id}/complete`, "tech", {});
    await flushFormEmails();
    expect(mail()).toHaveLength(1);
    await call("PUT", `/visits/${late.id}/forms/${late.forms[0].id}`, "tech", { answers: { n: "Done" } });
    await flushFormEmails();
    expect(mail()).toHaveLength(2);
    // No email address, or a sample customer: nothing is sent, and sending by hand says why.
    const cy = (await call("POST", "/visits", "office", order({ customerId: ID.cy, propertyId: ID.cyProp, formIds: [form.id] }))).body;
    await call("PUT", `/visits/${cy.id}/forms/${cy.forms[0].id}`, "tech", { answers: { n: "Done" } });
    await call("POST", `/visits/${cy.id}/complete`, "tech", {});
    await flushFormEmails();
    expect(mail()).toHaveLength(2);
    expect((await call("POST", `/visits/${cy.id}/forms/${cy.forms[0].id}/email`, "office")).body.error).toBe("Cy Noemail has no email address");
    expect((await call("POST", `/visits/${ID.checkWo}/forms/${ID.checkEntry}/email`, "office")).body.error).toBe("Sample customers aren't emailed");
    // The template is one of Crewdesk's own, so its wording can be changed under Templates.
    expect((await call("GET", "/templates", "office")).body.find((t: any) => t.systemKey === "visitform_email")).toMatchObject({ name: "Visit form copy (Crewdesk)", system: true });
  });

  it("once the work order is invoiced its forms are locked", async () => {
    expect((await call("POST", `/visits/${ID.annWo}/invoice`, "office")).status).toBe(200);
    const locked = (await call("GET", `/visits/${ID.annWo}/forms/${ID.annEntry}`, "office")).body;
    expect(locked).toMatchObject({ locked: true, canFill: false });
    expect((await call("PUT", `/visits/${ID.annWo}/forms/${ID.annEntry}`, "office", { answers: { cond: "good" } })).body.error).toBe("This work order is on an invoice, so its forms are locked. Void the invoice to change them.");
  });

  it("the submitted forms report: filters, a customer's forms, and the export", async () => {
    const all = (await call("GET", "/visit-forms/submitted", "office")).body;
    expect(all.total).toBeGreaterThanOrEqual(6);
    expect(all.rows[0]).toHaveProperty("summary");
    expect((await call("GET", "/visit-forms/submitted", "tech")).status).toBe(403);
    const ann = (await call("GET", `/visit-forms/submitted?customerId=${ID.ann}`, "office")).body;
    expect(ann.rows.every((r: any) => r.customer.name === "Ann Lee")).toBe(true);
    expect(ann.rows.map((r: any) => r.name).sort()).toEqual(["Condition check", "Service summary", "Service summary"]);
    const cond = (await call("GET", `/visit-forms/submitted?name=${encodeURIComponent("Condition check")}`, "office")).body;
    expect(cond.total).toBe(1);
    expect(cond.rows[0]).toMatchObject({ submittedBy: "tech Person", summary: "Lawn condition: Poor · Note: Called her", flags: 1, address: "9 Elm St, Norman" });
    expect(cond.rows[0].workOrder.title).toBe("Mow and edge");
    expect((await call("GET", `/visit-forms/submitted?q=${encodeURIComponent("blew off")}`, "office")).body.total).toBe(1);
    expect((await call("GET", `/visit-forms/submitted?byId=${ID.office}`, "office")).body.total).toBe(0);
    expect((await call("GET", `/visit-forms/submitted?from=${plus(today, 2)}`, "office")).body.total).toBe(0);
    expect((await call("GET", `/visit-forms/submitted?to=${plus(today, 1)}&limit=2`, "office")).body.rows).toHaveLength(2);
    const filters = (await call("GET", "/visit-forms/submitted/filters", "office")).body;
    expect(filters.names).toEqual(expect.arrayContaining(["Condition check", "Service check", "Service summary"]));
    expect(filters.people).toEqual([{ id: ID.tech, name: "tech Person" }]);
    const csv = await app.inject({ method: "GET", url: `/visit-forms/submitted/export?customerId=${ID.ann}`, headers: { authorization: `Bearer ${T.office}` } });
    expect(csv.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const lines = csv.payload.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Submitted,Form,Work order,Work order title,Work order date,Customer,Property,Submitted by,Emailed to customer,What we did,Lawn condition,Note");
    expect(lines).toHaveLength(4);
    // Times are the office's own (the company's time zone), not UTC stamps.
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},/);
    expect(lines.find((l) => l.includes("Condition check"))).toMatch(/,Ann Lee,"9 Elm St, Norman",tech Person,[^,]+,,Poor,Called her$/);
  });

  it("deleting a form takes it off work orders where it isn't submitted; submitted copies stay readable", async () => {
    const fresh = (await call("POST", "/visits", "office", order({ formIds: [ID.form] }))).body;
    expect(fresh.forms).toHaveLength(1);
    expect((await call("DELETE", `/visit-forms/${ID.form}`, "tech")).status).toBe(403);
    expect((await call("DELETE", `/visit-forms/${ID.form}`, "office")).body).toEqual({ ok: true, removed: 1 });
    expect((await call("GET", `/visits/${fresh.id}`, "office")).body.forms).toEqual([]);
    const still = (await call("GET", `/visits/${ID.wo}/forms/${ID.entry}`, "tech")).body;
    expect(still).toMatchObject({ name: "Lawn Care Checklist", submitted: true, formId: null, answers: { cond: "good" } });
    expect((await call("GET", `/visit-forms/${ID.form}`, "office")).status).toBe(404);
    // Deleting the work order takes its forms with it.
    expect((await call("DELETE", `/visits/${ID.wo}?scope=one`, "office")).status).toBe(200);
    expect((await call("GET", `/visits/${ID.wo}/forms/${ID.entry}`, "office")).status).toBe(404);
  });
});

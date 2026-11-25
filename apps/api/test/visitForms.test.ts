/** Marketing → Visit Forms: building forms, putting them on work orders (picked, automatic, series), the crew filling them in, and what a change or a delete does. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { pool } from "../src/db";
import { setPushTransport } from "../src/lib/notify";

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

beforeAll(async () => {
  setPushTransport({ send: async (m) => m.map(() => ({ status: "ok" as const, id: "x" })) });
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
});
afterAll(async () => { await app.close(); await pool.end(); });

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

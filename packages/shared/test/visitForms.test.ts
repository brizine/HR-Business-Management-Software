import { describe, expect, it } from "vitest";
import {
  FORM_HTML_MESSAGE, cleanFormAnswers, cleanFormDef, cleanFormSignatures, containsHtml, emptyFormDef, flaggedAnswers, formAnswerRows, formAnswerText, formAnswersSchema, formChanges, formCopyName, formFieldCount,
  formHasFlags, formTagIds, missingRequired,
  isSigned, newFormField, signaturePath, signatureSchema, signatureStrokes, visitFormSchema, visitSchema, type FormDef,
} from "../src";

const def: FormDef = {
  signature: true, signatureLabel: "Signature",
  sections: [{ id: "s1", name: "Checklist", fields: [
    { id: "tech", type: "text", label: "Technician name", options: [] },
    { id: "done", type: "checkbox", label: "Work done", options: [{ id: "mow", label: "Mowed" }, { id: "edge", label: "Edged" }] },
    { id: "cond", type: "dropdown", label: "Lawn condition", options: [{ id: "good", label: "Good" }, { id: "poor", label: "Poor" }] },
  ] }],
};

describe("visit forms", () => {
  it("a new form starts with one empty section; new checkbox and dropdown questions start with one option", () => {
    const d = emptyFormDef();
    expect(d.sections).toHaveLength(1);
    expect(d).toMatchObject({ signature: false, signatureLabel: "Signature" });
    expect(newFormField("text").options).toEqual([]);
    expect(newFormField("checkbox").options).toHaveLength(1);
    expect(newFormField("dropdown").options).toHaveLength(1);
  });

  it("what's kept: no empty questions, options or sections; text questions carry no options", () => {
    const clean = cleanFormDef({
      signature: false, signatureLabel: "  ",
      sections: [
        { id: "a", name: " Front ", fields: [{ id: "q1", type: "text", label: " Gate? ", options: [{ id: "x", label: "stray" }] }, { id: "q2", type: "textarea", label: "", options: [] }, { id: "q3", type: "dropdown", label: "Pick", options: [{ id: "o1", label: " A " }, { id: "o2", label: "" }] }] },
        { id: "b", name: "", fields: [] },
      ],
    });
    expect(clean.sections).toEqual([{ id: "a", name: "Front", fields: [{ id: "q1", type: "text", label: "Gate?", options: [] }, { id: "q3", type: "dropdown", label: "Pick", options: [{ id: "o1", label: "A" }] }] }]);
    expect(clean.signatureLabel).toBe("Signature");
    expect(formFieldCount(def)).toBe(4);
  });

  it("the form's rules: a name, something on it, and no HTML anywhere", () => {
    expect(visitFormSchema.safeParse({ name: "Lawn Care Checklist", def }).success).toBe(true);
    const bad = (v: unknown) => { const r = visitFormSchema.safeParse(v); return r.success ? null : r.error.issues[0].message; };
    expect(bad({ name: " ", def })).toBe("Please enter a form name");
    expect(bad({ name: "Empty", def: { sections: [], signature: false } })).toBe("Add at least one field to the form");
    expect(bad({ name: "Only a signature", def: { sections: [], signature: true } })).toBeNull();
    expect(bad({ name: "<i>x</i>", def })).toBe(FORM_HTML_MESSAGE);
    expect(bad({ name: "Opt", def: { ...def, sections: [{ ...def.sections[0], fields: [{ ...def.sections[0].fields[1], options: [{ id: "o", label: "<b>Mowed</b>" }] }] }] } })).toBe(FORM_HTML_MESSAGE);
    expect(bad({ name: "Twice", def: { ...def, sections: [...def.sections, { id: "s1", name: "Again", fields: [{ id: "z", type: "text", label: "Z", options: [] }] }] } })).toMatch(/share an id/);
    expect(containsHtml("Fertilizer & weed control, 3 < 5")).toBe(false);
    expect(containsHtml("a <br> b")).toBe(true);
    expect(containsHtml("&nbsp;")).toBe(true);
  });

  it("answers are checked against the form they're for", () => {
    expect(cleanFormAnswers(def, { tech: "  Pat ", done: ["mow", "gone", "mow"], cond: "poor", other: "x" })).toEqual({ tech: "Pat", done: ["mow"], cond: "poor" });
    expect(cleanFormAnswers(def, { tech: "   ", done: [], cond: "great" })).toEqual({});
    expect(cleanFormAnswers(def, { done: "mow", cond: ["good"] } as never)).toEqual({});
    expect(formAnswerText(def.sections[0].fields[1], ["edge", "mow"])).toBe("Edged, Mowed");
    expect(formAnswerText(def.sections[0].fields[2], "good")).toBe("Good");
    expect(formAnswerText(def.sections[0].fields[0], undefined)).toBe("");
    const rows = formAnswerRows(def, { tech: "Pat", done: ["edge"] });
    expect(rows[0].section).toBe("Checklist");
    expect(rows[0].rows.map((r) => [r.label, r.value])).toEqual([["Technician name", "Pat"], ["Work done", "Edged"], ["Lawn condition", ""]]);
    expect(rows[0].rows[1].options).toEqual([{ label: "Mowed", ticked: false }, { label: "Edged", ticked: true }]);
    expect(formAnswersSchema.safeParse({ answers: { tech: "Pat", done: ["mow"] }, signature: null }).success).toBe(true);
    expect(formAnswersSchema.safeParse({ answers: { "bad key!": "x" } }).success).toBe(false);
  });

  it("a signature is kept as its strokes, and nothing else gets through", () => {
    const d = signaturePath([[{ x: 10, y: 20.04 }, { x: 30.26, y: 40 }], [], [{ x: 5, y: 5 }]]);
    expect(d).toBe("M10 20 L30.3 40 M5 5 L5.6 5.6");
    expect(signatureStrokes(d)).toEqual([[{ x: 10, y: 20 }, { x: 30.3, y: 40 }], [{ x: 5, y: 5 }, { x: 5.6, y: 5.6 }]]);
    expect(signatureSchema.safeParse({ w: 300, h: 120, d }).success).toBe(true);
    expect(signatureSchema.safeParse({ w: 300, h: 120, d: "" }).success).toBe(true);
    for (const bad of ["M0 0 Z", "M0 0 L1 1 <svg onload=x>", "C1 2 3 4 5 6", "M1e5 2"]) expect(signatureSchema.safeParse({ w: 300, h: 120, d: bad }).success, bad).toBe(false);
    expect(isSigned({ w: 300, h: 120, d })).toBe(true);
    expect(isSigned({ w: 300, h: 120, d: " " })).toBe(false);
    expect(isSigned(null)).toBe(false);
  });

  it("copies are named like other copies, without clashing", () => {
    expect(formCopyName("Lawn Checklist", ["Lawn Checklist"])).toBe("Copy - Lawn Checklist");
    expect(formCopyName("Lawn Checklist", ["Lawn Checklist", "copy - lawn checklist", "Copy 2 - Lawn Checklist"])).toBe("Copy 3 - Lawn Checklist");
  });

  it("more kinds of question: yes/no, number, date, photo and signature, each checked", () => {
    const yn = newFormField("yesno");
    expect(yn.options.map((o) => [o.id, o.label])).toEqual([["yes", "Yes"], ["no", "No"]]);
    const d2: FormDef = {
      signature: false, signatureLabel: "Signature",
      sections: [{ id: "s", name: "Check", fields: [
        { id: "gate", type: "yesno", label: "Gate latched?", options: [{ id: "no", label: "Nope", tagId: "4f0c6b6e-1111-4222-8333-444455556666" }, { id: "extra", label: "Maybe" }] },
        { id: "gal", type: "number", label: "Gallons used", options: [{ id: "x", label: "stray" }] },
        { id: "day", type: "date", label: "Come back on", options: [] },
        { id: "pic", type: "photo", label: "Photo of the gate", options: [] },
        { id: "cust", type: "signature", label: "Customer signature", options: [] },
        { id: "yn2", type: "yesno", label: "", options: [] },
      ] }],
    };
    const clean = cleanFormDef(d2);
    // A yes/no question always has exactly Yes and No (keeping its flags); one with no question is dropped.
    expect(clean.sections[0].fields.map((f) => f.id)).toEqual(["gate", "gal", "day", "pic", "cust"]);
    expect(clean.sections[0].fields[0].options).toEqual([{ id: "yes", label: "Yes" }, { id: "no", label: "No", tagId: "4f0c6b6e-1111-4222-8333-444455556666" }]);
    expect(clean.sections[0].fields[1].options).toEqual([]);
    // Two yes/no questions share their choices' ids, and that's fine.
    expect(visitFormSchema.safeParse({ name: "Two yes-no", def: { ...d2, sections: [{ ...d2.sections[0], fields: [d2.sections[0].fields[0], { ...d2.sections[0].fields[0], id: "gate2" }] }] } }).success).toBe(true);
    const photos = new Set(["p1", "p2"]);
    expect(cleanFormAnswers(clean, { gate: "no", gal: " 1,250.5 ", day: "2026-12-01", pic: ["p1", "nope", "p1"], cust: "x" }, photos)).toEqual({ gate: "no", gal: "1250.5", day: "2026-12-01", pic: ["p1"] });
    expect(cleanFormAnswers(clean, { gate: "maybe", gal: "about two", day: "12/01/2026", pic: [] }, photos)).toEqual({});
    expect(formAnswerText(clean.sections[0].fields[0], "no")).toBe("No");
    expect(formAnswerText(clean.sections[0].fields[2], "2026-12-01")).toBe("Dec 1, 2026");
    expect(formAnswerText(clean.sections[0].fields[3], ["p1", "p2"])).toBe("2 photos");
    const signed = { w: 300, h: 100, d: "M1 1 L5 5" };
    expect(cleanFormSignatures(clean, { cust: signed, gate: signed, other: signed })).toEqual({ cust: signed });
    expect(cleanFormSignatures(clean, { cust: { w: 300, h: 100, d: "" } })).toEqual({});
    const rows = formAnswerRows(clean, { pic: ["p1"] }, { cust: signed })[0].rows;
    expect(rows.find((r) => r.id === "pic")).toMatchObject({ photos: ["p1"], value: "1 photo" });
    expect(rows.find((r) => r.id === "cust")).toMatchObject({ signature: signed, value: "Signed" });
  });

  it("required questions: says which are still missing", () => {
    const req: FormDef = {
      signature: true, signatureLabel: "Tech signature", signatureRequired: true,
      sections: [{ id: "s", name: "", fields: [
        { id: "a", type: "text", label: "Technician", options: [], required: true },
        { id: "b", type: "checkbox", label: "Work done", options: [{ id: "m", label: "Mowed" }], required: true },
        { id: "c", type: "yesno", label: "Gate latched?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], required: true },
        { id: "d", type: "signature", label: "Customer signature", options: [], required: true },
        { id: "e", type: "textarea", label: "Notes", options: [] },
      ] }],
    };
    expect(missingRequired(req, {}, null, {})).toEqual(["Technician", "Work done", "Gate latched?", "Customer signature", "Tech signature"]);
    const sig = { w: 300, h: 100, d: "M1 1 L2 2" };
    expect(missingRequired(req, { a: "Pat", b: ["m"], c: "no" }, sig, { d: sig })).toEqual([]);
    expect(missingRequired(req, { a: "  ", b: [], c: "no" }, sig, { d: sig })).toEqual(["Technician", "Work done"]);
    // The settings a form carries survive cleaning; a required signature needs the signature box.
    expect(cleanFormDef({ ...req, mustSubmit: true, emailCopy: true })).toMatchObject({ signatureRequired: true, mustSubmit: true, emailCopy: true });
    expect(cleanFormDef({ ...req, signature: false }).signatureRequired).toBeUndefined();
    expect(cleanFormDef(req).sections[0].fields.map((f) => !!f.required)).toEqual([true, true, true, true, false]);
  });

  it("flags and history: which answers call for a tag or a to-do, and what changed", () => {
    const tag = "4f0c6b6e-1111-4222-8333-444455556666";
    const fl: FormDef = {
      signature: true, signatureLabel: "Signature",
      sections: [{ id: "s", name: "", fields: [
        { id: "cond", type: "dropdown", label: "Lawn condition", options: [{ id: "good", label: "Good" }, { id: "poor", label: "Poor", tagId: tag, todo: true }] },
        { id: "seen", type: "checkbox", label: "Seen", options: [{ id: "grub", label: "Grubs", todo: true }, { id: "weed", label: "Weeds" }] },
        { id: "gate", type: "yesno", label: "Gate latched?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No", tagId: tag }] },
        { id: "note", type: "text", label: "Note", options: [] },
      ] }],
    };
    expect(formHasFlags(fl)).toBe(true);
    expect(formHasFlags(def)).toBe(false);
    expect(formTagIds(fl)).toEqual([tag]);
    expect(flaggedAnswers(fl, { cond: "good", seen: ["weed"], gate: "yes" })).toEqual([]);
    expect(flaggedAnswers(fl, { cond: "poor", seen: ["grub", "weed"], gate: "no" })).toEqual([
      { optionId: "cond:poor", question: "Lawn condition", answer: "Poor", tagId: tag, todo: true },
      { optionId: "seen:grub", question: "Seen", answer: "Grubs", tagId: null, todo: true },
      { optionId: "gate:no", question: "Gate latched?", answer: "No", tagId: tag, todo: false },
    ]);
    const sig = { w: 300, h: 100, d: "M1 1 L2 2" };
    expect(formChanges(fl, { answers: { cond: "good", note: "ok" }, signature: null }, { answers: { cond: "poor", note: "ok", seen: ["grub"] }, signature: sig })).toEqual([
      { label: "Lawn condition", from: "Good", to: "Poor" }, { label: "Seen", from: "", to: "Grubs" }, { label: "Signature", from: "", to: "Signed" },
    ]);
    expect(formChanges(fl, { answers: { cond: "poor" }, signature: sig }, { answers: { cond: "poor" }, signature: sig })).toEqual([]);
    expect(formChanges(fl, { answers: {}, signature: sig }, { answers: {}, signature: { ...sig, d: "M3 3 L4 4" } })).toEqual([{ label: "Signature", from: "Signed", to: "Signed again" }]);
    // A form can be tied to price-list services.
    expect(visitFormSchema.parse({ name: "By service", def: fl, serviceTypeIds: [tag] }).serviceTypeIds).toEqual([tag]);
    expect(visitFormSchema.parse({ name: "By service", def: fl }).serviceTypeIds).toEqual([]);
  });

  it("a work order can say which forms it gets, or leave it unsaid", () => {
    const base = { title: "Mow", customerId: "4f0c6b6e-1111-4222-8333-444455556666", propertyId: "4f0c6b6e-1111-4222-8333-444455556667", date: "2026-06-01" };
    expect(visitSchema.parse(base).formIds).toBeUndefined();
    expect(visitSchema.parse({ ...base, formIds: [] }).formIds).toEqual([]);
    expect(visitSchema.safeParse({ ...base, formIds: ["nope"] }).success).toBe(false);
  });
});

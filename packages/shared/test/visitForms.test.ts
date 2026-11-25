import { describe, expect, it } from "vitest";
import {
  FORM_HTML_MESSAGE, cleanFormAnswers, cleanFormDef, containsHtml, emptyFormDef, formAnswerRows, formAnswerText, formAnswersSchema, formCopyName, formFieldCount,
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

  it("a work order can say which forms it gets, or leave it unsaid", () => {
    const base = { title: "Mow", customerId: "4f0c6b6e-1111-4222-8333-444455556666", propertyId: "4f0c6b6e-1111-4222-8333-444455556667", date: "2026-06-01" };
    expect(visitSchema.parse(base).formIds).toBeUndefined();
    expect(visitSchema.parse({ ...base, formIds: [] }).formIds).toEqual([]);
    expect(visitSchema.safeParse({ ...base, formIds: ["nope"] }).success).toBe(false);
  });
});

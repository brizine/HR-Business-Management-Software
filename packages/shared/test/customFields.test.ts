import { describe, expect, it } from "vitest";
import {
  cleanCustomValues, coerceCustomValue, customDefault, customFieldSchema, customFieldUpdateSchema, formatCustomValue, startingCustomValues,
  type CustomFieldDef,
} from "../src";

const f = (over: Partial<CustomFieldDef>): CustomFieldDef => ({ id: "f1", appliesTo: "property", name: "Field", type: "text", options: [], defaultValue: null, transferable: false, ...over });
const errors = (input: unknown) => { const r = customFieldSchema.safeParse(input); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };

describe("custom field definitions (Homeworks' Add New Field)", () => {
  it("needs what it applies to, a name and a type; a dropdown needs its choices", () => {
    expect(errors({ appliesTo: "property", name: "Front Yard Sq Ft", type: "integer" })).toEqual([]);
    expect(errors({ name: "x", type: "text" })).toEqual(["appliesTo: Pick what the field applies to"]);
    expect(errors({ appliesTo: "property", name: " ", type: "text" })).toEqual(["name: Name the field"]);
    expect(errors({ appliesTo: "workorder", name: "Grass type", type: "select" })).toEqual(["options: Add the choices for the dropdown"]);
    expect(errors({ appliesTo: "workorder", name: "Grass type", type: "select", options: ["Bermuda", "bermuda"] })).toEqual(["options: Each choice only once"]);
  });

  it("checks the default value against the type", () => {
    expect(errors({ appliesTo: "property", name: "Total Sq Ft", type: "integer", defaultValue: "12.5" })).toEqual(["defaultValue: Default value: enter a whole number"]);
    expect(errors({ appliesTo: "property", name: "Gate", type: "select", options: ["Locked", "Open"], defaultValue: "Open" })).toEqual([]);
    expect(customFieldSchema.parse({ appliesTo: "property", name: "x", type: "text", defaultValue: "" }).defaultValue).toBeNull();
    expect(customFieldUpdateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(customDefault(f({ type: "integer", defaultValue: "1,200" }))).toBe(1200);
    expect(customDefault(f({ type: "checkbox", defaultValue: null }))).toBeNull();
    expect(customDefault(f({ type: "checkbox", defaultValue: "yes" }))).toBe(true);
  });
});

describe("custom field values", () => {
  it("cleans each type", () => {
    expect(coerceCustomValue({ type: "integer", options: [] }, "4,200")).toEqual({ value: 4200 });
    expect(coerceCustomValue({ type: "integer", options: [] }, "4.5")).toEqual({ error: "Enter a whole number" });
    expect(coerceCustomValue({ type: "decimal", options: [] }, "2.125")).toEqual({ value: 2.125 });
    expect(coerceCustomValue({ type: "decimal", options: [] }, "abc")).toEqual({ error: "Enter a number" });
    expect(coerceCustomValue({ type: "checkbox", options: [] }, "on")).toEqual({ value: true });
    expect(coerceCustomValue({ type: "checkbox", options: [] }, "")).toEqual({ value: false });
    expect(coerceCustomValue({ type: "date", options: [] }, "2026-02-30")).toEqual({ error: "Pick a date" });
    expect(coerceCustomValue({ type: "date", options: [] }, "2026-11-23")).toEqual({ value: "2026-11-23" });
    expect(coerceCustomValue({ type: "select", options: ["Bermuda", "Fescue"] }, "fescue")).toEqual({ value: "Fescue" });
    expect(coerceCustomValue({ type: "select", options: ["Bermuda", "Fescue"] }, "Zoysia")).toEqual({ error: "Pick one of: Bermuda, Fescue" });
    expect(coerceCustomValue({ type: "text", options: [] }, "  ")).toEqual({ value: null });
  });

  it("keeps only the company's fields, keeps what wasn't sent, and lists problems by field name", () => {
    const fields = [f({ id: "a", name: "Front Yard Sq Ft", type: "integer" }), f({ id: "b", name: "Notes", type: "text" }), f({ id: "c", name: "Dog", type: "checkbox" })];
    expect(cleanCustomValues(fields, { a: "1,500", stranger: "x", c: true }, { b: "Side gate" })).toEqual({ values: { a: 1500, b: "Side gate", c: true }, errors: [] });
    expect(cleanCustomValues(fields, { a: "", b: "x" }, { a: 900 }).values).toEqual({ b: "x" });
    expect(cleanCustomValues(fields, { a: "lots" }).errors).toEqual(["Front Yard Sq Ft: Enter a whole number"]);
  });

  it("starts a new record with what was entered, then transferable values by name, then defaults", () => {
    const property = [{ id: "p1", name: "Front Yard Sq Ft" }, { id: "p2", name: "Dog" }];
    const customer = [{ id: "c1", name: "front yard sq ft" }];
    const job = [
      f({ id: "j1", name: "Front Yard Sq Ft", type: "integer", transferable: true }),
      f({ id: "j2", name: "Dog", type: "checkbox", transferable: true }),
      f({ id: "j3", name: "Crew size", type: "integer", defaultValue: "2" }),
      f({ id: "j4", name: "Gallons used", type: "decimal" }),
      f({ id: "j5", name: "Dog", type: "text", transferable: false, defaultValue: "ask" }),
    ];
    const sources = [{ fields: property, values: { p1: 4200, p2: true } }, { fields: customer, values: { c1: 999 } }];
    expect(startingCustomValues(job, {}, sources)).toEqual({ j1: 4200, j2: true, j3: 2, j5: "ask" });
    // Entered values win, including an unticked box.
    expect(startingCustomValues(job, { j1: 10, j2: false }, sources)).toEqual({ j1: 10, j2: false, j3: 2, j5: "ask" });
    // The property has no value: the next source (the customer) is used.
    expect(startingCustomValues(job, {}, [{ fields: property, values: {} }, { fields: customer, values: { c1: 999 } }]).j1).toBe(999);
    // Not transferable: no copy.
    expect(startingCustomValues([f({ id: "x", name: "Front Yard Sq Ft", type: "integer" })], {}, sources)).toEqual({});
  });

  it("formats values for reading", () => {
    expect(formatCustomValue({ type: "integer" }, 4200)).toBe("4,200");
    expect(formatCustomValue({ type: "checkbox" }, false)).toBe("No");
    expect(formatCustomValue({ type: "date" }, "2026-11-23")).toBe("Nov 23, 2026");
    expect(formatCustomValue({ type: "text" }, undefined)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { estimateLineSchema, invoiceLineSchema, lawnAreaNote, lineAreaValues, lineSqFt, packageToLines, priceFor, rewordForArea, serviceTypeSchema, visitLineSchema, withAreaNote, type PricedService } from "../src";

// A lawn of 4,200 front + 6,800 back; a customer wants flea & tick only where the dog is.
const lawn = { lawnSqFt: 11000, frontSqFt: 4200, backSqFt: 6800 };
const fleaTick: PricedService & { id: string; defaultLawnArea?: string } = { id: "s1", pricing: "per_thousand", priceCents: 600, minimumCents: 3000, brackets: [] };

describe("which part of the lawn a line is for", () => {
  it("takes its square feet from the whole lawn, the front, the back or a typed size", () => {
    expect(lineSqFt({}, lawn)).toBe(11000);
    expect(lineSqFt({ lawnArea: "whole" }, lawn)).toBe(11000);
    expect(lineSqFt({ lawnArea: "front" }, lawn)).toBe(4200);
    expect(lineSqFt({ lawnArea: "back" }, lawn)).toBe(6800);
    expect(lineSqFt({ lawnArea: "custom", lawnAreaSqFt: 3000 }, lawn)).toBe(3000);
    // Not known: a property with only a total has no front or back; a typed size with nothing typed; no property.
    expect(lineSqFt({ lawnArea: "back" }, { lawnSqFt: 9000 })).toBeNull();
    expect(lineSqFt({ lawnArea: "custom" }, lawn)).toBeNull();
    expect(lineSqFt({ lawnArea: "front" }, null)).toBeNull();
    // A typed size needs no property at all.
    expect(lineSqFt({ lawnArea: "custom", lawnAreaSqFt: 2500 }, null)).toBe(2500);
  });

  it("prices the line from that size", () => {
    expect(priceFor(fleaTick, lineSqFt({ lawnArea: "whole" }, lawn))).toBe(6600);
    expect(priceFor(fleaTick, lineSqFt({ lawnArea: "back" }, lawn))).toBe(4080);
    // The front alone is under the minimum.
    expect(priceFor(fleaTick, lineSqFt({ lawnArea: "front" }, lawn))).toBe(3000);
    // Unknown size: no price, to be typed in.
    expect(priceFor(fleaTick, lineSqFt({ lawnArea: "back" }, { lawnSqFt: 9000 }))).toBeNull();
  });

  it("says so in the line's wording, for the crew and the customer", () => {
    expect(lawnAreaNote({ lawnArea: "whole" })).toBe("");
    expect(lawnAreaNote(null)).toBe("");
    expect(withAreaNote("Flea & tick", { lawnArea: "whole" })).toBe("Flea & tick");
    expect(withAreaNote("Flea & tick", { lawnArea: "back" })).toBe("Flea & tick (back lawn only)");
    expect(withAreaNote("Flea & tick", { lawnArea: "front" })).toBe("Flea & tick (front lawn only)");
    expect(withAreaNote("Flea & tick", { lawnArea: "custom", lawnAreaSqFt: 3000 })).toBe("Flea & tick (3,000 sq ft only)");
    expect(withAreaNote("Flea & tick", { lawnArea: "custom" })).toBe("Flea & tick");
  });

  it("rewords an untouched line when its area changes, and leaves a reworded one alone", () => {
    const back = { lawnArea: "back" }, whole = { lawnArea: "whole" }, typed = { lawnArea: "custom", lawnAreaSqFt: 3000 };
    expect(rewordForArea("Flea & tick", "Flea & tick", whole, back)).toBe("Flea & tick (back lawn only)");
    expect(rewordForArea("Flea & tick (back lawn only)", "Flea & tick", back, typed)).toBe("Flea & tick (3,000 sq ft only)");
    expect(rewordForArea("Flea & tick (back lawn only)", "Flea & tick", back, whole)).toBe("Flea & tick");
    expect(rewordForArea("Dog run and kennel side", "Flea & tick", whole, back)).toBe("Dog run and kennel side");
    // Either of the service's wordings counts: its name, or its invoice description.
    expect(rewordForArea("Flea and tick treatment", ["Flea & tick", "Flea and tick treatment"], whole, back)).toBe("Flea and tick treatment (back lawn only)");
    expect(rewordForArea("", ["Flea & tick", null], whole, back)).toBe("Flea & tick (back lawn only)");
  });

  it("is carried by work order, estimate and invoice lines, and starts as the whole lawn", () => {
    const line = { description: "Flea & tick", quantity: 1, unitPriceCents: 4080 };
    expect(visitLineSchema.parse(line)).toMatchObject({ lawnArea: "whole" });
    expect(visitLineSchema.parse({ ...line, lawnArea: "back" })).toMatchObject({ lawnArea: "back" });
    expect(estimateLineSchema.parse({ ...line, lawnArea: "custom", lawnAreaSqFt: "3000" })).toMatchObject({ lawnArea: "custom", lawnAreaSqFt: 3000 });
    expect(invoiceLineSchema.parse({ ...line, lawnArea: "front", lawnAreaSqFt: "" })).toMatchObject({ lawnArea: "front", lawnAreaSqFt: null });
    expect(visitLineSchema.safeParse({ ...line, lawnArea: "side" }).success).toBe(false);
    // Saved: the typed size only with "custom".
    expect(lineAreaValues({ lawnArea: "back", lawnAreaSqFt: 3000 })).toEqual({ lawnArea: "back", lawnAreaSqFt: null });
    expect(lineAreaValues({ lawnArea: "custom", lawnAreaSqFt: 3000 })).toEqual({ lawnArea: "custom", lawnAreaSqFt: 3000 });
    expect(lineAreaValues({})).toEqual({ lawnArea: "whole", lawnAreaSqFt: null });
  });

  it("a service can start its lines on the front or the back (never a typed size)", () => {
    const base = { name: "Flea & tick, back yard", pricing: "per_thousand", priceCents: 600 };
    expect(serviceTypeSchema.parse({ ...base, defaultLawnArea: "back" }).defaultLawnArea).toBe("back");
    expect(serviceTypeSchema.safeParse({ ...base, defaultLawnArea: "custom" }).success).toBe(false);
    // A save that doesn't mention it leaves what's saved alone.
    expect("defaultLawnArea" in serviceTypeSchema.parse(base)).toBe(false);
  });

  it("a package prices each line from the part of the lawn its service covers", () => {
    const services = [{ ...fleaTick, defaultLawnArea: "back" }, { ...fleaTick, id: "s2" }];
    const pkg = [{ serviceTypeId: "s1", description: "Flea & tick", quantity: 1 }, { serviceTypeId: "s2", description: "Whole lawn spray", quantity: 1 }];
    expect(packageToLines(pkg, services, lawn).map((l) => [l.lawnArea, l.unitPriceCents])).toEqual([["back", 4080], ["whole", 6600]]);
    // A bare number is the whole lawn's size, as before.
    expect(packageToLines(pkg, services, 11000).map((l) => [l.lawnArea, l.unitPriceCents])).toEqual([["whole", 6600], ["whole", 6600]]);
    expect(packageToLines(pkg, services, null).map((l) => l.unitPriceCents)).toEqual([null, null]);
  });
});

describe("a property's sizes are custom fields, and a service is priced from one of them", () => {
  const F = (id: string, name: string, builtin: any = null, type: any = "decimal") => ({ id, appliesTo: "property" as const, name, type, options: [], defaultValue: null, transferable: false, builtin });
  const SIDE = "11111111-2222-4333-8444-555555555555";
  const fields = [F("m", "Map Code", "mapCode", "text"), F("f", "Front Lawn ft", "frontSqFt"), F("b", "Back Lawn ft", "backSqFt"), F("o", "Other ft", "otherSqFt"), F("t", "Total ft", "lawnSqFt"), F("g", "Gate Code", "gateCode", "text"), F(SIDE, "Side Yard ft"), F("x", "Dog's name", null, "text")];
  const property = { lawnSqFt: 12500, frontSqFt: 4200, backSqFt: 6800, otherSqFt: 1500, custom: { [SIDE]: 900, x: "Rex" } };

  it("offers every number field, the total first, by the names the company gave them", async () => {
    const { sizeChoices, areaKeyOf, areaNames } = await import("../src");
    expect(sizeChoices(fields)).toEqual([
      { key: "whole", name: "Total ft" }, { key: "front", name: "Front Lawn ft" }, { key: "back", name: "Back Lawn ft" }, { key: "other", name: "Other ft" }, { key: `cf:${SIDE}`, name: "Side Yard ft" },
    ]);
    // Text fields (Map Code, Gate Code, the dog's name) aren't sizes.
    expect(areaKeyOf(fields[0])).toBeNull();
    expect(areaKeyOf(fields[7])).toBeNull();
    expect(areaNames(fields)[`cf:${SIDE}`]).toBe("Side Yard ft");
  });

  it("prices a line from the other area or from a field the company added", () => {
    expect(lineSqFt({ lawnArea: "other" }, property)).toBe(1500);
    expect(lineSqFt({ lawnArea: `cf:${SIDE}` }, property)).toBe(900);
    expect(priceFor(fleaTick, lineSqFt({ lawnArea: `cf:${SIDE}` }, property))).toBe(3000);
    // Nothing in the field at this property: no size, so no price until one is typed.
    expect(lineSqFt({ lawnArea: `cf:${SIDE}` }, { lawnSqFt: 9000, custom: {} })).toBeNull();
    expect(lineSqFt({ lawnArea: `cf:${SIDE}` }, { lawnSqFt: 9000 })).toBeNull();
    // A number typed with a comma still counts; a text value doesn't.
    expect(lineSqFt({ lawnArea: `cf:${SIDE}` }, { custom: { [SIDE]: "1,250" } })).toBe(1250);
    expect(lineSqFt({ lawnArea: "cf:not-a-field" }, property)).toBe(12500);
  });

  it("names the area in the line's wording, without the unit", async () => {
    const { areaNames } = await import("../src");
    const names = areaNames(fields);
    expect(withAreaNote("Flea & tick", { lawnArea: "other" })).toBe("Flea & tick (other area only)");
    expect(withAreaNote("Flea & tick", { lawnArea: `cf:${SIDE}` }, names)).toBe("Flea & tick (side yard only)");
    // Without the names (or once the field is deleted) the line just keeps its wording.
    expect(withAreaNote("Flea & tick", { lawnArea: `cf:${SIDE}` })).toBe("Flea & tick");
    expect(rewordForArea("Flea & tick (side yard only)", "Flea & tick", { lawnArea: `cf:${SIDE}` }, { lawnArea: "back" }, names)).toBe("Flea & tick (back lawn only)");
  });

  it("is what lines and services store", () => {
    const line = { description: "Flea & tick", quantity: 1, unitPriceCents: 3000 };
    expect(visitLineSchema.parse({ ...line, lawnArea: `cf:${SIDE}` }).lawnArea).toBe(`cf:${SIDE}`);
    expect(visitLineSchema.parse({ ...line, lawnArea: "other" }).lawnArea).toBe("other");
    expect(visitLineSchema.safeParse({ ...line, lawnArea: "cf:123" }).success).toBe(false);
    const svc = { name: "Side yard spray", pricing: "per_thousand", priceCents: 600 };
    expect(serviceTypeSchema.parse({ ...svc, defaultLawnArea: `cf:${SIDE}` }).defaultLawnArea).toBe(`cf:${SIDE}`);
    expect(serviceTypeSchema.parse({ ...svc, defaultLawnArea: "other" }).defaultLawnArea).toBe("other");
    expect(serviceTypeSchema.safeParse({ ...svc, defaultLawnArea: "custom" }).success).toBe(false);
    expect(lineAreaValues({ lawnArea: `cf:${SIDE}`, lawnAreaSqFt: 5 })).toEqual({ lawnArea: `cf:${SIDE}`, lawnAreaSqFt: null });
    expect(lineAreaValues({ lawnArea: "sideways" })).toEqual({ lawnArea: "whole", lawnAreaSqFt: null });
  });

  it("reads Crewdesk's own fields from the property and writes them back to it", async () => {
    const { propertyFieldValues, splitPropertyValues, lawnTotal, PROPERTY_BUILTIN_FIELDS } = await import("../src");
    expect(PROPERTY_BUILTIN_FIELDS.map((b) => b.name)).toEqual(["Map Code", "Front Lawn ft", "Back Lawn ft", "Other ft", "Total ft", "Gate Code", "Pets", "Access Notes", "Notes"]);
    const p = { ...property, mapCode: "801", gateCode: "2468", pets: null };
    const values = propertyFieldValues(fields, p);
    expect(values).toEqual({ m: "801", f: 4200, b: 6800, o: 1500, t: 12500, g: "2468", [SIDE]: 900, x: "Rex" });
    // Saving: only what was sent changes; blank clears; the company's own fields stay custom values.
    const sent = { g: "", b: "7000", [SIDE]: "950" };
    const cleaned = { ...values, b: 7000, [SIDE]: 950 } as Record<string, string | number | boolean>;
    delete cleaned.g;
    expect(splitPropertyValues(fields, sent, cleaned)).toEqual({ columns: { gateCode: null, backSqFt: 7000 }, custom: { [SIDE]: 950, x: "Rex" } });
    // The total: as typed (so it can be overridden), else front + back + other.
    expect(lawnTotal({ frontSqFt: 4200, backSqFt: 6800, otherSqFt: 1500 })).toBe(12500);
    expect(lawnTotal({ frontSqFt: 4200, backSqFt: 6800, otherSqFt: 1500, lawnSqFt: 13000 })).toBe(13000);
    expect(lawnTotal({ lawnSqFt: 9000 })).toBe(9000);
    expect(lawnTotal({})).toBeNull();
  });
});

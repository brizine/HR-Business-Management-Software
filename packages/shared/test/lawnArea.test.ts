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

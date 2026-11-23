import { describe, expect, it } from "vitest";
import { crewPeople, crewSchema, packageSchema, packageToLines, packageTotal } from "../src";

const sid = "7f9d1c0e-5b6a-4e8f-9a1b-2c3d4e5f6a7b";
describe("crews", () => {
  it("needs a name; the lead counts as a member", () => {
    expect(crewSchema.safeParse({ name: " " }).success).toBe(false);
    const c = crewSchema.parse({ name: "Crew 1 – Spray", leadId: "a1b2c3d4-0000-4000-8000-000000000001", memberIds: ["a1b2c3d4-0000-4000-8000-000000000002", "a1b2c3d4-0000-4000-8000-000000000001"], assetId: "" });
    expect(c).toMatchObject({ color: "#2563eb", assetId: null, active: true, updateOpenWorkOrders: false });
    expect(crewPeople(c)).toEqual(["a1b2c3d4-0000-4000-8000-000000000001", "a1b2c3d4-0000-4000-8000-000000000002"]);
  });
});

describe("packages", () => {
  it("custom items need a price; services can be priced per lawn", () => {
    const bad = packageSchema.safeParse({ name: "Spring round", lines: [{ description: "Edging", quantity: 1 }] });
    expect(bad.success ? [] : bad.error.issues.map((i) => i.message)).toEqual(["Give a custom item a price"]);
    expect(packageSchema.safeParse({ name: "Spring round", lines: [] }).success).toBe(false);
    const ok = packageSchema.parse({ name: "Spring round", lines: [{ serviceTypeId: sid, description: "Fertilizer", quantity: "1", unitPriceCents: "" }, { description: "Edging", quantity: 1, unitPriceCents: 1500, budgetedHours: "0.25" }] });
    expect(ok.lines[0].unitPriceCents).toBeNull();
    expect(ok.lines[1]).toMatchObject({ unitPriceCents: 1500, budgetedHours: 0.25 });
  });

  it("turns into line items priced for the lawn", () => {
    const services = [{ id: sid, pricing: "per_thousand", priceCents: 425, minimumCents: 4000, brackets: [] }];
    const pkg = [{ serviceTypeId: sid, description: "Fertilizer", quantity: 1, unitPriceCents: null }, { serviceTypeId: null, description: "Edging", quantity: 2, budgetedHours: 0.25, unitPriceCents: 1500 }];
    const lines = packageToLines(pkg, services, 11000);
    expect(lines.map((l) => l.unitPriceCents)).toEqual([4675, 1500]);
    expect(packageTotal(lines)).toBe(4675 + 3000);
    // No lawn size yet: the per-lawn service can't be priced.
    const unknown = packageToLines(pkg, services, null);
    expect(unknown[0].unitPriceCents).toBeNull();
    expect(packageTotal(unknown)).toBeNull();
  });
});

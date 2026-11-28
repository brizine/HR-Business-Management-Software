import { describe, expect, it } from "vitest";
import { crewPeople, crewSchema, packageSchema, packageToLines, packageTotal, propertyPackageSchema, roundMissed } from "../src";

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
  it("a round is a service with a window; the rate can be left to the lawn", () => {
    const round = { name: "Early Spring", serviceTypeId: sid, startDate: "2026-01-01", endDate: "2026-03-01", minDays: "35", unitPriceCents: "", budgetedHours: "" };
    const ok = packageSchema.parse({ name: "Eco Lawn Service", renewalDate: "2026-12-25", rounds: [round] });
    expect(ok.rounds[0]).toMatchObject({ minDays: 35, unitPriceCents: null, budgetedHours: null });
    expect(ok).toMatchObject({ active: true, renewalDate: "2026-12-25" });
    expect(packageSchema.safeParse({ name: "Eco Lawn Service", rounds: [] }).success).toBe(false);
    const issues = (rounds: unknown[]) => { const r = packageSchema.safeParse({ name: "X", rounds }); return r.success ? [] : r.error.issues.map((i) => i.message); };
    expect(issues([{ ...round, serviceTypeId: "" }])).toEqual(["Pick the round's service"]);
    expect(issues([{ ...round, startDate: "" }])).toEqual(["Give the round a start date"]);
    expect(issues([{ ...round, endDate: "2025-12-01" }])).toEqual(["Early Spring ends before it starts"]);
  });

  it("putting it on a property: every included round needs a rate; a missed round is one whose window ended", () => {
    const base = { propertyId: sid, packageId: sid };
    const none = propertyPackageSchema.safeParse({ ...base, rounds: [{ roundId: sid, include: false }] });
    expect(none.success ? [] : none.error.issues.map((i) => i.message)).toEqual(["Include at least one round"]);
    const unpriced = propertyPackageSchema.safeParse({ ...base, rounds: [{ roundId: sid, include: true, unitPriceCents: "" }] });
    expect(unpriced.success ? [] : unpriced.error.issues.map((i) => i.message)).toEqual(["Give every included round a rate"]);
    expect(propertyPackageSchema.parse({ ...base, crewId: "", rounds: [{ roundId: sid, unitPriceCents: 14500 }] })).toMatchObject({ renewal: "auto", crewId: null, rounds: [{ include: true, quantity: 1, scheduleMissed: false }] });
    expect(roundMissed({ endDate: "2026-03-01" }, "2026-03-01")).toBe(false);
    expect(roundMissed({ endDate: "2026-03-01" }, "2026-03-02")).toBe(true);
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

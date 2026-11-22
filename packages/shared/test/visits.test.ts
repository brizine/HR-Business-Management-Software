import { describe, expect, it } from "vitest";
import { describeRepeat, visitDates, visitLineHours, visitNumber, visitSchema, visitTotal, visitUpdateSchema, webPathFor } from "../src";

const ids = { customerId: "7f9d1c0e-5b6a-4e8f-9a1b-2c3d4e5f6a7b", propertyId: "8a9d1c0e-5b6a-4e8f-9a1b-2c3d4e5f6a7b" };
const base = { title: "Round 3: fertilizer & weed control", ...ids, date: "2027-04-05" };
const errors = (input: unknown) => {
  const r = visitSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("work order form", () => {
  it("needs a title, customer, property and a date (unless it's on the waitlist)", () => {
    expect(errors({ ...base, title: "" })[0]).toMatch(/^title:/);
    expect(errors({ ...base, propertyId: undefined })).toEqual(["propertyId: Pick the property"]);
    expect(errors({ ...base, date: "" })).toEqual(["date: Pick the date (or add it to the waitlist)"]);
    expect(errors({ ...base, date: "", scheduling: "waitlist" })).toEqual([]);
    const v = visitSchema.parse({ ...base, lines: [{ description: "Fertilizer", quantity: "1", budgetedHours: "0.5", unitPriceCents: "6500" }] });
    expect(v).toMatchObject({ billing: "invoice", scheduling: "single", repeatEvery: 1, repeatUnit: "week", offMonths: [], assigneeIds: [] });
    expect(v.lines[0]).toMatchObject({ quantity: 1, budgetedHours: 0.5, unitPriceCents: 6500 });
  });

  it("checks line items, times and repeats", () => {
    expect(errors({ ...base, lines: [{ description: "Mow", quantity: 0, unitPriceCents: 100 }] })).toEqual(["lines.0.quantity: The quantity must be more than 0"]);
    expect(errors({ ...base, lines: [{ description: "Mow", quantity: 1, unitPriceCents: -1 }] })).toEqual(["lines.0.unitPriceCents: Prices can't be negative"]);
    expect(errors({ ...base, startTime: "10:00", endTime: "09:00" })).toEqual(["endTime: The end time must be after the start time"]);
    expect(errors({ ...base, scheduling: "repeat" })).toEqual(["repeatUntil: Pick the last date it repeats"]);
    expect(errors({ ...base, scheduling: "repeat", repeatUntil: "2031-01-01" })).toEqual(["repeatUntil: A series can run up to three years"]);
    expect(errors({ ...base, scheduling: "repeat", repeatUnit: "day", repeatUntil: "2027-12-31" })[0]).toMatch(/more than 200 work orders/);
    expect(errors({ ...base, scheduling: "repeat", repeatEvery: 6, repeatUntil: "2027-11-30", offMonths: [12, 1, 2] })).toEqual([]);
    // Editing: no date means "move it to the waitlist".
    expect(visitUpdateSchema.safeParse({ ...base, date: null }).success).toBe(true);
    expect(visitUpdateSchema.parse({ ...base, scheduling: "repeat" })).not.toHaveProperty("scheduling");
  });
});

describe("repeating work orders", () => {
  it("repeats every N days, weeks, months or years", () => {
    expect(visitDates("2027-04-05", "week", 6, "2027-07-01")).toEqual(["2027-04-05", "2027-05-17", "2027-06-28"]);
    expect(visitDates("2027-04-05", "day", 3, "2027-04-12")).toEqual(["2027-04-05", "2027-04-08", "2027-04-11"]);
    expect(visitDates("2027-01-31", "month", 1, "2027-04-30")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(visitDates("2028-02-29", "year", 1, "2030-03-01")).toEqual(["2028-02-29", "2029-02-28", "2030-02-28"]);
    expect(visitDates("2027-04-05", "week", 1, null)).toEqual(["2027-04-05"]);
  });

  it("leaves out the off-season months", () => {
    // Monthly from October, with no work December through February.
    expect(visitDates("2027-10-15", "month", 1, "2028-04-30", [12, 1, 2])).toEqual(["2027-10-15", "2027-11-15", "2028-03-15", "2028-04-15"]);
    expect(describeRepeat("week", 6, [2, 12, 1])).toBe("Every 6 weeks (not Jan, Feb, Dec)");
    expect(describeRepeat("month", 1)).toBe("Every month");
  });
});

describe("work order totals and links", () => {
  it("adds up money and hours, and numbers work orders WO-", () => {
    const lines = [{ quantity: 1, unitPriceCents: 6500, budgetedHours: 0.5 }, { quantity: 2.5, unitPriceCents: 1999, budgetedHours: 0.75 }, { quantity: 1, unitPriceCents: 0 }];
    expect(visitTotal(lines)).toBe(6500 + 4998);
    expect(visitLineHours(lines)).toBe(1.25);
    expect(visitNumber(1001)).toBe("WO-1001");
    expect(webPathFor({ screen: "workorder", id: "abc" })).toBe("/visits/abc");
  });
});

import { describe, expect, it } from "vitest";
import { computeDue, summarizeHours, hasRole } from "../src";

describe("computeDue", () => {
  const today = new Date("2026-06-01T12:00:00Z");

  it("is ok when well within all intervals", () => {
    const r = computeDue(
      { intervalMiles: 5000, intervalDays: 180, lastServiceOdometer: 10000, lastServiceDate: "2026-05-01" },
      { odometer: 11000, engineHours: 0 },
      today,
    );
    expect(r.status).toBe("ok");
    expect(r.nextDueOdometer).toBe(15000);
    expect(r.nextDueDate).toBe("2026-10-28");
  });

  it("is due soon within 10% of the mileage interval", () => {
    const r = computeDue({ intervalMiles: 5000, lastServiceOdometer: 10000 }, { odometer: 14600, engineHours: 0 }, today);
    expect(r.status).toBe("due_soon");
  });

  it("whichever interval is hit first makes it overdue", () => {
    const r = computeDue(
      { intervalMiles: 5000, intervalDays: 30, lastServiceOdometer: 10000, lastServiceDate: "2026-04-01" },
      { odometer: 10500, engineHours: 0 },
      today,
    );
    expect(r.status).toBe("overdue");
    expect(r.reasons[0]).toMatch(/days/);
  });

  it("supports engine-hour intervals", () => {
    const r = computeDue({ intervalHours: 250, lastServiceHours: 1000 }, { odometer: 0, engineHours: 1260 }, today);
    expect(r.status).toBe("overdue");
    expect(r.nextDueHours).toBe(1250);
  });
});

describe("summarizeHours", () => {
  it("puts hours over 40 per week into overtime", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      clockIn: `2026-06-0${i + 1}T08:00:00Z`,
      clockOut: `2026-06-0${i + 1}T18:00:00Z`,
    }));
    expect(summarizeHours(entries)).toEqual({ totalHours: 50, regularHours: 40, overtimeHours: 10 });
  });
});

describe("hasRole", () => {
  it("ranks roles", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("employee", "manager")).toBe(false);
  });
});

import { toE164, webPathFor } from "../src";

describe("toE164", () => {
  it("normalizes common formats", () => {
    expect(toE164("(512) 555-0142")).toBe("+15125550142");
    expect(toE164("1-512-555-0142")).toBe("+15125550142");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0142")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});

describe("webPathFor", () => {
  it("maps links to web pages", () => {
    expect(webPathFor({ screen: "asset", id: "a1" })).toBe("/fleet/a1");
    expect(webPathFor(null)).toBeNull();
  });
});

import { availabilityConflicts, describeRule, shiftSegments } from "../src";

describe("availability", () => {
  const tuesdayAllDay = { weekday: 2 };
  const fridayMorning = { weekday: 5, endTime: "14:00" };

  it("describes rules", () => {
    expect(describeRule(tuesdayAllDay)).toBe("All day");
    expect(describeRule(fridayMorning)).toBe("Before 2pm");
    expect(describeRule({ weekday: 1, startTime: "17:30" })).toBe("After 5:30pm");
  });

  it("finds overlaps, including overnight shifts", () => {
    const fri = (from: number, to: number) => [{ weekday: 5, from, to }];
    expect(availabilityConflicts([fridayMorning], fri(13 * 60, 18 * 60))).toHaveLength(1);
    expect(availabilityConflicts([fridayMorning], fri(14 * 60, 18 * 60))).toHaveLength(0); // starts right when free
    // Monday 10pm → Tuesday 6am runs into Tuesday.
    const segs = shiftSegments({ weekday: 1, minutes: 22 * 60, date: "2030-01-07" }, { weekday: 2, minutes: 6 * 60, date: "2030-01-08" });
    expect(segs).toEqual([{ weekday: 1, from: 1320, to: 1440 }, { weekday: 2, from: 0, to: 360 }]);
    expect(availabilityConflicts([tuesdayAllDay], segs)).toHaveLength(1);
  });
});

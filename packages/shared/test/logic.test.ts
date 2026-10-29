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

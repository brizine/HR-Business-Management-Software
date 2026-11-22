import { describe, expect, it } from "vitest";
import { formatTodoTime, todoDates, todoSchema, todoState, todoUpdateSchema, webPathFor } from "../src";

const base = { title: "Call the HOA about the gate code", date: "2026-11-23" };
const errors = (input: unknown) => {
  const r = todoSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("to-do form", () => {
  it("needs a title and a date; blanks become empty", () => {
    expect(errors({ date: "2026-11-23" })[0]).toMatch(/^title:/);
    const t = todoSchema.parse({ ...base, notes: " ", location: "", budgetedHours: "", customerId: "" });
    expect(t).toMatchObject({ notes: null, location: null, budgetedHours: null, customerId: null, repeat: "none", assigneeIds: [], color: "#2563eb" });
    expect(todoSchema.parse({ ...base, budgetedHours: "1.5" }).budgetedHours).toBe(1.5);
  });

  it("checks days, times, property and repeats", () => {
    expect(errors({ ...base, endDate: "2026-11-22" })).toEqual(["endDate: The last day can't be before the first"]);
    expect(errors({ ...base, endTime: "10:00" })).toEqual(["startTime: Add a start time too"]);
    expect(errors({ ...base, startTime: "10:00", endTime: "09:30" })).toEqual(["endTime: The end time must be after the start time"]);
    // Overnight across a multi-day to-do is fine.
    expect(errors({ ...base, endDate: "2026-11-24", startTime: "10:00", endTime: "09:30" })).toEqual([]);
    expect(errors({ ...base, propertyId: "7f9d1c0e-5b6a-4e8f-9a1b-2c3d4e5f6a7b" })).toEqual(["propertyId: Pick the customer first"]);
    expect(errors({ ...base, repeat: "weekly" })).toEqual(["repeatUntil: Pick the last date it repeats"]);
    expect(errors({ ...base, repeat: "weekly", repeatUntil: "2028-01-01" })).toEqual(["repeatUntil: Repeats can go up to a year ahead"]);
    expect(errors({ ...base, repeat: "weekly", repeatUntil: "2026-12-31", endDate: "2026-11-25" })).toEqual(["endDate: Repeating to-dos are one day each"]);
    // Edits don't take a repeat.
    expect(todoUpdateSchema.parse({ ...base, repeat: "weekly" })).not.toHaveProperty("repeat");
  });
});

describe("repeating to-dos", () => {
  it("lists the dates for each repeat", () => {
    expect(todoDates("2026-11-23", "none", "2026-12-31")).toEqual(["2026-11-23"]);
    expect(todoDates("2026-11-23", "daily", "2026-11-26")).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
    // Fri 27 through Tue Dec 1: skips the weekend.
    expect(todoDates("2026-11-27", "weekdays", "2026-12-01")).toEqual(["2026-11-27", "2026-11-30", "2026-12-01"]);
    expect(todoDates("2026-11-23", "weekly", "2026-12-14")).toEqual(["2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"]);
    expect(todoDates("2026-11-23", "biweekly", "2026-12-20")).toEqual(["2026-11-23", "2026-12-07"]);
    // Month ends: Jan 31 → Feb 28 → Mar 31 (and Feb 29 in a leap year).
    expect(todoDates("2027-01-31", "monthly", "2027-04-30")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(todoDates("2028-01-31", "monthly", "2028-02-29")).toEqual(["2028-01-31", "2028-02-29"]);
    expect(todoDates("2026-11-23", "daily", "2030-01-01")).toHaveLength(367);
  });
});

describe("to-do status and display", () => {
  it("is overdue after its last day, today while it runs, upcoming before", () => {
    expect(todoState({ date: "2026-11-20" }, "2026-11-22")).toBe("overdue");
    expect(todoState({ date: "2026-11-20", endDate: "2026-11-23" }, "2026-11-22")).toBe("today");
    expect(todoState({ date: "2026-11-22" }, "2026-11-22")).toBe("today");
    expect(todoState({ date: "2026-11-25" }, "2026-11-22")).toBe("upcoming");
    expect(todoState({ date: "2026-11-20", doneAt: "2026-11-21T10:00:00Z" }, "2026-11-22")).toBe("done");
  });

  it("formats times and links", () => {
    expect(formatTodoTime("08:00", "10:30")).toBe("8:00 AM – 10:30 AM");
    expect(formatTodoTime("13:05", null)).toBe("1:05 PM");
    expect(formatTodoTime(null, null)).toBe("");
    expect(webPathFor({ screen: "todos", id: "abc" })).toBe("/todos?open=abc");
    expect(webPathFor({ screen: "todos" })).toBe("/todos");
  });
});

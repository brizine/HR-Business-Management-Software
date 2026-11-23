import { describe, expect, it } from "vitest";
import {
  colorName, describeTodoRule, describeSeries, formatMinutes, formatMonthDay, formatTodoTime, inOffSeason, normalizeRule, offSeasonSchema, previewSeries,
  ruleDates, todoDates, todoSchema, todoState, todoUpdateSchema, trackedMinutes, webPathFor,
} from "../src";

const base = { title: "Call the HOA about the gate code", date: "2026-11-23" };
const errors = (input: unknown) => {
  const r = todoSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("to-do form", () => {
  it("needs a title and a date; blanks become empty", () => {
    expect(errors({ date: "2026-11-23" })[0]).toMatch(/^title:/);
    const t = todoSchema.parse({ ...base, notes: " ", location: "", budgetedHours: "", customerId: "" });
    expect(t).toMatchObject({ notes: null, location: null, budgetedHours: null, customerId: null, assigneeIds: [], color: "#2563eb" });
    expect(t.rule ?? null).toBeNull();
    expect(todoSchema.parse({ ...base, budgetedHours: "1.5" }).budgetedHours).toBe(1.5);
  });

  it("checks days, times, property and repeats", () => {
    expect(errors({ ...base, endDate: "2026-11-22" })).toEqual(["endDate: The last day can't be before the first"]);
    expect(errors({ ...base, endTime: "10:00" })).toEqual(["startTime: Add a start time too"]);
    expect(errors({ ...base, startTime: "10:00", endTime: "09:30" })).toEqual(["endTime: The end time must be after the start time"]);
    // Overnight across a multi-day to-do is fine.
    expect(errors({ ...base, endDate: "2026-11-24", startTime: "10:00", endTime: "09:30" })).toEqual([]);
    expect(errors({ ...base, propertyId: "7f9d1c0e-5b6a-4e8f-9a1b-2c3d4e5f6a7b" })).toEqual(["propertyId: Pick the customer first"]);
    // The older repeat + repeatUntil still work: they become a rule.
    expect(errors({ ...base, repeat: "weekly" })).toEqual(["rule.until: Pick the last date you'll make a to-do"]);
    expect(todoSchema.parse({ ...base, repeat: "biweekly", repeatUntil: "2026-12-31" }).rule).toMatchObject({ freq: "weekly", every: 2, weekdays: [1], end: "date", until: "2026-12-31" });
    expect(errors({ ...base, rule: { freq: "weekly", end: "date", until: "2032-01-01" } })).toEqual(["rule.until: A series can run up to 5 years, or pick no end date"]);
    expect(errors({ ...base, rule: { freq: "weekly", end: "date", until: "2026-11-01" } })).toEqual(["rule.until: Pick a last date after the first one"]);
    expect(errors({ ...base, rule: { freq: "daily", end: "count" } })).toEqual(["rule.count: How many to-dos?"]);
    expect(errors({ ...base, rule: { freq: "daily", end: "never" } })).toEqual([]);
    expect(errors({ ...base, rule: { freq: "weekly", end: "never" }, endDate: "2026-11-25" })).toEqual(["endDate: Repeating to-dos are one day each"]);
    // Edits don't take a repeat.
    expect(todoUpdateSchema.parse({ ...base, rule: { freq: "daily", end: "never" } })).not.toHaveProperty("rule");
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

const days = (start: string, rule: Parameters<typeof ruleDates>[1], opts?: Parameters<typeof ruleDates>[2]) => ruleDates(start, rule, opts);

describe("repeat rules (like Homeworks')", () => {
  it("daily: every N days, or every weekday", () => {
    expect(days("2026-11-23", { freq: "daily", every: 3, end: "count", count: 4 })).toEqual(["2026-11-23", "2026-11-26", "2026-11-29", "2026-12-02"]);
    expect(days("2026-11-27", { freq: "daily", weekdaysOnly: true, end: "count", count: 3 })).toEqual(["2026-11-27", "2026-11-30", "2026-12-01"]);
  });

  it("weekly: every N weeks on the days picked", () => {
    // Homeworks' own preview: weekly on Monday from Sun Nov 22 to Dec 22 runs Nov 23 to Dec 21.
    expect(days("2026-11-22", { freq: "weekly", weekdays: [1], end: "date", until: "2026-12-22" })).toEqual(["2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14", "2026-12-21"]);
    expect(days("2026-11-23", { freq: "weekly", every: 2, weekdays: [3, 1], end: "date", until: "2026-12-31" }))
      .toEqual(["2026-11-23", "2026-11-25", "2026-12-07", "2026-12-09", "2026-12-21", "2026-12-23"]);
    // Starting on a Sunday, every 2 weeks on Monday: the next day, then two weeks on.
    expect(days("2026-11-22", { freq: "weekly", every: 2, weekdays: [1], end: "count", count: 3 })).toEqual(["2026-11-23", "2026-12-07", "2026-12-21"]);
    // No days picked: the first date's day.
    expect(days("2026-11-25", { freq: "weekly", end: "count", count: 2 })).toEqual(["2026-11-25", "2026-12-02"]);
  });

  it("monthly: a day of the month, or the Nth weekday", () => {
    expect(days("2027-01-15", { freq: "monthly", day: 31, end: "count", count: 4 })).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(days("2026-11-01", { freq: "monthly", every: 2, by: "nth", nth: -1, weekday: 5, end: "count", count: 3 })).toEqual(["2026-11-27", "2027-01-29", "2027-03-26"]);
    expect(days("2026-11-23", { freq: "monthly", by: "nth", nth: 1, weekday: 1, end: "count", count: 2 })).toEqual(["2026-12-07", "2027-01-04"]);
  });

  it("yearly: a month and day, or the Nth weekday of a month", () => {
    expect(days("2026-11-23", { freq: "yearly", month: 3, day: 15, end: "count", count: 3 })).toEqual(["2027-03-15", "2028-03-15", "2029-03-15"]);
    expect(days("2026-01-01", { freq: "yearly", by: "nth", nth: 4, weekday: 4, month: 11, end: "count", count: 2 })).toEqual(["2026-11-26", "2027-11-25"]);
  });

  it("pauses during an off-season, even over New Year", () => {
    const winter = { start: "12-01", end: "02-28" };
    expect(inOffSeason("2027-01-10", winter)).toBe(true);
    expect(inOffSeason("2026-11-30", winter)).toBe(false);
    expect(inOffSeason("2026-07-04", { start: "06-01", end: "08-31" })).toBe(true);
    expect(days("2026-11-23", { freq: "weekly", end: "date", until: "2027-03-15" }, { offSeason: winter })).toEqual(["2026-11-23", "2026-11-30", "2027-03-01", "2027-03-08", "2027-03-15"]);
    // A count counts only the to-dos made.
    expect(days("2026-11-23", { freq: "weekly", end: "count", count: 3 }, { offSeason: winter })).toEqual(["2026-11-23", "2026-11-30", "2027-03-01"]);
  });

  it("makes open-ended series a year ahead, and tops them up after what's made", () => {
    expect(days("2026-11-23", { freq: "daily", end: "never" })).toHaveLength(367);
    const more = days("2026-11-23", { freq: "daily", end: "never" }, { through: "2027-12-28", after: "2027-11-24" });
    expect(more[0]).toBe("2027-11-25");
    expect(more).toHaveLength(34);
    // A series ending on a date is made a year ahead too, then topped up to its last date.
    expect(days("2026-11-23", { freq: "weekly", end: "date", until: "2029-01-01" }).at(-1)).toBe("2027-11-22");
    expect(days("2026-11-23", { freq: "weekly", end: "date", until: "2029-01-01" }, { through: "2030-01-01", after: "2028-12-20" })).toEqual(["2028-12-25", "2029-01-01"]);
    expect(days("2026-11-23", { freq: "daily", end: "count", count: 500 })).toHaveLength(500);
    expect(errors({ ...base, rule: { freq: "daily", end: "count", count: 900 } })).toEqual(["rule.count: Up to 500 at a time"]);
  });

  it("fills blanks from the first date", () => {
    // Mon Nov 30 is the fifth Monday, so "last".
    expect(normalizeRule("2026-11-30", { freq: "monthly", by: "nth" })).toMatchObject({ nth: -1, weekday: 1, day: 30, month: 11, weekdays: [1] });
    expect(normalizeRule("2026-11-23", { freq: "weekly", weekdays: [0, 3, 1, 3] }).weekdays).toEqual([1, 3, 0]);
  });

  it("describes the series and previews the first and last", () => {
    expect(describeTodoRule("2026-11-23", { freq: "weekly" })).toBe("Every week on Mon");
    expect(describeTodoRule("2026-11-23", { freq: "weekly", every: 2, weekdays: [1, 3] })).toBe("Every 2 weeks on Mon, Wed");
    expect(describeTodoRule("2026-11-23", { freq: "daily", weekdaysOnly: true })).toBe("Every weekday");
    expect(describeTodoRule("2026-11-23", { freq: "daily", every: 3 })).toBe("Every 3 days");
    expect(describeTodoRule("2026-11-15", { freq: "monthly" })).toBe("Day 15 of every month");
    expect(describeTodoRule("2026-11-23", { freq: "monthly", every: 2, by: "nth", nth: -1, weekday: 5 })).toBe("The last Friday of every 2 months");
    expect(describeTodoRule("2026-03-15", { freq: "yearly" })).toBe("Every year on March 15");
    expect(describeTodoRule("2026-11-23", { freq: "yearly", by: "nth", nth: 4, weekday: 4, month: 11 })).toBe("The fourth Thursday of November, every year");
    expect(describeSeries("2026-11-23", { freq: "weekly", end: "date", until: "2026-12-21" }, "Winter")).toBe("Every week on Mon until Dec 21, 2026 · not during Winter");
    expect(describeSeries("2026-11-23", { freq: "daily", end: "count", count: 10 })).toBe("Every day, 10 times");
    expect(previewSeries("2026-11-22", { freq: "weekly", weekdays: [1], end: "date", until: "2026-12-22" }))
      .toEqual({ count: 5, text: "Based on these settings, the first to-do will be on Nov 23, 2026 and the last will be on Dec 21, 2026 (5 to-dos)." });
    expect(previewSeries("2026-11-23", { freq: "daily", end: "never" }).count).toBeNull();
    expect(previewSeries("2026-12-05", { freq: "weekly", end: "date", until: "2027-01-31" }, { start: "12-01", end: "02-28" }).count).toBe(0);
  });
});

describe("off-seasons, colors and work time", () => {
  it("checks off-seasons", () => {
    expect(offSeasonSchema.safeParse({ name: "Winter", start: "12-01", end: "02-28" }).success).toBe(true);
    expect(offSeasonSchema.safeParse({ name: "Winter", start: "12-01", end: "02-30" }).success).toBe(false);
    expect(offSeasonSchema.safeParse({ name: "Winter", start: "12-01", end: "12-01" }).success).toBe(false);
    expect(formatMonthDay("03-01")).toBe("March 1");
  });

  it("names Homeworks' colors and adds up work time", () => {
    expect(colorName("#166534")).toBe("Bold green");
    expect(colorName("#123456")).toBeNull();
    const now = new Date("2026-11-23T15:00:00Z");
    expect(trackedMinutes({ trackedSeconds: 600, startedAt: "2026-11-23T14:30:00Z" }, now)).toBe(40);
    expect(trackedMinutes({ trackedSeconds: 3900, startedAt: null }, now)).toBe(65);
    expect(formatMinutes(65)).toBe("1 h 05 m");
    expect(formatMinutes(12)).toBe("12 m");
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
    expect(webPathFor({ screen: "todos", id: "abc" })).toBe("/todos/abc");
    expect(webPathFor({ screen: "todos" })).toBe("/todos");
  });
});

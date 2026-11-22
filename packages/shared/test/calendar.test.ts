import { describe, expect, it } from "vitest";
import { eventOnDay, eventsCsv, sortEvents, type CalendarEvent } from "../src";

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  key: `todo:${over.id ?? "x"}`, type: "todo", id: "x", title: "A", date: "2026-11-23", endDate: null, startTime: null, endTime: null, color: null,
  status: "open", statusLabel: "Open", recurring: false, customer: null, property: null, location: null, people: [], hours: null, notes: null,
  tagIds: [], amountCents: null, invoiced: null, onSite: false, trackedMinutes: null, serviceIds: [], href: null, canMove: false, canComplete: false, ...over,
});

describe("calendar", () => {
  it("sorts a day's events by the chosen order", () => {
    const list = [
      ev({ id: "1", title: "Late", startTime: "15:00", hours: 1, status: "done", customer: { id: "c", name: "Zed" } }),
      ev({ id: "2", title: "All day", hours: 3 }),
      ev({ id: "3", title: "Early", startTime: "08:00", type: "repair", customer: { id: "d", name: "Ann" } }),
    ];
    const ids = (s: Parameters<typeof sortEvents>[1]) => sortEvents(list, s).map((e) => e.id).join("");
    expect(ids("time")).toBe("231");
    expect(ids("timeDesc")).toBe("132");
    expect(ids("hoursDesc")).toBe("213");
    expect(ids("customer")).toBe("312");
    expect(ids("status")).toBe("231");
    expect(ids("type")).toBe("213");
    const paid = [ev({ id: "a", amountCents: 5000 }), ev({ id: "b", amountCents: 12000 }), ev({ id: "c" })];
    expect(sortEvents(paid, "revenueDesc").map((e) => e.id).join("")).toBe("bac");
  });

  it("puts multi-day events on every day they run", () => {
    const e = ev({ date: "2026-11-23", endDate: "2026-11-25" });
    expect(["2026-11-22", "2026-11-23", "2026-11-25", "2026-11-26"].map((d) => eventOnDay(e, d))).toEqual([false, true, true, false]);
  });

  it("exports to CSV safely", () => {
    const csv = eventsCsv([ev({ title: '=HYPERLINK("x")', notes: "Gate, side", people: [{ id: "p", name: "Ann Lee" }, { id: "q", name: "Bo" }], startTime: "08:00" })]);
    const [head, row] = csv.split("\n");
    expect(head).toBe("Date,End date,Start,End,Type,Title,Status,Customer,Address or location,People,Hours,Amount,Notes");
    expect(row).toBe(`2026-11-23,,08:00,,To-dos,"'=HYPERLINK(""x"")",Open,,,Ann Lee; Bo,,,"Gate, side"`);
  });
});

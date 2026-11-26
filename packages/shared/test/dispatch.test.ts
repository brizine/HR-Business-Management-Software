import { describe, expect, it } from "vitest";
import {
  END, START, capacityText, clockText, dispatchAssignSchema, estimateLeg, etaText, eventKey, laneKeyOf, legText, optimizeOrder, parseEventKey,
  rainDaySchema, routeSaveSchema, routeTimeline,
} from "../src";

const shop = { lat: 35.2602833, lng: -97.4651331 };
const cityHall = { lat: 35.2226, lng: -97.4447 };
const library = { lat: 35.2241, lng: -97.4455 };
const campus = { lat: 35.2059, lng: -97.4457 };

describe("events and lanes", () => {
  it("names a work order or a to-do, and reads the name back", () => {
    const id = "0b0f7e7e-3f1f-4d44-9a11-0d9c2f8a1e10";
    expect(eventKey("visit", id)).toBe(`v:${id}`);
    expect(parseEventKey(`t:${id}`)).toEqual({ kind: "todo", id });
    expect(parseEventKey(`v:${id}`)).toEqual({ kind: "visit", id });
  });
  it("puts an event in its crew's lane, its people's lane, or Unassigned", () => {
    expect(laneKeyOf({ crewId: "c1", assigneeIds: ["b", "a"] })).toBe("crew:c1");
    expect(laneKeyOf({ crewId: null, assigneeIds: ["b", "a"] })).toBe("emp:a,b");
    expect(laneKeyOf({ crewId: null, assigneeIds: ["a", "b"] })).toBe("emp:a,b");
    expect(laneKeyOf({ assigneeIds: [] })).toBe("unassigned");
  });
});

describe("drive estimates", () => {
  it("is about what a map says for a drive across town", () => {
    const leg = estimateLeg(shop, cityHall);
    expect(leg.meters / 1609.344).toBeGreaterThan(3);
    expect(leg.meters / 1609.344).toBeLessThan(5);
    expect(leg.seconds / 60).toBeGreaterThan(6);
    expect(leg.seconds / 60).toBeLessThan(12);
    expect(legText(leg)).toMatch(/^\d(\.\d)? mi · \d+ min$/);
  });
  it("is nothing for the same spot, and short for next door", () => {
    expect(estimateLeg(shop, shop)).toEqual({ meters: 0, seconds: 0 });
    expect(estimateLeg(cityHall, library).seconds).toBeLessThan(120);
  });
  it("writes hours and minutes", () => {
    expect(clockText(31 * 60)).toBe("0:31");
    expect(clockText(4 * 3600 + 60)).toBe("4:01");
  });
});

describe("ordering stops", () => {
  const pts = [campus, cityHall, { lat: 35.25, lng: -97.46 }, library];
  const at = (i: number) => (i === START || i === END ? shop : pts[i]);
  const cost = (a: number, b: number) => estimateLeg(at(a), at(b)).seconds;
  const total = (order: number[]) => cost(START, order[0]) + order.slice(1).reduce((s, x, i) => s + cost(order[i], x), 0) + cost(order[order.length - 1], END);

  it("visits every stop once and beats the order given", () => {
    const order = optimizeOrder(4, cost, { hasStart: true, hasEnd: true });
    expect([...order].sort()).toEqual([0, 1, 2, 3]);
    expect(total(order)).toBeLessThanOrEqual(total([0, 1, 2, 3]));
    // The two downtown stops end up next to each other.
    expect(Math.abs(order.indexOf(1) - order.indexOf(3))).toBe(1);
  });
  it("keeps a pinned stop first and stops without a location last", () => {
    const order = optimizeOrder(4, cost, { hasStart: true, hasEnd: true, first: 0, last: [2] });
    expect(order[0]).toBe(0);
    expect(order[3]).toBe(2);
    expect([...order].sort()).toEqual([0, 1, 2, 3]);
  });
  it("works with no start or end, and with one stop or none", () => {
    expect([...optimizeOrder(4, cost)].sort()).toEqual([0, 1, 2, 3]);
    expect(optimizeOrder(1, cost, { hasStart: true })).toEqual([0]);
    expect(optimizeOrder(0, cost)).toEqual([]);
  });
});

describe("a route's day", () => {
  it("adds each drive and each stop's time to the start time", () => {
    const t = routeTimeline({ startTime: "08:00", minutes: [60, 30, 120], legs: [{ meters: 6400, seconds: 420 }, { meters: 320, seconds: 60 }, { meters: 2900, seconds: 480 }], endLeg: { meters: 12400, seconds: 840 } });
    expect(t.arrive.map((m) => etaText(m))).toEqual(["8:07 am", "9:08 am", "9:46 am"]);
    expect(etaText(t.endAt)).toBe("12:00 pm");
    expect(t.driveSeconds).toBe(1800);
    expect(t.onSiteMinutes).toBe(210);
    expect(t.totalMinutes).toBe(240);
  });
  it("leaves out the drives it doesn't have (an open-ended route, a stop with no location)", () => {
    const t = routeTimeline({ startTime: "13:30", minutes: [45, null], legs: [null, null], endLeg: null });
    expect(t.arrive).toEqual([810, 855]);
    expect(t.endAt).toBe(855);
    expect(t.driveSeconds).toBe(0);
  });
  it("shows arrival as a window, a half day, or the next day", () => {
    expect(etaText(8 * 60 + 7, 15)).toBe("8:00 – 8:15 am");
    expect(etaText(11 * 60 + 50, 60)).toBe("11:00 am – 12:00 pm");
    expect(etaText(14 * 60, -1)).toBe("PM");
    expect(etaText(24 * 60 + 20)).toBe("12:20 am +1d");
  });
});

describe("capacity", () => {
  it("reads booked over capacity, with what's left or how far over", () => {
    expect(capacityText(7, 14)).toMatchObject({ label: "7 / 14", rest: "Available 7", over: false, share: 0.5 });
    expect(capacityText(9.5, 8)).toMatchObject({ label: "9.5 / 8", rest: "Over 1.5", over: true, share: 1 });
  });
  it("treats a capacity of 0 as a real limit, and no capacity as just hours", () => {
    expect(capacityText(5, 0)).toMatchObject({ rest: "Over 5", over: true });
    expect(capacityText(0, 0)).toMatchObject({ rest: "Available 0", over: false });
    expect(capacityText(3, null)).toMatchObject({ label: "3BH", rest: "" });
  });
});

describe("what the server accepts", () => {
  const k = "v:0b0f7e7e-3f1f-4d44-9a11-0d9c2f8a1e10";
  it("assigns a crew or people, never both", () => {
    expect(dispatchAssignSchema.safeParse({ keys: [k], crewId: "0b0f7e7e-3f1f-4d44-9a11-0d9c2f8a1e11" }).success).toBe(true);
    expect(dispatchAssignSchema.safeParse({ keys: [k] }).success).toBe(true);
    expect(dispatchAssignSchema.safeParse({ keys: [k], crewId: "0b0f7e7e-3f1f-4d44-9a11-0d9c2f8a1e11", employeeIds: ["0b0f7e7e-3f1f-4d44-9a11-0d9c2f8a1e12"] }).success).toBe(false);
    expect(dispatchAssignSchema.safeParse({ keys: ["x:1"] }).success).toBe(false);
  });
  it("limits a route to 100 stops and future weeks to 1–52", () => {
    const many = Array.from({ length: 101 }, (_, i) => `v:0b0f7e7e-3f1f-4d44-9a11-${String(i).padStart(12, "0")}`);
    const r = routeSaveSchema.safeParse({ date: "2026-04-15", keys: many });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("limited to 100 stops");
    expect(routeSaveSchema.safeParse({ date: "2026-04-15", keys: [k], future: { everyWeeks: 53 } }).success).toBe(false);
    expect(routeSaveSchema.parse({ date: "2026-04-15", keys: [k], future: { everyWeeks: "2" } })).toMatchObject({ startTime: "08:00", start: { kind: "company" }, future: { everyWeeks: 2, assignments: "none" } });
  });
  it("sends a rain day's work to the waiting list or the next working day", () => {
    expect(rainDaySchema.parse({ date: "2026-04-15", to: "next" })).toMatchObject({ crewId: "all", reason: "rain", notify: false });
    expect(rainDaySchema.safeParse({ date: "2026-04-15", to: "tomorrow" }).success).toBe(false);
  });
});

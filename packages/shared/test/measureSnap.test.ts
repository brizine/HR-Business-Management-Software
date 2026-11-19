import { describe, expect, it } from "vitest";
import { bearingDeg, snapDrawPoint } from "../src/measureSnap";

const near = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 3);
  expect(p.y).toBeCloseTo(y, 3);
};

describe("snapping the next point", () => {
  it("does nothing before the first point, or when far from any direction", () => {
    expect(snapDrawPoint({ x: 10, y: 10 }, {}).kind).toBeNull();
    expect(snapDrawPoint({ x: 100, y: 60 }, { last: { x: 0, y: 0 } }).kind).toBeNull(); // about 31°
  });

  it("locks the first edge to north–south or east–west", () => {
    const r = snapDrawPoint({ x: 200, y: 6 }, { last: { x: 0, y: 0 } }); // 1.7° off east
    expect(r.kind).toBe("axis");
    near(r.point, 200, 0); // straight east, as far out as the crosshair reaches along it
  });

  it("squares the next edge to the last one, even when the lot is tilted", () => {
    // Last edge runs at 30°; cursor about 2° off square to it.
    const prev = { x: 0, y: 0 }, last = { x: 100 * Math.cos(Math.PI / 6), y: 50 };
    const a = ((120 + 2) * Math.PI) / 180;
    const cursor = { x: last.x + 100 * Math.cos(a), y: last.y + 100 * Math.sin(a) };
    const r = snapDrawPoint(cursor, { last, prev });
    expect(r.kind).toBe("square");
    const ang = (Math.atan2(r.point.y - last.y, r.point.x - last.x) * 180) / Math.PI;
    expect(ang).toBeCloseTo(120, 6);
  });

  it("offers straight on and 45°", () => {
    expect(snapDrawPoint({ x: 300, y: 3 }, { last: { x: 100, y: 0 }, prev: { x: 0, y: 0 } }).kind).toBe("straight");
    expect(snapDrawPoint({ x: 200, y: 98 }, { last: { x: 100, y: 0 }, prev: { x: 0, y: 0 } }).kind).toBe("diagonal");
  });

  it("snaps onto a nearby corner first, including the first point to close the shape", () => {
    const r = snapDrawPoint({ x: 52, y: 47 }, { last: { x: 0, y: 0 }, vertices: [{ x: 50, y: 50 }] });
    expect(r.kind).toBe("corner");
    near(r.point, 50, 50);
    const first = { x: 0, y: 0 };
    expect(snapDrawPoint({ x: 4, y: -3 }, { first, last: { x: 0, y: 100 }, prev: { x: 100, y: 100 } }).point).toEqual(first);
  });

  it("finds the fourth corner of a rectangle", () => {
    const first = { x: 0, y: 0 }, second = { x: 200, y: 0 }, third = { x: 200, y: 100 };
    const r = snapDrawPoint({ x: 6, y: 103 }, { first, second, prev: second, last: third });
    expect(r.kind).toBe("rectangle");
    near(r.point, 0, 100);
  });

  it("gives compass bearings", () => {
    expect(bearingDeg([35, -97], [35.01, -97])).toBeCloseTo(0, 3);
    expect(bearingDeg([35, -97], [35, -96.99])).toBeCloseTo(90, 3);
    expect(bearingDeg([35, -97], [34.99, -97])).toBeCloseTo(180, 3);
  });
});

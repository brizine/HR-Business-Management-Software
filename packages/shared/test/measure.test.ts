import { describe, expect, it } from "vitest";
import { measureShapeSchema, measureTotals, pathLengthM, polygonAreaSqM, SQ_FT_PER_SQ_M, type LatLng } from "../src/measure";

/** A square `side` meters across, centered near Norman, OK. */
function square(side: number, lat = 35.2226, lng = -97.4395): LatLng[] {
  const dLat = side / 111_320;
  const dLng = side / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [[lat, lng], [lat + dLat, lng], [lat + dLat, lng + dLng], [lat, lng + dLng]];
}

describe("measure math", () => {
  it("computes a 100 m square as about 10,000 m²", () => {
    expect(polygonAreaSqM(square(100))).toBeGreaterThan(9_900);
    expect(polygonAreaSqM(square(100))).toBeLessThan(10_100);
  });

  it("is the same whichever way the points go around", () => {
    const pts = square(50);
    expect(polygonAreaSqM([...pts].reverse())).toBeCloseTo(polygonAreaSqM(pts), 6);
  });

  it("gives zero for fewer than 3 points", () => {
    expect(polygonAreaSqM(square(50).slice(0, 2))).toBe(0);
  });

  it("measures a perimeter and a line", () => {
    expect(pathLengthM(square(100), true)).toBeGreaterThan(398);
    expect(pathLengthM(square(100), true)).toBeLessThan(402);
    expect(pathLengthM(square(100).slice(0, 2))).toBeCloseTo(100, 0);
  });

  it("subtracts cut-outs and adds up lines", () => {
    const t = measureTotals([
      { kind: "turf", points: square(100) },
      { kind: "cut", points: square(20) },
      { kind: "line", points: square(100).slice(0, 2) },
    ]);
    const expected = (polygonAreaSqM(square(100)) - polygonAreaSqM(square(20))) * SQ_FT_PER_SQ_M;
    expect(t.netSqFt).toBeCloseTo(expected, 3);
    expect(t.acres).toBeCloseTo(expected / 43_560, 6);
    expect(t.lineFt).toBeGreaterThan(325);
    expect(t.lineFt).toBeLessThan(332);
  });

  it("never goes below zero", () => {
    expect(measureTotals([{ kind: "cut", points: square(10) }]).netSqFt).toBe(0);
  });

  it("requires 3 points for an area but 2 for a line", () => {
    const two = square(10).slice(0, 2);
    expect(measureShapeSchema.safeParse({ id: "a", kind: "turf", points: two }).success).toBe(false);
    expect(measureShapeSchema.safeParse({ id: "a", kind: "line", points: two }).success).toBe(true);
  });
});

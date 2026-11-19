import { describe, expect, it } from "vitest";
import { imagerySourceSchema, measureShapeSchema, measureShapes, measureTotals, pickOkMapsLayers, pathLengthM, polygonAreaSqM, SQ_FT_PER_SQ_M, type LatLng } from "../src/measure";

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
    expect(t.netSqFt).toBeCloseTo(expected, -1);
    expect(t.acres).toBeCloseTo(expected / 43_560, 3);
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

describe("cut-outs subtract from the area they cut", () => {
  const big = square(100);
  const sq = (pts: LatLng[]) => polygonAreaSqM(pts) * SQ_FT_PER_SQ_M;
  /** A square `side` m across whose corner is `east` m east and `north` m north of the big square's corner. */
  const at = (side: number, north: number, east: number) => {
    const [lat, lng] = big[0];
    return square(side, lat + north / 111_320, lng + east / (111_320 * Math.cos((lat * Math.PI) / 180)));
  };

  it("removes a cut-out fully inside the area, and shows it on that area", () => {
    const r = measureShapes([{ id: "lawn", kind: "turf", points: big }, { id: "bed", kind: "cut", points: at(20, 10, 10) }]);
    expect(r.netSqFt).toBeCloseTo(sq(big) - sq(at(20, 10, 10)), -1);
    expect(r.byId.lawn).toBeCloseTo(r.netSqFt, 3);
    expect(r.byId.bed).toBeCloseTo(sq(at(20, 10, 10)), -1);
    expect(r.shapesWithHoles.lawn[0]).toHaveLength(2); // outer ring + hole
  });

  it("only removes the part of a cut-out that overlaps the area", () => {
    const r = measureShapes([{ id: "lawn", kind: "turf", points: big }, { id: "drive", kind: "cut", points: at(20, 40, 90) }]);
    // Half of the 20 m square hangs past the lawn's east edge.
    expect(r.byId.drive / sq(at(20, 40, 90))).toBeCloseTo(0.5, 1);
    expect(r.netSqFt).toBeCloseTo(sq(big) - r.byId.drive, -1);
  });

  it("ignores a cut-out outside every area", () => {
    const r = measureShapes([{ id: "lawn", kind: "turf", points: big }, { id: "x", kind: "cut", points: at(10, 300, 300) }]);
    expect(r.byId.x).toBe(0);
    expect(r.netSqFt).toBeCloseTo(sq(big), -1);
  });

  it("counts overlapping areas and overlapping cut-outs once", () => {
    const r = measureShapes([
      { id: "a", kind: "turf", points: big }, { id: "b", kind: "turf", points: at(100, 50, 0) },
      { id: "c1", kind: "cut", points: at(20, 60, 10) }, { id: "c2", kind: "cut", points: at(20, 60, 10) },
    ]);
    expect(r.turfSqFt / sq(big)).toBeCloseTo(1.5, 2);
    expect(r.cutSqFt).toBeCloseTo(sq(at(20, 60, 10)), -1);
  });
});

describe("OKMaps layer discovery", () => {
  // Layer names as OKMaps lists them (Nov 2026), plus a made-up future year.
  const names = [
    "ogi:Aerial2025_Composite", "ogi:NAIP2008_Composite", "ogi:NAIP2013_Statewide_Composite", "ogi:NAIP2023_NC_Statewide_Composite",
    "ogi:NAIP2025_Statewide_Composite", "ogi:NAIP2025", "ogi:NAIP2025_DegreeOverviews", "ogi_raster:OK2025_CIR_Composite", "ogi_raster:Aerial2025_CIR",
    "ogi:Aerial2025_Ottawa_RGB", "ogi:OK2025_RGB", "ogi:OK2025_rgb", "ogi:aerial2025_tile_index_rgb75_4326", "ogi:okng911_counties_2019_aerial2025_rgb_mosaics",
    "ogi:ok1950-59_aerial_photos_ss_9-15-15", "ogi:OK2027_RGB", "ogi:Aerial2027_Composite",
  ];
  it("finds one statewide leaf-off layer per year, newest first, preferring Composite", () => {
    expect(pickOkMapsLayers(names).leafOff).toEqual([{ year: 2027, layer: "ogi:Aerial2027_Composite" }, { year: 2025, layer: "ogi:Aerial2025_Composite" }]);
  });
  it("finds NAIP years, preferring the statewide composite", () => {
    const naip = pickOkMapsLayers(names).naip;
    expect(naip[0]).toEqual({ year: 2025, layer: "ogi:NAIP2025_Statewide_Composite" });
    expect(naip.map((n) => n.year)).toEqual([2025, 2023, 2013, 2008]);
  });
  it("checks custom sources", () => {
    const base = { key: "c1", label: "County 2026", url: "https://example.com/wms" };
    expect(imagerySourceSchema.safeParse({ ...base, kind: "wms" }).success).toBe(false);
    expect(imagerySourceSchema.safeParse({ ...base, kind: "wms", layers: "aerial" }).success).toBe(true);
    expect(imagerySourceSchema.safeParse({ ...base, kind: "tiles" }).success).toBe(false);
    expect(imagerySourceSchema.safeParse({ ...base, kind: "tiles", url: "https://t.example.com/{z}/{x}/{y}.jpg" }).success).toBe(true);
    expect(imagerySourceSchema.safeParse({ ...base, kind: "wms", layers: "a", url: "http://example.com/wms" }).success).toBe(false);
  });
});

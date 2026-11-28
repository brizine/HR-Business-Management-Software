import { describe, expect, it } from "vitest";
import {
  MAP_CODE_COLORS, cleanOutline, formatOutlineSize, mapCodeChange, mapCodeColor, mapCodeFinder, mapCodeSchema, outlineBox, outlineHas, outlineSqM, overlapSqM, sameMapCode, trimOutline,
  type MapOutline,
} from "../src/mapCodes";
import type { LatLng } from "../src/measure";

/** A box from (lat, lng) going `h` degrees north and `w` degrees east, as one piece with no holes. */
const box = (lat: number, lng: number, h = 0.02, w = 0.02): MapOutline => [[[[lat, lng], [lat + h, lng], [lat + h, lng + w], [lat, lng + w]]]];
const ring = (lat: number, lng: number, h: number, w: number): LatLng[] => [[lat, lng], [lat + h, lng], [lat + h, lng + w], [lat, lng + w]];
const near = (a: number, b: number, within = 0.02) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * within;

describe("map code outlines", () => {
  it("knows whether a pin is inside, including pieces and holes", () => {
    const west = box(35.2, -97.5);
    expect(outlineHas(west, 35.21, -97.49)).toBe(true);
    expect(outlineHas(west, 35.21, -97.47)).toBe(false);
    expect(outlineHas(west, 35.23, -97.49)).toBe(false);
    // A hole in the middle: a pocket that isn't served.
    const holed: MapOutline = [[west[0][0], ring(35.208, -97.492, 0.004, 0.004)]];
    expect(outlineHas(holed, 35.21, -97.49)).toBe(false);
    expect(outlineHas(holed, 35.203, -97.497)).toBe(true);
    // Two separate pieces under one code.
    const two: MapOutline = [...west, ...box(35.3, -97.5)];
    expect(outlineHas(two, 35.31, -97.49)).toBe(true);
    expect(outlineHas(two, 35.26, -97.49)).toBe(false);
    expect(outlineBox(two)).toEqual([35.2, -97.5, 35.32, -97.48]);
    expect(outlineBox([])).toBeNull();
  });

  it("measures an outline less its holes", () => {
    const whole = outlineSqM(box(35.2, -97.5));
    // 0.02° north is about 2.22 km; 0.02° east at 35.2° is about 1.82 km.
    expect(near(whole, 2224 * 1819)).toBe(true);
    const holed: MapOutline = [[box(35.2, -97.5)[0][0], ring(35.205, -97.495, 0.01, 0.01)]];
    expect(near(outlineSqM(holed), whole * 0.75)).toBe(true);
    expect(formatOutlineSize(whole)).toBe("1.6 sq mi");
    expect(formatOutlineSize(4046.8564224 * 40)).toBe("40 acres");
  });

  it("trims an outline to its neighbours' edges, which keep their ground", () => {
    const west = box(35.2, -97.5);
    // Drawn over the east half of west and on past it.
    const drawn = box(35.2, -97.49, 0.02, 0.03);
    expect(overlapSqM(drawn, west)).toBeGreaterThan(1_000_000);
    const east = trimOutline(drawn, [west]);
    expect(east).toHaveLength(1);
    expect(overlapSqM(east, west)).toBeLessThan(1);
    // What's left starts exactly at west's east edge: no gap and no overlap.
    expect(Math.min(...east[0][0].map((p) => p[1]))).toBe(-97.48);
    expect(near(outlineSqM(east), outlineSqM(drawn) * (2 / 3))).toBe(true);
    // A pin on either side lands in one outline only.
    const find = mapCodeFinder([{ code: "801", outline: west }, { code: "802", outline: east }]);
    expect(find(35.21, -97.485)?.code).toBe("801");
    expect(find(35.21, -97.475)?.code).toBe("802");
    expect(find(35.21, -97.3)).toBeNull();
    expect(find(null, -97.3)).toBeNull();
  });

  it("an outline drawn right across a neighbour is left as two pieces; one drawn inside it comes to nothing", () => {
    const tall = box(35.2, -97.49, 0.04, 0.005);
    const across = trimOutline(box(35.21, -97.5, 0.01, 0.03), [tall]);
    expect(across).toHaveLength(2);
    expect(overlapSqM(across, tall)).toBeLessThan(1);
    expect(trimOutline(box(35.21, -97.489, 0.005, 0.002), [tall])).toEqual([]);
    // Nothing to trim against: just tidied.
    expect(trimOutline(box(35.2, -97.5), [])).toHaveLength(1);
  });

  it("tidies what was drawn: joins pieces that overlap, cuts holes, drops slivers, untangles a bow tie", () => {
    const joined = cleanOutline([...box(35.2, -97.5), ...box(35.21, -97.49)]);
    expect(joined).toHaveLength(1);
    expect(near(outlineSqM(joined), outlineSqM(box(35.2, -97.5)) * 1.75)).toBe(true);
    // A hole drawn as a ring comes out as a hole; a speck of a hole is dropped.
    const holed = cleanOutline([[box(35.2, -97.5)[0][0], ring(35.205, -97.495, 0.01, 0.01), ring(35.2001, -97.4999, 0.00001, 0.00001)]]);
    expect(holed[0]).toHaveLength(2);
    // A sliver of a piece is dropped; so is a whole outline that small.
    expect(cleanOutline([...box(35.2, -97.5), ...box(35.4, -97.5, 0.00005, 0.00005)])).toHaveLength(1);
    expect(cleanOutline(box(35.4, -97.5, 0.00005, 0.00005))).toEqual([]);
    expect(cleanOutline([])).toEqual([]);
    // Corners clicked in a crossing order: two triangles, not an error.
    const bow = cleanOutline([[[[35.2, -97.5], [35.22, -97.48], [35.22, -97.5], [35.2, -97.48]]]]);
    expect(bow.length).toBeGreaterThanOrEqual(1);
    expect(outlineSqM(bow)).toBeGreaterThan(0);
    // Corners are kept to six decimals and the first isn't repeated at the end.
    const c = cleanOutline([[[[35.20000049, -97.5], [35.22, -97.5], [35.22, -97.48], [35.2, -97.48], [35.20000049, -97.5]]]]);
    expect(c[0][0]).toHaveLength(4);
    expect(c[0][0].every(([lat, lng]) => Number.isInteger(Math.round(lat * 1e6)) && String(lat).length <= 10 && String(lng).length <= 11)).toBe(true);
  });

  it("checks what's sent, and compares codes whatever their capitals", () => {
    const ok = mapCodeSchema.parse({ code: " 801 ", name: "  ", outline: box(35.2, -97.5) });
    expect(ok).toMatchObject({ code: "801", name: null, color: MAP_CODE_COLORS[0] });
    const errors = (v: unknown) => { const r = mapCodeSchema.safeParse(v); return r.success ? [] : r.error.issues.map((i) => i.message); };
    expect(errors({ code: "", outline: box(35.2, -97.5) })).toEqual(["Give the map code a code, such as 801"]);
    expect(errors({ code: "801", outline: [] })).toEqual(["Draw the outline on the map first"]);
    expect(errors({ code: "801", outline: [[[[35.2, -97.5], [35.3, -97.5]]]] })).toEqual(["An outline needs at least 3 corners"]);
    expect(errors({ code: "801", color: "blue", outline: box(35.2, -97.5) })).toEqual(["Pick a colour"]);
    expect(errors({ code: "801", outline: [[[[135.2, -97.5], [35.3, -97.5], [35.3, -97.4]]]] })).toHaveLength(1);
    expect(sameMapCode("nw1", " NW1 ")).toBe(true);
    expect(sameMapCode(null, "")).toBe(true);
    expect(sameMapCode("801", "802")).toBe(false);
    // The same text always gets the same colour, whatever its capitals.
    expect(mapCodeColor("nw1")).toBe(mapCodeColor("NW1 "));
    expect(MAP_CODE_COLORS).toContain(mapCodeColor("801"));
  });

  it("says what automatic map codes would do to a property", () => {
    const at = { lat: 35.21, lng: -97.49 };
    expect(mapCodeChange({ ...at, mapCode: "801", mapCodeManual: false }, "801")).toBe("same");
    expect(mapCodeChange({ ...at, mapCode: "nw1", mapCodeManual: false }, "NW1")).toBe("same");
    expect(mapCodeChange({ ...at, mapCode: null, mapCodeManual: false }, "801")).toBe("set");
    expect(mapCodeChange({ ...at, mapCode: "805", mapCodeManual: false }, "801")).toBe("moved");
    expect(mapCodeChange({ ...at, mapCode: "805", mapCodeManual: false }, null)).toBe("cleared");
    expect(mapCodeChange({ ...at, mapCode: null, mapCodeManual: false }, null)).toBe("same");
    // Set by hand: left alone, except when automatic map codes are first turned on.
    expect(mapCodeChange({ ...at, mapCode: "805", mapCodeManual: true }, "801")).toBe("by_hand");
    expect(mapCodeChange({ ...at, mapCode: "805", mapCodeManual: true }, "801", true)).toBe("moved");
    expect(mapCodeChange({ ...at, mapCode: "801", mapCodeManual: true }, "801", true)).toBe("same");
    // No pin: it can't be placed.
    expect(mapCodeChange({ lat: null, lng: null, mapCode: "805", mapCodeManual: false }, null)).toBe("no_pin");
  });
});

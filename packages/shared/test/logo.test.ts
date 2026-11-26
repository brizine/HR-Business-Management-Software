import { describe, expect, it } from "vitest";
import { LOGO_SIZES, fitInside, isLogoSize, logoPadding, trimBox } from "../src/logo";

/** A picture of one colour, with rectangles painted on it. */
function picture(width: number, height: number, bg: [number, number, number, number], rects: { x: number; y: number; w: number; h: number; c: [number, number, number, number] }[] = []) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) px.set(bg, i * 4);
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) px.set(r.c, (y * width + x) * 4);
  return px;
}

describe("fitting a logo", () => {
  it("fits a box without changing the shape, and never enlarges", () => {
    expect(fitInside(1600, 400, LOGO_SIZES.full)).toEqual({ width: 800, height: 200 });
    expect(fitInside(1000, 1000, LOGO_SIZES.full)).toEqual({ width: 400, height: 400 });
    expect(fitInside(1600, 400, LOGO_SIZES.small)).toEqual({ width: 480, height: 120 });
    expect(fitInside(1000, 1000, LOGO_SIZES.small)).toEqual({ width: 160, height: 160 });
    expect(fitInside(200, 50, LOGO_SIZES.full)).toEqual({ width: 200, height: 50 });
    expect(fitInside(3000, 2, LOGO_SIZES.small)).toEqual({ width: 480, height: 1 });
  });

  it("knows its two sizes", () => {
    expect(isLogoSize("small")).toBe(true);
    expect(isLogoSize("full")).toBe(true);
    expect(isLogoSize("huge")).toBe(false);
    expect(isLogoSize(undefined)).toBe(false);
  });

  it("takes a see-through border off the artwork", () => {
    const px = picture(100, 60, [0, 0, 0, 0], [{ x: 20, y: 10, w: 50, h: 30, c: [20, 120, 60, 255] }]);
    const t = trimBox(px, 100, 60);
    expect(t).toMatchObject({ x: 20, y: 10, width: 50, height: 30, background: "clear", color: null });
    expect(logoPadding(t)).toBe(0);
  });

  it("keeps faint edges (soft shadows) but not pixels too faint to see", () => {
    const px = picture(40, 40, [0, 0, 0, 0], [
      { x: 10, y: 10, w: 10, h: 10, c: [0, 0, 0, 255] },
      { x: 20, y: 10, w: 4, h: 10, c: [0, 0, 0, 60] },   // a shadow: kept
      { x: 30, y: 30, w: 2, h: 2, c: [0, 0, 0, 6] },     // a ghost: not artwork
    ]);
    expect(trimBox(px, 40, 40)).toMatchObject({ x: 10, y: 10, width: 14, height: 10 });
  });

  it("takes a plain white border off, and keeps a little of it as a margin", () => {
    const px = picture(200, 100, [255, 255, 255, 255], [{ x: 40, y: 30, w: 100, h: 40, c: [10, 60, 30, 255] }]);
    const t = trimBox(px, 200, 100);
    expect(t).toMatchObject({ x: 40, y: 30, width: 100, height: 40, background: "solid", color: [255, 255, 255] });
    expect(logoPadding(t)).toBe(4);
  });

  it("doesn't mistake the speckle of a saved JPEG for artwork", () => {
    const px = picture(120, 80, [252, 253, 251, 255], [{ x: 30, y: 20, w: 60, h: 40, c: [200, 30, 30, 255] }]);
    // off-white noise in the border
    for (const [x, y] of [[3, 3], [100, 5], [7, 70], [110, 75]]) px.set([246, 250, 255, 255], (y * 120 + x) * 4);
    expect(trimBox(px, 120, 80)).toMatchObject({ x: 30, y: 20, width: 60, height: 40, background: "solid" });
  });

  it("works on a dark plain background too", () => {
    const px = picture(50, 50, [17, 24, 39, 255], [{ x: 5, y: 20, w: 40, h: 10, c: [255, 255, 255, 255] }]);
    expect(trimBox(px, 50, 50)).toMatchObject({ x: 5, y: 20, width: 40, height: 10, background: "solid", color: [17, 24, 39] });
  });

  it("leaves a picture whole when its corners don't agree (a photo, or artwork to the edges)", () => {
    const px = picture(30, 30, [255, 255, 255, 255], [{ x: 0, y: 0, w: 15, h: 30, c: [0, 0, 200, 255] }]);
    expect(trimBox(px, 30, 30)).toEqual({ x: 0, y: 0, width: 30, height: 30, background: null, color: null });
  });

  it("leaves a blank picture as it came", () => {
    expect(trimBox(picture(10, 10, [0, 0, 0, 0]), 10, 10)).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(trimBox(picture(10, 10, [255, 255, 255, 255]), 10, 10)).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("a rounded tile (see-through corners only) keeps its whole face", () => {
    const px = picture(20, 20, [30, 90, 200, 255]);
    for (const [x, y] of [[0, 0], [19, 0], [0, 19], [19, 19]]) px.set([0, 0, 0, 0], (y * 20 + x) * 4);
    expect(trimBox(px, 20, 20)).toMatchObject({ x: 0, y: 0, width: 20, height: 20, background: "clear" });
  });
});

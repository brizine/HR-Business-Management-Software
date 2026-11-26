/**
 * Fitting an uploaded company logo: taking the blank border off the artwork and working out the
 * sizes it is saved at. The pixels are handled in the browser (apps/web/lib/logo.ts), which is
 * where the picture is; the rules live here.
 */

/** The boxes a logo is made to fit. It is never enlarged to fill one. */
export const LOGO_SIZES = {
  /** Printed invoices and letterheads, and designed emails. */
  full: { width: 800, height: 400 },
  /** Screens: the top bar, the customer portal, the header of plain emails. Twice the size it is drawn at. */
  small: { width: 480, height: 160 },
} as const;
export type LogoSize = keyof typeof LOGO_SIZES;
export const isLogoSize = (v: unknown): v is LogoSize => v === "full" || v === "small";

/** The largest size of the same shape that fits the box. Never larger than it started. */
export function fitInside(width: number, height: number, box: { width: number; height: number }) {
  const s = Math.min(1, box.width / width, box.height / height);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export interface LogoTrim {
  /** Where the artwork sits in the picture. */
  x: number; y: number; width: number; height: number;
  /** What was around it: see-through, one plain colour, or neither (the picture is left whole). */
  background: "clear" | "solid" | null;
  /** The plain colour, when that is what was around it. */
  color: [number, number, number] | null;
}

const CLEAR = 12;     // alpha at or below this is see-through
const SAME = 30;      // corners this close in colour are one background
const ARTWORK = 48;   // a pixel this far from the background is artwork (JPEG speckle is not)

/**
 * Where the artwork sits in a picture (RGBA bytes, row by row), once the blank border is taken off.
 * The border is see-through, or one plain colour read from the four corners (a logo saved on
 * white, say). A picture with neither, such as a photo or artwork that runs to the edges, is left whole.
 */
export function trimBox(px: ArrayLike<number>, width: number, height: number): LogoTrim {
  const whole: LogoTrim = { x: 0, y: 0, width, height, background: null, color: null };
  if (width < 1 || height < 1 || px.length < width * height * 4) return whole;
  const at = (x: number, y: number) => { const i = (y * width + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]] as const; };
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const far = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

  let background: LogoTrim["background"] = null;
  let color: [number, number, number] | null = null;
  if (corners.some((c) => c[3] <= CLEAR)) background = "clear";
  else if (corners.every((c) => c[3] >= 240 && far(c, corners[0]) <= SAME)) {
    background = "solid";
    color = [0, 1, 2].map((k) => Math.round(corners.reduce((sum, c) => sum + c[k], 0) / 4)) as [number, number, number];
  }
  if (!background) return whole;

  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = px[i + 3];
      const art = background === "clear"
        ? a > CLEAR
        // Over a plain colour, a faint pixel counts for as much as it shows.
        : (Math.abs(px[i] - color![0]) + Math.abs(px[i + 1] - color![1]) + Math.abs(px[i + 2] - color![2])) * (a / 255) > ARTWORK;
      if (!art) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  // Nothing but background: leave it as it came.
  if (right < left || bottom < top) return whole;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, background, color };
}

/**
 * The margin kept around trimmed artwork. A logo on a plain colour keeps a little of it, so the
 * artwork doesn't touch the edge of its own box; a see-through one needs none.
 */
export function logoPadding(t: LogoTrim): number {
  return t.background === "solid" ? Math.max(2, Math.round(Math.max(t.width, t.height) * 0.04)) : 0;
}

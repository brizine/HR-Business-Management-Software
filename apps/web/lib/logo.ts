import { LOGO_SIZES, fitInside, logoPadding, trimBox, type LogoSize } from "@crewdesk/shared";

/** What became of a logo that was fitted: its two files, and what to tell the person who uploaded it. */
export interface FittedLogo {
  full: Blob; small: Blob;
  /** The size it was saved at for print, and for screens. */
  sizes: Record<LogoSize, { width: number; height: number }>;
  /** A blank border was taken off. */
  trimmed: boolean;
}

const canvasOf = (width: number, height: number) => {
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const g = c.getContext("2d");
  if (!g) throw new Error("Couldn't read that image");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  return { c, g };
};
const png = (c: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that image"))), "image/png"));

/** The picture at a smaller size, halved step by step on the way down so thin lines and small lettering stay smooth. */
function scaled(src: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width >= width * 2 && cur.height >= height * 2) {
    const half = canvasOf(Math.max(width, Math.round(cur.width / 2)), Math.max(height, Math.round(cur.height / 2)));
    half.g.drawImage(cur, 0, 0, half.c.width, half.c.height);
    cur = half.c;
  }
  if (cur.width === width && cur.height === height) return cur;
  const out = canvasOf(width, height);
  out.g.drawImage(cur, 0, 0, width, height);
  return out.c;
}

/**
 * Makes an uploaded logo the right size for where Crewdesk uses it. The blank border around the
 * artwork comes off (see-through, or the plain colour it was saved on), so the logo fills the room
 * it is given; then it is saved twice as PNG, which keeps see-through backgrounds: once for print
 * and designed emails, once smaller for screens. It is never enlarged.
 */
export async function fitLogo(file: Blob): Promise<FittedLogo> {
  const bitmap = await createImageBitmap(file);
  // Worked on at no more than 2400px a side: plenty for a logo, and quick on any computer.
  const s = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * s)), height = Math.max(1, Math.round(bitmap.height * s));
  const whole = canvasOf(width, height);
  whole.g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const t = trimBox(whole.g.getImageData(0, 0, width, height).data, width, height);
  const pad = logoPadding(t);
  const art = canvasOf(t.width + pad * 2, t.height + pad * 2);
  if (t.color) { art.g.fillStyle = `rgb(${t.color.join(",")})`; art.g.fillRect(0, 0, art.c.width, art.c.height); }
  art.g.drawImage(whole.c, t.x, t.y, t.width, t.height, pad, pad, t.width, t.height);

  const sizes = {
    full: fitInside(art.c.width, art.c.height, LOGO_SIZES.full),
    small: fitInside(art.c.width, art.c.height, LOGO_SIZES.small),
  };
  const full = scaled(art.c, sizes.full.width, sizes.full.height);
  return {
    full: await png(full),
    // The small one is made from the full one: one more step down the same ladder.
    small: await png(scaled(full, sizes.small.width, sizes.small.height)),
    sizes,
    trimmed: t.width < width || t.height < height,
  };
}

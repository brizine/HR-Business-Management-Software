import { z } from "zod";
import * as clipModule from "polygon-clipping";
/** The package's ES build exports only a default object, although its types declare named functions. */
const clip = ((clipModule as unknown as { default?: typeof clipModule }).default ?? clipModule) as typeof clipModule;
import { polygonAreaSqM, type LatLng } from "./measure";

/**
 * Map Codes (MC): the service area drawn as outlines on the map. Each outline has a code ("801"), a name
 * ("Central Norman") and a colour; a property gets the code of the outline its map pin is inside. Outlines
 * never overlap, so a pin is in one at most: an outline that's saved overlapping a neighbour is trimmed to
 * the neighbour's edge.
 *
 * An outline is a list of pieces; each piece is a list of rings (the first is its edge, the rest are holes
 * cut out of it: pockets that aren't served); each ring is a list of [lat, lng] corners.
 */
export type MapRing = LatLng[];
export type MapPiece = MapRing[];
export type MapOutline = MapPiece[];

export const MAP_CODE_MAX = 200;
const MAX_PIECES = 60;
const MAX_RINGS = 60;
const MAX_POINTS = 4000;
/** Pieces and holes smaller than this are slivers left by trimming, and are dropped (about a tenth of an acre). */
export const MAP_SLIVER_SQ_M = 400;
/** Corners are kept to six decimals: about four inches. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const ring = z.array(point).min(3, "An outline needs at least 3 corners").max(MAX_POINTS);
export const mapOutlineSchema = z.array(z.array(ring).min(1).max(MAX_RINGS)).min(1, "Draw the outline on the map first").max(MAX_PIECES);

/**
 * The colours offered for an outline (and given to a typed code that has no outline yet, by its text).
 * No greys: a grey dot on the map is a property with no code.
 */
export const MAP_CODE_COLORS = ["#2f81f7", "#2ea043", "#f0883e", "#a371f7", "#e5534b", "#1b9aaa", "#d4a72c", "#db61a2", "#1f3a93", "#7fb800", "#9c5a2b", "#b5179e"] as const;
/** The same colour every time for the same code text, so a typed code's dots match the outline later drawn for it. */
export function mapCodeColor(code: string) {
  let h = 0;
  for (const ch of code.trim().toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MAP_CODE_COLORS[h % MAP_CODE_COLORS.length];
}

export const mapCodeSchema = z.object({
  /** What goes on the property: "801". Unique in the company (whatever the capitals). */
  code: z.string().trim().min(1, "Give the map code a code, such as 801").max(20),
  name: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(80).nullable()).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour").default(MAP_CODE_COLORS[0]),
  outline: mapOutlineSchema,
});
export type MapCodeInput = z.infer<typeof mapCodeSchema>;

/** Two codes are the same code whatever their capitals or outer spaces. */
export const sameMapCode = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();

type Flat = clipModule.MultiPolygon;
// The clipper works on x, y pairs: longitude then latitude. At a service area's size the earth is flat enough
// for "is this inside that" and "take this away from that"; sizes are measured on the sphere afterwards.
const toFlat = (o: MapOutline): Flat => o.map((piece) => piece.map((r) => r.map(([lat, lng]) => [lng, lat] as clipModule.Pair)));
const fromFlat = (f: Flat): MapOutline => f.map((poly) => poly.map((r) => {
  const pts = r.map(([x, y]) => [round6(y), round6(x)] as LatLng);
  // The clipper repeats the first corner at the end; outlines here don't.
  const last = pts[pts.length - 1];
  if (pts.length > 1 && last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();
  return dropRepeats(pts);
}));
const dropRepeats = (pts: LatLng[]) => pts.filter((p, i) => { const q = pts[(i + pts.length - 1) % pts.length]; return pts.length < 2 || p[0] !== q[0] || p[1] !== q[1]; });

const ringSqM = (r: MapRing) => polygonAreaSqM(r);
const pieceSqM = (p: MapPiece) => Math.max(0, ringSqM(p[0]) - p.slice(1).reduce((s, h) => s + ringSqM(h), 0));
/** An outline's size in square meters (its pieces, less their holes). */
export const outlineSqM = (o: MapOutline) => o.reduce((s, p) => s + pieceSqM(p), 0);
export const SQ_M_PER_SQ_MI = 2_589_988.110336;
/** "3.4 sq mi", or acres for something small. */
export function formatOutlineSize(sqM: number) {
  const mi = sqM / SQ_M_PER_SQ_MI;
  return mi >= 0.1 ? `${mi.toFixed(mi >= 10 ? 0 : 1)} sq mi` : `${Math.round(sqM / 4046.8564224).toLocaleString("en-US")} acres`;
}

/** Slivers gone: pieces too small to mean anything, and holes too small to matter. */
const tidy = (o: MapOutline): MapOutline => o
  .map((piece) => [piece[0], ...piece.slice(1).filter((h) => h.length >= 3 && ringSqM(h) >= MAP_SLIVER_SQ_M)])
  .filter((piece) => piece[0].length >= 3 && pieceSqM(piece) >= MAP_SLIVER_SQ_M);

/**
 * An outline as it's kept: pieces that touch or overlap joined into one, lines that cross themselves sorted
 * out, corners rounded, slivers gone. An outline that comes to nothing is an empty list.
 */
export function cleanOutline(o: MapOutline): MapOutline {
  const flat = toFlat(o).filter((poly) => poly.length && poly[0].length >= 3);
  if (!flat.length) return [];
  // Each drawn piece on its own first (its holes cut out of it), then the pieces joined.
  const pieces = flat.map((poly) => (poly.length > 1 ? clip.difference([poly[0]], ...poly.slice(1).map((h) => [h] as clipModule.Polygon)) : clip.union([poly[0]])));
  const joined = pieces.length > 1 ? clip.union(pieces[0], ...pieces.slice(1)) : pieces[0];
  return tidy(fromFlat(joined));
}

/** `o` with everything inside `others` taken away: the neighbours keep their ground and this one is trimmed to their edges. */
export function trimOutline(o: MapOutline, others: readonly MapOutline[]): MapOutline {
  const mine = cleanOutline(o);
  const theirs = others.filter((x) => x.length);
  if (!mine.length || !theirs.length) return mine;
  return tidy(fromFlat(clip.difference(toFlat(mine), ...theirs.map(toFlat))));
}

/** How much of `a` lies inside `b`, in square meters (0 when they only touch). */
export function overlapSqM(a: MapOutline, b: MapOutline) {
  if (!a.length || !b.length) return 0;
  return outlineSqM(fromFlat(clip.intersection(toFlat(a), toFlat(b))));
}

/** Whether a corner-to-corner ring has the point inside it (even-odd rule; a point exactly on the edge may go either way). */
function ringHas(r: MapRing, lat: number, lng: number) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [yi, xi] = r[i], [yj, xj] = r[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether the pin is inside the outline: in one of its pieces and not in a hole. */
export function outlineHas(o: MapOutline, lat: number, lng: number) {
  return o.some((piece) => ringHas(piece[0], lat, lng) && !piece.slice(1).some((h) => ringHas(h, lat, lng)));
}

/** The box around an outline: [south, west, north, east]; null when it has no corners. */
export function outlineBox(o: MapOutline): [number, number, number, number] | null {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  for (const piece of o) for (const [lat, lng] of piece[0]) { any = true; s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng); }
  return any ? [s, w, n, e] : null;
}

/**
 * Finds which map code a pin is in. Made once for a set of outlines and asked many times (every property):
 * the box around each outline rules most of them out before the corners are walked.
 */
export function mapCodeFinder<T extends { code: string; outline: MapOutline }>(codes: readonly T[]) {
  const boxed = codes.map((c) => ({ c, box: outlineBox(c.outline) })).filter((x): x is { c: T; box: [number, number, number, number] } => !!x.box);
  return (lat: number | null | undefined, lng: number | null | undefined): T | null => {
    if (lat == null || lng == null) return null;
    for (const { c, box } of boxed) if (lat >= box[0] && lat <= box[2] && lng >= box[1] && lng <= box[3] && outlineHas(c.outline, lat, lng)) return c;
    return null;
  };
}

/** What automatic map codes would do to one property. */
export type MapCodeChange = "same" | "set" | "moved" | "cleared" | "by_hand" | "no_pin";
/**
 * Where a property stands against the outlines. `replaceByHand` is for the moment automatic map codes are
 * turned on: codes typed before the outlines existed are replaced like any other. After that a code set by
 * hand is left alone. A property with no pin can't be placed, so it keeps what it has.
 */
export function mapCodeChange(p: { lat: number | null; lng: number | null; mapCode: string | null; mapCodeManual: boolean }, target: string | null, replaceByHand = false): MapCodeChange {
  if (p.lat == null || p.lng == null) return "no_pin";
  if (p.mapCodeManual && !replaceByHand) return "by_hand";
  if (sameMapCode(p.mapCode, target)) return "same";
  if (!target) return "cleared";
  return p.mapCode ? "moved" : "set";
}

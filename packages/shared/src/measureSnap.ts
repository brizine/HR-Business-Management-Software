/**
 * Snapping the next point while tracing on the Measure page, in screen pixels (the map is north-up and
 * conformal, so angles on screen are true angles on the ground). In order of preference:
 *   - "corner":    onto an existing corner nearby (another measurement's, or the first point to close the shape);
 *   - "rectangle": the spot that finishes a rectangle (square to the last edge and to the first edge);
 *   - "square" / "straight" / "diagonal": at 90°, 0° or 180°, or 45° to the last edge you drew;
 *   - "axis":      for the first edge, due north–south or east–west (the section-line grid).
 * Otherwise the point goes exactly where the crosshair is.
 */
export interface Px { x: number; y: number }
export type SnapKind = "corner" | "rectangle" | "square" | "straight" | "diagonal" | "axis";

export interface SnapInput {
  /** The last point placed (null before the first one). */
  last?: Px | null;
  /** The point before it (gives the direction of the last edge). */
  prev?: Px | null;
  /** The first and second points of an area being drawn (for closing it, and for finishing a rectangle). */
  first?: Px | null;
  second?: Px | null;
  /** Corners of other measurements to snap onto. */
  vertices?: Px[];
  /** How many degrees off a direction still snaps (default 4). */
  angleTol?: number;
  /** How many pixels from a corner still snaps (default 10). */
  pxTol?: number;
}

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const dist = (a: Px, b: Px) => Math.hypot(a.x - b.x, a.y - b.y);
/** Smallest difference between two angles, in degrees (0–180). */
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Where two lines meet (each given by a point and an angle), or null if they're parallel. */
function intersect(p: Px, a: number, q: Px, b: number): Px | null {
  const d1 = { x: Math.cos(rad(a)), y: Math.sin(rad(a)) };
  const d2 = { x: Math.cos(rad(b)), y: Math.sin(rad(b)) };
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * d2.y - (q.y - p.y) * d2.x) / den;
  return { x: p.x + d1.x * t, y: p.y + d1.y * t };
}

export function snapDrawPoint(cursor: Px, input: SnapInput): { point: Px; kind: SnapKind | null; corner?: Px } {
  const angleTol = input.angleTol ?? 4;
  const pxTol = input.pxTol ?? 10;
  const { last, prev, first, second } = input;

  // 1. An existing corner nearby (closing the shape on its first point counts).
  const corners = [...(input.vertices ?? []), ...(first && last && first !== last ? [first] : [])];
  let best: Px | null = null;
  for (const v of corners) if (dist(v, cursor) <= pxTol && (!best || dist(v, cursor) < dist(best, cursor))) best = v;
  if (best) return { point: { ...best }, kind: "corner", corner: best };

  if (!last || dist(last, cursor) < 8) return { point: cursor, kind: null };

  // 2. Directions to try from the last point: relative to the last edge, or the compass axes for the first edge.
  const ref = prev ? deg(Math.atan2(last.y - prev.y, last.x - prev.x)) : 0;
  const at = deg(Math.atan2(cursor.y - last.y, cursor.x - last.x));
  const steps = prev ? [0, 45, 90, 135, 180, 225, 270, 315] : [0, 90, 180, 270];
  let snapAngle: number | null = null;
  let kind: SnapKind | null = null;
  for (const s of steps) {
    const a = ref + s;
    if (angleDiff(at, a) <= angleTol && (snapAngle == null || angleDiff(at, a) < angleDiff(at, snapAngle))) {
      snapAngle = a;
      kind = !prev ? "axis" : s % 90 !== 0 ? "diagonal" : s === 90 || s === 270 ? "square" : "straight";
    }
  }

  // 3. Finishing a rectangle: square to the last edge and square to the first edge, from the first point.
  if (prev && first && second && first !== prev && kind === "square" && snapAngle != null) {
    const firstEdge = deg(Math.atan2(second.y - first.y, second.x - first.x));
    const corner = intersect(last, snapAngle, first, firstEdge + 90);
    if (corner && dist(corner, cursor) <= pxTol * 1.5) return { point: corner, kind: "rectangle" };
  }

  if (snapAngle == null) return { point: cursor, kind: null };
  // Keep the distance the crosshair is from the last point, along the snapped direction.
  const r = dist(last, cursor) * Math.cos(rad(angleDiff(at, snapAngle)));
  return { point: { x: last.x + r * Math.cos(rad(snapAngle)), y: last.y + r * Math.sin(rad(snapAngle)) }, kind };
}

/** A short label for what the point snapped to. */
export const SNAP_LABELS: Record<SnapKind, string> = {
  corner: "on corner", rectangle: "square corner", square: "90°", straight: "straight", diagonal: "45°", axis: "N–S / E–W",
};

/** Compass bearing from one map point to another, 0–360° clockwise from north. */
export function bearingDeg(from: [number, number], to: [number, number]) {
  const dLng = rad(to[1] - from[1]) * Math.cos(rad((from[0] + to[0]) / 2));
  const dLat = rad(to[0] - from[0]);
  return (deg(Math.atan2(dLng, dLat)) + 360) % 360;
}

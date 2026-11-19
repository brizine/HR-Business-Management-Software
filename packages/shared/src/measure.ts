import { z } from "zod";
import { distanceMeters } from "./location";

/**
 * Property measurements (the Measure page): turf areas traced on aerial photos, cut-outs for
 * beds, driveways and the house, and lines (e.g. a perimeter barrier). Points are [lat, lng].
 */
export const MEASURE_KINDS = ["turf", "cut", "line"] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];
export const MEASURE_KIND_LABELS: Record<MeasureKind, string> = { turf: "Area", cut: "Cut-out", line: "Line" };

export type LatLng = [number, number];

export const SQ_FT_PER_SQ_M = 10.763910417;
export const SQ_FT_PER_ACRE = 43_560;
export const FT_PER_M = 3.280839895;

const point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);

export const measureShapeSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    kind: z.enum(MEASURE_KINDS),
    label: z.string().trim().max(80).optional().nullable(),
    points: z.array(point).min(2).max(1000),
  })
  .refine((s) => s.kind === "line" || s.points.length >= 3, { message: "An area needs at least 3 points", path: ["points"] });
export type MeasureShape = z.infer<typeof measureShapeSchema>;

export const measurementSchema = z.object({
  name: z.string().trim().min(1, "Give the measurement a name (customer or property)").max(120),
  address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  zoom: z.number().int().min(1).max(23),
  imagery: z.string().trim().max(160).optional().nullable(),
  shapes: z.array(measureShapeSchema).max(200),
});
export type MeasurementInput = z.infer<typeof measurementSchema>;

const EARTH_RADIUS_M = 6_378_137;
const rad = (d: number) => (d * Math.PI) / 180;

/** Area of a polygon on the earth in square meters (spherical formula, as in Turf and Leaflet; within a fraction of a percent for property-sized shapes). */
export function polygonAreaSqM(points: readonly LatLng[]) {
  const n = points.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lat1, lng1] = points[i];
    const [lat2, lng2] = points[(i + 1) % n];
    total += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Length of a path in meters; `closed` adds the side back to the first point (a polygon's perimeter). */
export function pathLengthM(points: readonly LatLng[], closed = false) {
  let total = 0;
  const pts = closed && points.length > 2 ? [...points, points[0]] : points;
  for (let i = 1; i < pts.length; i++) total += distanceMeters({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] });
  return total;
}

export const shapeSqFt = (s: Pick<MeasureShape, "kind" | "points">) => (s.kind === "line" ? 0 : polygonAreaSqM(s.points) * SQ_FT_PER_SQ_M);
export const shapeFeet = (s: Pick<MeasureShape, "kind" | "points">) => pathLengthM(s.points, s.kind !== "line") * FT_PER_M;

/** Totals for a measurement: areas minus cut-outs (never below zero), and total line length. */
export function measureTotals(shapes: readonly Pick<MeasureShape, "kind" | "points">[]) {
  let turf = 0, cut = 0, lineFt = 0;
  for (const s of shapes) {
    if (s.kind === "turf") turf += shapeSqFt(s);
    else if (s.kind === "cut") cut += shapeSqFt(s);
    else lineFt += shapeFeet(s);
  }
  const netSqFt = Math.max(0, turf - cut);
  return { turfSqFt: turf, cutSqFt: cut, netSqFt, acres: netSqFt / SQ_FT_PER_ACRE, lineFt };
}

export const formatSqFt = (sqFt: number) => `${Math.round(sqFt).toLocaleString("en-US")} ft²`;
export const formatAcres = (sqFt: number) => `${(sqFt / SQ_FT_PER_ACRE).toFixed(sqFt >= SQ_FT_PER_ACRE * 10 ? 1 : 2)} acres`;
export const formatFeet = (ft: number) => (ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft).toLocaleString("en-US")} ft`);

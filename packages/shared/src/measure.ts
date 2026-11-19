import { z } from "zod";
import * as clipModule from "polygon-clipping";
/** The package's ES build exports only a default object, although its types declare named functions. */
const clip = ((clipModule as unknown as { default?: typeof clipModule }).default ?? clipModule) as typeof clipModule;
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

type Flat = clipModule.MultiPolygon;

/** A flat map in meters around `origin` (accurate to a tiny fraction of a percent across a property). */
function projector(origin: LatLng) {
  const k = Math.cos(rad(origin[0]));
  const m = (EARTH_RADIUS_M * Math.PI) / 180;
  return {
    to: ([lat, lng]: LatLng): clipModule.Pair => [(lng - origin[1]) * m * k, (lat - origin[0]) * m],
    from: ([x, y]: clipModule.Pair): LatLng => [origin[0] + y / m, origin[1] + x / (m * k)],
  };
}

function flatArea(mp: Flat) {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      let a = 0;
      for (let j = 0; j < ring.length; j++) {
        const [x1, y1] = ring[j];
        const [x2, y2] = ring[(j + 1) % ring.length];
        a += x1 * y2 - x2 * y1;
      }
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return Math.max(0, total);
}

export interface MeasureResult {
  /** Areas (overlaps counted once). */
  turfSqFt: number;
  /** What the cut-outs actually removed from the areas. */
  cutSqFt: number;
  /** Areas minus cut-outs. */
  netSqFt: number;
  acres: number;
  lineFt: number;
  /**
   * Per shape: an area's square feet after its cut-outs, a cut-out's square feet that fall inside an area
   * (what it removes), a line's feet.
   */
  byId: Record<string, number>;
  /** Each area as drawn after its cut-outs, as [outer ring, holes…] polygons in lat/lng (for the map). */
  shapesWithHoles: Record<string, LatLng[][][]>;
}

/**
 * Totals for a measurement. A cut-out takes away only the part of it that lies inside an area, and
 * overlapping areas (or overlapping cut-outs) are counted once.
 */
export function measureShapes(shapes: readonly Pick<MeasureShape, "id" | "kind" | "points">[]): MeasureResult {
  const byId: Record<string, number> = {};
  const shapesWithHoles: Record<string, LatLng[][][]> = {};
  let lineFt = 0;
  for (const s of shapes) if (s.kind === "line") { byId[s.id] = shapeFeet(s); lineFt += byId[s.id]; }
  const turfs = shapes.filter((s) => s.kind === "turf" && s.points.length >= 3);
  const cuts = shapes.filter((s) => s.kind === "cut" && s.points.length >= 3);
  const result = (turfSqFt: number, netSqFt: number): MeasureResult =>
    ({ turfSqFt, cutSqFt: Math.max(0, turfSqFt - netSqFt), netSqFt, acres: netSqFt / SQ_FT_PER_ACRE, lineFt, byId, shapesWithHoles });
  if (!turfs.length) {
    for (const c of cuts) byId[c.id] = 0;
    return result(0, 0);
  }
  const proj = projector(turfs[0].points[0]);
  const flat = (s: Pick<MeasureShape, "points">): clipModule.Polygon => [s.points.map(proj.to)];
  const sqFt = (mp: Flat) => flatArea(mp) * SQ_FT_PER_SQ_M;
  try {
    const turfUnion = clip.union(flat(turfs[0]), ...turfs.slice(1).map(flat));
    const cutUnion: Flat = cuts.length ? clip.union(flat(cuts[0]), ...cuts.slice(1).map(flat)) : [];
    const net = cutUnion.length ? clip.difference(turfUnion, cutUnion) : turfUnion;
    for (const t of turfs) {
      const left = cutUnion.length ? clip.difference(flat(t), cutUnion) : [flat(t)];
      byId[t.id] = sqFt(left);
      shapesWithHoles[t.id] = left.map((poly) => poly.map((ring) => ring.map(proj.from)));
    }
    for (const c of cuts) byId[c.id] = sqFt(clip.intersection(flat(c), turfUnion));
    return result(sqFt(turfUnion), sqFt(net));
  } catch {
    // Badly tangled shapes can defeat the clipper: fall back to simple sums.
    let turf = 0, cut = 0;
    for (const t of turfs) { byId[t.id] = shapeSqFt(t); turf += byId[t.id]; shapesWithHoles[t.id] = [[[...t.points]]]; }
    for (const c of cuts) { byId[c.id] = shapeSqFt(c); cut += byId[c.id]; }
    return result(turf, Math.max(0, turf - cut));
  }
}

/** Totals only (see measureShapes). */
export function measureTotals(shapes: readonly Pick<MeasureShape, "kind" | "points">[]) {
  const { turfSqFt, cutSqFt, netSqFt, acres, lineFt } = measureShapes(shapes.map((s, i) => ({ ...s, id: `s${i}` })));
  return { turfSqFt, cutSqFt, netSqFt, acres, lineFt };
}

export const formatSqFt = (sqFt: number) => `${Math.round(sqFt).toLocaleString("en-US")} ft²`;
export const formatAcres = (sqFt: number) => `${(sqFt / SQ_FT_PER_ACRE).toFixed(sqFt >= SQ_FT_PER_ACRE * 10 ? 1 : 2)} acres`;
export const formatFeet = (ft: number) => (ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${Math.round(ft).toLocaleString("en-US")} ft`);

/* ---------- Aerial photo sources ---------- */

/**
 * A photo layer for the Measure page: found automatically on OKMaps (the State of Oklahoma's map server),
 * or added by an admin (another WMS server, or a tile URL with {z}/{x}/{y}).
 */
export const imagerySourceSchema = z
  .object({
    key: z.string().trim().min(1).max(60),
    kind: z.enum(["wms", "tiles"]),
    label: z.string().trim().min(1, "Give the photo a name").max(80),
    detail: z.string().trim().max(120).default(""),
    url: z.string().trim().url("Enter the full web address, starting with https://").max(500).refine((u) => u.startsWith("https://"), "The address must start with https://"),
    layers: z.string().trim().max(200).optional().nullable(),
    attribution: z.string().trim().max(300).optional().nullable(),
    leafOff: z.boolean().default(false),
    maxNativeZoom: z.number().int().min(10).max(23).optional().nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "wms" && !s.layers) ctx.addIssue({ code: "custom", path: ["layers"], message: "Enter the WMS layer name" });
    if (s.kind === "tiles" && !(s.url.includes("{z}") && s.url.includes("{x}") && s.url.includes("{y}"))) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "A tile address needs {z}, {x} and {y} in it" });
    }
  });
export type ImagerySourceInput = z.infer<typeof imagerySourceSchema>;
export type ImagerySource = ImagerySourceInput & {
  origin: "okmaps" | "custom";
  year?: number;
  /** True for a few weeks after a newly released photo first shows up. */
  isNew?: boolean;
};

export const customImagerySchema = z.object({ custom: z.array(imagerySourceSchema).max(20) });

/** Stored per company: admins' own photo sources, and when each automatically found photo first appeared. */
export interface MeasureImagerySettings {
  custom?: ImagerySourceInput[];
  seen?: Record<string, string>;
}

/**
 * Picks the statewide photo layers out of OKMaps' layer names, one per year, newest first:
 * leaf-off aerials ("Aerial2025_Composite", "OK2026_RGB", …) and USDA NAIP ("NAIP2025_Statewide_Composite", …).
 * Color-infrared, tile indexes, overviews, single-county and test layers are skipped.
 */
export function pickOkMapsLayers(names: readonly string[]) {
  const skip = /cir|index|overview|_hl|test|mosaic|doqq|tile/i;
  const best = (re: RegExp, rank: (name: string) => number) => {
    const byYear = new Map<number, string>();
    for (const name of names) {
      if (skip.test(name)) continue;
      const m = name.match(re);
      if (!m) continue;
      const year = Number(m[1]);
      const cur = byYear.get(year);
      if (!cur || rank(name) > rank(cur)) byYear.set(year, name);
    }
    return [...byYear].map(([year, layer]) => ({ year, layer })).sort((a, b) => b.year - a.year);
  };
  // Prefer the "Composite" (all zoom levels) layer, then a plain RGB one.
  const rank = (n: string) => (/composite$/i.test(n) ? 2 : /rgb$/i.test(n) ? 1 : 0);
  return {
    leafOff: best(/^ogi(?:_raster)?:(?:Aerial|OK)_?(20\d\d)(?:_RGB)?(?:_Composite)?$/i, rank),
    naip: best(/^ogi(?:_raster)?:NAIP_?(20\d\d)(?:_NC)?(?:_Statewide)?(?:_Composite)?$/i, (n) => (/statewide_composite$/i.test(n) ? 3 : rank(n))),
  };
}

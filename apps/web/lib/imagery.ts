/**
 * Aerial photo sources for the Measure page.
 *
 * - Oklahoma statewide leaf-off photos (OKMaps / Oklahoma Office of Geographic Information): 6-inch, flown
 *   Feb to mid-March 2025 with the trees bare; public, served as WMS.
 * - Esri World Imagery Wayback: about 200 archived versions of Esri's world imagery since 2014. Most versions
 *   reuse the same photo at a given spot, so `findWaybackVersions` asks Esri which versions actually differ
 *   there and when each photo was taken. Use with attribution; Esri's terms apply.
 * - USDA NAIP 2025 (OKMaps): flown in summer with the leaves on; useful for comparison only.
 */

export type ImageryLayer =
  | { key: string; kind: "wms"; label: string; detail: string; url: string; layers: string; attribution: string; leafOff?: boolean }
  | { key: string; kind: "tiles"; label: string; detail: string; url: string; attribution: string; maxNativeZoom: number; leafOff?: boolean };

const OKMAPS_WMS = "https://okmaps.org/geoserver/ogi/wms";
const OKMAPS_ATTR = 'Aerial photos: <a href="https://okmaps.org/" target="_blank" rel="noreferrer">OKMaps</a> (Oklahoma Office of Geographic Information)';
const ESRI_ATTR = "Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community (World Imagery Wayback)";
const WAYBACK = "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery";

export const OK_LEAF_OFF: ImageryLayer = {
  key: "ok2025", kind: "wms", label: "Oklahoma 2025 leaf-off", detail: "Feb–Mar 2025 · 6-inch · Oklahoma only",
  url: OKMAPS_WMS, layers: "ogi:Aerial2025_Composite", attribution: OKMAPS_ATTR, leafOff: true,
};
export const OK_NAIP_2025: ImageryLayer = {
  key: "naip2025", kind: "wms", label: "USDA NAIP 2025", detail: "Summer 2025 · leaves on · 2-foot",
  url: OKMAPS_WMS, layers: "ogi:NAIP2025_Statewide_Composite", attribution: OKMAPS_ATTR,
};
export const STREET_MAP: ImageryLayer = {
  key: "streets", kind: "tiles", label: "Street map", detail: "OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors", maxNativeZoom: 19,
};

export interface WaybackRelease { num: number; id: string; releaseDate: string; metaName: string }

let releasesPromise: Promise<WaybackRelease[]> | null = null;

/** Every Wayback version, newest first, read from Esri's WMTS capabilities. */
export function waybackReleases(): Promise<WaybackRelease[]> {
  releasesPromise ??= fetch(`${WAYBACK}/MapServer/WMTS/1.0.0/WMTSCapabilities.xml`)
    .then((r) => { if (!r.ok) throw new Error("Couldn't load Esri's imagery list"); return r.text(); })
    .then((xml) => {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const out: WaybackRelease[] = [];
      for (const layer of Array.from(doc.getElementsByTagName("Layer"))) {
        const title = layer.getElementsByTagName("ows:Title")[0]?.textContent ?? "";
        const id = layer.getElementsByTagName("ows:Identifier")[0]?.textContent ?? "";
        const template = layer.getElementsByTagName("ResourceURL")[0]?.getAttribute("template") ?? "";
        const num = Number(template.match(/\/tile\/(\d+)\//)?.[1]);
        const date = title.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
        const m = id.match(/^WB_(\d{4})_R(\d+)$/i);
        if (num && date && m) out.push({ num, id, releaseDate: date, metaName: `${m[1]}_r${m[2].padStart(2, "0")}` });
      }
      return out.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
    })
    .catch((e) => { releasesPromise = null; throw e; });
  return releasesPromise;
}

export const waybackTileUrl = (num: number) => `${WAYBACK}/WMTS/1.0.0/default028mm/MapServer/tile/${num}/{z}/{y}/{x}`;

export interface WaybackVersion {
  release: WaybackRelease;
  /** When the photo at this spot was taken (YYYY-MM-DD), if Esri says. */
  captured: string | null;
  /** Photo detail in meters per pixel, if Esri says. */
  resolution: number | null;
  provider: string | null;
}

function tileFor(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}

async function captureInfo(release: WaybackRelease, lat: number, lng: number, z: number) {
  const layerId = Math.min(13, Math.max(0, 23 - z));
  const q = new URLSearchParams({
    geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    outFields: "SRC_DATE2,SRC_RES,NICE_DESC", returnGeometry: "false", f: "json",
  });
  try {
    const res = await fetch(`https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${release.metaName}/MapServer/${layerId}/query?${q}`);
    const a = (await res.json())?.features?.[0]?.attributes;
    if (!a) return { captured: null, resolution: null, provider: null };
    return {
      captured: a.SRC_DATE2 ? new Date(a.SRC_DATE2).toISOString().slice(0, 10) : null,
      resolution: typeof a.SRC_RES === "number" ? a.SRC_RES : null,
      provider: typeof a.NICE_DESC === "string" && a.NICE_DESC.trim() ? a.NICE_DESC.trim() : null,
    };
  } catch {
    return { captured: null, resolution: null, provider: null };
  }
}

/**
 * The Wayback versions whose photo at this spot differs from the next newer one, newest first, with the
 * date each photo was taken. Follows Esri's "tilemap" pointers: each answer names the version whose tile is
 * actually shown, so we can skip straight past every version that reuses it.
 */
export async function findWaybackVersions(
  lat: number, lng: number, zoom: number, signal?: AbortSignal, onProgress?: (soFar: WaybackVersion[]) => void,
): Promise<WaybackVersion[]> {
  const releases = await waybackReleases();
  const z = Math.min(19, Math.max(12, Math.round(zoom)));
  const { x, y } = tileFor(lat, lng, z);
  const index = new Map(releases.map((r, i) => [r.num, i]));
  const versions: WaybackVersion[] = [];
  const pending: Promise<void>[] = [];
  const report = () => onProgress?.(distinct(versions));
  let i = 0;
  while (i < releases.length && versions.length < 40) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const r = releases[i];
    const res = await fetch(`${WAYBACK}/MapServer/tilemap/${r.num}/${z}/${y}/${x}`, { signal });
    const body = await res.json().catch(() => null);
    if (!body?.data?.[0]) { i++; continue; }
    const actual: number = body.select?.[0] ?? r.num;
    const at = index.get(actual) ?? i;
    if (!versions.some((v) => v.release.num === actual)) {
      const v: WaybackVersion = { release: releases[at], captured: null, resolution: null, provider: null };
      versions.push(v);
      pending.push(captureInfo(v.release, lat, lng, z).then((info) => { Object.assign(v, info); if (!signal?.aborted) report(); }));
      report();
    }
    i = Math.max(at, i) + 1;
  }
  await Promise.all(pending);
  return distinct(versions);
}

/** Different versions can carry the same photo (same capture date): keep the newest of each. */
function distinct(versions: WaybackVersion[]) {
  const seen = new Set<string>();
  return versions
    .filter((v) => {
      if (!v.captured) return true;
      if (seen.has(v.captured)) return false;
      seen.add(v.captured);
      return true;
    })
    .map((v) => ({ ...v }));
}

/** December to March: deciduous trees are usually bare in Oklahoma. */
export const isLeafOffDate = (iso: string | null) => !!iso && [12, 1, 2, 3].includes(Number(iso.slice(5, 7)));

export const formatCaptured = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function waybackLayer(v: WaybackVersion): ImageryLayer {
  const when = v.captured ? formatCaptured(v.captured) : `version of ${formatCaptured(v.release.releaseDate)}`;
  const res = v.resolution ? ` · ${Math.round(v.resolution * 39.37)}-inch` : "";
  return {
    key: `wb-${v.release.num}`, kind: "tiles", label: `Esri photo ${when}`,
    detail: `${v.provider ? `${v.provider}` : "Esri"}${res}${isLeafOffDate(v.captured) ? " · winter" : ""}`,
    url: waybackTileUrl(v.release.num), attribution: ESRI_ATTR, maxNativeZoom: 19, leafOff: isLeafOffDate(v.captured),
  };
}

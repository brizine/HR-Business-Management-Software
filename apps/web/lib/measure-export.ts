"use client";
import type * as Leaflet from "leaflet";
import {
  MEASURE_KIND_LABELS, MEASURE_ZONE_LABELS, formatAcres, formatFeet, formatSqFt,
  type LatLng, type MeasureResult, type MeasureShape,
} from "@crewdesk/shared";
import { API_URL } from "./api";
import type { ImageryLayer } from "./imagery";
import { PIN_SVG, shapeColor } from "@/components/measure-map";

/**
 * Printing and exporting a measurement from the Measure page: the aerial photo as shown on screen with the
 * outlines and sizes drawn on it (PNG, JPEG, a PDF report, or printed), or just the outlines (KML for
 * Google Earth, GeoJSON for GIS tools).
 */
export interface ExportInfo {
  name: string;
  address: string;
  notes: string;
  imagery: ImageryLayer;
  shapes: MeasureShape[];
  result: MeasureResult;
  /** The pin on the house. */
  pin?: { lat: number; lng: number } | null;
}

const SCALE = 2;

/* ---------- Drawing the map ---------- */

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Paints the photo behind the current view: WMS photos come through our server; tile photos straight from their server. */
async function paintPhoto(ctx: CanvasRenderingContext2D, map: Leaflet.Map, L: typeof Leaflet, layer: ImageryLayer, w: number, h: number) {
  const size = map.getSize();
  if (layer.kind === "wms") {
    const b = map.getBounds();
    const sw = L.CRS.EPSG3857.project(b.getSouthWest());
    const ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const q = new URLSearchParams({ bbox: [sw.x, sw.y, ne.x, ne.y].join(","), width: String(Math.min(4096, w)), height: String(Math.min(4096, h)) });
    const res = await fetch(`${API_URL}/measurements/imagery/${encodeURIComponent(layer.key)}/wms?${q}`, { credentials: "include", headers: { "x-crewdesk-client": "web" } });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't get the photo for exporting. Try again.");
    const bitmap = await createImageBitmap(await res.blob());
    ctx.drawImage(bitmap, 0, 0, w, h);
    return;
  }
  // Tiles: fetch a level sharper than the screen (up to the photo's best detail) to fill the larger canvas.
  const zoom = map.getZoom();
  const zt = Math.min(Math.round(zoom + Math.log2(SCALE)), layer.maxNativeZoom);
  const toZt = 2 ** (zt - zoom);
  const k = SCALE / toZt; // canvas pixels per tile pixel
  const tl = map.getPixelBounds().min!;
  const x0 = tl.x * toZt, y0 = tl.y * toZt;
  const x1 = x0 + size.x * toZt, y1 = y0 + size.y * toZt;
  const jobs: Promise<boolean>[] = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) {
      const url = layer.url.replace("{z}", String(zt)).replace("{x}", String(tx)).replace("{y}", String(ty));
      jobs.push(loadImage(url).then((img) => {
        if (!img) return false;
        ctx.drawImage(img, (tx * 256 - x0) * k, (ty * 256 - y0) * k, 256 * k, 256 * k);
        return true;
      }));
    }
  }
  const ok = await Promise.all(jobs);
  if (!ok.some(Boolean)) throw new Error("This photo can't be exported (its server doesn't allow it). Switch to another photo and try again.");
}

function sizeText(s: MeasureShape, result: MeasureResult) {
  const n = result.byId[s.id] ?? 0;
  return s.kind === "line" ? formatFeet(n) : `${s.kind === "cut" ? "−" : ""}${formatSqFt(n)}`;
}

/** The middle of a polygon (area-weighted), in canvas pixels. */
function centroid(pts: [number, number][]) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-6) return pts.reduce(([sx, sy], [x, y]) => [sx + x / pts.length, sy + y / pts.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)] as [number, number];
}

function paintShapes(ctx: CanvasRenderingContext2D, map: Leaflet.Map, shapes: MeasureShape[], result: MeasureResult) {
  const px = (ll: LatLng): [number, number] => { const p = map.latLngToContainerPoint(ll); return [p.x * SCALE, p.y * SCALE]; };
  const ring = (pts: LatLng[]) => pts.forEach((ll, i) => { const [x, y] = px(ll); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  const order = [...shapes].sort((a, b) => ["turf", "cut", "line"].indexOf(a.kind) - ["turf", "cut", "line"].indexOf(b.kind));
  for (const s of order) {
    const color = shapeColor(s.kind, s.zone);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (s.kind === "line" ? 2.5 : 2) * SCALE;
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (s.kind === "line") {
      ring(s.points);
      ctx.stroke();
    } else {
      const polys = s.kind === "turf" && result.shapesWithHoles[s.id]?.length ? result.shapesWithHoles[s.id] : [[s.points]];
      for (const poly of polys) for (const r of poly) { ring(r); ctx.closePath(); }
      ctx.globalAlpha = s.kind === "cut" ? 0.1 : 0.28;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
      if (s.kind === "cut") ctx.setLineDash([5 * SCALE, 4 * SCALE]);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Size labels on top.
  ctx.font = `600 ${12 * SCALE}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const s of order) {
    const pts = s.points.map(px);
    const [x, y] = s.kind === "line" ? pts[Math.floor(pts.length / 2)] : centroid(pts);
    const text = `${s.label ? `${s.label}: ` : ""}${sizeText(s, result)}`;
    const w = ctx.measureText(text).width + 12 * SCALE, h = 18 * SCALE;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 * SCALE);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x, y + 0.5 * SCALE);
  }
}

/** The house pin, drawn from the same picture as on screen (tip on the spot). */
async function paintPin(ctx: CanvasRenderingContext2D, map: Leaflet.Map, pin: { lat: number; lng: number }) {
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(PIN_SVG)}`);
  if (!img) return;
  const p = map.latLngToContainerPoint([pin.lat, pin.lng]);
  const w = 26 * SCALE, h = 36 * SCALE;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 3 * SCALE;
  ctx.shadowOffsetY = 2 * SCALE;
  ctx.drawImage(img, p.x * SCALE - w / 2, p.y * SCALE - h + SCALE, w, h);
  ctx.restore();
}

/** A scale bar in feet, bottom left. */
function paintScale(ctx: CanvasRenderingContext2D, map: Leaflet.Map, h: number) {
  const size = map.getSize();
  const y = size.y / 2;
  const a = map.containerPointToLatLng([0, y]), b = map.containerPointToLatLng([100, y]);
  const feetPer100px = a.distanceTo(b) * 3.28084;
  const nice = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((f) => (f / feetPer100px) * 100 >= 60) ?? 5000;
  const len = (nice / feetPer100px) * 100 * SCALE;
  const x0 = 12 * SCALE, y0 = h - 14 * SCALE;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(x0 - 6 * SCALE, y0 - 18 * SCALE, len + 12 * SCALE, 26 * SCALE);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 2 * SCALE;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - 6 * SCALE); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0); ctx.lineTo(x0 + len, y0 - 6 * SCALE);
  ctx.stroke();
  ctx.fillStyle = "#111";
  ctx.font = `600 ${11 * SCALE}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(`${nice} ft`, x0 + len / 2, y0 - 8 * SCALE);
  ctx.restore();
}

/** The current map view (photo, outlines, sizes and a scale bar) at twice the screen's detail. */
export async function renderMap(map: Leaflet.Map, L: typeof Leaflet, info: ExportInfo) {
  const size = map.getSize();
  const w = size.x * SCALE, h = size.y * SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d0d4d9";
  ctx.fillRect(0, 0, w, h);
  await paintPhoto(ctx, map, L, info.imagery, w, h);
  paintShapes(ctx, map, info.shapes, info.result);
  if (info.pin) await paintPin(ctx, map, info.pin);
  paintScale(ctx, map, h);
  return canvas;
}

/* ---------- Report text ---------- */

const plain = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
const today = () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

function totalsRows(r: MeasureResult): [string, string][] {
  const rows: [string, string][] = [["Total Area", `${formatSqFt(r.netSqFt)} (${formatAcres(r.netSqFt)})`], ["Total Front Area", formatSqFt(r.frontSqFt)], ["Total Back Area", formatSqFt(r.backSqFt)]];
  if (r.cutSqFt > 0) rows.push(["Cut-outs", `−${formatSqFt(r.cutSqFt)}`]);
  if (r.lineFt > 0) rows.push(["Lines", formatFeet(r.lineFt)]);
  return rows;
}

function shapeRows(info: ExportInfo): [string, string, string][] {
  return info.shapes.map((s) => {
    const type = s.kind === "turf" && s.zone ? MEASURE_ZONE_LABELS[s.zone] : MEASURE_KIND_LABELS[s.kind];
    return [s.label || type, type, sizeText(s, info.result)];
  });
}

const photoLine = (info: ExportInfo) => `Photo: ${info.imagery.label}${info.imagery.detail ? ` (${info.imagery.detail})` : ""}. ${plain(info.imagery.attribution)}`;

/** The photo with a band underneath naming the property, the totals and the photo (for PNG and JPEG). Long lines wrap. */
function withCaption(map: HTMLCanvasElement, info: ExportInfo) {
  const pad = 14 * SCALE, gap = 4 * SCALE;
  const parts: { text: string; bold?: boolean }[] = [
    // The address first (then the name, if one was given).
    { text: [info.address, info.name].filter(Boolean).join(" · ") || "Property measurement", bold: true },
    { text: totalsRows(info.result).map(([k, v]) => `${k}: ${v}`).join("   ·   ") },
    { text: `${photoLine(info)}   Measured ${today()}.` },
  ];
  const font = (bold?: boolean) => `${bold ? 700 : 400} ${(bold ? 14 : 12) * SCALE}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const lineHeight = (bold?: boolean) => (bold ? 19 : 16) * SCALE;
  const measure = document.createElement("canvas").getContext("2d")!;
  const maxW = map.width - pad * 2;
  const lines: { text: string; bold?: boolean }[] = [];
  for (const part of parts) {
    measure.font = font(part.bold);
    let cur = "";
    for (const word of part.text.split(/(\s+)/)) {
      if (cur && measure.measureText(cur + word).width > maxW) { lines.push({ text: cur.trimEnd(), bold: part.bold }); cur = word.trimStart(); }
      else cur += word;
    }
    if (cur.trim()) lines.push({ text: cur.trim(), bold: part.bold });
  }
  const textH = lines.reduce((h, l) => h + lineHeight(l.bold), 0) + gap * (parts.length - 1);
  const canvas = document.createElement("canvas");
  canvas.width = map.width;
  canvas.height = map.height + pad * 2 + textH;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(map, 0, 0);
  ctx.textBaseline = "top";
  let y = map.height + pad, prevBold: boolean | undefined = true;
  for (const l of lines) {
    if (l.bold !== prevBold) y += gap;
    prevBold = l.bold;
    ctx.fillStyle = l.bold ? "#111" : "#444";
    ctx.font = font(l.bold);
    ctx.fillText(l.text, pad, y);
    y += lineHeight(l.bold);
  }
  return canvas;
}

/* ---------- Saving files ---------- */

export function fileBase(name: string) {
  const base = name.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60);
  return `${base || "measurement"}-${new Date().toISOString().slice(0, 10)}`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image"))), type, quality));

export async function exportImage(map: Leaflet.Map, L: typeof Leaflet, info: ExportInfo, format: "png" | "jpeg") {
  const canvas = withCaption(await renderMap(map, L, info), info);
  download(await toBlob(canvas, `image/${format}`, 0.92), `${fileBase(info.name || info.address)}.${format === "jpeg" ? "jpg" : "png"}`);
}

/** PDF fonts only cover basic Latin characters. */
const pdfText = (s: string) => s.replace(/−/g, "-").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, "...");

export async function exportPdf(map: Leaflet.Map, L: typeof Leaflet, info: ExportInfo) {
  const [{ jsPDF }, canvas] = await Promise.all([import("jspdf"), renderMap(map, L, info)]);
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), m = 40;
  let y = m;
  doc.setFont("helvetica", "bold").setFontSize(18).text(pdfText(info.name || info.address || "Property Measurement"), m, y + 8);
  y += 26;
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(90);
  doc.text(pdfText([info.name ? info.address : "", `Measured ${today()}`].filter(Boolean).join("  ·  ")), m, y);
  y += 14;
  // Photo: as wide as the page, up to about half its height.
  const maxW = W - m * 2, maxH = H * 0.5;
  const ratio = Math.min(maxW / canvas.width, maxH / canvas.height);
  const iw = canvas.width * ratio, ih = canvas.height * ratio;
  doc.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", m + (maxW - iw) / 2, y, iw, ih);
  y += ih + 22;
  doc.setTextColor(20).setFontSize(12).setFont("helvetica", "bold").text("Totals", m, y);
  y += 16;
  doc.setFontSize(11);
  for (const [k, v] of totalsRows(info.result)) {
    doc.setFont("helvetica", k === "Total Area" ? "bold" : "normal").text(pdfText(k), m, y).text(pdfText(v), m + 170, y);
    y += 15;
  }
  if (info.shapes.length) {
    y += 8;
    doc.setFont("helvetica", "bold").setFontSize(12).text("Measurements", m, y);
    y += 16;
    doc.setFontSize(10);
    for (const [label, type, size] of shapeRows(info)) {
      if (y > H - m - 40) { doc.addPage(); y = m; }
      doc.setFont("helvetica", "normal").text(pdfText(label).slice(0, 50), m, y).setTextColor(110).text(pdfText(type), m + 250, y).setTextColor(20).text(pdfText(size), W - m, y, { align: "right" });
      y += 14;
    }
  }
  if (info.notes) {
    y += 8;
    if (y > H - m - 60) { doc.addPage(); y = m; }
    doc.setFont("helvetica", "bold").setFontSize(12).text("Notes", m, y);
    y += 15;
    doc.setFont("helvetica", "normal").setFontSize(10);
    const lines = doc.splitTextToSize(pdfText(info.notes), W - m * 2);
    doc.text(lines, m, y);
    y += lines.length * 12;
  }
  doc.setFontSize(8).setTextColor(120);
  doc.text(doc.splitTextToSize(pdfText(photoLine(info)), W - m * 2), m, H - m + 10);
  doc.save(`${fileBase(info.name || info.address)}.pdf`);
}

/* ---------- Outlines (KML / GeoJSON) ---------- */

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
const closed = (pts: LatLng[]) => (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) ? [...pts, pts[0]] : pts);
/** KML colors are aabbggrr. */
const kmlColor = (hex: string, alpha: string) => `${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;

export function exportKml(info: ExportInfo) {
  const coords = (pts: LatLng[]) => closed(pts).map(([lat, lng]) => `${lng},${lat},0`).join(" ");
  const placemarks = info.shapes.map((s) => {
    const color = shapeColor(s.kind, s.zone);
    const style = `<Style><LineStyle><color>${kmlColor(color, "ff")}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(color, s.kind === "cut" ? "33" : "55")}</color></PolyStyle></Style>`;
    const type = s.kind === "turf" && s.zone ? MEASURE_ZONE_LABELS[s.zone] : MEASURE_KIND_LABELS[s.kind];
    const title = `${s.label || type}: ${sizeText(s, info.result).replace("−", "-")}`;
    let geom: string;
    if (s.kind === "line") {
      geom = `<LineString><coordinates>${s.points.map(([lat, lng]) => `${lng},${lat},0`).join(" ")}</coordinates></LineString>`;
    } else {
      const polys = s.kind === "turf" && info.result.shapesWithHoles[s.id]?.length ? info.result.shapesWithHoles[s.id] : [[s.points]];
      const one = (poly: LatLng[][]) =>
        `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(poly[0])}</coordinates></LinearRing></outerBoundaryIs>${poly.slice(1).map((r) => `<innerBoundaryIs><LinearRing><coordinates>${coords(r)}</coordinates></LinearRing></innerBoundaryIs>`).join("")}</Polygon>`;
      geom = polys.length === 1 ? one(polys[0]) : `<MultiGeometry>${polys.map(one).join("")}</MultiGeometry>`;
    }
    return `<Placemark><name>${xml(title)}</name><description>${xml(type)}</description>${style}${geom}</Placemark>`;
  });
  if (info.pin) {
    placemarks.unshift(`<Placemark><name>${xml(info.address || info.name || "Property")}</name><Style><IconStyle><color>ff3b38e5</color></IconStyle></Style><Point><coordinates>${info.pin.lng},${info.pin.lat},0</coordinates></Point></Placemark>`);
  }
  const summary = totalsRows(info.result).map(([k, v]) => `${k}: ${v}`).join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(info.name || "Property measurement")}</name><description>${xml([info.address, summary, info.notes].filter(Boolean).join("\n\n"))}</description>
${placemarks.join("\n")}
</Document></kml>`;
  download(new Blob([body], { type: "application/vnd.google-earth.kml+xml" }), `${fileBase(info.name || info.address)}.kml`);
}

export function exportGeoJson(info: ExportInfo) {
  const ring = (pts: LatLng[]) => closed(pts).map(([lat, lng]) => [lng, lat]);
  const features: object[] = info.shapes.map((s) => {
    let geometry: object;
    if (s.kind === "line") geometry = { type: "LineString", coordinates: s.points.map(([lat, lng]) => [lng, lat]) };
    else {
      const polys = s.kind === "turf" && info.result.shapesWithHoles[s.id]?.length ? info.result.shapesWithHoles[s.id] : [[s.points]];
      geometry = polys.length === 1 ? { type: "Polygon", coordinates: polys[0].map(ring) } : { type: "MultiPolygon", coordinates: polys.map((p) => p.map(ring)) };
    }
    const n = info.result.byId[s.id] ?? 0;
    return {
      type: "Feature", geometry,
      properties: { name: s.label || null, kind: s.kind, zone: s.zone ?? null, ...(s.kind === "line" ? { feet: Math.round(n) } : { squareFeet: Math.round(n) }) },
    };
  });
  if (info.pin) features.unshift({ type: "Feature", geometry: { type: "Point", coordinates: [info.pin.lng, info.pin.lat] }, properties: { name: info.address || info.name || null, kind: "pin" } });
  const r = info.result;
  const body = {
    type: "FeatureCollection",
    properties: { name: info.name || null, address: info.address || null, totalSqFt: Math.round(r.netSqFt), frontSqFt: Math.round(r.frontSqFt), backSqFt: Math.round(r.backSqFt), photo: info.imagery.label },
    features,
  };
  download(new Blob([JSON.stringify(body, null, 2)], { type: "application/geo+json" }), `${fileBase(info.name || info.address)}.geojson`);
}

/* ---------- Printing ---------- */

const html = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/** Prints a one-page report: the photo with outlines, totals, the list of measurements, notes and the photo's source. */
export async function printReport(map: Leaflet.Map, L: typeof Leaflet, info: ExportInfo) {
  const canvas = await renderMap(map, L, info);
  const root = document.createElement("div");
  root.className = "measure-print-root";
  root.innerHTML = `
    <h1>${html(info.name || info.address || "Property Measurement")}</h1>
    <p class="sub">${html([info.name ? info.address : "", `Measured ${today()}`].filter(Boolean).join(" · "))}</p>
    <img src="${canvas.toDataURL("image/jpeg", 0.92)}" alt="Aerial photo with measurements" />
    <div class="cols">
      <table><tbody>${totalsRows(info.result).map(([k, v]) => `<tr class="${k === "Total Area" ? "big" : ""}"><th>${html(k)}</th><td>${html(v)}</td></tr>`).join("")}</tbody></table>
      ${info.shapes.length ? `<table><thead><tr><th>Measurement</th><th>Type</th><th class="r">Size</th></tr></thead><tbody>${shapeRows(info).map(([a, b, c]) => `<tr><td>${html(a)}</td><td>${html(b)}</td><td class="r">${html(c)}</td></tr>`).join("")}</tbody></table>` : ""}
    </div>
    ${info.notes ? `<p><strong>Notes:</strong> ${html(info.notes)}</p>` : ""}
    <p class="src">${html(photoLine(info))}</p>`;
  document.body.appendChild(root);
  const img = root.querySelector("img")!;
  await (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; }));
  const cleanup = () => { root.remove(); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  window.print();
  // Some browsers don't fire afterprint; remove it after a while either way.
  setTimeout(cleanup, 60_000);
}

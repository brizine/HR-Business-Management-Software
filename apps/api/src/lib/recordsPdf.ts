import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Chemical application records as a PDF (for an inspection, or to keep): landscape, one row per
 * product applied, each record's details on its first row. Also the monthly product totals.
 */

/** Standard PDF fonts only cover Latin-1 and a few marks; anything else prints as "?". */
const clean = (s: unknown) => String(s ?? "").replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number, maxLines = 4) {
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n").map(clean)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) { // a word wider than the column: break it
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  const lines = out.filter((l, i) => l || i === 0);
  return lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]}…`] : lines;
}

export interface PdfRecordLine {
  record: { first: boolean; date: string; time: string; customer: string; site: string; applicator: string; area: string; weather: string; voided: boolean; issues: number };
  product: string; epa: string; method: string; rate: string; amount: string;
}
interface Col { title: string; width: number; get: (l: PdfRecordLine) => string; bold?: (l: PdfRecordLine) => boolean }

const PAGE: [number, number] = [792, 612];
const M = 30;

async function table<T>(o: {
  title: string; sub: string[]; cols: { title: string; width: number; get: (r: T) => string; bold?: (r: T) => boolean }[];
  rows: T[]; size?: number; groupStart?: (r: T) => boolean; empty: string;
}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = o.size ?? 7.5;
  const lh = size + 2.2;
  let page: PDFPage = doc.addPage(PAGE);
  let y = 0;
  const header = (first: boolean) => {
    y = PAGE[1] - M;
    if (first) {
      page.drawText(clean(o.title), { x: M, y: y - 12, size: 14, font: bold });
      y -= 22;
      for (const s of o.sub) { page.drawText(clean(s), { x: M, y: y - 9, size: 8.5, font, color: rgb(0.3, 0.3, 0.3) }); y -= 11; }
      y -= 6;
    }
    let x = M;
    page.drawRectangle({ x: M, y: y - lh - 3, width: PAGE[0] - 2 * M, height: lh + 3, color: rgb(0.93, 0.94, 0.96) });
    for (const c of o.cols) { page.drawText(clean(c.title), { x: x + 2, y: y - lh + 0.5, size, font: bold }); x += c.width; }
    y -= lh + 5;
  };
  header(true);
  if (!o.rows.length) page.drawText(clean(o.empty), { x: M, y: y - 12, size: 9, font });
  for (const r of o.rows) {
    const cells = o.cols.map((c) => wrap(c.get(r), c.bold?.(r) ? bold : font, size, c.width - 4));
    const h = Math.max(...cells.map((l) => l.length)) * lh + 3;
    if (y - h < M + 14) { page = doc.addPage(PAGE); header(false); }
    if (o.groupStart?.(r)) page.drawLine({ start: { x: M, y: y + 1.5 }, end: { x: PAGE[0] - M, y: y + 1.5 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.82) });
    let x = M;
    o.cols.forEach((c, i) => {
      cells[i].forEach((t, j) => page.drawText(t, { x: x + 2, y: y - (j + 1) * lh + 2, size, font: c.bold?.(r) ? bold : font }));
      x += c.width;
    });
    y -= h;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: PAGE[0] - M - 60, y: 16, size: 7.5, font, color: rgb(0.4, 0.4, 0.4) }));
  return doc.save();
}

/** The records, one row per product applied. */
export function recordsPdf(o: { title: string; sub: string[]; lines: PdfRecordLine[] }) {
  const first = (l: PdfRecordLine) => (l.record.first ? l : null);
  const cols: Col[] = [
    { title: "Date / time", width: 62, get: (l) => (first(l) ? `${l.record.date}\n${l.record.time}${l.record.voided ? "\nVOIDED" : ""}` : ""), bold: (l) => l.record.first },
    { title: "Customer / site", width: 140, get: (l) => (first(l) ? `${l.record.customer}\n${l.record.site}` : "") },
    { title: "Applicator", width: 92, get: (l) => (first(l) ? l.record.applicator : "") },
    { title: "Product (EPA #)", width: 132, get: (l) => `${l.product}${l.epa ? `\nEPA ${l.epa}` : ""}` },
    { title: "Method / mix", width: 92, get: (l) => l.method },
    { title: "Rate / 1,000", width: 52, get: (l) => l.rate },
    { title: "Amount", width: 52, get: (l) => l.amount },
    { title: "Area (sq ft)", width: 44, get: (l) => (first(l) ? l.record.area : "") },
    { title: "Weather", width: 66, get: (l) => (first(l) ? `${l.record.weather}${l.record.issues ? `\n${l.record.issues} missing` : ""}` : "") },
  ];
  return table({ title: o.title, sub: o.sub, cols, rows: o.lines, groupStart: (l) => l.record.first, empty: "No records match these filters." });
}

export interface PdfMonthlyRow { month: string; product: string; epa: string; amount: string; applications: number; first: boolean }

/** Monthly product totals. */
export function monthlyPdf(o: { title: string; sub: string[]; rows: PdfMonthlyRow[] }) {
  return table({
    title: o.title, sub: o.sub, size: 9, rows: o.rows, groupStart: (r) => r.first, empty: "No records match these filters.",
    cols: [
      { title: "Month", width: 110, get: (r) => (r.first ? r.month : ""), bold: (r) => r.first },
      { title: "Product", width: 280, get: (r) => r.product },
      { title: "EPA reg #", width: 110, get: (r) => r.epa },
      { title: "Total applied", width: 140, get: (r) => r.amount },
      { title: "Applications", width: 92, get: (r) => String(r.applications) },
    ],
  });
}

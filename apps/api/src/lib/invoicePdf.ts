import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { DEFAULT_INVOICE_LAYOUT, LAYOUT_INK, LAYOUT_SIZE_SCALE, LOGO_BOX, fillTags, formatAddress, formatMoney, formatTaxRate, termsLabel, type InvoiceLayout, type TemplateVars } from "@crewdesk/shared";

/**
 * Invoice PDFs, laid out for a standard #10 double-window envelope: the company's return address
 * shows through the top window and the customer's billing address through the bottom one when the
 * letter-size page is folded in thirds. The bottom third is a tear-off remittance stub to mail back
 * with a check. What shows between those, what it's called and how it looks comes from the
 * company's invoice layout (Settings → Invoice layout).
 */

export const W = 612, H = 792, IN = 72;
export const INK = rgb(0.1, 0.12, 0.16), MUTED = rgb(0.42, 0.45, 0.5), LINE = rgb(0.82, 0.84, 0.87);

/** Standard PDF fonts only cover Windows-1252; anything else becomes "?". */
export const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");

export interface PdfCompany {
  name: string; legalName?: string | null; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; zip?: string | null;
  phone?: string | null; email?: string | null; website?: string | null; logo?: Buffer | null;
}
export interface PdfInvoice {
  number: number | null; status: string; issueDate: string; dueDate: string; poNumber: string | null; notes: string | null;
  subtotalCents: number; discountCents: number; totalCents: number; paidCents: number; termsDays: number;
  /** Sales tax, and what the company calls it. */
  taxCents?: number; taxName?: string;
  customerName: string; billTo: string[]; serviceAddress: string | null; customerNumber: number;
  lines: { description: string; quantity: number; unitPriceCents: number; amountCents: number; taxRate?: number }[];
  copy?: boolean;
  /** Customer credit used on this invoice. */
  creditedCents?: number; credits?: { number: number; amountCents: number }[];
  /** "Pay online at …" on the stub, when the company takes online payments. */
  payOnline?: string | null;
  /** What the customer still owes on their earlier invoices (the "Previous Balance" line, when the layout shows it). */
  previousBalanceCents?: number;
  /** The dates of the work orders on the invoice (the "Service date" detail). */
  serviceDates?: string[];
  /** The custom fields the layout shows as details: "cf:<field id>" to its value, in words. */
  fields?: Record<string, string>;
  /** The layout it prints in (Crewdesk's own when there's none). */
  layout?: InvoiceLayout;
  /** What the fill-ins in the footer and text blocks become. */
  vars?: TemplateVars;
}

export const usDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
export const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of safe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

export class Pen {
  constructor(public page: PDFPage, public reg: PDFFont, public bold: PDFFont) {}
  text(s: string, x: number, yTop: number, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; right?: boolean; center?: boolean } = {}) {
    const size = o.size ?? 10, font = o.bold ? this.bold : this.reg, t = safe(s);
    const w = font.widthOfTextAtSize(t, size);
    const dx = o.right ? w : o.center ? w / 2 : 0;
    this.page.drawText(t, { x: x - dx, y: H - yTop - size, size, font, color: o.color ?? INK });
  }
  line(x1: number, yTop: number, x2: number, o: { dashed?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawLine({ start: { x: x1, y: H - yTop }, end: { x: x2, y: H - yTop }, thickness: 0.7, color: o.color ?? LINE, dashArray: o.dashed ? [4, 3] : undefined });
  }
}

export const companyLines = (c: PdfCompany) => [c.addressLine1, c.addressLine2, [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter((x): x is string => !!x);

export async function embedLogo(doc: PDFDocument, logo: Buffer | null | undefined): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    if (logo[0] === 0x89 && logo[1] === 0x50) return await doc.embedPng(logo);
    if (logo[0] === 0xff && logo[1] === 0xd8) return await doc.embedJpg(logo);
  } catch { /* an unusual image: leave the logo off */ }
  return null;
}

const FONTS = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold],
} as const;
const WHITE = rgb(1, 1, 1), STRIPE = rgb(0.955, 0.96, 0.968);
const hexRgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
/** The text, cut short with "..." when it's wider than its room. */
function fit(text: string, font: PDFFont, size: number, width: number) {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}
/** "11/20/2026", or the first and last day when the work took several. */
function serviceDateText(dates: string[] | undefined): string | null {
  const d = [...new Set(dates ?? [])].sort();
  if (!d.length) return null;
  return d.length === 1 ? usDate(d[0]) : `${usDate(d[0])} - ${usDate(d[d.length - 1])}`;
}

/**
 * Adds one invoice's pages to `doc`, printed the way its layout says (Crewdesk's own layout when
 * it has none). The two address blocks and the stub never move, whatever the layout: they're where
 * the envelope's windows and the fold are.
 */
export async function addInvoicePages(doc: PDFDocument, c: PdfCompany, inv: PdfInvoice) {
  const lay = inv.layout ?? DEFAULT_INVOICE_LAYOUT;
  /** Sizes and line steps grow and shrink with the layout's text size. */
  const k = LAYOUT_SIZE_SCALE[lay.page.size];
  const z = (n: number) => n * k;
  const reg = await doc.embedFont(FONTS[lay.page.font][0]);
  const bold = await doc.embedFont(FONTS[lay.page.font][1]);
  const accent = lay.page.accent === LAYOUT_INK ? INK : hexRgb(lay.page.accent);
  const fill = (t: string) => fillTags(t, inv.vars ?? {});
  const logo = lay.header.logo.show ? await embedLogo(doc, c.logo) : null;
  let page = doc.addPage([W, H]);
  let pen = new Pen(page, reg, bold);
  const firstPage = page;
  const due = inv.totalCents - inv.paidCents - (inv.creditedCents ?? 0);
  // With the previous balance lines on: what's owed from before, and (if the layout says so) the two together as the amount to pay.
  const bal = lay.totals.balance;
  const previous = bal.show ? Math.max(0, inv.previousBalanceCents ?? 0) : 0;
  const toPay = bal.show && bal.payTotal ? previous + due : due;
  /** The three balance lines print at the top right (in place of the amount due) or under the totals. */
  const balTop = bal.show && bal.place === "top", balTotals = bal.show && bal.place === "totals";
  const L = 0.5 * IN, R = W - 0.5 * IN;
  const box = LOGO_BOX[lay.header.logo.size];
  const ls = logo ? Math.min(box.w / logo.width, box.h / logo.height) : 0;
  const logoW = logo ? logo.width * ls : 0, logoH = logo ? logo.height * ls : 0;

  // Top window: who it's from (logo above the return address when it sits on the left).
  let y = 0.45 * IN;
  if (logo && lay.header.logo.place === "left") {
    page.drawImage(logo, { x: L, y: H - y - logoH, width: logoW, height: logoH });
    y += logoH + 4;
  }
  pen.text(c.name, L, y, { bold: true, size: z(11) }); y += z(13);
  if (lay.header.company.address) for (const l of companyLines(c)) { pen.text(l, L, y, { size: z(9) }); y += z(11); }
  const contact = [lay.header.company.phone && c.phone, lay.header.company.email && c.email, lay.header.company.website && c.website].filter(Boolean).join(" · ");
  if (contact) pen.text(contact, L, y, { size: z(8.5), color: MUTED });

  // Right: the title and the invoice's details.
  let top = 0.45 * IN;
  if (logo && lay.header.logo.place === "right") {
    page.drawImage(logo, { x: R - logoW, y: H - top - logoH, width: logoW, height: logoH });
    top += logoH + 8;
  }
  pen.text(inv.copy ? `${lay.header.title} (COPY)` : lay.header.title, R, top, { bold: true, size: z(18), right: true, color: accent });
  // The terms ride along with the due date unless they have their own line.
  const termsOwnLine = lay.header.details.some((d) => d.key === "terms" && d.show);
  const detail = (key: string): string | null => {
    switch (key) {
      case "number": return inv.number != null ? String(inv.number) : "Draft";
      case "date": return usDate(inv.issueDate);
      case "due": return termsOwnLine ? usDate(inv.dueDate) : `${usDate(inv.dueDate)} (${termsLabel(inv.termsDays)})`;
      case "terms": return termsLabel(inv.termsDays);
      case "customerNumber": return String(inv.customerNumber);
      case "po": return inv.poNumber || null;
      case "serviceDate": return serviceDateText(inv.serviceDates);
      default: return inv.fields?.[key]?.trim() || null;
    }
  };
  let fy = top + z(26);
  for (const d of lay.header.details) {
    const v = d.show ? detail(d.key) : null;
    if (v == null) continue;
    pen.text(d.label, R - 120, fy, { size: z(9), color: MUTED, right: true });
    pen.text(fit(v, reg, z(9), 114), R, fy, { size: z(9), right: true });
    fy += z(12);
  }
  if (balTop) {
    // Owed from before, this invoice, and the two together, the last one as large as the amount due it stands in for.
    let ry = fy + z(4);
    for (const [label, cents] of [[bal.previousLabel, previous], [bal.todayLabel, due]] as const) {
      pen.text(label, R - 120, ry, { size: z(9.5), right: true }); pen.text(formatMoney(cents), R, ry, { size: z(9.5), right: true }); ry += z(13);
    }
    pen.text(bal.totalLabel, R - 120, ry + z(3), { size: z(10), bold: true, right: true });
    pen.text(formatMoney(previous + due), R, ry + z(1), { size: z(13), bold: true, right: true, color: accent });
    fy = ry + z(19);
  } else if (lay.header.amountDue.show) {
    pen.text(lay.header.amountDue.label, R - 120, fy + z(4), { size: z(10), bold: true, right: true });
    pen.text(formatMoney(toPay), R, fy + z(2), { size: z(13), bold: true, right: true, color: accent });
    fy += z(20);
  }

  // Bottom window: who it's for (sits 2.1" from the top, 0.85" from the left).
  let by = 2.1 * IN;
  pen.text(inv.customerName, 0.85 * IN, by, { size: z(10.5), bold: true }); by += z(13);
  for (const l of inv.billTo) { pen.text(l, 0.85 * IN, by, { size: z(10) }); by += z(12); }

  // The middle of the page flows down from under the windows, onto more pages when it has to.
  // Page 1 keeps its bottom third for the stub; later pages use the full height.
  let ty = Math.max(3.45 * IN, fy + 10);
  // The stub starts where the paper is perforated; the lines stop a little above it.
  const st = H - lay.stub.fromBottom * IN;
  let limit = lay.stub.show ? st - 0.28 * IN : H - 0.8 * IN;
  const nextPage = () => { page = doc.addPage([W, H]); pen = new Pen(page, reg, bold); ty = 0.6 * IN; limit = H - 0.8 * IN; };

  // The numbers sit in columns from the right edge in; a Tax column only when a line is taxed.
  const taxed = inv.lines.some((l) => (l.taxRate ?? 0) > 0);
  const shown = lay.table.columns.filter((col) => col.show && col.key !== "description" && (col.key !== "tax" || taxed));
  const hasTax = shown.some((col) => col.key === "tax");
  const widths: Record<string, number> = hasTax ? { qty: 40, price: 80, tax: 57, amount: 78 } : { qty: 40, price: 85, tax: 57, amount: 85 };
  const cols: { key: string; label: string; right: number }[] = [];
  let edge = R;
  for (const col of [...shown].reverse()) { cols.unshift({ key: col.key, label: col.label, right: edge }); edge -= widths[col.key]; }
  const first = cols[0];
  const descWidth = (first ? first.right - widths[first.key] : R) - L - (first?.key === "qty" ? 0 : 12);
  const descLabel = lay.table.columns.find((col) => col.key === "description")?.label ?? "Description";
  /** Where the totals' labels end, and the room the notes get beside them. */
  const priceEdge = R - (hasTax ? 135 : 85);
  const bar = lay.table.head === "bar";
  const header = () => {
    const hs = z(8.5);
    if (bar) page.drawRectangle({ x: L - 4, y: H - (ty + hs + 3.5), width: R - L + 8, height: hs + 6.5, color: accent });
    const color = bar ? WHITE : MUTED;
    pen.text(descLabel, L, ty, { size: hs, bold: true, color });
    for (const col of cols) pen.text(col.label, col.right, ty, { size: hs, bold: true, color, right: true });
    ty += z(13);
    if (!bar) pen.line(L, ty - 2, R);
    ty += 4;
  };
  const cell = (key: string, l: PdfInvoice["lines"][number]) =>
    key === "qty" ? qty(l.quantity) : key === "price" ? formatMoney(l.unitPriceCents) : key === "tax" ? (l.taxRate ? formatTaxRate(l.taxRate) : "-") : formatMoney(l.amountCents);

  /** Each middle section: what draws it, or nothing when it has nothing to print (so it takes no room). */
  const sections: Record<string, () => (() => void) | null> = {
    lines: () => () => {
      if (lay.serviceAddress.show && inv.serviceAddress) {
        pen.text([lay.serviceAddress.label, inv.serviceAddress].filter(Boolean).join(": "), L, ty, { size: z(9), color: MUTED }); ty += z(16);
      }
      header();
      const step = z(12);
      inv.lines.forEach((l, i) => {
        const rows = wrap(l.description, reg, z(9.5), descWidth);
        if (ty + rows.length * step > limit) {
          nextPage();
          pen.text(`${sentence(lay.header.title)} ${inv.number ?? "(draft)"} continued`, L, ty, { size: z(9), color: MUTED }); ty += z(18); header();
        }
        if (lay.table.stripes && i % 2 === 1) page.drawRectangle({ x: L - 4, y: H - (ty + rows.length * step + 1), width: R - L + 8, height: rows.length * step + 4, color: STRIPE });
        rows.forEach((r, j) => pen.text(r, L, ty + j * step, { size: z(9.5) }));
        for (const col of cols) pen.text(cell(col.key, l), col.right, ty, { size: z(9.5), right: true });
        ty += rows.length * step + 4;
      });
    },
    totals: () => () => {
      const cfg = Object.fromEntries(lay.totals.rows.map((r) => [r.key, r]));
      const totals: [string, string, boolean][] = [];
      if (cfg.subtotal.show) totals.push([cfg.subtotal.label, formatMoney(inv.subtotalCents), false]);
      if (inv.discountCents) totals.push([cfg.discount.label, `-${formatMoney(inv.discountCents)}`, false]);
      if (inv.taxCents) {
        const rates = [...new Set(inv.lines.map((l) => l.taxRate ?? 0).filter((r) => r > 0))];
        totals.push([`${cfg.tax.label || inv.taxName || "Sales tax"}${rates.length === 1 ? ` (${formatTaxRate(rates[0])})` : ""}`, formatMoney(inv.taxCents), false]);
      }
      if (cfg.total.show || !balTotals) totals.push([cfg.total.label, formatMoney(inv.totalCents), true]);
      if (cfg.credit.show) for (const cr of inv.credits ?? []) totals.push([`${cfg.credit.label} CR-${cr.number}`, `-${formatMoney(cr.amountCents)}`, false]);
      if (cfg.paid.show && inv.paidCents) totals.push([cfg.paid.label, `-${formatMoney(inv.paidCents)}`, false]);
      // Under the totals, the balance lines say what this invoice still comes to ("Today's Amount"), so they take the place of its own "Amount due".
      if (!balTotals && (inv.paidCents || inv.credits?.length)) totals.push([cfg.due.label, formatMoney(due), true]);
      const balance: [string, string, boolean][] = balTotals
        ? [[bal.previousLabel, formatMoney(previous), false], [bal.todayLabel, formatMoney(due), false], [bal.totalLabel, formatMoney(previous + due), true]]
        : [];
      const beside = lay.notes.place === "beside";
      const noteWidth = beside ? priceEdge - 115 - L : R - L;
      const notes = lay.notes.show && inv.notes ? wrap(inv.notes, reg, z(9), noteWidth) : [];
      if (ty + (totals.length + balance.length) * z(13) + 10 + (balance.length ? 9 : 0) > limit) nextPage();
      pen.line(priceEdge - 60, ty, R); ty += 6;
      const totalsTop = ty;
      const row = ([label, v, strong]: [string, string, boolean]) => { pen.text(label, priceEdge, ty, { size: z(9.5), bold: strong, right: true }); pen.text(v, R, ty, { size: z(9.5), bold: strong, right: true }); ty += z(13); };
      totals.forEach(row);
      if (balance.length) {
        // A rule sets the account's lines apart from the invoice's own (none needed when nothing is above them).
        if (totals.length) { ty += 3; pen.line(priceEdge - 60, ty, R); ty += 6; }
        balance.forEach(row);
      }
      if (!notes.length) return;
      // Beside the totals the notes start level with them; under them, they follow on.
      const end = ty;
      let ny = beside ? totalsTop : end + 6, moved = false;
      const noteLine = (t: string, o: { bold?: boolean } = {}) => {
        if (ny >= limit - 10) { nextPage(); ny = ty; moved = true; }
        pen.text(t, L, ny, { size: z(9), bold: o.bold }); ny += z(11);
      };
      if (lay.notes.label) noteLine(lay.notes.label, { bold: true });
      for (const n of notes) noteLine(n);
      ty = moved ? ny : Math.max(end, ny);
    },
    footer: () => {
      const lines = lay.footer.show && lay.footer.text ? wrap(fill(lay.footer.text), reg, z(8.5), R - L) : [];
      if (!lines.length) return null;
      return () => {
        for (const f of lines) {
          if (ty >= limit) nextPage();
          pen.text(f, lay.footer.align === "center" ? W / 2 : lay.footer.align === "right" ? R : L, ty, { size: z(8.5), color: MUTED, center: lay.footer.align === "center", right: lay.footer.align === "right" });
          ty += z(10);
        }
      };
    },
  };
  /** One of the company's own text blocks. */
  const textBlock = (b: InvoiceLayout["blocks"][number] | undefined) => {
    if (!b) return null;
    const size = z({ small: 8.5, normal: 10, large: 12 }[b.size]), step = size * 1.3, pad = b.box ? 8 : 0;
    const lines = wrap(fill(b.text), b.bold ? bold : reg, size, R - L - pad * 2);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return null;
    return () => {
      const height = lines.length * step + pad * 2;
      if (ty + height > limit) nextPage();
      if (b.box) page.drawRectangle({ x: L, y: H - (ty + height), width: R - L, height, borderColor: LINE, borderWidth: 0.8 });
      const x = b.align === "center" ? W / 2 : b.align === "right" ? R - pad : L + pad;
      lines.forEach((t, i) => pen.text(t, x, ty + pad + i * step, { size, bold: b.bold, center: b.align === "center", right: b.align === "right" }));
      ty += height;
    };
  };

  let before = "";
  for (const s of lay.order) {
    const drawIt = s.startsWith("text:") ? textBlock(lay.blocks.find((x) => x.id === s.slice(5))) : sections[s]?.();
    if (!drawIt) continue;
    // Totals sit right under the lines; everything else gets a little air above it.
    if (before && !(before === "lines" && s === "totals")) ty += 10;
    drawIt();
    before = s;
  }

  // The tear-off stub (bottom third of page 1).
  if (!lay.stub.show) return;
  const sp = new Pen(firstPage, reg, bold);
  sp.line(L - 10, st, R + 10, { dashed: true, color: MUTED });
  if (lay.stub.detach) sp.text(lay.stub.detach, W / 2, st + 4, { size: 7.5, color: MUTED, center: true });
  let sy = st + 26;
  sp.text(lay.stub.payableLabel, L, sy, { size: 8.5, color: MUTED }); sy += 11;
  sp.text(lay.stub.payableTo || c.legalName || c.name, L, sy, { size: 10.5, bold: true }); sy += 14;
  sp.text(lay.stub.mailLabel, L, sy, { size: 8.5, color: MUTED }); sy += 11;
  sp.text(c.name, L, sy, { size: 10 }); sy += 12;
  for (const l of companyLines(c)) { sp.text(l, L, sy, { size: 10 }); sy += 12; }
  if (lay.stub.payOnline && inv.payOnline) {
    sy += 8;
    sp.text(lay.stub.payOnlineLabel, L, sy, { size: 8.5, color: MUTED }); sy += 11;
    sp.text(inv.payOnline, L, sy, { size: 10, bold: true });
  }
  const sx = W / 2 + 20;
  let ry = st + 26;
  const row = (label: string, v: string, strong = false) => { sp.text(label, sx, ry, { size: 9, color: MUTED }); sp.text(v, R, ry, { size: strong ? 12 : 10, bold: strong, right: true }); ry += strong ? 18 : 14; };
  row("Customer", inv.customerName);
  row("Customer #", String(inv.customerNumber));
  row("Invoice #", inv.number != null ? String(inv.number) : "Draft");
  row("Due date", usDate(inv.dueDate));
  row("Amount due", formatMoney(toPay), true);
  if (lay.stub.enclosed) {
    sp.text(lay.stub.enclosedLabel, sx, ry + 6, { size: 9, color: MUTED });
    sp.line(sx + 85, ry + 18, R);
  }
}

export async function invoicePdf(c: PdfCompany, inv: PdfInvoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number ?? "draft"} - ${c.name}`);
  await addInvoicePages(doc, c, inv);
  return doc.save();
}

/** Several invoices in one PDF (for mailing), after a cover sheet with the count and total. */
export async function batchPdf(c: PdfCompany, list: PdfInvoice[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoices to mail - ${c.name}`);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const cover = new Pen(doc.addPage([W, H]), reg, bold);
  cover.text("Invoices to mail", 0.75 * IN, 0.9 * IN, { size: 20, bold: true });
  cover.text(`${list.length} invoice${list.length === 1 ? "" : "s"}, sorted by ZIP code · total due ${formatMoney(list.reduce((s, i) => s + i.totalCents - i.paidCents - (i.creditedCents ?? 0), 0))}`, 0.75 * IN, 0.9 * IN + 30, { size: 11 });
  let y = 0.9 * IN + 60;
  for (const i of list) {
    if (y > H - 0.8 * IN) break;
    cover.text(`#${i.number ?? "draft"}`, 0.75 * IN, y, { size: 9.5 });
    cover.text(i.customerName, 1.5 * IN, y, { size: 9.5 });
    cover.text(i.billTo[i.billTo.length - 1] ?? "", 4.4 * IN, y, { size: 9.5, color: MUTED });
    cover.text(formatMoney(i.totalCents - i.paidCents - (i.creditedCents ?? 0)), W - 0.75 * IN, y, { size: 9.5, right: true });
    y += 13;
  }
  for (const i of list) await addInvoicePages(doc, c, i);
  return doc.save();
}

/** The billing address lines for the envelope window (falls back to the service address). */
export function billToLines(cust: { billingStreet: string | null; billingCity: string | null; billingState: string | null; billingZip: string | null }, prop?: { street: string; city: string | null; state: string; zip: string | null } | null): string[] {
  if (cust.billingStreet) return [cust.billingStreet, formatAddress({ city: cust.billingCity, state: cust.billingState, zip: cust.billingZip })].filter(Boolean);
  if (prop) return [prop.street, formatAddress({ city: prop.city, state: prop.state, zip: prop.zip })].filter(Boolean);
  return [];
}

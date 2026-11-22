import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { formatAddress, formatMoney, termsLabel } from "@crewdesk/shared";

/**
 * Invoice PDFs, laid out for a standard #10 double-window envelope: the company's return address
 * shows through the top window and the customer's billing address through the bottom one when the
 * letter-size page is folded in thirds. The bottom third is a tear-off remittance stub to mail back
 * with a check.
 */

const W = 612, H = 792, IN = 72;
const INK = rgb(0.1, 0.12, 0.16), MUTED = rgb(0.42, 0.45, 0.5), LINE = rgb(0.82, 0.84, 0.87);

/** Standard PDF fonts only cover Windows-1252; anything else becomes "?". */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");

export interface PdfCompany {
  name: string; legalName?: string | null; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; zip?: string | null;
  phone?: string | null; email?: string | null; website?: string | null; logo?: Buffer | null;
}
export interface PdfInvoice {
  number: number | null; status: string; issueDate: string; dueDate: string; poNumber: string | null; notes: string | null;
  subtotalCents: number; discountCents: number; totalCents: number; paidCents: number; termsDays: number;
  customerName: string; billTo: string[]; serviceAddress: string | null; customerNumber: number;
  lines: { description: string; quantity: number; unitPriceCents: number; amountCents: number }[];
  footer: string; payableTo: string; copy?: boolean;
  /** "Pay online at …" on the stub, when the company takes online payments. */
  payOnline?: string | null;
}

const usDate = (iso: string) => { const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
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

class Pen {
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

const companyLines = (c: PdfCompany) => [c.addressLine1, c.addressLine2, [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter((x): x is string => !!x);

async function embedLogo(doc: PDFDocument, logo: Buffer | null | undefined): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    if (logo[0] === 0x89 && logo[1] === 0x50) return await doc.embedPng(logo);
    if (logo[0] === 0xff && logo[1] === 0xd8) return await doc.embedJpg(logo);
  } catch { /* an unusual image: leave the logo off */ }
  return null;
}

/** Adds one invoice's pages to `doc`. */
export async function addInvoicePages(doc: PDFDocument, c: PdfCompany, inv: PdfInvoice) {
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedLogo(doc, c.logo);
  let page = doc.addPage([W, H]);
  let pen = new Pen(page, reg, bold);
  const due = inv.totalCents - inv.paidCents;
  const L = 0.5 * IN, R = W - 0.5 * IN;

  // Top window: who it's from (logo above the return address when there is one).
  let y = 0.45 * IN;
  if (logo) {
    const s = Math.min((2.6 * IN) / logo.width, 34 / logo.height);
    page.drawImage(logo, { x: L, y: H - y - logo.height * s, width: logo.width * s, height: logo.height * s });
    y += logo.height * s + 4;
  }
  pen.text(c.name, L, y, { bold: true, size: 11 }); y += 13;
  for (const l of companyLines(c)) { pen.text(l, L, y, { size: 9 }); y += 11; }
  const contact = [c.phone, c.email].filter(Boolean).join(" · ");
  if (contact) pen.text(contact, L, y, { size: 8.5, color: MUTED });

  // Right: invoice details.
  pen.text(inv.copy ? "INVOICE (COPY)" : "INVOICE", R, 0.45 * IN, { bold: true, size: 18, right: true });
  const facts: [string, string][] = [
    ["Invoice #", inv.number != null ? String(inv.number) : "Draft"],
    ["Date", usDate(inv.issueDate)],
    ["Due", `${usDate(inv.dueDate)} (${termsLabel(inv.termsDays)})`],
    ["Customer #", String(inv.customerNumber)],
    ...(inv.poNumber ? [["PO #", inv.poNumber] as [string, string]] : []),
  ];
  let fy = 0.45 * IN + 26;
  for (const [k, v] of facts) { pen.text(k, R - 120, fy, { size: 9, color: MUTED, right: true }); pen.text(v, R, fy, { size: 9, right: true }); fy += 12; }
  pen.text("Amount due", R - 120, fy + 4, { size: 10, bold: true, right: true });
  pen.text(formatMoney(due), R, fy + 2, { size: 13, bold: true, right: true });

  // Bottom window: who it's for (sits 2.1" from the top, 0.85" from the left).
  let by = 2.1 * IN;
  pen.text(inv.customerName, 0.85 * IN, by, { size: 10.5, bold: true }); by += 13;
  for (const l of inv.billTo) { pen.text(l, 0.85 * IN, by, { size: 10 }); by += 12; }

  // Lines.
  let ty = 3.45 * IN;
  if (inv.serviceAddress) { pen.text(`Service address: ${inv.serviceAddress}`, L, ty, { size: 9, color: MUTED }); ty += 16; }
  const COL = { qty: R - 170, price: R - 85, amount: R };
  const header = () => {
    pen.text("Description", L, ty, { size: 8.5, bold: true, color: MUTED });
    pen.text("Qty", COL.qty, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    pen.text("Price", COL.price, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    pen.text("Amount", COL.amount, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    ty += 13; pen.line(L, ty - 2, R); ty += 4;
  };
  header();
  // Page 1 keeps its bottom third for the stub; later pages use the full height.
  let limit = 7.05 * IN;
  const stubPage = page;
  for (const l of inv.lines) {
    const rows = wrap(l.description, reg, 9.5, COL.qty - L - 40);
    if (ty + rows.length * 12 > limit) {
      page = doc.addPage([W, H]); pen = new Pen(page, reg, bold); ty = 0.6 * IN; limit = H - 0.8 * IN;
      pen.text(`Invoice ${inv.number ?? "(draft)"} continued`, L, ty, { size: 9, color: MUTED }); ty += 18; header();
    }
    rows.forEach((r, i) => pen.text(r, L, ty + i * 12, { size: 9.5 }));
    pen.text(qty(l.quantity), COL.qty, ty, { size: 9.5, right: true });
    pen.text(formatMoney(l.unitPriceCents), COL.price, ty, { size: 9.5, right: true });
    pen.text(formatMoney(l.amountCents), COL.amount, ty, { size: 9.5, right: true });
    ty += rows.length * 12 + 4;
  }
  const totals: [string, string, boolean][] = [["Subtotal", formatMoney(inv.subtotalCents), false]];
  if (inv.discountCents) totals.push(["Discount", `-${formatMoney(inv.discountCents)}`, false]);
  totals.push(["Total", formatMoney(inv.totalCents), true]);
  if (inv.paidCents) totals.push(["Paid", `-${formatMoney(inv.paidCents)}`, false], ["Amount due", formatMoney(due), true]);
  const notes = inv.notes ? wrap(inv.notes, reg, 9, R - L - 200) : [];
  if (ty + totals.length * 13 + 10 > limit) { page = doc.addPage([W, H]); pen = new Pen(page, reg, bold); ty = 0.6 * IN; limit = H - 0.8 * IN; }
  pen.line(COL.price - 60, ty, R); ty += 6;
  const totalsTop = ty;
  for (const [k, v, strong] of totals) { pen.text(k, COL.price, ty, { size: 9.5, bold: strong, right: true }); pen.text(v, COL.amount, ty, { size: 9.5, bold: strong, right: true }); ty += 13; }
  let ny = totalsTop;
  for (const n of notes) { if (ny < limit - 10) pen.text(n, L, ny, { size: 9 }); ny += 11; }
  const footer = inv.footer ? wrap(inv.footer, reg, 8.5, R - L) : [];
  let fy2 = Math.max(ty, ny) + 10;
  for (const f of footer) { if (fy2 < limit) pen.text(f, L, fy2, { size: 8.5, color: MUTED }); fy2 += 10; }

  // The tear-off stub (bottom third of page 1).
  const sp = new Pen(stubPage, reg, bold);
  const st = 7.33 * IN;
  sp.line(L - 10, st, R + 10, { dashed: true, color: MUTED });
  sp.text("Please detach and return this part with your payment", W / 2, st + 4, { size: 7.5, color: MUTED, center: true });
  let sy = st + 26;
  sp.text("Make checks payable to", L, sy, { size: 8.5, color: MUTED }); sy += 11;
  sp.text(inv.payableTo || c.legalName || c.name, L, sy, { size: 10.5, bold: true }); sy += 14;
  sp.text("Mail to", L, sy, { size: 8.5, color: MUTED }); sy += 11;
  sp.text(c.name, L, sy, { size: 10 }); sy += 12;
  for (const l of companyLines(c)) { sp.text(l, L, sy, { size: 10 }); sy += 12; }
  if (inv.payOnline) {
    sy += 8;
    sp.text("Or pay online (card or bank account)", L, sy, { size: 8.5, color: MUTED }); sy += 11;
    sp.text(inv.payOnline, L, sy, { size: 10, bold: true });
  }
  const sx = W / 2 + 20;
  let ry = st + 26;
  const row = (k: string, v: string, strong = false) => { sp.text(k, sx, ry, { size: 9, color: MUTED }); sp.text(v, R, ry, { size: strong ? 12 : 10, bold: strong, right: true }); ry += strong ? 18 : 14; };
  row("Customer", inv.customerName);
  row("Customer #", String(inv.customerNumber));
  row("Invoice #", inv.number != null ? String(inv.number) : "Draft");
  row("Due date", usDate(inv.dueDate));
  row("Amount due", formatMoney(due), true);
  sp.text("Amount enclosed", sx, ry + 6, { size: 9, color: MUTED });
  sp.line(sx + 85, ry + 18, R);
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
  cover.text(`${list.length} invoice${list.length === 1 ? "" : "s"}, sorted by ZIP code · total due ${formatMoney(list.reduce((s, i) => s + i.totalCents - i.paidCents, 0))}`, 0.75 * IN, 0.9 * IN + 30, { size: 11 });
  let y = 0.9 * IN + 60;
  for (const i of list) {
    if (y > H - 0.8 * IN) break;
    cover.text(`#${i.number ?? "draft"}`, 0.75 * IN, y, { size: 9.5 });
    cover.text(i.customerName, 1.5 * IN, y, { size: 9.5 });
    cover.text(i.billTo[i.billTo.length - 1] ?? "", 4.4 * IN, y, { size: 9.5, color: MUTED });
    cover.text(formatMoney(i.totalCents - i.paidCents), W - 0.75 * IN, y, { size: 9.5, right: true });
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

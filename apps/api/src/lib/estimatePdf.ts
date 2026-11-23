import { PDFDocument, StandardFonts } from "pdf-lib";
import { formatMoney, formatTaxRate } from "@crewdesk/shared";
import { H, IN, MUTED, Pen, W, companyLines, embedLogo, qty, usDate, wrap, type PdfCompany } from "./invoicePdf";

/** An estimate as a PDF: the same header as invoices, the lines (optional ones marked), totals, notes, terms and where to accept. */
export interface PdfEstimate {
  number: number; status: string; issueDate: string; validUntil: string | null; poNumber: string | null; title: string | null;
  customerName: string; customerNumber: number; billTo: string[]; serviceAddress: string | null;
  lines: { description: string; quantity: number; unitPriceCents: number; visits: number; taxRate: number; amountCents: number; optional: boolean; included: boolean; recommended: boolean }[];
  subtotalCents: number; discountCents: number; discountPercent: number; taxCents: number; totalCents: number; taxName: string;
  customerNotes: string | null; terms: string | null;
  acceptUrl: string | null; accepted: { name: string | null; at: string } | null;
}

export async function estimatePdf(c: PdfCompany, e: PdfEstimate): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Estimate ${e.number}`);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedLogo(doc, c.logo);
  let page = doc.addPage([W, H]);
  let pen = new Pen(page, reg, bold);
  const L = 0.5 * IN, R = W - 0.5 * IN;
  const newPage = () => { page = doc.addPage([W, H]); pen = new Pen(page, reg, bold); return 0.6 * IN; };

  let y = 0.45 * IN;
  if (logo) {
    const s = Math.min((2.6 * IN) / logo.width, 34 / logo.height);
    page.drawImage(logo, { x: L, y: H - y - logo.height * s, width: logo.width * s, height: logo.height * s });
    y += logo.height * s + 4;
  }
  pen.text(c.name, L, y, { bold: true, size: 11 }); y += 13;
  for (const l of companyLines(c)) { pen.text(l, L, y, { size: 9 }); y += 11; }
  const contact = [c.phone, c.email].filter(Boolean).join(" · ");
  if (contact) { pen.text(contact, L, y, { size: 8.5, color: MUTED }); y += 11; }

  pen.text("ESTIMATE", R, 0.45 * IN, { bold: true, size: 18, right: true });
  const facts: [string, string][] = [
    ["Estimate #", String(e.number)], ["Date", usDate(e.issueDate)],
    ...(e.validUntil ? [["Good until", usDate(e.validUntil)] as [string, string]] : []),
    ["Customer #", String(e.customerNumber)],
    ...(e.poNumber ? [["PO #", e.poNumber] as [string, string]] : []),
  ];
  let fy = 0.45 * IN + 26;
  for (const [k, v] of facts) { pen.text(k, R - 120, fy, { size: 9, color: MUTED, right: true }); pen.text(v, R, fy, { size: 9, right: true }); fy += 12; }
  pen.text("Total", R - 120, fy + 4, { size: 10, bold: true, right: true });
  pen.text(formatMoney(e.totalCents), R, fy + 2, { size: 13, bold: true, right: true });

  let by = Math.max(y, fy + 20) + 14;
  pen.text("Prepared for", L, by, { size: 8.5, color: MUTED }); by += 11;
  pen.text(e.customerName, L, by, { size: 10.5, bold: true }); by += 13;
  for (const l of e.billTo) { pen.text(l, L, by, { size: 10 }); by += 12; }
  let ty = by + 12;
  if (e.title) { for (const t of wrap(e.title, bold, 12, R - L)) { pen.text(t, L, ty, { size: 12, bold: true }); ty += 15; } ty += 2; }
  if (e.serviceAddress) { pen.text(`Service address: ${e.serviceAddress}`, L, ty, { size: 9, color: MUTED }); ty += 16; }

  const taxed = e.lines.some((l) => l.taxRate > 0);
  const COL = taxed ? { qty: R - 215, price: R - 135, tax: R - 78, amount: R } : { qty: R - 170, price: R - 85, tax: 0, amount: R };
  const header = () => {
    pen.text("Description", L, ty, { size: 8.5, bold: true, color: MUTED });
    pen.text("Qty", COL.qty, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    pen.text("Price", COL.price, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    if (taxed) pen.text("Tax", COL.tax, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    pen.text("Amount", COL.amount, ty, { size: 8.5, bold: true, color: MUTED, right: true });
    ty += 13; pen.line(L, ty - 2, R); ty += 4;
  };
  header();
  const limit = H - 0.8 * IN;
  for (const l of e.lines) {
    const tags = [l.recommended ? "Recommended" : "", l.optional ? (l.included ? "Optional, included" : "Optional, not included") : "", l.visits > 1 ? `${l.visits} visits` : ""].filter(Boolean).join(" · ");
    const rows = wrap(l.description, reg, 9.5, COL.qty - L - 40);
    const height = rows.length * 12 + (tags ? 11 : 0);
    if (ty + height > limit) { ty = newPage(); pen.text(`Estimate ${e.number} continued`, L, ty, { size: 9, color: MUTED }); ty += 18; header(); }
    const color = l.included ? undefined : MUTED;
    rows.forEach((r, i) => pen.text(r, L, ty + i * 12, { size: 9.5, color }));
    pen.text(qty(l.quantity), COL.qty, ty, { size: 9.5, right: true, color });
    pen.text(formatMoney(l.unitPriceCents), COL.price, ty, { size: 9.5, right: true, color });
    if (taxed) pen.text(l.taxRate ? formatTaxRate(l.taxRate) : "-", COL.tax, ty, { size: 9.5, right: true, color });
    pen.text(l.included ? formatMoney(l.amountCents) : `(${formatMoney(l.amountCents)})`, COL.amount, ty, { size: 9.5, right: true, color });
    if (tags) pen.text(tags, L, ty + rows.length * 12, { size: 8, color: MUTED });
    ty += height + 5;
  }
  const totals: [string, string, boolean][] = [["Subtotal", formatMoney(e.subtotalCents), false]];
  if (e.discountCents) totals.push([`Discount (${e.discountPercent}%)`, `-${formatMoney(e.discountCents)}`, false]);
  if (e.taxCents) totals.push([e.taxName || "Sales tax", formatMoney(e.taxCents), false]);
  totals.push(["Total", formatMoney(e.totalCents), true]);
  if (ty + totals.length * 13 + 10 > limit) ty = newPage();
  pen.line(COL.price - 60, ty, R); ty += 6;
  for (const [k, v, strong] of totals) { pen.text(k, COL.price, ty, { size: 9.5, bold: strong, right: true }); pen.text(v, COL.amount, ty, { size: 9.5, bold: strong, right: true }); ty += 13; }
  if (e.lines.some((l) => l.optional && !l.included)) { pen.text("Amounts in brackets are optional and not in the total.", R, ty + 2, { size: 8, color: MUTED, right: true }); ty += 12; }
  ty += 10;
  const block = (title: string, text: string | null) => {
    if (!text) return;
    const rows = wrap(text, reg, 9, R - L);
    if (ty + 14 + Math.min(rows.length, 6) * 11 > limit) ty = newPage();
    pen.text(title, L, ty, { size: 9, bold: true }); ty += 12;
    for (const r of rows) { if (ty > limit) ty = newPage(); pen.text(r, L, ty, { size: 9 }); ty += 11; }
    ty += 8;
  };
  block("Notes", e.customerNotes);
  block("Terms", e.terms);
  if (ty + 60 > limit) ty = newPage();
  ty += 6;
  if (e.accepted) {
    pen.text(`Accepted${e.accepted.name ? ` by ${e.accepted.name}` : ""} on ${new Date(e.accepted.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, L, ty, { size: 10, bold: true });
  } else {
    if (e.acceptUrl) { pen.text("Accept online:", L, ty, { size: 9, color: MUTED }); pen.text(e.acceptUrl, L + 68, ty, { size: 9, bold: true }); ty += 22; }
    pen.text("Accepted by", L, ty + 14, { size: 9, color: MUTED }); pen.line(L + 60, ty + 24, L + 300);
    pen.text("Date", L + 320, ty + 14, { size: 9, color: MUTED }); pen.line(L + 345, ty + 24, R);
  }
  return doc.save();
}

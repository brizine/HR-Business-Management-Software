import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { formAnswerRows, formatPhone, isSigned, type FormAnswers, type FormDef, type FormSignature, type FormSignatures } from "@crewdesk/shared";
import { H, IN, W, companyLines, embedLogo, type PdfCompany } from "./invoicePdf";

/**
 * A visit form as a PDF: the company on top, what it's for (work order, customer, property, who
 * submitted it and when), then each section's questions with their answers, ticked boxes, photos
 * and signatures. Used for the download on the work order and the copy emailed to the customer.
 */

export interface FormPdfInput {
  company: PdfCompany;
  name: string;
  /** What it's for, as label and value lines ("Work order", "WO-1043 Mow and edge"). */
  meta: [string, string][];
  def: FormDef; answers: FormAnswers; signature: FormSignature | null; signatures: FormSignatures;
  /** A photo question's pictures, by id (JPEG and PNG are drawn; other kinds are named instead). */
  photos?: Map<string, { bytes: Buffer; contentType: string }>;
}

/** Standard PDF fonts cover Windows-1252; anything else becomes "?". */
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const clean = (s: string) => [...s.replace(/ /g, " ").replace(/\r/g, "")].map((ch) => (/[\x20-\x7E\xA1-\xFF\n]/.test(ch) || CP1252_EXTRA.includes(ch) ? ch : "?")).join("");

const LEFT = 0.75 * IN, RIGHT = W - 0.75 * IN, TOP = 0.75 * IN, BOTTOM = H - 0.8 * IN;
const INK = rgb(0.1, 0.12, 0.16), MUTED = rgb(0.4, 0.44, 0.5), LINE = rgb(0.78, 0.8, 0.84);

/** Words wrapped to a width (a word longer than the line is cut into pieces). */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (font.widthOfTextAtSize(word, size) > width) {
        let n = word.length;
        while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > width) n--;
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

export async function visitFormPdf(i: FormPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(clean(i.name));
  doc.setCreator("Crewdesk");
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([W, H]);
  let y = TOP;
  /** Starts a new page when `need` points won't fit under where we are. */
  const room = (need: number) => { if (y + need > BOTTOM) { page = doc.addPage([W, H]); y = TOP; } };
  const text = (s: string, x: number, size: number, font = reg, color = INK) => page.drawText(clean(s), { x, y: H - y - size, size, font, color });
  const lines = (s: string, x: number, size: number, width: number, font = reg, color = INK) => {
    for (const l of wrap(s, font, size, width)) { room(size + 4); text(l, x, size, font, color); y += size + 4; }
  };

  // The company, with its logo on the right.
  const logo = await embedLogo(doc, i.company.logo);
  if (logo) {
    const k = Math.min(150 / logo.width, 56 / logo.height, 1);
    page.drawImage(logo, { x: RIGHT - logo.width * k, y: H - TOP - logo.height * k, width: logo.width * k, height: logo.height * k });
  }
  text(i.company.name, LEFT, 13, bold); y += 18;
  for (const l of [...companyLines(i.company), [i.company.phone ? formatPhone(i.company.phone) : null, i.company.email].filter(Boolean).join("  ·  ")].filter(Boolean)) { text(l, LEFT, 9, reg, MUTED); y += 12; }
  y = Math.max(y, TOP + 62) + 10;
  page.drawLine({ start: { x: LEFT, y: H - y }, end: { x: RIGHT, y: H - y }, thickness: 0.8, color: LINE });
  y += 16;
  lines(i.name, LEFT, 17, RIGHT - LEFT, bold);
  y += 4;
  for (const [label, value] of i.meta.filter(([, v]) => v)) {
    room(14);
    text(`${label}:`, LEFT, 9.5, bold, MUTED);
    const x = LEFT + 78;
    for (const l of wrap(value, reg, 9.5, RIGHT - x)) { room(13); text(l, x, 9.5); y += 13; }
  }
  y += 10;

  const sign = (sig: FormSignature | null | undefined) => {
    const boxW = 3.2 * IN, boxH = 1.05 * IN;
    room(boxH + 8);
    page.drawRectangle({ x: LEFT, y: H - y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.8 });
    if (isSigned(sig)) {
      const k = Math.min((boxW - 12) / sig.w, (boxH - 10) / sig.h);
      // The strokes are drawn from the box's top-left corner (the path's y runs down, as it was drawn).
      page.drawSvgPath(sig.d, { x: LEFT + (boxW - sig.w * k) / 2, y: H - y - (boxH - sig.h * k) / 2, scale: k, borderColor: INK, borderWidth: 1.1 / k });
    } else {
      const was = y; y += boxH / 2 - 5; text("Not signed", LEFT + 10, 9.5, reg, MUTED); y = was;
    }
    y += boxH + 10;
  };

  const pictures = new Map<string, PDFImage | null>();
  const picture = async (id: string) => {
    if (!pictures.has(id)) { const p = i.photos?.get(id); pictures.set(id, p ? await embedLogo(doc, p.bytes) : null); }
    return pictures.get(id) ?? null;
  };

  for (const s of formAnswerRows(i.def, i.answers, i.signatures)) {
    if (s.section) {
      room(40);
      y += 6;
      lines(s.section, LEFT, 12.5, RIGHT - LEFT, bold);
      page.drawLine({ start: { x: LEFT, y: H - y }, end: { x: RIGHT, y: H - y }, thickness: 0.6, color: LINE });
      y += 10;
    }
    for (const r of s.rows) {
      room(34);
      lines(r.label + (r.required ? " *" : ""), LEFT, 9.5, RIGHT - LEFT, bold, MUTED);
      if (r.type === "checkbox") {
        for (const o of r.options ?? []) {
          room(16);
          page.drawRectangle({ x: LEFT + 2, y: H - y - 10, width: 9, height: 9, borderColor: INK, borderWidth: 0.9 });
          if (o.ticked) {
            page.drawLine({ start: { x: LEFT + 3.8, y: H - y - 6 }, end: { x: LEFT + 6, y: H - y - 8.4 }, thickness: 1.3, color: INK });
            page.drawLine({ start: { x: LEFT + 6, y: H - y - 8.4 }, end: { x: LEFT + 9.6, y: H - y - 2.6 }, thickness: 1.3, color: INK });
          }
          const was = y; y -= 1;
          const ls = wrap(o.label, reg, 10.5, RIGHT - LEFT - 20);
          for (const l of ls) { text(l, LEFT + 18, 10.5); y += 14; }
          y = Math.max(y, was + 15);
        }
        y += 6;
      } else if (r.type === "signature") {
        sign(r.signature);
      } else if (r.type === "photo") {
        const ids = r.photos ?? [];
        if (!ids.length) { lines("-", LEFT, 10.5, RIGHT - LEFT); y += 4; }
        for (const id of ids) {
          const img = await picture(id);
          if (!img) { lines("Photo (see the work order's photos)", LEFT, 10, RIGHT - LEFT, reg, MUTED); continue; }
          const k = Math.min((3.4 * IN) / img.width, (2.6 * IN) / img.height, 1);
          room(img.height * k + 8);
          page.drawImage(img, { x: LEFT, y: H - y - img.height * k, width: img.width * k, height: img.height * k });
          y += img.height * k + 8;
        }
        y += 4;
      } else {
        lines(r.value || "-", LEFT, 10.5, RIGHT - LEFT);
        y += 6;
      }
    }
  }
  if (i.def.signature) {
    room(40);
    y += 4;
    lines((i.def.signatureLabel || "Signature") + (i.def.signatureRequired ? " *" : ""), LEFT, 9.5, RIGHT - LEFT, bold, MUTED);
    sign(i.signature);
  }
  return doc.save();
}

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { formatPhone } from "@crewdesk/shared";
import { H, IN, INK, LINE, MUTED, W, companyLines, embedLogo, type PdfCompany } from "./invoicePdf";

/**
 * Letters (Resources → Documents) as PDFs: one letter per customer on the company's letterhead.
 * Laid out for a standard #10 double-window envelope like the invoices: the return address shows
 * through the top window and the customer's name and address through the bottom one when the page
 * is folded in thirds. The words are the document's formatted text (headings, bold, lists…),
 * already filled in for the customer.
 */

export type Letter = { toName: string; toLines: string[]; html: string };

/* ───────────── The document's HTML as blocks of styled text ───────────── */

type Style = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; link: boolean };
type Run = Style & { text: string };
type Align = "left" | "center" | "right";
export type Block = { kind: "p" | "h2" | "h3" | "hr"; align: Align; indent: number; bullet: string | null; quote: boolean; runs: Run[] };

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", copy: "©", reg: "®", trade: "™" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
  const k = e.toLowerCase();
  if (k in ENTITIES) return ENTITIES[k];
  if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16) || 63);
  if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10) || 63);
  return m;
});

/** The cleaned HTML a document is saved as (p, br, headings, lists, quotes, rules, bold…) as blocks. */
export function letterBlocks(html: string): Block[] {
  const out: Block[] = [];
  const style: Record<keyof Style, number> = { bold: 0, italic: 0, underline: 0, strike: 0, link: 0 };
  const lists: { ordered: boolean; n: number }[] = [];
  let quote = 0;
  let cur: Block | null = null;
  let pendingBullet: string | null = null;
  let href: string | null = null;
  let linkText = "";

  const open = (kind: Block["kind"], align: Align = "left") => {
    cur = { kind, align, indent: lists.length + quote, bullet: pendingBullet, quote: quote > 0, runs: [] };
    pendingBullet = null;
    out.push(cur);
    return cur;
  };
  const close = () => { cur = null; };
  const add = (text: string) => {
    if (!text) return;
    const b = cur ?? open("p");
    const heading = b.kind === "h2" || b.kind === "h3";
    b.runs.push({ text, bold: style.bold > 0 || heading, italic: style.italic > 0, underline: style.underline > 0 || style.link > 0, strike: style.strike > 0, link: style.link > 0 });
  };
  const alignOf = (attrs: string): Align => {
    const m = /text-align:\s*(left|right|center|justify)/i.exec(attrs);
    return m && (m[1] === "center" || m[1] === "right") ? (m[1] as Align) : "left";
  };

  const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)\/?>|([^<]+)/g;
  for (const m of html.replace(/\r/g, "").matchAll(TOKEN)) {
    if (m[4] != null) {
      const text = decode(m[4]).replace(/[\s ]+/g, " ");
      if (!cur && !text.trim()) continue; // spaces between blocks
      if (href != null) linkText += text;
      add(text);
      continue;
    }
    const closing = m[1] === "/", tag = m[2].toLowerCase(), attrs = m[3] ?? "";
    switch (tag) {
      case "p": case "div":
        if (closing) close(); else open("p", alignOf(attrs));
        break;
      case "h1": case "h2": case "h3": case "h4":
        if (closing) close(); else open(tag === "h3" || tag === "h4" ? "h3" : "h2", alignOf(attrs));
        break;
      case "br": add("\n"); break;
      case "hr": close(); out.push({ kind: "hr", align: "left", indent: 0, bullet: null, quote: false, runs: [] }); break;
      case "ul": case "ol":
        close();
        if (closing) lists.pop(); else lists.push({ ordered: tag === "ol", n: 0 });
        break;
      case "li":
        close();
        if (!closing) { const l = lists[lists.length - 1]; pendingBullet = l?.ordered ? `${++l.n}.` : "•"; } else pendingBullet = null;
        break;
      case "blockquote": close(); quote = Math.max(0, quote + (closing ? -1 : 1)); break;
      case "strong": case "b": style.bold = Math.max(0, style.bold + (closing ? -1 : 1)); break;
      case "em": case "i": style.italic = Math.max(0, style.italic + (closing ? -1 : 1)); break;
      case "u": style.underline = Math.max(0, style.underline + (closing ? -1 : 1)); break;
      case "s": case "strike": case "del": style.strike = Math.max(0, style.strike + (closing ? -1 : 1)); break;
      case "a":
        if (!closing) {
          href = decode(/href="([^"]*)"/i.exec(attrs)?.[1] ?? "");
          linkText = "";
          style.link++;
        } else {
          style.link = Math.max(0, style.link - 1);
          // On paper nobody can click: print the address after the words.
          const shown = linkText.trim(), address = (href ?? "").replace(/^mailto:|^tel:/i, "");
          if (address && shown && shown.replace(/\/$/, "") !== address.replace(/\/$/, "") && !address.includes(shown)) add(` (${address})`);
          href = null;
        }
        break;
      default: break;
    }
  }
  return out;
}

/* ───────────── Drawing ───────────── */

/** Standard PDF fonts cover Windows-1252: curly quotes, dashes, bullets and accents are fine; anything else becomes "?". */
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const clean = (s: string) => [...s.replace(/ /g, " ")].map((ch) => (/[\x20-\x7E\xA1-\xFF\n]/.test(ch) || CP1252_EXTRA.includes(ch) ? ch : "?")).join("");

const LEFT = 0.85 * IN, RIGHT = W - 0.85 * IN, BOTTOM = H - 0.9 * IN;
/** Where the words start on a letter's first page (under the fold, clear of both envelope windows) and on the next ones. */
const FIRST_TOP = 3.55 * IN, NEXT_TOP = 0.9 * IN;
const SIZE = { p: 11, h2: 15, h3: 12.5, hr: 11 } as const;
const BLUE = rgb(0.07, 0.3, 0.6);

type Fonts = { reg: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };
const fontFor = (f: Fonts, s: Style) => (s.bold ? (s.italic ? f.boldItalic : f.bold) : s.italic ? f.italic : f.reg);

type Piece = Style & { text: string; width: number; space: boolean };

/** One document's letters (one per customer) in a single PDF. */
export async function lettersPdf(c: PdfCompany, letters: Letter[], o: { title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(clean(o.title ?? "Document"));
  doc.setCreator("Crewdesk");
  const fonts: Fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique), boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const logo = await embedLogo(doc, c.logo);
  for (const l of letters) addLetter(doc, fonts, logo, c, l);
  if (!letters.length) doc.addPage([W, H]);
  return doc.save();
}

function addLetter(doc: PDFDocument, f: Fonts, logo: PDFImage | null, c: PdfCompany, letter: Letter) {
  const pages: PDFPage[] = [];
  let page = doc.addPage([W, H]);
  pages.push(page);
  const text = (s: string, x: number, yTop: number, size: number, font: PDFFont, color = INK) => page.drawText(clean(s), { x, y: H - yTop - size, size, font, color });

  // Letterhead: the company on the left (the envelope's top window), the logo on the right.
  let y = 0.45 * IN;
  text(c.name, 0.5 * IN, y, 11, f.bold); y += 13.5;
  for (const line of [...companyLines(c), c.phone ? formatPhone(c.phone) : "", c.email ?? "", c.website ?? ""].filter(Boolean)) { text(line, 0.5 * IN, y, 9, f.reg, MUTED); y += 11; }
  if (logo) {
    const s = Math.min((2.2 * IN) / logo.width, (0.95 * IN) / logo.height);
    page.drawImage(logo, { x: W - 0.5 * IN - logo.width * s, y: H - 0.45 * IN - logo.height * s, width: logo.width * s, height: logo.height * s });
  }
  // Who it's for (the bottom window: 2.1" from the top, 0.85" from the left).
  let ty = 2.1 * IN;
  text(letter.toName, LEFT, ty, 10.5, f.bold); ty += 13;
  for (const line of letter.toLines) { text(line, LEFT, ty, 10, f.reg); ty += 12; }

  y = FIRST_TOP;
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); y = NEXT_TOP; };

  for (const b of letterBlocks(letter.html)) {
    if (b.kind === "hr") {
      if (y + 14 > BOTTOM) newPage();
      page.drawLine({ start: { x: LEFT, y: H - y - 5 }, end: { x: RIGHT, y: H - y - 5 }, thickness: 0.7, color: LINE });
      y += 14;
      continue;
    }
    const size = SIZE[b.kind], lead = size * 1.42;
    const x0 = LEFT + b.indent * 18, width = RIGHT - x0;
    if (b.kind !== "p" && y > FIRST_TOP) y += 4;
    // Words and spaces, measured.
    const lines: Piece[][] = [[]];
    let used = 0;
    const push = (p: Piece) => { lines[lines.length - 1].push(p); used += p.width; };
    const wrapLine = () => { const l = lines[lines.length - 1]; while (l.length && l[l.length - 1].space) l.pop(); lines.push([]); used = 0; };
    for (const r of b.runs) {
      const font = fontFor(f, r);
      for (const part of clean(r.text).split(/(\n| )/)) {
        if (!part) continue;
        if (part === "\n") { wrapLine(); continue; }
        if (part === " ") { if (used > 0) push({ ...r, text: " ", width: font.widthOfTextAtSize(" ", size), space: true }); continue; }
        let word = part, w = font.widthOfTextAtSize(word, size);
        if (used > 0 && used + w > width) wrapLine();
        // A word longer than the line (a long address): break it where it fits.
        while (w > width && word.length > 1) {
          let n = word.length - 1;
          while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > width) n--;
          push({ ...r, text: word.slice(0, n), width: font.widthOfTextAtSize(word.slice(0, n), size), space: false });
          wrapLine();
          word = word.slice(n); w = font.widthOfTextAtSize(word, size);
        }
        push({ ...r, text: word, width: w, space: false });
      }
    }
    const last = lines[lines.length - 1];
    while (last.length && last[last.length - 1].space) last.pop();

    // A heading stays with the line after it.
    if (b.kind !== "p" && y + lead * 2.4 > BOTTOM && y > NEXT_TOP) newPage();
    lines.forEach((line, i) => {
      if (y + lead > BOTTOM) newPage();
      if (b.quote) page.drawLine({ start: { x: x0 - 9, y: H - y + 1 }, end: { x: x0 - 9, y: H - y - lead + 1 }, thickness: 1.6, color: LINE });
      if (i === 0 && b.bullet) {
        const bw = f.reg.widthOfTextAtSize(b.bullet, size);
        page.drawText(b.bullet, { x: x0 - 5 - bw, y: H - y - size, size, font: f.reg, color: INK });
      }
      const total = line.reduce((s, p) => s + p.width, 0);
      let x = b.align === "center" ? x0 + (width - total) / 2 : b.align === "right" ? x0 + width - total : x0;
      for (const p of line) {
        const color = p.link ? BLUE : INK;
        if (!p.space) page.drawText(p.text, { x, y: H - y - size, size, font: fontFor(f, p), color });
        if (p.underline) page.drawLine({ start: { x, y: H - y - size - 1.6 }, end: { x: x + p.width, y: H - y - size - 1.6 }, thickness: 0.6, color });
        if (p.strike) page.drawLine({ start: { x, y: H - y - size * 0.68 }, end: { x: x + p.width, y: H - y - size * 0.68 }, thickness: 0.6, color });
        x += p.width;
      }
      y += lead;
    });
    // Space after a paragraph or heading; list items sit closer together.
    y += b.bullet ? 2.5 : b.kind === "p" ? 6.5 : 5;
  }

  // "Page 2 of 3" only when a letter runs over one page.
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const s = `Page ${i + 1} of ${pages.length}`;
      p.drawText(s, { x: W - 0.5 * IN - f.reg.widthOfTextAtSize(s, 8.5), y: 0.45 * IN, size: 8.5, font: f.reg, color: MUTED });
    });
  }
}

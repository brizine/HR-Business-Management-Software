import { z } from "zod";

/**
 * Email designs: what the email template builder (Marketing → Templates) makes. A design is rows,
 * each with one or more columns, each holding content blocks (title, paragraph, image, button…),
 * plus page settings — the same shape Homeworks' builder uses, so its templates open as blocks.
 * `renderDesign` turns one into email-safe HTML (tables and inline styles, columns that stack on a
 * phone). Every setting is read defensively, so a design can never put anything but its own
 * colours, sizes and words into an email.
 */

/** A template body that came from a design starts with this (so it's sent as designed, not in the plain letter frame). */
export const DESIGN_MARK = "<!--crewdesk-design-->";
export const isDesignedBody = (body: string | null | undefined) => !!body && body.startsWith(DESIGN_MARK);

export const EMAIL_FONTS: [string, string][] = [
  ["Arial", "Arial, Helvetica Neue, Helvetica, sans-serif"],
  ["Courier", "'Courier New', Courier, 'Lucida Sans Typewriter', monospace"],
  ["Georgia", "Georgia, Times, 'Times New Roman', serif"],
  ["Helvetica", "Helvetica Neue, Helvetica, Arial, sans-serif"],
  ["Lucida Sans", "'Lucida Sans Unicode', 'Lucida Grande', 'Lucida Sans', Geneva, Verdana, sans-serif"],
  ["Tahoma", "Tahoma, Verdana, Segoe, sans-serif"],
  ["Times New Roman", "TimesNewRoman, 'Times New Roman', Times, Baskerville, Georgia, serif"],
  ["Trebuchet MS", "'Trebuchet MS', 'Lucida Grande', 'Lucida Sans Unicode', Tahoma, sans-serif"],
  ["Verdana", "Verdana, Geneva, sans-serif"],
];

export const BLOCK_TYPES = ["title", "paragraph", "list", "image", "button", "table", "divider", "spacer", "social", "html", "video", "icons", "menu", "text"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
/** The tiles on the builder's Content tab, in Homeworks' order and words. */
export const BLOCK_LABELS: Record<BlockType, string> = {
  title: "Title", paragraph: "Paragraph", list: "List", image: "Image", button: "Button", table: "Table", divider: "Divider", spacer: "Spacer",
  social: "Social", html: "HTML", video: "Video", icons: "Icons", menu: "Menu", text: "Text",
};
/** The column layouts on the Rows tab (twelfths). */
export const ROW_LAYOUTS: number[][] = [[12], [3, 9], [4, 8], [6, 6], [8, 4], [9, 3], [4, 4, 4], [3, 3, 3, 3], [2, 2, 2, 2, 2, 2]];

export const SOCIAL_NETWORKS: Record<string, { label: string; color: string; mark: string; url: string }> = {
  facebook: { label: "Facebook", color: "#1877f2", mark: "f", url: "https://www.facebook.com/" },
  x: { label: "X", color: "#000000", mark: "X", url: "https://x.com/" },
  instagram: { label: "Instagram", color: "#e4405f", mark: "ig", url: "https://instagram.com/" },
  linkedin: { label: "LinkedIn", color: "#0a66c2", mark: "in", url: "https://www.linkedin.com/" },
  youtube: { label: "YouTube", color: "#ff0000", mark: "▶", url: "https://www.youtube.com/" },
  tiktok: { label: "TikTok", color: "#111111", mark: "♪", url: "https://www.tiktok.com/" },
  google: { label: "Google", color: "#4285f4", mark: "G", url: "https://www.google.com/" },
  nextdoor: { label: "Nextdoor", color: "#00b246", mark: "n", url: "https://nextdoor.com/" },
  yelp: { label: "Yelp", color: "#d32323", mark: "y", url: "https://www.yelp.com/" },
  website: { label: "Website", color: "#555555", mark: "www", url: "https://" },
  email: { label: "Email", color: "#555555", mark: "@", url: "mailto:" },
  phone: { label: "Phone", color: "#2e7d32", mark: "☎", url: "tel:" },
};

export type Props = Record<string, string | number | boolean>;
export type Item = Record<string, string>;
export type Block = { id: string; type: BlockType; p: Props; items?: Item[]; cells?: string[][] };
export type Column = { id: string; span: number; p: Props; blocks: Block[] };
export type Row = { id: string; p: Props; columns: Column[] };
export type EmailDesign = { v: 1; p: Props; rows: Row[] };

/* ───────────── Saving ───────────── */

const prop = z.union([z.string().max(60_000), z.number().finite(), z.boolean()]);
const props = z.record(z.string().regex(/^[a-zA-Z]{1,24}$/), prop).refine((o) => Object.keys(o).length <= 60, "Too many settings");
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const item = z.record(z.string().regex(/^[a-z]{1,12}$/), z.string().max(2000));
const blockSchema = z.object({
  id, type: z.enum(BLOCK_TYPES), p: props,
  items: z.array(item).max(30).optional(),
  cells: z.array(z.array(z.string().max(2000)).max(8)).max(60).optional(),
});
export const emailDesignSchema = z.object({
  v: z.literal(1),
  p: props,
  rows: z.array(z.object({
    id, p: props,
    columns: z.array(z.object({ id, span: z.number().int().min(1).max(12), p: props, blocks: z.array(blockSchema).max(60) })).min(1).max(6),
  })).max(60),
});

/* ───────────── What new things start as ───────────── */

let seq = 0;
/** A short id, unique enough inside one design. */
export const designId = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const TEXT: Props = { font: "", weight: "400", size: 14, color: "#000000", linkColor: "#0068a5", align: "left", lineHeight: 1.2, letterSpacing: 0, paraSpacing: 16 };
const pad = (n: number): Props => ({ padTop: n, padRight: n, padBottom: n, padLeft: n });
export const DESIGN_DEFAULTS: Props = { width: 500, align: "center", bg: "#ffffff", contentBg: "transparent", font: "Arial", linkColor: "#0068a5", preheader: "" };
export const ROW_DEFAULTS: Props = { bg: "transparent", contentBg: "transparent", borderWidth: 0, borderStyle: "solid", borderColor: "transparent", radius: 0, hideOn: "", stack: true, valign: "top" };
export const COLUMN_DEFAULTS: Props = { bg: "transparent", padTop: 5, padBottom: 5, padLeft: 0, padRight: 0, borderWidth: 0, borderStyle: "solid", borderColor: "transparent" };
export const BLOCK_DEFAULTS: Record<BlockType, { p: Props; items?: Item[]; cells?: string[][] }> = {
  title: { p: { ...TEXT, level: "h1", html: "I'm a new title block", weight: "700", size: 23, color: "#555555", ...pad(10), hideOn: "" } },
  paragraph: { p: { ...TEXT, html: "<p>I'm a new paragraph block.</p>", ...pad(10), hideOn: "" } },
  list: { p: { ...TEXT, listType: "ul", html: "<ul><li>This is an unordered list</li></ul>", ...pad(10), hideOn: "" } },
  text: { p: { ...TEXT, html: "<p>I'm a new Text block ready for your content.</p>", color: "#555555", ...pad(10), hideOn: "" } },
  image: { p: { src: "", alt: "", href: "", autoWidth: true, width: 100, align: "center", fullMobile: false, ...pad(0), hideOn: "" } },
  button: { p: { text: "Button", href: "", autoWidth: true, width: 100, font: "", weight: "400", size: 14, bg: "#3aaee0", color: "#ffffff", align: "center", lineHeight: 2, radius: 4, cPadTop: 5, cPadBottom: 5, cPadLeft: 20, cPadRight: 20, borderWidth: 0, borderStyle: "solid", borderColor: "transparent", ...pad(10), hideOn: "" } },
  divider: { p: { transparent: false, style: "solid", lineWidth: 1, color: "#bbbbbb", width: 100, align: "center", ...pad(10), hideOn: "" } },
  spacer: { p: { height: 60, hideOn: "" } },
  social: { p: { align: "center", spacing: 5, size: 32, ...pad(10), hideOn: "" }, items: ["facebook", "x", "instagram", "linkedin"].map((net) => ({ net, url: SOCIAL_NETWORKS[net].url })) },
  html: { p: { html: '<div class="our-class"> I\'m a new HTML block. </div>', hideOn: "" } },
  video: { p: { url: "", ...pad(0), hideOn: "" } },
  icons: { p: { font: "", weight: "400", size: 14, color: "#000000", align: "center", iconSize: 32, spacing: 5, ...pad(0), hideOn: "" }, items: [] },
  menu: { p: { font: "", weight: "400", size: 14, color: "#000000", linkColor: "#0068a5", align: "center", separator: "", spacing: 5, ...pad(0), hideOn: "" }, items: [] },
  table: {
    p: { header: true, headerBg: "#eaeaea", headerColor: "#505659", headerWeight: "700", borderWidth: 1, borderStyle: "solid", borderColor: "#dddddd", bg: "transparent", alternate: false, font: "", weight: "400", size: 14, color: "#000000", align: "left", lineHeight: 1.2, ...pad(10), hideOn: "" },
    cells: [["Add header text", "", ""], ["Add text", "", ""], ["", "", ""], ["", "", ""]],
  },
};

export const newBlock = (type: BlockType): Block => {
  const d = BLOCK_DEFAULTS[type];
  return { id: designId(), type, p: { ...d.p }, ...(d.items ? { items: d.items.map((i) => ({ ...i })) } : {}), ...(d.cells ? { cells: d.cells.map((r) => [...r]) } : {}) };
};
export const newRow = (spans: number[] = [12], blocks: Block[] = []): Row => ({
  id: designId(), p: { ...ROW_DEFAULTS },
  columns: spans.map((span, i) => ({ id: designId(), span, p: { ...COLUMN_DEFAULTS }, blocks: i === 0 ? blocks : [] })),
});
export const emptyDesign = (): EmailDesign => ({ v: 1, p: { ...DESIGN_DEFAULTS }, rows: [] });

/* ───────────── Reading settings safely ───────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\))$/;
const col = (v: unknown, d: string) => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : d);
const num = (v: unknown, d: number, min: number, max: number) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const one = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const on = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
const STYLES = ["solid", "dashed", "dotted"] as const;
const fontStack = (name: unknown, fallback: string) => EMAIL_FONTS.find(([n]) => n === name)?.[1] ?? fallback;
/** A link's address: a web, email or phone address, or a tag like {{ESTIMATE_LINK}} that's filled in when sent. */
export const safeHref = (v: unknown) => { const s = str(v).trim(); return /^(https?:\/\/|mailto:|tel:)[^\s"<>]+$/i.test(s) || /^\{\{\s*[A-Z0-9_]+\s*\}\}$/.test(s) ? s : ""; };
const padding = (p: Props, d = 0) => `${num(p.padTop, d, 0, 120)}px ${num(p.padRight, d, 0, 120)}px ${num(p.padBottom, d, 0, 120)}px ${num(p.padLeft, d, 0, 120)}px`;
const hideClass = (p: Props) => (p.hideOn === "desktop" ? " cd-hide-d" : p.hideOn === "mobile" ? " cd-hide-m" : "");
const border = (p: Props) => { const w = num(p.borderWidth, 0, 0, 30); return w ? `${w}px ${one(p.borderStyle, STYLES, "solid")} ${col(p.borderColor, "transparent")}` : ""; };

/** YouTube's still picture for a video address (other sites have none we can link to). */
export function videoThumb(url: string): string | null {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/.exec(url);
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : null;
}

/* ───────────── The email ───────────── */

function textStyle(p: Props, base: string) {
  return `font-family:${fontStack(p.font, base)};font-size:${num(p.size, 14, 6, 120)}px;font-weight:${one(str(p.weight), ["400", "700"], "400")};color:${col(p.color, "#000000")};` +
    `line-height:${num(p.lineHeight, 1.2, 0.8, 4)};letter-spacing:${num(p.letterSpacing, 0, -5, 30)}px;text-align:${one(p.align, ["left", "center", "right", "justify"], "left")}`;
}
/** Paragraph gaps and link colours, written into the words themselves (email programs ignore style sheets). */
function inlineText(html: string, gap: number, link: string) {
  const total = (html.match(/<p[\s>]/g) ?? []).length;
  let n = 0;
  return html
    .replace(/<p(\s[^>]*)?>/g, () => `<p style="margin:0${++n < total ? ` 0 ${gap}px 0` : ""}">`)
    .replace(/<a\s/g, `<a style="color:${link};text-decoration:underline" `);
}

function renderBlock(b: Block, base: string, colWidth: number): string {
  const p = b.p;
  const wrap = (inner: string, d = 0, extra = "") => `<div class="cd-block${hideClass(p)}" style="padding:${padding(p, d)}${extra}">${inner}</div>`;
  const link = col(p.linkColor, "#0068a5");
  const align = one(p.align, ["left", "center", "right"], "center");
  switch (b.type) {
    case "title": {
      const tag = one(p.level, ["h1", "h2", "h3"], "h1");
      return wrap(`<${tag} style="margin:0;${textStyle(p, base)}">${inlineText(str(p.html), 0, link)}</${tag}>`, 10);
    }
    case "paragraph": case "text":
      return wrap(`<div style="${textStyle(p, base)}">${inlineText(str(p.html), num(p.paraSpacing, 16, 0, 80), link)}</div>`, 10);
    case "list": {
      const html = inlineText(str(p.html), 0, link).replace(/<(ul|ol)(\s[^>]*)?>/g, `<$1 style="margin:0;padding:0 0 0 40px">`);
      return wrap(`<div style="${textStyle(p, base)}">${html}</div>`, 10);
    }
    case "image": {
      const src = safeHref(p.src);
      if (!src) return "";
      const w = on(p.autoWidth, true) ? "" : ` width="${Math.round(colWidth * num(p.width, 100, 5, 100) / 100)}"`;
      const img = `<img src="${esc(src)}" alt="${esc(str(p.alt))}"${w} class="${on(p.fullMobile) ? "cd-full-m" : ""}" style="display:inline-block;max-width:100%;height:auto;border:0;outline:none;text-decoration:none">`;
      const href = safeHref(p.href);
      return wrap(href ? `<a href="${esc(href)}" target="_blank" style="text-decoration:none">${img}</a>` : img, 0, `;text-align:${align};line-height:0`);
    }
    case "button": {
      const href = safeHref(p.href);
      const bg = col(p.bg, "#3aaee0"), radius = num(p.radius, 4, 0, 60), bd = border(p);
      const a = `<a href="${esc(href || "#")}" target="_blank" style="display:${on(p.autoWidth, true) ? "inline-block" : "block"};font-family:${fontStack(p.font, base)};font-size:${num(p.size, 14, 6, 80)}px;font-weight:${one(str(p.weight), ["400", "700"], "400")};` +
        `line-height:${num(p.lineHeight, 2, 0.8, 4)};color:${col(p.color, "#ffffff")};text-decoration:none;text-align:center;padding:${num(p.cPadTop, 5, 0, 60)}px ${num(p.cPadRight, 20, 0, 80)}px ${num(p.cPadBottom, 5, 0, 60)}px ${num(p.cPadLeft, 20, 0, 80)}px;border-radius:${radius}px">${esc(str(p.text) || "Button")}</a>`;
      return wrap(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}"${on(p.autoWidth, true) ? "" : ` width="${num(p.width, 100, 10, 100)}%"`} style="border-collapse:separate"><tr>` +
        `<td align="center" bgcolor="${bg === "transparent" ? "" : bg}" style="background:${bg};border-radius:${radius}px${bd ? `;border:${bd}` : ""}">${a}</td></tr></table>`, 10, `;text-align:${align}`);
    }
    case "divider": {
      const line = on(p.transparent) ? "0" : `${num(p.lineWidth, 1, 1, 30)}px ${one(p.style, STYLES, "solid")} ${col(p.color, "#bbbbbb")}`;
      return wrap(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${num(p.width, 100, 1, 100)}%" align="${align}"><tr><td style="border-top:${line};font-size:1px;line-height:1px">&nbsp;</td></tr></table>`, 10);
    }
    case "spacer": {
      const h = num(p.height, 60, 1, 400);
      return `<div class="cd-block${hideClass(p)}" style="height:${h}px;line-height:${h}px;font-size:1px">&nbsp;</div>`;
    }
    case "social": {
      const size = num(p.size, 32, 16, 64), gap = num(p.spacing, 5, 0, 40);
      const cells = (b.items ?? []).map((i) => {
        const n = SOCIAL_NETWORKS[i.net];
        const href = safeHref(i.url);
        if (!n || !href) return "";
        return `<td style="padding:0 ${gap}px"><a href="${esc(href)}" target="_blank" title="${esc(n.label)}" style="display:block;width:${size}px;height:${size}px;line-height:${size}px;border-radius:${size}px;background:${n.color};color:#ffffff;` +
          `font-family:Arial,Helvetica,sans-serif;font-size:${Math.round(size * (n.mark.length > 2 ? 0.34 : n.mark.length > 1 ? 0.42 : 0.56))}px;font-weight:700;text-align:center;text-decoration:none">${esc(n.mark)}</a></td>`;
      }).join("");
      return cells ? wrap(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}"><tr>${cells}</tr></table>`, 10, `;text-align:${align}`) : "";
    }
    case "html": return `<div class="cd-block${hideClass(p)}">${str(p.html)}</div>`;
    case "video": {
      const href = safeHref(p.url);
      if (!href) return "";
      const thumb = videoThumb(href);
      const inner = thumb
        ? `<a href="${esc(href)}" target="_blank" style="text-decoration:none"><img src="${thumb}" alt="Watch the video" style="display:inline-block;max-width:100%;height:auto;border:0"></a>`
        : `<a href="${esc(href)}" target="_blank" style="font-family:${base};font-size:15px;color:#0068a5">▶ Watch the video</a>`;
      return wrap(inner, 0, ";text-align:center");
    }
    case "icons": {
      const size = num(p.iconSize, 32, 12, 120), gap = num(p.spacing, 5, 0, 40);
      const cells = (b.items ?? []).map((i) => {
        const src = safeHref(i.src), href = safeHref(i.url);
        const inner = `${src ? `<img src="${esc(src)}" alt="${esc(i.text ?? "")}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;border:0">` : ""}${i.text ? `<span style="vertical-align:middle;padding-left:${src ? 6 : 0}px">${esc(i.text)}</span>` : ""}`;
        if (!inner) return "";
        return `<td style="padding:0 ${gap}px;font-family:${fontStack(p.font, base)};font-size:${num(p.size, 14, 6, 80)}px;font-weight:${one(str(p.weight), ["400", "700"], "400")};color:${col(p.color, "#000000")}">${href ? `<a href="${esc(href)}" target="_blank" style="color:${col(p.color, "#000000")};text-decoration:none">${inner}</a>` : inner}</td>`;
      }).join("");
      return cells ? wrap(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}"><tr>${cells}</tr></table>`, 0, `;text-align:${align}`) : "";
    }
    case "menu": {
      const gap = num(p.spacing, 5, 0, 40), sep = esc(str(p.separator).slice(0, 3));
      const links = (b.items ?? []).filter((i) => i.text).map((i) => {
        const href = safeHref(i.url);
        return `<span style="display:inline-block;padding:${gap}px ${gap * 2}px">${href ? `<a href="${esc(href)}" target="_blank" style="color:${link};text-decoration:none">${esc(i.text)}</a>` : esc(i.text)}</span>`;
      });
      return links.length ? wrap(`<div style="font-family:${fontStack(p.font, base)};font-size:${num(p.size, 14, 6, 80)}px;font-weight:${one(str(p.weight), ["400", "700"], "400")};color:${col(p.color, "#000000")};text-align:${align}">${links.join(sep ? `<span>${sep}</span>` : "")}</div>`, 0) : "";
    }
    case "table": {
      const cells = b.cells ?? [];
      if (!cells.length) return "";
      const bd = `${num(p.borderWidth, 1, 0, 30)}px ${one(p.borderStyle, STYLES, "solid")} ${col(p.borderColor, "#dddddd")}`;
      const cols = Math.max(1, ...cells.map((r) => r.length));
      const rows = cells.map((r, ri) => {
        const head = ri === 0 && on(p.header, true);
        const bg = head ? col(p.headerBg, "#eaeaea") : on(p.alternate) && ri % 2 === 0 ? "#f5f5f5" : col(p.bg, "transparent");
        return `<tr>${Array.from({ length: cols }, (_, ci) => `<${head ? "th" : "td"} width="${Math.round(100 / cols)}%" style="border:${bd};padding:10px;background:${bg};` +
          `${head ? `color:${col(p.headerColor, "#505659")};font-weight:${one(str(p.headerWeight), ["400", "700"], "700")}` : `color:${col(p.color, "#000000")};font-weight:${one(str(p.weight), ["400", "700"], "400")}`};text-align:${one(p.align, ["left", "center", "right"], "left")}">${esc(r[ci] ?? "") || "&nbsp;"}</${head ? "th" : "td"}>`).join("")}</tr>`;
      }).join("");
      return wrap(`<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:${fontStack(p.font, base)};font-size:${num(p.size, 14, 6, 80)}px;line-height:${num(p.lineHeight, 1.2, 0.8, 4)}">${rows}</table>`, 10);
    }
  }
}

/** One block as it looks in the email (the builder shows blocks this way too). `colWidth` is its column's width in pixels. */
export const renderDesignBlock = (b: Block, design: EmailDesign, colWidth = 500) => renderBlock(b, fontStack(design.p.font, EMAIL_FONTS[0][1]), colWidth);

/** The style sheet a designed email needs (phones stack the columns; hide-on rules). */
export const DESIGN_CSS = "@media (max-width:620px){.cd-row{width:100%!important}.cd-stack .cd-col{display:block!important;width:100%!important;box-sizing:border-box}.cd-hide-m{display:none!important}.cd-full-m{width:100%!important}}@media (min-width:621px){.cd-hide-d{display:none!important}}";

/** The whole design as email HTML (the part between the page's top and Crewdesk's footer), starting with `DESIGN_MARK`. */
export function renderDesign(d: EmailDesign): string {
  const width = num(d.p.width, 500, 320, 900), align = one(d.p.align, ["left", "center"], "center");
  const base = fontStack(d.p.font, EMAIL_FONTS[0][1]);
  const pre = str(d.p.preheader).trim();
  const pageBg = col(d.p.contentBg, "transparent");
  const rows = d.rows.map((r) => {
    const bd = border(r.p), radius = num(r.p.radius, 0, 0, 60);
    const total = r.columns.reduce((s, c) => s + c.span, 0) || 12;
    const cols = r.columns.map((c) => {
      const w = Math.round(width * c.span / total);
      const inner = w - num(c.p.padLeft, 0, 0, 120) - num(c.p.padRight, 0, 0, 120);
      const cb = border(c.p);
      return `<td class="cd-col" width="${Math.round(c.span / total * 1000) / 10}%" valign="${one(r.p.valign, ["top", "middle", "bottom"], "top")}" style="background:${col(c.p.bg, "transparent")};padding:${padding(c.p)}${cb ? `;border:${cb}` : ""}">` +
        `${c.blocks.map((b) => renderBlock(b, base, inner)).join("") || "&nbsp;"}</td>`;
    }).join("");
    // The row's own colour runs the full width of the email; its content area is the email's width.
    const own = col(r.p.contentBg, "transparent");
    return `<table role="presentation" class="cd-row-wrap${hideClass(r.p)}" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${col(r.p.bg, "transparent")}"><tr><td align="${align}">` +
      `<table role="presentation" class="cd-row${on(r.p.stack, true) ? " cd-stack" : ""}" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;max-width:100%;background:${own === "transparent" ? pageBg : own}${bd ? `;border:${bd}` : ""}${radius ? `;border-radius:${radius}px` : ""}"><tr>${cols}</tr></table>` +
      `</td></tr></table>`;
  }).join("");
  return `${DESIGN_MARK}${pre ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}</div>` : ""}` +
    `<table role="presentation" class="cd-design" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${col(d.p.bg, "#ffffff")};font-family:${base};color:#000000"><tr><td>${rows}</td></tr></table>`;
}

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();
/** Whether there's anything to send: some words, an image or a button. */
export function designHasContent(d: EmailDesign): boolean {
  return d.rows.some((r) => r.columns.some((c) => c.blocks.some((b) =>
    b.type === "image" ? !!safeHref(b.p.src) : b.type === "button" ? !!str(b.p.text).trim() : b.type === "video" ? !!safeHref(b.p.url)
      : b.type === "table" ? (b.cells ?? []).some((r2) => r2.some((x) => x.trim())) : b.type === "social" || b.type === "icons" || b.type === "menu" ? !!b.items?.length
        : b.type === "divider" || b.type === "spacer" ? false : !!plain(str(b.p.html)))));
}
/** Every piece of writing in a design (to look for {{TAGS}} in). */
export function designTexts(d: EmailDesign): string[] {
  const out: string[] = [];
  for (const r of d.rows) for (const c of r.columns) for (const b of c.blocks) {
    for (const k of ["html", "text", "href", "src", "url", "alt"]) if (typeof b.p[k] === "string") out.push(b.p[k] as string);
    for (const i of b.items ?? []) out.push(...Object.values(i));
    for (const r2 of b.cells ?? []) out.push(...r2);
  }
  return out;
}

/* ───────────── Designs from elsewhere ───────────── */

const px = (v: unknown, d: number) => { const m = /-?[\d.]+/.exec(String(v ?? "")); return m ? Number(m[0]) : d; };
const fontName = (v: unknown, d: string) => { const first = String(v ?? "").split(",")[0].replace(/['"]/g, "").trim().toLowerCase(); return EMAIL_FONTS.find(([n]) => n.toLowerCase() === first || n.toLowerCase().startsWith(first))?.[0] ?? d; };
/** Homeworks' builder wraps each tag in a marker element; the tag itself is all that's needed. */
const unwrapTags = (html: string) => html.replace(/<code[^>]*data-bee-type="mergetag"[^>]*>([\s\S]*?)<\/code>/g, "$1").replace(/<\/?code[^>]*>/g, "");
type Bee = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A design from Homeworks' builder (its saved template content) as a Crewdesk design: the same
 * rows, columns and blocks with their colours, sizes and spacing. Kinds of block Crewdesk doesn't
 * have are left out and counted in `skipped`.
 */
export function beeToDesign(bee: unknown): { design: EmailDesign; skipped: number } {
  const page: Bee = (bee as Bee)?.page ?? {};
  let skipped = 0;
  const body = page.body ?? {};
  const design: EmailDesign = {
    v: 1,
    p: {
      ...DESIGN_DEFAULTS, width: px(body.content?.computedStyle?.messageWidth, 500), bg: col(body.container?.style?.["background-color"], "#ffffff"),
      contentBg: col(body.content?.computedStyle?.messageBackgroundColor, "transparent"), font: fontName(body.content?.style?.["font-family"], "Arial"), linkColor: col(body.content?.computedStyle?.linkColor, "#0068a5"),
    },
    rows: [],
  };
  const text = (s: Bee | undefined): Props => ({
    font: s?.["font-family"] && s["font-family"] !== "inherit" ? fontName(s["font-family"], "") : "", weight: String(s?.["font-weight"] ?? "400") === "700" || s?.["font-weight"] === "bold" ? "700" : "400",
    size: px(s?.["font-size"], 14), color: col(s?.color, "#000000"), align: one(s?.["text-align"], ["left", "center", "right", "justify"], "left"),
    lineHeight: /%/.test(String(s?.["line-height"] ?? "")) ? px(s?.["line-height"], 120) / 100 : px(s?.["line-height"], 1.2), letterSpacing: px(s?.["letter-spacing"], 0),
  });
  const pads = (s: Bee | undefined, d: number): Props => ({ padTop: px(s?.["padding-top"], d), padRight: px(s?.["padding-right"], d), padBottom: px(s?.["padding-bottom"], d), padLeft: px(s?.["padding-left"], d) });
  const hide = (cs: Bee | undefined) => (cs?.hideContentOnDesktop ? "desktop" : cs?.hideContentOnMobile ? "mobile" : "");
  const borderOf = (s: Bee | undefined): Props => { const m = /^([\d.]+)(?:px)?\s+(\w+)\s+(.+)$/.exec(String(s?.["border-top"] ?? "")); return { borderWidth: m ? Number(m[1]) : 0, borderStyle: one(m?.[2], STYLES, "solid"), borderColor: col(m?.[3], "transparent") }; };
  for (const r of (page.rows ?? []) as Bee[]) {
    const row: Row = {
      id: designId(),
      p: { ...ROW_DEFAULTS, bg: col(r.container?.style?.["background-color"], "transparent"), contentBg: col(r.content?.style?.["background-color"], "transparent"), stack: r.content?.computedStyle?.rowColStackOnMobile !== false,
        valign: one(r.content?.computedStyle?.verticalAlign, ["top", "middle", "bottom"], "top"), hideOn: hide(r.content?.computedStyle) },
      columns: [],
    };
    for (const c of (r.columns ?? []) as Bee[]) {
      const column: Column = { id: designId(), span: Math.min(12, Math.max(1, Number(c["grid-columns"]) || 12)), p: { ...COLUMN_DEFAULTS, bg: col(c.style?.["background-color"], "transparent"), ...pads(c.style, 0), ...borderOf(c.style) }, blocks: [] };
      for (const m of (c.modules ?? []) as Bee[]) {
        const kind = String(m.type ?? "").replace("mailup-bee-newsletter-modules-", "");
        const d = m.descriptor ?? {};
        const common = { ...pads(d.style, 0), hideOn: hide(d.computedStyle) };
        const make = (type: BlockType, p: Props, extra: Partial<Block> = {}) => column.blocks.push({ id: designId(), type, p: { ...BLOCK_DEFAULTS[type].p, ...p, ...common }, ...extra });
        if (kind === "heading") make("title", { ...text(d.heading?.style), linkColor: col(d.heading?.style?.["link-color"], "#0068a5"), level: one(d.heading?.title, ["h1", "h2", "h3"], "h1"), html: unwrapTags(String(d.heading?.text ?? "")) });
        else if (kind === "paragraph" || kind === "text") make(kind === "text" ? "text" : "paragraph", { ...text(d.paragraph?.style ?? d.text?.style), linkColor: col((d.paragraph ?? d.text)?.computedStyle?.linkColor, "#0068a5"), paraSpacing: px(d.paragraph?.computedStyle?.paragraphSpacing, 16), html: unwrapTags(String(d.paragraph?.html ?? d.text?.html ?? "")) });
        else if (kind === "list") make("list", { ...text(d.list?.style), linkColor: col(d.list?.computedStyle?.linkColor, "#0068a5"), listType: one(d.list?.tag, ["ul", "ol"], "ul"), html: unwrapTags(String(d.list?.html ?? "")) });
        else if (kind === "image") {
          const cls = String(d.computedStyle?.class ?? "");
          make("image", { src: String(d.image?.src ?? ""), alt: String(d.image?.alt ?? ""), href: String(d.image?.href ?? ""), autoWidth: cls.includes("autowidth") || !d.computedStyle?.width, align: one(cls.split(" ")[0], ["left", "center", "right"], "center"), fullMobile: cls.includes("fullwidthOnMobile"),
            width: Math.min(100, Math.max(5, Math.round(px(d.computedStyle?.width, design.p.width as number) / (design.p.width as number) * 100))) });
        } else if (kind === "button") {
          const s = d.button?.style ?? {};
          make("button", { text: plain(unwrapTags(String(d.button?.label ?? "Button"))), href: String(d.button?.href ?? ""), ...text(s), bg: col(s["background-color"], "#3aaee0"), color: col(s.color, "#ffffff"), align: one(d.style?.["text-align"], ["left", "center", "right"], "center"),
            radius: px(s["border-radius"], 4), cPadTop: px(s["padding-top"], 5), cPadBottom: px(s["padding-bottom"], 5), cPadLeft: px(s["padding-left"], 20), cPadRight: px(s["padding-right"], 20), lineHeight: 2 });
        } else if (kind === "divider") {
          const m2 = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(String(d.divider?.style?.["border-top"] ?? ""));
          make("divider", { lineWidth: m2 ? Number(m2[1]) : 1, style: one(m2?.[2], STYLES, "solid"), color: col(m2?.[3], "#bbbbbb"), transparent: m2?.[3] === "transparent", width: px(d.divider?.style?.width, 100) });
        } else if (kind === "spacer") make("spacer", { height: px(d.spacer?.style?.height, 60) });
        else if (kind === "html") make("html", { html: String(d.html?.html ?? "") });
        else skipped++;
      }
      row.columns.push(column);
    }
    if (row.columns.length) design.rows.push(row);
  }
  return { design, skipped };
}

/**
 * A plain template (the earlier editor's formatted text) as a design: headings become titles,
 * lists become list blocks, lines become dividers and the rest paragraphs, on a white page
 * 600 wide, with the company's logo on top when it has one (as those emails were framed).
 */
export function htmlToDesign(html: string, o: { logoUrl?: string | null } = {}): EmailDesign {
  const blocks: Block[] = [];
  if (o.logoUrl) blocks.push({ ...newBlock("image"), p: { ...BLOCK_DEFAULTS.image.p, src: o.logoUrl, alt: "Logo", autoWidth: false, width: 40, align: "left", ...pad(10) } });
  let paras = "";
  const flush = () => { if (plain(paras) || /<img/.test(paras)) blocks.push({ ...newBlock("paragraph"), p: { ...BLOCK_DEFAULTS.paragraph.p, size: 15, lineHeight: 1.5, color: "#1d2939", html: paras } }); paras = ""; };
  const TOP = /<(p|h1|h2|h3|ul|ol|blockquote)(\s[^>]*)?>([\s\S]*?)<\/\1>|<hr\s*\/?>/g;
  let last = 0;
  for (const m of html.replace(DESIGN_MARK, "").matchAll(TOP)) {
    const between = html.slice(last, m.index).trim();
    if (plain(between)) paras += `<p>${between}</p>`;
    last = (m.index ?? 0) + m[0].length;
    const tag = m[1];
    if (!tag) { flush(); blocks.push(newBlock("divider")); }
    else if (tag === "p" || tag === "blockquote") paras += tag === "p" ? `<p>${m[3]}</p>` : `<p><em>${plain(m[3])}</em></p>`;
    else if (tag === "ul" || tag === "ol") { flush(); blocks.push({ ...newBlock("list"), p: { ...BLOCK_DEFAULTS.list.p, size: 15, lineHeight: 1.5, color: "#1d2939", listType: tag, html: `<${tag}>${m[3]}</${tag}>` } }); }
    else { flush(); blocks.push({ ...newBlock("title"), p: { ...BLOCK_DEFAULTS.title.p, level: tag === "h3" ? "h3" : "h2", size: tag === "h3" ? 17 : 20, color: "#1d2939", align: /text-align:\s*center/.test(m[2] ?? "") ? "center" : "left", html: m[3] } }); }
  }
  const rest = html.slice(last).trim();
  if (plain(rest)) paras += `<p>${rest}</p>`;
  flush();
  const row = newRow([12], blocks);
  row.p.contentBg = "#ffffff";
  row.columns[0].p = { ...COLUMN_DEFAULTS, padTop: 14, padBottom: 14, padLeft: 14, padRight: 14 };
  return { v: 1, p: { ...DESIGN_DEFAULTS, width: 600, bg: "#f5f6f8" }, rows: blocks.length ? [row] : [] };
}

/* ───────────── Saved rows and the company's own header ───────────── */

/**
 * A saved row is a row kept by name (a header, a footer) and used in many templates. A row in a
 * design that came from one carries its id in `p.saved` (and its name in `p.savedName`): it's the
 * same everywhere, so changing the saved row changes every template that uses it.
 */
export type SavedRow = { id: string; name: string; row: Row };
export const emailRowSchema = emailDesignSchema.shape.rows.element;
export const savedRowSchema = z.object({ name: z.string().trim().min(1, "Name the row").max(60), row: emailRowSchema });

const unlinked = (p: Props): Props => { const { saved: _s, savedName: _n, ...rest } = p; return rest; };
/** A copy of a saved row to put in a design, tied to the saved one. */
export const linkedRow = (s: SavedRow): Row => ({
  id: designId(), p: { ...unlinked(s.row.p), saved: s.id, savedName: s.name },
  columns: s.row.columns.map((c) => ({ ...c, id: designId(), p: { ...c.p }, blocks: c.blocks.map((b) => ({ ...b, id: designId(), p: { ...b.p }, items: b.items?.map((i) => ({ ...i })), cells: b.cells?.map((r) => [...r]) })) })),
});
/** The row as its own (no longer tied to a saved row). */
export const unlinkRow = (r: Row): Row => ({ ...r, p: unlinked(r.p) });
/**
 * A design with every row that's tied to a saved row brought up to date with it (a row tied to
 * one that no longer exists becomes the design's own). `changed` says whether anything differed.
 */
export function withSavedRows(d: EmailDesign, saved: Map<string, SavedRow>): { design: EmailDesign; changed: boolean } {
  let changed = false;
  const rows = d.rows.map((r) => {
    if (typeof r.p.saved !== "string") return r;
    const s = saved.get(r.p.saved);
    const next: Row = s ? { ...linkedRow(s), id: r.id } : unlinkRow(r);
    // Compared whatever order the settings are stored in (the database doesn't keep it).
    const sorted = (_k: string, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1))) : v);
    const same = (x: Row) => JSON.stringify({ p: x.p, columns: x.columns.map((c) => ({ span: c.span, p: c.p, blocks: c.blocks.map((b) => ({ type: b.type, p: b.p, items: b.items, cells: b.cells })) })) }, sorted);
    if (same(next) !== same(r)) changed = true;
    return s && same(next) === same(r) ? r : next;
  });
  return { design: { ...d, rows }, changed };
}
/** How many rows of a design are tied to this saved row. */
export const usesSavedRow = (d: EmailDesign, id: string) => d.rows.filter((r) => r.p.saved === id).length;

/** White or near-black, whichever reads better on a colour. */
export function contrastText(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#111111";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#111111" : "#ffffff";
}
/**
 * A header in the company's own colours: its logo (or its name) on a background, with a line of
 * its accent colour underneath (left out when the two are the same colour).
 */
export function brandHeaderRow(o: { color: string; accent?: string | null; logoUrl?: string | null; companyName: string }): Row {
  const color = col(o.color, "#ffffff").toLowerCase(), accent = col(o.accent, color).toLowerCase();
  const inner: Props = { padTop: 18, padBottom: 18, padLeft: 20, padRight: 20 };
  const block: Block = o.logoUrl
    ? { ...newBlock("image"), p: { ...BLOCK_DEFAULTS.image.p, src: o.logoUrl, alt: o.companyName, autoWidth: false, width: 42, align: "center", ...inner } }
    : { ...newBlock("title"), p: { ...BLOCK_DEFAULTS.title.p, level: "h1", html: esc(o.companyName), size: 24, align: "center", color: contrastText(color), ...inner } };
  const row = newRow([12], accent === color ? [block] : [block, accentLine(accent)]);
  row.p.contentBg = color;
  row.columns[0].p = { ...COLUMN_DEFAULTS, ...pad(0) };
  return row;
}
const accentLine = (accent: string): Block => ({ ...newBlock("divider"), p: { ...BLOCK_DEFAULTS.divider.p, lineWidth: 4, color: accent, ...pad(0) } });
/**
 * A header put on other colours: the background changes, words that were white or near-black stay
 * readable on it, and its lines take the accent colour (one is added when it had none).
 */
export function recolorHeaderRow(row: Row, hex: string, accentHex?: string | null): Row {
  const color = col(hex, "#ffffff").toLowerCase(), accent = col(accentHex, color).toLowerCase();
  const plain = (c: unknown) => typeof c === "string" && ["#ffffff", "#111111"].includes(c.toLowerCase());
  const lined = row.columns.some((c) => c.blocks.some((b) => b.type === "divider"));
  return {
    ...row, p: { ...row.p, contentBg: color },
    columns: row.columns.map((c, i) => ({
      ...c,
      blocks: [
        ...c.blocks.map((b) => (b.type === "divider" && accentHex ? { ...b, p: { ...b.p, color: accent } } : plain(b.p.color) ? { ...b, p: { ...b.p, color: contrastText(color) } } : b)),
        ...(accentHex && !lined && accent !== color && i === 0 && row.columns.length === 1 ? [accentLine(accent)] : []),
      ],
    })),
  };
}

/** A picture that lives on Homeworks' storage (its own artwork, which goes away if Homeworks removes it). */
export const isHomeworksPicture = (src: unknown) => typeof src === "string" && /prod-beefree-images\.s3\.amazonaws\.com|copilot-template-builder/i.test(src);
export const homeworksPictures = (d: EmailDesign | null | undefined) => (d ? d.rows.reduce((n, r) => n + r.columns.reduce((m, c) => m + c.blocks.filter((b) => b.type === "image" && isHomeworksPicture(b.p.src)).length, 0), 0) : 0);
/** What a Homeworks picture said, when its file name says it ("Estimate Accepted"); nothing for its plain art ("Invoice 1"). */
export function homeworksPictureTitle(src: string): string | null {
  let name = src.split("/").pop() ?? "";
  try { name = decodeURIComponent(name); } catch { /* keep it as it is */ }
  name = name.replace(/\.[a-z]+$/i, "").replace(/\s*\d+$/, "").trim();
  if (!name || /copilot|google|header/i.test(name) || !name.includes(" ")) return null;
  return name;
}
/**
 * A design with Homeworks' pictures taken out and the company's own header (a saved row) put on
 * top instead. Where a picture's name said what the email is about, a title says it now.
 */
export function swapHomeworksPictures(d: EmailDesign, header: SavedRow): { design: EmailDesign; swapped: number } {
  let swapped = 0;
  const rows = d.rows.map((r) => ({ ...r, columns: r.columns.map((c) => ({ ...c, blocks: c.blocks.flatMap((b): Block[] => {
    if (b.type !== "image" || !isHomeworksPicture(b.p.src)) return [b];
    swapped++;
    const title = homeworksPictureTitle(String(b.p.src));
    return title ? [{ ...newBlock("title"), p: { ...BLOCK_DEFAULTS.title.p, level: "h1", html: esc(title), size: 22, align: "center", padTop: 18, padBottom: 6 } }] : [];
  }) })) }));
  if (!swapped) return { design: d, swapped };
  const has = rows.some((r) => r.p.saved === header.id);
  return { design: { ...d, rows: has ? rows : [linkedRow(header), ...rows] }, swapped };
}

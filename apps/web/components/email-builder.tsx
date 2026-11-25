"use client";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import {
  BLOCK_LABELS, BLOCK_TYPES, COLUMN_DEFAULTS, EMAIL_FONTS, ROW_LAYOUTS, SOCIAL_NETWORKS, TEMPLATE_TAGS, designId, newBlock, newRow, renderDesignBlock,
  type Block, type BlockType, type Column, type EmailDesign, type Item, type Props, type Row,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";

/**
 * The email template builder, laid out like the one in Homeworks: a dark bar on top (Actions,
 * Show structure, Help), Content / Rows / Settings on the left, and the email on the right.
 * Blocks are dragged (or clicked) from the Content tab into rows; picking a block or a row opens
 * its properties on the left; words are typed right on the email. What you see is made by the same
 * code that makes the email that's sent.
 */

/* ───────────── Changing a design ───────────── */

type Sel = { kind: "block" | "row"; id: string } | null;
const eachCol = (d: EmailDesign, fn: (c: Column, r: Row) => Column): EmailDesign => ({ ...d, rows: d.rows.map((r) => ({ ...r, columns: r.columns.map((c) => fn(c, r)) })) });
const patchBlock = (d: EmailDesign, id: string, fn: (b: Block) => Block) => eachCol(d, (c) => (c.blocks.some((b) => b.id === id) ? { ...c, blocks: c.blocks.map((b) => (b.id === id ? fn(b) : b)) } : c));
const dropBlock = (d: EmailDesign, id: string) => eachCol(d, (c) => (c.blocks.some((b) => b.id === id) ? { ...c, blocks: c.blocks.filter((b) => b.id !== id) } : c));
const putBlock = (d: EmailDesign, colId: string, index: number, b: Block) => eachCol(d, (c) => (c.id === colId ? { ...c, blocks: [...c.blocks.slice(0, index), b, ...c.blocks.slice(index)] } : c));
const findBlock = (d: EmailDesign, id: string) => { for (const r of d.rows) for (const c of r.columns) { const i = c.blocks.findIndex((b) => b.id === id); if (i >= 0) return { row: r, col: c, block: c.blocks[i], index: i }; } return null; };
const patchRow = (d: EmailDesign, id: string, fn: (r: Row) => Row) => ({ ...d, rows: d.rows.map((r) => (r.id === id ? fn(r) : r)) });
const copyBlock = (b: Block): Block => ({ ...b, id: designId(), p: { ...b.p }, items: b.items?.map((i) => ({ ...i })), cells: b.cells?.map((r) => [...r]) });
const copyRow = (r: Row): Row => ({ ...r, id: designId(), p: { ...r.p }, columns: r.columns.map((c) => ({ ...c, id: designId(), p: { ...c.p }, blocks: c.blocks.map(copyBlock) })) });
const TEXT_BLOCKS: BlockType[] = ["title", "paragraph", "list", "text"];
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);

/* ───────────── The properties each kind of block has ───────────── */

type Field =
  | { t: "section"; label: string }
  | { t: "font" | "weight" | "color" | "toggle" | "text" | "url" | "align3" | "align4" | "lineheight" | "hide" | "html" | "image"; k: string; label: string; hint?: string }
  | { t: "num"; k: string; label: string; min: number; max: number; step?: number; unit?: string; when?: (p: Props) => boolean }
  | { t: "select"; k: string; label: string; options: [string, string][] }
  | { t: "padding"; prefix: string; label: string }
  | { t: "border"; label: string }
  | { t: "items"; kind: "social" | "menu" | "icons" }
  | { t: "cells" };
const TYPO = (spacing: boolean): Field[] => [
  { t: "font", k: "font", label: "Font family" }, { t: "weight", k: "weight", label: "Font weight" }, { t: "num", k: "size", label: "Font size", min: 6, max: 120 },
  { t: "color", k: "color", label: "Text color" }, { t: "color", k: "linkColor", label: "Link color" }, { t: "align4", k: "align", label: "Align" },
  ...(spacing ? [{ t: "num", k: "paraSpacing", label: "Paragraph spacing", min: 0, max: 80 } as Field] : []),
  { t: "lineheight", k: "lineHeight", label: "Line height" }, { t: "num", k: "letterSpacing", label: "Letter spacing", min: -5, max: 30 },
];
const OPTS: Field[] = [{ t: "section", label: "BLOCK OPTIONS" }, { t: "padding", prefix: "pad", label: "Padding" }, { t: "hide", k: "hideOn", label: "Hide on" }];
const STYLES: [string, string][] = [["solid", "solid"], ["dashed", "dashed"], ["dotted", "dotted"]];
const FIELDS: Record<BlockType, Field[]> = {
  title: [{ t: "select", k: "level", label: "Title", options: [["h1", "H1"], ["h2", "H2"], ["h3", "H3"]] }, ...TYPO(false), ...OPTS],
  paragraph: [...TYPO(true), ...OPTS],
  text: [...TYPO(true), ...OPTS],
  list: [{ t: "select", k: "listType", label: "List type", options: [["ul", "Unordered"], ["ol", "Ordered"]] }, ...TYPO(false), ...OPTS],
  image: [
    { t: "image", k: "src", label: "Add image" }, { t: "toggle", k: "autoWidth", label: "Auto width" }, { t: "num", k: "width", label: "Width", min: 5, max: 100, unit: "%", when: (p) => p.autoWidth === false },
    { t: "toggle", k: "fullMobile", label: "Full width on mobile" }, { t: "align3", k: "align", label: "Align" }, { t: "text", k: "alt", label: "Alternate text" },
    { t: "section", label: "ACTION" }, { t: "url", k: "href", label: "Image link" }, ...OPTS,
  ],
  button: [
    { t: "text", k: "text", label: "Button text" }, { t: "section", label: "ACTION" }, { t: "url", k: "href", label: "Url" }, { t: "section", label: "BUTTON OPTIONS" },
    { t: "toggle", k: "autoWidth", label: "Auto width" }, { t: "num", k: "width", label: "Width", min: 10, max: 100, unit: "%", when: (p) => p.autoWidth === false },
    { t: "font", k: "font", label: "Font family" }, { t: "weight", k: "weight", label: "Font weight" }, { t: "num", k: "size", label: "Font size", min: 6, max: 80 },
    { t: "color", k: "bg", label: "Background color" }, { t: "color", k: "color", label: "Text color" }, { t: "align3", k: "align", label: "Align" }, { t: "lineheight", k: "lineHeight", label: "Line height" },
    { t: "num", k: "radius", label: "Border radius", min: 0, max: 60 }, { t: "padding", prefix: "cPad", label: "Content padding" }, { t: "border", label: "Border" }, ...OPTS,
  ],
  divider: [
    { t: "toggle", k: "transparent", label: "Transparent" }, { t: "select", k: "style", label: "Line", options: STYLES }, { t: "num", k: "lineWidth", label: "Line thickness", min: 1, max: 30 },
    { t: "color", k: "color", label: "Line color" }, { t: "num", k: "width", label: "Width", min: 1, max: 100, unit: "%" }, { t: "align3", k: "align", label: "Align" }, ...OPTS,
  ],
  spacer: [{ t: "num", k: "height", label: "Height", min: 1, max: 400 }, { t: "section", label: "BLOCK OPTIONS" }, { t: "hide", k: "hideOn", label: "Hide on" }],
  social: [{ t: "items", kind: "social" }, { t: "align3", k: "align", label: "Align" }, { t: "num", k: "spacing", label: "Icon spacing", min: 0, max: 40 }, { t: "num", k: "size", label: "Icon size", min: 16, max: 64 }, ...OPTS],
  html: [{ t: "html", k: "html", label: "HTML", hint: "HTML experts only. Using your own code may affect how the message is rendered. Make sure to use correct and responsive HTML." }, { t: "section", label: "BLOCK OPTIONS" }, { t: "hide", k: "hideOn", label: "Hide on" }],
  video: [{ t: "url", k: "url", label: "Url", hint: "Add a YouTube URL to automatically generate a preview image. The image will link to the provided URL." }, ...OPTS],
  icons: [
    { t: "items", kind: "icons" }, { t: "font", k: "font", label: "Font family" }, { t: "weight", k: "weight", label: "Font weight" }, { t: "num", k: "size", label: "Font size", min: 6, max: 80 },
    { t: "color", k: "color", label: "Text color" }, { t: "align3", k: "align", label: "Align" }, { t: "num", k: "iconSize", label: "Icon size", min: 12, max: 120 }, { t: "num", k: "spacing", label: "Icon spacing", min: 0, max: 40 }, ...OPTS,
  ],
  menu: [
    { t: "items", kind: "menu" }, { t: "font", k: "font", label: "Font family" }, { t: "weight", k: "weight", label: "Font weight" }, { t: "num", k: "size", label: "Font size", min: 6, max: 80 },
    { t: "color", k: "color", label: "Text color" }, { t: "color", k: "linkColor", label: "Link color" }, { t: "align3", k: "align", label: "Align" }, { t: "text", k: "separator", label: "Separator" },
    { t: "num", k: "spacing", label: "Item spacing", min: 0, max: 40 }, ...OPTS,
  ],
  table: [
    { t: "section", label: "STRUCTURE" }, { t: "cells" }, { t: "border", label: "Border" }, { t: "color", k: "bg", label: "Background color" }, { t: "toggle", k: "alternate", label: "Alternate rows" },
    { t: "section", label: "HEADER" }, { t: "toggle", k: "header", label: "Header row" }, { t: "color", k: "headerBg", label: "Background color" }, { t: "weight", k: "headerWeight", label: "Font weight" }, { t: "color", k: "headerColor", label: "Text color" },
    { t: "section", label: "CONTENT" }, { t: "font", k: "font", label: "Font family" }, { t: "weight", k: "weight", label: "Font weight" }, { t: "num", k: "size", label: "Font size", min: 6, max: 80 },
    { t: "color", k: "color", label: "Text color" }, { t: "align3", k: "align", label: "Align" }, { t: "lineheight", k: "lineHeight", label: "Line height" }, ...OPTS,
  ],
};
const ROW_FIELDS: Field[] = [
  { t: "section", label: "BACKGROUNDS" }, { t: "color", k: "bg", label: "Row background color" }, { t: "color", k: "contentBg", label: "Content area background color" },
  { t: "section", label: "BORDERS" }, { t: "border", label: "Border" }, { t: "num", k: "radius", label: "Rounded corners", min: 0, max: 60 },
  { t: "section", label: "LAYOUT" }, { t: "hide", k: "hideOn", label: "Hide on" }, { t: "toggle", k: "stack", label: "Stack on mobile" },
  { t: "select", k: "valign", label: "Vertical align", options: [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]] },
];
const COLUMN_FIELDS: Field[] = [{ t: "color", k: "bg", label: "Column background" }, { t: "padding", prefix: "pad", label: "Padding" }, { t: "border", label: "Border" }];
const SETTINGS_FIELDS: Field[] = [
  { t: "section", label: "DESIGN SETTINGS" }, { t: "num", k: "width", label: "Content area width", min: 320, max: 900, step: 10, unit: "px" },
  { t: "select", k: "align", label: "Content area alignment", options: [["left", "LEFT"], ["center", "CENTER"]] }, { t: "color", k: "bg", label: "Background color" },
  { t: "color", k: "contentBg", label: "Content area background color" }, { t: "font", k: "font", label: "Default font" }, { t: "color", k: "linkColor", label: "Link color" },
  { t: "section", label: "EMAIL DETAILS" }, { t: "text", k: "preheader", label: "Preheader", hint: "The short line inboxes show after the subject." },
];

/* ───────────── Property inputs ───────────── */

function Stepper({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
  return (
    <span className="eb-step">
      <button type="button" aria-label={`Less ${label}`} onClick={() => set(value - step)}>-</button>
      <input type="text" inputMode="decimal" aria-label={label} value={value} onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(v)) set(v); }} />
      <button type="button" aria-label={`More ${label}`} onClick={() => set(value + step)}>+</button>
    </span>
  );
}
function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const clear = value === "transparent";
  return (
    <span className="eb-color">
      <input type="color" aria-label={`${label} picker`} className={clear ? "none" : ""} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"} onChange={(e) => onChange(e.target.value)} />
      <input type="text" aria-label={label} value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); const v = e.target.value.trim(); if (/^(#[0-9a-f]{3}|#[0-9a-f]{6}|transparent)$/i.test(v)) onChange(v.toLowerCase()); }} onBlur={() => setText(value)} />
      <button type="button" title="No color (transparent)" aria-label={`${label}: transparent`} onClick={() => onChange("transparent")}>∅</button>
    </span>
  );
}
function Segmented({ value, options, onChange, label }: { value: string; options: [string, ReactNode, string?][]; onChange: (v: string) => void; label: string }) {
  return <span className="eb-seg" role="radiogroup" aria-label={label}>{options.map(([v, text, title]) => <button key={v} type="button" role="radio" aria-checked={value === v} title={title} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{text}</button>)}</span>;
}
const alignIcon = (kind: string) => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d={kind === "left" ? "M1 2h16M1 7h10M1 12h14" : kind === "center" ? "M1 2h16M4 7h10M2 12h14" : kind === "right" ? "M1 2h16M7 7h10M3 12h14" : "M1 2h16M1 7h16M1 12h16"} />
  </svg>
);

/** Uploads a picture for the email and gives back its address. */
function useImageUpload(onUrl: (url: string) => void) {
  const act = useAction();
  const input = useRef<HTMLInputElement>(null);
  const send = (file: File | undefined) => { if (file) void act.run(async () => { const body = new FormData(); body.append("file", file); onUrl((await api<{ url: string }>("/templates/images", { body })).url); }); };
  const field = <input ref={input} type="file" accept="image/jpeg,image/png,image/gif" hidden onChange={(e) => { send(e.target.files?.[0]); e.target.value = ""; }} />;
  return { field, pick: () => input.current?.click(), send, busy: act.busy, error: act.error };
}
function ImageField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const up = useImageUpload(onChange);
  return (
    <div className="eb-field col">
      {up.field}
      <button type="button" className="eb-primary" disabled={up.busy} onClick={up.pick}>{up.busy ? "Uploading…" : value ? "Change image" : label}</button>
      <label className="eb-addon"><span>Url</span><input type="text" aria-label="Image url" value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://" /></label>
      {up.error && <span className="eb-err">{up.error}</span>}
    </div>
  );
}

function Fields({ fields, p, set, block, setBlock }: { fields: Field[]; p: Props; set: (patch: Props) => void; block?: Block; setBlock?: (b: Block) => void }) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  return (
    <>
      {fields.map((f, i) => {
        if (f.t === "section") return <div key={i} className="eb-section">{f.label}</div>;
        if (f.t === "num") return f.when && !f.when(p) ? null : <div key={i} className="eb-field"><span>{f.label}{f.unit ? ` (${f.unit})` : ""}</span><Stepper label={f.label} value={n(p[f.k], f.min)} min={f.min} max={f.max} step={f.step} onChange={(v) => set({ [f.k]: v })} /></div>;
        if (f.t === "select") return <div key={i} className="eb-field"><span>{f.label}</span><select aria-label={f.label} value={s(p[f.k], f.options[0][0])} onChange={(e) => set({ [f.k]: e.target.value })}>{f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>;
        if (f.t === "font") return <div key={i} className="eb-field"><span>{f.label}</span><select aria-label={f.label} value={s(p[f.k])} onChange={(e) => set({ [f.k]: e.target.value })}>{f.label === "Default font" ? null : <option value="">Global font</option>}{EMAIL_FONTS.map(([name]) => <option key={name} value={name}>{name}</option>)}</select></div>;
        if (f.t === "weight") return <div key={i} className="eb-field"><span>{f.label}</span><select aria-label={f.label} value={s(p[f.k], "400")} onChange={(e) => set({ [f.k]: e.target.value })}><option value="400">Regular</option><option value="700">Bold</option></select></div>;
        if (f.t === "lineheight") return <div key={i} className="eb-field"><span>{f.label}</span><select aria-label={f.label} value={String(n(p[f.k], 1.2))} onChange={(e) => set({ [f.k]: Number(e.target.value) })}>{[1, 1.2, 1.5, 1.8, 2, 2.5, 3].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>;
        if (f.t === "color") return <div key={i} className="eb-field"><span>{f.label}</span><ColorInput label={f.label} value={s(p[f.k], "transparent")} onChange={(v) => set({ [f.k]: v })} /></div>;
        if (f.t === "toggle") return <label key={i} className="eb-field"><span>{f.label}</span><input type="checkbox" className="eb-toggle" checked={p[f.k] !== false && p[f.k] !== undefined ? !!p[f.k] : false} onChange={(e) => set({ [f.k]: e.target.checked })} /></label>;
        if (f.t === "text") return <div key={i} className="eb-field col"><label className="eb-addon"><span>{f.label}</span><input type="text" aria-label={f.label} value={s(p[f.k])} onChange={(e) => set({ [f.k]: e.target.value })} /></label>{f.hint && <small>{f.hint}</small>}</div>;
        if (f.t === "url") return <div key={i} className="eb-field col"><label className="eb-addon"><span>{f.label}</span><input type="text" aria-label={f.label} value={s(p[f.k])} placeholder="https://  or a tag like {{ESTIMATE_LINK}}" onChange={(e) => set({ [f.k]: e.target.value })} /></label>{f.hint && <small>{f.hint}</small>}</div>;
        if (f.t === "html") return <div key={i} className="eb-field col"><textarea aria-label={f.label} className="eb-code" rows={9} spellCheck={false} value={s(p[f.k])} onChange={(e) => set({ [f.k]: e.target.value })} />{f.hint && <small><strong>{f.hint.split(".")[0]}.</strong>{f.hint.slice(f.hint.indexOf(".") + 1)}</small>}</div>;
        if (f.t === "image") return <ImageField key={i} label={f.label} value={s(p[f.k])} onChange={(v) => set({ [f.k]: v })} />;
        if (f.t === "align3" || f.t === "align4") return <div key={i} className="eb-field"><span>{f.label}</span><Segmented label={f.label} value={s(p[f.k], "left")} onChange={(v) => set({ [f.k]: v })} options={(f.t === "align4" ? ["left", "center", "right", "justify"] : ["left", "center", "right"]).map((a) => [a, alignIcon(a), a] as [string, ReactNode, string])} /></div>;
        if (f.t === "hide") return <div key={i} className="eb-field"><span>{f.label}</span><Segmented label={f.label} value={s(p[f.k])} onChange={(v) => set({ [f.k]: v })} options={[["", "OFF"], ["desktop", "Desktop", "Hide on desktop"], ["mobile", "Mobile", "Hide on mobile"]]} /></div>;
        if (f.t === "padding") {
          const keys = ["Top", "Right", "Bottom", "Left"].map((side) => `${f.prefix}${side}`);
          const vals = keys.map((k) => n(p[k], 0));
          const open = more[f.prefix] ?? !vals.every((v) => v === vals[0]);
          return (
            <div key={i} className="eb-field col">
              <div className="eb-row"><span>{f.label}</span><label className="eb-more">More options <input type="checkbox" className="eb-toggle" checked={open} onChange={(e) => setMore({ ...more, [f.prefix]: e.target.checked })} /></label></div>
              {open
                ? <div className="eb-sides">{["Top", "Right", "Bottom", "Left"].map((side, j) => <label key={side}><small>{side}</small><Stepper label={`${f.label} ${side.toLowerCase()}`} value={vals[j]} min={0} max={120} onChange={(v) => set({ [keys[j]]: v })} /></label>)}</div>
                : <label className="eb-row"><small>All sides</small><Stepper label={`${f.label} all sides`} value={vals[0]} min={0} max={120} onChange={(v) => set(Object.fromEntries(keys.map((k) => [k, v])))} /></label>}
            </div>
          );
        }
        if (f.t === "border") return (
          <div key={i} className="eb-field col">
            <span>{f.label}</span>
            <div className="eb-border">
              <select aria-label={`${f.label} style`} value={s(p.borderStyle, "solid")} onChange={(e) => set({ borderStyle: e.target.value })}>{STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <Stepper label={`${f.label} width`} value={n(p.borderWidth, 0)} min={0} max={30} onChange={(v) => set({ borderWidth: v })} />
              <ColorInput label={`${f.label} color`} value={s(p.borderColor, "transparent")} onChange={(v) => set({ borderColor: v })} />
            </div>
          </div>
        );
        if (f.t === "items" && block && setBlock) return <ItemsField key={i} kind={f.kind} block={block} setBlock={setBlock} />;
        if (f.t === "cells" && block && setBlock) return <CellsField key={i} block={block} setBlock={setBlock} />;
        return null;
      })}
    </>
  );
}

/** The links of a Social, Menu or Icons block. */
function ItemsField({ kind, block, setBlock }: { kind: "social" | "menu" | "icons"; block: Block; setBlock: (b: Block) => void }) {
  const items = block.items ?? [];
  const set = (next: Item[]) => setBlock({ ...block, items: next });
  const edit = (i: number, patch: Item) => set(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const add = () => set([...items, kind === "social" ? { net: "facebook", url: SOCIAL_NETWORKS.facebook.url } : kind === "menu" ? { text: "Menu item", url: "" } : { src: "", text: "", url: "" }]);
  return (
    <div className="eb-field col">
      {items.map((it, i) => (
        <div key={i} className="eb-item">
          <div className="eb-row">
            {kind === "social"
              ? <select aria-label="Network" value={it.net} onChange={(e) => edit(i, { net: e.target.value, url: SOCIAL_NETWORKS[e.target.value]?.url ?? "" })}>{Object.entries(SOCIAL_NETWORKS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              : <input type="text" aria-label="Text" placeholder="Text" value={it.text ?? ""} onChange={(e) => edit(i, { text: e.target.value })} />}
            <button type="button" className="eb-x" aria-label="Delete" title="Delete" onClick={() => set(items.filter((_, j) => j !== i))}>×</button>
          </div>
          {kind === "icons" && <ImageField label="Add icon" value={it.src ?? ""} onChange={(v) => edit(i, { src: v })} />}
          <label className="eb-addon"><span>Url</span><input type="text" aria-label="Url" value={it.url ?? ""} onChange={(e) => edit(i, { url: e.target.value })} /></label>
        </div>
      ))}
      <button type="button" className="eb-primary" onClick={add}>{kind === "menu" ? "ADD NEW ITEM" : "ADD NEW ICON"}</button>
    </div>
  );
}
/** A Table block's columns, rows and what's in each cell. */
function CellsField({ block, setBlock }: { block: Block; setBlock: (b: Block) => void }) {
  const cells = block.cells ?? [[""]];
  const cols = Math.max(1, ...cells.map((r) => r.length)), rows = cells.length;
  const resize = (c: number, r: number) => setBlock({ ...block, cells: Array.from({ length: r }, (_, ri) => Array.from({ length: c }, (_, ci) => cells[ri]?.[ci] ?? "")) });
  return (
    <div className="eb-field col">
      <div className="eb-row"><span>Columns</span><Stepper label="Columns" value={cols} min={1} max={8} onChange={(v) => resize(v, rows)} /></div>
      <div className="eb-row"><span>Rows</span><Stepper label="Rows" value={rows} min={1} max={40} onChange={(v) => resize(cols, v)} /></div>
      <div className="eb-cells" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {cells.map((r, ri) => Array.from({ length: cols }, (_, ci) => (
          <input key={`${ri}-${ci}`} type="text" aria-label={`Row ${ri + 1}, column ${ci + 1}`} value={r[ci] ?? ""}
            onChange={(e) => setBlock({ ...block, cells: cells.map((row, y) => (y === ri ? Array.from({ length: cols }, (_, x) => (x === ci ? e.target.value : row[x] ?? "")) : row)) })} />
        )))}
      </div>
    </div>
  );
}

/* ───────────── Words typed right on the email ───────────── */

function Editable({ html, tag, style, className, onCommit, singleLine }: { html: string; tag: string; style?: CSSProperties; className?: string; onCommit: (html: string) => void; singleLine?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { const el = ref.current; if (el && el.innerHTML !== html && document.activeElement !== el) el.innerHTML = html; }, [html]);
  const Tag = tag as "div";
  return (
    <Tag ref={ref as never} className={className} style={style} contentEditable suppressContentEditableWarning role="textbox" aria-multiline={!singleLine}
      onFocus={() => { try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older browsers */ } }}
      onKeyDown={(e) => { if (singleLine && e.key === "Enter") { e.preventDefault(); document.execCommand("insertLineBreak"); } }}
      onPaste={(e) => { e.preventDefault(); document.execCommand("insertText", false, e.clipboardData.getData("text/plain")); }}
      onBlur={() => { const v = ref.current?.innerHTML ?? ""; if (v !== html) onCommit(v); }} />
  );
}
const EMOJI = ["😀", "🙂", "👍", "🙏", "🎉", "⭐", "✅", "❗", "📞", "📱", "📧", "🌐", "📍", "📅", "⏰", "💲", "💳", "🧾", "🏡", "🌱", "🌿", "🍂", "❄️", "☀️", "🌧️", "🐜", "🚚", "👉", "👤", "❤️"];
const CHARS = ["©", "®", "™", "°", "•", "…", "–", "—", "½", "¼", "¾", "×", "÷", "±", "≤", "≥", "→", "←", "✓", "✗", "¢", "€", "£"];
/** The bar that shows while typing in a block: bold, colors, links, emoji and the fill-in tags. */
function TextBar() {
  const [open, setOpen] = useState<null | "emoji" | "chars" | "tags">(null);
  const cmd = (name: string, value?: string, css = false) => { document.execCommand("styleWithCSS", false, css ? "true" : "false"); document.execCommand(name, false, value); };
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const B = ({ c, title, children, v }: { c: string; title: string; children: ReactNode; v?: string }) => <button type="button" title={title} aria-label={title} onMouseDown={keep} onClick={() => cmd(c, v)}>{children}</button>;
  const link = () => { const url = window.prompt("Link to (a web address, or a tag like {{REVIEW_PAGE}}):", "https://"); if (url && url.trim() && url.trim() !== "https://") cmd("createLink", url.trim()); };
  const menu = (kind: "emoji" | "chars" | "tags", items: [string, string][]) => open === kind && (
    <div className={`eb-pop ${kind}`} onMouseDown={keep}>{items.map(([label, value]) => <button key={label} type="button" onClick={() => { cmd("insertText", value); setOpen(null); }}>{label}</button>)}</div>
  );
  return (
    <div className="eb-textbar" role="toolbar" aria-label="Text formatting" onMouseDown={keep} onClick={(e) => e.stopPropagation()}>
      <B c="bold" title="Bold"><b>B</b></B><B c="italic" title="Italic"><i>I</i></B><B c="underline" title="Underline"><u>U</u></B><B c="strikeThrough" title="Strikethrough"><s>S</s></B>
      <label title="Text color" className="eb-ink"><span style={{ borderBottom: "3px solid currentColor" }}>A</span><input type="color" aria-label="Text color" onMouseDown={(e) => e.stopPropagation()} onChange={(e) => cmd("foreColor", e.target.value, true)} /></label>
      <label title="Highlight color" className="eb-ink"><span style={{ background: "#ffe066", color: "#111", padding: "0 3px" }}>A</span><input type="color" aria-label="Highlight color" defaultValue="#ffff00" onMouseDown={(e) => e.stopPropagation()} onChange={(e) => cmd("hiliteColor", e.target.value, true)} /></label>
      <B c="superscript" title="Superscript">x²</B><B c="subscript" title="Subscript">x₂</B>
      <button type="button" title="Special characters" aria-label="Special characters" onClick={() => setOpen(open === "chars" ? null : "chars")}>Ω</button>
      <B c="removeFormat" title="Clear formatting">T̶</B>
      <button type="button" title="Emoji" aria-label="Emoji" onClick={() => setOpen(open === "emoji" ? null : "emoji")}>☺</button>
      <button type="button" title="Insert link" aria-label="Insert link" onClick={link}>🔗</button><B c="unlink" title="Remove link">⛓</B>
      <button type="button" className="wide" aria-haspopup="menu" aria-expanded={open === "tags"} onClick={() => setOpen(open === "tags" ? null : "tags")}>Merge tags</button>
      {menu("emoji", EMOJI.map((e) => [e, e]))}
      {menu("chars", CHARS.map((c) => [c, c]))}
      {menu("tags", TEMPLATE_TAGS.map((t) => [t.tag.replace(/_/g, " "), `{{${t.tag}}}`]))}
    </div>
  );
}

/**
 * A block as it will look in the email, kept apart from this page's own styles (which would
 * otherwise restyle the email's tables and links) by drawing it in its own shadow tree.
 */
function Shown({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<div style="font-size:14px;line-height:1.2;color:#000000;text-align:left">${html}</div>`;
  }, [html]);
  return <div ref={ref} className="eb-shown" />;
}

/* ───────────── Icons ───────────── */

const TILE_ICONS: Record<BlockType, string> = {
  title: "M4 5h9M8.5 5v12M15 8h6M15 12h6M4 20h17", paragraph: "M3 5h9M3 9h9M3 13h18M3 17h18M16 4v7M19 4v7M15 4h5a0 0 0 0 1 0 0", list: "M4 6h.01M4 12h.01M4 18h.01M9 6h12M9 12h12M9 18h12",
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z", button: "M3 8h18v7H3zM7 11.5h8M17 14l2 6 1.5-2.5L23 16z", table: "M3 5h18v14H3zM3 10h18M3 14.5h18M9 10v9M15 10v9",
  divider: "M2 12h20M6 4h12v4H6zM6 16h12v4H6z", spacer: "M4 5h16v14H4zM12 8v8M9.5 10.5L12 8l2.5 2.5M9.5 13.5L12 16l2.5-2.5", social: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M7 12h10",
  html: "M6 3h9l4 4v14H6zM15 3v4h4M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5", video: "M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4M10.5 9.5v5l4-2.5z", icons: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  menu: "M3 6h18M3 12h18M3 18h18", text: "M5 5h14M12 5v15M9 20h6",
};
const Glyph = ({ d, size = 34 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const ICON = {
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6", copy: "M8 8h11v12H8zM5 16V4h10", close: "M5 5l14 14M19 5L5 19", move: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", desktop: "M3 4h18v12H3zM8 20h8M12 16v4", mobile: "M7 3h10v18H7zM11 18h2", undo: "M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12", redo: "M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12",
  content: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", rows: "M3 5h18v5H3zM3 14h18v5H3z", settings: "M4 4h16v16H4zM7 8h10M7 12h10M7 16h6",
};

/* ───────────── The builder ───────────── */

type Drag = { kind: "new"; type: BlockType } | { kind: "block"; id: string } | { kind: "row"; spans: number[] } | { kind: "moverow"; id: string };
type Drop = { colId: string; index: number } | { rowIndex: number } | null;

export function EmailBuilder({ value, onChange, onPreview, onSendTest, extra }: {
  value: EmailDesign; onChange: (d: EmailDesign) => void; onPreview: () => void; onSendTest: () => void;
  /** More settings for the Settings tab (who the template is for). */
  extra?: ReactNode;
}) {
  const [tab, setTab] = useState<"content" | "rows" | "settings">("content");
  const [sel, setSel] = useState<Sel>(null);
  const [mobile, setMobile] = useState(false);
  const [structure, setStructure] = useState(false);
  const [actions, setActions] = useState(false);
  const [drop, setDrop] = useState<Drop>(null);
  const [typing, setTyping] = useState(false);
  const drag = useRef<Drag | null>(null);
  const past = useRef<EmailDesign[]>([]);
  const future = useRef<EmailDesign[]>([]);
  const [, tick] = useState(0);

  const apply = (next: EmailDesign) => { past.current = [...past.current.slice(-49), value]; future.current = []; onChange(next); };
  const undo = () => { const prev = past.current.pop(); if (prev) { future.current.push(value); setSel(null); onChange(prev); tick((x) => x + 1); } };
  const redo = () => { const next = future.current.pop(); if (next) { past.current.push(value); setSel(null); onChange(next); tick((x) => x + 1); } };
  // A design opened from outside (another template) starts a new history.
  const lastOwn = useRef(value);
  useEffect(() => { if (lastOwn.current !== value && !past.current.includes(lastOwn.current) && !future.current.includes(lastOwn.current)) { past.current = []; future.current = []; setSel(null); } lastOwn.current = value; }, [value]);

  const width = Math.min(900, Math.max(320, n(value.p.width, 500)));
  const picked = sel?.kind === "block" ? findBlock(value, sel.id) : null;
  const pickedRow = sel?.kind === "row" ? value.rows.find((r) => r.id === sel.id) ?? null : null;

  /** Adds a block where it makes sense: after the picked block, in the picked row, or at the end. */
  const addBlock = (type: BlockType) => {
    const b = newBlock(type);
    const at = picked ? { colId: picked.col.id, index: picked.index + 1 } : pickedRow ? { colId: pickedRow.columns[0].id, index: pickedRow.columns[0].blocks.length }
      : value.rows.length ? { colId: value.rows[value.rows.length - 1].columns[0].id, index: value.rows[value.rows.length - 1].columns[0].blocks.length } : null;
    apply(at ? putBlock(value, at.colId, at.index, b) : { ...value, rows: [newRow([12], [b])] });
    setSel({ kind: "block", id: b.id });
  };
  const addRow = (spans: number[], index = value.rows.length) => { const r = newRow(spans); apply({ ...value, rows: [...value.rows.slice(0, index), r, ...value.rows.slice(index)] }); setSel({ kind: "row", id: r.id }); };
  const removeSel = () => { if (!sel) return; apply(sel.kind === "block" ? dropBlock(value, sel.id) : { ...value, rows: value.rows.filter((r) => r.id !== sel.id) }); setSel(null); };
  const duplicateSel = () => {
    if (picked) { const b = copyBlock(picked.block); apply(putBlock(value, picked.col.id, picked.index + 1, b)); setSel({ kind: "block", id: b.id }); }
    else if (pickedRow) { const r = copyRow(pickedRow); const i = value.rows.indexOf(pickedRow); apply({ ...value, rows: [...value.rows.slice(0, i + 1), r, ...value.rows.slice(i + 1)] }); setSel({ kind: "row", id: r.id }); }
  };

  /* Dragging */
  const start = (d: Drag) => (e: DragEvent) => { drag.current = d; e.dataTransfer.effectAllowed = "copyMove"; e.dataTransfer.setData("text/plain", d.kind); e.stopPropagation(); };
  const end = () => { drag.current = null; setDrop(null); };
  const overColumn = (colId: string) => (e: DragEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || (d.kind !== "new" && d.kind !== "block")) return;
    e.preventDefault(); e.stopPropagation();
    const kids = [...e.currentTarget.querySelectorAll<HTMLElement>(":scope > [data-block]")];
    let index = kids.findIndex((k) => { const r = k.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (index < 0) index = kids.length;
    if (!drop || !("colId" in drop) || drop.colId !== colId || drop.index !== index) setDrop({ colId, index });
  };
  const overStage = (e: DragEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    e.preventDefault();
    const kids = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
    let rowIndex = kids.findIndex((k) => { const r = k.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (rowIndex < 0) rowIndex = kids.length;
    if (!drop || !("rowIndex" in drop) || drop.rowIndex !== rowIndex) setDrop({ rowIndex });
  };
  const onDrop = (e: DragEvent) => {
    const d = drag.current, at = drop;
    e.preventDefault(); e.stopPropagation();
    end();
    if (!d || !at) return;
    if ("colId" in at && (d.kind === "new" || d.kind === "block")) {
      if (d.kind === "new") { const b = newBlock(d.type); apply(putBlock(value, at.colId, at.index, b)); setSel({ kind: "block", id: b.id }); return; }
      const from = findBlock(value, d.id);
      if (!from) return;
      const index = from.col.id === at.colId && from.index < at.index ? at.index - 1 : at.index;
      apply(putBlock(dropBlock(value, d.id), at.colId, index, from.block));
    } else if ("rowIndex" in at) {
      if (d.kind === "row") addRow(d.spans, at.rowIndex);
      else if (d.kind === "moverow") { const i = value.rows.findIndex((r) => r.id === d.id); if (i < 0) return; const rest = value.rows.filter((r) => r.id !== d.id); const to = i < at.rowIndex ? at.rowIndex - 1 : at.rowIndex; apply({ ...value, rows: [...rest.slice(0, to), value.rows[i], ...rest.slice(to)] }); }
      else if (d.kind === "new") { const b = newBlock(d.type); const r = newRow([12], [b]); apply({ ...value, rows: [...value.rows.slice(0, at.rowIndex), r, ...value.rows.slice(at.rowIndex)] }); setSel({ kind: "block", id: b.id }); }
      else { const from = findBlock(value, d.id); if (!from) return; const without = dropBlock(value, d.id); const r = newRow([12], [from.block]); apply({ ...without, rows: [...without.rows.slice(0, at.rowIndex), r, ...without.rows.slice(at.rowIndex)] }); }
    }
  };
  const line = <div className="eb-dropline"><span>Drop it here</span></div>;

  /* The email on the stage */
  const stageWidth = mobile ? 360 : width;
  const block = (b: Block, col: Column, row: Row, colWidth: number) => {
    const on = sel?.kind === "block" && sel.id === b.id;
    const isText = TEXT_BLOCKS.includes(b.type);
    const p = b.p;
    const pad = `${n(p.padTop, 0)}px ${n(p.padRight, 0)}px ${n(p.padBottom, 0)}px ${n(p.padLeft, 0)}px`;
    const html = isText ? "" : renderDesignBlock(b, value, colWidth);
    const typo: CSSProperties = {
      fontFamily: EMAIL_FONTS.find(([name]) => name === (p.font || value.p.font))?.[1], fontSize: n(p.size, 14), fontWeight: s(p.weight, "400") as never, color: s(p.color, "#000000"), lineHeight: n(p.lineHeight, 1.2),
      letterSpacing: n(p.letterSpacing, 0), textAlign: s(p.align, "left") as never, margin: 0, ["--gap" as never]: `${b.type === "paragraph" || b.type === "text" ? n(p.paraSpacing, 16) : 0}px`, ["--link" as never]: s(p.linkColor, "#0068a5"),
    };
    const dim = (mobile && p.hideOn === "mobile") || (!mobile && p.hideOn === "desktop");
    return (
      <div key={b.id} data-block={b.id} data-type={b.type} className={`eb-block${on ? " on" : ""}${dim ? " dim" : ""}`} onClick={(e) => { e.stopPropagation(); setSel({ kind: "block", id: b.id }); setTab("content"); }}>
        {isText
          ? <div style={{ padding: pad }} onFocus={() => { setTyping(true); setSel({ kind: "block", id: b.id }); }} onBlur={() => setTyping(false)}>
            <Editable tag={b.type === "title" ? s(p.level, "h1") : "div"} className="eb-text" style={typo} html={s(p.html)} singleLine={b.type === "title"} onCommit={(v) => apply(patchBlock(value, b.id, (x) => ({ ...x, p: { ...x.p, html: v } })))} />
          </div>
          : html ? <Shown html={html} />
            : b.type === "image" ? <ImageDrop onUrl={(url) => apply(patchBlock(value, b.id, (x) => ({ ...x, p: { ...x.p, src: url } })))} />
              : <div className="eb-empty"><Glyph d={TILE_ICONS[b.type]} /><strong>{BLOCK_LABELS[b.type]}</strong></div>}
        {on && <span className="eb-handle" draggable onDragStart={start({ kind: "block", id: b.id })} onDragEnd={end} title="Drag to move" aria-label="Drag to move"><Glyph d={ICON.move} size={16} /></span>}
        {on && <span className="eb-tools"><button type="button" title="Delete" aria-label="Delete block" onClick={(e) => { e.stopPropagation(); removeSel(); }}><Glyph d={ICON.trash} size={16} /></button><button type="button" title="Duplicate" aria-label="Duplicate block" onClick={(e) => { e.stopPropagation(); duplicateSel(); }}><Glyph d={ICON.copy} size={16} /></button></span>}
        {on && isText && typing && <TextBar />}
        {on && <span className="eb-tag">{BLOCK_LABELS[b.type]}</span>}
      </div>
    );
  };
  const rowEl = (r: Row) => {
    const on = sel?.kind === "row" && sel.id === r.id;
    const total = r.columns.reduce((a, c) => a + c.span, 0) || 12;
    const stack = mobile && r.p.stack !== false;
    const bw = n(r.p.borderWidth, 0);
    const dim = (mobile && r.p.hideOn === "mobile") || (!mobile && r.p.hideOn === "desktop");
    return (
      <div key={r.id} data-row={r.id} className={`eb-row-wrap${on ? " on" : ""}${dim ? " dim" : ""}`} style={{ background: s(r.p.bg, "transparent") }} onClick={(e) => { e.stopPropagation(); setSel({ kind: "row", id: r.id }); setTab("rows"); }}>
        <div className="eb-row-box" style={{ width: stageWidth, maxWidth: "100%", margin: value.p.align === "left" ? "0" : "0 auto", background: s(r.p.contentBg, "transparent") === "transparent" ? s(value.p.contentBg, "transparent") : s(r.p.contentBg), border: bw ? `${bw}px ${s(r.p.borderStyle, "solid")} ${s(r.p.borderColor, "transparent")}` : undefined, borderRadius: n(r.p.radius, 0), flexDirection: stack ? "column" : "row", alignItems: r.p.valign === "middle" ? "center" : r.p.valign === "bottom" ? "flex-end" : "stretch" }}>
          {r.columns.map((c) => {
            const cw = Math.round((stack ? stageWidth : stageWidth * c.span / total)) - n(c.p.padLeft, 0) - n(c.p.padRight, 0);
            const cb = n(c.p.borderWidth, 0);
            return (
              <div key={c.id} className="eb-col" data-col={c.id} onDragOver={overColumn(c.id)} onDrop={onDrop}
                style={{ width: stack ? "100%" : `${c.span / total * 100}%`, background: s(c.p.bg, "transparent"), padding: `${n(c.p.padTop, 0)}px ${n(c.p.padRight, 0)}px ${n(c.p.padBottom, 0)}px ${n(c.p.padLeft, 0)}px`, border: cb ? `${cb}px ${s(c.p.borderStyle, "solid")} ${s(c.p.borderColor, "transparent")}` : undefined }}>
                {c.blocks.map((b, i) => <div key={b.id} data-block={b.id} className="eb-slot">{drop && "colId" in drop && drop.colId === c.id && drop.index === i && line}{block(b, c, r, cw)}</div>)}
                {c.blocks.length > 0 && drop && "colId" in drop && drop.colId === c.id && drop.index === c.blocks.length && line}
                {/* An empty column keeps its drop area while something is dragged over it (swapping it out would lose the drop). */}
                {!c.blocks.length && <div className={`eb-dropzone${drop && "colId" in drop && drop.colId === c.id ? " over" : ""}`}>{drop && "colId" in drop && drop.colId === c.id ? "Drop it here" : "Drop content blocks here"}</div>}
              </div>
            );
          })}
        </div>
        <span className="eb-row-tag" draggable onDragStart={start({ kind: "moverow", id: r.id })} onDragEnd={end} title="Click to pick the row; drag to move it">Row</span>
        {on && <span className="eb-tools row"><button type="button" title="Delete" aria-label="Delete row" onClick={(e) => { e.stopPropagation(); removeSel(); }}><Glyph d={ICON.trash} size={16} /></button><button type="button" title="Duplicate" aria-label="Duplicate row" onClick={(e) => { e.stopPropagation(); duplicateSel(); }}><Glyph d={ICON.copy} size={16} /></button></span>}
      </div>
    );
  };

  /* The left side */
  const head = (title: string) => (
    <div className="eb-prop-head">
      <strong>{title}</strong>
      <span><button type="button" title="Delete" aria-label="Delete" onClick={removeSel}><Glyph d={ICON.trash} size={18} /></button><button type="button" title="Duplicate" aria-label="Duplicate" onClick={duplicateSel}><Glyph d={ICON.copy} size={18} /></button><button type="button" title="Close" aria-label="Close properties" onClick={() => setSel(null)}><Glyph d={ICON.close} size={18} /></button></span>
    </div>
  );
  const setBlockProps = (b: Block) => (patch: Props) => {
    // Changing a list between bullets and numbers changes its words' wrapper too.
    const html = b.type === "list" && typeof patch.listType === "string" ? s(b.p.html).replace(/<(\/?)(ul|ol)\b/g, `<$1${patch.listType}`) : undefined;
    apply(patchBlock(value, b.id, (x) => ({ ...x, p: { ...x.p, ...patch, ...(html !== undefined ? { html } : {}) } })));
  };
  const columnsEditor = (r: Row) => (
    <>
      <div className="eb-section">COLUMNS STRUCTURE</div>
      <div className="eb-field col">
        <div className="eb-colbar">{r.columns.map((c, i) => <span key={c.id} style={{ flex: c.span }}>{c.span}</span>)}</div>
        <div className="eb-row">
          <button type="button" className="eb-primary" disabled={r.columns.length >= 6} onClick={() => apply(patchRow(value, r.id, (x) => { const k = x.columns.length + 1; const span = Math.floor(12 / k); return { ...x, columns: [...x.columns.map((c) => ({ ...c, span })), { id: designId(), span: 12 - span * (k - 1), p: { ...COLUMN_DEFAULTS }, blocks: [] }] }; }))}>Add new column</button>
          <select aria-label="Columns layout" value="" onChange={(e) => { const spans = e.target.value.split("-").map(Number); if (!e.target.value) return; apply(patchRow(value, r.id, (x) => ({ ...x, columns: spans.map((span, i) => (x.columns[i] ? { ...x.columns[i], span } : { id: designId(), span, p: { ...COLUMN_DEFAULTS }, blocks: [] })).map((c, i, all) => (i === all.length - 1 ? { ...c, blocks: [...c.blocks, ...x.columns.slice(spans.length).flatMap((y) => y.blocks)] } : c)) }))); }}>
            <option value="">Change layout…</option>{ROW_LAYOUTS.map((l) => <option key={l.join("-")} value={l.join("-")}>{l.map((x) => `${Math.round(x / 12 * 100)}%`).join(" + ")}</option>)}
          </select>
        </div>
      </div>
      {r.columns.map((c, i) => (
        <div key={c.id}>
          <div className="eb-section sub">COLUMN {i + 1}{r.columns.length > 1 && <button type="button" className="eb-x" title="Delete this column" aria-label={`Delete column ${i + 1}`} onClick={() => apply(patchRow(value, r.id, (x) => { const rest = x.columns.filter((y) => y.id !== c.id); const give = Math.floor(c.span / rest.length); return { ...x, columns: rest.map((y, j) => ({ ...y, span: y.span + give + (j === rest.length - 1 ? c.span - give * rest.length : 0), blocks: j === 0 ? [...y.blocks, ...c.blocks] : y.blocks })) }; }))}>×</button>}</div>
          <Fields fields={COLUMN_FIELDS} p={c.p} set={(patch) => apply(patchRow(value, r.id, (x) => ({ ...x, columns: x.columns.map((y) => (y.id === c.id ? { ...y, p: { ...y.p, ...patch } } : y)) })))} />
        </div>
      ))}
    </>
  );

  return (
    <div className={`eb${structure ? " structure" : ""}`} onDragEnd={end}>
      <div className="eb-top">
        <div className="eb-actions">
          <button type="button" aria-haspopup="menu" aria-expanded={actions} onClick={() => setActions(!actions)} onBlur={() => setTimeout(() => setActions(false), 150)}>Actions <span aria-hidden="true">▾</span></button>
          {actions && <div className="eb-actions-menu" role="menu"><button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => { setActions(false); onPreview(); }}>Preview</button><button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => { setActions(false); onSendTest(); }}>Send test</button></div>}
        </div>
        <button type="button" aria-pressed={structure} onClick={() => setStructure(!structure)}><Glyph d={ICON.eye} size={16} /> {structure ? "Hide structure" : "Show structure"}</button>
        <a href="/help" target="_blank" rel="noreferrer" className="eb-help">? Help</a>
      </div>
      <div className="eb-main">
        <aside className="eb-side">
          <div className="eb-tabs" role="tablist" aria-label="Builder">
            {([["content", "CONTENT", ICON.content], ["rows", "ROWS", ICON.rows], ["settings", "SETTINGS", ICON.settings]] as const).map(([k, label, icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); setSel(null); }}><Glyph d={icon} size={20} /> {label}</button>
            ))}
          </div>
          <div className="eb-panel">
            {picked ? (
              <>{head("CONTENT PROPERTIES")}<Fields fields={FIELDS[picked.block.type]} p={picked.block.p} set={setBlockProps(picked.block)} block={picked.block} setBlock={(b) => apply(patchBlock(value, b.id, () => b))} /></>
            ) : pickedRow ? (
              <>{head("ROW PROPERTIES")}<Fields fields={ROW_FIELDS} p={pickedRow.p} set={(patch) => apply(patchRow(value, pickedRow.id, (x) => ({ ...x, p: { ...x.p, ...patch } })))} />{columnsEditor(pickedRow)}</>
            ) : tab === "content" ? (
              <div className="eb-tiles">
                {BLOCK_TYPES.map((t) => <button key={t} type="button" className="eb-tile" draggable onDragStart={start({ kind: "new", type: t })} onDragEnd={end} onClick={() => addBlock(t)} title={`Drag onto the email, or click to add a ${BLOCK_LABELS[t].toLowerCase()}`}><Glyph d={TILE_ICONS[t]} /><span>{BLOCK_LABELS[t].toUpperCase()}</span></button>)}
              </div>
            ) : tab === "rows" ? (
              <div className="eb-rows">
                <div className="eb-rows-pick">Empty</div>
                {ROW_LAYOUTS.map((l) => <button key={l.join("-")} type="button" className="eb-rowtile" draggable onDragStart={start({ kind: "row", spans: l })} onDragEnd={end} onClick={() => addRow(l)} title="Drag onto the email, or click to add this row at the end" aria-label={`Row: ${l.map((x) => `${Math.round(x / 12 * 100)}%`).join(" + ")}`}>{l.map((x, i) => <span key={i} style={{ flex: x }}><i /></span>)}</button>)}
              </div>
            ) : (
              <><Fields fields={SETTINGS_FIELDS} p={value.p} set={(patch) => apply({ ...value, p: { ...value.p, ...patch } })} />{extra}</>
            )}
          </div>
        </aside>
        <div className="eb-stage" style={{ background: s(value.p.bg, "#ffffff") }} onClick={() => setSel(null)} onDragOver={overStage} onDrop={onDrop}>
          <div className="eb-modes"><Segmented label="Stage mode" value={mobile ? "m" : "d"} onChange={(v) => setMobile(v === "m")} options={[["d", <Glyph key="d" d={ICON.desktop} size={16} />, "Desktop"], ["m", <Glyph key="m" d={ICON.mobile} size={16} />, "Mobile"]]} /></div>
          <div className={`eb-page${mobile ? " mobile" : ""}`} style={mobile ? { width: 360 } : undefined}>
            {value.rows.map((r, i) => <div key={r.id}>{drop && "rowIndex" in drop && drop.rowIndex === i && line}{rowEl(r)}</div>)}
            {drop && "rowIndex" in drop && drop.rowIndex === value.rows.length && value.rows.length > 0 && line}
            {!value.rows.length && <div className={`eb-dropzone first${drop ? " over" : ""}`} style={{ width: Math.min(stageWidth, 500), maxWidth: "100%" }}>{drop ? "Drop it here" : "Drop content blocks here"}</div>}
          </div>
          <div className="eb-history"><button type="button" title="Undo" aria-label="Undo" disabled={!past.current.length} onClick={(e) => { e.stopPropagation(); undo(); }}><Glyph d={ICON.undo} size={16} /></button><button type="button" title="Redo" aria-label="Redo" disabled={!future.current.length} onClick={(e) => { e.stopPropagation(); redo(); }}><Glyph d={ICON.redo} size={16} /></button></div>
        </div>
      </div>
    </div>
  );
}

/** An Image block with no picture yet: drop a file on it, or browse. */
function ImageDrop({ onUrl }: { onUrl: (url: string) => void }) {
  const up = useImageUpload(onUrl);
  return (
    <div className="eb-empty image" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); } }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); up.send(e.dataTransfer.files[0]); } }}>
      {up.field}
      <Glyph d={TILE_ICONS.image} /><strong>Image</strong><span>{up.busy ? "Uploading…" : "Drop your file here"}</span>
      <button type="button" onClick={(e) => { e.stopPropagation(); up.pick(); }}>Browse</button>
      {up.error && <span className="eb-err">{up.error}</span>}
    </div>
  );
}

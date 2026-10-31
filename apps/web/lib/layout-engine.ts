/**
 * Page layouts without touching each page: finds the boxes on a page (cards and other blocks)
 * and the items inside them (fields, details, filters, buttons), gives each a stable id from
 * its heading or label, and puts them in the owner's saved order with CSS `order`. Only
 * containers laid out with flex or grid can be reordered this way, which covers the boxes on
 * a page and the field grids, filter bars, button rows and stacks inside them.
 */
import type { PageLayouts } from "@crewdesk/shared";

export type PageLayout = Record<string, string[]>;

/** Pages with ids in the address share a layout, e.g. every /people/<id>. */
export function pageKey(pathname: string) {
  return (
    pathname
      .split("/")
      .map((seg) => (/^[0-9a-f-]{16,}$/i.test(seg) || /^\d+$/.test(seg) ? ":id" : seg))
      .join("/") || "/"
  );
}

/** Inside a box, these hold items that can be reordered. */
const ITEM_CONTAINERS = ".formgrid, .filters, .row, .stack, .grid, .settings-tabs, .tabs";
/** Never treated as boxes or items. */
const SKIP = "script, style, template, .layout-editor-bar, .mix-window-backdrop, [role=dialog]";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A readable name for an element: its heading, label, legend or first words. */
function nameOf(el: Element): string {
  const own = (sel: string) => el.querySelector(sel)?.textContent?.trim();
  const direct = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())?.textContent?.trim();
  const candidates = [
    el.matches("h1, h2, h3, legend, button, a, strong, summary") ? el.textContent?.trim() : undefined,
    el.getAttribute("aria-label") ?? undefined,
    own(":scope > h1, :scope > h2, :scope > h3, :scope > legend, :scope > summary, :scope > .muted, :scope > strong"),
    el.matches("label") ? direct : undefined,
    own("h1, h2, h3, legend, summary"),
    (el as HTMLInputElement).placeholder || undefined,
    direct,
    el.textContent?.trim(),
  ];
  const name = candidates.find((c) => c && c.length > 0) ?? el.tagName.toLowerCase();
  return name.replace(/\s+/g, " ").slice(0, 48);
}

const HEADING = ":scope > h1, :scope > h2, :scope > h3, :scope > legend, :scope > summary, :scope > div > h2, :scope > div > h3, :scope > details > summary";
/** The element's first class, ignoring the editor's own (layout-dragging etc.), or its tag. */
const firstClass = (el: Element | null | undefined) => {
  if (!el) return "";
  const cls = Array.from(el.classList).find((c) => !c.startsWith("layout-"));
  return cls ?? el.tagName.toLowerCase();
};

/**
 * A box's id comes from its heading when it has one; otherwise from its structure (not its
 * text), so editing what's in it doesn't lose its place. Items use their label.
 */
function idBaseOf(el: Element, kind: "box" | "item") {
  if (kind === "item") return slug(nameOf(el));
  const heading = el.querySelector(HEADING)?.textContent?.trim();
  if (heading) return slug(heading);
  return slug(`${firstClass(el)}-${firstClass(el.firstElementChild)}`) || "box";
}

/** What the editor shows on a box: its heading, or "Box: " and its first couple of item labels. */
function boxLabel(el: Element) {
  const heading = el.querySelector(HEADING)?.textContent?.trim();
  if (heading) return heading.replace(/\s+/g, " ").slice(0, 48);
  const labels = Array.from(el.querySelectorAll("label, .muted, strong, legend")).map((n) => (n.childNodes[0]?.textContent ?? "").trim()).filter(Boolean);
  if (labels.length) return `Box: ${labels.slice(0, 2).join(", ")}${labels.length > 2 ? "…" : ""}`.slice(0, 48);
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  return text ? `“${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”` : "Box";
}

function children(container: Element) {
  return Array.from(container.children).filter((c) => !c.matches(SKIP) && (c as HTMLElement).offsetParent !== null || c.matches(".pagehead"));
}

/** Saved items move into the slots saved items occupy; anything new stays where the page put it. */
export function arrange(domOrder: string[], saved: string[] | undefined) {
  if (!saved?.length) return domOrder;
  const present = new Set(domOrder);
  const savedHere = saved.filter((id) => present.has(id));
  const savedSet = new Set(savedHere);
  let next = 0;
  return domOrder.map((id) => (savedSet.has(id) ? savedHere[next++] : id));
}

export interface Scanned {
  containers: Map<string, HTMLElement[]>;
}

/**
 * Tags everything on the page and applies `layout`. Returns each container's children in their
 * current visual order, which the editor uses when something is dragged.
 */
export function applyLayout(root: HTMLElement, layout: PageLayout | undefined, editing: boolean): Scanned {
  const containers = new Map<string, HTMLElement[]>();

  const tagChildren = (container: Element, key: string, kind: "box" | "item") => {
    const kids = children(container) as HTMLElement[];
    if (kids.length < 2) return [];
    const used = new Map<string, number>();
    const ids = kids.map((el) => {
      const base = el.matches(".pagehead") ? "page-heading" : idBaseOf(el, kind) || el.tagName.toLowerCase();
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const id = `${key}/${n > 1 ? `${base}-${n}` : base}`;
      el.dataset.lid = id;
      el.dataset.lkind = kind;
      el.dataset.lname = kind === "box" ? boxLabel(el) : nameOf(el);
      el.dataset.lparent = key;
      const movable = editing && !el.matches(".pagehead");
      if (movable) el.setAttribute("draggable", "true");
      else if (el.dataset.ldrag) el.removeAttribute("draggable");
      el.dataset.ldrag = movable ? "1" : "";
      return id;
    });
    const order = arrange(ids, layout?.[key]);
    const byId = new Map(kids.map((el, i) => [ids[i], el]));
    order.forEach((id, i) => { byId.get(id)!.style.order = String(i); });
    const visual = order.map((id) => byId.get(id)!);
    containers.set(key, visual);
    return visual;
  };

  const tagItems = (box: HTMLElement) => {
    const boxId = box.dataset.lid!;
    const inner = [box, ...Array.from(box.querySelectorAll<HTMLElement>(ITEM_CONTAINERS))].filter((c) => {
      if (c.closest("table, " + SKIP)) return false;
      const d = getComputedStyle(c).display;
      return d.includes("flex") || d.includes("grid");
    });
    const seen = new Map<string, number>();
    for (const c of inner) {
      const kind = slug(firstClass(c));
      const n = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, n);
      tagChildren(c, c === box ? `${boxId}>` : `${boxId}>${kind}-${n}`, "item");
    }
  };

  root.dataset.lid = "page";
  // Plain wrappers holding boxes (e.g. a tab panel) become stacks so their boxes can move too.
  for (const el of Array.from(root.children) as HTMLElement[]) {
    if (!el.matches(".card, .pagehead, .grid, " + SKIP) && el.querySelector(":scope > .card")) el.dataset.lgroup = "1";
  }
  const boxes = tagChildren(root, "page", "box");
  for (const b of boxes) {
    if (b.matches(".grid") || b.dataset.lgroup) {
      for (const inner of tagChildren(b, b.dataset.lid!, "box")) tagItems(inner);
    } else if (!b.matches(".pagehead")) tagItems(b);
  }
  return { containers };
}

/** The new order of a container after dropping `moving` just before or after `target`. */
export function moveWithin(visual: HTMLElement[], moving: HTMLElement, target: HTMLElement, after: boolean) {
  const ids = visual.map((el) => el.dataset.lid!);
  if (!ids.includes(moving.dataset.lid!) || !ids.includes(target.dataset.lid!) || moving === target) return null;
  const rest = ids.filter((id) => id !== moving.dataset.lid);
  rest.splice(rest.indexOf(target.dataset.lid!) + (after ? 1 : 0), 0, moving.dataset.lid!);
  return rest.join() === ids.join() ? null : rest;
}

/** Whether a drop at (x, y) lands after `target`: its right half in a row, its lower half in a column. */
export function dropsAfter(target: HTMLElement, x: number, y: number) {
  const r = target.getBoundingClientRect();
  const parent = target.parentElement ? getComputedStyle(target.parentElement) : null;
  const horizontal = !!parent && ((parent.display.includes("flex") && !parent.flexDirection.startsWith("column")) || (parent.display.includes("grid") && r.width < (target.parentElement!.getBoundingClientRect().width * 0.9)));
  return horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
}

export const isEmptyLayout = (l: PageLayout | undefined) => !l || !Object.keys(l).length;
export type { PageLayouts };

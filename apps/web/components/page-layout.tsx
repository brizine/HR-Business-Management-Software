"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MenuEditors } from "./menu-editors";
import { menusForPage } from "@crewdesk/shared";
import { HIDDEN_KEY, WIDTHS, WIDTH_KEY, WIDTH_LABELS, applyLayout, besideWidths, boxDrop, dropsAfter, isEmptyLayout, moveWithin, pageKey, readWidths, writeWidths, type PageLayout, type PageLayouts } from "@/lib/layout-engine";

const EDITOR_FLAG = "crewdesk.layoutEditor";
/** Unsaved editor changes, kept for this tab so a reload doesn't lose them. */
const DRAFT_KEY = "crewdesk.layoutDraft";
const readDraft = (): PageLayouts => {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}"); } catch { return {}; }
};

interface LayoutCtx {
  saved: PageLayouts;
  setSaved: (p: PageLayouts) => void;
}
const Ctx = createContext<LayoutCtx>({ saved: {}, setSaved: () => {} });
export const useSavedLayouts = () => useContext(Ctx);

/** Settings → Layout editor: open the editor in a new tab. */
export function PageLayoutsCard({ children }: { children?: ReactNode }) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Page layouts</h2>
      <p className="muted" style={{ margin: 0 }}>
        Opens a working copy of Crewdesk in a new tab where you can rearrange any page: drag its boxes to move them on the page, and drag
        the items inside a box (fields, details, filters, buttons) to move them within it. Nobody else sees your changes until you click Save there,
        and Reset this page in the editor puts a page back to its original layout. Edit drop-down menus there changes the choices in that page&apos;s menus.
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => window.open("/dashboard?layout-editor=1", "_blank")}>Open layout editor</button>
      </div>
      {children}
    </div>
  );
}

/** Is this tab the owner's layout editor? (Opened from Settings → Layout editor; only that tab.) */
function useEditorMode(isOwner: boolean) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!isOwner) return setOn(false);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("layout-editor") === "1") {
        sessionStorage.setItem(EDITOR_FLAG, "1");
        url.searchParams.delete("layout-editor");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
      setOn(sessionStorage.getItem(EDITOR_FLAG) === "1");
    } catch {
      setOn(false);
    }
  }, [isOwner]);
  const exit = () => {
    try { sessionStorage.removeItem(EDITOR_FLAG); } catch {}
    setOn(false);
  };
  return { on, exit };
}

/**
 * Wraps every page: applies the owner's saved layout for everyone, and in the owner's layout
 * editor tab lets them drag boxes and the items inside them. Edits stay in this tab until Save.
 */
export function PageLayoutRoot({ children }: { children: ReactNode }) {
  const { me, can } = useAuth();
  const path = usePathname();
  const page = pageKey(path);
  const root = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<PageLayouts>({});
  const [draft, setDraftState] = useState<PageLayouts>({});
  const setDraft = useCallback((next: PageLayouts | ((d: PageLayouts) => PageLayouts)) => {
    setDraftState((d) => {
      const value = typeof next === "function" ? next(d) : next;
      try { if (Object.keys(value).length) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value)); else sessionStorage.removeItem(DRAFT_KEY); } catch {}
      return value;
    });
  }, []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const editor = useEditorMode(can("owner", "company"));
  useEffect(() => { if (editor.on) setDraftState(readDraft()); }, [editor.on]);
  const scanned = useRef<ReturnType<typeof applyLayout> | null>(null);
  const dragging = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (me) api<{ pages: PageLayouts }>("/employees/layouts").then((r) => setSaved(r.pages), () => {});
  }, [me?.company.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const layoutFor = useCallback((p: string): PageLayout | undefined => (p in draft ? draft[p] : saved[p]), [draft, saved]);
  const dirtyPages = Object.keys(draft).filter((p) => JSON.stringify(draft[p] ?? {}) !== JSON.stringify(saved[p] ?? {}));

  // Apply now, and again whenever the page changes what it shows.
  const apply = useCallback(() => {
    if (root.current) scanned.current = applyLayout(root.current, layoutFor(page), editor.on);
  }, [layoutFor, page, editor.on]);
  useLayoutEffect(() => {
    apply();
    if (!root.current) return;
    let frame = 0;
    const obs = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); });
    obs.observe(root.current, { childList: true, subtree: true });
    window.addEventListener("resize", apply);
    return () => { obs.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", apply); };
  }, [apply]);

  // Dragging (editor only): a box moves among the page's boxes, an item among its box's items.
  // A line shows where it will land; it moves on drop, to wherever the line was (even if the pointer
  // ends up in a gap between boxes). Near the top or bottom of the window the page scrolls.
  useEffect(() => {
    const el = root.current;
    if (!el || !editor.on) return;
    const target = (e: Event) => (e.target as Element | null)?.closest?.("[data-ldrag='1']") as HTMLElement | null;
    const marked = { el: null as HTMLElement | null, spot: null as null | "left" | "right" | "before" | "after" };
    const unmark = () => { marked.el?.classList.remove("layout-drop-before", "layout-drop-after", "layout-drop-left", "layout-drop-right"); marked.el = null; marked.spot = null; };
    const pointer = { x: 0, y: 0 };
    let scrollFrame = 0;

    /** The box (or item) to drop next to: the one under the pointer, else the nearest one in the same place. */
    const findTarget = (x: number, y: number, under: Element | null) => {
      const moving = dragging.current;
      if (!moving) return null;
      const parent = moving.dataset.lparent ?? "";
      const hit = under?.closest?.(`[data-lparent="${CSS.escape(parent)}"]`) as HTMLElement | null;
      if (hit && hit !== moving) return hit;
      if (hit === moving) return null; // still over itself: no move
      const siblings = (scanned.current?.containers.get(parent) ?? []).filter((s) => s !== moving && s.isConnected && s.getClientRects().length);
      // Items only move within their own box, so only look for them while the pointer is near it.
      if (moving.dataset.lkind !== "box") {
        const box = moving.parentElement?.getBoundingClientRect();
        if (!box || x < box.left - 40 || x > box.right + 40 || y < box.top - 40 || y > box.bottom + 40) return null;
      }
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const s of siblings) {
        const r = s.getBoundingClientRect();
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = s; }
      }
      return best;
    };
    const spotFor = (over: HTMLElement, x: number, y: number) => {
      // Outside the target (in a gap): above/below it, or beside it if level with it.
      const r = over.getBoundingClientRect();
      if (dragging.current?.dataset.lkind === "box") {
        if (y >= r.top && y <= r.bottom && x < r.left) return "left";
        if (y >= r.top && y <= r.bottom && x > r.right) return "right";
        return boxDrop(over, Math.min(Math.max(x, r.left + r.width * 0.3), r.right - r.width * 0.3), y);
      }
      return dropsAfter(over, x, y) ? "after" : "before";
    };
    const mark = (x: number, y: number, under: Element | null) => {
      const over = findTarget(x, y, under);
      if (!over) return unmark();
      const spot = spotFor(over, x, y) as typeof marked.spot;
      if (marked.el !== over) unmark();
      marked.el = over;
      marked.spot = spot;
      for (const k of ["left", "right", "before", "after"]) over.classList.toggle(`layout-drop-${k}`, k === spot);
    };

    /** Scrolls the page while the pointer is near the top or bottom of the window. */
    const autoScroll = () => {
      if (!dragging.current) return;
      const zone = Math.min(100, window.innerHeight / 5);
      const y = pointer.y;
      const speed = y < zone ? -Math.ceil(((zone - y) / zone) * 24) : y > window.innerHeight - zone ? Math.ceil(((y - (window.innerHeight - zone)) / zone) * 24) : 0;
      if (speed) {
        window.scrollBy(0, speed);
        mark(pointer.x, pointer.y, document.elementFromPoint(pointer.x, pointer.y));
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };

    const onOver = (e: DragEvent) => {
      if (!dragging.current) return;
      e.preventDefault(); // allow dropping anywhere on the page
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      mark(e.clientX, e.clientY, e.target as Element | null);
    };
    const finish = () => {
      cancelAnimationFrame(scrollFrame);
      unmark();
      dragging.current?.classList.remove("layout-dragging");
      dragging.current = null;
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("drop", onDrop);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const moving = dragging.current;
      const over = marked.el;
      const spot = marked.spot;
      finish();
      if (!moving || !over || !spot) return;
      const visual = scanned.current?.containers.get(moving.dataset.lparent!);
      if (!visual) return;
      const isBox = moving.dataset.lkind === "box";
      const order = moveWithin(visual, moving, over, spot === "after" || spot === "right");
      const beside = isBox && (spot === "left" || spot === "right");
      if (!order && !beside) return;
      setDraft((d) => {
        const current = page in d ? d[page] : saved[page] ?? {};
        const next = { ...current, ...(order ? { [moving.dataset.lparent!]: order } : {}) };
        // Dropped beside another box: the two share that box's width.
        if (beside) next[WIDTH_KEY] = writeWidths(besideWidths(readWidths(current), moving, over));
        return { ...d, [page]: next };
      });
      setNote(beside ? `“${moving.dataset.lname}” now sits beside “${over.dataset.lname}”. Point at a box to change its width.` : null);
    };
    const onStart = (e: DragEvent) => {
      const t = target(e);
      if (!t) return;
      e.stopPropagation();
      dragging.current = t;
      t.classList.add("layout-dragging");
      e.dataTransfer?.setData("text/plain", t.dataset.lid ?? "");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      // Listen on the whole document so a drop outside the boxes (in a gap, or by the header) still counts.
      document.addEventListener("dragover", onOver);
      document.addEventListener("drop", onDrop);
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(autoScroll);
    };
    // Dropped outside the window or cancelled with Escape: nothing moves.
    const onEnd = () => finish();
    el.addEventListener("dragstart", onStart);
    el.addEventListener("dragend", onEnd);
    return () => {
      finish();
      el.removeEventListener("dragstart", onStart);
      el.removeEventListener("dragend", onEnd);
    };
  }, [editor.on, page, saved, setDraft]);

  // Hide / Show (editor only): a small button over whatever box or item the pointer is on.
  const [hovered, setHovered] = useState<{ el: HTMLElement; rect: DOMRect } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || !editor.on) return setHovered(null);
    const onMove = (e: MouseEvent) => {
      if (dragging.current) return;
      const t = (e.target as Element | null)?.closest?.("[data-ldrag='1']") as HTMLElement | null;
      setHovered((h) => (t ? (h?.el === t ? h : { el: t, rect: t.getBoundingClientRect() }) : h));
    };
    const refresh = () => setHovered((h) => (h && h.el.isConnected ? { el: h.el, rect: h.el.getBoundingClientRect() } : null));
    el.addEventListener("mouseover", onMove);
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    return () => { el.removeEventListener("mouseover", onMove); window.removeEventListener("scroll", refresh, true); window.removeEventListener("resize", refresh); };
  }, [editor.on]);
  const toggleHidden = (target: HTMLElement) => {
    const id = target.dataset.lid!;
    setDraft((d) => {
      const current = page in d ? d[page] : saved[page] ?? {};
      const list = current[HIDDEN_KEY] ?? [];
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      return { ...d, [page]: { ...current, [HIDDEN_KEY]: next } };
    });
    setNote(target.dataset.lhidden === "1" ? `“${target.dataset.lname}” will show again.` : `“${target.dataset.lname}” will be hidden for everyone once you save.`);
    requestAnimationFrame(() => setHovered((h) => (h ? { el: h.el, rect: h.el.getBoundingClientRect() } : null)));
  };

  const setWidth = (target: HTMLElement, w: number) => {
    setDraft((d) => {
      const current = page in d ? d[page] : saved[page] ?? {};
      const widths = readWidths(current);
      widths.set(target.dataset.lid!, w);
      return { ...d, [page]: { ...current, [WIDTH_KEY]: writeWidths(widths) } };
    });
    setNote(`“${target.dataset.lname}” is now ${w === 100 ? "full width" : `${WIDTH_LABELS[w]} of the page width`}.`);
    requestAnimationFrame(() => setHovered((h) => (h ? { el: h.el, rect: h.el.getBoundingClientRect() } : null)));
  };

  // "Edit drop-down menus": the Job title and Department choices, in a window over the page.
  const [menusOpen, setMenusOpen] = useState(false);
  useEffect(() => {
    if (!menusOpen) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenusOpen(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [menusOpen]);

  const save = async () => {
    setBusy(true);
    try {
      const pages = Object.fromEntries(dirtyPages.map((p) => [p, isEmptyLayout(draft[p]) ? null : draft[p]]));
      const res = await api<{ pages: PageLayouts }>("/employees/layouts", { method: "PUT", body: { pages } });
      setSaved(res.pages);
      setDraft({});
      setNote(`Saved ${dirtyPages.length} page${dirtyPages.length === 1 ? "" : "s"}. Everyone now sees the new layout.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pageName = (root.current?.querySelector(".pagehead h1")?.textContent ?? page).trim();
  const pageMenus = menusForPage(page).map((m) => m.key);

  return (
    <Ctx.Provider value={{ saved, setSaved }}>
      {editor.on && (
        <div className="layout-editor-bar" role="region" aria-label="Layout editor">
          <div>
            <strong>Layout editor</strong> · {pageName}
            <div className="layout-editor-hint">
              {note ?? "Drag boxes anywhere on the page: drop on another box's left or right edge to sit beside it, or top or bottom to go above or below. Drag items within their box. Point at a box to set its width or hide it. Only you see changes until you save."}
            </div>
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <button className="btn primary" disabled={busy || !dirtyPages.length} onClick={save}>
              {busy ? "Saving…" : `Save${dirtyPages.length ? ` (${dirtyPages.length} page${dirtyPages.length === 1 ? "" : "s"})` : ""}`}
            </button>
            <button className="btn" onClick={() => setMenusOpen(true)}>Edit drop-down menus</button>
            <button className="btn" disabled={busy || (isEmptyLayout(layoutFor(page)))} onClick={() => { setDraft((d) => ({ ...d, [page]: {} })); setNote("This page is back to its default layout. Save to keep it."); }}>Reset this page</button>
            <button className="btn" disabled={busy || !dirtyPages.length} onClick={() => { setDraft({}); setNote("Changes discarded."); }}>Discard</button>
            <button className="btn" onClick={() => {
              if (dirtyPages.length && !confirm("Leave the layout editor without saving your changes?")) return;
              setDraft({});
              editor.exit();
              if (window.opener) window.close();
            }}>Exit editor</button>
          </div>
        </div>
      )}
      <div ref={root} className={`layout-page${editor.on ? " layout-editing" : ""}`}>{children}</div>
      {editor.on && menusOpen && createPortal(
        <div className="mix-window-backdrop" onClick={(e) => e.target === e.currentTarget && setMenusOpen(false)}>
          <div className="mix-window menus-window" role="dialog" aria-modal="true" aria-labelledby="menus-window-title">
            <div className="mix-window-head">
              <div>
                <h2 id="menus-window-title" style={{ margin: 0 }}>Drop-down menus on {pageName}</h2>
                <div className="muted">The choices in this page&apos;s drop-down menus. Changes save as you make them and apply everywhere the menu is used.</div>
              </div>
              <button type="button" className="mix-window-close" onClick={() => setMenusOpen(false)} aria-label="Close" title="Close" autoFocus>×</button>
            </div>
            {pageMenus.length ? <MenuEditors keys={pageMenus} /> : (
              <p className="muted" style={{ margin: 0 }}>
                This page has no drop-down menus with editable choices. Menus that list your own records (people, assets, time-off types, checklists) change when you edit those records, and settings menus are fixed.
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
      {editor.on && hovered && hovered.el.isConnected && createPortal(
        <div
          className="layout-toolbar"
          // A box's toolbar sits on its top edge (so reaching it doesn't cross the box's items); an item's just inside.
          style={{ top: Math.max(hovered.rect.top + (hovered.el.dataset.lkind === "box" ? -16 : 2), 4), left: Math.max(hovered.rect.right - (hovered.el.dataset.lkind === "box" ? 300 : 72), 4) }}
          role="toolbar"
          aria-label={`Layout of ${hovered.el.dataset.lname}`}
        >
          {hovered.el.dataset.lkind === "box" && (
            <>
              <span className="layout-toolbar-label">Width</span>
              {WIDTHS.map((w) => (
                <button key={w} type="button" className="layout-hide-btn" aria-pressed={hovered.el.dataset.lwidth === String(w)}
                  aria-label={`Width ${w === 100 ? "full" : WIDTH_LABELS[w]}`} onClick={() => setWidth(hovered.el, w)}>{WIDTH_LABELS[w]}</button>
              ))}
            </>
          )}
          <button type="button" className="layout-hide-btn" onClick={() => toggleHidden(hovered.el)}
            aria-label={`${hovered.el.dataset.lhidden === "1" ? "Show" : "Hide"} ${hovered.el.dataset.lname}`}>
            {hovered.el.dataset.lhidden === "1" ? "👁 Show" : "🚫 Hide"}
          </button>
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

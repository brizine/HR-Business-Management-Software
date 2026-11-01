"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MenuEditors } from "./menu-editors";
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

/** Settings → Company: open the editor in a new tab. */
export function PageLayoutsCard({ children }: { children?: ReactNode }) {
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Page layouts</h2>
      <p className="muted" style={{ margin: 0 }}>
        Opens a working copy of Crewdesk in a new tab where you can rearrange any page: drag its boxes to move them on the page, and drag
        the items inside a box (fields, details, filters, buttons) to move them within it. Nobody else sees your changes until you click Save there,
        and Reset this page in the editor puts a page back to its original layout.
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => window.open("/dashboard?layout-editor=1", "_blank")}>Open layout editor</button>
      </div>
      {children}
    </div>
  );
}

/** Is this tab the owner's layout editor? (Opened from Settings → Company; only that tab.) */
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
  useEffect(() => {
    const el = root.current;
    if (!el || !editor.on) return;
    const target = (e: Event) => (e.target as Element | null)?.closest?.("[data-ldrag='1']") as HTMLElement | null;
    const onStart = (e: DragEvent) => {
      const t = target(e);
      if (!t) return;
      e.stopPropagation();
      dragging.current = t;
      t.classList.add("layout-dragging");
      e.dataTransfer?.setData("text/plain", t.dataset.lid ?? "");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    };
    // While dragging, a line shows where it will land; it moves only on drop (no jumping around).
    const marked = { el: null as HTMLElement | null };
    const unmark = () => { marked.el?.classList.remove("layout-drop-before", "layout-drop-after", "layout-drop-left", "layout-drop-right"); marked.el = null; };
    const overTarget = (e: DragEvent) => {
      const moving = dragging.current;
      if (!moving) return null;
      const over = (e.target as Element | null)?.closest?.(`[data-lparent="${CSS.escape(moving.dataset.lparent ?? "")}"]`) as HTMLElement | null;
      return over && over !== moving ? over : null;
    };
    const onOver = (e: DragEvent) => {
      const over = overTarget(e);
      if (!dragging.current) return;
      e.preventDefault();
      if (!over) return unmark();
      const spot = over.dataset.lkind === "box" ? boxDrop(over, e.clientX, e.clientY) : dropsAfter(over, e.clientX, e.clientY) ? "after" : "before";
      if (marked.el !== over) unmark();
      marked.el = over;
      for (const k of ["left", "right", "before", "after"]) over.classList.toggle(`layout-drop-${k}`, k === spot);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const moving = dragging.current;
      const over = overTarget(e);
      unmark();
      if (!moving || !over) return;
      const visual = scanned.current?.containers.get(moving.dataset.lparent!);
      if (!visual) return;
      const isBox = moving.dataset.lkind === "box";
      const spot = isBox ? boxDrop(over, e.clientX, e.clientY) : dropsAfter(over, e.clientX, e.clientY) ? "after" : "before";
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
    const onEnd = () => { unmark(); dragging.current?.classList.remove("layout-dragging"); dragging.current = null; };
    el.addEventListener("dragstart", onStart);
    el.addEventListener("dragover", onOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragend", onEnd);
    return () => {
      el.removeEventListener("dragstart", onStart);
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("drop", onDrop);
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
                <h2 id="menus-window-title" style={{ margin: 0 }}>Drop-down menus</h2>
                <div className="muted">The choices people pick from on the employee and hiring forms. Changes save as you make them.</div>
              </div>
              <button type="button" className="mix-window-close" onClick={() => setMenusOpen(false)} aria-label="Close" title="Close" autoFocus>×</button>
            </div>
            <MenuEditors />
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

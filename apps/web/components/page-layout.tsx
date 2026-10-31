"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { applyLayout, dropsAfter, isEmptyLayout, moveWithin, pageKey, type PageLayout, type PageLayouts } from "@/lib/layout-engine";

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

/** Settings → Company: open the editor in a new tab, and see or reset the pages already arranged. */
export function PageLayoutsCard() {
  const { saved, setSaved } = useSavedLayouts();
  const [error, setError] = useState<string | null>(null);
  const pages = Object.keys(saved).sort();
  const reset = async (p: string | null) => {
    setError(null);
    try {
      const body = { pages: Object.fromEntries((p ? [p] : pages).map((k) => [k, null])) };
      setSaved((await api<{ pages: PageLayouts }>("/employees/layouts", { method: "PUT", body })).pages);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const label = (p: string) => p.replace(/^\//, "").replace(/\/:id/g, " (each one)").replace(/\//g, " › ").replace(/-/g, " ") || "home";
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Page layouts</h2>
      <p className="muted" style={{ margin: 0 }}>
        Opens a working copy of Crewdesk in a new tab where you can rearrange any page: drag its boxes to move them on the page, and drag
        the items inside a box (fields, details, filters, buttons) to move them within it. Nobody else sees your changes until you click Save there.
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => window.open("/dashboard?layout-editor=1", "_blank")}>Open layout editor</button>
        {pages.length > 1 && <button className="btn" onClick={() => confirm("Put every page back to its default layout?") && reset(null)}>Reset all pages</button>}
      </div>
      {pages.length ? (
        <ul className="menu-list">
          {pages.map((p) => (
            <li key={p}>
              <span style={{ flex: 1, textTransform: "capitalize" }}>{label(p)}</span>
              <button className="btn sm" onClick={() => confirm(`Put "${label(p)}" back to its default layout?`) && reset(p)}>Reset</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted" style={{ margin: 0 }}>Every page uses its default layout.</p>}
      {error && <div className="error" role="alert">{error}</div>}
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
  const editor = useEditorMode(can("owner"));
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
    const unmark = () => { marked.el?.classList.remove("layout-drop-before", "layout-drop-after"); marked.el = null; };
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
      const after = dropsAfter(over, e.clientX, e.clientY);
      if (marked.el !== over) unmark();
      marked.el = over;
      over.classList.toggle("layout-drop-after", after);
      over.classList.toggle("layout-drop-before", !after);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const moving = dragging.current;
      const over = overTarget(e);
      unmark();
      if (!moving || !over) return;
      const visual = scanned.current?.containers.get(moving.dataset.lparent!);
      const order = visual && moveWithin(visual, moving, over, dropsAfter(over, e.clientX, e.clientY));
      if (!order) return;
      setDraft((d) => ({ ...d, [page]: { ...(page in d ? d[page] : saved[page] ?? {}), [moving.dataset.lparent!]: order } }));
      setNote(null);
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
              {note ?? "Drag the outlined boxes to move them on this page, and drag the items inside a box to move them within it. Only you see changes until you save."}
            </div>
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <button className="btn primary" disabled={busy || !dirtyPages.length} onClick={save}>
              {busy ? "Saving…" : `Save${dirtyPages.length ? ` (${dirtyPages.length} page${dirtyPages.length === 1 ? "" : "s"})` : ""}`}
            </button>
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
    </Ctx.Provider>
  );
}

"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { describe, type TipFacts } from "@/lib/tips";

/**
 * Hover descriptions for the whole app, drawn in one place: rest the pointer on a button (or tab to
 * it) and a short line says what it does. One listener on the page does all of it, so no button
 * needs anything added; the words come from the button's own `title` or `data-tip`, or from the
 * lists in lib/tip-words.ts (see lib/tips.ts for the order).
 *
 * A `title` is shown in this style too, in place of the browser's own slow yellow box.
 */

/** What can have a description. */
const TARGETS = "[data-tip], [title], [data-tip-title], button, [role='button'], a.btn, a.topbar-icon, a.rail-btn, a.rail-link, a.menu-link, label.btn, summary";
/** The left menu's pages and the Operations | Team switch. */
const NAV = ".rail a, .rail .rail-btn, .side-switch button";
/** Column headings that sort the list. */
const SORT = ".cl-sort, .dx-th, th button, th[role='button'], button[aria-sort]";
const WAIT = 450;   // before the first one shows
const NEXT = 80;    // moving straight from one button to the next

/** What the page knows about a button (lib/tips.ts turns this into its description). */
export function tipFacts(el: Element, path: string): TipFacts {
  const classes = [...el.classList];
  return {
    text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    aria: (el.getAttribute("aria-label") ?? "").trim(),
    written: (el.getAttribute("data-tip") ?? el.getAttribute("data-tip-title") ?? el.getAttribute("title") ?? "").trim(),
    classes, path,
    nav: el.matches(NAV),
    sort: el.matches(SORT),
    // The app's own buttons are called btn (or something-btn): those are the ones that do something.
    action: el.matches("button, a, label, summary, [role='button']") && classes.some((c) => /^(btn|linkbtn|linkish|linklike)$|-btn$|^btn-/.test(c)),
  };
}

/** The description for whatever the pointer is on, or null when there is nothing worth saying. */
export function tipFor(el: Element, path: string): string | null {
  const facts = tipFacts(el, path);
  // Something that isn't a button is only described by what was written for it.
  if (!el.matches("button, [role='button'], a, label.btn, summary")) return facts.written && facts.written.toLowerCase() !== facts.text.toLowerCase() ? facts.written : null;
  return describe(facts);
}

export function Tips() {
  const [tip, setTip] = useState<{ text: string; box: DOMRect } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; arrow: number; above: boolean } | null>(null);

  useEffect(() => {
    // Nothing to hover with on a touch screen.
    if (window.matchMedia("(hover: none)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    // The button just clicked says nothing more until the pointer has left it.
    let clicked: Element | null = null;
    let hidAt = 0;
    let showing = false;
    // For checking how much of a page is described, from the browser's console: crewdeskTip($0).
    Object.assign(window, { crewdeskTip: (el: Element) => tipFor(el, window.location.pathname), crewdeskTipFacts: (el: Element) => tipFacts(el, window.location.pathname) });
    const leave = () => {
      clearTimeout(timer);
      if (!current) return;
      // The browser's own tooltip gets its words back.
      const kept = current.getAttribute("data-tip-title");
      if (kept != null) { current.setAttribute("title", kept); current.removeAttribute("data-tip-title"); }
      current = null;
      // Remembered at once (not when React gets round to it), so the next button knows one was just showing.
      if (showing) hidAt = Date.now();
      showing = false;
      setTip(null);
    };
    const enter = (el: Element) => {
      if (el === current || el === clicked) return;
      leave();
      current = el;
      // Taken off while we show ours, so the two don't appear together.
      const title = el.getAttribute("title");
      if (title != null) { el.setAttribute("data-tip-title", title); el.removeAttribute("title"); }
      timer = setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        const text = tipFor(el, window.location.pathname);
        if (text) { showing = true; setTip({ text, box: el.getBoundingClientRect() }); }
      }, Date.now() - hidAt < 350 ? NEXT : WAIT);
    };
    const find = (t: EventTarget | null) => (t instanceof Element ? t.closest(TARGETS) : null);
    const over = (e: MouseEvent) => { const el = find(e.target); if (el) enter(el); else leave(); };
    const out = (e: MouseEvent) => {
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (clicked && !(to && clicked.contains(to))) clicked = null;
      if (current && !(to && current.contains(to))) leave();
    };
    const press = (e: MouseEvent) => { clicked = find(e.target); leave(); };
    const focus = (e: FocusEvent) => {
      // Only for the keyboard: a click focuses too, and has just said what it wanted.
      const el = find(e.target);
      if (el && el instanceof HTMLElement && el.matches(":focus-visible")) enter(el);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" || !["Tab", "Shift"].includes(e.key)) leave(); };
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("mousedown", press, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", leave, true);
    window.addEventListener("blur", leave);
    return () => {
      leave();
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("mousedown", press, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", leave, true);
      window.removeEventListener("blur", leave);
    };
  }, []);

  // Under the button, or over it when there's no room below; never off the side of the window.
  useLayoutEffect(() => {
    if (!tip || !bubble.current) { setAt(null); return; }
    const b = bubble.current.getBoundingClientRect();
    const { box } = tip;
    const middle = box.left + box.width / 2;
    const left = Math.max(8, Math.min(middle - b.width / 2, window.innerWidth - b.width - 8));
    const above = box.bottom + 8 + b.height > window.innerHeight - 4 && box.top - 8 - b.height > 4;
    setAt({ left, top: above ? box.top - 8 - b.height : box.bottom + 8, arrow: Math.max(10, Math.min(middle - left, b.width - 10)), above });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={bubble} className={`tip${at?.above ? " above" : ""}`} role="tooltip"
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden", ["--tip-arrow" as string]: `${at?.arrow ?? 20}px` }}>
      {tip.text}
    </div>
  );
}

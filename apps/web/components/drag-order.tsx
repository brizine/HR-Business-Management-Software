"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/**
 * Dragging the rows of a list or table into order, with the mouse or a finger. The order is saved
 * once, when the row is let go; until the save comes back the rows stay where they were dropped.
 *
 *   const drag = useDragOrder(items.map((x) => x.id), (ids) => save(ids));
 *   <tbody ref={drag.box}>
 *     {drag.sorted(items, (x) => x.id).map((x) => (
 *       <tr key={x.id} {...drag.row(x.id)}><td><Grip drag={drag} id={x.id} name={x.name} /></td>…</tr>
 *     ))}
 *   </tbody>
 *
 * The grip also takes the up and down arrow keys. With `groupOf`, a row only moves among the rows of
 * its own group (they must sit together). `disabled` switches the grips off; `busy` (something else
 * on the page is saving) only makes them wait, so the keyboard stays on the row being moved.
 */
export function useDragOrder(keys: string[], onDrop: (next: string[], moved: string) => void | Promise<unknown>, o: { disabled?: boolean; busy?: boolean; groupOf?: (key: string) => string } = {}) {
  const el = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // While a row is held or its save is on the way, the rows show in the order it was dragged to.
  const order = preview && preview.length === keys.length && preview.every((k) => keys.includes(k)) ? preview : keys;
  const live = useRef(order);
  live.current = order;
  const latest = useRef({ onDrop, o });
  latest.current = { onDrop, o };
  const held = useRef(false);
  const saving = useRef(false);
  const queued = useRef<{ next: string[]; key: string } | null>(null);
  const refocus = useRef<string | null>(null);
  // A row moved down with the keyboard is put back into the page by the browser, which drops the
  // keyboard from it. Hand it back, so the arrow keys can be pressed again and again.
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    const row = ([...(el.current?.children ?? [])] as HTMLElement[]).find((r) => r.dataset.key === key);
    const grip = row?.querySelector<HTMLElement>(".drag-grip");
    if (grip && document.activeElement !== grip) grip.focus();
  });
  // Our own save doesn't hold up the next move: it is saved as soon as this one is back.
  const off = () => !!latest.current.o.disabled || (!!latest.current.o.busy && !saving.current);

  const groupOf = (k: string) => latest.current.o.groupOf?.(k) ?? "";
  /** The list with `key` put at `to`, counted among the rows of its own group. */
  const placed = (key: string, to: number) => {
    const rest = live.current.filter((k) => k !== key);
    const mine = rest.map((k, i) => ({ k, i })).filter((x) => groupOf(x.k) === groupOf(key));
    if (!mine.length) return live.current;
    const n = Math.max(0, Math.min(mine.length, to));
    const at = n < mine.length ? mine[n].i : mine[mine.length - 1].i + 1;
    return [...rest.slice(0, at), key, ...rest.slice(at)];
  };
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
  const commit = (next: string[], key: string, before: string[]) => {
    if (same(next, before)) { if (!saving.current) setPreview(null); return; }
    live.current = next;
    setPreview(next);
    if (saving.current) { queued.current = { next, key }; return; }
    saving.current = true;
    const send = (n: string[], k: string): Promise<unknown> => Promise.resolve().then(() => latest.current.onDrop(n, k)).catch(() => {}).then(() => {
      const q = queued.current;
      queued.current = null;
      return q ? send(q.next, q.key) : undefined;
    });
    send(next, key).finally(() => { saving.current = false; if (!held.current) setPreview(null); });
  };

  const start = (key: string) => (e: React.PointerEvent) => {
    if (off() || held.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    held.current = true;
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    // The list holds the pointer for the drag: rows change places under it, the list doesn't.
    try { el.current?.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    const before = live.current;
    setDragging(key);
    setPreview(before);
    document.body.classList.add("drag-sorting");
    let y = e.clientY;
    const place = () => {
      const box = el.current;
      if (!box) return;
      // Its place is however many of the other rows (of its group) sit above the pointer.
      const others = ([...box.children] as HTMLElement[]).filter((r) => r.dataset.key && r.dataset.key !== key && (r.dataset.group ?? "") === groupOf(key));
      const next = placed(key, others.filter((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < y; }).length);
      if (!same(next, live.current)) { live.current = next; setPreview(next); }
    };
    const move = (ev: PointerEvent) => { y = ev.clientY; place(); };
    // The page keeps scrolling while the row is held near the top or bottom of the window.
    const scroller = (() => {
      for (let n = el.current?.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      }
      return document.scrollingElement as HTMLElement | null;
    })();
    const edge = setInterval(() => {
      if (!scroller) return;
      const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      const bottom = scroller === document.scrollingElement ? window.innerHeight : scroller.getBoundingClientRect().bottom;
      const by = y < top + 50 ? -14 : y > bottom - 50 ? 14 : 0;
      if (!by) return;
      const was = scroller.scrollTop;
      scroller.scrollTop += by;
      if (scroller.scrollTop !== was) place();
    }, 40);
    const stop = () => {
      clearInterval(edge);
      document.body.classList.remove("drag-sorting");
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop);
      setDragging(null);
      held.current = false;
      commit(live.current, key, before);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const keyDown = (key: string) => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (off() || held.current) return;
    refocus.current = key;
    const before = live.current;
    const mine = before.filter((k) => groupOf(k) === groupOf(key));
    commit(placed(key, mine.indexOf(key) + (e.key === "ArrowUp" ? -1 : 1)), key, before);
  };

  return {
    /** The keys in the order to draw them. */
    order,
    /** `items` in that order. */
    sorted: <T,>(items: T[], keyOf: (x: T) => string) => { const by = new Map(items.map((x) => [keyOf(x), x])); return order.map((k) => by.get(k)).filter((x): x is T => x !== undefined); },
    /** Goes on the element whose children are the rows (a tbody, an ol…). */
    box: (node: HTMLElement | null) => { el.current = node; },
    /** Spread on each row. */
    row: (key: string, className = "") => ({ "data-key": key, "data-group": latest.current.o.groupOf ? groupOf(key) : undefined, className: `${className} drag-row${dragging === key ? " dragging" : ""}`.trim() }),
    grip: (key: string) => ({ onPointerDown: start(key), onKeyDown: keyDown(key) }),
    disabled: !!o.disabled,
    saving: !!preview && !dragging,
  };
}

/** The handle a row is dragged by (six dots). */
export function Grip({ drag, id, name }: { drag: ReturnType<typeof useDragOrder>; id: string; name: string }) {
  return (
    <button type="button" className="drag-grip" disabled={drag.disabled} title={drag.disabled ? undefined : "Drag to reorder"} aria-label={`${name}: drag to reorder, or press the up and down arrow keys`} {...drag.grip(id)}>
      <Icon name="grip" size={16} />
    </button>
  );
}

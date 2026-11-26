"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dateLabel, endOfMonth, plusDays, startOfMonth, startOfWeek, weekdayOf } from "./data";

/* The small parts the beta dispatch board is built from: icons, menus, windows, a month calendar, toasts. */

const PATHS: Record<string, string> = {
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  down: "M6 9l6 6 6-6", left: "M15 18l-6-6 6-6", right: "M9 18l6-6-6-6", up: "M18 15l-6-6-6 6",
  table: "M3 5h4M3 12h4M3 19h4M11 5h10M11 12h10M11 19h10",
  board: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  split: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 4v16",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  hourglass: "M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4",
  print: "M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z",
  swap: "M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  plus: "M12 5v14M5 12h14", minus: "M5 12h14", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  route: "M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 16h6.5a3.5 3.5 0 0 0 0-7H15",
  dots: "M12 5h.01M12 12h.01M12 19h.01", grip: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  x: "M18 6 6 18M6 6l12 12", check: "M20 6 9 17l-5-5",
  pin: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  note: "M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8zM15 3v6h6",
  doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8",
  columns: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16M15 4v16",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M9.9 5.2A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2",
  lasso: "M7 22a5 5 0 0 1-2-4M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  shapes: "M8.3 10a.7.7 0 0 1-.6-1.1l3.7-6.3a.7.7 0 0 1 1.2 0l3.7 6.3a.7.7 0 0 1-.6 1.1zM3 14h6v6H3zM17.5 20.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  popout: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 5v12a2 2 0 0 0 2 2h4M13 13h8v8h-8z",
  fit: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
  palette: "M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3-4 3h-1.5a2 2 0 0 0-1.5 3.3 1.5 1.5 0 0 1-1 2.7zM7.5 10.5h.01M12 7.5h.01M16.5 10.5h.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  sparkles: "M9.9 3.6 12 9l5.4 2.1L12 13.2 9.9 18.6 7.8 13.2 2.4 11.1 7.8 9zM19 3v4M17 5h4M19 17v4M17 19h4",
  updown: "M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4",
  undo: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5", tag: "M12.6 2.6 21 11a2 2 0 0 1 0 2.8l-7.2 7.2a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6zM7.5 7.5h.01",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6", message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", copy: "M8 8h12v12H8zM4 16V4h12", pencil: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  todo: "M3 5h4M3 12h4M3 19h4M11 5h10M11 12h10M11 19h10", wrench: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
  truck: "M10 17h4V5H2v12h3M20 17h2v-3.3a1 1 0 0 0-.2-.6l-3.5-4.4a1 1 0 0 0-.8-.4H14v9M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  pinTop: "M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  send: "M5 12h14M13 6l6 6-6 6", circleCheck: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9 12l2 2 4-4", lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  cloud: "M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 6 16.5M8 19v2M12 19v2M16 19v2", gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.1 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.8h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
};
export function Ico({ name, size = 16, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

/** Closes something when the pointer goes down outside it, or Escape is pressed. */
export function useDismiss(open: boolean, close: () => void, refs: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!refs.some((r) => r.current?.contains(e.target as Node))) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** A menu that opens under (or beside) whatever was clicked, kept on screen. */
export function Pop({ at, onClose, children, width, className = "", align = "left" }: { at: { x: number; y: number; w?: number; h?: number } | null; onClose: () => void; children: ReactNode; width?: number; className?: string; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismiss(!!at, onClose, [ref]);
  useLayoutEffect(() => {
    if (!at || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    let left = align === "right" ? at.x + (at.w ?? 0) - r.width : at.x;
    let top = at.y + (at.h ?? 0) + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, at.y - r.height - 4);
    setPos({ left, top });
  }, [at, align]);
  if (!at || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} className={`dx dx-pop ${className}`} role="menu" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, visibility: pos ? "visible" : "hidden" }}>{children}</div>,
    document.body,
  );
}
/** Where a clicked button is, for opening a Pop under it. */
export const anchorOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

export function MenuItem({ icon, children, onClick, checked, disabled, danger, hint }: { icon?: string; children: ReactNode; onClick?: () => void; checked?: boolean; disabled?: boolean; danger?: boolean; hint?: string }) {
  return (
    <button type="button" role="menuitem" className={`dx-mi${danger ? " danger" : ""}`} disabled={disabled} onClick={onClick} title={hint}>
      {icon && <Ico name={icon} />}<span>{children}</span>{checked && <Ico name="check" className="dx-mi-check" />}
    </button>
  );
}

/** A window over the page. Escape or the ✕ closes it. */
export function Dialog({ title, onClose, children, footer, width = 448, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="dx dx-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dx-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} style={{ width: wide ? undefined : width }}>
        <div className="dx-dialog-head"><h2>{title}</h2><button type="button" className="dx-icon-btn" aria-label="Close" onClick={onClose}><Ico name="x" /></button></div>
        <div className="dx-dialog-body">{children}</div>
        {footer && <div className="dx-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Check({ checked, mixed, onChange, label, disabled }: { checked: boolean; mixed?: boolean; onChange: (v: boolean, e: React.MouseEvent) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={mixed ? "mixed" : checked} aria-label={label} disabled={disabled} className={`dx-check${checked || mixed ? " on" : ""}`} onClick={(e) => { e.stopPropagation(); onChange(!checked, e); }}>
      {mixed ? <Ico name="minus" size={12} /> : checked ? <Ico name="check" size={12} /> : null}
    </button>
  );
}

/** A month to pick a day from. `marks` colors days (the future-weeks preview). */
export function MiniCal({ value, onPick, today, marks, min }: { value: string | null; onPick?: (d: string) => void; today: string; marks?: Record<string, "this" | "gets">; min?: string }) {
  const [month, setMonth] = useState(startOfMonth(value ?? today));
  useEffect(() => { if (value) setMonth(startOfMonth(value)); }, [value]);
  const first = startOfWeek(month);
  const last = endOfMonth(month);
  const days: string[] = [];
  for (let d = first; d <= last || weekdayOf(d) !== 0; d = plusDays(d, 1)) days.push(d);
  return (
    <div className="dx-cal">
      <div className="dx-cal-head">
        <button type="button" className="dx-icon-btn" aria-label="Previous month" onClick={() => setMonth(startOfMonth(plusDays(month, -1)))}><Ico name="left" /></button>
        <strong>{dateLabel(month, { month: "long", year: "numeric" })}</strong>
        <button type="button" className="dx-icon-btn" aria-label="Next month" onClick={() => setMonth(startOfMonth(plusDays(last, 1)))}><Ico name="right" /></button>
      </div>
      <div className="dx-cal-grid">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => <span key={d} className="dx-cal-dow">{d}</span>)}
        {days.map((d) => (
          <button key={d} type="button" disabled={!onPick || (!!min && d < min)} onClick={() => onPick?.(d)}
            className={`dx-cal-day${d.slice(0, 7) !== month.slice(0, 7) ? " other" : ""}${d === value ? " on" : ""}${d === today ? " today" : ""}${marks?.[d] ? ` mark-${marks[d]}` : ""}`}>{Number(d.slice(8))}</button>
        ))}
      </div>
    </div>
  );
}

/* ───────────── Toasts ───────────── */

export type Toast = { id: number; text: string; bad?: boolean };
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const n = useRef(0);
  const toast = (text: string, bad = false) => {
    const id = ++n.current;
    setToasts((t) => [...t, { id, text, bad }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 4000);
  };
  return { toasts, toast };
}
export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (!toasts.length || typeof document === "undefined") return null;
  return createPortal(<div className="dx dx-toasts" role="status">{toasts.map((t) => <div key={t.id} className={`dx-toast${t.bad ? " bad" : ""}`}>{t.bad ? <Ico name="info" /> : <Ico name="circleCheck" />}{t.text}</div>)}</div>, document.body);
}

/** A two-or-three way switch (Table | Board, Table | Split | Map). */
export function Seg<T extends string>({ value, onChange, options, small, disabled }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon: string }[]; small?: boolean; disabled?: boolean }) {
  return (
    <div className={`dx-seg${small ? " small" : ""}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} disabled={disabled} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          <Ico name={o.icon} /><span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

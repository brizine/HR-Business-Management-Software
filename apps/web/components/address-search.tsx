"use client";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/api";

export interface AddressSuggestion {
  label: string;
  lat: number;
  lng: number;
  kind: "address" | "street" | "place";
  /** Look the label up for the exact spot when picked (OpenStreetMap had the street but not the house number). */
  lookUp: boolean;
}

/**
 * The "Find a property" box: suggests addresses near the map as you type (after 3 characters), with arrow keys,
 * Enter and Escape. Picking one calls `onPick`; Enter with nothing picked calls `onSubmit` with what was typed.
 */
export function AddressSearch({ value, onChange, near, onPick, onSubmit, busy, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  near: () => { lat: number; lng: number };
  onPick: (s: AddressSuggestion) => void;
  onSubmit: (text: string) => void;
  busy?: boolean;
  placeholder?: string;
}) {
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const typed = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const listId = useId();

  useEffect(() => {
    const q = value.trim();
    if (!typed.current || q.length < 3 || /^https?:/i.test(q)) { setItems([]); setLoading(false); return; }
    const timer = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setLoading(true);
      try {
        const c = near();
        const res = await api<AddressSuggestion[]>(`/measurements/suggest?q=${encodeURIComponent(q)}&lat=${c.lat.toFixed(4)}&lng=${c.lng.toFixed(4)}`);
        // Stop if a search or pick happened while this was on its way.
        if (ctrl.signal.aborted || !typed.current) return;
        setItems(res);
        setActive(-1);
        setOpen(true);
      } catch {
        if (!ctrl.signal.aborted) setItems([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: AddressSuggestion) => {
    typed.current = false;
    abort.current?.abort();
    setOpen(false);
    setItems([]);
    onChange(s.label);
    onPick(s);
  };

  const showList = open && value.trim().length >= 3 && (items.length > 0 || !loading);

  return (
    <form
      className="card row"
      style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (open && active >= 0 && items[active]) return pick(items[active]);
        typed.current = false;
        abort.current?.abort();
        setOpen(false);
        setItems([]);
        onSubmit(value.trim());
      }}
    >
      <label style={{ flex: "1 1 320px", position: "relative" }}>Find a property
        <input
          value={value}
          onChange={(e) => { typed.current = true; onChange(e.target.value); }}
          onFocus={() => items.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!showList || !items.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a <= 0 ? items.length - 1 : a - 1)); }
            else if (e.key === "Escape") { setOpen(false); }
          }}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        />
        {showList && (
          <div className="address-suggest" id={listId} role="listbox">
            {items.map((s, i) => (
              <div
                key={s.label}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="address-suggest-icon" aria-hidden>{s.kind === "place" ? "◎" : s.kind === "street" ? "—" : "⌂"}</span>
                <span>{s.label}</span>
              </div>
            ))}
            {!items.length && <div className="muted address-suggest-empty">No suggestions. Press Find to search for exactly what you typed.</div>}
            <div className="address-suggest-credit">Suggestions © OpenStreetMap contributors (Photon)</div>
          </div>
        )}
      </label>
      <button className="btn primary" disabled={busy}>{busy ? "Finding…" : "Find"}</button>
    </form>
  );
}

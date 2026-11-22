"use client";
import { useSyncExternalStore } from "react";

/**
 * The breadcrumb trail: the pages you visited most recently, oldest first, ending with the page you're
 * on. Kept per person and per company in this browser (the test company has its own), and survives a
 * reload. Visiting a page that's already in the trail moves it to the end.
 */

export type TrailEntry = { key: string; href: string; title: string };
/** How many earlier pages show before the current one. */
export const TRAIL_BEFORE = 3;
export const UNNAMED = "…";

let scope = "";
let entries: TrailEntry[] = [];
let pending: { key: string; title: string } | null = null;
const listeners = new Set<() => void>();
const EMPTY: TrailEntry[] = [];

const storageKey = () => `crewdesk.trail.${scope}`;
function save() {
  try { localStorage.setItem(storageKey(), JSON.stringify(entries)); } catch { /* private window: the trail lasts until the tab closes */ }
}
function emit() { for (const l of listeners) l(); }

/** Whose trail this is (person + company); loads what was saved for them. */
export function setTrailScope(s: string) {
  if (s === scope) return;
  scope = s;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) ?? "[]");
    entries = Array.isArray(saved) ? saved.filter((e) => e && typeof e.key === "string" && typeof e.href === "string").slice(-(TRAIL_BEFORE + 1)) : [];
  } catch {
    entries = [];
  }
  emit();
}

/** You opened a page: it goes on the end of the trail (moved there if it was already in it). */
export function visit(key: string, href: string, fallbackTitle: string) {
  const before = entries.find((e) => e.key === key);
  const named = pending?.key === key ? pending.title : null;
  pending = null;
  const title = named ?? (before && before.title !== UNNAMED ? before.title : fallbackTitle);
  entries = [...entries.filter((e) => e.key !== key), { key, href, title }].slice(-(TRAIL_BEFORE + 1));
  save();
  emit();
}

/** The page you're on says what it's called (its title, once its data has loaded). */
export function nameCurrent(key: string, title: string) {
  const t = title.trim();
  if (!t) return;
  const last = entries[entries.length - 1];
  if (!last || last.key !== key) { pending = { key, title: t }; return; }
  if (last.title === t) return;
  entries = [...entries.slice(0, -1), { ...last, title: t }];
  save();
  emit();
}

export const currentTitle = () => entries[entries.length - 1]?.title ?? null;

export function useTrail() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => entries,
    () => EMPTY,
  );
}

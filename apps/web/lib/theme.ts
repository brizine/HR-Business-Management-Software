"use client";
import { useSyncExternalStore } from "react";
import { THEME_KEY } from "./theme-boot";

/**
 * Light, dark or auto (follow the device). The choice is kept in this browser and applied as
 * data-theme on <html>; with no choice (auto) the CSS follows the device's setting. A tiny script in
 * the root layout applies it before the page paints, so a dark page never flashes white.
 */
export type ThemeChoice = "light" | "dark" | "auto";
export const THEME_CHOICES: { key: ThemeChoice; label: string; icon: string; hint: string }[] = [
  { key: "light", label: "Light", icon: "sun", hint: "Light mode" },
  { key: "dark", label: "Dark", icon: "moon", hint: "Dark mode" },
  { key: "auto", label: "Auto", icon: "monitor", hint: "Match this device's setting" },
];

const listeners = new Set<() => void>();
const read = (): ThemeChoice => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
};
let current: ThemeChoice | null = null;

function applyTheme(t: ThemeChoice) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

export function setTheme(t: ThemeChoice) {
  current = t;
  try {
    if (t === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch { /* storage blocked: lasts until the page reloads */ }
  applyTheme(t);
  for (const l of listeners) l();
}

/** Whether the page is showing dark right now (your choice, or the device's setting on Auto). */
export function isDark() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      // Another tab changed it: follow along.
      const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY || e.key === null) { current = read(); applyTheme(current); cb(); } };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
    },
    () => (current ??= read()),
    () => "auto",
  );
}

"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { STORED_LISTS, defaultLabel, defaultList, type LabelMenu, type StoredList } from "@crewdesk/shared";
import { api } from "./api";
import { useAuth } from "./auth";

/** Everything /employees/menus returns: the editable lists, new wording for fixed choices, and usage counts. */
export type Menus = { jobTitles: string[]; departments: string[]; labels: Record<string, Record<string, string>>; usage: Record<string, Record<string, number>> } & Record<StoredList, string[]>;

const empty: Menus = { jobTitles: [], departments: [], labels: {}, usage: {}, ...(Object.fromEntries(STORED_LISTS.map((k) => [k, defaultList(k)])) as Record<StoredList, string[]>) };

interface MenusCtx {
  menus: Menus;
  setMenus: (m: Menus) => void;
  /** How a fixed choice reads (the owner's wording, else "in_progress" → "in progress"). */
  label: (menu: LabelMenu, value: string | null | undefined) => string;
}
const Ctx = createContext<MenusCtx>({ menus: empty, setMenus: () => {}, label: (_m, v) => (v ? defaultLabel(v) : "") });

const CHANNEL = "crewdesk-menus";

/**
 * Loads the company's drop-down menus for every page, and keeps them current: an edit saved in
 * one tab (e.g. the layout editor's) tells this browser's other tabs to reload them, and every tab
 * reloads when you come back to it, so changes made by someone else show up too.
 */
export function MenusProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [menus, setMenusState] = useState<Menus>(empty);
  const load = useCallback(() => {
    if (me) api<Menus>("/employees/menus").then(setMenusState, () => {});
  }, [me?.company.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
    if (!me) return;
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = () => load();
    } catch {}
    return () => { document.removeEventListener("visibilitychange", onVisible); channel?.close(); };
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  /** After an edit: update this tab and tell the others. */
  const setMenus = useCallback((m: Menus) => {
    setMenusState(m);
    try {
      const c = new BroadcastChannel(CHANNEL);
      c.postMessage("changed");
      c.close();
    } catch {}
  }, []);
  const label = useCallback((menu: LabelMenu, value: string | null | undefined) => (value ? menus.labels[menu]?.[value] ?? defaultLabel(value) : ""), [menus]);
  return <Ctx.Provider value={{ menus, setMenus, label }}>{children}</Ctx.Provider>;
}

export const useMenuData = () => useContext(Ctx);

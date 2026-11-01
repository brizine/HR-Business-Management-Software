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

/** Loads the company's drop-down menus once for every page. */
export function MenusProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [menus, setMenus] = useState<Menus>(empty);
  useEffect(() => {
    if (me) api<Menus>("/employees/menus").then(setMenus, () => {});
  }, [me?.company.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = useCallback((menu: LabelMenu, value: string | null | undefined) => (value ? menus.labels[menu]?.[value] ?? defaultLabel(value) : ""), [menus]);
  return <Ctx.Provider value={{ menus, setMenus, label }}>{children}</Ctx.Provider>;
}

export const useMenuData = () => useContext(Ctx);

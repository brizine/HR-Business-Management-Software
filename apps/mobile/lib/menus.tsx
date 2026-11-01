import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { defaultLabel, type LabelMenu } from "@crewdesk/shared";
import { api } from "./api";
import { useAuth } from "./auth";

type Labels = Record<string, Record<string, string>>;

/** How a fixed choice reads: the owner's wording (Edit drop-down menus on the website), else the default. */
const Ctx = createContext<(menu: LabelMenu, value: string | null | undefined) => string>((_m, v) => (v ? defaultLabel(v) : ""));

/** Loads the company's wording once per session (and again on sign-in). */
export function MenusProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [labels, setLabels] = useState<Labels>({});
  useEffect(() => {
    if (me) api<{ labels: Labels }>("/employees/menus").then((m) => setLabels(m.labels ?? {}), () => {});
    else setLabels({});
  }, [me?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = useCallback((menu: LabelMenu, value: string | null | undefined) => (value ? labels[menu]?.[value] ?? defaultLabel(value) : ""), [labels]);
  return <Ctx.Provider value={label}>{children}</Ctx.Provider>;
}

export const useMenuLabel = () => useContext(Ctx);

import * as Notifications from "expo-notifications";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { api } from "./api";
import { useAuth } from "./auth";

const Ctx = createContext<{ allowed: boolean; unread: number; refresh: () => void }>({ allowed: false, unread: 0, refresh: () => {} });

/** How many text conversations have something unread (the chat icon by the bell), for the people who answer texts. */
export function TextsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const allowed = !!me?.access?.texting;
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (!allowed) return setUnread(0);
    api<{ unread: number }>("/texting/unread").then((r) => setUnread(r.unread), () => {});
  }, [allowed]);
  useEffect(() => {
    refresh();
    const received = Platform.OS === "web" ? { remove() {} } : Notifications.addNotificationReceivedListener(refresh);
    const appState = AppState.addEventListener("change", (s) => s === "active" && refresh());
    return () => { received.remove(); appState.remove(); };
  }, [refresh]);
  return <Ctx.Provider value={{ allowed, unread, refresh }}>{children}</Ctx.Provider>;
}

export const useTextsUnread = () => useContext(Ctx);

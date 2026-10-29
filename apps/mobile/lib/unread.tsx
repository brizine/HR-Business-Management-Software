import * as Notifications from "expo-notifications";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api } from "./api";
import { useAuth } from "./auth";

const Ctx = createContext<{ unread: number; refresh: () => void }>({ unread: 0, refresh: () => {} });

/** Keeps the unread count (header bell and app icon badge) in sync. */
export function UnreadProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(() => {
    if (!me) return setUnread(0);
    api<{ unread: number }>("/notifications/unread-count")
      .then(({ unread }) => {
        setUnread(unread);
        Notifications.setBadgeCountAsync(unread).catch(() => {});
      })
      .catch(() => {});
  }, [me]);

  useEffect(() => {
    refresh();
    const received = Notifications.addNotificationReceivedListener(refresh);
    const appState = AppState.addEventListener("change", (s) => s === "active" && refresh());
    return () => {
      received.remove();
      appState.remove();
    };
  }, [refresh]);

  return <Ctx.Provider value={{ unread, refresh }}>{children}</Ctx.Provider>;
}

export const useUnread = () => useContext(Ctx);

import * as Notifications from "expo-notifications";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import type { NotificationLink } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { routeFor } from "@/lib/push";
import { UnreadProvider, useUnread } from "@/lib/unread";

/** Opens the right screen when a notification is tapped, including from a cold start. */
function useNotificationTaps() {
  const { me } = useAuth();
  const { refresh } = useUnread();
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!me || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const data = response.notification.request.content.data as { notificationId?: string; link?: NotificationLink };
    if (data.notificationId) api(`/notifications/${data.notificationId}/read`, { method: "POST" }).then(refresh, () => {});
    const route = routeFor(data.link);
    if (route) router.push(route as never);
  }, [me, response, router, refresh]);
}

function Gate() {
  const { me, ready } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  useNotificationTaps();

  useEffect(() => {
    if (!ready) return;
    const onLogin = segments[0] === "login";
    if (!me && !onLogin) router.replace("/login");
    else if (me && onLogin) router.replace("/");
  }, [me, ready, segments, router]);

  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="wiki/index" options={{ title: "Company wiki" }} />
      <Stack.Screen name="wiki/[id]" options={{ title: "" }} />
      <Stack.Screen name="scan" options={{ title: "Scan equipment" }} />
      <Stack.Screen name="q/[code]" options={{ title: "Equipment" }} />
      <Stack.Screen name="availability" options={{ title: "My availability" }} />
      <Stack.Screen name="notification-settings" options={{ title: "Notification settings" }} />
      <Stack.Screen name="asset/[id]" options={{ title: "Asset" }} />
      <Stack.Screen name="inspect/[id]" options={{ title: "Inspection", presentation: "modal" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <UnreadProvider>
        <StatusBar style="auto" />
        <Gate />
      </UnreadProvider>
    </AuthProvider>
  );
}

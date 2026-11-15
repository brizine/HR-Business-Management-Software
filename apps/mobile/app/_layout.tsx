import * as Notifications from "expo-notifications";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { NotificationLink } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { MenusProvider } from "@/lib/menus";
import { LocationRequired } from "@/lib/location";
import { routeFor } from "@/lib/push";
import { UnreadProvider, useUnread } from "@/lib/unread";

// The browser preview has no notifications (and the hook throws there).
const useLastNotificationResponse = Platform.OS === "web" ? () => null : Notifications.useLastNotificationResponse;

/** Opens the right screen when a notification is tapped, including from a cold start. */
function useNotificationTaps() {
  const { me } = useAuth();
  const { refresh } = useUnread();
  const router = useRouter();
  const response = useLastNotificationResponse();
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
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="documents" options={{ title: "Documents" }} />
      <Stack.Screen name="wiki/index" options={{ title: "Company Wiki" }} />
      <Stack.Screen name="wiki/[id]" options={{ title: "" }} />
      <Stack.Screen name="scan" options={{ title: "Scan Equipment" }} />
      <Stack.Screen name="q/[code]" options={{ title: "Equipment" }} />
      <Stack.Screen name="availability" options={{ title: "My Availability" }} />
      <Stack.Screen name="my-info" options={{ title: "My Info" }} />
      <Stack.Screen name="reviews" options={{ title: "My Reviews" }} />
      <Stack.Screen name="attendance" options={{ title: "My Attendance" }} />
      <Stack.Screen name="training/index" options={{ title: "Training" }} />
      <Stack.Screen name="training/[id]" options={{ title: "Course" }} />
      <Stack.Screen name="training/lesson/[id]" options={{ title: "Lesson" }} />
      <Stack.Screen name="asset/[id]" options={{ title: "Asset" }} />
      <Stack.Screen name="inspect/[id]" options={{ title: "Inspection", presentation: "modal" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <MenusProvider>
        <UnreadProvider>
          <StatusBar style="auto" />
          <Gate />
          <LocationRequired />
        </UnreadProvider>
      </MenusProvider>
    </AuthProvider>
  );
}

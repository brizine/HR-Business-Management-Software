import * as Location from "expo-location";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, StyleSheet, View } from "react-native";
import { LOCATION_PING_MINUTES } from "@crewdesk/shared";
import { Button, Txt, useTheme } from "@/components/ui";
import { api } from "./api";
import { useAuth } from "./auth";

type Access = { services: boolean; granted: boolean; canAsk: boolean } | null;

/** Whether location services are on and the app is allowed to use them (re-checked when the app comes back). */
function useLocationAccess() {
  const [access, setAccess] = useState<Access>(null);
  const check = useCallback(async () => {
    try {
      const [services, perm] = await Promise.all([Location.hasServicesEnabledAsync(), Location.getForegroundPermissionsAsync()]);
      setAccess({ services, granted: perm.granted, canAsk: perm.canAskAgain });
    } catch {
      setAccess({ services: false, granted: false, canAsk: true });
    }
  }, []);
  useEffect(() => {
    check();
    const sub = AppState.addEventListener("change", (s) => s === "active" && check());
    return () => sub.remove();
  }, [check]);
  return { access, check };
}

/**
 * While clocked in and the app is open: records where the phone is every LOCATION_PING_MINUTES.
 * Points that can't be sent (no signal) are kept and sent with the next one. Nothing is recorded
 * off the clock, and nothing while the app is closed.
 */
function useTracking(enabled: boolean) {
  const queue = useRef<{ lat: number; lng: number; accuracy?: number; at: string }[]>([]);
  const busy = useRef(false);
  const tick = useCallback(async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    try {
      const status = await api<{ openEntry: unknown | null }>("/time/status");
      if (!status.openEntry) { queue.current = []; return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      queue.current.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? undefined, at: new Date(pos.timestamp || Date.now()).toISOString() });
      queue.current = queue.current.slice(-100);
      await api("/time/locations", { body: { points: queue.current } });
      queue.current = [];
    } catch {
      // Offline or location hiccup: try again next time (queued points are kept).
    } finally {
      busy.current = false;
    }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    tick();
    const timer = setInterval(tick, LOCATION_PING_MINUTES * 60_000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && tick());
    return () => { clearInterval(timer); sub.remove(); };
  }, [enabled, tick]);
}

/**
 * Location is required to use the app: while signed in and location is off or not allowed, this
 * covers the app with a screen explaining why and how to turn it on. (Skipped in the browser
 * preview.) Also runs the clocked-in location tracking.
 */
export function LocationRequired() {
  const { me } = useAuth();
  const t = useTheme();
  const { access, check } = useLocationAccess();
  const web = Platform.OS === "web";
  const ok = !!access?.services && !!access?.granted;
  useTracking(!!me && ok && !web);
  if (!me || web || !access || ok) return null;

  const allow = async () => {
    if (access.services && access.canAsk) await Location.requestForegroundPermissionsAsync().catch(() => {});
    else await Linking.openSettings();
    check();
  };
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg, padding: 28, justifyContent: "center", gap: 16, zIndex: 1000 }]}>
      <Txt style={{ fontSize: 48, textAlign: "center" }}>📍</Txt>
      <Txt style={{ fontSize: 22, fontWeight: "700", textAlign: "center" }}>Location is required</Txt>
      <Txt style={{ textAlign: "center" }}>
        {access.services
          ? "Crewdesk needs your location to work. It's recorded when you clock in and out, and every few minutes while you're clocked in with the app open. It is never recorded when you're off the clock."
          : "Location Services are turned off on this phone. Turn them on in Settings (Privacy & Security → Location Services) to use Crewdesk."}
      </Txt>
      <Button title={access.services && access.canAsk ? "Allow location" : "Open Settings"} onPress={allow} />
      {access.services && !access.canAsk && <Txt muted style={{ textAlign: "center" }}>In Settings, tap Location and choose "While Using the App".</Txt>}
      <Button title="I turned it on" kind="secondary" onPress={check} />
    </View>
  );
}

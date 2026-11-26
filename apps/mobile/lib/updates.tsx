import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { Alert, AppState, Platform, Pressable, Text, View } from "react-native";
import { Txt, useTheme } from "@/components/ui";

// Over-the-air updates: screen changes reach phones without a new build from the App Store or
// Google Play. The app looks for an update each time it's opened from closed and switches to it the
// next time it's opened. Phones keep apps open for days, so this file also looks whenever the app
// comes back to the front, and once an update is downloaded it offers to switch right away.
//
// Only a build from the stores (or an EAS build) has updates switched on: not the browser preview,
// Expo Go or a development build.
const on = Platform.OS !== "web" && Updates.isEnabled;

/** Coming back to the front looks again only this long after the last look. */
const GAP_MS = 15 * 60_000;
// Opening the app is itself a look, so the first one from here waits.
let lastLook = Date.now();

/** Looks for a newer version and downloads it. True when one is downloaded and waiting. */
export async function fetchAppUpdate(): Promise<boolean> {
  if (!on) return false;
  lastLook = Date.now();
  const found = await Updates.checkForUpdateAsync();
  // "Roll back" is an update too: the office took a bad one back, and the app returns to its built-in screens.
  if (!found.isAvailable && !found.isRollBackToEmbedded) return false;
  const got = await Updates.fetchUpdateAsync();
  return got.isNew || got.isRollBackToEmbedded;
}

/** Call once at the top of the app: keeps looking for updates while the app stays open. */
export function useAppUpdates() {
  useEffect(() => {
    if (!on) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && Date.now() - lastLook > GAP_MS) fetchAppUpdate().catch(() => {});
    });
    return () => sub.remove();
  }, []);
}

/** Restarting drops anything typed but not saved, so it's always the person's choice. */
function askToRestart(title = "Update the app now?") {
  Alert.alert(title, "The app restarts, which takes a few seconds. Save anything you're in the middle of first.", [
    { text: "Later", style: "cancel" },
    { text: "Update now", onPress: () => { Updates.reloadAsync().catch(() => {}); } },
  ]);
}

/** In the top bar of every tab once an update is downloaded: tap to switch to it. */
export function UpdateButton() {
  const t = useTheme();
  const { isUpdatePending } = Updates.useUpdates();
  if (!on || !isUpdatePending) return null;
  return (
    <Pressable onPress={() => askToRestart()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Update the app" style={{ marginRight: 18, backgroundColor: t.primary, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5 }}>
      <Text allowFontScaling={false} style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>Update</Text>
    </Pressable>
  );
}

/** On the Me tab: which version is running, and a way to look for a newer one right now. */
export function AppVersion() {
  const t = useTheme();
  const { currentlyRunning, isUpdatePending } = Updates.useUpdates();
  const [busy, setBusy] = useState(false);
  const made = on ? currentlyRunning.createdAt : undefined;

  async function look() {
    if (isUpdatePending) return askToRestart();
    setBusy(true);
    try {
      if (await fetchAppUpdate()) askToRestart("An update is ready");
      else Alert.alert("You're up to date", "This is the newest version of the app.");
    } catch {
      Alert.alert("Couldn't check for updates", "Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ alignItems: "center", gap: 4 }}>
      <Txt muted style={{ fontSize: 12, textAlign: "center" }}>
        Version {Constants.expoConfig?.version ?? "—"}
        {made ? `, updated ${made.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}
      </Txt>
      {on && (
        <Txt style={{ fontSize: 12, color: t.primary }} onPress={busy ? undefined : look} accessibilityRole="button">
          {busy ? "Checking…" : isUpdatePending ? "Update now" : "Check for updates"}
        </Txt>
      )}
    </View>
  );
}

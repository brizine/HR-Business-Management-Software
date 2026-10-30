import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, View } from "react-native";
import { API_URL, api, authHeaders } from "@/lib/api";
import { Txt, useTheme } from "./ui";

/** An employee's photo, or their initials in a circle when there isn't one. */
export function Avatar({ e, size = 40 }: { e: any; size?: number }) {
  const t = useTheme();
  const [broken, setBroken] = useState(false);
  const circle = { width: size, height: size, borderRadius: size / 2 };
  if (e?.hasPhoto && !broken) {
    const v = e.photoUpdatedAt ? `?v=${encodeURIComponent(e.photoUpdatedAt)}` : "";
    return <Image source={{ uri: `${API_URL}/employees/${e.id}/photo${v}`, headers: authHeaders() }} style={circle} onError={() => setBroken(true)} accessibilityLabel={`${e.firstName} ${e.lastName}`} />;
  }
  return (
    <View style={[circle, { backgroundColor: t.border, alignItems: "center", justifyContent: "center" }]}>
      <Txt style={{ fontSize: size * 0.38, fontWeight: "700", color: t.primary }}>{`${e?.firstName?.[0] ?? ""}${e?.lastName?.[0] ?? ""}`.toUpperCase()}</Txt>
    </View>
  );
}

/** Your own photo: tap to take or choose a new one, or remove it. */
export function MyPhoto({ e, onChange }: { e: any; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (source: "camera" | "photos") => {
    if (source === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      Alert.alert("Camera access needed", "Allow camera access in Settings, or choose a photo instead.");
      return;
    }
    // Square crop, compressed to JPEG by the picker so uploads stay small.
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.6 };
    const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", { uri: res.assets[0].uri, name: "photo.jpg", type: "image/jpeg" } as unknown as Blob);
      await api(`/employees/${e.id}/photo`, { method: "PUT", body: fd });
      onChange();
    } catch (err) {
      Alert.alert("Couldn't save photo", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const menu = () =>
    Alert.alert("Profile photo", undefined, [
      { text: "Take photo", onPress: () => pick("camera") },
      { text: "Choose photo", onPress: () => pick("photos") },
      ...(e.hasPhoto ? [{ text: "Remove photo", style: "destructive" as const, onPress: () => api(`/employees/${e.id}/photo`, { method: "DELETE" }).then(onChange, (err) => Alert.alert("Error", err.message)) }] : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  return (
    <Pressable onPress={menu} disabled={busy} accessibilityRole="button" accessibilityLabel={e.hasPhoto ? "Change your photo" : "Add your photo"} style={{ alignItems: "center", gap: 4 }}>
      {busy ? <View style={{ width: 64, height: 64, justifyContent: "center" }}><ActivityIndicator /></View> : <Avatar e={e} size={64} />}
      <Txt muted style={{ fontSize: 12 }}>{e.hasPhoto ? "Change" : "Add photo"}</Txt>
    </Pressable>
  );
}

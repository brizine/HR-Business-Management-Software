import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { API_URL, WEB_URL, api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Divider, Row, Txt } from "./ui";

type Upload = { uri: string; name: string; type: string };

/** Lets the person photograph a document, or pick a photo or PDF. */
async function pickFile(source: "camera" | "photos" | "files"): Promise<Upload | null> {
  if (source === "files") {
    const res = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*"], copyToCacheDirectory: true });
    if (res.canceled) return null;
    const f = res.assets[0];
    return { uri: f.uri, name: f.name, type: f.mimeType ?? "application/octet-stream" };
  }
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera access needed", "Allow camera access in Settings, or choose a photo instead.");
      return null;
    }
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.7 };
  const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled) return null;
  const a = res.assets[0];
  return { uri: a.uri, name: a.fileName ?? `photo-${Date.now()}.jpg`, type: a.mimeType ?? "image/jpeg" };
}

/** One onboarding task: check off, upload (camera/photos/files), or read & sign. */
export function OnboardingTaskItem({ task, mode, onChange }: { task: any; mode: "self" | "manager"; onChange: () => void }) {
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const overdue = task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10);

  const attempt = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) Alert.alert(done);
      onChange();
    } catch (e) {
      Alert.alert("Couldn't do that", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = (source: "camera" | "photos" | "files") =>
    attempt(async () => {
      const file = await pickFile(source);
      if (!file) return;
      const fd = new FormData();
      // React Native's FormData takes { uri, name, type } for files.
      fd.append("file", file as unknown as Blob);
      await api(`/onboarding/tasks/${task.id}/upload`, { body: fd });
    });

  const read = () => attempt(async () => {
    const { path } = await api(`/documents/${task.document.id}/link`, { method: "POST" });
    await Linking.openURL(API_URL + path);
  });

  const sign = () => {
    const name = `${me!.user.firstName} ${me!.user.lastName}`;
    Alert.alert("Sign document", `Sign "${task.document.name}" as ${name}? Make sure you've read it first.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign", onPress: () => attempt(() => api(`/documents/${task.document.id}/sign`, { body: { signedName: name } }), "Signed. Thank you!") },
    ]);
  };

  const complete = () => attempt(() => api(`/onboarding/tasks/${task.id}/complete`, { method: "POST" }));

  let actions;
  if (mode === "manager") {
    actions = <Button title={task.action === "none" ? "Mark done" : "Mark done (paper copy)"} kind="secondary" busy={busy} onPress={complete} />;
  } else if (task.assignee !== "employee") {
    actions = <Txt muted>Waiting on your {task.assignee}</Txt>;
  } else if (task.action === "upload") {
    actions = (
      <Row>
        <View style={{ flex: 1 }}><Button title="📷 Take photo" busy={busy} onPress={() => upload("camera")} /></View>
        <View style={{ flex: 1 }}><Button title="Choose file" kind="secondary" disabled={busy} onPress={() =>
          Alert.alert("Upload", "Choose a photo or a PDF", [
            { text: "Photo library", onPress: () => upload("photos") },
            { text: "Files (PDF)", onPress: () => upload("files") },
            { text: "Cancel", style: "cancel" },
          ])} /></View>
      </Row>
    );
  } else if (task.action === "form") {
    // Tax forms are filled out on the website (sign in there with the same email and password).
    const path = { w4: "/tax-forms/w4", i9: "/tax-forms/i9", direct_deposit: "/tax-forms/direct-deposit" }[task.formType as string] ?? "/tax-forms";
    actions = <Button title="Fill out (opens website)" onPress={() => Linking.openURL(WEB_URL + path)} />;
  } else if (task.action === "sign" && task.document) {
    actions = (
      <Row>
        <View style={{ flex: 1 }}><Button title="Read" kind="secondary" disabled={busy} onPress={read} /></View>
        <View style={{ flex: 1 }}><Button title="Sign" busy={busy} onPress={sign} /></View>
      </Row>
    );
  } else {
    actions = <Button title="Mark done" kind="secondary" busy={busy} onPress={complete} />;
  }

  return (
    <View style={{ gap: 6 }}>
      <Divider />
      <Row>
        <Txt style={{ fontWeight: "600", flex: 1 }}>{task.title}</Txt>
        {overdue && <Badge value="overdue" />}
      </Row>
      <Txt muted>{task.subtitle ?? `Due ${fmtDate(task.dueDate)}`}</Txt>
      {actions}
    </View>
  );
}

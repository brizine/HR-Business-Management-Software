import { useState } from "react";
import { Alert, Linking, Platform, Pressable, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { formatTodoTime } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { CustomLines, useCustomFieldDefs } from "./custom-values";
import { Badge, Button, Card, Divider, Input, Row, Txt, useTheme } from "./ui";

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function openMap(address: string, lat?: number | null, lng?: number | null) {
  const q = lat != null && lng != null ? `${lat},${lng}` : encodeURIComponent(address);
  Linking.openURL(Platform.OS === "ios" ? `http://maps.apple.com/?q=${q}` : `geo:0,0?q=${q}`).catch(() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`));
}

/**
 * Tasks tab: the crew's work orders for the next week (and any waiting on them), with the address
 * (tap for directions), gate code, pets, services and notes, and Arrived / Completed / Skip.
 */
export function MyWorkOrdersCard({ refreshKey }: { refreshKey?: number }) {
  const t = useTheme();
  const fieldDefs = useCustomFieldDefs();
  const list = useApi<{ today: string; items: any[] }>(`/visits?mine=true&status=active&to=${plusDays(new Date().toISOString().slice(0, 10), 8)}&r=${refreshKey ?? 0}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [writing, setWriting] = useState<{ id: string; kind: "complete" | "skip"; text: string } | null>(null);
  const today = list.data?.today ?? "";
  const items = (list.data?.items ?? []).filter((v) => !v.date || !today || v.date <= plusDays(today, 7));

  /** Take or choose a photo and add it to the work order (compressed to JPEG by the picker). */
  const addPhoto = (id: string) => {
    const pick = async (source: "camera" | "photos") => {
      if (source === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
        Alert.alert("Camera access needed", "Allow camera access in Settings, or choose a photo instead.");
        return;
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6, allowsMultipleSelection: source === "photos", selectionLimit: 10 };
      const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (res.canceled) return;
      setBusy(id);
      try {
        for (const [i, a] of res.assets.entries()) {
          const fd = new FormData();
          fd.append("file", { uri: a.uri, name: `photo-${Date.now()}-${i + 1}.jpg`, type: "image/jpeg" } as unknown as Blob);
          await api(`/visits/${id}/files`, { method: "POST", body: fd });
        }
        await list.reload();
      } catch (e) { Alert.alert("Couldn't add the photo", (e as Error).message); }
      setBusy(null);
    };
    Alert.alert("Add a photo", undefined, [
      { text: "Take photo", onPress: () => pick("camera") },
      { text: "Choose photos", onPress: () => pick("photos") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const post = async (id: string, path: string, body: object = {}) => {
    setBusy(id);
    try { await api(`/visits/${id}/${path}`, { method: "POST", body }); setWriting(null); await list.reload(); }
    catch (e) { Alert.alert("Couldn't save that", (e as Error).message); }
    setBusy(null);
  };

  if (!items.length) return list.data ? <Card title="My work orders"><Txt muted>No work orders this week.</Txt></Card> : null;
  return (
    <Card title="My work orders">
      {items.map((v) => {
        const late = v.status === "open" && v.date && today && (v.endDate ?? v.date) < today;
        const p = v.property;
        const w = writing && writing.id === v.id ? writing : null;
        return (
          <View key={v.id} style={{ gap: 6 }}>
            <Divider />
            <View style={{ borderLeftWidth: 4, borderLeftColor: v.color, paddingLeft: 10, gap: 3 }}>
              <Row>
                <Txt style={{ fontWeight: "600", flex: 1 }}>WO-{v.number} {v.title}{v.seriesId ? "  ↻" : ""}</Txt>
                <Badge value={late ? "overdue" : v.status === "on_site" ? "in_progress" : v.date === today ? "today" : "open"} />
              </Row>
              <Txt muted>{[v.date ? day(v.date) : "Waitlist", formatTodoTime(v.startTime, v.endTime)].filter(Boolean).join(" · ")}</Txt>
              <Txt>{v.customer.name}{v.customer.phone ? ` · ${v.customer.phone}` : ""}</Txt>
              {v.crew ? <Txt muted>Crew: {v.crew.name}</Txt> : null}
              {v.tags?.length ? <Txt muted>Tags: {v.tags.map((t: any) => t.name).join(", ")}</Txt> : null}
              {p ? (
                <Pressable onPress={() => openMap(p.address, p.lat, p.lng)} accessibilityRole="link" accessibilityLabel={`Directions to ${p.address}`}>
                  <Txt style={{ color: t.primary }}>{p.address}</Txt>
                </Pressable>
              ) : null}
              {p?.gateCode ? <Txt muted>Gate code {p.gateCode}</Txt> : null}
              <CustomLines defs={fieldDefs.data} target="property" values={p?.custom} />
              <CustomLines defs={fieldDefs.data} target="workorder" values={v.custom} />
              {p?.pets ? <Txt muted>Pets: {p.pets}</Txt> : null}
              {p?.accessNotes ? <Txt muted>{p.accessNotes}</Txt> : null}
              {v.lines.length ? <Txt muted>{v.lines.map((l: any) => `${l.description}${l.quantity !== 1 ? ` × ${l.quantity}` : ""}`).join(" · ")}</Txt> : null}
              {v.notes ? <Txt muted numberOfLines={4}>{v.notes}</Txt> : null}
              {v.budgetedHours ? <Txt muted>{v.budgetedHours} h budgeted</Txt> : null}
              {v.fileCount ? <Txt muted>📎 {v.fileCount} photo{v.fileCount === 1 ? "" : "s"} or document{v.fileCount === 1 ? "" : "s"}</Txt> : null}
            </View>
            <Button title={busy === v.id ? "Adding…" : "Add photo"} kind="secondary" busy={busy === v.id} onPress={() => addPhoto(v.id)} />
            {w ? (
              <View style={{ gap: 6 }}>
                <Input label={w.kind === "complete" ? "Notes about the work (optional)" : "Why was it skipped?"} value={w.text} multiline
                  onChangeText={(text) => setWriting({ ...w, text })} placeholder={w.kind === "complete" ? "Applied round 3; gate was open" : "Rain, locked gate…"} />
                <Row>
                  <View style={{ flex: 1 }}><Button title={w.kind === "complete" ? "Mark completed" : "Skip it"} busy={busy === v.id}
                    disabled={w.kind === "skip" && !w.text.trim()}
                    onPress={() => post(v.id, w.kind, w.kind === "complete" ? { notes: w.text } : { reason: w.text })} /></View>
                  <View style={{ flex: 1 }}><Button title="Cancel" kind="secondary" onPress={() => setWriting(null)} /></View>
                </Row>
              </View>
            ) : (
              <Row>
                {v.status === "open" && <View style={{ flex: 1 }}><Button title="Arrived" kind="secondary" busy={busy === v.id} onPress={() => post(v.id, "start")} /></View>}
                <View style={{ flex: 1 }}><Button title="Completed" onPress={() => setWriting({ id: v.id, kind: "complete", text: "" })} /></View>
                <View style={{ flex: 1 }}><Button title="Skip" kind="secondary" onPress={() => setWriting({ id: v.id, kind: "skip", text: "" })} /></View>
              </Row>
            )}
          </View>
        );
      })}
    </Card>
  );
}

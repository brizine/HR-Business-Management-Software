import { useState } from "react";
import { Alert, Linking, Platform, Pressable, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { formatMinutes, formatTodoTime, todoState } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { CustomLines, useCustomFieldDefs } from "./custom-values";
import { Badge, Button, Card, Divider, Input, Row, Txt, useTheme } from "./ui";

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Opens an address in the phone's maps app. */
function openMap(address: string) {
  const q = encodeURIComponent(address);
  Linking.openURL(Platform.OS === "ios" ? `http://maps.apple.com/?q=${q}` : `geo:0,0?q=${q}`).catch(() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`));
}

/**
 * Tasks tab: your to-dos through the next week, oldest first: the category and repeat, the address
 * (tap for directions), gate code and notes; Start work / Stop work (time tracking, like Homeworks'
 * job sheet), Done, Add photo, and a note for the dispatcher. Quick add makes one for yourself today
 * or tomorrow.
 */
export function MyTodosCard({ refreshKey }: { refreshKey?: number }) {
  const t = useTheme();
  const fieldDefs = useCustomFieldDefs();
  const list = useApi<{ today: string; items: any[] }>(`/todos?mine=true&to=${plusDays(new Date().toISOString().slice(0, 10), 8)}&r=${refreshKey ?? 0}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const today = list.data?.today ?? "";
  const items = (list.data?.items ?? []).filter((x) => !today || x.date <= plusDays(today, 7));

  const post = async (id: string, path: string, body: object = {}) => {
    setBusy(id);
    try { await api(`/todos/${id}/${path}`, { method: "POST", body }); await list.reload(); } catch (e) { Alert.alert("Couldn't save that", (e as Error).message); }
    setBusy(null);
  };
  const add = async (when: number) => {
    if (!title.trim() || !today) return;
    setBusy("add");
    try { await api("/todos", { body: { title: title.trim(), date: plusDays(today, when) } }); setTitle(""); await list.reload(); } catch (e) { Alert.alert("Couldn't add it", (e as Error).message); }
    setBusy(null);
  };
  const sendNote = async () => {
    const w = note;
    if (!w || !w.text.trim()) return;
    setBusy(w.id);
    try { await api(`/todos/${w.id}/notes`, { body: { body: w.text.trim() } }); setNote(null); await list.reload(); } catch (e) { Alert.alert("Couldn't add the note", (e as Error).message); }
    setBusy(null);
  };

  /** Take or choose a photo and add it to the to-do (compressed to JPEG by the picker). */
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
          await api(`/todos/${id}/files`, { method: "POST", body: fd });
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

  return (
    <Card title="My to-dos">
      {items.length ? items.map((x) => {
        const state = todoState(x, today);
        const place = x.property?.address ?? x.location;
        const when = [x.endDate && x.endDate !== x.date ? `${day(x.date)} – ${day(x.endDate)}` : day(x.date), formatTodoTime(x.startTime, x.endTime)].filter(Boolean).join(" · ");
        const working = !!x.startedAt;
        return (
          <View key={x.id} style={{ gap: 6 }}>
            <Divider />
            <View style={{ borderLeftWidth: 4, borderLeftColor: x.color, paddingLeft: 10, gap: 3 }}>
              <Row>
                <Txt style={{ fontWeight: "600", flex: 1 }}>{x.title}{x.seriesId ? "  ↻" : ""}</Txt>
                {working ? <Badge value="working" /> : state === "overdue" ? <Badge value="overdue" /> : state === "today" ? <Badge value="today" /> : null}
              </Row>
              <Txt muted>{when}</Txt>
              {x.category || x.repeatLabel ? <Txt muted>{[x.category?.name, x.repeatLabel].filter(Boolean).join(" · ")}</Txt> : null}
              {x.customer ? <Txt muted>{x.customer.name}</Txt> : null}
              {place ? (
                <Pressable onPress={() => openMap(place)} accessibilityRole="link" accessibilityLabel={`Directions to ${place}`}>
                  <Txt style={{ color: t.primary }}>{place}</Txt>
                </Pressable>
              ) : null}
              {x.property?.gateCode ? <Txt muted>Gate code {x.property.gateCode}</Txt> : null}
              <CustomLines defs={fieldDefs.data} target="property" values={x.property?.custom} />
              <CustomLines defs={fieldDefs.data} target="todo" values={x.custom} />
              {x.property?.accessNotes ? <Txt muted numberOfLines={3}>{x.property.accessNotes}</Txt> : null}
              {x.notes ? <Txt muted numberOfLines={3}>{x.notes}</Txt> : null}
              {x.crew ? <Txt muted>Crew: {x.crew.name}</Txt> : null}
              {x.budgetedHours || x.trackedMinutes ? (
                <Txt muted>{[x.budgetedHours ? `${x.budgetedHours} h budgeted` : null, x.trackedMinutes ? `${formatMinutes(x.trackedMinutes)} tracked${working ? " so far" : ""}` : null].filter(Boolean).join(" · ")}</Txt>
              ) : null}
              {x.fileCount || x.noteCount ? <Txt muted>{[x.fileCount ? `📎 ${x.fileCount}` : null, x.noteCount ? `💬 ${x.noteCount} note${x.noteCount === 1 ? "" : "s"}` : null].filter(Boolean).join("   ")}</Txt> : null}
            </View>
            <Row>
              <View style={{ flex: 1 }}>
                {working
                  ? <Button title="Stop work" kind="secondary" busy={busy === x.id} onPress={() => post(x.id, "stop")} />
                  : <Button title={x.trackedMinutes ? "Start again" : "Start work"} kind="secondary" busy={busy === x.id} onPress={() => post(x.id, "start")} />}
              </View>
              <View style={{ flex: 1 }}><Button title={busy === x.id ? "Saving…" : "Done"} busy={busy === x.id} onPress={() => post(x.id, "done", { done: true })} /></View>
            </Row>
            <Row>
              <View style={{ flex: 1 }}><Button title="Add photo" kind="secondary" disabled={busy === x.id} onPress={() => addPhoto(x.id)} /></View>
              <View style={{ flex: 1 }}><Button title="Note for office" kind="secondary" disabled={busy === x.id} onPress={() => setNote(note?.id === x.id ? null : { id: x.id, text: "" })} /></View>
            </Row>
            {note && note.id === x.id ? (
              <View style={{ gap: 6 }}>
                <Input label="Note for the dispatcher" value={note.text} onChangeText={(text) => setNote({ id: x.id, text })} placeholder="A cracked lid, a locked gate, parts to order…" multiline />
                <Button title={busy === x.id ? "Sending…" : "Send note"} disabled={!note.text.trim() || busy === x.id} onPress={sendNote} />
              </View>
            ) : null}
          </View>
        );
      }) : list.data ? <Txt muted>Nothing to do this week.</Txt> : null}
      <Divider />
      <Input label="Quick add a to-do for yourself" value={title} onChangeText={setTitle} placeholder="Order more flags" returnKeyType="done" />
      <Row>
        <View style={{ flex: 1 }}><Button title="For today" kind="secondary" disabled={!title.trim() || busy === "add"} onPress={() => add(0)} /></View>
        <View style={{ flex: 1 }}><Button title="For tomorrow" kind="secondary" disabled={!title.trim() || busy === "add"} onPress={() => add(1)} /></View>
      </Row>
    </Card>
  );
}

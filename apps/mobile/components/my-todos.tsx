import { useState } from "react";
import { Alert, Linking, Platform, Pressable, View } from "react-native";
import { formatTodoTime, todoState } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, Input, Row, Txt, useTheme } from "./ui";

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Opens an address in the phone's maps app. */
function openMap(address: string) {
  const q = encodeURIComponent(address);
  Linking.openURL(Platform.OS === "ios" ? `http://maps.apple.com/?q=${q}` : `geo:0,0?q=${q}`).catch(() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`));
}

/**
 * Tasks tab: your to-dos through the next week, oldest first, with Done; tap an address for
 * directions. Quick add makes one for yourself today or tomorrow.
 */
export function MyTodosCard({ refreshKey }: { refreshKey?: number }) {
  const t = useTheme();
  const list = useApi<{ today: string; items: any[] }>(`/todos?mine=true&to=${plusDays(new Date().toISOString().slice(0, 10), 8)}&r=${refreshKey ?? 0}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const today = list.data?.today ?? "";
  const items = (list.data?.items ?? []).filter((x) => !today || x.date <= plusDays(today, 7));

  const done = async (id: string) => {
    setBusy(id);
    try { await api(`/todos/${id}/done`, { method: "POST", body: { done: true } }); await list.reload(); } catch (e) { Alert.alert("Couldn't check it off", (e as Error).message); }
    setBusy(null);
  };
  const add = async (when: number) => {
    if (!title.trim() || !today) return;
    setBusy("add");
    try { await api("/todos", { body: { title: title.trim(), date: plusDays(today, when) } }); setTitle(""); await list.reload(); } catch (e) { Alert.alert("Couldn't add it", (e as Error).message); }
    setBusy(null);
  };

  return (
    <Card title="My to-dos">
      {items.length ? items.map((x) => {
        const state = todoState(x, today);
        const place = x.property?.address ?? x.location;
        const when = [x.endDate && x.endDate !== x.date ? `${day(x.date)} – ${day(x.endDate)}` : day(x.date), formatTodoTime(x.startTime, x.endTime)].filter(Boolean).join(" · ");
        return (
          <View key={x.id} style={{ gap: 6 }}>
            <Divider />
            <View style={{ borderLeftWidth: 4, borderLeftColor: x.color, paddingLeft: 10, gap: 3 }}>
              <Row>
                <Txt style={{ fontWeight: "600", flex: 1 }}>{x.title}{x.seriesId ? "  ↻" : ""}</Txt>
                {state === "overdue" ? <Badge value="overdue" /> : state === "today" ? <Badge value="today" /> : null}
              </Row>
              <Txt muted>{when}</Txt>
              {x.customer ? <Txt muted>{x.customer.name}</Txt> : null}
              {place ? (
                <Pressable onPress={() => openMap(place)} accessibilityRole="link" accessibilityLabel={`Directions to ${place}`}>
                  <Txt style={{ color: t.primary }}>{place}</Txt>
                </Pressable>
              ) : null}
              {x.property?.gateCode ? <Txt muted>Gate code {x.property.gateCode}</Txt> : null}
              {x.notes ? <Txt muted numberOfLines={3}>{x.notes}</Txt> : null}
              {x.budgetedHours ? <Txt muted>{x.budgetedHours} h budgeted</Txt> : null}
            </View>
            <Button title={busy === x.id ? "Saving…" : "Done"} busy={busy === x.id} onPress={() => done(x.id)} />
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

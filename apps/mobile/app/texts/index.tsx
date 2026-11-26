import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { formatPhone, textInitials } from "@crewdesk/shared";
import { useApi } from "@/lib/hooks";
import { ErrorText, Row, Screen, Txt, useTheme } from "@/components/ui";

/**
 * Text messages (Marketing → Text on the web): every conversation on the company's number,
 * newest first. For Customers & billing managers and the people picked to answer texts.
 */

type Thread = { id: string; phone: string; kind: "customer" | "employee" | "unknown"; name: string | null; status: "open" | "done"; unread: number; last: { body: string; direction: "in" | "out"; at: string } };
type List = { total: number; unread: number; threads: Thread[] };

const shortWhen = (iso: string) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); };

export default function Texts() {
  const t = useTheme();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const list = useApi<List>(`/texting/threads?filter=${filter}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
  // A text arriving while the list is open shows up at once.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationReceivedListener(() => { void list.reload(); });
    return () => sub.remove();
  }, [list.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = list.data;
  return (
    <Screen refreshing={list.loading} onRefresh={list.reload}>
      <Row style={{ gap: 6, justifyContent: "flex-start" }}>
        {(["all", "unread"] as const).map((k) => (
          <Pressable key={k} onPress={() => setFilter(k)} accessibilityRole="tab" accessibilityState={{ selected: filter === k }}
            style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: filter === k ? t.primary : t.border, backgroundColor: filter === k ? t.primary : t.surface }}>
            <Txt style={{ color: filter === k ? "#fff" : t.text, fontWeight: "600" }}>{k === "all" ? "All" : `Unread${d?.unread ? ` (${d.unread})` : ""}`}</Txt>
          </Pressable>
        ))}
      </Row>
      <TextInput value={q} onChangeText={(v) => { setQ(v); if (!v) setSearch(""); }} onSubmitEditing={() => setSearch(q.trim())} returnKeyType="search" placeholder="Search for messages or people" placeholderTextColor={t.muted}
        accessibilityLabel="Search for messages or people" autoCapitalize="none"
        style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, backgroundColor: t.surface, color: t.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 }} />
      <ErrorText error={list.error} />
      {(d?.threads ?? []).map((th) => (
        <Pressable key={th.id} onPress={() => router.push(`/texts/${th.id}` as never)} accessibilityRole="button" accessibilityLabel={`${th.name ?? formatPhone(th.phone)}${th.unread ? `, ${th.unread} unread` : ""}`}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: th.unread ? t.primary : t.border, borderRadius: 12, padding: 12, opacity: pressed ? 0.7 : 1 })}>
          <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
            <Txt style={{ fontWeight: "700" }}>{textInitials(th.name)}</Txt>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Row>
              <Txt style={{ fontWeight: th.unread ? "700" : "600", flex: 1 }} numberOfLines={1}>{th.name ?? formatPhone(th.phone)}</Txt>
              <Txt muted style={{ fontSize: 12 }}>{shortWhen(th.last.at)}</Txt>
            </Row>
            <Txt muted={!th.unread} style={{ fontSize: 14 }} numberOfLines={1}>{th.last.direction === "out" ? "You: " : ""}{th.last.body}</Txt>
          </View>
          {th.unread > 0 ? (
            <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: t.bad, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }}>
              <Txt style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>{th.unread}</Txt>
            </View>
          ) : th.status === "done" ? <Txt muted style={{ fontSize: 12 }}>Done</Txt> : null}
        </Pressable>
      ))}
      {d && !d.threads.length ? <Txt muted>{search ? "No conversations match." : filter === "unread" ? "Nothing unread." : "No texts yet."}</Txt> : null}
    </Screen>
  );
}

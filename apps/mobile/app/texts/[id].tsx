import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useContext, useEffect, useRef, useState, type ComponentRef } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import * as Notifications from "expo-notifications";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { TEXT_MAX, formatPhone, textSegments } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useTextsUnread } from "@/lib/texts";
import { ErrorText, Row, Txt, useTheme } from "@/components/ui";

/** One conversation by text: read it, answer it, mark it unread or done. */

type Text = { id: string; direction: "in" | "out"; body: string; status: string; error: string | null; source: string; by: string | null; at: string };
type Thread = { id: string; phone: string; kind: "customer" | "employee" | "unknown"; name: string | null; status: "open" | "done"; optedOut: string | null; connected: boolean; texts: Text[] };

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function TextThread() {
  const t = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conv = useApi<Thread>(id ? `/texting/threads/${id}` : null);
  const { refresh } = useTextsUnread();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const count = conv.data?.texts.length ?? 0;
  // Opening it marked its replies read: bring the count on the chat icon down.
  useEffect(() => { if (conv.data) refresh(); }, [count]); // eslint-disable-line react-hooks/exhaustive-deps
  // New texts show without leaving: at once when a notification arrives, and every few seconds otherwise.
  useEffect(() => {
    const timer = setInterval(() => { void conv.reload(); }, 10_000);
    const sub = Platform.OS === "web" ? null : Notifications.addNotificationReceivedListener(() => { void conv.reload(); });
    return () => { clearInterval(timer); sub?.remove(); };
  }, [conv.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = conv.data;
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError(null);
    try { await fn(); await conv.reload(); refresh(); after?.(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const send = () => act(async () => { await api(`/texting/threads/${id}`, { body: { body: body.trim() } }); setBody(""); });
  const seg = textSegments(body);
  const title = d ? d.name ?? formatPhone(d.phone) : "";
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title }} />
      <View style={{ paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface, marginTop: Platform.OS === "ios" ? headerHeight : 0 }}>
        <Row>
          <Txt muted style={{ flex: 1, fontSize: 13 }} numberOfLines={1}>{d ? `${formatPhone(d.phone)}${d.kind === "employee" ? " · on your team" : d.kind === "unknown" ? " · not a customer yet" : ""}` : "Loading…"}</Txt>
          {d ? (
            <Row style={{ gap: 14 }}>
              <Pressable disabled={busy} hitSlop={8} accessibilityRole="button" onPress={() => act(() => api(`/texting/threads/${id}/unread`, { method: "POST" }), () => router.back())}>
                <Txt style={{ color: t.primary, fontWeight: "600" }}>Mark unread</Txt>
              </Pressable>
              <Pressable disabled={busy} hitSlop={8} accessibilityRole="button" accessibilityState={{ selected: d.status === "done" }} onPress={() => act(() => api(`/texting/threads/${id}/status`, { body: { status: d.status === "done" ? "open" : "done" } }))}>
                <Txt style={{ color: d.status === "done" ? t.ok : t.primary, fontWeight: "600" }}>{d.status === "done" ? "Done ✓" : "Mark done"}</Txt>
              </Pressable>
            </Row>
          ) : null}
        </Row>
      </View>
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 8 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })} keyboardShouldPersistTaps="handled">
        <ErrorText error={conv.error} />
        {(d?.texts ?? []).map((m) => {
          const out = m.direction === "out", failed = m.status === "failed";
          return (
            <View key={m.id} style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "84%", gap: 2, alignItems: out ? "flex-end" : "flex-start" }}>
              <View style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderBottomRightRadius: out ? 4 : 16, borderBottomLeftRadius: out ? 16 : 4,
                backgroundColor: failed ? "transparent" : out ? t.primary : t.surface, borderWidth: failed || !out ? 1 : 0, borderColor: failed ? t.bad : t.border, borderStyle: failed ? "dashed" : "solid" }}>
                <Txt style={{ color: failed ? t.bad : out ? "#fff" : t.text, fontSize: 16 }}>{m.body}</Txt>
              </View>
              <Txt muted style={{ fontSize: 11 }}>
                {when(m.at)}{out ? ` · ${m.source === "automation" ? "automation" : m.source === "talkroute" ? "sent from Talkroute" : m.by ?? "office"}${failed ? ` · not sent: ${m.error ?? ""}` : ""}` : ""}
              </Txt>
            </View>
          );
        })}
        {d && !d.texts.length ? <Txt muted>No texts yet.</Txt> : null}
      </ScrollView>
      <View style={{ padding: 10, gap: 6, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface }}>
        <ErrorText error={error} />
        {d && !d.connected ? <Txt muted>Texting isn&apos;t connected yet.</Txt>
          : d?.optedOut ? <Txt style={{ color: t.bad }}>They replied STOP, so they can&apos;t be texted until they reply START.</Txt>
          : (
            <>
              <Row style={{ alignItems: "flex-end", gap: 8 }}>
                <TextInput value={body} onChangeText={setBody} multiline maxLength={TEXT_MAX} placeholder="Type your message..." placeholderTextColor={t.muted} accessibilityLabel="Message"
                  style={{ flex: 1, minHeight: 44, maxHeight: 140, borderWidth: 1, borderColor: t.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: t.text, backgroundColor: t.bg }} />
                <Pressable onPress={send} disabled={busy || !body.trim()} accessibilityRole="button" accessibilityLabel="Send"
                  style={{ height: 44, paddingHorizontal: 18, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: t.primary, opacity: busy || !body.trim() ? 0.5 : 1 }}>
                  <Txt style={{ color: "#fff", fontWeight: "700" }}>{busy ? "…" : "Send"}</Txt>
                </Pressable>
              </Row>
              {seg.segments > 1 ? <Txt muted style={{ fontSize: 12 }}>{seg.length} characters · sent as {seg.segments} texts</Txt> : null}
            </>
          )}
      </View>
    </KeyboardAvoidingView>
  );
}

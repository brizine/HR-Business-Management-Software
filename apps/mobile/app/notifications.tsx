import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { routeFor } from "@/lib/push";
import { useUnread } from "@/lib/unread";
import { Button, Card, Row, Screen, Txt, useTheme } from "@/components/ui";

function ago(d: string) {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(d).toLocaleDateString();
}

export default function Inbox() {
  const t = useTheme();
  const { refresh } = useUnread();
  const { data, loading, reload } = useApi<{ items: any[]; unread: number }>("/notifications");

  const open = async (n: any) => {
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: "POST" }).catch(() => {});
    refresh();
    const route = routeFor(n.link);
    if (route && route !== "/notifications") router.push(route as never);
    else reload();
  };

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Button title="Notification settings" kind="secondary" onPress={() => router.push("/notification-settings")} />
      {!!data?.unread && (
        <Button title="Mark all as read" kind="secondary" onPress={() => api("/notifications/read-all", { method: "POST" }).then(() => { reload(); refresh(); })} />
      )}
      {data?.items.map((n) => (
        <Pressable key={n.id} onPress={() => open(n)}>
          <Card>
            <Row style={{ alignItems: "flex-start" }}>
              {!n.readAt && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.primary, marginTop: 7 }} />}
              <View style={{ flex: 1, gap: 2 }}>
                <Txt style={{ fontWeight: n.readAt ? "400" : "700" }}>{n.title}</Txt>
                <Txt muted>{n.body}</Txt>
              </View>
              <Txt muted style={{ fontSize: 12 }}>{ago(n.createdAt)}</Txt>
            </Row>
          </Card>
        </Pressable>
      ))}
      {data && !data.items.length && <Txt muted>You're all caught up.</Txt>}
    </Screen>
  );
}

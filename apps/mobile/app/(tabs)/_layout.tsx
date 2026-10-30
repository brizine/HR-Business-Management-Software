import { Tabs, router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/components/ui";
import { useUnread } from "@/lib/unread";

const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

function Bell() {
  const t = useTheme();
  const { unread } = useUnread();
  return (
    <Pressable onPress={() => router.push("/notifications")} hitSlop={10} style={{ marginRight: 16 }} accessibilityLabel={`Notifications, ${unread} unread`}>
      <Text style={{ fontSize: 20 }}>🔔</Text>
      {unread > 0 && (
        <View style={{ position: "absolute", top: -4, right: -8, backgroundColor: t.bad, borderRadius: 9, minWidth: 18, height: 18, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
          <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{unread > 99 ? "99+" : unread}</Text>
        </View>
      )}
    </Pressable>
  );
}

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.primary, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface }, headerRight: () => <Bell /> }}>
      <Tabs.Screen name="index" options={{ title: "Clock", tabBarIcon: icon("⏱") }} />
      <Tabs.Screen name="schedule" options={{ title: "Schedule", tabBarIcon: icon("📅") }} />
      <Tabs.Screen name="fleet" options={{ title: "Fleet", tabBarIcon: icon("🚚") }} />
      <Tabs.Screen name="spray-mix" options={{ title: "Spray Mix", headerTitle: "Spray Mix Calculator", tabBarIcon: icon("🧪") }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: icon("✓") }} />
      <Tabs.Screen name="profile" options={{ title: "Me", tabBarIcon: icon("👤") }} />
    </Tabs>
  );
}

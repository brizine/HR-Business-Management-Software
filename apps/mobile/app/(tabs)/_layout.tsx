import { Tabs, router } from "expo-router";
import { Pressable, Text, View, type ColorValue } from "react-native";
import { useTheme } from "@/components/ui";
import { useUnread } from "@/lib/unread";
import { CompanyLogo } from "@/components/company-logo";
import { useAuth } from "@/lib/auth";

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

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
  const { me } = useAuth();
  // The bar at the top shows the company logo; the name only when there's no logo (they overlapped).
  const headerTitle = me?.company.hasLogo ? "" : me?.company.name ?? "";
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.primary, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface }, headerTitle, headerRight: () => <Bell />, headerLeft: () => <View style={{ marginLeft: 16 }}><CompanyLogo /></View> }}>
      <Tabs.Screen name="index" options={{ title: "Clock", tabBarIcon: icon("⏱") }} />
      <Tabs.Screen name="schedule" options={{ title: "Schedule", tabBarIcon: icon("📅") }} />
      <Tabs.Screen name="fleet" options={{ title: "Fleet", tabBarIcon: icon("🚚") }} />
      <Tabs.Screen name="spray-mix" options={{ title: "Spray Mix", tabBarIcon: icon("🧪") }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: icon("✓") }} />
      <Tabs.Screen name="profile" options={{ title: "Me", tabBarIcon: icon("👤") }} />
    </Tabs>
  );
}

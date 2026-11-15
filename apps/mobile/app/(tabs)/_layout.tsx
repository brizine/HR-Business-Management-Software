import { Tabs, router } from "expo-router";
import { Pressable, Text, View, type ColorValue } from "react-native";
import { useTheme } from "@/components/ui";
import { useUnread } from "@/lib/unread";
import { CompanyLogo } from "@/components/company-logo";
import { useAuth } from "@/lib/auth";

// Each icon sits in the same fixed box, centered, so emoji of different widths line up evenly.
const icon = (glyph: string) => ({ color }: { color: ColorValue }) => (
  <View style={{ width: 28, height: 26, alignItems: "center", justifyContent: "center" }}>
    <Text style={{ color, fontSize: 18, textAlign: "center" }}>{glyph}</Text>
  </View>
);

function Bell() {
  const t = useTheme();
  const { unread } = useUnread();
  return (
    <Pressable onPress={() => router.push("/notifications")} hitSlop={10} style={{ marginRight: 16 }} accessibilityLabel={`Notifications, ${unread} unread`}>
      <Text style={{ fontSize: 20 }}>🔔</Text>
      {unread > 0 && (
        // Centered over the bell (a wider "99+" grows equally both ways).
        <View pointerEvents="none" style={{ position: "absolute", top: -14, left: -12, right: -12, alignItems: "center" }}>
          <View style={{ backgroundColor: t.bad, borderRadius: 9, minWidth: 18, height: 18, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
            <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{unread > 99 ? "99+" : unread}</Text>
          </View>
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
    <Tabs screenOptions={{ tabBarActiveTintColor: t.primary, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface, paddingHorizontal: 0 }, tabBarItemStyle: { flex: 1, paddingHorizontal: 0, alignItems: "center" }, tabBarLabelPosition: "below-icon", tabBarLabelStyle: { fontSize: 11, textAlign: "center" }, headerTitle, headerRight: () => <Bell />, headerLeft: () => <View style={{ marginLeft: 16 }}><CompanyLogo /></View> }}>
      <Tabs.Screen name="index" options={{ title: "Clock", tabBarIcon: icon("⏱") }} />
      <Tabs.Screen name="schedule" options={{ title: "Schedule", tabBarIcon: icon("📅") }} />
      <Tabs.Screen name="fleet" options={{ title: "Fleet", tabBarIcon: icon("🚚") }} />
      <Tabs.Screen name="spray-mix" options={{ title: "Spray Mix", tabBarIcon: icon("🧪") }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: icon("✓") }} />
      <Tabs.Screen name="profile" options={{ title: "Me", tabBarIcon: icon("👤") }} />
    </Tabs>
  );
}

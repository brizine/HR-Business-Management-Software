import { Tabs } from "expo-router";
import { Text } from "react-native";
import { useTheme } from "@/components/ui";

const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.primary, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface } }}>
      <Tabs.Screen name="index" options={{ title: "Clock", tabBarIcon: icon("⏱") }} />
      <Tabs.Screen name="time-off" options={{ title: "Time off", tabBarIcon: icon("🌴") }} />
      <Tabs.Screen name="fleet" options={{ title: "Fleet", tabBarIcon: icon("🚚") }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", tabBarIcon: icon("✓") }} />
      <Tabs.Screen name="profile" options={{ title: "Me", tabBarIcon: icon("👤") }} />
    </Tabs>
  );
}

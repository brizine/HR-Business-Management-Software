import { Link, Stack, useLocalSearchParams } from "expo-router";
import { Pressable, View } from "react-native";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Card, Divider, ErrorText, Screen, Txt, useTheme } from "@/components/ui";
import { Markdown } from "@/components/markdown";

export default function WikiPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { data: p, error, loading, reload } = useApi(`/wiki/pages/${id}`);
  if (!p) return <Screen><ErrorText error={error} /></Screen>;
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: p.title }} />
      {p.breadcrumbs.length > 0 && <Txt muted style={{ fontSize: 13 }}>{p.breadcrumbs.map((c: any) => c.title).join(" › ")}</Txt>}
      <Txt style={{ fontSize: 24, fontWeight: "800" }} >{p.title}</Txt>
      <Txt muted style={{ fontSize: 13 }}>Updated {fmtDate(p.updatedAt)}{p.updatedBy ? ` by ${p.updatedBy}` : ""}{p.canEdit ? " · edit on the website" : ""}</Txt>
      <Card>{p.body.trim() ? <Markdown text={p.body} /> : <Txt muted>This page is empty.</Txt>}</Card>
      {p.children.length > 0 && (
        <Card title="Pages in this section">
          {p.children.map((c: any) => (
            <View key={c.id}>
              <Divider />
              <Link href={`/wiki/${c.id}`} asChild>
                <Pressable accessibilityRole="link" style={{ paddingVertical: 8 }}><Txt style={{ color: t.primary }}>{c.title}</Txt></Pressable>
              </Link>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

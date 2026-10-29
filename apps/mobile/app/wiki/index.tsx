import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useApi } from "@/lib/hooks";
import { Card, Input, Screen, Txt } from "@/components/ui";

/** The company wiki (read-only on the phone; edit on the website). */
export default function Wiki() {
  const [q, setQ] = useState("");
  const search = q.trim().length >= 2 ? `/wiki/pages?q=${encodeURIComponent(q.trim())}` : "/wiki/pages";
  const { data, loading, reload } = useApi<any[]>(search);
  const pages = data ?? [];

  const tree = (parentId: string | null, depth: number): React.ReactNode[] =>
    pages
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title))
      .flatMap((p) => [
        <Link key={p.id} href={`/wiki/${p.id}`} asChild>
          <Pressable accessibilityRole="link" style={{ paddingVertical: 10, paddingLeft: depth * 16 }}>
            <Txt style={{ fontWeight: depth ? "400" : "600" }}>{p.pinned ? "📌 " : ""}{p.title}</Txt>
          </Pressable>
        </Link>,
        ...tree(p.id, depth + 1),
      ]);

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Input label="Search the wiki" value={q} onChangeText={setQ} placeholder="e.g. payroll, ladder" returnKeyType="search" />
      <Card>
        {q.trim().length >= 2 ? (
          pages.length ? pages.map((p) => (
            <Link key={p.id} href={`/wiki/${p.id}`} asChild>
              <Pressable accessibilityRole="link" style={{ paddingVertical: 8, gap: 2 }}>
                <Txt style={{ fontWeight: "600" }}>{p.title}</Txt>
                <Txt muted style={{ fontSize: 13 }}>{p.snippet}</Txt>
              </Pressable>
            </Link>
          )) : <Txt muted>No pages match.</Txt>
        ) : pages.length ? <View>{tree(null, 0)}</View> : <Txt muted>{loading ? "Loading…" : "No pages yet."}</Txt>}
      </Card>
    </Screen>
  );
}

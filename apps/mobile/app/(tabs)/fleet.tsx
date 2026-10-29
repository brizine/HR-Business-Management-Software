import { Link, router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Row, Screen, Txt, useTheme } from "@/components/ui";

export default function Fleet() {
  const { me } = useAuth();
  const t = useTheme();
  const { data, loading, reload } = useApi<any[]>("/assets");
  const [onlyMine, setOnlyMine] = useState(true);
  const mine = data?.filter((a) => a.assignedEmployeeId === me?.user.id) ?? [];
  const list = onlyMine && mine.length ? mine : (data ?? []).filter((a) => a.status !== "retired");

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Button title="📷  Scan equipment QR" onPress={() => router.push("/scan")} />
      {mine.length > 0 && (
        <Row style={{ justifyContent: "flex-start" }}>
          {[["Assigned to me", true], ["All", false]].map(([label, v]) => (
            <Pressable key={String(v)} onPress={() => setOnlyMine(v as boolean)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: onlyMine === v ? t.primary : t.surface, borderWidth: 1, borderColor: t.border }}>
              <Txt style={{ color: onlyMine === v ? "#fff" : t.text }}>{label as string}</Txt>
            </Pressable>
          ))}
        </Row>
      )}
      {list.map((a) => (
        <Link key={a.id} href={`/asset/${a.id}`} asChild>
          <Pressable>
            <Card>
              <Row>
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: "700", fontSize: 16 }}>{a.name}</Txt>
                  <Txt muted>{[a.year, a.make, a.model].filter(Boolean).join(" ") || a.type.replace("_", " ")}</Txt>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Badge value={a.status} />
                  {a.maintenanceStatus !== "ok" && <Badge value={a.maintenanceStatus} />}
                </View>
              </Row>
            </Card>
          </Pressable>
        </Link>
      ))}
      {!list.length && !loading && <Txt muted>No assets yet.</Txt>}
    </Screen>
  );
}

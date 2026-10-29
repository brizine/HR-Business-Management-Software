import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, ErrorText, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

export default function Asset() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { data: a, loading, reload, error } = useApi(`/assets/${id}`);
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const [issue, setIssue] = useState<{ title: string; description: string; priority: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const saveMeter = async () => {
    setBusy(true);
    try {
      await api(`/assets/${id}/meter`, { body: { odometer: odometer ? Number(odometer) : undefined, engineHours: hours ? Number(hours) : undefined } });
      setOdometer(""); setHours(""); reload();
    } catch (e) {
      Alert.alert("Error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const report = async () => {
    setBusy(true);
    try {
      await api("/work-orders", { body: { assetId: id, ...issue, description: issue!.description || undefined } });
      setIssue(null);
      reload();
      Alert.alert("Reported", "Your issue was sent to the shop.");
    } catch (e) {
      Alert.alert("Error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!a) return <Screen><ErrorText error={error} /></Screen>;
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: a.name }} />
      <Card>
        <Row><Txt style={{ fontSize: 20, fontWeight: "700" }}>{a.name}</Txt><Badge value={a.status} /></Row>
        <Txt muted>{[a.year, a.make, a.model, a.licensePlate].filter(Boolean).join(" · ")}</Txt>
        <Row>
          <View><Txt muted>Odometer</Txt><Txt style={{ fontWeight: "700" }}>{a.odometer.toLocaleString()} mi</Txt></View>
          <View><Txt muted>Engine hours</Txt><Txt style={{ fontWeight: "700" }}>{a.engineHours.toLocaleString()}</Txt></View>
        </Row>
      </Card>

      <Button title="Start pre-trip inspection" onPress={() => router.push(`/inspect/${a.id}`)} />

      <Card title="Log meter reading">
        <Row>
          <View style={{ flex: 1 }}><Input label="Odometer" value={odometer} onChangeText={setOdometer} keyboardType="number-pad" placeholder={String(a.odometer)} /></View>
          <View style={{ flex: 1 }}><Input label="Engine hours" value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder={String(a.engineHours)} /></View>
        </Row>
        <Button title="Save reading" kind="secondary" onPress={saveMeter} busy={busy} disabled={!odometer && !hours} />
      </Card>

      {issue ? (
        <Card title="Report an issue">
          <Input label="What's wrong?" value={issue.title} onChangeText={(v) => setIssue({ ...issue, title: v })} placeholder="e.g. Check engine light" />
          <Input label="Details" value={issue.description} onChangeText={(v) => setIssue({ ...issue, description: v })} multiline />
          <Row style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
            {["low", "medium", "high", "critical"].map((p) => (
              <Pressable key={p} onPress={() => setIssue({ ...issue, priority: p })}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: issue.priority === p ? t.primary : t.border }}>
                <Txt>{p}</Txt>
              </Pressable>
            ))}
          </Row>
          {issue.priority === "critical" && <Txt muted>Critical takes the asset out of service until it's fixed.</Txt>}
          <Button title="Send to shop" onPress={report} busy={busy} disabled={!issue.title} />
          <Button title="Cancel" kind="secondary" onPress={() => setIssue(null)} />
        </Card>
      ) : (
        <Button title="Report an issue" kind="secondary" onPress={() => setIssue({ title: "", description: "", priority: "medium" })} />
      )}

      <Card title="Upcoming maintenance">
        {a.schedules.length ? a.schedules.map((s: any) => (
          <View key={s.id}>
            <Divider />
            <Row>
              <View style={{ flex: 1 }}><Txt>{s.name}</Txt><Txt muted>{s.due.reasons.join(", ") || `Next: ${[s.due.nextDueOdometer && `${s.due.nextDueOdometer.toLocaleString()} mi`, s.due.nextDueHours && `${s.due.nextDueHours} hrs`, s.due.nextDueDate && fmtDate(s.due.nextDueDate)].filter(Boolean).join(" / ")}`}</Txt></View>
              <Badge value={s.due.status} />
            </Row>
          </View>
        )) : <Txt muted>No schedules.</Txt>}
      </Card>

      <Card title="Open work orders">
        {a.workOrders.filter((w: any) => !["completed", "cancelled"].includes(w.status)).map((w: any) => (
          <View key={w.id}>
            <Divider />
            <Row><Txt>#{w.number} {w.title}</Txt><Badge value={w.status} /></Row>
          </View>
        ))}
        {!a.workOrders.some((w: any) => !["completed", "cancelled"].includes(w.status)) && <Txt muted>None.</Txt>}
      </Card>
    </Screen>
  );
}

import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { DEFAULT_INSPECTION_ITEMS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { Button, Card, Divider, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

type Item = { item: string; ok: boolean; note: string };

export default function Inspect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [items, setItems] = useState<Item[]>(DEFAULT_INSPECTION_ITEMS.map((item) => ({ item, ok: true, note: "" })));
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Item>) => setItems(items.map((x, j) => (i === j ? { ...x, ...patch } : x)));
  const defects = items.filter((i) => !i.ok).length;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api("/inspections", {
        body: {
          assetId: id,
          odometer: odometer ? Number(odometer) : undefined,
          engineHours: hours ? Number(hours) : undefined,
          notes: notes || undefined,
          items: items.map((i) => ({ item: i.item, ok: i.ok, note: i.note || undefined })),
        },
      });
      Alert.alert(
        res.inspection.passed ? "Inspection passed" : "Defects reported",
        res.workOrder ? `Work order #${res.workOrder.number} was opened for the shop.` : "Have a safe trip.",
      );
      router.back();
    } catch (e) {
      Alert.alert("Error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choice = (active: boolean, color: string) => ({
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1,
    borderColor: active ? color : t.border, backgroundColor: active ? color : "transparent",
  });

  return (
    <Screen>
      <Card>
        <Row>
          <View style={{ flex: 1 }}><Input label="Odometer" value={odometer} onChangeText={setOdometer} keyboardType="number-pad" /></View>
          <View style={{ flex: 1 }}><Input label="Engine hours" value={hours} onChangeText={setHours} keyboardType="decimal-pad" /></View>
        </Row>
      </Card>
      <Card title="Checklist">
        {items.map((it, i) => (
          <View key={it.item} style={{ gap: 6 }}>
            <Divider />
            <Row>
              <Txt style={{ flex: 1 }}>{it.item}</Txt>
              <Pressable onPress={() => set(i, { ok: true })} style={choice(it.ok, t.ok)}><Txt style={{ color: it.ok ? "#fff" : t.text }}>OK</Txt></Pressable>
              <Pressable onPress={() => set(i, { ok: false })} style={choice(!it.ok, t.bad)}><Txt style={{ color: !it.ok ? "#fff" : t.text }}>Defect</Txt></Pressable>
            </Row>
            {!it.ok && <Input label="Describe the problem" value={it.note} onChangeText={(v) => set(i, { note: v })} />}
          </View>
        ))}
      </Card>
      <Card><Input label="Notes" value={notes} onChangeText={setNotes} multiline /></Card>
      <Button title={defects ? `Submit with ${defects} defect${defects > 1 ? "s" : ""}` : "Submit: all OK"} kind={defects ? "danger" : "primary"} onPress={submit} busy={busy} />
    </Screen>
  );
}

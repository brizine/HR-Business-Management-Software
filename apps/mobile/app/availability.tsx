import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { WEEKDAYS, type AvailabilityRule } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { Button, Card, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

type Kind = "all" | "before" | "after" | "between";
type RuleRow = { weekday: number; kind: Kind; startTime: string; endTime: string; note: string };
const KINDS: [Kind, string][] = [["all", "All day"], ["before", "Before"], ["after", "After"], ["between", "Between"]];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const kindOf = (r: AvailabilityRule): Kind => (!r.startTime && !r.endTime ? "all" : !r.startTime ? "before" : !r.endTime ? "after" : "between");

function Chips<T extends string | number>({ options, value, onChange }: { options: [T, string][]; value: T; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 6 }}>
      {options.map(([v, label]) => (
        <Pressable key={String(v)} onPress={() => onChange(v)}
          style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, borderWidth: 1, borderColor: value === v ? t.primary : t.border, backgroundColor: value === v ? t.primary : "transparent" }}>
          <Txt style={{ fontSize: 13, color: value === v ? "#fff" : t.text }}>{label}</Txt>
        </Pressable>
      ))}
    </Row>
  );
}

export default function Availability() {
  const [rows, setRows] = useState<RuleRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<any[]>("/availability").then((data) =>
      setRows(data.map((r) => ({ weekday: r.weekday, kind: kindOf(r), startTime: r.startTime ?? "", endTime: r.endTime ?? "", note: r.note ?? "" }))),
    );
  }, []);
  if (!rows) return <Screen><Txt muted>Loading…</Txt></Screen>;
  const set = (i: number, patch: Partial<RuleRow>) => setRows(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  const save = async () => {
    const needsStart = (r: RuleRow) => r.kind === "after" || r.kind === "between";
    const needsEnd = (r: RuleRow) => r.kind === "before" || r.kind === "between";
    const bad = rows.find((r) => (needsStart(r) && !HHMM.test(r.startTime)) || (needsEnd(r) && !HHMM.test(r.endTime)));
    if (bad) return Alert.alert("Check the times", `Use 24-hour HH:MM, like 07:30 or 14:00 (${WEEKDAYS[bad.weekday]}).`);
    setBusy(true);
    try {
      await api("/availability", {
        method: "PUT",
        body: {
          rules: rows.map((r) => ({
            weekday: r.weekday,
            startTime: needsStart(r) ? r.startTime : null,
            endTime: needsEnd(r) ? r.endTime : null,
            note: r.note || null,
          })),
        },
      });
      Alert.alert("Saved", "Your manager has been notified.");
      router.back();
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Txt muted>Recurring times you can&apos;t work. For specific days off, request time off instead.</Txt>
      {rows.map((r, i) => (
        <Card key={i}>
          <Chips options={WEEKDAYS.map((d, n) => [n, d.slice(0, 3)] as [number, string])} value={r.weekday} onChange={(v) => set(i, { weekday: v })} />
          <Chips options={KINDS} value={r.kind} onChange={(v) => set(i, { kind: v })} />
          <Row>
            {(r.kind === "after" || r.kind === "between") && (
              <View style={{ flex: 1 }}><Input label={r.kind === "after" ? "After (HH:MM)" : "From (HH:MM)"} value={r.startTime} onChangeText={(v) => set(i, { startTime: v })} placeholder="14:00" /></View>
            )}
            {(r.kind === "before" || r.kind === "between") && (
              <View style={{ flex: 1 }}><Input label={r.kind === "before" ? "Before (HH:MM)" : "Until (HH:MM)"} value={r.endTime} onChangeText={(v) => set(i, { endTime: v })} placeholder="12:00" /></View>
            )}
          </Row>
          <Input label="Reason (optional)" value={r.note} onChangeText={(v) => set(i, { note: v })} />
          <Button title="Remove" kind="secondary" onPress={() => setRows(rows.filter((_, j) => j !== i))} />
        </Card>
      ))}
      {!rows.length && <Txt muted>You&apos;re available any day, any time.</Txt>}
      <Button title="+ Add a time I can't work" kind="secondary" onPress={() => setRows([...rows, { weekday: 1, kind: "all", startTime: "", endTime: "", note: "" }])} />
      <Button title="Save availability" onPress={save} busy={busy} />
    </Screen>
  );
}

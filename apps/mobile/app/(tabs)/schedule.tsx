import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { shiftDay, shiftTimes } from "@/lib/shifts";
import { Badge, Button, Card, Divider, Row, Screen, Txt, useTheme } from "@/components/ui";
import { TimeOffView } from "@/components/time-off-view";


function ShiftDetails({ shift, assetName }: { shift: any; assetName: string | null }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Txt style={{ fontWeight: "700" }}>{shiftDay(shift.startsAt)}</Txt>
      <Txt>{shiftTimes(shift)}</Txt>
      {(shift.position || shift.location) && <Txt muted>{[shift.position, shift.location].filter(Boolean).join(" · ")}</Txt>}
      {assetName && <Txt muted>🚚 {assetName}</Txt>}
      {shift.notes && <Txt muted>{shift.notes}</Txt>}
    </View>
  );
}

/** Upcoming shifts, open shifts and availability. */
function ShiftsView() {
  const { data, loading, reload } = useApi<{ mine: any[]; open: any[] }>("/shifts/mine");
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await fn();
      Alert.alert(done);
      reload();
    } catch (e) {
      Alert.alert("Couldn't do that", (e as Error).message);
      reload();
    } finally {
      setBusy(null);
    }
  };

  const drop = (shift: any) =>
    Alert.alert("Ask to drop this shift?", `${shiftDay(shift.startsAt)}, ${shiftTimes(shift)}\n\nYour manager has to approve it. You're still scheduled until then.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Send request", onPress: () => act(shift.id, () => api(`/shifts/${shift.id}/drop-request`, { body: {} }), "Request sent to your manager") },
    ]);

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Card title="My upcoming shifts">
        {data?.mine.length ? data.mine.map(({ shift, assetName }) => (
          <View key={shift.id} style={{ gap: 8 }}>
            <Divider />
            <Row style={{ alignItems: "flex-start" }}>
              <ShiftDetails shift={shift} assetName={assetName} />
              {shift.dropRequestedAt && <Badge value="pending" />}
            </Row>
            {!shift.dropRequestedAt && new Date(shift.startsAt) > new Date() && (
              <Button title="Ask to drop" kind="secondary" busy={busy === shift.id} onPress={() => drop(shift)} />
            )}
          </View>
        )) : <Txt muted>No shifts in the next two weeks.</Txt>}
      </Card>
      <Button title="My availability" kind="secondary" onPress={() => router.push("/availability")} />
      <Card title="Open shifts">
        {data?.open.length ? data.open.map(({ shift, assetName }) => (
          <View key={shift.id} style={{ gap: 8 }}>
            <Divider />
            <ShiftDetails shift={shift} assetName={assetName} />
            <Button title="Pick up this shift" busy={busy === shift.id}
              onPress={() => act(shift.id, () => api(`/shifts/${shift.id}/claim`, { method: "POST" }), "It's yours! The shift is on your schedule.")} />
          </View>
        )) : <Txt muted>No open shifts right now.</Txt>}
      </Card>
    </Screen>
  );
}

type ScheduleView = "shifts" | "time-off";

/** The Schedule tab: shifts and time off, switched at the top. */
export default function Schedule() {
  const t = useTheme();
  // Notifications about time off open this tab with ?view=time-off.
  const params = useLocalSearchParams<{ view?: string }>();
  const [view, setView] = useState<ScheduleView>(params.view === "time-off" ? "time-off" : "shifts");
  useEffect(() => {
    if (params.view === "time-off" || params.view === "shifts") setView(params.view);
  }, [params.view]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", margin: 12, marginBottom: 0, borderRadius: 10, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, padding: 3 }}>
        {([["shifts", "Shifts"], ["time-off", "Time off"]] as const).map(([value, label]) => (
          <Pressable key={value} onPress={() => setView(value)} accessibilityRole="tab" accessibilityState={{ selected: view === value }}
            style={{ flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: "center", backgroundColor: view === value ? t.primary : "transparent" }}>
            <Txt style={{ fontWeight: "600", color: view === value ? "#fff" : t.text }}>{label}</Txt>
          </Pressable>
        ))}
      </View>
      {view === "shifts" ? <ShiftsView /> : <TimeOffView />}
    </View>
  );
}

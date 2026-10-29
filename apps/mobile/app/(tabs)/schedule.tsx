import { useState } from "react";
import { Alert, View } from "react-native";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { shiftDay, shiftTimes } from "@/lib/shifts";
import { Badge, Button, Card, Divider, Row, Screen, Txt } from "@/components/ui";


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

export default function Schedule() {
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

import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { entryHours, summarizeHours } from "@crewdesk/shared";
import { api, fmtDate, fmtTime } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, ErrorText, Row, Screen, Txt } from "@/components/ui";

function weekStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

/** Best-effort GPS fix; clocking in still works if permission is denied. */
async function currentPosition() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return {};
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return {};
  }
}

export default function Clock() {
  const { me } = useAuth();
  const status = useApi("/time/status");
  const week = useApi<any[]>(`/time/entries?from=${encodeURIComponent(weekStartIso())}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  const open = status.data?.openEntry;
  const totals = summarizeHours(week.data ?? []);

  const punch = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(open ? "/time/clock-out" : "/time/clock-in", { body: await currentPosition() });
      await Promise.all([status.reload(), week.reload()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen refreshing={status.loading} onRefresh={() => { status.reload(); week.reload(); }}>
      <Txt style={{ fontSize: 22, fontWeight: "700" }}>Hi, {me?.user.firstName}</Txt>
      <Card>
        <View style={{ alignItems: "center", gap: 6, paddingVertical: 10 }}>
          {open ? (
            <>
              <Badge value="active" />
              <Txt style={{ fontSize: 40, fontWeight: "800" }}>{entryHours(open).toFixed(2)}h</Txt>
              <Txt muted>Clocked in at {fmtTime(open.clockIn)}</Txt>
            </>
          ) : (
            <>
              <Txt style={{ fontSize: 22, fontWeight: "700" }}>You're clocked out</Txt>
              <Txt muted>Your location is recorded when you clock in and out.</Txt>
            </>
          )}
        </View>
        <ErrorText error={error} />
        <Button title={open ? "Clock out" : "Clock in"} kind={open ? "danger" : "primary"} onPress={punch} busy={busy} />
      </Card>
      <Card title="This week">
        <Row>
          <View><Txt muted>Regular</Txt><Txt style={{ fontSize: 20, fontWeight: "700" }}>{totals.regularHours.toFixed(2)}</Txt></View>
          <View><Txt muted>Overtime</Txt><Txt style={{ fontSize: 20, fontWeight: "700" }}>{totals.overtimeHours.toFixed(2)}</Txt></View>
          <View><Txt muted>Total</Txt><Txt style={{ fontSize: 20, fontWeight: "700" }}>{totals.totalHours.toFixed(2)}</Txt></View>
        </Row>
        {week.data?.map((e) => (
          <View key={e.id}>
            <Divider />
            <Row>
              <Txt>{fmtDate(e.clockIn)}</Txt>
              <Txt muted>{fmtTime(e.clockIn)} – {e.clockOut ? fmtTime(e.clockOut) : "now"}</Txt>
              <Txt>{entryHours(e).toFixed(2)}h</Txt>
            </Row>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

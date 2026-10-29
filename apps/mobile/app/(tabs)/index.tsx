import * as Location from "expo-location";
import { useEffect, useState } from "react";
import { Alert, Linking, View } from "react-native";
import { entryHours, needsLocation, summarizeHours, usesGeofence, type LocationPolicy } from "@crewdesk/shared";
import { ApiError, api, fmtDate, fmtTime } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, ErrorText, Row, Screen, Txt } from "@/components/ui";
import { shiftDay, shiftTimes } from "@/lib/shifts";

function weekStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

/**
 * One GPS fix for this punch (never tracked in between). Uses high accuracy
 * when the company checks job sites. Returns {} if location is off or denied;
 * the server decides whether that's allowed.
 */
async function currentPosition(rule: LocationPolicy) {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return {};
    const pos = await Location.getCurrentPositionAsync({ accuracy: usesGeofence(rule) ? Location.Accuracy.High : Location.Accuracy.Balanced });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? undefined };
  } catch {
    return {};
  }
}

const locationOffAlert = (message: string) =>
  Alert.alert("Location needed", message, [
    { text: "Not now", style: "cancel" },
    { text: "Open Settings", onPress: () => Linking.openSettings() },
  ]);

export default function Clock() {
  const { me } = useAuth();
  const status = useApi("/time/status");
  const week = useApi<any[]>(`/time/entries?from=${encodeURIComponent(weekStartIso())}`);
  const shifts = useApi<{ mine: any[] }>("/shifts/mine");
  const next = shifts.data?.mine[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  const open = status.data?.openEntry;
  const totals = summarizeHours(week.data ?? []);
  const rule: LocationPolicy = (open ? status.data?.locationPolicy?.clockOut : status.data?.locationPolicy?.clockIn) ?? "optional";
  const [result, setResult] = useState<string | null>(null);

  const punch = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const loc = await currentPosition(rule);
      if (needsLocation(rule) && loc.lat === undefined) {
        locationOffAlert(`Your company needs your location to clock ${open ? "out" : "in"}. Allow location for Crewdesk in Settings, then try again.`);
        return;
      }
      const row = await api(open ? "/time/clock-out" : "/time/clock-in", { body: loc });
      setResult(
        `${open ? "Clocked out" : "Clocked in"}${row.siteName ? ` at ${row.siteName}` : ""}.` +
          (row.clockInFlag || row.clockOutFlag ? " You're away from a job site, so this punch is flagged for your manager." : ""),
      );
      await Promise.all([status.reload(), week.reload()]);
    } catch (e) {
      if (e instanceof ApiError && e.code === "location_required") locationOffAlert(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen refreshing={status.loading} onRefresh={() => { status.reload(); week.reload(); shifts.reload(); }}>
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
            </>
          )}
          <Txt muted style={{ textAlign: "center" }}>
            {rule === "optional"
              ? "Your location is recorded when you clock in and out, if location is on."
              : usesGeofence(rule)
                ? `📍 Clock ${open ? "out" : "in"} at a job site${rule === "geofence_flag" ? " (punches elsewhere are flagged)" : ""}. Location is only checked at this moment.`
                : `📍 Location is required to clock ${open ? "out" : "in"}. It's only checked at this moment.`}
          </Txt>
        </View>
        {result && <Txt style={{ textAlign: "center" }}>{result}</Txt>}
        <ErrorText error={error} />
        {next && !open && (
          <Txt muted style={{ textAlign: "center" }}>
            Next shift: {shiftDay(next.shift.startsAt)}, {shiftTimes(next.shift)}{next.assetName ? ` · ${next.assetName}` : ""}
          </Txt>
        )}
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

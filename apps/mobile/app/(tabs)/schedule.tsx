import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { shiftDay, shiftTimes } from "@/lib/shifts";
import { Badge, Button, Card, Divider, Input, Row, Screen, Txt, useTheme } from "@/components/ui";
import { Chips } from "@/components/chips";
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

const NO_FILTERS = { q: "", show: "", position: "", location: "", asset: "" };
type Filters = typeof NO_FILTERS;
type ShiftRow = { shift: any; assetName: string | null };

/** Distinct non-empty values, sorted, for a filter. */
const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))].sort((a, b) => a.localeCompare(b));

/** Search and filters for the shift lists (same as the website's Schedule page, minus the team-only ones). */
function ShiftFilters({ rows, filters, onChange }: { rows: ShiftRow[]; filters: Filters; onChange: (f: Filters) => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const positions = distinct(rows.map((r) => r.shift.position));
  const locations = distinct(rows.map((r) => r.shift.location));
  const assets = distinct(rows.map((r) => r.shift.assetId)).map((id) => ({ value: id, label: rows.find((r) => r.shift.assetId === id)?.assetName ?? "Unknown" }));
  const active = (["show", "position", "location", "asset"] as const).filter((k) => filters[k]).length;
  const choices = (all: string, list: { value: string; label: string }[]) => [{ value: "", label: all }, ...list];
  return (
    <Card>
      <Input label="Search" placeholder="Position, site, vehicle, notes…" value={filters.q} onChangeText={(q) => set({ q })} clearButtonMode="while-editing" autoCorrect={false} />
      <Row>
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8}>
          <Txt style={{ color: t.primary, fontWeight: "600" }}>{open ? "Hide filters" : `Filters${active ? ` (${active})` : ""}`}</Txt>
        </Pressable>
        {(active > 0 || !!filters.q) && (
          <Pressable onPress={() => onChange(NO_FILTERS)} accessibilityRole="button" hitSlop={8}>
            <Txt style={{ color: t.primary }}>Clear filters</Txt>
          </Pressable>
        )}
      </Row>
      {open && (
        <View style={{ gap: 10 }}>
          <Txt muted>Show</Txt>
          <Chips label="Show" value={filters.show} onChange={(show) => set({ show })} options={choices("All shifts", [{ value: "mine", label: "My shifts" }, { value: "open", label: "Open shifts" }])} />
          {positions.length > 0 && <><Txt muted>Position</Txt><Chips label="Position" value={filters.position} onChange={(position) => set({ position })} options={choices("All", positions.map((v) => ({ value: v, label: v })))} /></>}
          {locations.length > 0 && <><Txt muted>Location / job site</Txt><Chips label="Location" value={filters.location} onChange={(location) => set({ location })} options={choices("All", locations.map((v) => ({ value: v, label: v })))} /></>}
          {assets.length > 0 && <><Txt muted>Vehicle / equipment</Txt><Chips label="Vehicle" value={filters.asset} onChange={(asset) => set({ asset })} options={choices("All", assets)} /></>}
        </View>
      )}
    </Card>
  );
}

const matches = (r: ShiftRow, f: Filters) => {
  const s = r.shift;
  const q = f.q.trim().toLowerCase();
  return (!f.position || s.position === f.position) && (!f.location || s.location === f.location) && (!f.asset || s.assetId === f.asset) &&
    (!q || `${s.position ?? ""} ${s.location ?? ""} ${r.assetName ?? ""} ${s.notes ?? ""} ${shiftDay(s.startsAt)}`.toLowerCase().includes(q));
};

/** Upcoming shifts, open shifts and availability. */
function ShiftsView() {
  const { me } = useAuth();
  const { data, loading, reload } = useApi<{ mine: any[]; open: any[] }>("/shifts/mine");
  const [busy, setBusy] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const filtering = Object.values(filters).some(Boolean);
  const mine = (data?.mine ?? []).filter((r) => matches(r, filters));
  const open = (data?.open ?? []).filter((r) => matches(r, filters));

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
      <ShiftFilters rows={[...(data?.mine ?? []), ...(data?.open ?? [])]} filters={filters} onChange={setFilters} />
      {filters.show !== "open" && <Card title="My upcoming shifts">
        {mine.length ? mine.map(({ shift, assetName }) => (
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
        )) : <Txt muted>{filtering && data?.mine.length ? "None of your shifts match your filters." : "No shifts in the next two weeks."}</Txt>}
      </Card>}
      {/* Availability is only tracked for part-time employees. */}
      {me?.user.employmentType === "part_time" && <Button title="My availability" kind="secondary" onPress={() => router.push("/availability")} />}
      {filters.show !== "mine" && <Card title="Open shifts">
        {open.length ? open.map(({ shift, assetName }) => (
          <View key={shift.id} style={{ gap: 8 }}>
            <Divider />
            <ShiftDetails shift={shift} assetName={assetName} />
            <Button title="Pick up this shift" busy={busy === shift.id}
              onPress={() => act(shift.id, () => api(`/shifts/${shift.id}/claim`, { method: "POST" }), "It's yours! The shift is on your schedule.")} />
          </View>
        )) : <Txt muted>{filtering && data?.open.length ? "No open shifts match your filters." : "No open shifts right now."}</Txt>}
      </Card>}
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

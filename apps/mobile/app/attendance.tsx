import { useState } from "react";
import { Pressable, View } from "react-native";
import { ATTENDANCE_LABELS, type AttendanceStatus } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Button, Card, Row, Screen, Txt, useTheme } from "@/components/ui";

/** Green worked, yellow late/left early, red no-show, blue sick, grey excused (same as the website). */
const COLORS: Partial<Record<AttendanceStatus, { bg: string; fg: string }>> = {
  on_time: { bg: "#dcfce7", fg: "#14532d" },
  unscheduled: { bg: "#f0fdf4", fg: "#14532d" },
  tardy: { bg: "#fef9c3", fg: "#713f12" },
  early_leave: { bg: "#fef9c3", fg: "#713f12" },
  no_show: { bg: "#fee2e2", fg: "#7f1d1d" },
  sick: { bg: "#dbeafe", fg: "#1e3a8a" },
  excused: { bg: "#f3f4f6", fg: "#374151" },
};
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Your attendance by month, and your attendance points. */
export default function MyAttendance() {
  const t = useTheme();
  const { me } = useAuth();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [picked, setPicked] = useState<string | null>(null);
  const first = ymd(month);
  const last = ymd(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  const { data, loading, reload } = useApi<any>(me ? `/attendance?from=${first}&to=${last}&employeeId=${me.user.id}` : null);
  const person = data?.people?.[0];
  const byDate = new Map<string, any>((person?.days ?? []).map((d: any) => [d.date, d]));
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)).filter((d, i) => i < 35 || d.getMonth() === month.getMonth());
  const day = picked ? byDate.get(picked) : null;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {person && data.rules.pointsEnabled && (
        <Card title="Attendance points">
          <Txt style={{ fontSize: 28, fontWeight: "800" }}>{person.points.total}</Txt>
          {person.points.highest && <Txt>Reached: {person.points.highest.label}</Txt>}
          {person.points.next && <Txt muted>Next level: {person.points.next.label} at {person.points.next.points}</Txt>}
          <Txt muted>Points drop off after {data.rules.pointsExpireDays} days.</Txt>
        </Card>
      )}
      <Card>
        <Row>
          <Button title="‹" kind="secondary" onPress={() => { setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)); setPicked(null); }} />
          <Txt style={{ fontWeight: "700" }}>{month.toLocaleDateString([], { month: "long", year: "numeric" })}</Txt>
          <Button title="›" kind="secondary" onPress={() => { setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)); setPicked(null); }} />
        </Row>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <Txt key={i} muted style={{ width: `${100 / 7}%`, textAlign: "center", fontSize: 12 }}>{d}</Txt>)}
          {cells.map((d) => {
            const iso = ymd(d);
            const rec = byDate.get(iso);
            const c = rec ? COLORS[rec.status as AttendanceStatus] : undefined;
            const other = d.getMonth() !== month.getMonth();
            return (
              <Pressable key={iso} onPress={() => !other && setPicked(iso)} style={{ width: `${100 / 7}%`, padding: 2 }} accessibilityLabel={`${iso}: ${rec ? ATTENDANCE_LABELS[rec.status as AttendanceStatus] : "nothing scheduled"}`}>
                <View style={{ borderRadius: 8, paddingVertical: 10, alignItems: "center", backgroundColor: c?.bg ?? "transparent", borderWidth: picked === iso ? 2 : 1, borderColor: picked === iso ? t.text : t.border, opacity: other ? 0.3 : 1 }}>
                  <Txt style={{ color: c?.fg ?? t.text, fontWeight: "600" }}>{d.getDate()}</Txt>
                </View>
              </Pressable>
            );
          })}
        </View>
        <Txt muted style={{ fontSize: 12 }}>Green: worked as scheduled · Yellow: late or left early · Red: no-show · Blue: called in sick · Grey: excused</Txt>
      </Card>
      {picked && (
        <Card title={new Date(`${picked}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}>
          {day ? (
            <>
              <Txt style={{ fontWeight: "700" }}>{ATTENDANCE_LABELS[day.status as AttendanceStatus]}{day.points ? ` · ${day.points} point${day.points === 1 ? "" : "s"}` : ""}</Txt>
              {day.note && <Txt muted>{day.note}</Txt>}
              {day.shifts.map((s: any, i: number) => (
                <Txt key={i} muted>
                  Scheduled {new Date(s.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–{new Date(s.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  {s.clockIn ? ` · in ${new Date(s.clockIn).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}{s.minutesLate ? ` (${s.minutesLate} min late)` : ""}
                </Txt>
              ))}
            </>
          ) : <Txt muted>Nothing scheduled or recorded.</Txt>}
        </Card>
      )}
    </Screen>
  );
}

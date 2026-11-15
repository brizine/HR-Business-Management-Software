import { useMemo, useState } from "react";
import { Alert, Pressable, Share, View, Linking } from "react-native";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { shiftTimes } from "@/lib/shifts";
import { Badge, Button, Card, Divider, Row, Txt, useTheme } from "./ui";
import { Chips } from "./chips";

/** The phone's local calendar day, YYYY-MM-DD. */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Weeks start on Monday, like the website's schedule. */
const startOfWeek = (d: Date) => addDays(atMidnight(d), -((d.getDay() + 6) % 7));
const hours = (s: { startsAt: string; endsAt: string }) => (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 3_600_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOLIDAY = "#8250df";

type ShiftRow = { shift: any; employee: { id: string; firstName: string; lastName: string } | null; assetName: string | null };
type Off = { id: string; startDate: string; endDate: string; who?: string; policy?: string };
type Holiday = { name: string; date: string };

/** Ask for your private subscription link, then add it to Apple Calendar or share it (Google Calendar, others). */
export async function subscribeToCalendar() {
  try {
    const link = await api<{ url: string; webcal: string }>("/shifts/calendar-link", { method: "POST" });
    Alert.alert(
      "Subscribe in Calendar",
      "Your published shifts, approved time off and paid holidays show up in your phone's calendar and update on their own. This link is private to you.",
      [
        { text: "Add to iPhone Calendar", onPress: () => Linking.openURL(link.webcal).catch(() => Linking.openURL(link.url)) },
        { text: "Share link (Google Calendar…)", onPress: () => Share.share({ message: link.url }) },
        { text: "Reset my link", style: "destructive", onPress: () =>
          Alert.alert("Reset your calendar link?", "Calendars using the old link stop updating. Subscribe again afterwards.", [
            { text: "Cancel", style: "cancel" },
            { text: "Reset", style: "destructive", onPress: () => api("/shifts/calendar-link", { method: "DELETE" }).then(() => Alert.alert("Done", "Tap Subscribe in Calendar to get a new link."), (e) => Alert.alert("Couldn't reset", e.message)) },
          ]) },
        { text: "Cancel", style: "cancel" },
      ],
    );
  } catch (e) {
    Alert.alert("Couldn't get your calendar link", (e as Error).message);
  }
}

/**
 * Week or month calendar of shifts with colored dots (yours, open shifts you could pick up, time
 * off, paid holidays); tap a day for its details. Managers can switch to the whole crew.
 */
export function ShiftCalendar({ mode }: { mode: "week" | "month" }) {
  const { me, can } = useAuth();
  const t = useTheme();
  const manager = can("manager", "schedule");
  const today = ymd(new Date());
  const [anchor, setAnchor] = useState(() => atMidnight(new Date()));
  const [selected, setSelected] = useState(today);
  const [crew, setCrew] = useState(false);
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // The days shown: one week, or the month's weeks (Monday to Sunday).
  const { start, end, days, title } = useMemo(() => {
    if (mode === "week") {
      const s = startOfWeek(anchor);
      const e = addDays(s, 7);
      const fmt = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
      return { start: s, end: e, days: Array.from({ length: 7 }, (_, i) => addDays(s, i)), title: `${fmt(s)} – ${fmt(addDays(e, -1))}` };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const s = startOfWeek(first);
    const e = addDays(startOfWeek(last), 7);
    const n = Math.round((e.getTime() - s.getTime()) / 86_400_000);
    return { start: s, end: e, days: Array.from({ length: n }, (_, i) => addDays(s, i)), title: first.toLocaleDateString([], { month: "long", year: "numeric" }) };
  }, [mode, anchor]);

  const shiftsApi = useApi<ShiftRow[]>(`/shifts?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
  const myOff = useApi<{ request: any; policyName: string }[]>(crew ? null : "/pto/requests?mine=true&status=approved");
  const crewOff = useApi<any[]>(crew ? `/pto/calendar?from=${ymd(start)}&to=${ymd(addDays(end, -1))}` : null);
  const hol = useApi<{ upcoming: Holiday[] }>(`/holidays?from=${ymd(start)}&to=${ymd(addDays(end, -1))}`);
  const reload = () => { shiftsApi.reload(); myOff.reload(); crewOff.reload(); hol.reload(); };

  // Published only (managers also get drafts from the API; those aren't on anyone's calendar yet).
  const all = (shiftsApi.data ?? []).filter((r) => r.shift.status === "published");
  const people = [...new Map(all.filter((r) => r.employee).map((r) => [r.employee!.id, `${r.employee!.firstName} ${r.employee!.lastName}`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const shown = crew ? all.filter((r) => !person || r.employee?.id === person || (person === "open" && !r.shift.employeeId))
    : all.filter((r) => r.shift.employeeId === me?.user.id || (!r.shift.employeeId && Date.parse(r.shift.startsAt) > Date.now()));
  const offs: Off[] = crew
    ? (crewOff.data ?? []).map((o) => ({ id: o.id, startDate: o.startDate, endDate: o.endDate, who: `${o.firstName} ${o.lastName}`, policy: o.policyName })).filter((o) => !person || o.who === people.find((p) => p[0] === person)?.[1])
    : (myOff.data ?? []).map(({ request: r, policyName }) => ({ id: r.id, startDate: r.startDate, endDate: r.endDate, policy: policyName }));
  const holidays = hol.data?.upcoming ?? [];

  const byDay = (day: string) => ({
    shifts: shown.filter((r) => ymd(new Date(r.shift.startsAt)) === day),
    off: offs.filter((o) => o.startDate <= day && day <= o.endDate),
    holiday: holidays.filter((h) => h.date === day),
  });

  // Totals: your scheduled hours (or the crew's) for the week / month; weeks over 40 flagged.
  const inPeriod = (r: ShiftRow) => mode === "week" || new Date(r.shift.startsAt).getMonth() === anchor.getMonth();
  const mine = shown.filter((r) => r.shift.employeeId === (crew ? r.shift.employeeId : me?.user.id) && r.shift.employeeId && inPeriod(r));
  const total = mine.reduce((s, r) => s + hours(r.shift), 0);
  const overWeeks = crew ? [] : [...mine.reduce((m, r) => {
    const k = ymd(startOfWeek(new Date(r.shift.startsAt)));
    return m.set(k, (m.get(k) ?? 0) + hours(r.shift));
  }, new Map<string, number>()).entries()].filter(([, h]) => h > 40);
  const openCount = shown.filter((r) => !r.shift.employeeId && inPeriod(r)).length;

  const step = (dir: number) => {
    const next = mode === "week" ? addDays(anchor, 7 * dir) : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    setAnchor(next);
    setSelected(mode === "week" ? ymd(startOfWeek(next)) : ymd(next));
  };
  const goToday = () => { setAnchor(atMidnight(new Date())); setSelected(today); };

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try { await fn(); Alert.alert(done); } catch (e) { Alert.alert("Couldn't do that", (e as Error).message); } finally { setBusy(null); reload(); }
  };

  const dots = (day: string) => {
    const d = byDay(day);
    const list: string[] = [];
    if (d.shifts.some((r) => r.shift.employeeId && (crew || r.shift.employeeId === me?.user.id))) list.push(t.primary);
    if (d.shifts.some((r) => !r.shift.employeeId)) list.push(t.ok);
    if (d.off.length) list.push(t.muted);
    if (d.holiday.length) list.push(HOLIDAY);
    return list;
  };
  const sel = byDay(selected);
  const selDate = new Date(`${selected}T12:00:00`);

  return (
    <>
      <Card>
        <Row style={{ alignItems: "center" }}>
          <Pressable onPress={() => step(-1)} hitSlop={12} accessibilityLabel={mode === "week" ? "Previous week" : "Previous month"}><Txt style={{ fontSize: 22, color: t.primary, paddingHorizontal: 6 }}>‹</Txt></Pressable>
          <Pressable onPress={goToday} accessibilityLabel="Go to today" style={{ alignItems: "center", flex: 1 }}>
            <Txt style={{ fontWeight: "700", fontSize: 17 }}>{title}</Txt>
            <Txt muted style={{ fontSize: 12 }}>Tap for today</Txt>
          </Pressable>
          <Pressable onPress={() => step(1)} hitSlop={12} accessibilityLabel={mode === "week" ? "Next week" : "Next month"}><Txt style={{ fontSize: 22, color: t.primary, paddingHorizontal: 6 }}>›</Txt></Pressable>
        </Row>
        {manager && (
          <Chips label="Whose shifts" value={crew ? "crew" : "mine"} onChange={(v) => { setCrew(v === "crew"); setPerson(""); }}
            options={[{ value: "mine", label: "My shifts" }, { value: "crew", label: "Whole crew" }]} />
        )}
        {crew && people.length > 0 && (
          <Chips label="Person" value={person} onChange={setPerson} options={[{ value: "", label: "Everyone" }, { value: "open", label: "Open shifts" }, ...people.map(([id, name]) => ({ value: id, label: name }))]} />
        )}
        <View style={{ flexDirection: "row" }}>
          {WEEKDAYS.map((w) => <Txt key={w} muted style={{ flex: 1, textAlign: "center", fontSize: 12 }}>{w}</Txt>)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {days.map((d) => {
            const key = ymd(d);
            const outside = mode === "month" && d.getMonth() !== anchor.getMonth();
            const isSel = key === selected;
            const myFirst = byDay(key).shifts.find((r) => r.shift.employeeId === me?.user.id);
            return (
              <Pressable key={key} onPress={() => setSelected(key)} accessibilityRole="button" accessibilityState={{ selected: isSel }}
                accessibilityLabel={d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
                style={{ width: `${100 / 7}%`, alignItems: "center", paddingVertical: mode === "week" ? 8 : 5, borderRadius: 10, backgroundColor: isSel ? t.primary + "22" : "transparent" }}>
                <View style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: key === today ? 2 : 0, borderColor: t.primary }}>
                  <Txt style={{ fontWeight: isSel ? "700" : "500", color: outside ? t.muted : t.text }}>{d.getDate()}</Txt>
                </View>
                {mode === "week" && !crew && (
                  <Txt muted style={{ fontSize: 10, marginTop: 2 }}>{myFirst ? new Date(myFirst.shift.startsAt).toLocaleTimeString([], { hour: "numeric" }).replace(" ", "").toLowerCase() : "Off"}</Txt>
                )}
                <View style={{ flexDirection: "row", gap: 3, height: 8, marginTop: 3 }}>
                  {dots(key).map((c) => <View key={c} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c }} />)}
                </View>
              </Pressable>
            );
          })}
        </View>
        <Row style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 10 }}>
          {[[t.primary, crew ? "Shift" : "Your shift"], [t.ok, "Open shift"], [t.muted, "Time off"], [HOLIDAY, "Paid holiday"]].map(([c, l]) => (
            <Row key={l} style={{ gap: 4, alignItems: "center" }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} /><Txt muted style={{ fontSize: 12 }}>{l}</Txt></Row>
          ))}
        </Row>
      </Card>

      <Card title={crew ? "Crew hours" : "Scheduled hours"}>
        <Txt style={{ fontSize: 20, fontWeight: "700" }}>{total.toFixed(1)} hrs {mode === "week" ? "this week" : `in ${anchor.toLocaleDateString([], { month: "long" })}`}</Txt>
        <Txt muted>{mine.length} shift{mine.length === 1 ? "" : "s"}{openCount ? ` · ${openCount} open shift${openCount === 1 ? "" : "s"}` : ""}</Txt>
        {overWeeks.map(([wk, h]) => (
          <Txt key={wk} style={{ color: t.warn }}>⚠ Week of {new Date(`${wk}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}: {h.toFixed(1)} hrs (over 40)</Txt>
        ))}
      </Card>

      <Card title={selDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}>
        {sel.holiday.map((h) => <Txt key={h.name} style={{ color: HOLIDAY, fontWeight: "600" }}>🎉 Paid holiday: {h.name}</Txt>)}
        {sel.off.map((o) => <Txt key={o.id} muted>🌴 {o.who ? `${o.who}: ` : ""}Time off{o.policy ? ` (${o.policy})` : ""}</Txt>)}
        {sel.shifts.map(({ shift, employee, assetName }) => {
          const isMine = shift.employeeId === me?.user.id;
          const open = !shift.employeeId;
          const future = Date.parse(shift.startsAt) > Date.now();
          return (
            <View key={shift.id} style={{ gap: 6 }}>
              <Divider />
              <Row style={{ alignItems: "flex-start" }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt style={{ fontWeight: "700", color: open ? t.ok : t.text }}>{open ? "Open shift" : crew ? `${employee?.firstName ?? ""} ${employee?.lastName ?? ""}` : "Your shift"}</Txt>
                  <Txt>{shiftTimes(shift)} · {hours(shift).toFixed(1)} hrs</Txt>
                  {(shift.position || shift.location) && <Txt muted>{[shift.position, shift.location].filter(Boolean).join(" · ")}</Txt>}
                  {assetName && <Txt muted>🚚 {assetName}</Txt>}
                  {shift.notes && <Txt muted>{shift.notes}</Txt>}
                </View>
                {shift.dropRequestedAt && <Badge value="pending" />}
              </Row>
              {open && future && <Button title="Pick up this shift" busy={busy === shift.id} onPress={() => act(shift.id, () => api(`/shifts/${shift.id}/claim`, { method: "POST" }), "It's yours! The shift is on your schedule.")} />}
            </View>
          );
        })}
        {!sel.holiday.length && !sel.off.length && !sel.shifts.length && <Txt muted>{crew ? "No shifts this day." : "You're off this day."}</Txt>}
      </Card>
    </>
  );
}

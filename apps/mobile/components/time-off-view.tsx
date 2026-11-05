import { Alert, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, Row, Screen, Txt } from "./ui";
import { AccruedTimeOffCard, RequestTimeOffCard } from "./time-off-boxes";

/** Time-off balances, requests and (for managers) approvals. Shown inside the Schedule tab. */
export function TimeOffView() {
  const { can } = useAuth();
  const balances = useApi<any[]>("/pto/balances");
  const mine = useApi<any[]>("/pto/requests?mine=true");
  const pending = useApi<any[]>(can("manager", "timeoff") ? "/pto/requests?status=pending" : null);
  // Paid holidays in the next year (set up on the website's Time off page).
  const holidays = useApi<{ upcoming: { holidayId: string; name: string; hours: number; date: string; observed: string }[] }>("/holidays");
  const reload = () => { balances.reload(); mine.reload(); pending.reload(); holidays.reload(); };
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  const decide = (id: string, status: "approved" | "denied") =>
    api(`/pto/requests/${id}/decide`, { body: { status } }).then(reload, (e) => Alert.alert("Error", e.message));

  return (
    <Screen refreshing={balances.loading} onRefresh={reload}>
      <AccruedTimeOffCard balances={balances.data} />
      <RequestTimeOffCard balances={balances.data} onSent={reload} showRecent={false} />

      {can("manager", "timeoff") && !!pending.data?.length && (
        <Card title="Needs your approval">
          {pending.data.map(({ request: r, employee, policyName }) => (
            <View key={r.id} style={{ gap: 6 }}>
              <Divider />
              <Txt style={{ fontWeight: "600" }}>{employee.firstName} {employee.lastName}</Txt>
              <Txt muted>{policyName} · {r.hours}h · {fmtDate(r.startDate)} – {fmtDate(r.endDate)}</Txt>
              {r.reason && <Txt muted>"{r.reason}"</Txt>}
              <Row>
                <View style={{ flex: 1 }}><Button title="Approve" onPress={() => decide(r.id, "approved")} /></View>
                <View style={{ flex: 1 }}><Button title="Deny" kind="secondary" onPress={() => decide(r.id, "denied")} /></View>
              </Row>
            </View>
          ))}
        </Card>
      )}

      <Card title="My requests">
        {mine.data?.length ? mine.data.map(({ request: r, policyName }) => (
          <View key={r.id}>
            <Divider />
            <Row>
              <View style={{ flex: 1 }}>
                <Txt>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}</Txt>
                <Txt muted>{policyName} · {r.hours}h</Txt>
              </View>
              <Badge value={r.status} />
            </Row>
          </View>
        )) : <Txt muted>No requests yet.</Txt>}
      </Card>
      <Card title="Paid holidays">
        {holidays.data?.upcoming.length ? holidays.data.upcoming.map((h) => (
          <View key={`${h.holidayId}-${h.observed}`} style={{ gap: 2 }}>
            <Divider />
            <Row>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontWeight: "600" }}>{h.name}</Txt>
                <Txt muted>{day(h.observed)}{h.date !== h.observed ? " (observed)" : ""}</Txt>
              </View>
              <Txt muted>{h.hours}h</Txt>
            </Row>
          </View>
        )) : <Txt muted>No paid holidays in the next year.</Txt>}
      </Card>
    </Screen>
  );
}

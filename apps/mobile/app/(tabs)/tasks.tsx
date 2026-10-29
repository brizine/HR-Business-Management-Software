import { Alert, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { OnboardingTaskItem } from "@/components/onboarding-task";
import { Badge, Button, Card, Divider, Row, Screen, Txt } from "@/components/ui";

export default function Tasks() {
  const onboarding = useApi<any[]>("/onboarding/tasks?open=true");
  const workOrders = useApi<any[]>("/work-orders?status=active&mine=true");
  const { can } = useAuth();
  const waiting = useApi<any[]>(can("manager") ? "/onboarding/assigned" : null);
  const reload = () => { onboarding.reload(); workOrders.reload(); waiting.reload(); };

  const setStatus = (id: string, status: string) =>
    api(`/work-orders/${id}`, { method: "PATCH", body: { status } }).then(reload, (e) => Alert.alert("Error", e.message));

  return (
    <Screen refreshing={onboarding.loading || workOrders.loading} onRefresh={reload}>
      {!!onboarding.data?.length && (
        <Card title="My onboarding checklist">
          {onboarding.data.map((t) => <OnboardingTaskItem key={t.id} task={t} mode="self" onChange={reload} />)}
        </Card>
      )}
      {!!waiting.data?.length && (
        <Card title="Onboarding: waiting on you">
          {waiting.data.map((t) => (
            <OnboardingTaskItem key={t.id} mode="manager" onChange={reload}
              task={{ ...t, title: t.title, subtitle: `${t.employee.name} · due ${fmtDate(t.dueDate)}` }} />
          ))}
        </Card>
      )}
      <Card title="My work orders">
        {workOrders.data?.length ? workOrders.data.map(({ workOrder: w, assetName }) => (
          <View key={w.id} style={{ gap: 6 }}>
            <Divider />
            <Row>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontWeight: "600" }}>#{w.number} {w.title}</Txt>
                <Txt muted>{assetName}{w.dueDate ? ` · due ${fmtDate(w.dueDate)}` : ""}</Txt>
              </View>
              <View style={{ gap: 4, alignItems: "flex-end" }}><Badge value={w.priority} /><Badge value={w.status} /></View>
            </Row>
            {w.description ? <Txt muted>{w.description}</Txt> : null}
            <Row>
              {w.status === "open" && <View style={{ flex: 1 }}><Button title="Start" kind="secondary" onPress={() => setStatus(w.id, "in_progress")} /></View>}
              {w.status !== "waiting_parts" && <View style={{ flex: 1 }}><Button title="Waiting on parts" kind="secondary" onPress={() => setStatus(w.id, "waiting_parts")} /></View>}
              <View style={{ flex: 1 }}><Button title="Complete" onPress={() => setStatus(w.id, "completed")} /></View>
            </Row>
          </View>
        )) : <Txt muted>Nothing assigned to you.</Txt>}
      </Card>
    </Screen>
  );
}

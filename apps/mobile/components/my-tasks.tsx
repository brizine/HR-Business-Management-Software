import { router } from "expo-router";
import { Linking, Pressable, View } from "react-native";
import { WEB_URL, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Card, Divider, Row, Txt, useTheme } from "./ui";

interface Task {
  key: string;
  title: string;
  detail: string;
  badge?: string;
  /** What tapping it does; none for things handled further down this screen. */
  open?: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Me tab: what's waiting on you (same as "My Tasks" on the website's employee page): work orders,
 * your onboarding checklist, documents to sign, pay periods to approve and (managers) onboarding
 * steps waiting on you. `documents` is the list the Me tab already loaded.
 */
export function MyTasksCard({ documents }: { documents: any[] | null }) {
  const { me, can } = useAuth();
  const t = useTheme();
  const workOrders = useApi<any[]>("/work-orders?status=active&mine=true");
  const onboarding = useApi<any[]>("/onboarding/tasks?open=true");
  const waitingOnMe = useApi<any[]>(can("manager") ? "/onboarding/assigned" : null);
  const payPeriods = useApi<{ canApprove: boolean; periods: any[] }>("/pay-periods");

  const tasks: Task[] = [
    ...(workOrders.data ?? []).map(({ workOrder: w, assetName }) => ({
      key: `wo-${w.id}`, title: `${w.number ? `#${w.number} ` : ""}${w.title}`,
      detail: `Work order · ${assetName}${w.dueDate ? ` · due ${fmtDate(w.dueDate)}` : ""}`, badge: w.status, open: () => router.push("/tasks"),
    })),
    ...(onboarding.data ?? []).filter((x) => x.assignee === "employee").map((x) => ({
      key: `ob-${x.id}`, title: x.title, detail: `Onboarding${x.dueDate ? ` · due ${fmtDate(x.dueDate)}` : ""}`,
      badge: x.dueDate && x.dueDate < today() ? "overdue" : undefined, open: () => router.push("/tasks"),
    })),
    ...(documents ?? []).filter((d) => d.requiresSignature && !d.signedAt && d.employeeId === me?.user.id).map((d) => ({
      key: `doc-${d.id}`, title: `Sign ${d.name}`, detail: "Document · sign it below", badge: "pending",
    })),
    ...(payPeriods.data?.canApprove ? payPeriods.data.periods.filter((p) => p.status === "pending") : []).map((p) => ({
      key: `pay-${p.id}`, title: `Approve pay period ${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`,
      detail: `Payroll · payday ${fmtDate(p.payday)} · opens the website`, badge: "pending", open: () => Linking.openURL(`${WEB_URL}/pay-periods/${p.id}`),
    })),
    ...(waitingOnMe.data ?? []).map((x) => ({
      key: `obm-${x.id}`, title: `${x.title} (${x.employee.name})`, detail: `Onboarding${x.dueDate ? ` · due ${fmtDate(x.dueDate)}` : ""}`,
      badge: x.dueDate && x.dueDate < today() ? "overdue" : undefined, open: () => router.push("/tasks"),
    })),
  ];
  const loading = !workOrders.data || !onboarding.data;

  return (
    <Card title={`My Tasks${tasks.length ? ` · ${tasks.length} open` : ""}`}>
      {tasks.length ? tasks.map((task) => (
        <View key={task.key}>
          <Divider />
          <Pressable disabled={!task.open} onPress={task.open} accessibilityRole={task.open ? "button" : undefined}>
            <Row style={{ alignItems: "center", paddingVertical: 4 }}>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontWeight: "600", color: task.open ? t.primary : t.text }}>{task.title}</Txt>
                <Txt muted style={{ fontSize: 12 }}>{task.detail}</Txt>
              </View>
              {task.badge && <Badge value={task.badge} />}
            </Row>
          </Pressable>
        </View>
      )) : !loading ? <Txt muted>You're all caught up.</Txt> : null}
    </Card>
  );
}

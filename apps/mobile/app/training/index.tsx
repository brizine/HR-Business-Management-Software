import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { ENROLLMENT_STATUS_LABELS, type EnrollmentStatus } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Badge, Card, Divider, Row, Screen, Txt, useTheme } from "@/components/ui";

/** My training: assigned courses first, then the rest of the catalog. */
export default function TrainingList() {
  const t = useTheme();
  const { data, loading, reload } = useApi<any>("/training/courses");
  const courses: any[] = data?.courses ?? [];
  const mine = courses.filter((c) => c.enrollment);
  const others = courses.filter((c) => !c.enrollment && c.published && c.selfEnroll);
  const row = (c: any) => (
    <Pressable key={c.id} onPress={() => router.push(`/training/${c.id}`)} accessibilityRole="button">
      <View style={{ gap: 6, paddingVertical: 6 }}>
        <Divider />
        <Row>
          <View style={{ flex: 1 }}>
            <Txt style={{ fontWeight: "700" }}>{c.title}</Txt>
            <Txt muted>{c.lessons} lessons{c.enrollment?.dueDate && !c.enrollment.completedAt ? ` · due ${fmtDate(c.enrollment.dueDate)}` : ""}{c.enrollment?.expiresAt ? ` · good until ${fmtDate(c.enrollment.expiresAt)}` : ""}</Txt>
          </View>
          {c.enrollment && <Badge value={c.enrollment.status === "completed" ? "completed" : c.enrollment.status === "overdue" || c.enrollment.status === "expired" ? "overdue" : "pending"} />}
        </Row>
        {c.enrollment && (
          <View style={{ height: 6, borderRadius: 3, backgroundColor: t.border, overflow: "hidden" }}>
            <View style={{ width: `${c.enrollment.percent}%`, height: 6, backgroundColor: t.primary }} />
          </View>
        )}
        {c.enrollment && <Txt muted style={{ fontSize: 12 }}>{ENROLLMENT_STATUS_LABELS[c.enrollment.status as EnrollmentStatus]} · {c.enrollment.percent}%</Txt>}
      </View>
    </Pressable>
  );
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Card title="My training">{mine.length ? mine.map(row) : <Txt muted>Nothing assigned to you yet.</Txt>}</Card>
      {others.length > 0 && <Card title="Other courses you can take">{others.map(row)}</Card>}
    </Screen>
  );
}

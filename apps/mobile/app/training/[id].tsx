import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Button, Card, Divider, Row, Screen, Txt, useTheme } from "@/components/ui";

/** A course: description, progress and its lessons. */
export default function CourseScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: c, loading, reload } = useApi<any>(`/training/courses/${id}`);
  const [busy, setBusy] = useState(false);
  if (!c) return <Screen refreshing={loading} onRefresh={reload}><Txt muted>Loading…</Txt></Screen>;
  const e = c.enrollment;
  const done = (lid: string) => !!e?.progress?.find((p: any) => p.lessonId === lid && p.completedAt);
  const next = c.lessons.find((l: any) => !done(l.id)) ?? c.lessons[0];
  const enroll = async () => {
    setBusy(true);
    try { await api(`/training/courses/${id}/enroll`, { method: "POST" }); reload(); } catch (err) { Alert.alert("Couldn't sign up", (err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Card title={c.title}>
        {c.description && <Txt>{c.description}</Txt>}
        {e ? (
          <>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: t.border, overflow: "hidden" }}><View style={{ width: `${e.percent}%`, height: 8, backgroundColor: t.primary }} /></View>
            <Txt muted>{e.lessonsDone} of {e.lessonsTotal} lessons{e.completedAt ? ` · completed ${fmtDate(e.completedAt)}` : e.dueDate ? ` · due ${fmtDate(e.dueDate)}` : ""}{e.expiresAt ? ` · good until ${fmtDate(e.expiresAt)}` : ""}</Txt>
            {!e.completedAt && next && <Button title={e.lessonsDone ? "Continue" : "Start"} onPress={() => router.push(`/training/lesson/${next.id}?course=${id}`)} />}
          </>
        ) : c.selfEnroll ? <Button title="Sign up" busy={busy} onPress={enroll} /> : <Txt muted>Ask your manager to assign you this course.</Txt>}
      </Card>
      <Card title="Lessons">
        {c.lessons.map((l: any, i: number) => (
          <Pressable key={l.id} disabled={!e} onPress={() => router.push(`/training/lesson/${l.id}?course=${id}`)}>
            <View style={{ gap: 4 }}>
              {i > 0 && <Divider />}
              {l.chapter && (i === 0 || c.lessons[i - 1].chapter !== l.chapter) && <Txt muted style={{ fontSize: 11, fontWeight: "700" }}>{l.chapter.toUpperCase()}</Txt>}
              <Row>
                <Txt style={{ flex: 1, fontWeight: done(l.id) ? "400" : "600" }}>{done(l.id) ? "✓ " : ""}{l.title}</Txt>
                <Txt muted style={{ fontSize: 12 }}>{l.questions ? "quiz" : l.hasVideo ? "video" : ""}</Txt>
              </Row>
            </View>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}

import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, View } from "react-native";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Button, Card, Screen, Txt, useTheme } from "@/components/ui";
import { Markdown } from "@/components/markdown";

/** One lesson: text, a link to its video, and its quiz (graded by the server). */
export default function LessonScreen() {
  const t = useTheme();
  const { id, course } = useLocalSearchParams<{ id: string; course: string }>();
  const lesson = useApi<any>(`/training/lessons/${id}`);
  const outline = useApi<any>(course ? `/training/courses/${course}` : null);
  const [answers, setAnswers] = useState<number[][]>([]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAnswers([]); setResult(null); }, [id]);
  const l = lesson.data;
  if (!l) return <Screen refreshing={lesson.loading} onRefresh={lesson.reload}><Txt muted>Loading…</Txt></Screen>;
  const lessons: any[] = outline.data?.lessons ?? [];
  const next = lessons[lessons.findIndex((x) => x.id === l.id) + 1];
  const finished = !!l.progress?.completedAt || !!result?.passed;
  const go = () => (next ? router.replace(`/training/lesson/${next.id}?course=${course}`) : router.back());
  const pick = (q: number, o: number, multi: boolean) => {
    const cur = answers[q] ?? [];
    const copy = [...answers];
    copy[q] = multi ? (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]) : [o];
    setAnswers(copy);
  };
  const send = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { Alert.alert("Couldn't save", (e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Screen refreshing={lesson.loading} onRefresh={lesson.reload}>
      <Card title={l.title}>
        {l.videoUrl && <Button title="▶  Watch the video" kind="secondary" onPress={() => Linking.openURL(l.videoUrl)} />}
        {l.content?.trim() ? <Markdown text={l.content} /> : null}
      </Card>
      {l.quiz.length > 0 ? (
        <Card title="Quiz">
          <Txt muted>Score {l.passingScore}% or more to pass.</Txt>
          {l.quiz.map((q: any, qi: number) => (
            <View key={qi} style={{ gap: 6, borderWidth: 1, borderRadius: 8, padding: 10, borderColor: result ? (result.results[qi] ? "#16a34a" : t.bad) : t.border }}>
              <Txt style={{ fontWeight: "700" }}>{qi + 1}. {q.question}{q.kind === "multiple" ? " (pick all that apply)" : ""}</Txt>
              {q.options.map((o: string, oi: number) => {
                const on = (answers[qi] ?? []).includes(oi);
                return (
                  <Pressable key={oi} disabled={!!result?.passed} onPress={() => pick(qi, oi, q.kind === "multiple")} accessibilityRole={q.kind === "multiple" ? "checkbox" : "radio"} accessibilityState={{ checked: on }}
                    style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: on ? t.primary : t.border, backgroundColor: on ? t.primary : "transparent" }}>
                    <Txt style={{ color: on ? "#fff" : t.text }}>{o}</Txt>
                  </Pressable>
                );
              })}
              {result && <Txt muted>{result.results[qi] ? "✓ Right" : "✗ Not quite"}{result.explanations[qi] ? `: ${result.explanations[qi]}` : ""}</Txt>}
            </View>
          ))}
          {result && <Txt style={{ fontWeight: "700", color: result.passed ? "#15803d" : t.bad }}>{result.passed ? `Passed with ${result.score}%!` : `You scored ${result.score}%. You need ${result.passingScore}%.`}</Txt>}
          {!result?.passed && !l.preview && (
            <Button title={result ? "Try again" : "Submit answers"} busy={busy} onPress={() => send(async () => {
              const r = await api(`/training/lessons/${l.id}/quiz`, { body: { answers: l.quiz.map((_: unknown, i: number) => answers[i] ?? []) } });
              setResult(r);
              if (r.passed) { lesson.reload(); outline.reload(); }
            })} />
          )}
        </Card>
      ) : !finished && !l.preview ? (
        <Button title={next ? "Mark as done and continue" : "Mark as done"} busy={busy} onPress={() => send(async () => { await api(`/training/lessons/${l.id}/complete`, { method: "POST" }); outline.reload(); go(); })} />
      ) : null}
      {finished && <Button title={next ? "Next lesson" : "Back to the course"} onPress={go} />}
    </Screen>
  );
}

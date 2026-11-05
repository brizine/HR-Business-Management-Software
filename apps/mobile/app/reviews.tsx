import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { DISCIPLINE_REASON_LABELS, RATING_LABELS, recordTypeLabel, type RecordKind } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Divider, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

/** Reviews and disciplinary actions shared with you; acknowledge each one (managers write them on the website). */
export default function MyReviews() {
  const t = useTheme();
  const params = useLocalSearchParams<{ open?: string }>();
  const { me: user } = useAuth();
  // Managers get everyone's from the API; this screen is only about you.
  const { data, loading, reload } = useApi<any[]>(user ? `/reviews?employeeId=${user.user.id}` : null);
  const [open, setOpen] = useState<string | null>(params.open ?? null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const me = (data ?? []).filter((r) => r.employeeId === user?.user.id && r.status !== "draft");

  const acknowledge = async (id: string) => {
    setBusy(true);
    try {
      await api(`/reviews/${id}/acknowledge`, { body: { comment: comment.trim() || undefined } });
      setComment("");
      reload();
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const block = (label: string, value: string | null) => value ? (
    <View style={{ gap: 2 }}><Txt muted style={{ fontSize: 12, fontWeight: "600" }}>{label}</Txt><Txt>{value}</Txt></View>
  ) : null;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Txt muted style={{ fontSize: 13 }}>Reviews and disciplinary actions shared with you. Acknowledging confirms you&apos;ve read one; it doesn&apos;t mean you agree.</Txt>
      {me.length ? me.map((r) => (
        <Card key={r.id}>
          <Pressable onPress={() => setOpen(open === r.id ? null : r.id)} accessibilityRole="button">
            <Row>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontWeight: "700" }}>{recordTypeLabel(r.kind as RecordKind, r.type)}</Txt>
                <Txt muted>{fmtDate(r.date)}{r.authorName ? ` · ${r.authorName}` : ""}{r.rating ? ` · ${r.rating}/5` : ""}</Txt>
              </View>
              <Badge value={r.status === "shared" ? "pending" : "completed"} />
            </Row>
          </Pressable>
          {open === r.id && (
            <View style={{ gap: 10 }}>
              <Divider />
              {r.rating ? <Txt>Rating: {r.rating} of 5, {RATING_LABELS[r.rating]}</Txt> : null}
              {r.reason ? <Txt muted>{(DISCIPLINE_REASON_LABELS as Record<string, string>)[r.reason]}{r.incidentDate ? ` · ${fmtDate(r.incidentDate)}` : ""}</Txt> : null}
              {block(r.kind === "review" ? "Summary" : "What happened", r.summary)}
              {block("Strengths", r.strengths)}
              {block("Areas to improve", r.improvements)}
              {block("Goals", r.goals)}
              {block("Expectations and next steps", r.expectations)}
              {r.followUpDate ? <Txt muted>Follow-up: {fmtDate(r.followUpDate)}</Txt> : null}
              {r.status === "shared" ? (
                <View style={{ gap: 8 }}>
                  <Input label="Your comment (optional)" value={comment} onChangeText={setComment} multiline maxLength={5000} />
                  <Button title="I've read this" busy={busy} onPress={() => acknowledge(r.id)} />
                </View>
              ) : (
                <Txt style={{ color: t.text }}>Acknowledged {r.acknowledgedAt ? new Date(r.acknowledgedAt).toLocaleDateString() : ""}{r.employeeComment ? `. Your comment: "${r.employeeComment}"` : ""}</Txt>
              )}
            </View>
          )}
        </Card>
      )) : <Txt muted>Nothing has been shared with you yet.</Txt>}
    </Screen>
  );
}

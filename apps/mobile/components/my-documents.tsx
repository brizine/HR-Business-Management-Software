import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { openDocument } from "@/lib/documents";
import { Badge, Button, Card, Divider, Input, Row, Txt, useTheme } from "./ui";

type Doc = { id: string; name: string; category: string; createdAt: string; employeeId: string | null; requiresSignature: boolean; signedAt: string | null };

/**
 * Me tab: documents to sign (open it first, then sign) and every document of yours or the
 * company's, each opening on tap. Filters appear once the list is long.
 */
export function MyDocuments({ docs, onChange }: { docs: Doc[] | null; onChange: () => void }) {
  const { me } = useAuth();
  const t = useTheme();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [onlyToSign, setOnlyToSign] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const all = docs ?? [];
  const toSign = all.filter((d) => d.requiresSignature && !d.signedAt && d.employeeId === me?.user.id);

  const open = async (d: Doc) => {
    setBusy(d.id);
    try {
      await openDocument(d.id);
      setOpened((s) => new Set(s).add(d.id));
    } catch (e) {
      Alert.alert("Couldn't open it", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const sign = (d: Doc) => {
    const name = `${me!.user.firstName} ${me!.user.lastName}`;
    Alert.alert("Sign document", `Sign "${d.name}" as ${name}? Your typed name, the date and time are recorded as your signature.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign", onPress: () => api(`/documents/${d.id}/sign`, { body: { signedName: name } }).then(() => { Alert.alert("Signed", "Thank you!"); onChange(); }, (e) => Alert.alert("Couldn't sign", e.message)) },
    ]);
  };

  const long = all.length > 5;
  const query = q.trim().toLowerCase();
  const shown = all.filter((d) => (!query || `${d.name} ${d.category}`.toLowerCase().includes(query)) && (!onlyToSign || (d.requiresSignature && !d.signedAt)));

  return (
    <>
      {toSign.length > 0 && (
        <Card title="Needs your signature">
          {toSign.map((d) => (
            <View key={d.id} style={{ gap: 6 }}>
              <Divider />
              <Txt style={{ fontWeight: "600" }}>{d.name}</Txt>
              <Row>
                <View style={{ flex: 1 }}><Button title={opened.has(d.id) ? "Read again" : "1. Read it"} kind="secondary" busy={busy === d.id} onPress={() => open(d)} /></View>
                <View style={{ flex: 1 }}><Button title="2. Sign" kind="secondary" disabled={!opened.has(d.id)} onPress={() => sign(d)} /></View>
              </Row>
              {!opened.has(d.id) && <Txt muted style={{ fontSize: 12 }}>Open and read the document first; then you can sign it.</Txt>}
            </View>
          ))}
        </Card>
      )}
      <Card title="Documents">
        {long && (
          <View style={{ gap: 6 }}>
            <Input label="Search" value={q} onChangeText={setQ} placeholder="Name or category" autoCorrect={false} />
            <Pressable onPress={() => setOnlyToSign(!onlyToSign)} style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: onlyToSign ? t.primary : t.border, backgroundColor: onlyToSign ? t.primary : "transparent" }}>
              <Txt style={{ color: onlyToSign ? "#fff" : t.text }}>Needs a signature</Txt>
            </Pressable>
          </View>
        )}
        {shown.length ? shown.map((d) => (
          <Pressable key={d.id} onPress={() => open(d)} disabled={busy === d.id} accessibilityRole="button" accessibilityLabel={`Open ${d.name}`}>
            <Divider />
            <Row style={{ alignItems: "center", paddingVertical: 4 }}>
              <View style={{ flex: 1 }}>
                <Txt style={{ color: t.primary, fontWeight: "600" }}>{d.name}</Txt>
                <Txt muted style={{ fontSize: 12 }}>{d.category} · {fmtDate(d.createdAt)}{d.employeeId ? "" : " · Company-wide"}</Txt>
              </View>
              {d.requiresSignature && <Badge value={d.signedAt ? "completed" : "pending"} />}
            </Row>
          </Pressable>
        )) : <Txt muted>{all.length ? "No documents match." : "No documents."}</Txt>}
        {all.length > 0 && <Txt muted style={{ fontSize: 12 }}>Tap a document to open it.</Txt>}
      </Card>
    </>
  );
}

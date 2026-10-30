import { router } from "expo-router";
import { Alert, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Badge, Button, Card, Divider, Row, Screen, Txt } from "@/components/ui";

export default function Profile() {
  const { me, signOut } = useAuth();
  const docs = useApi<any[]>("/documents");
  const toSign = docs.data?.filter((d) => d.requiresSignature && !d.signedAt && d.employeeId === me?.user.id) ?? [];

  const sign = (doc: any) => {
    const name = `${me!.user.firstName} ${me!.user.lastName}`;
    Alert.alert("Sign document", `Sign "${doc.name}" as ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign", onPress: () => api(`/documents/${doc.id}/sign`, { body: { signedName: name } }).then(docs.reload, (e) => Alert.alert("Error", e.message)) },
    ]);
  };

  return (
    <Screen refreshing={docs.loading} onRefresh={docs.reload}>
      <Card>
        <Txt style={{ fontSize: 20, fontWeight: "700" }}>{me?.user.firstName} {me?.user.lastName}</Txt>
        <Txt muted>{me?.user.email}</Txt>
        <Txt muted>{me?.company.name} · {me?.user.role}</Txt>
      </Card>
      {toSign.length > 0 && (
        <Card title="Needs your signature">
          {toSign.map((d) => (
            <View key={d.id} style={{ gap: 6 }}>
              <Divider />
              <Txt>{d.name}</Txt>
              <Button title="Review & sign" onPress={() => sign(d)} />
            </View>
          ))}
        </Card>
      )}
      <Card title="Documents">
        {docs.data?.length ? docs.data.map((d) => (
          <View key={d.id}>
            <Divider />
            <Row>
              <View style={{ flex: 1 }}><Txt>{d.name}</Txt><Txt muted>{d.category} · {fmtDate(d.createdAt)}</Txt></View>
              {d.requiresSignature && <Badge value={d.signedAt ? "completed" : "pending"} />}
            </Row>
          </View>
        )) : <Txt muted>No documents.</Txt>}
      </Card>
      <Button title="📖  Company wiki" onPress={() => router.push("/wiki")} />
      <Button title="My info: address & emergency contact" kind="secondary" onPress={() => router.push("/my-info")} />
      <Button title="Notification settings" kind="secondary" onPress={() => router.push("/notification-settings")} />
      <Button title="Sign out" kind="secondary" onPress={signOut} />
      <Button title="Sign out on all devices" kind="danger" onPress={() =>
        Alert.alert("Sign out everywhere?", "Ends your Crewdesk sessions on every phone and computer, including this one. Use this if a device was lost.", [
          { text: "Cancel", style: "cancel" },
          { text: "Sign out everywhere", style: "destructive", onPress: () => api("/auth/logout-all", { method: "POST" }).then(signOut, signOut) },
        ])} />
      <Txt muted style={{ fontSize: 12, textAlign: "center" }}>Password and two-factor settings are under Settings → Security on the website.</Txt>
    </Screen>
  );
}

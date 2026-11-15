import { router } from "expo-router";
import { Alert, View } from "react-native";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { useMenuLabel } from "@/lib/menus";
import { Badge, Button, Card, Divider, Row, Screen, Txt } from "@/components/ui";
import { MyPhoto } from "@/components/avatar";
import { MyDocuments } from "@/components/my-documents";

export default function Profile() {
  const { me, signOut } = useAuth();
  const label = useMenuLabel();
  const docs = useApi<any[]>("/documents?mine=true");
  const mine = useApi<any>(me ? `/employees/${me.user.id}` : null);
  return (
    <Screen refreshing={docs.loading} onRefresh={docs.reload}>
      <Card>
        <Row style={{ justifyContent: "flex-start", gap: 14 }}>
          {mine.data && <MyPhoto e={mine.data} onChange={mine.reload} />}
          <View style={{ flex: 1 }}>
            <Txt style={{ fontSize: 20, fontWeight: "700" }}>{me?.user.firstName} {me?.user.lastName}</Txt>
            <Txt muted>{label("role", me?.user.role).replace(/^./, (c: string) => c.toUpperCase())}</Txt>
          </View>
        </Row>
      </Card>
      <Button title="My Info" kind="secondary" onPress={() => router.push("/my-info")} />
      <Button title="My Attendance" kind="secondary" onPress={() => router.push("/attendance")} />
      <Button title="My Reviews" kind="secondary" onPress={() => router.push("/reviews")} />
      <MyDocuments docs={docs.data} onChange={docs.reload} />
      <Button title="📖  Company Wiki" kind="secondary" onPress={() => router.push("/wiki")} />
      <Button title="🎓  Training" kind="secondary" onPress={() => router.push("/training")} />
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

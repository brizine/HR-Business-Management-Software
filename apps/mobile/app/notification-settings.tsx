import { useEffect, useState } from "react";
import { Alert, Pressable, Switch, View } from "react-native";
import { DELIVERY_MODES, NOTIFICATION_CATEGORY_INFO, type DeliveryMode, type NotificationPreference } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { Button, Card, Divider, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

const MODE_LABELS: Record<DeliveryMode, string> = { never: "Off", no_app: "No app", always: "Always" };

function Modes({ value, onChange, disabled }: { value: DeliveryMode; onChange: (m: DeliveryMode) => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: "flex-start", gap: 6, opacity: disabled ? 0.4 : 1 }}>
      {DELIVERY_MODES.map((m) => (
        <Pressable key={m} disabled={disabled} onPress={() => onChange(m)}
          style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, borderWidth: 1, borderColor: value === m ? t.primary : t.border, backgroundColor: value === m ? t.primary : "transparent" }}>
          <Txt style={{ fontSize: 13, color: value === m ? "#fff" : t.text }}>{MODE_LABELS[m]}</Txt>
        </Pressable>
      ))}
    </Row>
  );
}

export default function NotificationSettings() {
  const [data, setData] = useState<any>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api("/notifications/preferences").then((d) => { setData(d); setPhone(d.employee.phone ?? ""); });
  useEffect(() => { load(); }, []);

  const save = async (body: object) => {
    setBusy(true);
    try {
      setData(await api("/notifications/preferences", { method: "PUT", body }));
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Screen><Txt muted>Loading…</Txt></Screen>;
  const prefs: NotificationPreference[] = data.preferences;
  const update = (category: string, patch: Partial<NotificationPreference>) =>
    save({ preferences: prefs.map((p) => (p.category === category ? { ...p, ...patch } : p)) });

  return (
    <Screen>
      <Card title="Text messages">
        <Input label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="(512) 555-0100" />
        {phone !== (data.employee.phone ?? "") && (
          <Button title="Save number" kind="secondary" busy={busy} onPress={async () => {
            setBusy(true);
            try {
              await api("/employees/me/profile", { method: "PATCH", body: { phone } });
              await load();
            } finally {
              setBusy(false);
            }
          }} />
        )}
        <Row>
          <Txt style={{ flex: 1 }}>Text me Crewdesk notifications</Txt>
          <Switch value={data.employee.smsOptIn} disabled={busy || !data.employee.phoneTextable} onValueChange={(v) => save({ smsOptIn: v })} />
        </Row>
        <Txt muted style={{ fontSize: 12 }}>Message & data rates may apply. Reply STOP to any text to opt out.</Txt>
        {!data.channels.sms && <Txt muted style={{ fontSize: 12 }}>Texts are turned off for your company right now.</Txt>}
      </Card>

      {prefs.map((p) => {
        const info = NOTIFICATION_CATEGORY_INFO[p.category];
        return (
          <Card key={p.category}>
            <Row>
              <View style={{ flex: 1 }}>
                <Txt style={{ fontWeight: "700" }}>{info.label}</Txt>
                <Txt muted style={{ fontSize: 13 }}>{info.description}</Txt>
              </View>
              <Switch value={p.app} disabled={busy} onValueChange={(v) => update(p.category, { app: v })} />
            </Row>
            <Divider />
            <Txt muted style={{ fontSize: 13 }}>Email</Txt>
            <Modes value={p.email} onChange={(m) => update(p.category, { email: m })} disabled={busy} />
            <Txt muted style={{ fontSize: 13 }}>Text</Txt>
            <Modes value={p.sms} onChange={(m) => update(p.category, { sms: m })} disabled={busy || !data.employee.smsOptIn} />
          </Card>
        );
      })}
      <Txt muted style={{ fontSize: 12 }}>The switch controls app alerts for each type. "No app" sends email or text only if you sign out of the app on every phone.</Txt>
    </Screen>
  );
}

import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { EMPLOYEE_PRIVATE_CONTACT_FIELDS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, ErrorText, Input, Row, Screen, Txt } from "@/components/ui";

type Field = "phone" | (typeof EMPLOYEE_PRIVATE_CONTACT_FIELDS)[number];
const FIELDS: Field[] = ["phone", ...EMPLOYEE_PRIVATE_CONTACT_FIELDS];

/** Your phone, home address and emergency contact. Only managers and admins can see them. */
export default function MyInfo() {
  const { me } = useAuth();
  const [v, setV] = useState<Record<Field, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me) return;
    api(`/employees/${me.user.id}`).then(
      (e: any) => setV(Object.fromEntries(FIELDS.map((f) => [f, e[f] ?? ""])) as Record<Field, string>),
      (e) => setError(e.message),
    );
  }, [me]);

  if (!v) return <Screen><ErrorText error={error} /></Screen>;
  const field = (f: Field, label: string, props: object = {}) => (
    <Input label={label} value={v[f]} onChangeText={(text) => setV({ ...v, [f]: text })} {...props} />
  );
  const save = async () => {
    setBusy(true);
    try {
      await api("/employees/me/profile", { method: "PATCH", body: Object.fromEntries(FIELDS.map((f) => [f, v[f].trim() || null])) });
      Alert.alert("Saved", "Your info is up to date.");
      router.back();
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Txt muted style={{ fontSize: 13 }}>Only managers and admins can see this.</Txt>
      <Card>{field("phone", "Mobile phone", { keyboardType: "phone-pad", autoComplete: "tel" })}</Card>
      <Card title="Home address">
        {field("addressLine1", "Street address", { autoComplete: "street-address" })}
        {field("addressLine2", "Apt, suite, unit")}
        {field("city", "City")}
        <Row>
          <View style={{ flex: 1 }}>{field("state", "State", { autoCapitalize: "characters", maxLength: 2, placeholder: "TX" })}</View>
          <View style={{ flex: 2 }}>{field("zip", "ZIP", { keyboardType: "number-pad", maxLength: 10, autoComplete: "postal-code" })}</View>
        </Row>
      </Card>
      <Card title="Emergency contact">
        {field("emergencyName", "Name")}
        {field("emergencyRelationship", "Relationship", { placeholder: "e.g. Spouse, parent" })}
        {field("emergencyPhone", "Phone", { keyboardType: "phone-pad" })}
      </Card>
      <Button title="Save" busy={busy} onPress={save} />
    </Screen>
  );
}

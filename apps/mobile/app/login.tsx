import { useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { useAuth } from "@/lib/auth";
import { Button, Card, ErrorText, Input, Txt, useTheme } from "@/components/ui";

export default function Login() {
  const { signIn } = useAuth();
  const t = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "center", padding: 20, backgroundColor: t.bg }}>
      <View style={{ marginBottom: 20 }}>
        <Txt style={{ fontSize: 30, fontWeight: "800" }}>Crewdesk</Txt>
        <Txt muted>Clock in, request time off, and inspect equipment.</Txt>
      </View>
      <Card>
        <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={submit} />
        <ErrorText error={error} />
        <Button title="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />
      </Card>
    </KeyboardAvoidingView>
  );
}

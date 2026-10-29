import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Share, View } from "react-native";
import { WEB_URL, api } from "@/lib/api";
import { useAuth, type SignInStep } from "@/lib/auth";
import { Button, Card, ErrorText, Input, Txt, useTheme } from "@/components/ui";

/** Sign in, including the two-factor code step and first-time two-factor setup. */
export default function Login() {
  const { signIn, completeSignIn } = useAuth();
  const t = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<SignInStep>({ kind: "done" });
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [backup, setBackup] = useState<{ codes: string[]; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = () => attempt(async () => {
    const next = await signIn(email.trim(), password);
    setStep(next);
    if (next.kind === "setup") setSetup(await api("/auth/mfa/setup", { method: "POST", token: next.setupToken }));
  });

  const submitCode = () => attempt(async () => {
    if (step.kind !== "code") return;
    const res = await api("/auth/login/mfa", { body: { code: code.trim() }, token: step.mfaToken });
    await completeSignIn(res.token);
  }).finally(() => setCode(""));

  const confirmSetup = () => attempt(async () => {
    if (step.kind !== "setup") return;
    const res = await api("/auth/mfa/enable", { body: { code: code.trim() }, token: step.setupToken });
    setBackup({ codes: res.recoveryCodes, token: res.token });
  });

  let body;
  if (backup) {
    body = (
      <Card title="Save your backup codes">
        <Txt muted>If you lose your phone, each code lets you sign in once. Keep them somewhere safe (not only on this phone). They won&apos;t be shown again.</Txt>
        <Txt style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 16, lineHeight: 26 }}>{backup.codes.join("\n")}</Txt>
        <Button title="Share / save codes" kind="secondary" onPress={() => Share.share({ message: `Crewdesk backup codes (each works once)\n\n${backup.codes.join("\n")}` })} />
        <Button title="I've saved them, continue" onPress={() => attempt(() => completeSignIn(backup.token))} busy={busy} />
      </Card>
    );
  } else if (step.kind === "setup") {
    body = (
      <Card title="Set up two-factor sign-in">
        <Txt muted>Your company requires a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) for your role.</Txt>
        {setup && (
          <>
            <Button title="Add to authenticator app" kind="secondary" onPress={() => Linking.openURL(setup.otpauthUri).catch(() => setError("No authenticator app found. Install one, or enter the key below by hand."))} />
            <Txt muted>Or enter this key in the app:</Txt>
            <Txt style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", letterSpacing: 1 }} >{setup.secret.match(/.{1,4}/g)!.join(" ")}</Txt>
          </>
        )}
        <Input label="Then enter the 6-digit code it shows" value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} />
        <ErrorText error={error} />
        <Button title="Turn on two-factor" onPress={confirmSetup} busy={busy} disabled={code.length < 6} />
      </Card>
    );
  } else if (step.kind === "code") {
    body = (
      <Card title="Two-factor sign-in">
        <Txt muted>Enter the 6-digit code from your authenticator app, or one of your backup codes.</Txt>
        <Input label="Code" value={code} onChangeText={setCode} autoCapitalize="none" textContentType="oneTimeCode" autoFocus onSubmitEditing={submitCode} />
        <ErrorText error={error} />
        <Button title="Verify" onPress={submitCode} busy={busy} disabled={code.trim().length < 6} />
        <Txt muted style={{ fontSize: 12 }}>No phone and no backup codes? Ask your Crewdesk admin to reset your two-factor.</Txt>
      </Card>
    );
  } else {
    body = (
      <Card>
        <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={submitPassword} />
        <ErrorText error={error} />
        <Button title="Sign in" onPress={submitPassword} busy={busy} disabled={!email || !password} />
        <Pressable onPress={() => Linking.openURL(`${WEB_URL}/forgot-password`)}>
          <Txt style={{ color: t.primary, textAlign: "center" }}>Forgot your password?</Txt>
        </Pressable>
      </Card>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View>
          <Txt style={{ fontSize: 30, fontWeight: "800" }}>Crewdesk</Txt>
          <Txt muted>Clock in, request time off, and inspect equipment.</Txt>
        </View>
        {body}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type TextInputProps,
} from "react-native";

const light = { bg: "#f6f7f9", surface: "#fff", border: "#e3e6eb", text: "#1c2330", muted: "#667085", primary: "#1f6feb", ok: "#0f7b4b", okBg: "#e3f6ec", warn: "#9a6100", warnBg: "#fff3d6", bad: "#b42318", badBg: "#fde7e5" };
const dark = { bg: "#0d1117", surface: "#161b22", border: "#2b323c", text: "#e6edf3", muted: "#8b949e", primary: "#4c8dff", ok: "#4ad295", okBg: "#11301f", warn: "#f0b949", warnBg: "#3a2a07", bad: "#ff8a80", badBg: "#3d1210" };

export function useTheme() {
  return useColorScheme() === "dark" ? dark : light;
}

export function Screen({ children, refreshing, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const t = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }]}>
      {(title || right) && (
        <View style={styles.cardHead}>
          {title && <Txt style={{ fontWeight: "700", fontSize: 16 }}>{title}</Txt>}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Txt({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.muted : t.text, fontSize: 15 }, style]}>{children}</Text>;
}

export function Button({ title, onPress, kind = "primary", disabled, busy }: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; busy?: boolean }) {
  const t = useTheme();
  const bg = kind === "primary" ? t.primary : kind === "danger" ? t.bad : t.surface;
  const fg = kind === "secondary" ? t.text : "#fff";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: kind === "secondary" ? t.border : bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: "600", fontSize: 16 }}>{title}</Text>}
    </Pressable>
  );
}

export function Input({ label, ...props }: TextInputProps & { label: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Txt muted style={{ fontSize: 13 }}>{label}</Txt>
      <TextInput
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surface }]}
        {...props}
      />
    </View>
  );
}

const TONES: Record<string, "ok" | "warn" | "bad"> = {
  approved: "ok", completed: "ok", ok: "ok", active: "ok", passed: "ok",
  pending: "warn", due_soon: "warn", in_progress: "warn", in_shop: "warn", waiting_parts: "warn", medium: "warn", open: "warn",
  denied: "bad", overdue: "bad", out_of_service: "bad", critical: "bad", high: "bad", failed: "bad", cancelled: "bad",
};

export function Badge({ value }: { value: string }) {
  const t = useTheme();
  const tone = TONES[value];
  const bg = tone === "ok" ? t.okBg : tone === "warn" ? t.warnBg : tone === "bad" ? t.badBg : t.border;
  const fg = tone ? t[tone] : t.text;
  return (
    <View style={{ backgroundColor: bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, alignSelf: "flex-start" }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>{value.replace(/_/g, " ")}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, style]}>{children}</View>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  const t = useTheme();
  return error ? <Text style={{ color: t.bad }}>{error}</Text> : null;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: 4 }} />;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 },
  button: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
});

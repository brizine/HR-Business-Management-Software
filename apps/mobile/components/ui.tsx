import { useCallback, useContext, useEffect, useRef, type ComponentRef, type ReactNode } from "react";
import { useFocusEffect, useNavigation } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type TextInputProps,
  type TextProps,
} from "react-native";
import type { LabelMenu } from "@crewdesk/shared";
import { useMenuLabel } from "@/lib/menus";

const light = { stripe: "#fff3b0", bg: "#f6f7f9", surface: "#fff", border: "#e3e6eb", text: "#1c2330", muted: "#667085", primary: "#1f6feb", ok: "#0f7b4b", okBg: "#e3f6ec", warn: "#9a6100", warnBg: "#fff3d6", bad: "#b42318", badBg: "#fde7e5" };
const dark = { stripe: "#3d3510", bg: "#0d1117", surface: "#161b22", border: "#2b323c", text: "#e6edf3", muted: "#8b949e", primary: "#4c8dff", ok: "#4ad295", okBg: "#11301f", warn: "#f0b949", warnBg: "#3a2a07", bad: "#ff8a80", badBg: "#3d1210" };

export function useTheme() {
  return useColorScheme() === "dark" ? dark : light;
}

export function Screen({ children, refreshing, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const t = useTheme();
  // On iPhone, pages opened with a Back button sit under the floating top bar: start them below it.
  // Tab pages already start below their bar. (A fixed amount: iOS's automatic insets carried over
  // between pages when React Native reused a scroll view, leaving a gap on tab pages.)
  const inStack = useNavigation().getState()?.type === "stack";
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const top = Platform.OS === "ios" && inStack ? Math.round(headerHeight) : 0;

  // iOS quirk: after leaving a screen that has pull-to-refresh and coming back, the page can be left
  // resting slightly pulled down (a gap at the top). If it's below its top without the person
  // pulling or a refresh running, put it back.
  const ref = useRef<ComponentRef<typeof ScrollView>>(null);
  const dragging = useRef(false);
  const offset = useRef(0);
  // Just after a pull (bouncing back, or the refresh spinner settling) the page is legitimately below its top.
  const settleUntil = useRef(0);
  const snapBack = () => {
    if (!dragging.current && !refreshing && Date.now() > settleUntil.current && offset.current < -1) ref.current?.scrollTo({ y: 0, animated: false });
  };
  useEffect(() => { settleUntil.current = Date.now() + 1000; }, [refreshing]);
  useFocusEffect(useCallback(() => {
    const timer = setTimeout(snapBack, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshing]));

  return (
    <ScrollView
      ref={ref}
      scrollEventThrottle={32}
      onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y; if (Platform.OS === "ios") snapBack(); }}
      onScrollBeginDrag={() => { dragging.current = true; }}
      onScrollEndDrag={() => { dragging.current = false; settleUntil.current = Date.now() + 1000; }}
      onMomentumScrollEnd={() => { dragging.current = false; snapBack(); }}
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: 16 + top, gap: 12 }}
      scrollIndicatorInsets={top ? { top } : undefined}
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

export function Txt({ children, muted, style, ...rest }: { children: ReactNode; muted?: boolean; style?: object } & Omit<TextProps, "style" | "children">) {
  const t = useTheme();
  return <Text {...rest} style={[{ color: muted ? t.muted : t.text, fontSize: 15 }, style]}>{children}</Text>;
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

/** A status pill. With `menu`, it reads the way the owner worded that choice. */
export function Badge({ value, menu }: { value: string; menu?: LabelMenu }) {
  const t = useTheme();
  const label = useMenuLabel();
  const tone = TONES[value];
  const bg = tone === "ok" ? t.okBg : tone === "warn" ? t.warnBg : tone === "bad" ? t.badBg : t.border;
  const fg = tone ? t[tone] : t.text;
  return (
    <View style={{ backgroundColor: bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, alignSelf: "flex-start" }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: "600" }}>{menu ? label(menu, value) : value.replace(/_/g, " ")}</Text>
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

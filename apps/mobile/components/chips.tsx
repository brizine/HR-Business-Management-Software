import { Pressable } from "react-native";
import { Row, Txt, useTheme } from "./ui";

/**
 * A row of tappable choices, one selected (like a drop-down that shows every option). `light`:
 * all white, the chosen one outlined in blue (instead of filled blue).
 */
export function Chips<T extends string>({ options, value, onChange, label, light = false }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string; light?: boolean }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: o.value === value }} accessibilityLabel={`${label}: ${o.label}`}
          style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: light && o.value === value ? 2 : 1, borderColor: o.value === value ? t.primary : t.border,
            backgroundColor: light ? t.surface : o.value === value ? t.primary : "transparent" }}>
          <Txt style={{ color: o.value === value ? (light ? t.primary : "#fff") : t.text, fontSize: 14, fontWeight: light && o.value === value ? "700" : "400" }}>{o.label}</Txt>
        </Pressable>
      ))}
    </Row>
  );
}

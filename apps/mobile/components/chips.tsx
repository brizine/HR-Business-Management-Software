import { Pressable } from "react-native";
import { Row, Txt, useTheme } from "./ui";

/** A row of tappable choices, one selected (like a drop-down that shows every option). */
export function Chips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: o.value === value }} accessibilityLabel={`${label}: ${o.label}`}
          style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: o.value === value ? t.primary : t.border, backgroundColor: o.value === value ? t.primary : "transparent" }}>
          <Txt style={{ color: o.value === value ? "#fff" : t.text, fontSize: 14 }}>{o.label}</Txt>
        </Pressable>
      ))}
    </Row>
  );
}

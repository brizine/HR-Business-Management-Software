import { Linking, Platform, Text, View } from "react-native";
import { useTheme } from "./ui";

/**
 * A small renderer for wiki text: headings, paragraphs, bullet and numbered
 * lists, bold/italic/code, links, quotes, code blocks and tables (shown as
 * rows). Only http(s), mailto and tel links open.
 */
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;

function Inline({ text, style }: { text: string; style?: object }) {
  const t = useTheme();
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**") || tok.startsWith("__")) parts.push(<Text key={key++} style={{ fontWeight: "700" }}>{tok.slice(2, -2)}</Text>);
    else if (tok.startsWith("`")) parts.push(<Text key={key++} style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", backgroundColor: t.bg }}>{tok.slice(1, -1)}</Text>);
    else if (tok.startsWith("[")) {
      const [, label, url] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      parts.push(SAFE_LINK.test(url)
        ? <Text key={key++} style={{ color: t.primary, textDecorationLine: "underline" }} accessibilityRole="link" onPress={() => Linking.openURL(url)}>{label}</Text>
        : label);
    } else parts.push(<Text key={key++} style={{ fontStyle: "italic" }}>{tok.slice(1, -1)}</Text>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Text style={[{ color: t.text, fontSize: 16, lineHeight: 24 }, style]}>{parts}</Text>;
}

export function Markdown({ text }: { text: string }) {
  const t = useTheme();
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const size = [24, 20, 18, 17, 16, 16][heading[1].length - 1];
      blocks.push(<Text key={key++} accessibilityRole="header" style={{ color: t.text, fontSize: size, fontWeight: "700", marginTop: 8 }}>{heading[2]}</Text>);
      i++;
    } else if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<Text key={key++} style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", backgroundColor: t.bg, padding: 10, borderRadius: 8, color: t.text }}>{code.join("\n")}</Text>);
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const [, marker, rest] = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/)!;
        items.push({ marker: /\d/.test(marker) ? marker : "•", text: rest });
        i++;
      }
      blocks.push(
        <View key={key++} style={{ gap: 4 }}>
          {items.map((it, n) => (
            <View key={n} style={{ flexDirection: "row", gap: 8 }}>
              <Text style={{ color: t.text, fontSize: 16, lineHeight: 24, minWidth: 18 }}>{it.marker}</Text>
              <View style={{ flex: 1 }}><Inline text={it.text} /></View>
            </View>
          ))}
        </View>,
      );
    } else if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      blocks.push(
        <View key={key++} style={{ borderWidth: 1, borderColor: t.border, borderRadius: 8 }}>
          {rows.map((r, n) => (
            <View key={n} style={{ flexDirection: "row", borderTopWidth: n ? 1 : 0, borderColor: t.border }}>
              {r.map((c, k) => <View key={k} style={{ flex: 1, padding: 6 }}><Inline text={c} style={n === 0 ? { fontWeight: "700", fontSize: 14 } : { fontSize: 14 }} /></View>)}
            </View>
          ))}
        </View>,
      );
    } else if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<View key={key++} style={{ borderLeftWidth: 3, borderColor: t.border, paddingLeft: 10 }}><Inline text={quote.join(" ")} style={{ color: t.muted }} /></View>);
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|\||>)/.test(lines[i])) para.push(lines[i++]);
      blocks.push(<Inline key={key++} text={para.join(" ")} />);
    }
  }
  return <View style={{ gap: 12 }}>{blocks}</View>;
}

import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import * as Print from "expo-print";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import { MIX_UNITS, computeMix, formatAmount, formatEntered } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Button, Card, Divider, ErrorText, Input, Row, Screen, Txt, useTheme } from "@/components/ui";

const tankKey = (sheetId: string) => `spray-mix.tank.${sheetId}`;

function Chips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
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

/** Editors: one product's name, rate and unit. */
function ProductEditor({ product, onSaved }: { product: any; onSaved: () => void }) {
  const [name, setName] = useState(product.name);
  const [rate, setRate] = useState(String(product.ratePerAcre));
  const [unit, setUnit] = useState(product.unit);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/spray-mixes/products/${product.id}`, { method: "PATCH", body: { name, ratePerAcre: Number(rate), unit } });
      onSaved();
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <Input label="Product" value={name} onChangeText={setName} />
      <Input label={`Rate per acre (${unit})`} value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
      <Chips label="Measurement" value={unit} onChange={setUnit} options={[...new Set([...MIX_UNITS, product.unit])].map((u) => ({ value: u, label: u }))} />
      <Row>
        <View style={{ flex: 1 }}><Button title="Save" busy={busy} onPress={save} disabled={!name.trim() || !(Number(rate) >= 0) || rate.trim() === ""} /></View>
        <View style={{ flex: 1 }}><Button title="Remove" kind="secondary" disabled={busy} onPress={() =>
          Alert.alert("Remove product?", `Remove ${product.name} from this mix?`, [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => api(`/spray-mixes/products/${product.id}`, { method: "DELETE" }).then(onSaved, (e) => Alert.alert("Error", e.message)) },
          ])} /></View>
      </Row>
    </View>
  );
}

function SheetEditor({ sheet, onSaved }: { sheet: any; onSaved: () => void }) {
  const [gpa, setGpa] = useState(String(sheet.gallonsPerAcre));
  const [tank, setTank] = useState(String(sheet.defaultTankGallons));
  const [notes, setNotes] = useState(sheet.notes ?? "");
  const [newName, setNewName] = useState("");
  const [newRate, setNewRate] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onSaved();
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Mix settings">
      <Input label="Gallons of water per acre" value={gpa} onChangeText={setGpa} keyboardType="decimal-pad" />
      <Input label="Default tank (gallons)" value={tank} onChangeText={setTank} keyboardType="decimal-pad" />
      <Input label="Notes" value={notes} onChangeText={setNotes} />
      <Button title="Save mix settings" kind="secondary" busy={busy}
        onPress={() => run(() => api(`/spray-mixes/${sheet.id}`, { method: "PATCH", body: { gallonsPerAcre: Number(gpa), defaultTankGallons: Number(tank), notes } }))} />
      <Divider />
      <Txt style={{ fontWeight: "700" }}>Add a product</Txt>
      <Input label="Product" value={newName} onChangeText={setNewName} />
      <Input label="Rate per acre (ounces liquid)" value={newRate} onChangeText={setNewRate} keyboardType="decimal-pad" />
      <Button title="Add product" busy={busy} disabled={!newName.trim() || newRate.trim() === ""}
        onPress={() => run(async () => {
          await api(`/spray-mixes/${sheet.id}/products`, { body: { name: newName, ratePerAcre: Number(newRate), unit: "ounces liquid" } });
          setNewName("");
          setNewRate("");
        })} />
      <Txt muted style={{ fontSize: 12 }}>New products start as ounces liquid; tap the product to change the measurement.</Txt>
    </Card>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Just the ticked products, full screen: × closes, Print sends them to a printer (or a PDF). */
function SelectedWindow({ sheet, gallons, rows, acres, onClose }: { sheet: any; gallons: number; rows: any[]; acres: number; onClose: () => void }) {
  const t = useTheme();
  const print = () => {
    const html = `<html><head><meta name="viewport" content="width=device-width"><style>
      body{font-family:-apple-system,Roboto,sans-serif;padding:24px;color:#111}h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:#555}
      table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}tbody tr:nth-child(even){background:#fff3b0}
      td.n{font-weight:700;font-size:18px;white-space:nowrap}</style></head><body>
      <h1>${esc(sheet.name)}</h1><p>${esc(formatEntered(gallons))} gal tank · covers ${acres.toFixed(2)} acre · ${new Date().toLocaleDateString()}</p>
      <table><thead><tr><th>Product</th><th>Rate/Acre</th><th>Measurement</th><th>Product needed</th></tr></thead><tbody>
      ${rows.map(({ product: p, needed }) => `<tr><td>${esc(p.name)}</td><td>${esc(formatEntered(p.ratePerAcre))}</td><td>${esc(p.unit)}</td><td class="n">${esc(formatAmount(needed))} ${esc(p.unit.split(" ")[0])}</td></tr>`).join("")}
      </tbody></table></body></html>`;
    Print.printAsync({ html }).catch((e) => Alert.alert("Couldn't print", (e as Error).message));
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 54 }}>
        <Row style={{ paddingHorizontal: 16, alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <Txt style={{ fontSize: 20, fontWeight: "700" }}>{sheet.name}</Txt>
            <Txt muted style={{ fontSize: 13 }}>{formatEntered(gallons)} gal tank · covers {acres.toFixed(2)} acre</Txt>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12} style={{ padding: 4 }}>
            <Txt style={{ fontSize: 30, lineHeight: 32, color: t.muted }}>×</Txt>
          </Pressable>
        </Row>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
          <Card>
            {rows.map(({ product: p, needed }, i) => (
              <View key={p.id} style={{ backgroundColor: i % 2 ? t.stripe : "transparent", marginHorizontal: -14, paddingHorizontal: 14, paddingBottom: 6 }}>
                <Divider />
                <Row style={{ alignItems: "flex-start" }}>
                  <View style={{ flex: 1 }}>
                    <Txt style={{ fontWeight: "600" }}>{p.name}</Txt>
                    <Txt muted style={{ fontSize: 12 }}>{formatEntered(p.ratePerAcre)}/acre</Txt>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Txt style={{ fontSize: 22, fontWeight: "800" }}>{formatAmount(needed)}</Txt>
                    <Txt muted style={{ fontSize: 12 }}>{p.unit}</Txt>
                  </View>
                </Row>
              </View>
            ))}
          </Card>
          <Button title="Print" onPress={print} />
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Spray Mix Calculator: everyone calculates their tank; chosen editors can change products and rates. */
export default function SprayMix() {
  const t = useTheme();
  const { data, loading, reload, error } = useApi("/spray-mixes");
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [applied, setApplied] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showing, setShowing] = useState(false);
  const changes = useApi<any[]>(editing && sheetId ? `/spray-mixes/${sheetId}/changes` : null);

  const sheet = data?.sheets.find((s: any) => s.id === sheetId) ?? data?.sheets[0];

  useEffect(() => {
    if (!sheet) return;
    setSheetId(sheet.id);
    SecureStore.getItemAsync(tankKey(sheet.id))
      .then((v) => Number(v) > 0 ? Number(v) : sheet.defaultTankGallons)
      .catch(() => sheet.defaultTankGallons)
      .then((start) => {
        setInput(String(start));
        setApplied(start);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet?.id, sheet?.defaultTankGallons]);

  if (!data) return <Screen><ErrorText error={error} /></Screen>;
  if (!sheet) {
    return (
      <Screen>
        <Card title="Spray Mix Calculator">
          <Txt muted>No mix sheets yet. {data.canEdit ? "Set them up on the website (Spray Mix Calculator)." : "Ask an admin to set them up."}</Txt>
        </Card>
      </Screen>
    );
  }

  const value = Number(input);
  const valid = input.trim() !== "" && value > 0 && value <= 100_000;
  const pending = valid && value !== applied;
  const mix = computeMix(sheet, applied);
  const update = () => {
    if (!valid) return;
    setApplied(value);
    SecureStore.setItemAsync(tankKey(sheet.id), String(value)).catch(() => {});
  };

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Chips label="Mix" value={sheet.id} onChange={(id) => { setSheetId(id); setEditingProduct(null); setPicked(new Set()); }} options={data.sheets.map((s: any) => ({ value: s.id, label: s.name }))} />
      {/* Editors tap this line to change gallons per acre, the default tank and notes. */}
      <Pressable disabled={!data.canEdit} onPress={() => setEditing(!editing)} accessibilityRole={data.canEdit ? "button" : undefined}
        accessibilityHint={data.canEdit ? "Change gallons per acre, default tank and notes" : undefined}>
        <Txt muted style={{ fontSize: 13 }}>
          {formatEntered(sheet.gallonsPerAcre)} gal/acre · {formatAmount(mix.gallonsPer1000)} gal/1000 ft² · default tank {formatEntered(sheet.defaultTankGallons)} gal{sheet.notes ? ` · ${sheet.notes}` : ""}{data.canEdit ? "  ✎" : ""}
        </Txt>
      </Pressable>
      <Card>
        <Input label="Tank mix in desired gallons" value={input} onChangeText={setInput} keyboardType="decimal-pad" returnKeyType="done" onSubmitEditing={update} />
        <Button title="Update total" kind={pending ? "primary" : "secondary"} onPress={update} disabled={!valid} />
        <Txt muted accessibilityLiveRegion="polite">
          {!valid ? "Enter the gallons of water you're mixing." : pending ? "Tap Update total to recalculate." : `${formatEntered(applied)} gal covers ${mix.acres.toFixed(2)} acre (${Math.round(mix.squareFeet).toLocaleString()} ft²).`}
        </Txt>
      </Card>
      <Row style={{ justifyContent: "flex-start", gap: 8 }}>
        <Txt muted style={{ flex: 1, fontSize: 13 }}>{picked.size ? `${picked.size} selected` : "Tick products to show just those."}</Txt>
        {picked.size > 0 && <Button title={`Show selected (${picked.size})`} onPress={() => setShowing(true)} />}
        {picked.size > 0 && <Button title="Clear" kind="secondary" onPress={() => setPicked(new Set())} />}
      </Row>
      {showing && (
        <SelectedWindow sheet={sheet} gallons={applied} acres={mix.acres} rows={mix.rows.filter((r) => picked.has(r.product.id as string))} onClose={() => setShowing(false)} />
      )}
      <Card title={`Product needed for ${formatEntered(applied)} gal`}>
        {data.canEdit && <Txt muted style={{ fontSize: 12 }}>Tap a product to change its name, rate or measurement.</Txt>}
        {mix.rows.map(({ product: p, ratePer1000, needed }, i) => (
          // Every other product in yellow, so the eye can follow a row across.
          <View key={p.id} style={{ gap: 4, backgroundColor: i % 2 ? t.stripe : "transparent", marginHorizontal: -14, paddingHorizontal: 14, paddingBottom: 6 }}>
            <Divider />
            {/* Editors tap a product to change it right here. */}
            <Row style={{ alignItems: "flex-start", gap: 10 }}>
            {/* Tick to include this product in "Show selected". */}
            <Pressable onPress={() => setPicked((s) => { const n = new Set(s); if (n.has(p.id!)) n.delete(p.id!); else n.add(p.id!); return n; })}
              accessibilityRole="checkbox" accessibilityState={{ checked: picked.has(p.id!) }} accessibilityLabel={`Select ${p.name}`} hitSlop={10}
              style={{ width: 24, height: 24, marginTop: 2, borderRadius: 5, borderWidth: 2, borderColor: picked.has(p.id!) ? t.primary : t.muted, backgroundColor: picked.has(p.id!) ? t.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
              {picked.has(p.id!) && <Txt style={{ color: "#fff", fontWeight: "800", fontSize: 14, lineHeight: 16 }}>✓</Txt>}
            </Pressable>
            <Pressable style={{ flex: 1 }} disabled={!data.canEdit} onPress={() => setEditingProduct(editingProduct === p.id ? null : p.id ?? null)}
              accessibilityRole={data.canEdit ? "button" : undefined} accessibilityHint={data.canEdit ? "Change this product's name, rate or measurement" : undefined}>
              <Row style={{ alignItems: "flex-start" }}>
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: "600" }}>{p.name}{data.canEdit ? <Txt muted style={{ fontSize: 12 }}>  ✎</Txt> : null}</Txt>
                  <Txt muted style={{ fontSize: 12 }}>{formatEntered(p.ratePerAcre)}/acre · {formatAmount(ratePer1000)}/1000 ft²</Txt>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Txt style={{ fontSize: 22, fontWeight: "800" }}>{formatAmount(needed)}</Txt>
                  <Txt muted style={{ fontSize: 12 }}>{p.unit}</Txt>
                </View>
              </Row>
            </Pressable>
            </Row>
            {data.canEdit && editingProduct === p.id && (
              <ProductEditor key={`${p.id}-${p.name}-${p.ratePerAcre}-${p.unit}`} product={p} onSaved={() => { setEditingProduct(null); reload(); changes.reload(); }} />
            )}
          </View>
        ))}
      </Card>
      {data.canEdit && <Button title={editing ? "Close mix settings" : "Mix settings, add a product & history"} kind="secondary" onPress={() => { setEditing(!editing); setEditingProduct(null); }} />}
      {editing && <SheetEditor key={sheet.id} sheet={sheet} onSaved={() => { reload(); changes.reload(); }} />}
      {editing && !!changes.data?.length && (
        <Card title="Change history">
          {changes.data.slice(0, 20).map((c, i) => (
            <View key={i}>
              <Divider />
              <Txt style={{ fontSize: 14 }}>{c.summary}</Txt>
              <Txt muted style={{ fontSize: 12 }}>{c.by} · {fmtDate(c.at)}</Txt>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

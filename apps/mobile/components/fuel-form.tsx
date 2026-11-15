import { useState } from "react";
import { Alert, Pressable, Switch, View } from "react-native";
import { FUEL_TYPES, FUEL_TYPE_LABELS, fuelUnit, type FuelType } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { pickFile } from "./onboarding-task";
import { Button, Card, Input, Row, Txt, useTheme } from "./ui";

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Log a fill-up from the pump: fuel, amount, total, odometer/hours, and a receipt photo. */
export function FuelForm({ asset, onDone, onCancel }: { asset: { id: string; odometer: number; engineHours: number }; onDone: () => void; onCancel: () => void }) {
  const t = useTheme();
  const [type, setType] = useState<FuelType>("gasoline");
  const [qty, setQty] = useState("");
  const [total, setTotal] = useState("");
  const [odometer, setOdometer] = useState("");
  const [hours, setHours] = useState("");
  const [vendor, setVendor] = useState("");
  const [full, setFull] = useState(true);
  const [receipt, setReceipt] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const unit = fuelUnit(type);
  const price = qty && total && Number(qty) > 0 ? (Number(total) / Number(qty)).toFixed(3) : null;

  const save = async () => {
    setBusy(true);
    try {
      const entry = await api("/fuel", { body: {
        assetId: asset.id, date: today(), fuelType: type, quantity: Number(qty), totalCostCents: Math.round(Number(total) * 100),
        odometer: odometer ? Number(odometer) : null, hours: hours ? Number(hours) : null, fullTank: full, vendor: vendor || undefined,
      } });
      if (receipt) {
        const fd = new FormData();
        fd.append("file", receipt as unknown as Blob);
        await api(`/fuel/${entry.id}/receipt`, { body: fd });
      }
      Alert.alert("Saved", "Fill-up logged.");
      onDone();
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Log fuel">
      <Row style={{ justifyContent: "flex-start", flexWrap: "wrap", gap: 6 }}>
        {FUEL_TYPES.map((f) => (
          <Pressable key={f} onPress={() => setType(f)}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: type === f ? t.primary : t.border, backgroundColor: type === f ? t.primary : "transparent" }}>
            <Txt style={{ color: type === f ? "#fff" : t.text }}>{FUEL_TYPE_LABELS[f]}</Txt>
          </Pressable>
        ))}
      </Row>
      <Row>
        <View style={{ flex: 1 }}><Input label={unit === "GGE" ? "Amount (GGE)" : "Gallons"} value={qty} onChangeText={setQty} keyboardType="decimal-pad" /></View>
        <View style={{ flex: 1 }}><Input label="Total $" value={total} onChangeText={setTotal} keyboardType="decimal-pad" /></View>
      </Row>
      {price && <Txt muted>${price} per {unit}</Txt>}
      <Row>
        <View style={{ flex: 1 }}><Input label="Odometer" value={odometer} onChangeText={setOdometer} keyboardType="number-pad" placeholder={asset.odometer ? String(asset.odometer) : ""} /></View>
        <View style={{ flex: 1 }}><Input label="Engine hours" value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder={asset.engineHours ? String(asset.engineHours) : ""} /></View>
      </Row>
      <Input label="Station" value={vendor} onChangeText={setVendor} />
      <Row><Txt>Filled to full</Txt><Switch value={full} onValueChange={setFull} /></Row>
      {type === "cng" && <Txt muted>Enter the GGE shown on the CNG pump.</Txt>}
      <Row>
        <View style={{ flex: 1 }}><Button title={receipt ? "Retake receipt" : "Photo of receipt"} kind="secondary" onPress={async () => setReceipt((await pickFile("camera")) ?? receipt)} /></View>
        {receipt && <Txt muted>✓ Receipt added</Txt>}
      </Row>
      <Button title="Save fill-up" onPress={save} busy={busy} disabled={!qty || !total} />
      <Button title="Cancel" kind="secondary" onPress={onCancel} />
    </Card>
  );
}

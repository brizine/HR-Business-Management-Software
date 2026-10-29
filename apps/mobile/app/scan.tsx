import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { api } from "@/lib/api";
import { codeFromScan } from "@crewdesk/shared";
import { Button, Card, Input, Screen, Txt } from "@/components/ui";

/** Point the camera at an equipment QR label to jump straight to that asset. */
export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const busy = useRef(false);

  const open = async (code: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const asset = await api<{ id: string }>(`/assets/by-code/${encodeURIComponent(code)}`);
      router.replace(`/asset/${asset.id}`);
    } catch (e) {
      Alert.alert("Label not recognized", (e as Error).message, [{ text: "OK", onPress: () => (busy.current = false) }]);
    }
  };

  const onScan = ({ data }: { data: string }) => {
    const code = codeFromScan(data);
    if (code) open(code);
  };

  if (!permission) return <Screen><Txt muted>Loading camera…</Txt></Screen>;
  if (!permission.granted) {
    return (
      <Screen>
        <Card title="Camera access">
          <Txt>Crewdesk uses the camera only to read QR labels on vehicles and equipment.</Txt>
          <Button title="Allow camera" onPress={requestPermission} />
        </Card>
        <ManualEntry value={manual} onChange={setManual} onSubmit={() => open(manual)} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.frame} />
        <Txt style={styles.hint}>Point at the QR label on the equipment</Txt>
      </View>
      <View style={styles.bottom}>
        <ManualEntry value={manual} onChange={setManual} onSubmit={() => open(manual)} />
      </View>
    </View>
  );
}

function ManualEntry({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  return (
    <Card title="Label damaged?">
      <Input label="Type the code printed under the QR" value={value} onChangeText={onChange} autoCapitalize="characters" autoCorrect={false} placeholder="ET2W42AUDZ" />
      <Button title="Find equipment" kind="secondary" onPress={onSubmit} disabled={value.trim().length < 6} />
    </Card>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 16 },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: "#fff", borderRadius: 18 },
  hint: { color: "#fff", fontWeight: "600" },
  bottom: { position: "absolute", left: 16, right: 16, bottom: 32 },
});

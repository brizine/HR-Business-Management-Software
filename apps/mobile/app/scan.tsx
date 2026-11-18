import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useRef, useState, type ComponentRef } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { api } from "@/lib/api";
import { codeFromScan } from "@crewdesk/shared";
import { Button, Card, Input, Screen, Txt } from "@/components/ui";

/** Point the camera at an equipment QR label to jump straight to that asset. */
export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const busy = useRef(false);
  // On newer iPhones the top bar can float over the screen: push the content below it.
  const headerHeight = useHeaderHeight();
  const [top, setTop] = useState(0);
  const root = useRef<ComponentRef<typeof View>>(null);
  const measure = () => root.current?.measureInWindow((_x: number, y: number) => setTop(headerHeight > 0 && y < 2 ? Math.round(headerHeight) : 0));

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

  if (!permission) return <View ref={root} onLayout={measure} style={{ flex: 1, paddingTop: top }}><Screen><Txt muted>Loading camera…</Txt></Screen></View>;
  if (!permission.granted) {
    return (
      <View ref={root} onLayout={measure} style={{ flex: 1, paddingTop: top }}>
        <Screen>
          <Card title="Camera access">
            <Txt>Crewdesk uses the camera only to read QR labels on vehicles and equipment.</Txt>
            <Button title="Allow camera" onPress={requestPermission} />
          </Card>
          <ManualEntry value={manual} onChange={setManual} onSubmit={() => open(manual)} />
        </Screen>
      </View>
    );
  }

  return (
    <View ref={root} onLayout={measure} style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
      {/* Centered in the part of the screen below the top bar, above the manual-entry card. */}
      <View pointerEvents="none" style={[styles.overlay, { top, bottom: 260 }]}>
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
  overlay: { position: "absolute", left: 0, right: 0, alignItems: "center", justifyContent: "center", gap: 16 },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: "#fff", borderRadius: 18 },
  hint: { color: "#fff", fontWeight: "600", textShadowColor: "#000", textShadowRadius: 4 },
  bottom: { position: "absolute", left: 16, right: 16, bottom: 32 },
});

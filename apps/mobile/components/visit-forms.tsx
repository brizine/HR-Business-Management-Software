import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, PanResponder, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { isSigned, signatureStrokes, type FormAnswers, type FormDef, type FormSignature } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { Button, Divider, ErrorText, Input, Row, Txt, useTheme } from "./ui";

/**
 * Visit forms on the crew's work orders (Marketing → Visit Forms on the web): the forms on a work
 * order with whether each has been submitted; tap one to fill it in, sign it and submit it.
 */

export interface WorkOrderForm { id: string; name: string; submitted: boolean; submittedAt: string | null; submittedBy: string | null }
interface Entry extends WorkOrderForm { def: FormDef; answers: FormAnswers; signature: FormSignature | null; canFill: boolean }

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The work order's forms, listed under it. */
export function VisitFormLines({ visitId, forms, onChanged }: { visitId: string; forms?: WorkOrderForm[]; onChanged: () => void }) {
  const t = useTheme();
  const [open, setOpen] = useState<WorkOrderForm | null>(null);
  if (!forms?.length) return null;
  return (
    <View style={{ gap: 4 }}>
      <Txt muted style={{ fontSize: 13 }}>Visit forms</Txt>
      {forms.map((f) => (
        <Pressable key={f.id} onPress={() => setOpen(f)} accessibilityRole="button" accessibilityLabel={`${f.name}, ${f.submitted ? "submitted" : "not submitted"}`}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: t.surface, opacity: pressed ? 0.7 : 1 })}>
          <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: f.submitted ? t.okBg : "transparent", borderWidth: f.submitted ? 0 : 2, borderColor: t.muted, borderStyle: "dotted" }}>
            {f.submitted ? <Txt style={{ color: t.ok, fontSize: 13, fontWeight: "700" }}>✓</Txt> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Txt style={{ fontWeight: "600" }}>{f.name}</Txt>
            <Txt muted style={{ fontSize: 12 }}>{f.submitted ? `Submitted${f.submittedBy ? ` by ${f.submittedBy}` : ""}${f.submittedAt ? ` · ${when(f.submittedAt)}` : ""}` : "Not submitted"}</Txt>
          </View>
          <Txt muted>›</Txt>
        </Pressable>
      ))}
      {open ? <FormFill visitId={visitId} entryId={open.id} title={open.name} onClose={() => setOpen(null)} onSaved={onChanged} /> : null}
    </View>
  );
}

/* ───────────── The signature box ───────────── */

type Pt = { x: number; y: number };
const n1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Sign with a finger. The strokes are kept in the size of the box they were first drawn in (which
 * may have been a computer's), so here they're fitted to this box, and new ones are added in the
 * same measure. Drawn as short straight pieces (the app has no drawing canvas).
 */
function SignaturePad({ value, onChange, disabled, onSigning }: { value: FormSignature | null; onChange: (s: FormSignature | null) => void; disabled?: boolean; onSigning: (on: boolean) => void }) {
  const t = useTheme();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const latest = useRef({ value, box });
  latest.current = { value, box };
  /** How the kept signature sits in this box: its scale, and where it starts. */
  const fit = (v: FormSignature | null, b: { w: number; h: number }) => {
    if (!v || !b.w) return { k: 1, dx: 0, dy: 0 };
    const k = Math.min(b.w / v.w, b.h / v.h);
    return { k, dx: (b.w - v.w * k) / 2, dy: (b.h - v.h * k) / 2 };
  };
  const add = (x: number, y: number, start: boolean) => {
    const { value: v, box: b } = latest.current;
    if (!b.w) return;
    const base = v ?? { w: Math.round(b.w), h: Math.round(b.h), d: "" };
    const f = fit(base, b);
    const px = n1((x - f.dx) / f.k), py = n1((y - f.dy) / f.k);
    // A tap leaves a dot.
    onChange({ ...base, d: start ? `${base.d ? `${base.d} ` : ""}M${px} ${py} L${n1(px + 0.6)} ${n1(py + 0.6)}` : `${base.d} L${px} ${py}` });
  };
  const disabledRef = useRef(!!disabled);
  disabledRef.current = !!disabled;
  const onSigningRef = useRef(onSigning);
  onSigningRef.current = onSigning;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !disabledRef.current,
    onMoveShouldSetPanResponder: () => !disabledRef.current,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { onSigningRef.current(true); add(e.nativeEvent.locationX, e.nativeEvent.locationY, true); },
    onPanResponderMove: (e) => add(e.nativeEvent.locationX, e.nativeEvent.locationY, false),
    onPanResponderRelease: () => onSigningRef.current(false),
    onPanResponderTerminate: () => onSigningRef.current(false),
  })).current;

  const pieces = useMemo(() => {
    if (!value?.d || !box.w) return [];
    const f = fit(value, box);
    const out: { left: number; top: number; width: number; angle: number }[] = [];
    for (const stroke of signatureStrokes(value.d)) {
      for (let i = 1; i < stroke.length; i++) {
        const a: Pt = { x: stroke[i - 1].x * f.k + f.dx, y: stroke[i - 1].y * f.k + f.dy }, b: Pt = { x: stroke[i].x * f.k + f.dx, y: stroke[i].y * f.k + f.dy };
        const len = Math.max(2.4, Math.hypot(b.x - a.x, b.y - a.y) + 1.2);
        out.push({ left: (a.x + b.x) / 2 - len / 2, top: (a.y + b.y) / 2 - 1.2, width: len, angle: Math.atan2(b.y - a.y, b.x - a.x) });
      }
    }
    return out;
  }, [value, box]);

  return (
    <View style={{ gap: 4 }}>
      {/* The box is white in both themes, like paper; the ink is dark. */}
      <View onLayout={(e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} {...pan.panHandlers}
        accessibilityLabel={isSigned(value) ? "Signature: signed" : "Signature: sign here with your finger"}
        style={{ height: 170, borderWidth: 1, borderStyle: "dashed", borderColor: t.border, borderRadius: 10, backgroundColor: "#fff", overflow: "hidden" }}>
        <View pointerEvents="none" style={{ flex: 1 }}>
          {pieces.map((p, i) => <View key={i} style={{ position: "absolute", left: p.left, top: p.top, width: p.width, height: 2.4, borderRadius: 1.2, backgroundColor: "#111", transform: [{ rotate: `${p.angle}rad` }] }} />)}
          {!isSigned(value) && !disabled ? <Txt style={{ position: "absolute", left: 12, bottom: 8, color: "#98a2b3", fontSize: 13 }}>Sign here</Txt> : null}
        </View>
      </View>
      {!disabled ? (
        <Pressable onPress={() => onChange(null)} disabled={!isSigned(value)} style={{ alignSelf: "flex-end", paddingVertical: 4, paddingHorizontal: 8 }} accessibilityRole="button">
          <Txt style={{ color: isSigned(value) ? t.primary : t.muted, fontWeight: "600" }}>Clear</Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ───────────── Filling one in ───────────── */

function FormFill({ visitId, entryId, title, onClose, onSaved }: { visitId: string; entryId: string; title: string; onClose: () => void; onSaved: () => void }) {
  const t = useTheme();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [signature, setSignature] = useState<FormSignature | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [changed, setChanged] = useState(false);
  const take = (e: Entry) => { setEntry(e); setAnswers(e.answers ?? {}); setSignature(e.signature ?? null); setChanged(false); };
  useEffect(() => { api<Entry>(`/visits/${visitId}/forms/${entryId}`).then(take, (e: Error) => setError(e.message)); }, [visitId, entryId]);
  const set = (id: string, v: string | string[]) => { setAnswers((a) => ({ ...a, [id]: v })); setChanged(true); };
  const off = !entry?.canFill;
  const submit = async () => {
    if (!entry) return;
    setBusy(true); setError(null);
    try {
      const was = entry.submitted;
      take(await api<Entry>(`/visits/${visitId}/forms/${entryId}`, { method: "PUT", body: { answers, signature } }));
      onSaved();
      Alert.alert(was ? "Form updated" : "Form submitted");
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const close = () => {
    if (changed && entry?.canFill) Alert.alert("Leave without saving?", "What you changed on this form hasn't been submitted.", [{ text: "Keep filling in", style: "cancel" }, { text: "Leave", style: "destructive", onPress: onClose }]);
    else onClose();
  };
  return (
    <Modal visible animationType="slide" onRequestClose={close} presentationStyle="fullScreen">
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <Row style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface }}>
          <Txt style={{ fontWeight: "700", fontSize: 17, flex: 1 }} numberOfLines={2}>{title}</Txt>
          <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}><Txt style={{ color: t.primary, fontWeight: "600" }}>Close</Txt></Pressable>
        </Row>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled" scrollEnabled={!signing}>
          <ErrorText error={error} />
          {!entry && !error ? <Txt muted>Loading…</Txt> : null}
          {entry?.submitted && entry.submittedAt ? <Txt muted style={{ fontSize: 13 }}>Submitted{entry.submittedBy ? ` by ${entry.submittedBy}` : ""} · {when(entry.submittedAt)}</Txt> : null}
          {entry?.def.sections.map((s) => (
            <View key={s.id} style={{ gap: 12 }}>
              {s.name ? <Txt style={{ fontWeight: "700", fontSize: 17 }}>{s.name}</Txt> : null}
              {s.fields.map((f) => {
                const a = answers[f.id];
                if (f.type === "text" || f.type === "textarea") {
                  // A long answer gets a taller box (its own style; a short one keeps the usual input).
                  const long = f.type === "textarea" ? { multiline: true, maxLength: 10_000, style: { minHeight: 110, textAlignVertical: "top" as const, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 16, color: t.text, borderColor: t.border, backgroundColor: t.surface } } : { maxLength: 500 };
                  return <Input key={f.id} label={f.label} value={typeof a === "string" ? a : ""} editable={!off} onChangeText={(text) => set(f.id, text)} {...long} />;
                }
                const ticked = Array.isArray(a) ? a : [];
                return (
                  <View key={f.id} style={{ gap: 6 }}>
                    <Txt muted style={{ fontSize: 13 }}>{f.label}{f.type === "dropdown" ? " (pick one)" : ""}</Txt>
                    {f.options.map((o) => {
                      const on = f.type === "checkbox" ? ticked.includes(o.id) : a === o.id;
                      return (
                        <Pressable key={o.id} disabled={off} accessibilityRole={f.type === "checkbox" ? "checkbox" : "radio"} accessibilityState={{ checked: on }} accessibilityLabel={o.label}
                          onPress={() => set(f.id, f.type === "checkbox" ? (on ? ticked.filter((x) => x !== o.id) : [...ticked, o.id]) : on ? "" : o.id)}
                          style={{ flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: on ? t.primary : t.border, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 12, backgroundColor: t.surface }}>
                          <View style={{ width: 22, height: 22, borderRadius: f.type === "checkbox" ? 5 : 11, borderWidth: 2, borderColor: on ? t.primary : t.muted, backgroundColor: on ? t.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                            {on ? <Txt style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>✓</Txt> : null}
                          </View>
                          <Txt style={{ flex: 1 }}>{o.label}</Txt>
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
              <Divider />
            </View>
          ))}
          {entry?.def.signature ? (
            <View style={{ gap: 6 }}>
              <Txt muted style={{ fontSize: 13 }}>{entry.def.signatureLabel || "Signature"}</Txt>
              <SignaturePad value={signature} disabled={off} onSigning={setSigning} onChange={(s) => { setSignature(s); setChanged(true); }} />
            </View>
          ) : null}
          {entry && off ? <Txt muted>Only the crew on this work order or a manager can fill it in.</Txt> : null}
          {entry?.canFill ? <Button title={entry.submitted ? "Update" : "Submit"} busy={busy} disabled={entry.submitted && !changed} onPress={submit} /> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

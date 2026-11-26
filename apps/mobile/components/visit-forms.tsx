import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, Modal, PanResponder, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { FORM_PHOTOS_MAX, isSigned, signatureStrokes, type FormAnswers, type FormDef, type FormSignature, type FormSignatures } from "@crewdesk/shared";
import { API_URL, api, authHeaders } from "@/lib/api";
import { formatMdyTyping, mdyToIso } from "@/lib/dates";
import { Button, Divider, ErrorText, Input, Row, Txt, useTheme } from "./ui";

/**
 * Visit forms on the crew's work orders (Marketing → Visit Forms on the web): the forms on a work
 * order with whether each has been submitted; tap one to fill it in, sign it and submit it.
 */

export interface WorkOrderForm { id: string; name: string; submitted: boolean; submittedAt: string | null; submittedBy: string | null; mustSubmit?: boolean }
interface Entry extends WorkOrderForm { def: FormDef; answers: FormAnswers; signature: FormSignature | null; signatures?: FormSignatures; canFill: boolean; locked?: boolean; flagged?: string[] }

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
            <Txt muted style={{ fontSize: 12 }}>{f.submitted ? `Submitted${f.submittedBy ? ` by ${f.submittedBy}` : ""}${f.submittedAt ? ` · ${when(f.submittedAt)}` : ""}` : f.mustSubmit ? "Not submitted · needed before Completed" : "Not submitted"}</Txt>
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

/* ───────────── A date question ───────────── */

const isoToMdy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}` : "");

/** A date, typed as MM-DD-YYYY like the app's other dates (kept as YYYY-MM-DD), with a shortcut for today. */
function DateAnswer({ label, value, onChange, disabled }: { label: string; value: string; onChange: (iso: string) => void; disabled?: boolean }) {
  const t = useTheme();
  const [text, setText] = useState(isoToMdy(value));
  // The saved answer changed underneath (the form was loaded or submitted): show it.
  useEffect(() => { if ((mdyToIso(text) ?? "") !== value) setText(isoToMdy(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const typed = (raw: string) => { const next = formatMdyTyping(raw); setText(next); const iso = mdyToIso(next) ?? ""; if (iso !== value) onChange(iso); };
  const today = () => { const d = new Date(); typed(`${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${d.getFullYear()}`); };
  return (
    <View style={{ gap: 4 }}>
      <Input label={label} value={text} editable={!disabled} onChangeText={typed} placeholder="MM-DD-YYYY" keyboardType="number-pad" maxLength={10} />
      {text && !mdyToIso(text) ? <Txt style={{ color: t.warn, fontSize: 12 }}>Enter the date as MM-DD-YYYY, e.g. 12-22-2026</Txt> : null}
      {!disabled ? (
        <Pressable onPress={today} accessibilityRole="button" style={{ alignSelf: "flex-start", paddingVertical: 2 }}>
          <Txt style={{ color: t.primary, fontWeight: "600" }}>Today</Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ───────────── A photo question ───────────── */

/** The pictures taken for a photo question (kept with the work order's photos), and adding more. */
function PhotoAnswer({ visitId, label, ids, onChange, disabled }: { visitId: string; label: string; ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const left = FORM_PHOTOS_MAX - ids.length;
  const pick = async (source: "camera" | "photos") => {
    if (source === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      Alert.alert("Camera access needed", "Allow camera access in Settings, or choose a photo instead.");
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6, allowsMultipleSelection: source === "photos", selectionLimit: Math.min(10, left) };
    const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled) return;
    setBusy(true);
    const made: string[] = [];
    try {
      for (const [i, a] of res.assets.slice(0, left).entries()) {
        const fd = new FormData();
        fd.append("caption", label.slice(0, 300));
        fd.append("file", { uri: a.uri, name: `photo-${Date.now()}-${i + 1}.jpg`, type: "image/jpeg" } as unknown as Blob);
        made.push((await api<{ id: string }>(`/visits/${visitId}/files`, { method: "POST", body: fd })).id);
      }
    } catch (e) { Alert.alert("Couldn't add the photo", (e as Error).message); }
    setBusy(false);
    if (made.length) onChange([...ids, ...made]);
  };
  const add = () => Alert.alert("Add a photo", undefined, [
    { text: "Take photo", onPress: () => pick("camera") },
    { text: "Choose photos", onPress: () => pick("photos") },
    { text: "Cancel", style: "cancel" },
  ]);
  return (
    <View style={{ gap: 8 }}>
      {ids.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {ids.map((id) => (
            <View key={id} style={{ width: 92, height: 92, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
              <Image source={{ uri: `${API_URL}/visits/${visitId}/files/${id}`, headers: authHeaders() }} style={{ width: "100%", height: "100%" }} resizeMode="cover" accessibilityLabel={label} />
              {!disabled ? (
                <Pressable onPress={() => onChange(ids.filter((x) => x !== id))} accessibilityRole="button" accessibilityLabel="Take this photo off the form" hitSlop={6}
                  style={{ position: "absolute", top: 3, right: 3, width: 24, height: 24, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.62)", alignItems: "center", justifyContent: "center" }}>
                  <Txt style={{ color: "#fff", fontWeight: "700", fontSize: 14, lineHeight: 16 }}>×</Txt>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : disabled ? <Txt muted>No photo</Txt> : null}
      {!disabled && left > 0 ? <Button title={busy ? "Adding…" : ids.length ? "Add another photo" : "Add photo"} kind="secondary" busy={busy} onPress={add} /> : null}
    </View>
  );
}

/* ───────────── Filling one in ───────────── */

function FormFill({ visitId, entryId, title, onClose, onSaved }: { visitId: string; entryId: string; title: string; onClose: () => void; onSaved: () => void }) {
  const t = useTheme();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [signature, setSignature] = useState<FormSignature | null>(null);
  const [signatures, setSignatures] = useState<FormSignatures>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [changed, setChanged] = useState(false);
  const take = (e: Entry) => { setEntry(e); setAnswers(e.answers ?? {}); setSignature(e.signature ?? null); setSignatures(e.signatures ?? {}); setChanged(false); };
  useEffect(() => { api<Entry>(`/visits/${visitId}/forms/${entryId}`).then(take, (e: Error) => setError(e.message)); }, [visitId, entryId]);
  const set = (id: string, v: string | string[]) => { setAnswers((a) => ({ ...a, [id]: v })); setChanged(true); setError(null); };
  const sign = (id: string, sg: FormSignature | null) => { setSignatures((all) => { const next = { ...all }; if (sg) next[id] = sg; else delete next[id]; return next; }); setChanged(true); };
  const off = !entry?.canFill;
  /** A question's label, with a star when it has to be answered. */
  const ask = (label: string, required?: boolean, hint = "") => <Txt muted style={{ fontSize: 13 }}>{label}{hint}{required ? <Txt style={{ color: t.bad, fontWeight: "700" }}> *</Txt> : null}</Txt>;
  const submit = async () => {
    if (!entry) return;
    setBusy(true); setError(null);
    try {
      const was = entry.submitted;
      const next = await api<Entry>(`/visits/${visitId}/forms/${entryId}`, { method: "PUT", body: { answers, signature, signatures } });
      take(next);
      onSaved();
      // What an answer set off for the office (a tag, a to-do), if anything.
      Alert.alert(was ? "Form updated" : "Form submitted", next.flagged?.length ? next.flagged.join("\n") : undefined);
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
          {entry?.locked ? <Txt style={{ color: t.warn }}>This work order is on an invoice, so its forms are locked.</Txt> : null}
          {entry?.submitted && entry.submittedAt ? <Txt muted style={{ fontSize: 13 }}>Submitted{entry.submittedBy ? ` by ${entry.submittedBy}` : ""} · {when(entry.submittedAt)}</Txt> : null}
          {entry?.def.sections.map((s) => (
            <View key={s.id} style={{ gap: 12 }}>
              {s.name ? <Txt style={{ fontWeight: "700", fontSize: 17 }}>{s.name}</Txt> : null}
              {s.fields.map((f) => {
                const a = answers[f.id];
                const label = `${f.label}${f.required ? " *" : ""}`;
                if (f.type === "date") return <DateAnswer key={f.id} label={label} value={typeof a === "string" ? a : ""} disabled={off} onChange={(iso) => set(f.id, iso)} />;
                if (f.type === "text" || f.type === "textarea" || f.type === "number") {
                  // A long answer gets a taller box (its own style; the others keep the usual input).
                  const kind = f.type === "textarea" ? { multiline: true, maxLength: 10_000, style: { minHeight: 110, textAlignVertical: "top" as const, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 16, color: t.text, borderColor: t.border, backgroundColor: t.surface } }
                    : f.type === "number" ? { maxLength: 20, keyboardType: "decimal-pad" as const }
                    : { maxLength: 500 };
                  return <Input key={f.id} label={label} value={typeof a === "string" ? a : ""} editable={!off} onChangeText={(text) => set(f.id, f.type === "number" ? text.replace(/[^0-9.,-]/g, "") : text)} {...kind} />;
                }
                if (f.type === "photo") return <View key={f.id} style={{ gap: 6 }}>{ask(f.label, f.required)}<PhotoAnswer visitId={visitId} label={f.label} ids={Array.isArray(a) ? a : []} disabled={off} onChange={(ids) => set(f.id, ids)} /></View>;
                if (f.type === "signature") return <View key={f.id} style={{ gap: 6 }}>{ask(f.label || "Signature", f.required)}<SignaturePad value={signatures[f.id] ?? null} disabled={off} onSigning={setSigning} onChange={(sg) => sign(f.id, sg)} /></View>;
                const many = f.type === "checkbox";
                const ticked = Array.isArray(a) ? a : [];
                return (
                  <View key={f.id} style={{ gap: 6 }}>
                    {ask(f.label, f.required, f.type === "dropdown" ? " (pick one)" : "")}
                    {f.options.map((o) => {
                      const on = many ? ticked.includes(o.id) : a === o.id;
                      return (
                        <Pressable key={o.id} disabled={off} accessibilityRole={many ? "checkbox" : "radio"} accessibilityState={{ checked: on }} accessibilityLabel={o.label}
                          onPress={() => set(f.id, many ? (on ? ticked.filter((x) => x !== o.id) : [...ticked, o.id]) : on ? "" : o.id)}
                          style={{ flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: on ? t.primary : t.border, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 12, backgroundColor: t.surface }}>
                          <View style={{ width: 22, height: 22, borderRadius: many ? 5 : 11, borderWidth: 2, borderColor: on ? t.primary : t.muted, backgroundColor: on ? t.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
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
              {ask(entry.def.signatureLabel || "Signature", entry.def.signatureRequired)}
              <SignaturePad value={signature} disabled={off} onSigning={setSigning} onChange={(s) => { setSignature(s); setChanged(true); }} />
            </View>
          ) : null}
          {entry && off && !entry.locked ? <Txt muted>Only the crew on this work order or a manager can fill it in.</Txt> : null}
          {entry?.canFill ? <Button title={entry.submitted ? "Update" : "Submit"} busy={busy} disabled={entry.submitted && !changed} onPress={submit} /> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

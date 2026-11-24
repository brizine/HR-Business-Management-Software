import { useState } from "react";
import { Pressable, View } from "react-native";
import { formatRateAmount } from "@crewdesk/shared";
import { Chips } from "./chips";
import { Button, Divider, Input, Row, Txt, useTheme } from "./ui";

/** What GET /visits/:id/chemicals returns. */
export interface ChemicalOptions {
  chemical: boolean;
  areaSqFt: number | null;
  site: string | null;
  methods: { id: string; name: string; galPer1000: number | null }[];
  items: { productId: string; productName: string; unit: string; used: boolean; methodId: string; ratePer1000: number; amount: number | null }[];
  products: { id: string; name: string; unit: string; ratePer1000: number | null; defaultMethodId: string; bySheet: Record<string, number | null> }[];
}
interface Item { productId: string; name: string; unit: string; used: boolean; methodId: string; rate: string; amount: string; edited: boolean }

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(/,/g, "")));
const fmt = (n: number | null | undefined, d = 3) => (n == null || !Number.isFinite(n) ? "" : String(Math.round(n * 10 ** d) / 10 ** d));

/**
 * The tech's chemicals step when completing a chemical work order: each product is prefilled as used,
 * with how it was applied (a Spray Mix sheet or spreader) and the amount for this lawn. If nothing
 * changed, Save is the only tap. Any product can be added (spot treatments).
 */
export function ChemicalsStep({ options, busy, onSave, onCancel }: {
  options: ChemicalOptions; busy: boolean;
  onSave: (notes: string, chemicals: { areaSqFt: number | null; site: string | null; items: { productId: string; used: boolean; methodId: string; ratePer1000: number; amount: number }[] }) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [area, setArea] = useState(fmt(options.areaSqFt, 0));
  const [site, setSite] = useState(options.site ?? "");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const rateFor = (productId: string, methodId: string, fallback: number | null) => {
    const p = options.products.find((x) => x.id === productId);
    return (p?.bySheet[methodId] ?? p?.ratePer1000 ?? fallback) ?? 0;
  };
  const amountFor = (rate: number, a: string) => (Number.isFinite(num(a)) ? (rate * num(a)) / 1000 : NaN);
  const [items, setItems] = useState<Item[]>(options.items.map((i) => ({
    productId: i.productId, name: i.productName, unit: i.unit, used: true, methodId: i.methodId,
    rate: fmt(i.ratePer1000), amount: fmt(i.amount ?? amountFor(i.ratePer1000, fmt(options.areaSqFt, 0))), edited: false,
  })));
  const update = (n: number, patch: Partial<Item>) => setItems((list) => list.map((x, j) => (j === n ? { ...x, ...patch } : x)));
  const changeMethod = (n: number, methodId: string) => {
    const it = items[n];
    const rate = rateFor(it.productId, methodId, num(it.rate));
    update(n, { methodId, rate: fmt(rate), amount: it.edited ? it.amount : fmt(amountFor(rate, area)) });
  };
  const changeArea = (a: string) => {
    setArea(a);
    setItems((list) => list.map((x) => (x.edited ? x : { ...x, amount: fmt(amountFor(num(x.rate), a)) })));
  };
  const add = (id: string) => {
    const p = options.products.find((x) => x.id === id)!;
    const rate = rateFor(id, p.defaultMethodId, p.ratePer1000);
    setItems((list) => [...list, { productId: id, name: p.name, unit: p.unit, used: true, methodId: p.defaultMethodId, rate: fmt(rate), amount: fmt(amountFor(rate, area)), edited: false }]);
    setSearch("");
  };
  const matches = search.trim().length >= 2
    ? options.products.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()) && !items.some((i) => i.productId === p.id)).slice(0, 6)
    : [];
  const bad = items.some((i) => i.used && (!Number.isFinite(num(i.amount)) || !Number.isFinite(num(i.rate))));
  const methodOptions = options.methods.map((m) => ({ value: m.id, label: m.name }));

  return (
    <View style={{ gap: 8 }}>
      <Txt style={{ fontWeight: "600" }}>Chemicals applied</Txt>
      <Txt muted>Check what you applied and how. Change anything that was different.</Txt>
      {items.map((it, n) => (
        <View key={`${it.productId}-${n}`} style={{ gap: 6, opacity: it.used ? 1 : 0.55 }}>
          <Divider />
          <Row>
            <Txt style={{ fontWeight: "600", flex: 1 }}>{it.name}</Txt>
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: it.used }} accessibilityLabel={`${it.name} used`}
              onPress={() => update(n, { used: !it.used })} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: it.used ? t.primary : t.border }}>
              <Txt style={{ color: it.used ? "#fff" : t.text, fontWeight: "600" }}>{it.used ? "Used" : "Not used"}</Txt>
            </Pressable>
          </Row>
          {it.used ? (
            <>
              <Chips label="How it was applied" options={methodOptions} value={it.methodId} onChange={(m) => changeMethod(n, m)} />
              <Row>
                <View style={{ flex: 1 }}><Input label={`Rate per 1,000 sq ft (${formatRateAmount(1, it.unit).replace(/^1 /, "")})`} keyboardType="decimal-pad" value={it.rate}
                  onChangeText={(v) => update(n, { rate: v, amount: it.edited ? it.amount : fmt(amountFor(num(v), area)) })} /></View>
                <View style={{ flex: 1 }}><Input label="Amount used" keyboardType="decimal-pad" value={it.amount} onChangeText={(v) => update(n, { amount: v, edited: true })} /></View>
              </Row>
            </>
          ) : null}
        </View>
      ))}
      <Divider />
      <Input label="Add a product" value={search} onChangeText={setSearch} placeholder="Type a product name" />
      {matches.map((p) => (
        <Pressable key={p.id} onPress={() => add(p.id)} accessibilityRole="button" accessibilityLabel={`Add ${p.name}`} style={{ paddingVertical: 8 }}>
          <Txt style={{ color: t.primary }}>+ {p.name}</Txt>
        </Pressable>
      ))}
      <Row>
        <View style={{ flex: 1 }}><Input label="Area treated (sq ft)" keyboardType="number-pad" value={area} onChangeText={changeArea} /></View>
        <View style={{ flex: 1 }}><Input label="Site" value={site} onChangeText={setSite} placeholder="Turf – front and back lawn" /></View>
      </Row>
      <Input label="Notes about the work (optional)" value={notes} onChangeText={setNotes} multiline placeholder="Applied round 3; gate was open" />
      <Row>
        <View style={{ flex: 1 }}><Button title="Mark completed" busy={busy} disabled={bad}
          onPress={() => onSave(notes, {
            areaSqFt: Number.isFinite(num(area)) && num(area) > 0 ? num(area) : null,
            site: site.trim() || null,
            items: items.map((i) => ({ productId: i.productId, used: i.used, methodId: i.methodId, ratePer1000: i.used ? num(i.rate) : 0, amount: i.used ? num(i.amount) : 0 })),
          })} /></View>
        <View style={{ flex: 1 }}><Button title="Cancel" kind="secondary" onPress={onCancel} /></View>
      </Row>
      {bad ? <Txt muted>Enter the rate and amount for each product used.</Txt> : null}
    </View>
  );
}

"use client";
import { useMemo, useState } from "react";
import { formatRateAmount } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/** What GET /visits/:id/chemicals returns. */
export interface ChemicalOptions {
  chemical: boolean;
  areaSqFt: number | null;
  site: string | null;
  methods: { id: string; name: string; galPer1000: number | null }[];
  items: { productId: string; productName: string; unit: string; used: boolean; methodId: string | null; ratePer1000: number; amount: number | null }[];
  products: { id: string; name: string; unit: string; ratePer1000: number | null; defaultMethodId: string | null; byMethod: Record<string, number | null> }[];
}
interface Item { productId: string; name: string; unit: string; used: boolean; methodId: string; rate: string; amount: string; edited: boolean }
export interface ChemicalCompletion { areaSqFt: number | null; site: string | null; items: { productId: string; used: boolean; methodId: string; ratePer1000: number; amount: number }[] }

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(/,/g, "")));
const fmt = (n: number | null | undefined, d = 3) => (n == null || !Number.isFinite(n) ? "" : String(Math.round(n * 10 ** d) / 10 ** d));

/** Whether completing this work order needs the chemicals step, and what to prefill it with. */
export const loadChemicalOptions = (visitId: string) => api<ChemicalOptions>(`/visits/${visitId}/chemicals`);

/**
 * The chemicals step when a chemical work order is marked completed on the website, the same as
 * the phone's: each product prefilled as used, with its usual method and the amount for this lawn.
 * Change the method (its rate fills in), the amount, the area or site; mark one not used; add any
 * product. What's saved here is what goes on the chemical record.
 */
export function ChemicalsStep({ options, busy, error, onSave, onCancel }: {
  options: ChemicalOptions; busy: boolean; error?: string | null;
  onSave: (notes: string, chemicals: ChemicalCompletion) => void;
  onCancel: () => void;
}) {
  const [area, setArea] = useState(fmt(options.areaSqFt, 0));
  const [site, setSite] = useState(options.site ?? "");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState("");
  const rateFor = (productId: string, methodId: string | null, fallback: number | null) => {
    const p = options.products.find((x) => x.id === productId);
    return ((methodId ? p?.byMethod[methodId] : null) ?? p?.ratePer1000 ?? fallback) ?? 0;
  };
  const amountFor = (rate: number, a: string) => (Number.isFinite(num(a)) ? (rate * num(a)) / 1000 : NaN);
  const [items, setItems] = useState<Item[]>(() => options.items.map((i) => ({
    productId: i.productId, name: i.productName, unit: i.unit, used: true, methodId: i.methodId ?? options.methods[0]?.id ?? "",
    rate: fmt(i.ratePer1000), amount: fmt(i.amount ?? amountFor(i.ratePer1000, fmt(options.areaSqFt, 0))), edited: false,
  })));
  const update = (n: number, patch: Partial<Item>) => setItems((list) => list.map((x, j) => (j === n ? { ...x, ...patch } : x)));
  const changeMethod = (n: number, methodId: string) => {
    const it = items[n];
    const rate = rateFor(it.productId, methodId, num(it.rate));
    update(n, { methodId, rate: fmt(rate), amount: it.edited ? it.amount : fmt(amountFor(rate, area)) });
  };
  const changeRate = (n: number, rate: string) => {
    const it = items[n];
    update(n, { rate, amount: it.edited ? it.amount : fmt(amountFor(num(rate), area)) });
  };
  const changeArea = (a: string) => {
    setArea(a);
    setItems((list) => list.map((x) => (x.edited ? x : { ...x, amount: fmt(amountFor(num(x.rate), a)) })));
  };
  const add = (id: string) => {
    const p = options.products.find((x) => x.id === id);
    if (!p) return;
    const methodId = p.defaultMethodId ?? options.methods[0]?.id ?? "";
    const rate = rateFor(id, methodId, p.ratePer1000);
    setItems((list) => [...list, { productId: id, name: p.name, unit: p.unit, used: true, methodId, rate: fmt(rate), amount: fmt(amountFor(rate, area)), edited: false }]);
    setAdding("");
  };
  const addable = useMemo(() => options.products.filter((p) => !items.some((i) => i.productId === p.id)), [options.products, items]);
  const bad = items.some((i) => i.used && (!i.methodId || !Number.isFinite(num(i.amount)) || !Number.isFinite(num(i.rate))));
  const save = () => onSave(notes, {
    areaSqFt: Number.isFinite(num(area)) && num(area) > 0 ? num(area) : null,
    site: site.trim() || null,
    items: items.map((i) => ({ productId: i.productId, used: i.used, methodId: i.methodId, ratePer1000: i.used ? num(i.rate) : 0, amount: i.used ? num(i.amount) : 0 })),
  });

  return (
    <div className="stack chem-step">
      <div>
        <h3 style={{ margin: 0 }}>Chemicals applied</h3>
        <p className="muted" style={{ margin: "2px 0 0" }}>Check what went down. This goes on the state record.</p>
      </div>
      {items.length === 0 && <p className="muted" style={{ margin: 0 }}>No products on this service. Add what was applied below.</p>}
      {items.map((it, n) => {
        const unit = formatRateAmount(1, it.unit).replace(/^1 /, "");
        return (
          <fieldset key={`${it.productId}-${n}`} className="contacts" style={{ opacity: it.used ? 1 : 0.6 }}>
            <legend>
              <label className="check" style={{ fontWeight: 600 }}>
                <input type="checkbox" checked={it.used} onChange={(e) => update(n, { used: e.target.checked })} /> {it.name}
              </label>
            </legend>
            {it.used ? (
              <div className="formgrid">
                <label>How it was applied
                  <select value={it.methodId} onChange={(e) => changeMethod(n, e.target.value)}>
                    {!it.methodId && <option value="">Pick a method…</option>}
                    {options.methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label>Rate ({unit} / 1,000 sq ft)<input inputMode="decimal" value={it.rate} onChange={(e) => changeRate(n, e.target.value)} /></label>
                <label>Amount used ({unit})<input inputMode="decimal" value={it.amount} onChange={(e) => update(n, { amount: e.target.value, edited: true })} /></label>
              </div>
            ) : <p className="muted" style={{ margin: 0 }}>Not used</p>}
          </fieldset>
        );
      })}
      {addable.length > 0 && (
        <label style={{ maxWidth: 360 }}>Add a product <span className="muted">(spot treatment, anything else applied)</span>
          <select value={adding} onChange={(e) => add(e.target.value)}>
            <option value="">Pick a product…</option>
            {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <div className="formgrid">
        <label>Area treated (sq ft)<input inputMode="numeric" value={area} onChange={(e) => changeArea(e.target.value)} /></label>
        <label>Site<input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Turf – front and back lawn" /></label>
      </div>
      <label>Notes about the work (optional)<textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Applied round 3; back gate was open" /></label>
      {bad && <p className="warn-text" style={{ margin: 0 }}>Pick how each product was applied and enter its rate and amount.</p>}
      <ErrorBox error={error} />
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || bad} onClick={save}>Mark completed</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Completing from somewhere small (the calendar's pop-up): checks whether it's a chemical work
 * order and, if so, shows the step in a window over the page. Otherwise completes it right away.
 */
export function useCompleteVisit(onDone: () => void) {
  const [step, setStep] = useState<{ visitId: string; options: ChemicalOptions } | null>(null);
  const act = useAction();
  const start = (visitId: string) => act.run(async () => {
    const options = await loadChemicalOptions(visitId);
    if (options.chemical) { setStep({ visitId, options }); return; }
    await api(`/visits/${visitId}/complete`, { method: "POST", body: {} });
    onDone();
  });
  const finish = (notes: string, chemicals: ChemicalCompletion) => act.run(async () => {
    if (!step) return;
    await api(`/visits/${step.visitId}/complete`, { method: "POST", body: { notes: notes.trim() || undefined, chemicals } });
    setStep(null);
    onDone();
  });
  const dialog = step ? (
    <div className="chem-overlay" role="dialog" aria-modal="true" aria-label="Chemicals applied" onMouseDown={(e) => { if (e.target === e.currentTarget && !act.busy) setStep(null); }}>
      <div className="card chem-dialog">
        <ChemicalsStep options={step.options} busy={act.busy} error={act.error} onSave={finish} onCancel={() => setStep(null)} />
      </div>
    </div>
  ) : null;
  return { start, busy: act.busy, error: step ? null : act.error, dialog };
}

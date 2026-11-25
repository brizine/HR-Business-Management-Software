"use client";
import { useState } from "react";
import { formatRateAmount } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import type { Method } from "../products/page";

interface MixItem { productId: string; productName: string; unit: string; ratePer1000: number; productActive: boolean }
interface Mix { id: string; name: string; applicationMethodId: string | null; methodName: string | null; notes: string | null; active: boolean; items: MixItem[] }
interface Product { id: string; name: string; useUnit: string; active: boolean; labelMaxPer1000: number | null; rates: { amountPer1000: number; applicationMethodId: string | null }[] }

const num = (v: string) => (v.trim() === "" ? NaN : Number(v.replace(/[,\s]/g, "")));
const short = (unit: string) => formatRateAmount(1, unit).replace(/^1 /, "");
const r3 = (n: number) => +n.toFixed(3);

/**
 * Mixes: products that go in one tank together (e.g. a pre-emergent, a broadleaf and a surfactant),
 * each at its rate, applied one way. Techs add the whole mix in one tap when they complete a work
 * order; the record still lists every product, with the mix's name.
 */
export default function Mixes() {
  const list = useApi<Mix[]>("/chemical-tracking/mixes");
  const methods = useApi<Method[]>("/chemical-tracking/methods");
  const [editing, setEditing] = useState<Mix | "new" | null>(null);
  const rows = list.data ?? [];
  const gal = (id: string | null) => methods.data?.find((m) => m.id === id)?.galPer1000 ?? null;
  return (
    <>
      <PageHead title="Mixes" sub="Products that go in one tank together, each at its rate. Techs add the whole mix in one tap instead of each product, so nothing gets left off or entered at the wrong rate.">
        <button className="btn primary" onClick={() => setEditing("new")}>Add mix</button>
      </PageHead>
      {editing && <MixForm key={editing === "new" ? "new" : editing.id} mix={editing === "new" ? null : editing} methods={methods.data ?? []} onDone={() => { setEditing(null); list.reload(); }} />}
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Mix</th><th>Applied with</th><th>Products per 1,000 sq ft</th><th /></tr></thead>
            <tbody>{rows.map((m) => {
              const g = gal(m.applicationMethodId);
              return (
                <tr key={m.id} style={{ opacity: m.active ? 1 : 0.6 }}>
                  <td><strong>{m.name}</strong>{!m.active && <> <span className="badge">off</span></>}{m.notes && <div className="muted">{m.notes}</div>}</td>
                  <td>{m.methodName ?? <span className="badge warn">no method</span>}</td>
                  <td>{m.items.map((i) => (
                    <div key={i.productId}>{i.productName} <span className="muted">{formatRateAmount(i.ratePer1000, i.unit)}{g ? ` · ${r3(i.ratePer1000 / g)} ${short(i.unit)} per gal of spray` : ""}</span>{!i.productActive && <> <span className="badge">retired</span></>}</div>
                  ))}</td>
                  <td><button className="btn" onClick={() => setEditing(m)}>Edit</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>No mixes yet. Add the tank mixes your techs put down, like a pre-emergent with a broadleaf and a surfactant.</Empty>}
      </div>
    </>
  );
}

function MixForm({ mix, methods, onDone }: { mix: Mix | null; methods: Method[]; onDone: () => void }) {
  const catalog = useApi<Product[]>("/products");
  const [name, setName] = useState(mix?.name ?? "");
  const [methodId, setMethodId] = useState(mix?.applicationMethodId ?? methods.find((m) => m.active && m.galPer1000 != null)?.id ?? "");
  const [notes, setNotes] = useState(mix?.notes ?? "");
  const [active, setActive] = useState(mix?.active ?? true);
  const [items, setItems] = useState(mix?.items.map((i) => ({ productId: i.productId, rate: String(i.ratePer1000) })) ?? [{ productId: "", rate: "" }]);
  const { busy, error, run, setError } = useAction();
  const products = (catalog.data ?? []).filter((p) => p.active || items.some((i) => i.productId === p.id));
  const usable = methods.filter((m) => m.active || m.id === methodId);
  const g = methods.find((m) => m.id === methodId)?.galPer1000 ?? null;
  /** A product's own rate for this method (else its first rate), to start from. */
  const startRate = (id: string, method: string) => {
    const p = catalog.data?.find((x) => x.id === id);
    const r = p?.rates.find((x) => x.applicationMethodId === method) ?? p?.rates[0];
    return r ? String(r.amountPer1000) : "";
  };
  const upd = (n: number, patch: Partial<(typeof items)[number]>) => setItems(items.map((x, j) => (j === n ? { ...x, ...patch } : x)));
  const save = () => run(async () => {
    const used = items.filter((i) => i.productId);
    if (used.some((i) => !(num(i.rate) > 0))) return setError("Enter the rate for each product");
    const body = { name, applicationMethodId: methodId, notes, active, items: used.map((i) => ({ productId: i.productId, ratePer1000: num(i.rate) })) };
    await api(mix ? `/chemical-tracking/mixes/${mix.id}` : "/chemical-tracking/mixes", { method: mix ? "PUT" : "POST", body });
    onDone();
  });
  const remove = () => run(async () => { if (mix && confirm(`Remove the ${mix.name} mix? Records already made keep their products.`)) { await api(`/chemical-tracking/mixes/${mix.id}`, { method: "DELETE" }); onDone(); } });
  return (
    <form className="card stack" style={{ marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
      <h3 style={{ margin: 0 }}>{mix ? `Edit ${mix.name}` : "New mix"}</h3>
      <div className="formgrid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Early Spring pre-em + broadleaf" /></label>
        <label>Applied with
          <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            <option value="">Pick a method…</option>
            {usable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="contacts">
        <legend>Products <span className="muted">(rate per 1,000 sq ft)</span></legend>
        {items.map((it, n) => {
          const p = catalog.data?.find((x) => x.id === it.productId);
          const over = p?.labelMaxPer1000 != null && num(it.rate) > p.labelMaxPer1000;
          return (
            <div key={n} className="row">
              <label style={{ flex: 1, minWidth: 220 }}>Product
                <select value={it.productId} onChange={(e) => upd(n, { productId: e.target.value, rate: it.rate || startRate(e.target.value, methodId) })}>
                  <option value="">Pick a product…</option>
                  {products.map((x) => <option key={x.id} value={x.id} disabled={x.id !== it.productId && items.some((i) => i.productId === x.id)}>{x.name}</option>)}
                </select>
              </label>
              <label style={{ width: 170 }}>Rate{p ? ` (${short(p.useUnit)})` : ""}<input inputMode="decimal" value={it.rate} onChange={(e) => upd(n, { rate: e.target.value })} /></label>
              <div className="muted" style={{ alignSelf: "flex-end", minWidth: 150 }}>
                {over ? <span className="bad-text">over the label max ({p!.labelMaxPer1000})</span> : p && g && num(it.rate) > 0 ? `${r3(num(it.rate) / g)} ${short(p.useUnit)} per gal` : ""}
              </div>
              {items.length > 1 && <button type="button" className="btn" style={{ alignSelf: "flex-end" }} onClick={() => setItems(items.filter((_, j) => j !== n))}>Remove</button>}
            </div>
          );
        })}
        <div><button type="button" className="btn" onClick={() => setItems([...items, { productId: "", rate: "" }])}>Add a product</button></div>
      </fieldset>
      <label>Notes for the tech <span className="muted">(optional)</span><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Add the surfactant last" /></label>
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active <span className="muted">(untick to hide it from techs)</span></label>
      <ErrorBox error={error ?? catalog.error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        {mix && <button type="button" className="btn" disabled={busy} onClick={remove} style={{ marginLeft: "auto" }}>Remove mix</button>}
      </div>
    </form>
  );
}

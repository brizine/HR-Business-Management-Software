"use client";
import { useEffect, useState } from "react";
import { MIX_UNITS, computeMix, formatAmount, formatEntered, isInactive, totalsByUnit } from "@crewdesk/shared";
import { api, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

const remembered = (sheetId: string) => {
  try {
    const v = Number(localStorage.getItem(`spray-mix.tank.${sheetId}`));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
};
const remember = (sheetId: string, gallons: number) => {
  try {
    localStorage.setItem(`spray-mix.tank.${sheetId}`, String(gallons));
  } catch {}
};

/**
 * Editors click a value in the calculator to change it in place: Enter or clicking away saves,
 * Esc cancels. Everyone else just sees the value.
 */
function Editable({ value, display, label, canEdit, onSave, kind = "text", options, width }: {
  value: string | number;
  display?: React.ReactNode;
  label: string;
  canEdit: boolean;
  onSave: (v: string) => Promise<unknown>;
  kind?: "text" | "number" | "select";
  options?: string[];
  width?: number | string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const { busy, error, run } = useAction();
  if (!canEdit) return <>{display ?? value}</>;
  const start = () => { setDraft(String(value)); setEditing(true); };
  const save = async () => {
    if (draft.trim() === String(value)) return setEditing(false);
    if (await run(() => onSave(draft.trim()))) setEditing(false);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
  };
  if (!editing) {
    return (
      <button type="button" className="mix-editable" onClick={start} title={`Click to change ${label}`} aria-label={`${label}: ${value}. Click to change.`}>
        {display ?? value}
      </button>
    );
  }
  const common = { autoFocus: true, disabled: busy, "aria-label": label, onKeyDown: keys, onBlur: save, style: { width: width ?? "100%", minWidth: 0, padding: "3px 6px" } };
  return (
    <span className="mix-editing">
      {kind === "select" ? (
        <select {...common} value={draft} onChange={(e) => setDraft(e.target.value)}>
          {[...new Set([...(options ?? []), String(value)])].map((o) => <option key={o}>{o}</option>)}
        </select>
      ) : (
        <input {...common} type={kind === "number" ? "number" : "text"} step="any" min={kind === "number" ? 0 : undefined} inputMode={kind === "number" ? "decimal" : undefined} value={draft} onChange={(e) => setDraft(e.target.value)} />
      )}
      {error && <span className="mix-edit-error" role="alert">{error}</span>}
    </span>
  );
}

const units = MIX_UNITS as readonly string[];

/** Editors: a blank row at the bottom of the calculator for a new product. */
function AddProductRow({ sheet, onChange, columns }: { sheet: any; onChange: () => void; columns: number }) {
  const { busy, error, run } = useAction();
  return (
    <tr className="noprint mix-add-row">
      <td colSpan={columns}>
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          run(async () => { await api(`/spray-mixes/${sheet.id}/products`, { body: { name: f.get("name"), ratePerAcre: Number(f.get("ratePerAcre")), unit: f.get("unit") } }); form.reset(); onChange(); });
        }}>
          <input name="name" placeholder="+ Add a product" aria-label="New product name" required style={{ flex: 2, minWidth: 160 }} />
          <input name="ratePerAcre" type="number" step="any" min="0" placeholder="Rate/acre" aria-label="New product rate per acre" required style={{ width: 110 }} />
          <select name="unit" aria-label="New product measurement" style={{ width: 150 }}>{units.map((u) => <option key={u}>{u}</option>)}</select>
          <button className="btn sm primary" disabled={busy}>Add</button>
          <ErrorBox error={error} />
        </form>
      </td>
    </tr>
  );
}

/**
 * Just the ticked products, in a window over the page: × closes it (so do Esc and clicking outside),
 * Print prints only this window.
 */
function SelectedWindow({ sheet, gallons, rows, acres, squareFeet, onClose }: { sheet: any; gallons: number; rows: any[]; acres: number; squareFeet: number; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    document.body.classList.add("printing-window");
    return () => { document.removeEventListener("keydown", key); document.body.classList.remove("printing-window"); };
  }, [onClose]);
  return (
    <div className="mix-window-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mix-window" role="dialog" aria-modal="true" aria-labelledby="mix-window-title">
        <div className="mix-window-head">
          <div>
            <h2 id="mix-window-title" style={{ margin: 0 }}>{sheet.name}</h2>
            <div className="muted">{formatEntered(gallons)} gal tank · covers {acres.toFixed(2)} acre ({Math.round(squareFeet).toLocaleString()} ft²) · {new Date().toLocaleDateString()}</div>
          </div>
          <div className="row noprint" style={{ flexWrap: "nowrap" }}>
            <button type="button" className="btn" onClick={() => window.print()}>Print</button>
            <button type="button" className="mix-window-close" onClick={onClose} aria-label="Close" title="Close" autoFocus>×</button>
          </div>
        </div>
        <table className="mix-table">
          <thead><tr><th scope="col">Product</th><th scope="col">Rate/Acre</th><th scope="col">Measurement</th><th scope="col">Product needed</th></tr></thead>
          <tbody>
            {rows.map(({ product: p, needed }) => (
              <tr key={p.id}>
                <th scope="row" style={{ fontWeight: 500 }}>{p.name}</th>
                <td>{formatEntered(p.ratePerAcre)}</td>
                <td>{p.unit}</td>
                <td><strong style={{ fontSize: 18 }}>{formatAmount(needed)}</strong> <span className="muted">{p.unit.split(" ")[0]}</span></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="mix-total">
              <th scope="row" colSpan={3}>Total ({rows.length} product{rows.length === 1 ? "" : "s"})</th>
              <td>
                {totalsByUnit(rows).map((t) => (
                  <div key={t.unit} style={{ whiteSpace: "nowrap" }}><strong style={{ fontSize: 18 }}>{formatAmount(t.amount)}</strong> <span className="muted">{t.unit}</span></div>
                ))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Everyone: enter tank gallons, Update total. Nothing here is saved to the server. */
function Calculator({ sheet, canEdit, onChange }: { sheet: any; canEdit: boolean; onChange: () => void }) {
  const [input, setInput] = useState("");
  const [applied, setApplied] = useState<number>(sheet.defaultTankGallons);
  useEffect(() => {
    const start = remembered(sheet.id) ?? sheet.defaultTankGallons;
    setInput(String(start));
    setApplied(start);
  }, [sheet.id, sheet.defaultTankGallons]);

  const value = Number(input);
  const valid = input.trim() !== "" && value > 0 && value <= 100_000;
  const pending = valid && value !== applied;
  const mix = computeMix(sheet, applied);
  const update = () => {
    if (!valid) return;
    setApplied(value);
    remember(sheet.id, value);
  };
  const saveProduct = (p: any, body: Record<string, unknown>) => api(`/spray-mixes/products/${p.id}`, { method: "PATCH", body }).then(onChange);
  const remove = (p: any) => confirm(`Remove ${p.name} from ${sheet.name}?`) && api(`/spray-mixes/products/${p.id}`, { method: "DELETE" }).then(onChange, (e) => alert(e.message));
  const rateNumber = (v: string) => { const n = Number(v); if (v === "" || !(n >= 0)) throw new Error("Enter a rate of 0 or more."); return n; };

  // Ticked products, shown on their own in a window that can be printed.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showing, setShowing] = useState(false);
  useEffect(() => { setPicked(new Set()); setShowing(false); }, [sheet.id]);
  const ids = mix.rows.map((r) => r.product.id as string);
  const pickedRows = mix.rows.filter((r) => picked.has(r.product.id as string));
  const allPicked = ids.length > 0 && ids.every((id) => picked.has(id));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickBox = (p: any) => (
    <input type="checkbox" className="mix-pick" checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.name}`} />
  );

  return (
    <>
      <form className="card row noprint-border" onSubmit={(e) => { e.preventDefault(); update(); }} style={{ alignItems: "flex-end" }}>
        <label style={{ maxWidth: 220 }}>Tank mix in desired gallons
          <input type="number" inputMode="decimal" min="0.1" step="any" value={input} onChange={(e) => setInput(e.target.value)} aria-describedby="tank-help" style={{ fontSize: 18 }} />
        </label>
        <button className={`btn ${pending ? "primary" : ""}`} disabled={!valid}>Update total</button>
        <span id="tank-help" className="muted" role="status">
          {!valid ? "Enter the gallons of water you're mixing." : pending ? "Press Update total to recalculate." : `${formatEntered(applied)} gal covers ${mix.acres.toFixed(2)} acre (${Math.round(mix.squareFeet).toLocaleString()} ft²).`}
        </span>
      </form>
      <div className="mix-select-bar noprint" role="region" aria-label="Selected products">
        <span className="muted">{picked.size ? `${picked.size} selected` : "Tick products to show just those in their own window."}</span>
        {picked.size > 0 && (
          <>
            <button type="button" className="btn primary sm" onClick={() => setShowing(true)}>Show selected ({pickedRows.length})</button>
            <button type="button" className="btn sm" onClick={() => setPicked(new Set())}>Clear</button>
          </>
        )}
      </div>
      {showing && pickedRows.length > 0 && (
        <SelectedWindow sheet={sheet} gallons={applied} rows={pickedRows} acres={mix.acres} squareFeet={mix.squareFeet} onClose={() => setShowing(false)} />
      )}
      <div className="card tablewrap mix-table-wrap">
        <table className="mix-table">
          <caption className="sr-only">Product needed for a {applied}-gallon tank of {sheet.name}</caption>
          <thead><tr><th scope="col" className="mix-pick-col noprint">
            <input type="checkbox" className="mix-pick" checked={allPicked} disabled={!ids.length} onChange={() => setPicked(allPicked ? new Set() : new Set(ids))} aria-label="Select all products" />
          </th><th scope="col">Product</th><th scope="col">Rate/Acre</th><th scope="col">Rate/1000 ft²</th><th scope="col">Measurement</th><th scope="col">Water volume</th><th scope="col">Product needed</th>{canEdit && <th className="noprint"><span className="sr-only">Remove</span></th>}</tr></thead>
          <tbody>
            {mix.rows.map(({ product: p, ratePer1000, needed }) => (
              <tr key={p.id} className={picked.has(p.id!) ? "mix-picked" : undefined}>
                <td className="mix-pick-col noprint">{pickBox(p)}</td>
                <th scope="row" style={{ fontWeight: 500 }}>
                  <Editable canEdit={canEdit} label={`${p.name} name`} value={p.name} onSave={(v) => saveProduct(p, { name: v })} />
                </th>
                <td><Editable canEdit={canEdit} kind="number" width={90} label={`${p.name} rate per acre`} value={p.ratePerAcre} display={formatEntered(p.ratePerAcre)} onSave={async (v) => saveProduct(p, { ratePerAcre: rateNumber(v) })} /></td>
                <td>{formatAmount(ratePer1000)}</td>
                <td><Editable canEdit={canEdit} kind="select" options={units as string[]} width={140} label={`${p.name} measurement`} value={p.unit} onSave={(v) => saveProduct(p, { unit: v })} /></td>
                <td>{formatEntered(applied)} gal</td>
                <td><strong style={{ fontSize: 16 }}>{formatAmount(needed)}</strong> <span className="muted">{p.unit.split(" ")[0]}</span></td>
                {canEdit && <td className="noprint"><button type="button" className="btn sm danger mix-remove" aria-label={`Remove ${p.name}`} title={`Remove ${p.name}`} onClick={() => remove(p)}>×</button></td>}
              </tr>
            ))}
            {canEdit && <AddProductRow sheet={sheet} onChange={onChange} columns={8} />}
          </tbody>
        </table>
        {!mix.rows.length && <Empty>No products on this sheet yet.</Empty>}
      </div>
      {/* Phones: the amount to add first and large, rates underneath, so nothing scrolls sideways. */}
      <ul className="mix-cards" aria-label={`Product needed for a ${applied}-gallon tank`}>
        {mix.rows.map(({ product: p, ratePer1000, needed }) => (
          <li key={p.id} className={`card${picked.has(p.id!) ? " mix-picked" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <strong><span className="noprint" style={{ marginRight: 8 }}>{pickBox(p)}</span><Editable canEdit={canEdit} label={`${p.name} name`} value={p.name} onSave={(v) => saveProduct(p, { name: v })} /></strong>
              <span><strong style={{ fontSize: 20 }}>{formatAmount(needed)}</strong> <span className="muted">
                <Editable canEdit={canEdit} kind="select" options={units as string[]} width={140} label={`${p.name} measurement`} value={p.unit} onSave={(v) => saveProduct(p, { unit: v })} />
              </span></span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <Editable canEdit={canEdit} kind="number" width={90} label={`${p.name} rate per acre`} value={p.ratePerAcre} display={formatEntered(p.ratePerAcre)} onSave={async (v) => saveProduct(p, { ratePerAcre: rateNumber(v) })} />/acre · {formatAmount(ratePer1000)}/1000 ft²
              {canEdit && <button type="button" className="btn sm danger noprint" style={{ float: "right" }} onClick={() => remove(p)}>Remove</button>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Editors: settings that aren't in the calculator itself (product order, deleting the mix). */
function Editor({ sheet, onChange }: { sheet: any; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const num = (v: FormDataEntryValue | null) => Number(v);
  const unitOptions = (current: string) => [...new Set([...MIX_UNITS, current])];

  return (
    <div className="card stack noprint">
      <h2 style={{ margin: 0 }}>More settings for {sheet.name}</h2>
      <p className="muted" style={{ margin: 0 }}>Tip: you can also click any name, rate, measurement or the default tank in the calculator above to change it.</p>
      <form className="formgrid" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(async () => {
          await api(`/spray-mixes/${sheet.id}`, { method: "PATCH", body: { name: f.get("name"), gallonsPerAcre: num(f.get("gallonsPerAcre")), defaultTankGallons: num(f.get("defaultTankGallons")), notes: (f.get("notes") as string) || "" } });
          onChange();
        });
      }}>
        <label>Mix name<input name="name" defaultValue={sheet.name} required /></label>
        <label>Gallons of water per acre<input name="gallonsPerAcre" type="number" step="any" min="0.01" defaultValue={sheet.gallonsPerAcre} required /></label>
        <label>Default tank (gallons)<input name="defaultTankGallons" type="number" step="any" min="0.1" defaultValue={sheet.defaultTankGallons} required /></label>
        <label>Notes<input name="notes" defaultValue={sheet.notes ?? ""} placeholder="e.g. Green Tips/4MPH" /></label>
        <div style={{ alignSelf: "end" }}><button className="btn" disabled={busy}>Save mix settings</button></div>
      </form>
      <table>
        <thead><tr><th>Product</th><th>Rate per acre</th><th>Measurement</th><th /></tr></thead>
        <tbody>
          {sheet.products.map((p: any, i: number) => (
            <tr key={p.id}>
              <td colSpan={4}>
                <form className="row" onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(async () => { await api(`/spray-mixes/products/${p.id}`, { method: "PATCH", body: { name: f.get("name"), ratePerAcre: num(f.get("ratePerAcre")), unit: f.get("unit") } }); onChange(); });
                }}>
                  <input name="name" defaultValue={p.name} aria-label="Product name" required style={{ flex: 2, minWidth: 160 }} />
                  <input name="ratePerAcre" type="number" step="any" min="0" defaultValue={p.ratePerAcre} aria-label={`${p.name} rate per acre`} required style={{ width: 110 }} />
                  <select name="unit" defaultValue={p.unit} aria-label={`${p.name} measurement`} style={{ width: 150 }}>{unitOptions(p.unit).map((u) => <option key={u}>{u}</option>)}</select>
                  <button className="btn sm" disabled={busy}>Save</button>
                  <button type="button" className="btn sm" aria-label={`Move ${p.name} up`} disabled={busy || i === 0} onClick={() => run(async () => {
                    const prev = sheet.products[i - 1];
                    await api(`/spray-mixes/products/${p.id}`, { method: "PATCH", body: { sortOrder: i - 1 } });
                    await api(`/spray-mixes/products/${prev.id}`, { method: "PATCH", body: { sortOrder: i } });
                    onChange();
                  })}>↑</button>
                  <button type="button" className="btn sm danger" disabled={busy} onClick={() => confirm(`Remove ${p.name} from ${sheet.name}?`) && run(async () => { await api(`/spray-mixes/products/${p.id}`, { method: "DELETE" }); onChange(); })}>Remove</button>
                </form>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={4}>
              <form className="row" onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                run(async () => { await api(`/spray-mixes/${sheet.id}/products`, { body: { name: f.get("name"), ratePerAcre: num(f.get("ratePerAcre")), unit: f.get("unit") } }); form.reset(); onChange(); });
              }}>
                <input name="name" placeholder="New product" aria-label="New product name" required style={{ flex: 2, minWidth: 160 }} />
                <input name="ratePerAcre" type="number" step="any" min="0" placeholder="Rate/acre" aria-label="New product rate per acre" required style={{ width: 110 }} />
                <select name="unit" aria-label="New product measurement" style={{ width: 150 }}>{MIX_UNITS.map((u) => <option key={u}>{u}</option>)}</select>
                <button className="btn sm primary" disabled={busy}>Add product</button>
              </form>
            </td>
          </tr>
        </tbody>
      </table>
      <ErrorBox error={error} />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 13 }}>Every change is recorded below with who made it.</span>
        <button className="btn sm danger" onClick={() => confirm(`Delete the whole "${sheet.name}" sheet? This can't be undone.`) && run(async () => { await api(`/spray-mixes/${sheet.id}`, { method: "DELETE" }); onChange(); })}>Delete this mix</button>
      </div>
    </div>
  );
}

function Changes({ sheetId }: { sheetId: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useApi<any[]>(open ? `/spray-mixes/${sheetId}/changes` : null);
  return (
    <details className="card noprint" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><strong>Change history</strong></summary>
      {data?.length ? (
        <table><tbody>{data.map((c, i) => <tr key={i}><td>{c.summary}</td><td className="muted">{c.by}</td><td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(c.at)}</td></tr>)}</tbody></table>
      ) : data ? <Empty>No changes yet.</Empty> : null}
    </details>
  );
}

/** Admins pick which employees can edit (admins always can). */
function Editors() {
  const staff = useApi<any[]>("/employees");
  const current = useApi<string[]>("/spray-mixes/editors");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (current.data) setPicked(new Set(current.data)); }, [current.data]);
  if (!staff.data || !picked) return null;
  const people = staff.data.filter((e) => !isInactive(e.status) && !["admin", "owner"].includes(e.role));
  return (
    <details className="card noprint">
      <summary><strong>Who can edit</strong> <span className="muted">({picked.size} employee{picked.size === 1 ? "" : "s"} + admins)</span></summary>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: "10px 0 0" }}>
        <legend className="muted" style={{ fontSize: 13 }}>Admins can always edit. Everyone can use the calculator.</legend>
        <div className="formgrid">
          {people.map((e) => (
            <label key={e.id} className="check">
              <input type="checkbox" checked={picked.has(e.id)} onChange={(ev) => {
                const next = new Set(picked);
                if (ev.target.checked) next.add(e.id); else next.delete(e.id);
                setPicked(next);
                setSaved(false);
              }} /> {e.firstName} {e.lastName}<span className="muted"> · {e.role}</span>
            </label>
          ))}
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api("/spray-mixes/editors", { method: "PUT", body: { employeeIds: [...picked] } }); setSaved(true); })}>Save editors</button>
          {saved && <span className="muted" role="status">Saved.</span>}
        </div>
      </fieldset>
    </details>
  );
}

export default function SprayMix() {
  const { data, error, reload } = useApi("/spray-mixes");
  const [tab, setTab] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const action = useAction();
  if (!data) return <ErrorBox error={error} />;
  const sheet = data.sheets.find((s: any) => s.id === tab) ?? data.sheets[0];
  const saveSheet = async (body: Record<string, unknown>) => { await api(`/spray-mixes/${sheet.id}`, { method: "PATCH", body }); await reload(); };

  return (
    <>
      <PageHead title="Spray Mix Calculator" sub={`Enter the gallons you're mixing and press Update total to see how much of each product to add.${data.canEdit ? " To change a product, rate or measurement, click it." : ""}`}>
        <button className="btn noprint" onClick={() => window.print()}>Print</button>
        {data.canEdit && sheet && <button className={`btn noprint ${editing ? "primary" : ""}`} onClick={() => setEditing(!editing)}>{editing ? "Close settings" : "More settings"}</button>}
      </PageHead>
      {!data.sheets.length ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>No mix sheets yet.</p>
          {data.canEdit ? (
            <div className="row">
              <button className="btn primary" disabled={action.busy} onClick={() => action.run(async () => { await api("/spray-mixes/template", { method: "POST" }); reload(); })}>
                Start with the Truck, Backpack and ZSpray mixes
              </button>
              <span className="muted">From the original Spray Tank Fill spreadsheet.</span>
            </div>
          ) : <p className="muted" style={{ margin: 0 }}>Ask an admin to set them up.</p>}
          <ErrorBox error={action.error} />
        </div>
      ) : (
        <>
          <div className="tabs noprint" role="tablist" aria-label="Mix sheets" style={{ marginBottom: 12 }}>
            {data.sheets.map((s: any) => (
              <button key={s.id} role="tab" aria-selected={s.id === sheet.id} onClick={() => setTab(s.id)}>{s.name}</button>
            ))}
            {data.canEdit && (
              <button className="btn sm" style={{ marginLeft: "auto", alignSelf: "center" }} onClick={() => {
                const name = prompt("Name of the new mix (e.g. Backpack Mix)");
                if (name) action.run(async () => { const s = await api("/spray-mixes", { body: { name, gallonsPerAcre: 87.12, defaultTankGallons: 50 } }); await reload(); setTab(s.id); setEditing(true); });
              }}>+ New mix</button>
            )}
          </div>
          <section role="tabpanel" aria-label={sheet.name}>
            <h2 style={{ marginBottom: 2 }}>
              <Editable canEdit={data.canEdit} label="Mix name" value={sheet.name} width={320} onSave={(v) => saveSheet({ name: v })} />
            </h2>
            <p className="muted" style={{ marginTop: 0 }}>
              <Editable canEdit={data.canEdit} kind="number" width={90} label="Gallons of water per acre" value={sheet.gallonsPerAcre} display={formatEntered(sheet.gallonsPerAcre)}
                onSave={(v) => { if (!(Number(v) > 0)) throw new Error("Enter gallons per acre above 0."); return saveSheet({ gallonsPerAcre: Number(v) }); }} /> gallons/acre · {formatAmount(computeMix(sheet, 1).gallonsPer1000)} gallons/1000 ft² · default tank{" "}
              <Editable canEdit={data.canEdit} kind="number" width={90} label="Default tank (gallons)" value={sheet.defaultTankGallons} display={formatEntered(sheet.defaultTankGallons)}
                onSave={(v) => { if (!(Number(v) > 0)) throw new Error("Enter a tank size above 0."); return saveSheet({ defaultTankGallons: Number(v) }); }} /> gal
              {sheet.notes || data.canEdit ? " · " : ""}
              <Editable canEdit={data.canEdit} label="Notes" value={sheet.notes ?? ""} width={220} display={sheet.notes || (data.canEdit ? <em>add a note</em> : null)} onSave={(v) => saveSheet({ notes: v })} />
              {sheet.updatedBy ? ` · Last changed by ${sheet.updatedBy}, ${fmtDateTime(sheet.updatedAt)}` : ""}
            </p>
            <Calculator sheet={sheet} canEdit={data.canEdit} onChange={reload} />
            {editing && data.canEdit && <Editor sheet={sheet} onChange={reload} />}
            <Changes sheetId={sheet.id} />
          </section>
          {data.canManageEditors && <Editors />}
        </>
      )}
    </>
  );
}

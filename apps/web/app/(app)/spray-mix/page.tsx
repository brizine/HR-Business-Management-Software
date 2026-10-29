"use client";
import { useEffect, useState } from "react";
import { MIX_UNITS, computeMix, formatAmount, formatEntered } from "@crewdesk/shared";
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

/** Everyone: enter tank gallons, Update total. Nothing here is saved to the server. */
function Calculator({ sheet }: { sheet: any }) {
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
      <div className="card tablewrap mix-table-wrap">
        <table className="mix-table">
          <caption className="sr-only">Product needed for a {applied}-gallon tank of {sheet.name}</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Rate/Acre</th><th scope="col">Rate/1000 ft²</th><th scope="col">Measurement</th><th scope="col">Water volume</th><th scope="col">Product needed</th></tr></thead>
          <tbody>
            {mix.rows.map(({ product: p, ratePer1000, needed }) => (
              <tr key={p.id}>
                <th scope="row" style={{ fontWeight: 500 }}>{p.name}</th>
                <td>{formatEntered(p.ratePerAcre)}</td>
                <td>{formatAmount(ratePer1000)}</td>
                <td>{p.unit}</td>
                <td>{formatEntered(applied)} gal</td>
                <td><strong style={{ fontSize: 16 }}>{formatAmount(needed)}</strong> <span className="muted">{p.unit.split(" ")[0]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!mix.rows.length && <Empty>No products on this sheet yet.</Empty>}
      </div>
      {/* Phones: the amount to add first and large, rates underneath, so nothing scrolls sideways. */}
      <ul className="mix-cards" aria-label={`Product needed for a ${applied}-gallon tank`}>
        {mix.rows.map(({ product: p, ratePer1000, needed }) => (
          <li key={p.id} className="card">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <strong>{p.name}</strong>
              <span><strong style={{ fontSize: 20 }}>{formatAmount(needed)}</strong> <span className="muted">{p.unit}</span></span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>{formatEntered(p.ratePerAcre)}/acre · {formatAmount(ratePer1000)}/1000 ft²</div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Editors: change the sheet's settings and its products. */
function Editor({ sheet, onChange }: { sheet: any; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const num = (v: FormDataEntryValue | null) => Number(v);
  const unitOptions = (current: string) => [...new Set([...MIX_UNITS, current])];

  return (
    <div className="card stack noprint">
      <h2 style={{ margin: 0 }}>Edit {sheet.name}</h2>
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
  const people = staff.data.filter((e) => e.status !== "terminated" && !["admin", "owner"].includes(e.role));
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

  return (
    <>
      <PageHead title="Spray Mix Calculator" sub="Enter the gallons you're mixing and press Update total to see how much of each product to add.">
        <button className="btn noprint" onClick={() => window.print()}>Print</button>
        {data.canEdit && sheet && <button className={`btn noprint ${editing ? "primary" : ""}`} onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit products & rates"}</button>}
      </PageHead>
      {!data.sheets.length ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>No mix sheets yet.</p>
          {data.canEdit ? (
            <div className="row">
              <button className="btn primary" disabled={action.busy} onClick={() => action.run(async () => { await api("/spray-mixes/template", { method: "POST" }); reload(); })}>
                Start with the Truck Mix and Z spray Mix
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
            <h2 style={{ marginBottom: 2 }}>{sheet.name}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {formatEntered(sheet.gallonsPerAcre)} gallons/acre · {formatAmount(computeMix(sheet, 1).gallonsPer1000)} gallons/1000 ft²
              {sheet.notes ? ` · ${sheet.notes}` : ""}
              {sheet.updatedBy ? ` · Last changed by ${sheet.updatedBy}, ${fmtDateTime(sheet.updatedAt)}` : ""}
            </p>
            <Calculator sheet={sheet} />
            {editing && data.canEdit && <Editor sheet={sheet} onChange={reload} />}
            <Changes sheetId={sheet.id} />
          </section>
          {data.canManageEditors && <Editors />}
        </>
      )}
    </>
  );
}

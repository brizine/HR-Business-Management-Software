"use client";
import { useMemo, useState } from "react";
import {
  CUSTOM_FIELD_TARGETS, CUSTOM_FIELD_TARGET_LABELS, CUSTOM_FIELD_TYPE_LABELS, formatCustomValue,
  type CustomFieldDef, type CustomFieldTarget,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Icon } from "@/components/icons";
import { NewFieldModal } from "@/components/custom-fields";

/**
 * Custom fields (Homeworks' Custom Fields page): every field with its type, what it applies to, its
 * default value and whether it's transferable. Owners and admins add fields, rename them, set the
 * default (✓ saves it), tick Transferable, reorder and delete, one or several at a time.
 */
export default function CustomFields() {
  const { can } = useAuth();
  const admin = can("admin");
  const list = useApi<CustomFieldDef[]>("/custom-fields");
  const [target, setTarget] = useState<CustomFieldTarget | "">("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const act = useAction();
  const all = list.data ?? [];
  const rows = useMemo(() => all
    .filter((f) => !target || f.appliesTo === target)
    .filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => CUSTOM_FIELD_TARGETS.indexOf(a.appliesTo) - CUSTOM_FIELD_TARGETS.indexOf(b.appliesTo)), [all, target, q]);
  const update = (f: CustomFieldDef, body: Record<string, unknown>) => act.run(async () => { await api(`/custom-fields/${f.id}`, { method: "PUT", body }); await list.reload(); });
  const move = (f: CustomFieldDef, dir: -1 | 1) => act.run(async () => {
    const same = all.filter((x) => x.appliesTo === f.appliesTo);
    const i = same.findIndex((x) => x.id === f.id);
    const j = i + dir;
    if (j < 0 || j >= same.length) return;
    [same[i], same[j]] = [same[j], same[i]];
    await api("/custom-fields/order", { method: "PUT", body: { ids: same.map((x) => x.id) } });
    await list.reload();
  });
  const remove = (ids: string[]) => act.run(async () => {
    await api("/custom-fields/delete", { body: { ids } });
    setPicked([]);
    await list.reload();
  });
  const toggleAll = (on: boolean) => setPicked(on ? rows.map((f) => f.id) : []);

  return (
    <>
      <PageHead title="Custom fields" sub={list.data ? `${all.length} field${all.length === 1 ? "" : "s"} · your own fields on customers, properties, work orders, to-dos, invoices and equipment` : undefined}>
        {admin && <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> New field</button>}
      </PageHead>
      {!admin && <div className="notice">Only owners and admins can add or change custom fields.</div>}
      <div className="card filters">
        <label>Applies to
          <select value={target} onChange={(e) => setTarget(e.target.value as CustomFieldTarget | "")}>
            <option value="">Applies to all</option>
            {CUSTOM_FIELD_TARGETS.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TARGET_LABELS[t]}</option>)}
          </select>
        </label>
        <label>Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Field name" /></label>
      </div>
      <ErrorBox error={list.error ?? act.error} />
      {list.data && !rows.length ? (
        <div className="card"><Empty>{all.length ? "No fields match." : "No custom fields yet. Add one, like Front Yard Sq Ft on properties or Gallons used on work orders."}</Empty></div>
      ) : (
        <div className="card tablewrap">
          <table className="cf-table">
            <thead>
              <tr>
                {admin && <th style={{ width: 30 }}><input type="checkbox" aria-label="Select all" checked={!!rows.length && picked.length === rows.length} onChange={(e) => toggleAll(e.target.checked)} /></th>}
                <th>Field name / label</th><th>Field type</th><th>Field applies to</th><th>Default value</th><th>Transferable</th>{admin && <th aria-label="Order and delete" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => <FieldRow key={f.id} f={f} admin={admin} picked={picked.includes(f.id)}
                onPick={(on) => setPicked((p) => (on ? [...p, f.id] : p.filter((x) => x !== f.id)))}
                onUpdate={(body) => update(f, body)} onMove={(d) => move(f, d)} onDelete={() => confirm(`Delete "${f.name}"? Its values stop showing everywhere.`) && remove([f.id])} busy={act.busy} />)}
            </tbody>
          </table>
          {admin && picked.length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn danger" disabled={act.busy} onClick={() => confirm(`Delete ${picked.length} field${picked.length === 1 ? "" : "s"}? Their values stop showing everywhere.`) && remove(picked)}>Delete {picked.length} selected</button>
            </div>
          )}
        </div>
      )}
      {adding && <NewFieldModal appliesTo={target || undefined} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} />}
    </>
  );
}

function FieldRow({ f, admin, picked, onPick, onUpdate, onMove, onDelete, busy }: {
  f: CustomFieldDef; admin: boolean; picked: boolean; onPick: (on: boolean) => void; onUpdate: (body: Record<string, unknown>) => void;
  onMove: (d: -1 | 1) => void; onDelete: () => void; busy: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(f.name);
  const [choices, setChoices] = useState(f.options.join("\n"));
  const [def, setDef] = useState(f.defaultValue ?? "");
  const defChanged = def !== (f.defaultValue ?? "");
  return (
    <tr>
      {admin && <td><input type="checkbox" aria-label={`Select ${f.name}`} checked={picked} onChange={(e) => onPick(e.target.checked)} /></td>}
      <td>
        {renaming ? (
          <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); onUpdate({ name, ...(f.type === "select" ? { options: choices.split(/\n|,/).map((s) => s.trim()).filter(Boolean) } : {}) }); setRenaming(false); }}>
            <input autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-label="Field name" />
            {f.type === "select" && <textarea rows={3} value={choices} onChange={(e) => setChoices(e.target.value)} aria-label="Choices, one per line" />}
            <div className="row"><button className="btn primary" disabled={busy || !name.trim()}>Save</button><button type="button" className="btn" onClick={() => { setRenaming(false); setName(f.name); }}>Cancel</button></div>
          </form>
        ) : admin ? (
          <button type="button" className="linkbtn cf-name" title="Rename" onClick={() => setRenaming(true)}>{f.name}</button>
        ) : f.name}
        {f.type === "select" && !renaming && <div className="muted" style={{ fontSize: 12 }}>{f.options.join(" · ")}</div>}
      </td>
      <td>{CUSTOM_FIELD_TYPE_LABELS[f.type]}</td>
      <td>{CUSTOM_FIELD_TARGET_LABELS[f.appliesTo]}</td>
      <td>
        {admin ? (
          <form className="input-addon cf-default" onSubmit={(e) => { e.preventDefault(); onUpdate({ defaultValue: def.trim() === "" ? null : def }); }}>
            {f.type === "checkbox" ? (
              <select aria-label={`Default for ${f.name}`} value={def} onChange={(e) => setDef(e.target.value)}><option value="">Unticked</option><option value="true">Ticked</option></select>
            ) : f.type === "select" ? (
              <select aria-label={`Default for ${f.name}`} value={def} onChange={(e) => setDef(e.target.value)}><option value="">None</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
            ) : <input aria-label={`Default for ${f.name}`} type={f.type === "date" ? "date" : "text"} value={def} onChange={(e) => setDef(e.target.value)} placeholder="None" />}
            <button className={`btn${defChanged ? " primary" : ""}`} disabled={busy || !defChanged} aria-label={`Save the default for ${f.name}`} title="Save">✓</button>
          </form>
        ) : formatCustomValue(f, f.defaultValue) || <span className="muted">None</span>}
      </td>
      <td><input type="checkbox" aria-label={`${f.name} is transferable`} checked={f.transferable} disabled={!admin || busy} onChange={(e) => onUpdate({ transferable: e.target.checked })} /></td>
      {admin && (
        <td className="cf-row-actions">
          <button type="button" className="btn" aria-label={`Move ${f.name} up`} disabled={busy} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="btn" aria-label={`Move ${f.name} down`} disabled={busy} onClick={() => onMove(1)}>↓</button>
          <button type="button" className="btn danger" aria-label={`Delete ${f.name}`} disabled={busy} onClick={onDelete}>Delete</button>
        </td>
      )}
    </tr>
  );
}

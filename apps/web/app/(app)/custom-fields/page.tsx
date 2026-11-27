"use client";
import { useMemo, useState } from "react";
import {
  CUSTOM_FIELD_TARGETS, CUSTOM_FIELD_TARGET_LABELS, CUSTOM_FIELD_TYPE_LABELS, formatCustomValue,
  type CustomFieldDef, type CustomFieldTarget, type PropertyBuiltin,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Grip, useDragOrder } from "@/components/drag-order";
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
  // A field moves among the fields for the same kind of record. With a search on, the ones it hides keep their places.
  const byId = new Map(all.map((f) => [f.id, f]));
  const drag = useDragOrder(rows.map((f) => f.id), (next, moved) => act.run(async () => {
    const kind = byId.get(moved)!.appliesTo;
    const shownNow = next.filter((id) => byId.get(id)?.appliesTo === kind);
    const slots = all.filter((x) => x.appliesTo === kind).map((x) => x.id);
    let n = 0;
    const ids = slots.map((id) => (shownNow.includes(id) ? shownNow[n++] : id));
    await api("/custom-fields/order", { method: "PUT", body: { ids } });
    await list.reload();
  }), { disabled: !admin, busy: act.busy, groupOf: (id) => byId.get(id)?.appliesTo ?? "" });
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
                {admin && <th className="drag-col" aria-label="Order" />}
                {admin && <th style={{ width: 30 }}><input type="checkbox" aria-label="Select all" checked={!!rows.length && picked.length === rows.length} onChange={(e) => toggleAll(e.target.checked)} /></th>}
                <th>Field name / label</th><th>Field type</th><th>Field applies to</th><th>Default value</th><th>Transferable</th>{admin && <th aria-label="Delete" />}
              </tr>
            </thead>
            <tbody ref={drag.box}>
              {drag.sorted(rows, (f) => f.id).map((f) => <FieldRow key={f.id} f={f} admin={admin} picked={picked.includes(f.id)} drag={drag}
                onPick={(on) => setPicked((p) => (on ? [...p, f.id] : p.filter((x) => x !== f.id)))}
                onUpdate={(body) => update(f, body)} onDelete={() => confirm(`Delete "${f.name}"? Its values stop showing everywhere.`) && remove([f.id])} busy={act.busy} />)}
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

/** What Crewdesk does with each of its own property fields. */
const BUILTIN_USE: Record<PropertyBuiltin, string> = {
  mapCode: "it groups routes and the dispatch map", frontSqFt: "a size services can be priced from", backSqFt: "a size services can be priced from",
  otherSqFt: "a size services can be priced from", lawnSqFt: "the size services are priced from unless they say otherwise", gateCode: "shown to the crew on the work order",
  pets: "shown to the crew, and flags a dog on the waiting list", accessNotes: "shown to the crew on the work order", notes: "office notes on the property",
};

function FieldRow({ f, admin, picked, onPick, onUpdate, drag, onDelete, busy }: {
  f: CustomFieldDef; admin: boolean; picked: boolean; onPick: (on: boolean) => void; onUpdate: (body: Record<string, unknown>) => void;
  drag: ReturnType<typeof useDragOrder>; onDelete: () => void; busy: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(f.name);
  const [choices, setChoices] = useState(f.options.join("\n"));
  const [def, setDef] = useState(f.defaultValue ?? "");
  const defChanged = def !== (f.defaultValue ?? "");
  return (
    <tr {...drag.row(f.id)}>
      {admin && <td className="drag-col"><Grip drag={drag} id={f.id} name={f.name} /></td>}
      {admin && <td>{f.builtin ? null : <input type="checkbox" aria-label={`Select ${f.name}`} checked={picked} onChange={(e) => onPick(e.target.checked)} />}</td>}
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
        {f.builtin && !renaming && <div className="muted" style={{ fontSize: 12 }}>Crewdesk uses this one itself ({BUILTIN_USE[f.builtin]}). Rename it or move it; it can&apos;t be deleted.</div>}
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
          {!f.builtin && <button type="button" className="btn danger" aria-label={`Delete ${f.name}`} disabled={busy} onClick={onDelete}>Delete</button>}
        </td>
      )}
    </tr>
  );
}

"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  CUSTOM_FIELD_TARGETS, CUSTOM_FIELD_TARGET_LABELS, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, customDefault, formatCustomValue,
  type CustomFieldDef, type CustomFieldTarget, type CustomFieldType, type CustomValue, type CustomValues,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Icon } from "./icons";
import { ErrorBox } from "./ui";

/** Tells every list of custom fields on the page to reload (a field was added). */
export const fieldsChanged = () => window.dispatchEvent(new Event("crewdesk:custom-fields"));
/** The company's custom fields for one kind of record (reloads when one is added anywhere on the page). */
export function useCustomFields(target: CustomFieldTarget | null) {
  const list = useApi<CustomFieldDef[]>(target ? `/custom-fields?appliesTo=${target}` : null);
  useEffect(() => {
    const reload = () => list.reload();
    window.addEventListener("crewdesk:custom-fields", reload);
    return () => window.removeEventListener("crewdesk:custom-fields", reload);
  }, [list.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

/** Where a transferable field's value comes from, for the hint on a new record. */
const FROM: Partial<Record<CustomFieldTarget, string>> = {
  workorder: "the property or customer", todo: "the property or customer", invoice: "the work order or customer", property: "the bill-to customer",
};
const ONE: Record<CustomFieldTarget, string> = { customer: "customer", property: "property", workorder: "work order", todo: "to-do", invoice: "invoice", asset: "piece of equipment" };
const blank = (v: unknown) => v === null || v === undefined || v === "";

/** One input for a field, by its type. */
export function FieldInput({ f, value, onChange, placeholder }: { f: CustomFieldDef; value: CustomValue | undefined; onChange: (v: CustomValue | "") => void; placeholder?: string }) {
  const id = `cf-${f.id}`;
  const str = blank(value) ? "" : String(value);
  switch (f.type) {
    case "checkbox":
      return <label className="check" htmlFor={id}><input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> Yes</label>;
    case "date":
      return <input id={id} type="date" value={str} onChange={(e) => onChange(e.target.value)} />;
    case "select":
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{placeholder ? `(${placeholder.toLowerCase()})` : "—"}</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
          {str && !f.options.includes(str) && <option value={str}>{str} (no longer a choice)</option>}
        </select>
      );
    case "integer":
    case "decimal":
      return <input id={id} inputMode={f.type === "integer" ? "numeric" : "decimal"} value={str} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
    default:
      // Crewdesk's own note fields on a property get room to write.
      if (f.builtin === "accessNotes" || f.builtin === "notes") return <textarea id={id} rows={2} maxLength={2000} value={str} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
      return <input id={id} maxLength={2000} value={str} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

/**
 * The custom field inputs on a form (Homeworks' "Custom Fields" box): a label and an input for each,
 * then Reset to defaults, Clear, and (owners and admins) Add custom field. On a new record the
 * defaults are filled in; transferable fields left blank are filled from the record it's made for.
 */
export function CustomFieldInputs({ target, values, onChange, fresh, title = "Custom fields", tools = true }: {
  target: CustomFieldTarget; values: CustomValues; onChange: (v: CustomValues) => void; fresh?: boolean; title?: string;
  /** Reset to defaults and Clear (left out where the box holds a record's main details). */
  tools?: boolean;
}) {
  const { can } = useAuth();
  const admin = can("admin");
  const list = useCustomFields(target);
  const fields = list.data ?? [];
  const [adding, setAdding] = useState(false);
  const filled = useRef(false);
  // A new record starts with each field's default (transferable ones wait for the record they're made for).
  useEffect(() => {
    if (!fresh || filled.current || !list.data) return;
    filled.current = true;
    const next = { ...values };
    for (const f of list.data) if (!f.transferable && blank(next[f.id])) { const d = customDefault(f); if (d !== null) next[f.id] = d; }
    onChange(next);
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.data || (!fields.length && !admin)) return null;
  // Blanks are kept as "" so saving clears them.
  const set = (id: string, v: CustomValue | "") => onChange({ ...values, [id]: v });
  const reset = () => onChange(Object.fromEntries(fields.map((f) => [f.id, customDefault(f) ?? ""])) as CustomValues);
  return (
    <fieldset className="cf-box">
      <legend>{title}</legend>
      {fields.length ? (
        <div className="cf-grid">
          {fields.map((f) => {
            const hint = fresh && f.transferable && FROM[target] ? `From ${FROM[target]} if left blank` : f.defaultValue && !fresh ? `Default: ${f.defaultValue}` : undefined;
            return (
              <div key={f.id} className="cf-row">
                <label htmlFor={`cf-${f.id}`} className="cf-label">{f.name}</label>
                <FieldInput f={f} value={values[f.id]} onChange={(v) => set(f.id, v)} placeholder={hint} />
              </div>
            );
          })}
        </div>
      ) : <p className="muted" style={{ margin: 0 }}>No custom fields for {CUSTOM_FIELD_TARGET_LABELS[target].toLowerCase()} yet.</p>}
      <div className="row cf-actions">
        {tools && fields.length > 0 && <button type="button" className="btn" onClick={reset}>Reset to defaults</button>}
        {tools && fields.length > 0 && <button type="button" className="btn" onClick={() => onChange(Object.fromEntries(fields.map((f) => [f.id, ""])))}>Clear</button>}
        {admin && <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add custom field</button>}
      </div>
      {adding && <NewFieldModal appliesTo={target} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); fieldsChanged(); }} />}
    </fieldset>
  );
}

/** The fields with their values, read only (blank ones left out unless `showBlank`). */
export function CustomValueList({ fields, values, showBlank }: { fields: CustomFieldDef[]; values: CustomValues | null | undefined; showBlank?: boolean }) {
  const shown = fields.filter((f) => showBlank || !blank(values?.[f.id]));
  if (!shown.length) return null;
  return (
    <dl className="facts">
      {shown.map((f) => <div key={f.id} style={{ display: "contents" }}><dt>{f.name}</dt><dd>{formatCustomValue(f, values?.[f.id]) || <span className="muted">—</span>}</dd></div>)}
    </dl>
  );
}

/**
 * A record's custom fields on its page (Homeworks' "Save Custom Fields"): the values, and Edit for
 * whoever may change them. Hidden when the company has none (owners and admins see Add custom field).
 */
export function CustomFieldsCard({ target, id, canEdit, values: given, onSaved }: {
  target: CustomFieldTarget; id: string; canEdit: boolean; values?: CustomValues | null; onSaved?: (v: CustomValues) => void;
}) {
  const { can } = useAuth();
  const admin = can("admin");
  const list = useCustomFields(target);
  const fetched = useApi<CustomValues>(given === undefined ? `/custom-fields/values/${target}/${id}` : null);
  const [saved, setSaved] = useState<CustomValues | null>(null);
  const values = saved ?? (given !== undefined ? given ?? {} : fetched.data ?? {});
  const [editing, setEditing] = useState<CustomValues | null>(null);
  const [adding, setAdding] = useState(false);
  const save = useAction();
  useEffect(() => { setSaved(null); }, [given]);
  const fields = list.data ?? [];
  if (!list.data || (!fields.length && !admin)) return null;
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Custom fields</h2>
        <div className="row">
          {canEdit && fields.length > 0 && !editing && <button type="button" className="btn" onClick={() => setEditing({ ...values })}>Edit</button>}
          {admin && !editing && <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add custom field</button>}
        </div>
      </div>
      {editing ? (
        <>
          <CustomFieldInputs target={target} values={editing} onChange={setEditing} title="Values" />
          <ErrorBox error={save.error} />
          <div className="row">
            <button type="button" className="btn primary" disabled={save.busy} onClick={() => save.run(async () => {
              // Send every field, so cleared ones are cleared.
              const body = Object.fromEntries(fields.map((f) => [f.id, editing[f.id] ?? ""]));
              const v = await api<CustomValues>(`/custom-fields/values/${target}/${id}`, { method: "PUT", body: { values: body } });
              setSaved(v); setEditing(null); onSaved?.(v);
            })}>{save.busy ? "Saving…" : "Save custom fields"}</button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </>
      ) : fields.length ? (
        <CustomValueList fields={fields} values={values} showBlank />
      ) : <p className="muted" style={{ margin: 0 }}>No custom fields for {CUSTOM_FIELD_TARGET_LABELS[target].toLowerCase()} yet.</p>}
      {adding && <NewFieldModal appliesTo={target} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); fieldsChanged(); }} />}
    </div>
  );
}

/** Homeworks' "Add New Field": applies to, field name / label, field type, transferable, default value. */
export function NewFieldModal({ appliesTo, onClose, onSaved }: { appliesTo?: CustomFieldTarget; onClose: () => void; onSaved: (f: CustomFieldDef) => void }) {
  const [target, setTarget] = useState<CustomFieldTarget>(appliesTo ?? "property");
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldType>("text");
  const [choices, setChoices] = useState("");
  const [transferable, setTransferable] = useState(false);
  const [def, setDef] = useState<CustomValue | "">("");
  const save = useAction();
  const options = choices.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
  const probe: CustomFieldDef = { id: "new", appliesTo: target, name, type, options, defaultValue: null, transferable };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="cal-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="cal-modal card stack cf-modal" role="dialog" aria-label="Add new field" onSubmit={(e) => {
        e.preventDefault();
        save.run(async () => {
          const f = await api<CustomFieldDef>("/custom-fields", { body: { appliesTo: target, name, type, options: type === "select" ? options : [], transferable, defaultValue: def === "" ? null : def } });
          onSaved(f);
        });
      }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Add new field</h2>
          <button type="button" className="btn" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        <label>Applies to
          <select value={target} onChange={(e) => setTarget(e.target.value as CustomFieldTarget)}>
            {CUSTOM_FIELD_TARGETS.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TARGET_LABELS[t]}</option>)}
          </select>
        </label>
        <label>Field name / label<input required autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Front Yard Sq Ft, Grass type, Gallons used…" /></label>
        <label>Field type
          <select value={type} onChange={(e) => { setType(e.target.value as CustomFieldType); setDef(""); }}>
            {CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        {type === "select" && <label>Choices (one per line)<textarea rows={4} value={choices} onChange={(e) => setChoices(e.target.value)} placeholder={"Bermuda\nFescue\nZoysia"} /></label>}
        <div className="stack" style={{ gap: 4 }}>
          <span className="todo-label">Transferable field</span>
          <label className="check"><input type="checkbox" checked={transferable} onChange={(e) => setTransferable(e.target.checked)} /> Yes</label>
          <span className="muted" style={{ fontSize: 12 }}>
            A new {ONE[target]} copies this value from a field with the same name on {FROM[target] ?? "the record it's made for"}.
            {(target === "workorder" || target === "todo") && " Names like Front Yard Sq Ft, Back Yard Sq Ft or Total Sq Ft also fill from the property's measured lawn."}
          </span>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <span className="todo-label">Default value</span>
          <FieldInput f={probe} value={def === "" ? undefined : def} onChange={setDef} placeholder="Enter value here" />
        </div>
        <ErrorBox error={save.error} />
        <div className="row todo-form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.busy || !name.trim() || (type === "select" && !options.length)}>{save.busy ? "Saving…" : "Save field"}</button>
        </div>
      </form>
    </div>
  );
}

/** A record's filled-in custom values as <dt>/<dd> pairs, to drop into an existing list of facts. */
export function CustomFacts({ target, values }: { target: CustomFieldTarget; values: CustomValues | null | undefined }) {
  const list = useCustomFields(values && Object.keys(values).length ? target : null);
  return <>{(list.data ?? []).filter((f) => !blank(values?.[f.id])).map((f) => <Fragment key={f.id}><dt>{f.name}</dt><dd>{formatCustomValue(f, values?.[f.id])}</dd></Fragment>)}</>;
}

/** A record's filled-in custom values as table rows (the to-do job sheet). */
export function CustomRows({ target, values }: { target: CustomFieldTarget; values: CustomValues | null | undefined }) {
  const list = useCustomFields(values && Object.keys(values).length ? target : null);
  return <>{(list.data ?? []).filter((f) => !blank(values?.[f.id])).map((f) => <tr key={f.id}><th scope="row">{f.name}</th><td>{formatCustomValue(f, values?.[f.id])}</td></tr>)}</>;
}

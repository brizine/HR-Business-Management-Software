"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  FORM_FIELD_HINTS, FORM_FIELD_LABELS, FORM_FIELD_TYPES, FORM_HTML_MESSAGE, FORM_LABEL_MAX, FORM_NAME_MAX, FORM_PHOTOS_MAX, VISIT_FILE_MAX_BYTES, cleanFormDef, containsHtml, emptyFormDef,
  hasChoices, isSigned, newFormField, newFormOption, newFormSection, visitNumber,
  type FormAnswers, type FormChange, type FormDef, type FormField, type FormFieldType, type FormOption, type FormSection, type FormSignature, type FormSignatures,
} from "@crewdesk/shared";
import { API_URL, api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ConfirmDialog } from "./automation-bits";
import { useTags } from "./customers";
import { Icon } from "./icons";
import { shrink } from "./visit-files";

/**
 * Marketing → Visit Forms, laid out like Homeworks: the forms list, the form builder (sections of
 * questions, a signature box, attach to every new work order or by service), the preview, and the
 * form as the crew fills it in on a work order. Crewdesk adds required questions, more kinds of
 * question, answers that tag or make a to-do, a PDF and an optional copy to the customer, a
 * history of changes, and the list of everything submitted.
 */

export interface VisitFormRow {
  id: string; name: string; autoAttach: boolean; updatedAt: string; fields: number; signature: boolean; linked: number; submitted: number;
  mustSubmit: boolean; emailCopy: boolean; flags: boolean; serviceTypeIds: string[];
}
export interface VisitFormFull { id: string; name: string; def: FormDef; autoAttach: boolean; serviceTypeIds: string[]; linked: number; submitted: number }
/** A form on a work order, as lists show it. */
export interface WorkOrderForm { id: string; formId: string | null; name: string; submitted: boolean; submittedAt: string | null; submittedBy: string | null; mustSubmit?: boolean }
interface HistoryRow { id: string; action: "submitted" | "updated" | "emailed"; at: string; by: string | null; changes: FormChange[]; detail: string | null }
interface Entry extends WorkOrderForm {
  def: FormDef; answers: FormAnswers; signature: FormSignature | null; signatures: FormSignatures; updatedAt: string | null; updatedBy: string | null;
  canFill: boolean; locked: boolean; emailedAt: string | null; emailedTo: string | null; canEmail: boolean; history: HistoryRow[]; flagged?: string[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });


/** What each kind of question adds to a form (shown when the pointer rests on its button). */
const FIELD_TIPS: Record<(typeof FORM_FIELD_TYPES)[number], string> = {
  text: "Add a question answered in a few words",
  textarea: "Add a question with room for a longer answer",
  checkbox: "Add a list of boxes to tick: as many as apply",
  dropdown: "Add a question answered by picking one choice from a list",
  yesno: "Add a yes or no question",
  number: "Add a question answered with a number",
  date: "Add a question answered with a date",
  photo: "Ask the crew for photos",
  signature: "Ask for a signature, drawn on the screen",
};
function Dialog({ title, children, foot, onClose, className = "" }: { title: string; children: ReactNode; foot?: ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  return (
    <div className="hw-dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`hw-dialog hwf-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="hw-dialog-head"><span>{title}</span><button type="button" className="hw-dialog-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="hw-dialog-body">{children}</div>
        {foot && <div className="hw-dialog-foot">{foot}</div>}
      </div>
    </div>
  );
}

/**
 * Prints only the form on screen: a copy of it is put on a page of its own (answers written out
 * in full, so a long note isn't cut off at the size of its box) and the rest is left out.
 */
function printForm() {
  const src = document.querySelector<HTMLElement>(".hwf-print");
  if (!src) return;
  const copy = src.cloneNode(true) as HTMLElement;
  const from = src.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
  copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach((el, i) => {
    const o = from[i];
    if (el instanceof HTMLInputElement && el.type === "file") { el.remove(); return; }
    // A radio keeps its tick but leaves its group, so the copy can't untick the one on screen.
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) { el.removeAttribute("name"); el.checked = (o as HTMLInputElement).checked; return; }
    const line = document.createElement("div");
    line.className = `hwf-print-answer${o instanceof HTMLTextAreaElement ? " long" : ""}`;
    line.textContent = o instanceof HTMLSelectElement ? (o.value ? o.selectedOptions[0]?.text ?? "" : "")
      : o instanceof HTMLInputElement && o.type === "date" && o.value ? new Date(`${o.value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : o.value;
    el.replaceWith(line);
  });
  document.getElementById("hwf-print-root")?.remove();
  const root = document.createElement("div");
  root.id = "hwf-print-root";
  root.appendChild(copy);
  document.body.appendChild(root);
  document.body.classList.add("hwf-printing");
  const done = () => { document.body.classList.remove("hwf-printing"); root.remove(); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
}

/* ───────────── The signature box ───────────── */

/** Sign with a mouse, a finger or a pen. Kept as its strokes, in the size of the box it was drawn in. */
export function SignaturePad({ value, onChange, disabled, label }: { value: FormSignature | null; onChange: (s: FormSignature | null) => void; disabled?: boolean; label: string }) {
  const box = useRef<SVGSVGElement>(null);
  const drawing = useRef(false);
  const size = value ? { w: value.w, h: value.h } : null;
  const point = (e: RPointerEvent<SVGSVGElement>) => {
    const r = box.current!.getBoundingClientRect();
    const w = size?.w ?? Math.round(r.width), h = size?.h ?? Math.round(r.height);
    const n = (v: number) => Math.round(v * 10) / 10;
    return { w, h, x: n((e.clientX - r.left) * (w / r.width)), y: n((e.clientY - r.top) * (h / r.height)) };
  };
  const down = (e: RPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.preventDefault();
    box.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    // A tap leaves a dot.
    onChange({ w: p.w, h: p.h, d: `${value?.d ? `${value.d} ` : ""}M${p.x} ${p.y} L${p.x + 0.6} ${p.y + 0.6}` });
  };
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drawing.current || disabled || !value) return;
    const p = point(e);
    onChange({ ...value, d: `${value.d} L${p.x} ${p.y}` });
  };
  const up = () => { drawing.current = false; };
  return (
    <div className="hwf-sign">
      <svg ref={box} className={`hwf-sign-box${disabled ? " off" : ""}`} role="img" aria-label={isSigned(value) ? `${label}: signed` : `${label}: sign here`}
        viewBox={size ? `0 0 ${size.w} ${size.h}` : undefined} preserveAspectRatio="xMidYMid meet"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {value?.d && <path d={value.d} fill="none" stroke="#111" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {!disabled && <button type="button" className="hwf-clear" disabled={!isSigned(value)} onClick={() => onChange(null)}>Clear</button>}
    </div>
  );
}

/* ───────────── The form, as it's filled in ───────────── */

const Star = () => <span className="hwf-star" aria-hidden="true"> *</span>;

/** A photo question: the pictures taken for it (kept with the work order's photos), and adding more. */
function PhotoAnswer({ visitId, label, ids, onChange, disabled }: { visitId?: string; label: string; ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (picked: FileList | null) => {
    const all = [...(picked ?? [])].slice(0, FORM_PHOTOS_MAX - ids.length);
    if (!all.length || !visitId) return;
    setError(null);
    const made: string[] = [];
    for (const [i, raw] of all.entries()) {
      setBusy(`Uploading ${i + 1} of ${all.length}…`);
      try {
        const f = await shrink(raw);
        if (f.size > VISIT_FILE_MAX_BYTES) throw new Error(`${raw.name} is over 25 MB`);
        const fd = new FormData();
        fd.append("caption", label.slice(0, 300));
        fd.append("file", f, f.name);
        made.push((await api<{ id: string }>(`/visits/${visitId}/files`, { method: "POST", body: fd })).id);
      } catch (e) { setError((e as Error).message); break; }
    }
    setBusy(null);
    if (made.length) onChange([...ids, ...made]);
    if (input.current) input.current.value = "";
  };
  return (
    <div className="hwf-photos">
      {ids.map((id) => (
        <span className="hwf-photo" key={id}>
          {visitId && <a href={`${API_URL}/visits/${visitId}/files/${id}`} target="_blank" rel="noopener noreferrer"><img src={`${API_URL}/visits/${visitId}/files/${id}`} alt={label} loading="lazy" /></a>}
          {!disabled && <button type="button" aria-label="Take this photo off the form" title="Take it off the form (it stays in the work order's photos)" onClick={() => onChange(ids.filter((x) => x !== id))}>×</button>}
        </span>
      ))}
      {!disabled && ids.length < FORM_PHOTOS_MAX && (
        <>
          <button type="button" className="btn hw-soft" disabled={!visitId || !!busy} onClick={() => input.current?.click()}><Icon name="plus" size={14} /> {busy ?? "Add photo"}</button>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" multiple hidden onChange={(e) => void add(e.target.files)} />
        </>
      )}
      {disabled && !ids.length && <span className="muted">No photo</span>}
      {error && <span className="hwf-error">{error}</span>}
    </div>
  );
}

/**
 * A form's questions with their answers: typed into, ticked, photographed and signed, or just
 * shown. `visitId` is the work order it's on (photo questions keep their pictures there); without
 * one (the builder's preview) photos can't be added.
 */
export function FormView({ def, answers, signature, signatures = {}, onAnswers, onSignature, onSignatures, disabled, visitId }: {
  def: FormDef; answers: FormAnswers; signature: FormSignature | null; signatures?: FormSignatures;
  onAnswers?: (a: FormAnswers) => void; onSignature?: (s: FormSignature | null) => void; onSignatures?: (s: FormSignatures) => void; disabled?: boolean; visitId?: string;
}) {
  const set = (id: string, v: string | string[]) => onAnswers?.({ ...answers, [id]: v });
  const off = disabled || !onAnswers;
  const sign = (id: string, s: FormSignature | null) => { const next = { ...signatures }; if (s) next[id] = s; else delete next[id]; onSignatures?.(next); };
  return (
    <div className="hwf-view">
      {def.sections.map((s) => (
        <div className="hwf-view-section" key={s.id}>
          {s.name && <h3>{s.name}</h3>}
          {s.fields.map((f) => {
            const a = answers[f.id];
            const label = <>{f.label}{f.required && <Star />}</>;
            if (f.type === "checkbox" || f.type === "yesno") {
              const ticked = Array.isArray(a) ? a : typeof a === "string" && a ? [a] : [];
              const one = f.type === "yesno";
              return (
                <fieldset className={`hwf-q${one ? " yesno" : ""}`} key={f.id} disabled={off}>
                  <legend>{label}</legend>
                  {f.options.map((o) => (
                    <label className="hwf-tick" key={o.id}>
                      <input type={one ? "radio" : "checkbox"} name={one ? `q-${f.id}` : undefined} checked={ticked.includes(o.id)}
                        onChange={() => set(f.id, one ? o.id : ticked.includes(o.id) ? ticked.filter((x) => x !== o.id) : [...ticked, o.id])}
                        onClick={() => { if (one && ticked.includes(o.id) && !f.required) set(f.id, ""); }} />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </fieldset>
              );
            }
            if (f.type === "photo") return <div className="hwf-q" key={f.id}><span>{label}</span><PhotoAnswer visitId={visitId} label={f.label} ids={Array.isArray(a) ? a : []} disabled={off} onChange={(ids) => set(f.id, ids)} /></div>;
            if (f.type === "signature") return <div className="hwf-q" key={f.id}><span>{label}</span><SignaturePad label={f.label || "Signature"} value={signatures[f.id] ?? null} disabled={off || !onSignatures} onChange={(sg) => sign(f.id, sg)} /></div>;
            return (
              <label className="hwf-q" key={f.id}>
                <span>{label}</span>
                {f.type === "text" && <input type="text" maxLength={500} disabled={off} value={typeof a === "string" ? a : ""} onChange={(e) => set(f.id, e.target.value)} />}
                {f.type === "number" && <input type="text" inputMode="decimal" maxLength={20} className="hwf-short" disabled={off} value={typeof a === "string" ? a : ""} onChange={(e) => set(f.id, e.target.value.replace(/[^0-9.,-]/g, ""))} />}
                {f.type === "date" && <input type="date" className="hwf-short" disabled={off} value={typeof a === "string" ? a : ""} onChange={(e) => set(f.id, e.target.value)} />}
                {f.type === "textarea" && <textarea rows={5} maxLength={10_000} disabled={off} value={typeof a === "string" ? a : ""} onChange={(e) => set(f.id, e.target.value)} />}
                {f.type === "dropdown" && (
                  <select disabled={off} value={typeof a === "string" ? a : ""} onChange={(e) => set(f.id, e.target.value)}>
                    <option value="">Select an option...</option>
                    {f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                )}
              </label>
            );
          })}
        </div>
      ))}
      {def.signature && (
        <div className="hwf-q">
          <span>{def.signatureLabel || "Signature"}{def.signatureRequired && <Star />}</span>
          <SignaturePad label={def.signatureLabel || "Signature"} value={signature} disabled={off || !onSignature} onChange={(s) => onSignature?.(s)} />
        </div>
      )}
      {!def.sections.some((s) => s.fields.length) && !def.signature && <p className="muted" style={{ margin: 0 }}>This form has no questions yet.</p>}
      {(def.signatureRequired || def.sections.some((s) => s.fields.some((f) => f.required))) && <p className="muted hwf-note">(<span className="hwf-star">*</span>: Required Fields)</p>}
    </div>
  );
}

/* ───────────── The list ───────────── */

/** Marketing → Visit Forms: Homeworks' table (Form Name, Last Modified, linked work orders, Auto Attached, Actions). */
export function VisitFormsList() {
  const list = useApi<VisitFormRow[]>("/visit-forms");
  const [del, setDel] = useState<VisitFormRow | null>(null);
  const act = useAction();
  const remove = (f: VisitFormRow) => void act.run(async () => { setDel(null); await api(`/visit-forms/${f.id}`, { method: "DELETE" }); await list.reload(); });
  const rows = list.data ?? [];
  return (
    <>
      <div className="hw-top-right"><Link className="btn hw-and" href="/visit-forms/new"><Icon name="plus" size={14} /> New Form</Link></div>
      {(list.error ?? act.error) && <div className="hw-errors">{list.error ?? act.error}</div>}
      <div className="card hw-table-card">
        <div className="tablewrap">
          <table className="hw-table hwf-table">
            <thead><tr><th>Form Name</th><th>Last Modified</th><th>Work Orders Linked</th><th>Auto Attached</th><th className="c-actions">Actions</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>
                    <Link className="hwf-name" href={`/visit-forms/${f.id}`}>{f.name}</Link>
                    {f.mustSubmit && <span className="hwf-tag" title="The work order can't be marked Completed until this form is submitted">Needed to complete</span>}
                    {f.emailCopy && <span className="hwf-tag" title="The customer is emailed a copy when the work order is completed">Emails the customer</span>}
                    {f.flags && <span className="hwf-tag" title="Some answers add a tag or make a to-do for the office">Flags answers</span>}
                  </td>
                  <td>{day(f.updatedAt)}</td>
                  <td>{f.linked}{f.linked > 0 && <span className="muted"> · {f.submitted} submitted</span>}</td>
                  <td><span className={`hwf-pill ${f.autoAttach || f.serviceTypeIds.length ? "yes" : "no"}`}>{f.autoAttach ? "Yes" : f.serviceTypeIds.length ? `By service (${f.serviceTypeIds.length})` : "No"}</span></td>
                  <td className="c-actions">
                    <span className="hw-row-actions">
                      <Link className="hw-icon-btn" href={`/visit-forms/${f.id}`} aria-label={`Edit ${f.name}`} title="Edit"><Icon name="pencil" size={17} /></Link>
                      <button type="button" className="hw-icon-btn danger" aria-label={`Delete ${f.name}`} title="Delete" onClick={() => setDel(f)}><Icon name="trash" size={17} /></button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && !rows.length && <div className="hwf-none">No Forms Found</div>}
      </div>
      {del && (
        <ConfirmDialog title="Delete Form" onYes={() => remove(del)} onNo={() => setDel(null)}
          message={<>By deleting this form, <strong>unfilled form</strong> from visit event will be removed.{del.submitted > 0 && <> The {del.submitted} already submitted stay{del.submitted === 1 ? "s" : ""} on {del.submitted === 1 ? "its work order" : "their work orders"}.</>}</>} />
      )}
    </>
  );
}

/* ───────────── The builder ───────────── */

const move = <T,>(list: T[], i: number, by: number) => { const j = i + by; if (j < 0 || j >= list.length) return list; const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; return next; };

/** What picking a choice does for the office: a tag on the customer and the work order, a to-do, or both. */
function OptionFlag({ option, tags, onChange }: { option: FormOption; tags: { id: string; name: string }[]; onChange: (patch: Partial<FormOption>) => void }) {
  return (
    <div className="hwf-flag">
      <span>When this is picked:</span>
      <select aria-label="Add a tag" value={option.tagId ?? ""} onChange={(e) => onChange({ tagId: e.target.value || null })}>
        <option value="">No tag</option>
        {tags.map((t) => <option key={t.id} value={t.id}>Add the tag “{t.name}”</option>)}
      </select>
      <label><input type="checkbox" checked={!!option.todo} onChange={(e) => onChange({ todo: e.target.checked })} /> Make a to-do for the office</label>
    </div>
  );
}

/** New Form / edit a form: Homeworks' builder, with Crewdesk's extra kinds of question and settings. */
export function FormBuilder({ form }: { form?: VisitFormFull }) {
  const router = useRouter();
  const [name, setName] = useState(form?.name ?? "");
  const [def, setDef] = useState<FormDef>(() => (form ? { ...form.def, sections: form.def.sections.length ? form.def.sections : [newFormSection()] } : emptyFormDef()));
  const [autoAttach, setAutoAttach] = useState(form?.autoAttach ?? false);
  const [serviceTypeIds, setServiceTypeIds] = useState<string[]>(form?.serviceTypeIds ?? []);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  /** The choices whose "when this is picked" row is open. */
  const [flagOpen, setFlagOpen] = useState<string[]>([]);
  const save = useAction();
  const copy = useAction();
  const { tags } = useTags();
  const services = useApi<{ id: string; name: string }[]>("/service-types");

  const setSection = (id: string, fn: (s: FormSection) => FormSection) => setDef((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? fn(s) : s)) }));
  const setField = (sid: string, fid: string, fn: (f: FormField) => FormField) => setSection(sid, (s) => ({ ...s, fields: s.fields.map((f) => (f.id === fid ? fn(f) : f)) }));
  const setOption = (sid: string, fid: string, oid: string, patch: Partial<FormOption>) => setField(sid, fid, (x) => ({ ...x, options: x.options.map((y) => (y.id === oid ? { ...y, ...patch } : y)) }));
  const add = (sid: string, type: FormFieldType) => setSection(sid, (s) => ({ ...s, fields: [...s.fields, newFormField(type)] }));
  const hasHtml = () => [name, def.signatureLabel, ...def.sections.flatMap((s) => [s.name, ...s.fields.flatMap((f) => [f.label, ...f.options.map((o) => o.label)])])].some((t) => containsHtml(t));

  const submit = () => {
    setSaved(null);
    if (hasHtml()) { setWarn(FORM_HTML_MESSAGE); return; }
    void save.run(async () => {
      const body = { name, def, autoAttach, serviceTypeIds };
      if (form) { await api(`/visit-forms/${form.id}`, { method: "PUT", body }); setSaved("Form saved"); }
      else { await api("/visit-forms", { body }); router.push("/visit-forms"); }
    });
  };
  const openPreview = () => { if (hasHtml()) { setWarn(FORM_HTML_MESSAGE.replace("submitting", "previewing")); return; } setPreview(true); };
  const duplicate = () => void copy.run(async () => { const c = await api<{ id: string }>(`/visit-forms/${form!.id}/copy`, { method: "POST" }); router.push(`/visit-forms/${c.id}`); });
  const shown = useMemo(() => cleanFormDef(def), [def]);
  const unpicked = (services.data ?? []).filter((s) => !serviceTypeIds.includes(s.id));

  return (
    <div className="card hwf-builder">
      <div className="hwf-builder-top">
        {form ? <button type="button" className="btn hw-soft" disabled={copy.busy} onClick={duplicate}>{copy.busy ? "Duplicating…" : "Duplicate Form"}</button> : <span />}
        <button type="button" className="btn hw-and" onClick={openPreview}><Icon name="search" size={14} /> Preview</button>
      </div>
      <input type="text" className="hwf-name-input" aria-label="Form name" placeholder="Form name" maxLength={FORM_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} />

      {def.sections.map((s, si) => (
        <div key={s.id} className="hwf-section-wrap">
          <div className="hwf-section">
            <div className="hwf-section-bar">
              {def.sections.length > 1 && (
                <>
                  <button type="button" className="hw-icon-btn" title="Move section up" aria-label="Move section up" disabled={si === 0} onClick={() => setDef((d) => ({ ...d, sections: move(d.sections, si, -1) }))}>↑</button>
                  <button type="button" className="hw-icon-btn" title="Move section down" aria-label="Move section down" disabled={si === def.sections.length - 1} onClick={() => setDef((d) => ({ ...d, sections: move(d.sections, si, 1) }))}>↓</button>
                  <button type="button" className="hw-icon-btn danger" title="Remove section" aria-label={`Remove section ${s.name || si + 1}`} onClick={() => setDef((d) => ({ ...d, sections: d.sections.filter((x) => x.id !== s.id) }))}><Icon name="trash" size={15} /></button>
                </>
              )}
            </div>
            <div className="hwf-block">
              <input type="text" aria-label="Section name" placeholder="Section name" maxLength={FORM_LABEL_MAX} value={s.name} onChange={(e) => setSection(s.id, (x) => ({ ...x, name: e.target.value }))} />
            </div>
            {s.fields.map((f, fi) => (
              <div className="hwf-block" key={f.id} data-type={f.type}>
                <div className="hwf-block-head">
                  <input type="text" aria-label={FORM_FIELD_HINTS[f.type]} placeholder={FORM_FIELD_HINTS[f.type]} maxLength={FORM_LABEL_MAX} value={f.label} onChange={(e) => setField(s.id, f.id, (x) => ({ ...x, label: e.target.value }))} />
                  <span className="hwf-block-tools">
                    <button type="button" className="hw-icon-btn" title="Move up" aria-label="Move up" disabled={fi === 0} onClick={() => setSection(s.id, (x) => ({ ...x, fields: move(x.fields, fi, -1) }))}>↑</button>
                    <button type="button" className="hw-icon-btn" title="Move down" aria-label="Move down" disabled={fi === s.fields.length - 1} onClick={() => setSection(s.id, (x) => ({ ...x, fields: move(x.fields, fi, 1) }))}>↓</button>
                    <button type="button" className="hw-icon-btn danger" title="Remove" aria-label={`Remove ${f.label || FORM_FIELD_LABELS[f.type]}`} onClick={() => setSection(s.id, (x) => ({ ...x, fields: x.fields.filter((y) => y.id !== f.id) }))}><Icon name="trash" size={15} /></button>
                  </span>
                </div>
                {(f.type === "text" || f.type === "number" || f.type === "date") && <input type="text" className={`hwf-sample${f.type === "text" ? "" : " hwf-short"}`} disabled aria-hidden="true" tabIndex={-1} placeholder={f.type === "number" ? "0" : f.type === "date" ? "mm/dd/yyyy" : undefined} />}
                {f.type === "textarea" && <textarea className="hwf-sample" rows={2} disabled aria-hidden="true" tabIndex={-1} />}
                {f.type === "photo" && <span className="btn hw-soft hwf-sample-btn" aria-hidden="true"><Icon name="plus" size={14} /> Add photo</span>}
                {f.type === "signature" && <div className="hwf-sample hwf-sample-sign" aria-hidden="true" />}
                {hasChoices(f.type) && (
                  <>
                    {f.options.map((o) => {
                      const key = `${f.id}:${o.id}`, open = flagOpen.includes(key) || !!o.tagId || !!o.todo;
                      return (
                        <div className="hwf-option-wrap" key={o.id}>
                          <div className={`hwf-option ${f.type}`}>
                            {f.type !== "dropdown" && <span className={`hwf-box${f.type === "yesno" ? " round" : ""}`} aria-hidden="true" />}
                            {f.type === "yesno" ? <span className="hwf-fixed">{o.label}</span> : (
                              <input type="text" aria-label={f.type === "checkbox" ? "Checkbox name" : "Option"} placeholder={f.type === "checkbox" ? "Checkbox name" : "Option"} maxLength={FORM_LABEL_MAX} value={o.label}
                                onChange={(e) => setOption(s.id, f.id, o.id, { label: e.target.value })} />
                            )}
                            <button type="button" className={`hw-icon-btn hwf-flag-btn${o.tagId || o.todo ? " on" : ""}`} title="When this is picked: add a tag or make a to-do" aria-label={`What picking ${o.label || "this"} does`} aria-expanded={open}
                              onClick={() => setFlagOpen((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]))}>⚑</button>
                            {f.type !== "yesno" && <button type="button" className="hw-icon-btn" title="Remove" aria-label={`Remove ${o.label || "option"}`} disabled={f.options.length < 2} onClick={() => setField(s.id, f.id, (x) => ({ ...x, options: x.options.filter((y) => y.id !== o.id) }))}>×</button>}
                          </div>
                          {open && <OptionFlag option={o} tags={tags} onChange={(patch) => setOption(s.id, f.id, o.id, patch)} />}
                        </div>
                      );
                    })}
                    {f.type !== "yesno" && <button type="button" className="btn hw-and hwf-add-option" onClick={() => setField(s.id, f.id, (x) => ({ ...x, options: [...x.options, newFormOption()] }))}>{f.type === "checkbox" ? "Add New Checkbox" : "Add New Option"}</button>}
                  </>
                )}
                <label className="hwf-required"><input type="checkbox" checked={!!f.required} onChange={(e) => setField(s.id, f.id, (x) => ({ ...x, required: e.target.checked }))} /> Required</label>
              </div>
            ))}
          </div>
          <div className="hwf-add" role="group" aria-label="Add a field">
            <strong>Add:</strong>
            {FORM_FIELD_TYPES.map((t) => <button key={t} type="button" data-tip={FIELD_TIPS[t]} onClick={() => add(s.id, t)}>{FORM_FIELD_LABELS[t]}</button>)}
          </div>
        </div>
      ))}

      {def.signature && (
        <div className="hwf-section">
          <div className="hwf-section-bar" />
          <div className="hwf-block">
            <input type="text" aria-label="Signature label" placeholder="Signature" maxLength={FORM_LABEL_MAX} value={def.signatureLabel} onChange={(e) => setDef((d) => ({ ...d, signatureLabel: e.target.value }))} />
            <label className="hwf-required"><input type="checkbox" checked={!!def.signatureRequired} onChange={(e) => setDef((d) => ({ ...d, signatureRequired: e.target.checked }))} /> Required</label>
          </div>
        </div>
      )}
      <label className="hwf-check"><input type="checkbox" checked={def.signature} onChange={(e) => setDef((d) => ({ ...d, signature: e.target.checked }))} /> Accept Signature with this form.</label>
      <div><button type="button" className="btn hw-and" onClick={() => setDef((d) => ({ ...d, sections: [...d.sections, newFormSection()] }))}><Icon name="plus" size={14} /> Add New Section</button></div>
      <label className="hwf-check"><input type="checkbox" checked={autoAttach} onChange={(e) => setAutoAttach(e.target.checked)} /> Automatically attach to new work orders</label>
      <div className="hwf-services">
        <span>Or attach to new work orders that include one of these services:</span>
        <div className="hwf-services-row">
          {serviceTypeIds.map((id) => {
            const svc = services.data?.find((x) => x.id === id);
            return <span className="hwf-chip" key={id}><button type="button" aria-label={`Remove ${svc?.name ?? "service"}`} onClick={() => setServiceTypeIds((k) => k.filter((x) => x !== id))}>×</button>{svc?.name ?? "…"}</span>;
          })}
          <select aria-label="Add a service" value="" disabled={!unpicked.length} onChange={(e) => { if (e.target.value) setServiceTypeIds((k) => [...k, e.target.value]); }}>
            <option value="">{services.data && !services.data.length ? "No services on the price list yet" : unpicked.length ? "Add a service…" : "Every service is picked"}</option>
            {unpicked.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      </div>
      <label className="hwf-check"><input type="checkbox" checked={!!def.mustSubmit} onChange={(e) => setDef((d) => ({ ...d, mustSubmit: e.target.checked }))} /> Must be submitted before the work order can be marked Completed</label>
      <label className="hwf-check"><input type="checkbox" checked={!!def.emailCopy} onChange={(e) => setDef((d) => ({ ...d, emailCopy: e.target.checked }))} /> Email the customer a copy when the work order is completed</label>
      {def.emailCopy && <p className="muted hwf-note hwf-indent">The copy goes as a PDF with the “Visit form copy (Crewdesk)” email, which you can reword under <Link href="/templates">Marketing → Templates</Link>. Leave this off and a copy can still be sent by hand from any submitted form.</p>}
      {form && form.linked > 0 && <p className="muted hwf-note">On {form.linked} work order{form.linked === 1 ? "" : "s"}{form.submitted ? `, submitted on ${form.submitted}` : ""}. Saving changes the copies that haven&apos;t been submitted; submitted ones stay as they were answered.</p>}
      {save.error && <div className="hwf-error" role="alert">{save.error}</div>}
      {saved && <div className="hwd-success" role="status"><div>{saved}</div><button type="button" aria-label="Close" onClick={() => setSaved(null)}>×</button></div>}
      <div className="hwf-actions">
        <Link className="btn hw-and" href="/visit-forms">Cancel</Link>
        <button type="button" className="btn hw-and" disabled={save.busy} onClick={submit}>{save.busy ? "Saving…" : "Save Form"}</button>
      </div>

      {preview && <FormPreview name={name} def={shown} onClose={() => setPreview(false)} />}
      {warn && <Dialog title="Visit Form" className="hwf-small" onClose={() => setWarn(null)} foot={<button type="button" className="btn hw-and" onClick={() => setWarn(null)}>OK</button>}>{warn}</Dialog>}
    </div>
  );
}

/** Homeworks' Visit Form Preview: the form as the crew will see it (try it; nothing is saved), with Print. */
function FormPreview({ name, def, onClose }: { name: string; def: FormDef; onClose: () => void }) {
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [signature, setSignature] = useState<FormSignature | null>(null);
  const [signatures, setSignatures] = useState<FormSignatures>({});
  return (
    <Dialog title="Visit Form Preview" onClose={onClose} foot={<><button type="button" className="btn hw-soft" onClick={printForm}><Icon name="print" size={14} /> Print</button><button type="button" className="btn hw-and" onClick={onClose}>Close</button></>}>
      <div className="hwf-print">
        <h2 className="hwf-print-title">{name || "Visit form"}</h2>
        <FormView def={def} answers={answers} signature={signature} signatures={signatures} onAnswers={setAnswers} onSignature={setSignature} onSignatures={setSignatures} />
      </div>
    </Dialog>
  );
}

/* ───────────── On the work order form: which forms it gets ───────────── */

/**
 * Homeworks' "Visit Forms" box on a visit: search and pick as many as wanted (the list stays open).
 * On a new work order the forms set to attach automatically start picked, and adding a service
 * picks the forms tied to it.
 */
export function VisitFormsPicker({ value, onChange, attached = [], serviceIds = [] }: { value: string[] | null; onChange: (ids: string[]) => void; attached?: WorkOrderForm[]; serviceIds?: string[] }) {
  const list = useApi<VisitFormRow[]>("/visit-forms");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const forms = list.data ?? [];
  /** The services already looked at (a work order being edited starts with its own, so only ones added now pick forms). */
  const seen = useRef<Set<string> | null>(value === null ? new Set() : null);
  // Nothing chosen yet on a new work order: the automatic ones.
  useEffect(() => { if (value === null && list.data) onChange(list.data.filter((f) => f.autoAttach).map((f) => f.id)); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // A service added to the work order brings the forms tied to it.
  const serviceKey = [...serviceIds].sort().join(",");
  useEffect(() => {
    if (!list.data || value === null) return;
    if (!seen.current) { seen.current = new Set(serviceIds); return; }
    const fresh = serviceIds.filter((id) => !seen.current!.has(id));
    fresh.forEach((id) => seen.current!.add(id));
    const add = list.data.filter((f) => f.serviceTypeIds.some((id) => fresh.includes(id)) && !value.includes(f.id)).map((f) => f.id);
    if (add.length) onChange([...value, ...add]);
  }, [serviceKey, list.data, value === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const away = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  const picked = value ?? [];
  const toggle = (id: string) => onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const shown = forms.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()));
  // A form that was on it has been taken off: Homeworks' notice.
  const takenOff = attached.some((a) => a.formId && !picked.includes(a.formId));
  const kept = attached.filter((a) => a.submitted && (!a.formId || !picked.includes(a.formId)));
  if (list.data && !forms.length && !attached.length) return <p className="muted" style={{ margin: 0 }}>No visit forms yet. Make one on <Link href="/visit-forms">Marketing → Visit Forms</Link>.</p>;
  return (
    <div className="hwf-picker" ref={wrap}>
      {takenOff && <div className="hwf-alert" role="status"><strong>Any Unfilled forms will be removed from visit event.</strong> Saved form will remain.</div>}
      <div className={`hwf-picker-box${open ? " open" : ""}`} onClick={() => setOpen(true)}>
        {picked.map((id) => {
          const f = forms.find((x) => x.id === id);
          return f ? <span className="hwf-chip" key={id}><button type="button" aria-label={`Remove ${f.name}`} onClick={(e) => { e.stopPropagation(); toggle(id); }}>×</button>{f.name}</span> : null;
        })}
        <input type="search" aria-label="Visit Forms" placeholder={picked.length ? "" : "Search visit forms..."} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); if (e.key === "Backspace" && !q && picked.length) toggle(picked[picked.length - 1]); }} />
        {picked.length > 0 && <button type="button" className="hwf-picker-clear" aria-label="Remove all visit forms" onClick={(e) => { e.stopPropagation(); onChange([]); }}>×</button>}
      </div>
      {open && (
        <ul className="hwf-picker-list" role="listbox" aria-multiselectable="true" aria-label="Visit forms">
          {shown.map((f) => (
            <li key={f.id} role="option" aria-selected={picked.includes(f.id)} className={picked.includes(f.id) ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(f.id)}>
              {f.name}{f.autoAttach ? <span className="muted"> · attaches to every new work order</span> : f.serviceTypeIds.length ? <span className="muted"> · attaches by service</span> : null}
            </li>
          ))}
          {!shown.length && <li className="none">No results found</li>}
        </ul>
      )}
      {kept.length > 0 && <p className="muted hwf-note">Already submitted, so {kept.length === 1 ? "it stays" : "they stay"} on this work order: {kept.map((k) => k.name).join(", ")}.</p>}
    </div>
  );
}

/* ───────────── On the work order: the forms, and filling one in ───────────── */

function Status({ submitted }: { submitted: boolean }) {
  return (
    <span className={`hwf-status ${submitted ? "done" : ""}`} aria-label={submitted ? "Submitted" : "Not submitted"} title={submitted ? "Submitted" : "Not submitted"}>
      {submitted && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
    </span>
  );
}

/** The work order's "Visit forms": each with whether it's been submitted; click one to fill it in or read it. */
export function WorkOrderForms({ visitId, forms, onChanged }: { visitId: string; forms: WorkOrderForm[]; onChanged: () => void }) {
  const [open, setOpen] = useState<WorkOrderForm | null>(null);
  if (!forms.length) return null;
  return (
    <div className="card hwf-wo">
      <h3>Visit forms</h3>
      <ol className="hwf-wo-list">
        {forms.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => setOpen(f)}>
              <Status submitted={f.submitted} />
              <span className="hwf-wo-name">{f.name}</span>
              {!f.submitted && f.mustSubmit && <span className="hwf-tag warn">Needed before Completed</span>}
              {f.submitted && f.submittedAt && <span className="muted hwf-wo-who">{f.submittedBy ?? "Unknown author"} · {when(f.submittedAt)}</span>}
              <Icon name="right" size={18} />
            </button>
          </li>
        ))}
      </ol>
      {open && <FillDialog visitId={visitId} entryId={open.id} title={open.name} onClose={() => setOpen(null)} onSaved={onChanged} />}
    </div>
  );
}

const sameAnswers = (a: FormAnswers, b: FormAnswers) => JSON.stringify(Object.entries(a).filter(([, v]) => (Array.isArray(v) ? v.length : v)).sort()) === JSON.stringify(Object.entries(b).filter(([, v]) => (Array.isArray(v) ? v.length : v)).sort());
const sameSigns = (a: FormSignatures, b: FormSignatures) => JSON.stringify(Object.entries(a).map(([k, v]) => [k, v?.d ?? ""]).filter(([, d]) => d).sort()) === JSON.stringify(Object.entries(b).map(([k, v]) => [k, v?.d ?? ""]).filter(([, d]) => d).sort());
const HISTORY_WORDS = { submitted: "Submitted", updated: "Changed", emailed: "Emailed" } as const;

/**
 * One form on a work order: Submit the first time, Update after (once something's changed), as in
 * Homeworks; with its history, a PDF, and (for the office) emailing the customer a copy.
 */
export function FillDialog({ visitId, entryId, title, onClose, onSaved }: { visitId: string; entryId: string; title: string; onClose: () => void; onSaved?: () => void }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [signature, setSignature] = useState<FormSignature | null>(null);
  const [signatures, setSignatures] = useState<FormSignatures>({});
  const [toast, setToast] = useState<string | null>(null);
  const [did, setDid] = useState<string[]>([]);
  const load = useAction();
  const save = useAction();
  const mail = useAction();
  const take = (e: Entry) => { setEntry(e); setAnswers(e.answers); setSignature(e.signature); setSignatures(e.signatures ?? {}); };
  useEffect(() => { void load.run(async () => take(await api<Entry>(`/visits/${visitId}/forms/${entryId}`))); }, [visitId, entryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!entry && (!sameAnswers(answers, entry.answers) || (signature?.d ?? "") !== (entry.signature?.d ?? "") || !sameSigns(signatures, entry.signatures ?? {}));
  const submit = () => void save.run(async () => {
    const was = entry!.submitted;
    const next = await api<Entry>(`/visits/${visitId}/forms/${entryId}`, { method: "PUT", body: { answers, signature, signatures } });
    take(next);
    setDid(next.flagged ?? []);
    setToast(was ? "Form updated" : "Form submitted");
    onSaved?.();
  });
  const email = () => void mail.run(async () => {
    const r = await api<{ to: string }>(`/visits/${visitId}/forms/${entryId}/email`, { method: "POST" });
    take(await api<Entry>(`/visits/${visitId}/forms/${entryId}`));
    setToast(`Emailed to ${r.to}`);
  });
  return (
    <Dialog title={title} onClose={onClose}
      foot={entry && (
        <>
          <button type="button" className="btn hw-soft" onClick={printForm}><Icon name="print" size={14} /> Print</button>
          <a className="btn hw-soft" href={`${API_URL}/visits/${visitId}/forms/${entryId}/pdf`} target="_blank" rel="noopener noreferrer"><Icon name="download" size={14} /> PDF</a>
          {entry.canEmail && <button type="button" className="btn hw-soft" disabled={mail.busy || dirty} title={dirty ? "Save your changes first" : entry.emailedAt ? "Send the customer another copy" : "Send the customer a copy (a PDF)"} onClick={() => { if (!entry.emailedAt || window.confirm(`A copy was already emailed to ${entry.emailedTo ?? "the customer"}. Send another?`)) email(); }}><Icon name="mail" size={14} /> {mail.busy ? "Sending…" : "Email to customer"}</button>}
          <span className="hwf-foot-gap" />
          {entry.canFill
            ? <button type="button" className="btn hw-and" disabled={save.busy || (entry.submitted && !dirty)} onClick={submit}>{save.busy ? "Saving…" : entry.submitted ? "Update" : "Submit"}</button>
            : <button type="button" className="btn hw-and" onClick={onClose}>Close</button>}
        </>
      )}>
      {(load.error ?? save.error ?? mail.error) && <div className="hwf-error" role="alert">{load.error ?? save.error ?? mail.error}</div>}
      {!entry && !load.error && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
      {entry && (
        <>
          {entry.locked && <div className="hwf-alert" role="note">This work order is on an invoice, so its forms are locked. Void the invoice to change them.</div>}
          <div className="hwf-print">
            <h2 className="hwf-print-title">{entry.name}</h2>
            {entry.submitted && entry.submittedAt && (
              <div className="hwf-author">
                <span>{entry.submittedBy ?? "Unknown author"}</span>
                <span>{when(entry.submittedAt)}</span>
              </div>
            )}
            <FormView def={entry.def} answers={answers} signature={signature} signatures={signatures} visitId={visitId}
              onAnswers={entry.canFill ? setAnswers : undefined} onSignature={entry.canFill ? setSignature : undefined} onSignatures={entry.canFill ? setSignatures : undefined} />
          </div>
          {!entry.canFill && !entry.locked && <p className="muted hwf-note">Only the crew on this work order or a manager can fill it in.</p>}
          {did.length > 0 && <div className="hwf-alert" role="status">{did.map((d) => <div key={d}>{d}</div>)}</div>}
          {entry.emailedAt && <p className="muted hwf-note">A copy was emailed to {entry.emailedTo ?? "the customer"} on {when(entry.emailedAt)}.</p>}
          {entry.history.length > 0 && (
            <details className="hwf-history">
              <summary>History ({entry.history.length})</summary>
              <ol>
                {entry.history.map((h) => (
                  <li key={h.id}>
                    <strong>{HISTORY_WORDS[h.action] ?? h.action}</strong> {h.by ? `by ${h.by}` : h.action === "emailed" ? "automatically" : ""} · {when(h.at)}
                    {h.detail && <div className="muted">{h.detail}</div>}
                    {h.changes.map((c, i) => <div className="muted" key={i}>{c.label}: {c.from || "(blank)"} → {c.to || "(blank)"}</div>)}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      {toast && <div className="hwf-toast" role="status" onAnimationEnd={() => setToast(null)}>{toast}</div>}
    </Dialog>
  );
}

/* ───────────── Submitted forms: the report, and a customer's ───────────── */

interface SubmittedRow {
  id: string; visitId: string; name: string; submittedAt: string; submittedBy: string | null; emailedAt: string | null; flags: number; summary: string;
  workOrder: { number: number; title: string; date: string | null; status: string }; customer: { id: string; name: string }; address: string;
}

/** Marketing → Visit Forms → Submitted: every submitted form, narrowed by form, dates, who and words; open one, or export the list. */
export function SubmittedForms({ customerId }: { customerId?: string }) {
  const filters = useApi<{ names: string[]; people: { id: string; name: string }[] }>("/visit-forms/submitted/filters");
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [byId, setById] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<SubmittedRow | null>(null);
  const query = new URLSearchParams({ ...(name ? { name } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(byId ? { byId } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(customerId ? { customerId } : {}) }).toString();
  const list = useApi<{ total: number; rows: SubmittedRow[] }>(`/visit-forms/submitted?${query}${query ? "&" : ""}limit=${limit}`);
  const rows = list.data?.rows ?? [];
  return (
    <>
      {customerId && <div className="hwf-alert" role="status">Showing one customer&apos;s forms{rows[0] ? `: ${rows[0].customer.name}` : ""}. <Link href="/visit-forms?tab=submitted">Show everyone&apos;s</Link></div>}
      <div className="card hwf-filters">
        <label>Form<select value={name} onChange={(e) => setName(e.target.value)}><option value="">All forms</option>{(filters.data?.names ?? []).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Submitted by<select value={byId} onChange={(e) => setById(e.target.value)}><option value="">Anyone</option>{(filters.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="grow">Search<input type="search" placeholder="Customer, address, work order or an answer" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <a className="btn hw-soft" href={`${API_URL}/visit-forms/submitted/export?${query}`}><Icon name="download" size={14} /> Export</a>
      </div>
      {list.error && <div className="hw-errors">{list.error}</div>}
      <div className="card hw-table-card">
        <div className="tablewrap">
          <table className="hw-table hwf-table hwf-submitted">
            <thead><tr><th>Submitted</th><th>Form</th><th>Work order</th><th>Customer</th><th>Submitted by</th><th>Answers</th><th className="c-actions">Actions</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{when(r.submittedAt)}</td>
                  <td>{r.name}{r.flags > 0 && <span className="hwf-tag warn" title="An answer on it added a tag or made a to-do">Flagged</span>}{r.emailedAt && <span className="hwf-tag" title={`Emailed to the customer ${when(r.emailedAt)}`}>Emailed</span>}</td>
                  <td><Link href={`/visits/${r.visitId}`}>{visitNumber(r.workOrder.number)}</Link> {r.workOrder.title}</td>
                  <td><Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link>{r.address && <div className="muted">{r.address}</div>}</td>
                  <td>{r.submittedBy ?? "—"}</td>
                  <td className="hwf-summary">{r.summary || "—"}</td>
                  <td className="c-actions"><button type="button" className="hw-icon-btn" aria-label={`Open ${r.name}`} title="Open" onClick={() => setOpen(r)}><Icon name="eye" size={17} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && !rows.length && <div className="hwf-none">No submitted forms{query ? " match" : " yet"}</div>}
        {list.data && list.data.total > rows.length && <div className="hw-top-right"><button type="button" className="btn hw-soft" onClick={() => setLimit((n) => n + 100)}>Show more ({rows.length} of {list.data.total})</button></div>}
      </div>
      {open && <FillDialog visitId={open.visitId} entryId={open.id} title={open.name} onClose={() => setOpen(null)} onSaved={list.reload} />}
    </>
  );
}

/** The customer's page: the forms submitted on their work orders, newest first. */
export function CustomerForms({ customerId }: { customerId: string }) {
  const list = useApi<{ total: number; rows: SubmittedRow[] }>(`/visit-forms/submitted?customerId=${customerId}&limit=8`);
  const [open, setOpen] = useState<SubmittedRow | null>(null);
  const rows = list.data?.rows ?? [];
  if (!rows.length) return null;
  return (
    <div className="card hwf-wo">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="cp-h">Visit forms<span className="muted" style={{ fontWeight: 400, fontSize: 14 }}> · {list.data!.total} submitted</span></h2>
        {list.data!.total > rows.length && <Link href={`/visit-forms?tab=submitted&customerId=${customerId}`}>See all</Link>}
      </div>
      <ol className="hwf-wo-list">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setOpen(r)}>
              <Status submitted />
              <span className="hwf-wo-name">{r.name}</span>
              <span className="muted hwf-wo-who">{visitNumber(r.workOrder.number)} · {r.submittedBy ?? "Unknown author"} · {when(r.submittedAt)}</span>
              <Icon name="right" size={18} />
            </button>
          </li>
        ))}
      </ol>
      {open && <FillDialog visitId={open.visitId} entryId={open.id} title={open.name} onClose={() => setOpen(null)} onSaved={list.reload} />}
    </div>
  );
}

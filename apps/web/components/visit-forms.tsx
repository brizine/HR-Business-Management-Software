"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  FORM_FIELD_HINTS, FORM_FIELD_LABELS, FORM_FIELD_TYPES, FORM_HTML_MESSAGE, FORM_LABEL_MAX, FORM_NAME_MAX, cleanFormDef, containsHtml, emptyFormDef, isSigned, newFormField,
  newFormOption, newFormSection,
  type FormAnswers, type FormDef, type FormField, type FormFieldType, type FormSection, type FormSignature,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ConfirmDialog } from "./automation-bits";
import { Icon } from "./icons";

/**
 * Marketing → Visit Forms, laid out like Homeworks: the forms list, the form builder (sections of
 * short text, long text, checkbox and dropdown questions, a signature box, attach to every new
 * work order), the preview, and the form as the crew fills it in on a work order.
 */

export interface VisitFormRow { id: string; name: string; autoAttach: boolean; updatedAt: string; fields: number; signature: boolean; linked: number; submitted: number }
export interface VisitFormFull { id: string; name: string; def: FormDef; autoAttach: boolean; linked: number; submitted: number }
/** A form on a work order, as lists show it. */
export interface WorkOrderForm { id: string; formId: string | null; name: string; submitted: boolean; submittedAt: string | null; submittedBy: string | null }
interface Entry extends WorkOrderForm { def: FormDef; answers: FormAnswers; signature: FormSignature | null; updatedAt: string | null; updatedBy: string | null; canFill: boolean }

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
    if (el instanceof HTMLInputElement && el.type === "checkbox") { el.checked = (o as HTMLInputElement).checked; return; }
    const line = document.createElement("div");
    line.className = `hwf-print-answer${o instanceof HTMLTextAreaElement ? " long" : ""}`;
    line.textContent = o instanceof HTMLSelectElement ? (o.value ? o.selectedOptions[0]?.text ?? "" : "") : o.value;
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

/** A form's questions with their answers: typed into, ticked and signed, or just shown. */
export function FormView({ def, answers, signature, onAnswers, onSignature, disabled }: {
  def: FormDef; answers: FormAnswers; signature: FormSignature | null;
  onAnswers?: (a: FormAnswers) => void; onSignature?: (s: FormSignature | null) => void; disabled?: boolean;
}) {
  const set = (id: string, v: string | string[]) => onAnswers?.({ ...answers, [id]: v });
  const off = disabled || !onAnswers;
  return (
    <div className="hwf-view">
      {def.sections.map((s) => (
        <div className="hwf-view-section" key={s.id}>
          {s.name && <h3>{s.name}</h3>}
          {s.fields.map((f) => {
            const a = answers[f.id];
            if (f.type === "checkbox") {
              const ticked = Array.isArray(a) ? a : [];
              return (
                <fieldset className="hwf-q" key={f.id} disabled={off}>
                  <legend>{f.label}</legend>
                  {f.options.map((o) => (
                    <label className="hwf-tick" key={o.id}>
                      <input type="checkbox" checked={ticked.includes(o.id)} onChange={() => set(f.id, ticked.includes(o.id) ? ticked.filter((x) => x !== o.id) : [...ticked, o.id])} />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </fieldset>
              );
            }
            return (
              <label className="hwf-q" key={f.id}>
                <span>{f.label}</span>
                {f.type === "text" && <input type="text" maxLength={500} disabled={off} value={typeof a === "string" ? a : ""} onChange={(e) => set(f.id, e.target.value)} />}
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
          <span>{def.signatureLabel || "Signature"}</span>
          <SignaturePad label={def.signatureLabel || "Signature"} value={signature} disabled={off || !onSignature} onChange={(s) => onSignature?.(s)} />
        </div>
      )}
      {!def.sections.some((s) => s.fields.length) && !def.signature && <p className="muted" style={{ margin: 0 }}>This form has no questions yet.</p>}
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
                  <td><Link className="hwf-name" href={`/visit-forms/${f.id}`}>{f.name}</Link></td>
                  <td>{day(f.updatedAt)}</td>
                  <td>{f.linked}{f.linked > 0 && <span className="muted"> · {f.submitted} submitted</span>}</td>
                  <td><span className={`hwf-pill ${f.autoAttach ? "yes" : "no"}`}>{f.autoAttach ? "Yes" : "No"}</span></td>
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

/** New Form / edit a form: Homeworks' builder. */
export function FormBuilder({ form }: { form?: VisitFormFull }) {
  const router = useRouter();
  const [name, setName] = useState(form?.name ?? "");
  const [def, setDef] = useState<FormDef>(() => (form ? { ...form.def, sections: form.def.sections.length ? form.def.sections : [newFormSection()] } : emptyFormDef()));
  const [autoAttach, setAutoAttach] = useState(form?.autoAttach ?? false);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const save = useAction();
  const copy = useAction();

  const setSection = (id: string, fn: (s: FormSection) => FormSection) => setDef((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? fn(s) : s)) }));
  const setField = (sid: string, fid: string, fn: (f: FormField) => FormField) => setSection(sid, (s) => ({ ...s, fields: s.fields.map((f) => (f.id === fid ? fn(f) : f)) }));
  const add = (sid: string, type: FormFieldType) => setSection(sid, (s) => ({ ...s, fields: [...s.fields, newFormField(type)] }));
  const hasHtml = () => [name, def.signatureLabel, ...def.sections.flatMap((s) => [s.name, ...s.fields.flatMap((f) => [f.label, ...f.options.map((o) => o.label)])])].some((t) => containsHtml(t));

  const submit = () => {
    setSaved(null);
    if (hasHtml()) { setWarn(FORM_HTML_MESSAGE); return; }
    void save.run(async () => {
      const body = { name, def, autoAttach };
      if (form) { await api(`/visit-forms/${form.id}`, { method: "PUT", body }); setSaved("Form saved"); }
      else { await api("/visit-forms", { body }); router.push("/visit-forms"); }
    });
  };
  const openPreview = () => { if (hasHtml()) { setWarn(FORM_HTML_MESSAGE.replace("submitting", "previewing")); return; } setPreview(true); };
  const duplicate = () => void copy.run(async () => { const c = await api<{ id: string }>(`/visit-forms/${form!.id}/copy`, { method: "POST" }); router.push(`/visit-forms/${c.id}`); });
  const shown = useMemo(() => cleanFormDef(def), [def]);

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
                {f.type === "text" && <input type="text" className="hwf-sample" disabled aria-hidden="true" tabIndex={-1} />}
                {f.type === "textarea" && <textarea className="hwf-sample" rows={2} disabled aria-hidden="true" tabIndex={-1} />}
                {(f.type === "checkbox" || f.type === "dropdown") && (
                  <>
                    {f.options.map((o) => (
                      <div className={`hwf-option ${f.type}`} key={o.id}>
                        {f.type === "checkbox" && <span className="hwf-box" aria-hidden="true" />}
                        <input type="text" aria-label={f.type === "checkbox" ? "Checkbox name" : "Option"} placeholder={f.type === "checkbox" ? "Checkbox name" : "Option"} maxLength={FORM_LABEL_MAX} value={o.label}
                          onChange={(e) => setField(s.id, f.id, (x) => ({ ...x, options: x.options.map((y) => (y.id === o.id ? { ...y, label: e.target.value } : y)) }))} />
                        <button type="button" className="hw-icon-btn" title="Remove" aria-label={`Remove ${o.label || "option"}`} disabled={f.options.length < 2} onClick={() => setField(s.id, f.id, (x) => ({ ...x, options: x.options.filter((y) => y.id !== o.id) }))}>×</button>
                      </div>
                    ))}
                    <button type="button" className="btn hw-and hwf-add-option" onClick={() => setField(s.id, f.id, (x) => ({ ...x, options: [...x.options, newFormOption()] }))}>{f.type === "checkbox" ? "Add New Checkbox" : "Add New Option"}</button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="hwf-add" role="group" aria-label="Add a field">
            <strong>Add:</strong>
            {FORM_FIELD_TYPES.map((t) => <button key={t} type="button" onClick={() => add(s.id, t)}>{FORM_FIELD_LABELS[t]}</button>)}
          </div>
        </div>
      ))}

      {def.signature && (
        <div className="hwf-section">
          <div className="hwf-section-bar" />
          <div className="hwf-block">
            <input type="text" aria-label="Signature label" placeholder="Signature" maxLength={FORM_LABEL_MAX} value={def.signatureLabel} onChange={(e) => setDef((d) => ({ ...d, signatureLabel: e.target.value }))} />
          </div>
        </div>
      )}
      <label className="hwf-check"><input type="checkbox" checked={def.signature} onChange={(e) => setDef((d) => ({ ...d, signature: e.target.checked }))} /> Accept Signature with this form.</label>
      <div><button type="button" className="btn hw-and" onClick={() => setDef((d) => ({ ...d, sections: [...d.sections, newFormSection()] }))}><Icon name="plus" size={14} /> Add New Section</button></div>
      <label className="hwf-check"><input type="checkbox" checked={autoAttach} onChange={(e) => setAutoAttach(e.target.checked)} /> Automatically attach to new work orders</label>
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
  return (
    <Dialog title="Visit Form Preview" onClose={onClose} foot={<><button type="button" className="btn hw-soft" onClick={printForm}><Icon name="print" size={14} /> Print</button><button type="button" className="btn hw-and" onClick={onClose}>Close</button></>}>
      <div className="hwf-print">
        <h2 className="hwf-print-title">{name || "Visit form"}</h2>
        <FormView def={def} answers={answers} signature={signature} onAnswers={setAnswers} onSignature={setSignature} />
      </div>
    </Dialog>
  );
}

/* ───────────── On the work order form: which forms it gets ───────────── */

/**
 * Homeworks' "Visit Forms" box on a visit: search and pick as many as wanted (the list stays open).
 * On a new work order the forms set to attach automatically start picked.
 */
export function VisitFormsPicker({ value, onChange, attached = [] }: { value: string[] | null; onChange: (ids: string[]) => void; attached?: WorkOrderForm[] }) {
  const list = useApi<VisitFormRow[]>("/visit-forms");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const forms = list.data ?? [];
  // Nothing chosen yet on a new work order: the automatic ones.
  useEffect(() => { if (value === null && list.data) onChange(list.data.filter((f) => f.autoAttach).map((f) => f.id)); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
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
            <li key={f.id} role="option" aria-selected={picked.includes(f.id)} className={picked.includes(f.id) ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(f.id)}>{f.name}{f.autoAttach && <span className="muted"> · attaches to every new work order</span>}</li>
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

/** One form on a work order: Submit the first time, Update after (once something's changed), as in Homeworks. */
function FillDialog({ visitId, entryId, title, onClose, onSaved }: { visitId: string; entryId: string; title: string; onClose: () => void; onSaved: () => void }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [signature, setSignature] = useState<FormSignature | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = useAction();
  const save = useAction();
  const take = (e: Entry) => { setEntry(e); setAnswers(e.answers); setSignature(e.signature); };
  useEffect(() => { void load.run(async () => take(await api<Entry>(`/visits/${visitId}/forms/${entryId}`))); }, [visitId, entryId]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!entry && (!sameAnswers(answers, entry.answers) || (signature?.d ?? "") !== (entry.signature?.d ?? ""));
  const submit = () => void save.run(async () => {
    const was = entry!.submitted;
    take(await api<Entry>(`/visits/${visitId}/forms/${entryId}`, { method: "PUT", body: { answers, signature } }));
    setToast(was ? "Form updated" : "Form submitted");
    onSaved();
  });
  return (
    <Dialog title={title} onClose={onClose}
      foot={entry && (
        <>
          <button type="button" className="btn hw-soft" onClick={printForm}><Icon name="print" size={14} /> Print</button>
          {entry.canFill
            ? <button type="button" className="btn hw-and" disabled={save.busy || (entry.submitted && !dirty)} onClick={submit}>{save.busy ? "Saving…" : entry.submitted ? "Update" : "Submit"}</button>
            : <button type="button" className="btn hw-and" onClick={onClose}>Close</button>}
        </>
      )}>
      {(load.error ?? save.error) && <div className="hwf-error" role="alert">{load.error ?? save.error}</div>}
      {!entry && !load.error && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
      {entry && (
        <div className="hwf-print">
          <h2 className="hwf-print-title">{entry.name}</h2>
          {entry.submitted && entry.submittedAt && (
            <div className="hwf-author">
              <span>{entry.submittedBy ?? "Unknown author"}</span>
              <span>{when(entry.submittedAt)}{entry.updatedAt && entry.updatedAt !== entry.submittedAt && entry.updatedBy ? ` · changed ${when(entry.updatedAt)} by ${entry.updatedBy}` : ""}</span>
            </div>
          )}
          <FormView def={entry.def} answers={answers} signature={signature} onAnswers={entry.canFill ? setAnswers : undefined} onSignature={entry.canFill ? setSignature : undefined} />
          {!entry.canFill && <p className="muted hwf-note">Only the crew on this work order or a manager can fill it in.</p>}
        </div>
      )}
      {toast && <div className="hwf-toast" role="status" onAnimationEnd={() => setToast(null)}>{toast}</div>}
    </Dialog>
  );
}

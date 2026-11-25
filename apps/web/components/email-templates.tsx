"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DESIGN_DEFAULTS, MESSAGE_KIND_LABELS, brandHeaderRow, contrastText, designHasContent, emptyDesign, newBlock, newRow, recolorHeaderRow, renderDesign, swapHomeworksPictures, withSavedRows,
  type EmailDesign, type Row, type SavedRow, type TemplateAudience,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ConfirmDialog, Req } from "./automation-bits";
import { CustomerPicker } from "./customers";
import { EmailBuilder } from "./email-builder";
import { Icon } from "./icons";
import type { Template } from "./templates";

/**
 * Marketing → Templates → Email Templates, laid out like Homeworks: the Templates List on top
 * (edit, delete, copy), then Template Name, Subject (with Insert Tags) and the builder, with
 * Create / Update Template underneath. Sent / History is the second tab.
 */

/** Homeworks' Insert Tags for the subject line. */
const SUBJECT_TAGS = ["CUSTOMER FIRST NAME", "CUSTOMER LAST NAME", "CUSTOMER NAME", "CUSTOMER COMPANY NAME", "COMPANY OWNER FIRST NAME", "COMPANY OWNER LAST NAME", "COMPANY NAME", "INVOICE NUMBER", "ESTIMATE NUMBER"];
type Full = Template & { design: EmailDesign | null };
type Form = { id: string | null; name: string; subject: string; audience: TemplateAudience; system: boolean };
const BLANK: Form = { id: null, name: "", subject: "", audience: "customer", system: false };
type Saved = SavedRow & { usedIn: number };
type RowsInfo = { rows: Saved[]; brandColor: string | null; companyName: string; logoUrl: string | null };
const many = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Where a template is used, in words: the automations that send it and what it's the default for. */
const usesOf = (t: Template) => [...(t.usedBy ?? []).map((name) => `"${name}"`), ...t.usedFor.map((k) => `every ${MESSAGE_KIND_LABELS[k].toLowerCase().replace(/s$/, "")} email (Defaults)`)];

function Dialog({ title, children, foot, onClose, className = "" }: { title: string; children: ReactNode; foot: ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  return (
    <div className="hw-dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`hw-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="hw-dialog-head"><span>{title}</span><button type="button" className="hw-dialog-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="hw-dialog-body">{children}</div>
        <div className="hw-dialog-foot">{foot}</div>
      </div>
    </div>
  );
}

export function EmailTemplatesTab({ list, reload }: { list: Template[]; reload: () => Promise<unknown> | void }) {
  const { me, can } = useAuth();
  const rows = useApi<RowsInfo>("/templates/rows");
  const [editRow, setEditRow] = useState<Saved | null>(null);
  const [delRow, setDelRow] = useState<Saved | null>(null);
  const [header, setHeader] = useState(false);
  const emails = list.filter((t) => t.channel === "email");
  const [form, setForm] = useState<Form>(BLANK);
  const [design, setDesign] = useState<EmailDesign>(emptyDesign);
  const [alert, setAlert] = useState<string | null>(null);
  const [warn, setWarn] = useState<{ message: string; focus?: "name" | "subject" } | null>(null);
  const [del, setDel] = useState<Template | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tags, setTags] = useState(false);
  const [preview, setPreview] = useState(false);
  const [test, setTest] = useState(false);
  const [q, setQ] = useState("");
  const [confirmUse, setConfirmUse] = useState<string[] | null>(null);
  const act = useAction();
  const nameRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const reset = () => { setForm(BLANK); setDesign(emptyDesign()); };
  /** How many templates still show pictures kept on Homeworks' storage. */
  const borrowed = emails.filter((t) => (t.homeworksPictures ?? 0) > 0).length;
  /**
   * After a saved row changes: the lists are read again, and the template that's open follows
   * (its saved rows brought up to date, without losing what's been changed in it but not saved).
   */
  const rowsChanged = async (swapFor?: SavedRow) => {
    const fresh = await api<RowsInfo>("/templates/rows");
    rows.setData(fresh);
    const map = new Map<string, SavedRow>(fresh.rows.map((r) => [r.id, r]));
    setDesign((d) => {
      const out = withSavedRows(d, map), next = out.changed ? out.design : d;
      return swapFor ? swapHomeworksPictures(next, map.get(swapFor.id) ?? swapFor).design : next;
    });
    await reload();
  };
  const removeRow = (r: Saved) => void act.run(async () => {
    setDelRow(null);
    await api(`/templates/rows/${r.id}`, { method: "DELETE" });
    setAlert(`Saved row "${r.name}" deleted`);
    await rowsChanged();
  });
  const open = (t: Template) => void act.run(async () => {
    setAlert(null); setListError(null);
    const full = await api<Full>(`/templates/${t.id}`);
    setForm({ id: full.id, name: full.name, subject: full.subject ?? "", audience: full.audience, system: full.system });
    setDesign(full.design ?? emptyDesign());
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  const shown = emails.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const save = (sure = false) => {
    if (!form.name.trim()) { setWarn({ message: "Email template name is required. Please enter a name for the template.", focus: "name" }); return; }
    if (!form.subject.trim()) { setWarn({ message: "Email subject is required. Please enter a subject for the email.", focus: "subject" }); return; }
    if (!designHasContent(design)) { setWarn({ message: "This template has no content. Add text or an image before saving." }); return; }
    // Changing a template that's already going out changes what those send: say so first.
    const current = form.id ? emails.find((t) => t.id === form.id) : null;
    const uses = current ? usesOf(current) : [];
    if (uses.length && !sure) { setConfirmUse(uses); return; }
    setConfirmUse(null);
    void act.run(async () => {
      const body = { channel: "email", audience: form.audience, name: form.name, subject: form.subject, design };
      if (form.id) await api(`/templates/${form.id}`, { method: "PUT", body }); else await api("/templates", { body });
      setAlert(form.id ? "Template updated successfully" : "Template added successfully");
      if (!form.id) { reset(); window.scrollTo({ top: 0, behavior: "smooth" }); }
      await reload();
    });
  };
  const clone = (t: Template) => void act.run(async () => { setListError(null); await api(`/templates/${t.id}/clone`, { method: "POST" }); setAlert("Template copied successfully"); await reload(); });
  const remove = (t: Template) => void (async () => {
    setDel(null);
    try { await api(`/templates/${t.id}`, { method: "DELETE" }); if (form.id === t.id) reset(); setAlert("Template deleted successfully"); await reload(); }
    catch (e) { setListError((e as Error).message); }
  })();
  const insertTag = (tag: string) => {
    const el = subjectRef.current, text = `{{${tag.replace(/ /g, "_")}}}`;
    const at = el?.selectionStart ?? form.subject.length, end = el?.selectionEnd ?? at;
    setForm({ ...form, subject: form.subject.slice(0, at) + text + form.subject.slice(end) });
    setTags(false);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };
  const resetOwn = () => void act.run(async () => { if (!form.id) return; await api(`/templates/${form.id}/reset`, { method: "POST" }); setAlert("Put back to Crewdesk's own wording"); const t = emails.find((x) => x.id === form.id); await reload(); if (t) open(t); });

  return (
    <div className="hwe" data-lkeep="">
      {borrowed > 0 && (
        <div className="hwe-notice" role="note">
          <p><strong>{many(borrowed, "template")} still {borrowed === 1 ? "shows" : "show"} Homeworks&apos; header pictures.</strong> Those pictures are Homeworks&apos; artwork, kept on its servers, and they stop showing if Homeworks ever takes them down. Put your own header (your logo on your color) in their place.</p>
          <button type="button" className="btn" onClick={() => setHeader(true)}>Use my own header…</button>
        </div>
      )}
      <div className="card hwd-list-card">
        <div className="hwd-list-head hwe-list-head">
          <span>Templates List</span>
          <input type="search" placeholder="Search templates..." aria-label="Search templates" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {listError && <p className="hwd-error" style={{ margin: 0, padding: "8px 12px", fontSize: 13 }}>{/system|Crewdesk's own/.test(listError) ? "You can not delete system templates. " : ""}{listError}</p>}
        <div className="hwe-list">
          {shown.map((t) => (
            <div className={`hwe-row${form.id === t.id ? " on" : ""}`} key={t.id}>
              <button type="button" className="hwe-name" onClick={() => open(t)} title="Edit">{t.name}</button>
              {usesOf(t).length > 0 && <span className="hwe-used" title={`Used by ${usesOf(t).join(", ")}`}>Used by {usesOf(t).length}</span>}
              <span className="hwd-row-actions">
                <button type="button" className="hw-icon-btn" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => open(t)}><Icon name="pencil" size={17} /></button>
                <button type="button" className="hw-icon-btn danger" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => { setListError(null); setDel(t); }}><Icon name="trash" size={17} /></button>
                <button type="button" className="hw-icon-btn" aria-label={`Copy ${t.name}`} title="Copy" onClick={() => clone(t)}><Icon name="copy" size={17} /></button>
              </span>
            </div>
          ))}
          {!shown.length && <p className="hwd-none" style={{ padding: 12 }}>(No templates found)</p>}
        </div>
      </div>

      {alert && <div className="hwd-success" role="status"><div>{alert}</div><button type="button" aria-label="Close" onClick={() => setAlert(null)}>×</button></div>}
      <div className="hwe-form" ref={formRef}>
        <label className="hw-field">
          <span className="hw-label">Template Name <Req /></span>
          <input ref={nameRef} type="text" maxLength={100} aria-label="Template Name" value={form.name} readOnly={form.system} title={form.system ? "Crewdesk's own templates keep their names" : undefined} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <div className="hw-field">
          <div className="hwe-subject"><label className="hw-label" htmlFor="hwe-subject"><span>Subject <Req /></span></label><button type="button" className="hwe-insert" onClick={() => setTags(true)}>Insert Tags</button></div>
          <input id="hwe-subject" ref={subjectRef} type="text" maxLength={250} aria-label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </div>
        <EmailBuilder value={design} onChange={setDesign} onPreview={() => setPreview(true)} onSendTest={() => setTest(true)}
          saved={{
            rows: rows.data?.rows ?? [], brandColor: rows.data?.brandColor ?? null,
            onSave: async (row, name) => { const sr = await api<SavedRow>("/templates/rows", { body: { name, row } }); await rowsChanged(); return sr; },
            onEdit: (sr) => setEditRow(rows.data?.rows.find((r) => r.id === sr.id) ?? { ...sr, usedIn: 0 }),
            onDelete: (sr) => setDelRow(rows.data?.rows.find((r) => r.id === sr.id) ?? { ...sr, usedIn: 0 }),
            onHeader: () => setHeader(true),
          }}
          extra={(
            <>
              <div className="eb-section">CREWDESK</div>
              <div className="eb-field"><span>Who it&apos;s for</span>
                <select aria-label="Who it's for" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as TemplateAudience })}><option value="customer">Customers</option><option value="internal">Your team</option></select>
              </div>
              {form.system && <div className="eb-field col"><small>This is one of Crewdesk&apos;s own templates (invoices, estimates, receipts).</small><button type="button" className="eb-primary" disabled={act.busy} onClick={resetOwn}>Reset to Crewdesk&apos;s wording</button></div>}
            </>
          )} />
        {act.error && <div className="hw-errors">{act.error}</div>}
        <div className="hwe-foot">
          {form.id ? <button type="button" className="btn hw-soft" onClick={reset}>Cancel</button> : <span />}
          <button type="button" className="btn" disabled={act.busy} onClick={() => save()}>✓ {form.id ? "Update Template" : "Create Template"}</button>
        </div>
      </div>

      {tags && <Dialog title="Insert Tags" className="hwe-small" onClose={() => setTags(false)} foot={<button type="button" className="btn hw-soft" onClick={() => setTags(false)}>Close</button>}><div className="hwe-tags">{SUBJECT_TAGS.map((t) => <button key={t} type="button" onClick={() => insertTag(t)}>{t}</button>)}</div></Dialog>}
      {warn && <Dialog title="Warning" className="hwe-small" onClose={() => { const f = warn.focus; setWarn(null); (f === "name" ? nameRef : f === "subject" ? subjectRef : null)?.current?.focus(); }} foot={<button type="button" className="btn hw-soft" onClick={() => { const f = warn.focus; setWarn(null); (f === "name" ? nameRef : f === "subject" ? subjectRef : null)?.current?.focus(); }}>Close</button>}>{warn.message}</Dialog>}
      {confirmUse && (
        <ConfirmDialog title="Update Template" onYes={() => save(true)} onNo={() => setConfirmUse(null)}
          message={<><p style={{ marginTop: 0 }}>This template is already in use. Updating it changes what goes out from:</p><ul style={{ margin: "0 0 10px", paddingLeft: 20 }}>{confirmUse.map((u) => <li key={u}>{u}</li>)}</ul>Update it?</>} />
      )}
      {del && <ConfirmDialog title="Delete Template" message="Are you sure you want to delete this template?" onYes={() => remove(del)} onNo={() => setDel(null)} />}
      {delRow && (
        <ConfirmDialog title="Delete Saved Row" onYes={() => removeRow(delRow)} onNo={() => setDelRow(null)}
          message={<>Delete the saved row &quot;{delRow.name}&quot;?{delRow.usedIn > 0 && <> It&apos;s in {many(delRow.usedIn, "template")}: it stays in {delRow.usedIn === 1 ? "that template" : "each of them"} as {delRow.usedIn === 1 ? "its" : "that template's"} own row, and is no longer changed in one place.</>}</>} />
      )}
      {editRow && <SavedRowEditor saved={editRow} onClose={() => setEditRow(null)} onSaved={async (n) => { setEditRow(null); setAlert(n ? `Saved row updated in ${many(n, "template")}` : "Saved row updated"); await rowsChanged(); }} />}
      {header && rows.data && (
        <HeaderDialog info={rows.data} borrowed={borrowed} admin={can("admin", "customers")} onClose={() => setHeader(false)}
          onDone={async (row, done) => { setHeader(false); setAlert(done); await rowsChanged(row); }} />
      )}
      {preview && <PreviewMode subject={form.subject} design={design} onClose={() => setPreview(false)} />}
      {test && <SendTest subject={form.subject} design={design} mine={me?.user.email ?? ""} onClose={() => setTest(false)} onSent={(to) => { setTest(false); setAlert(`Test Email sent successfully to ${to}!`); }} />}
    </div>
  );
}

/** A saved row opened by itself in the builder. Saving it changes every template that uses it. */
function SavedRowEditor({ saved, onClose, onSaved }: { saved: Saved; onClose: () => void; onSaved: (templates: number) => Promise<void> | void }) {
  const [name, setName] = useState(saved.name);
  const [design, setDesign] = useState<EmailDesign>(() => ({ ...emptyDesign(), rows: [{ ...saved.row, p: (({ saved: _s, savedName: _n, ...rest }) => rest)(saved.row.p) }] }));
  const act = useAction();
  const save = () => void act.run(async () => {
    if (!name.trim()) throw new Error("Name the row.");
    const r = await api<{ templates: number }>(`/templates/rows/${saved.id}`, { method: "PUT", body: { name: name.trim(), row: design.rows[0] } });
    await onSaved(r.templates);
  });
  return (
    <div className="hwe-preview" role="dialog" aria-modal="true" aria-label="Edit saved row">
      <div className="hwe-preview-head">
        <h2>Edit saved row</h2>
        <span style={{ fontSize: 13 }}>{saved.usedIn ? <>In {many(saved.usedIn, "template")}. Saving changes {saved.usedIn === 1 ? "it" : "them all"}.</> : "Not used in a template yet."}</span>
        <button type="button" className="btn hw-soft" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={act.busy} onClick={save}>{act.busy ? "Saving…" : "✓ Save row"}</button>
      </div>
      <div className="hwe-roweditor-body">
        {act.error && <div className="hw-errors">{act.error}</div>}
        <label className="hw-field"><span className="hw-label">Row Name <Req /></span><input type="text" maxLength={60} aria-label="Row Name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <EmailBuilder value={design} onChange={setDesign} oneRow />
      </div>
    </div>
  );
}

type LogoColors = { background: string | null; main: string | null; pale: boolean };
/**
 * What a logo's colors say about the header it belongs on: its own background when it has one
 * (so it sits on the header with no box around it), its main color (white, black and grey left
 * out), and whether it's a white logo made for dark backgrounds. Null when it can't be read.
 */
async function logoColors(url: string): Promise<LogoColors | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const N = 64, c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(img, 0, 0, N, N);
    const px = g.getImageData(0, 0, N, N).data;
    const at = (x: number, y: number) => { const i = (y * N + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]] as const; };
    const hex = (r: number, gr: number, b: number) => `#${[r, gr, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    const far = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const corners = [at(1, 1), at(N - 2, 1), at(1, N - 2), at(N - 2, N - 2)];
    const solid = corners.every((k) => k[3] > 240 && far(k, corners[0]) < 36);
    const back = solid ? [0, 1, 2].map((k) => corners.reduce((sum, x) => sum + x[k], 0) / 4) : null;
    const groups = new Map<number, [number, number, number, number]>();
    let seen = 0, white = 0;
    for (let i = 0; i < px.length; i += 4) {
      const p = [px[i], px[i + 1], px[i + 2]] as const;
      if (px[i + 3] < 200) continue;
      seen++;
      if (Math.min(...p) > 215) white++;
      if (Math.max(...p) - Math.min(...p) < 45 || (back && far(p, back) < 90)) continue;
      const key = (p[0] >> 5) << 6 | (p[1] >> 5) << 3 | (p[2] >> 5);
      const sum = groups.get(key) ?? [0, 0, 0, 0];
      groups.set(key, [sum[0] + 1, sum[1] + p[0], sum[2] + p[1], sum[3] + p[2]]);
    }
    const top = [...groups.values()].sort((x, y) => y[0] - x[0])[0];
    return {
      background: back ? hex(back[0], back[1], back[2]) : null,
      main: top && top[0] >= 12 ? hex(top[1] / top[0], top[2] / top[0], top[3] / top[0]) : null,
      pale: !back && seen > 0 && white / seen > 0.8,
    };
  } catch { return null; }
}

const HEX = /^#[0-9a-f]{6}$/i;
/** A color: the browser's picker and the code beside it. */
function ColorPick({ label, value, onChange, children }: { label: string; value: string; onChange: (c: string) => void; children?: ReactNode }) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  return (
    <div className="hwe-header-pick">
      <span className="hwe-header-label">{label}</span>
      <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} />
      <input type="text" aria-label={`${label} code`} maxLength={7} value={typed} onChange={(e) => { setTyped(e.target.value); if (HEX.test(e.target.value.trim())) onChange(e.target.value.trim().toLowerCase()); }} />
      {children}
    </div>
  );
}

/**
 * "My header": the company's logo (or its name) on a background, over a line of its color, kept
 * as the saved row "Header". It can also take the place of Homeworks' pictures in every template
 * that has them.
 */
function HeaderDialog({ info, borrowed, admin, onClose, onDone }: { info: RowsInfo; borrowed: number; admin: boolean; onClose: () => void; onDone: (row: SavedRow, done: string) => Promise<void> | void }) {
  const have = info.rows.find((r) => r.name === "Header") ?? null;
  const had = typeof have?.row.p.contentBg === "string" && HEX.test(have.row.p.contentBg) ? have.row.p.contentBg.toLowerCase() : null;
  const [color, setColor] = useState(had ?? (info.logoUrl ? "#ffffff" : "#1f2937"));
  const [accent, setAccent] = useState(info.brandColor ?? had ?? "#1f2937");
  const [logo, setLogo] = useState<LogoColors | null>(null);
  const [swap, setSwap] = useState(borrowed > 0 && admin);
  const act = useAction();
  // A first header starts from the logo's own colors: on its own background (or white), with a line of its main color.
  useEffect(() => {
    if (!info.logoUrl) return;
    let live = true;
    void logoColors(info.logoUrl).then((c) => {
      if (!live || !c) return;
      setLogo(c);
      if (have || info.brandColor) return;
      setColor(c.background ?? (c.pale ? "#1f2937" : "#ffffff"));
      setAccent(c.main ?? c.background ?? "#333333");
    });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const row: Row = have ? recolorHeaderRow(have.row, color, accent) : brandHeaderRow({ color, accent, logoUrl: info.logoUrl, companyName: info.companyName });
  const button = { ...newBlock("button"), p: { ...newBlock("button").p, bg: accent, color: contrastText(accent) } };
  const sample = newRow([12], [{ ...newBlock("paragraph"), p: { ...newBlock("paragraph").p, html: "Hi Pat,<br><br>This is how your emails start: your header on top, then the message." } }, button]);
  const html = renderDesign({ v: 1, p: { ...DESIGN_DEFAULTS }, rows: [row, sample] });
  const save = () => void act.run(async () => {
    const made = await api<SavedRow & { made: boolean; templates: number }>("/templates/brand-header", { body: { color, accent } });
    let done = made.made ? "Your header is saved (Rows → Saved rows → Header)" : made.templates ? `Header updated in ${many(made.templates, "template")}` : "Header updated";
    if (swap) {
      const r = await api<{ templates: number; pictures: number }>("/templates/replace-homeworks-pictures", { body: { rowId: made.id } });
      done = `Your header is now in ${many(r.templates, "template")}, in place of ${many(r.pictures, "Homeworks picture")}`;
    }
    await onDone({ id: made.id, name: made.name, row: made.row }, done);
  });
  return (
    <Dialog title="My header" className="hwe-header" onClose={onClose}
      foot={<><button type="button" className="btn hw-soft" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={act.busy} onClick={save}>{act.busy ? "Saving…" : swap ? "Save and replace the pictures" : "Save header"}</button></>}>
      <p style={{ margin: 0 }}>{info.logoUrl ? "Your logo over a line of your color." : <>Your company name over a line of your color. Add a logo in <Link href="/settings/company-info">Company info</Link> and it&apos;s used instead.</>} It&apos;s kept as the saved row <strong>Header</strong>: put it in any template, and change it once to change it everywhere.{have && " Anything you've added to your header stays; only its colors change here."}</p>
      <ColorPick label="Background" value={color} onChange={setColor}>
        {color !== "#ffffff" && <button type="button" className="hw-link" onClick={() => setColor("#ffffff")}>White</button>}
        {logo?.background && logo.background !== color && <button type="button" className="hw-link" onClick={() => setColor(logo.background!)}>My logo&apos;s background</button>}
        {logo?.main && logo.main !== color && <button type="button" className="hw-link" onClick={() => setColor(logo.main!)}>My logo&apos;s color</button>}
      </ColorPick>
      <ColorPick label="Line and buttons" value={accent} onChange={setAccent}>
        {logo?.main && logo.main !== accent && <button type="button" className="hw-link" onClick={() => setAccent(logo.main!)}>My logo&apos;s color</button>}
      </ColorPick>
      <iframe title="Header preview" className="hwe-header-preview" sandbox="" srcDoc={html} />
      {borrowed > 0 && (admin
        ? <label className="hwe-check"><input type="checkbox" checked={swap} onChange={(e) => setSwap(e.target.checked)} /><span>Put this header in the {many(borrowed, "template")} that still {borrowed === 1 ? "shows" : "show"} Homeworks&apos; pictures, and take those pictures out. Where a picture named what the email is about (like &quot;Estimate Accepted&quot;), a title says it instead. The wording isn&apos;t touched.</span></label>
        : <p className="muted" style={{ marginBottom: 0 }}>An admin can also put this header in place of Homeworks&apos; pictures in {many(borrowed, "template")}.</p>)}
      {act.error && <p className="hwd-error" style={{ margin: "8px 0 0" }}>{act.error}</p>}
    </Dialog>
  );
}

/** Actions → Preview: the email at desktop, tablet or phone width, with example values or filled in for a customer. */
function PreviewMode({ subject, design, onClose }: { subject: string; design: EmailDesign; onClose: () => void }) {
  const [device, setDevice] = useState<"d" | "t" | "m">("d");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [data, setData] = useState<{ subject: string; html: string; missing: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ subject: string; html: string; missing: string[] }>("/templates/preview", { body: { channel: "email", subject, design, customerId: customer?.id ?? null } }).then((d) => { if (live) setData(d); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [customer]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  return (
    <div className="hwe-preview" role="dialog" aria-modal="true" aria-label="Preview mode">
      <div className="hwe-preview-head">
        <h2>Preview mode</h2>
        <span className="eb-seg" role="radiogroup" aria-label="Device">
          {([["d", "Desktop"], ["t", "Tablet"], ["m", "Mobile"]] as const).map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={device === k} className={device === k ? "on" : ""} onClick={() => setDevice(k)}>{label}</button>)}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          {customer ? <>Filled in for <strong>{customer.name}</strong> <button type="button" className="hw-link" onClick={() => setCustomer(null)}>use example values</button></> : <>Example values. <CustomerPicker label="Fill in for a customer" onPick={setCustomer} /></>}
        </span>
        <button type="button" className="eb-x" aria-label="Close preview" onClick={onClose}>×</button>
      </div>
      <div className="hwe-preview-body">
        {error && <div className="hw-errors">{error}</div>}
        {data && <div className="hwe-preview-subject"><span className="muted">Subject:</span> {data.subject}{data.missing.length > 0 && <span className="muted"> · tags about {data.missing.join(", ")} are blank here; they&apos;re filled in when the email is about one</span>}</div>}
        {data ? <iframe title="Email preview" sandbox="" srcDoc={data.html} style={{ maxWidth: device === "m" ? 390 : device === "t" ? 768 : undefined }} /> : !error && <p className="muted">Loading the preview…</p>}
      </div>
    </div>
  );
}

/** Actions → Send test: Homeworks' pop-up. (Here the fill-ins are shown with example values.) */
function SendTest({ subject, design, mine, onClose, onSent }: { subject: string; design: EmailDesign; mine: string; onClose: () => void; onSent: (to: string) => void }) {
  const [to, setTo] = useState(mine);
  const [error, setError] = useState<string | null>(null);
  const act = useAction();
  const send = () => {
    const email = to.trim();
    if (!email) { setError("Please enter an email address."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError("Invalid email format."); return; }
    if (!designHasContent(design)) { setError("This email has no content. Add text or an image before sending."); return; }
    setError(null);
    void act.run(async () => { const r = await api<{ to: string }>("/templates/test", { body: { channel: "email", subject: subject || "Test Subject", design, to: email } }); onSent(r.to); });
  };
  return (
    <Dialog title="Send test email" className="hwe-small" onClose={onClose} foot={<><button type="button" className="btn hw-soft" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={act.busy} onClick={send}>{act.busy ? "Sending…" : "Send"}</button></>}>
      <label className="hw-field">
        <span>Enter an email address to send a test email</span>
        <small style={{ fontSize: "85%" }}><b>Please note:</b> Merge tags are filled in with example values in test emails</small>
        <input type="text" autoFocus aria-label="Email address" placeholder="email@example.com" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
      </label>
      {(error ?? act.error) && <p className="hwd-error" style={{ margin: "6px 0 0" }}>{error ?? act.error}</p>}
    </Dialog>
  );
}

/* ───────────── Sent / History ───────────── */

type Sent = { id: string; to: string; subject: string; status: string; error: string | null; sentAt: string; openedAt: string | null; openCount: number; customer: { id: string; name: string } | null; template: { id: string; name: string } | null; hasBody: boolean };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export function EmailHistoryTab() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<Sent | null>(null);
  useEffect(() => { const t = setTimeout(() => setSearch(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const rows = useApi<Sent[]>(`/templates/history/list?q=${encodeURIComponent(search)}`);
  return (
    <div className="hwe" data-lkeep="">
      <div className="card" style={{ padding: 16 }}><input type="search" placeholder="Search" aria-label="Search sent emails" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "min(405px, 100%)", borderRadius: 12 }} /></div>
      <div className="card tablewrap" style={{ padding: 16 }}>
        {rows.error && <div className="hw-errors">{rows.error}</div>}
        <table className="hw-table hwe-history" style={{ width: "100%" }}>
          <thead><tr><th>Email ID</th><th>Subject</th><th>Content</th><th>Recipient</th><th>Status</th><th>Sent Time</th><th>Open Time</th><th>Open Count</th><th>Notes</th></tr></thead>
          <tbody>
            {(rows.data ?? []).map((r) => (
              <tr key={r.id}>
                <td title={r.id}>{r.id.slice(0, 8)}</td>
                <td>{r.subject}</td>
                <td>{r.hasBody ? <button type="button" className="hw-link" style={{ fontSize: 13 }} onClick={() => setView(r)}>View</button> : ""}</td>
                <td>{r.customer ? <><Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link><br /></> : null}<span className="muted">{r.to}</span></td>
                <td>{r.status === "failed" ? <span className="hwd-error" style={{ fontSize: 13 }}>Failed</span> : r.openCount > 0 ? "Opened" : "Sent"}</td>
                <td>{when(r.sentAt)}</td>
                <td>{when(r.openedAt)}</td>
                <td>{r.openCount}</td>
                <td>{r.error ?? (r.template ? r.template.name : "")}</td>
              </tr>
            ))}
            {rows.data && !rows.data.length && <tr><td colSpan={9}>(No Email History Found)</td></tr>}
            {!rows.data && !rows.error && <tr><td colSpan={9} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
        {rows.data?.length === 100 && <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Showing the latest 100. Search to find older ones.</p>}
      </div>
      {view && <SentBody row={view} onClose={() => setView(null)} />}
    </div>
  );
}
function SentBody({ row, onClose }: { row: Sent; onClose: () => void }) {
  const one = useApi<{ body: string | null }>(`/templates/history/${row.id}`);
  return (
    <Dialog title={row.subject} onClose={onClose} foot={<button type="button" className="btn hw-soft" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginTop: 0 }}>To {row.to} · {when(row.sentAt)}</p>
      {one.error ? <div className="hw-errors">{one.error}</div> : <div style={{ whiteSpace: "pre-wrap", maxHeight: "60vh", overflow: "auto" }}>{one.data ? one.data.body ?? "(The words weren't kept for this one.)" : "Loading…"}</div>}
    </Dialog>
  );
}

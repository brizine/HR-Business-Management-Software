"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { designHasContent, emptyDesign, type EmailDesign, type TemplateAudience } from "@crewdesk/shared";
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
  const { me } = useAuth();
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
  const act = useAction();
  const nameRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const reset = () => { setForm(BLANK); setDesign(emptyDesign()); };
  const open = (t: Template) => void act.run(async () => {
    setAlert(null); setListError(null);
    const full = await api<Full>(`/templates/${t.id}`);
    setForm({ id: full.id, name: full.name, subject: full.subject ?? "", audience: full.audience, system: full.system });
    setDesign(full.design ?? emptyDesign());
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  const save = () => {
    if (!form.name.trim()) { setWarn({ message: "Email template name is required. Please enter a name for the template.", focus: "name" }); return; }
    if (!form.subject.trim()) { setWarn({ message: "Email subject is required. Please enter a subject for the email.", focus: "subject" }); return; }
    if (!designHasContent(design)) { setWarn({ message: "This template has no content. Add text or an image before saving." }); return; }
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
      <div className="card hwd-list-card">
        <div className="hwd-list-head">Templates List</div>
        {listError && <p className="hwd-error" style={{ margin: 0, padding: "8px 12px", fontSize: 13 }}>{/system|Crewdesk's own/.test(listError) ? "You can not delete system templates. " : ""}{listError}</p>}
        <div className="hwe-list">
          {emails.map((t) => (
            <div className={`hwe-row${form.id === t.id ? " on" : ""}`} key={t.id}>
              <button type="button" className="hwe-name" onClick={() => open(t)} title="Edit">{t.name}</button>
              <span className="hwd-row-actions">
                <button type="button" className="hw-icon-btn" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => open(t)}><Icon name="pencil" size={17} /></button>
                <button type="button" className="hw-icon-btn danger" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => { setListError(null); setDel(t); }}><Icon name="trash" size={17} /></button>
                <button type="button" className="hw-icon-btn" aria-label={`Copy ${t.name}`} title="Copy" onClick={() => clone(t)}><Icon name="copy" size={17} /></button>
              </span>
            </div>
          ))}
          {!emails.length && <p className="hwd-none" style={{ padding: 12 }}>(No templates found)</p>}
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
          <button type="button" className="btn" disabled={act.busy} onClick={save}>✓ {form.id ? "Update Template" : "Create Template"}</button>
        </div>
      </div>

      {tags && <Dialog title="Insert Tags" className="hwe-small" onClose={() => setTags(false)} foot={<button type="button" className="btn hw-soft" onClick={() => setTags(false)}>Close</button>}><div className="hwe-tags">{SUBJECT_TAGS.map((t) => <button key={t} type="button" onClick={() => insertTag(t)}>{t}</button>)}</div></Dialog>}
      {warn && <Dialog title="Warning" className="hwe-small" onClose={() => { const f = warn.focus; setWarn(null); (f === "name" ? nameRef : f === "subject" ? subjectRef : null)?.current?.focus(); }} foot={<button type="button" className="btn hw-soft" onClick={() => { const f = warn.focus; setWarn(null); (f === "name" ? nameRef : f === "subject" ? subjectRef : null)?.current?.focus(); }}>Close</button>}>{warn.message}</Dialog>}
      {del && <ConfirmDialog title="Delete Template" message="Are you sure you want to delete this template?" onYes={() => remove(del)} onNo={() => setDel(null)} />}
      {preview && <PreviewMode subject={form.subject} design={design} onClose={() => setPreview(false)} />}
      {test && <SendTest subject={form.subject} design={design} mine={me?.user.email ?? ""} onClose={() => setTest(false)} onSent={(to) => { setTest(false); setAlert(`Test Email sent successfully to ${to}!`); }} />}
    </div>
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

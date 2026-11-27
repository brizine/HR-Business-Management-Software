"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import LinkExt from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import Link from "next/link";
import { DOC_CUSTOMERS_MAX, DOC_NAME_MAX, DOC_PRINT_MAX, DOC_TAGS, docHistoryText, docSchema, docWords, type DocHistoryAction, type DocHistoryDetail } from "@crewdesk/shared";
import { api, apiBlob } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ConfirmDialog, Req } from "./automation-bits";
import type { Selection } from "./customer-messages";
import { Icon } from "./icons";

/**
 * Resources → Documents, laid out like Homeworks: the form on the left (template, name, header,
 * content), the list on the right, and pop-ups to email or print a document for chosen customers.
 */

type Row = { id: string; name: string; imported?: string | null };
type Full = { id: string; name: string; content: string; unknown?: string[] };
type Letterhead = { name: string; lines: string[]; phone: string | null; email: string | null; website: string | null; logoUrl: string | null };
type History = { id: string; action: DocHistoryAction; detail: DocHistoryDetail | null; by: string | null; at: string };
type Customer = { id: string; name: string; email: string | null; optedOut: boolean; sample: boolean };
type EmailTemplate = { id: string; name: string; channel: string; audience: string };
type EmailResult = { messageId: string; sending: number; attachPdf: boolean; skipped: { reason: string; label: string; n: number }[]; skippedNames: { name: string; reason: string }[] };
type PreviewData = { customer: { id: string; name: string; email: string | null }; email: { subject: string; html: string }; letter: { toName: string; toLines: string[]; html: string }; attachPdf: boolean };
type Audience = { total: number; sending: number; skipped: { reason: string; label: string; n: number }[]; byMail: number; emailReady: boolean; first: { id: string; name: string } | null };
const people = (n: number) => `${n.toLocaleString()} customer${n === 1 ? "" : "s"}`;

/** Opens a PDF the server makes in a new tab (opened right at the click, so it isn't blocked), or saves it when a tab can't be opened. */
async function openPdf(path: string, body: unknown, fallbackName: string) {
  const tab = window.open("", "_blank");
  try {
    const { blob, filename } = await apiBlob(path, body);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else { const a = document.createElement("a"); a.href = url; a.download = filename ?? fallbackName; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** "November 25, 2026 10:09 AM", as Homeworks writes history dates. */
const longDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

/* ───────────── The editor ───────────── */

function ToolButton({ on, label, title, run }: { on?: boolean; label: ReactNode; title: string; run: () => void }) {
  return <button type="button" className={`hwd-tool${on ? " on" : ""}`} title={title} aria-label={title} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={run}>{label}</button>;
}

/** A toolbar button that opens a short list (Add, Format, Align, the fill-ins). */
function ToolMenu({ label, title, wide, items, itemTip }: { label: ReactNode; title: string; wide?: boolean; items: { label: string; run: () => void }[]; itemTip?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="hwd-menu" ref={box}>
      <button type="button" className={`hwd-tool${wide ? " wide" : ""}${open ? " on" : ""}`} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <div className="hwd-menu-list" role="menu">
          {items.map((i) => <button key={i.label} type="button" role="menuitem" data-tip={itemTip} onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); i.run(); }}>{i.label}</button>)}
        </div>
      )}
    </div>
  );
}

const lines = (n: number) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d={n === 0 ? "M2 4h12M2 8h8M2 12h12" : "M3 5l-2 3 2 3M13 5l2 3-2 3M9.5 3l-3 10"} />
  </svg>
);

/**
 * The content box, like Homeworks': Add, HTML, Format, Align, Bold, Italic, Underline,
 * Strikethrough, Link, then "Insert Customer / Company Info", with the word count underneath.
 */
export function DocEditor({ value, onChange, label }: { value: string; onChange: (html: string) => void; label: string }) {
  const [source, setSource] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, codeBlock: false, code: false }),
      Underline,
      LinkExt.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
    ],
    content: value,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": label, role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: ed }) => onChange(ed.isEmpty ? "" : ed.getHTML()),
  });
  if (!editor) return <div className="hwd-editor hwd-editor-loading" />;
  const link = (ed: Editor) => {
    const prev = ed.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link to (a web address). Leave empty to remove the link.", prev ?? "https://");
    if (url === null) return;
    if (!url.trim() || url.trim() === "https://") ed.chain().focus().extendMarkRange("link").unsetLink().run();
    else ed.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  const toggleSource = () => {
    // Back from the HTML: the box takes what was typed there.
    if (source) { editor.commands.setContent(value, false); onChange(editor.isEmpty ? "" : editor.getHTML()); }
    setSource(!source);
  };
  const insert = (tag: string) => {
    const text = `{{${tag}}}`;
    if (!source) { editor.chain().focus().insertContent(text).run(); return; }
    const el = area.current, at = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? at;
    onChange(value.slice(0, at) + text + value.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };
  const c = () => editor.chain().focus();
  return (
    <div className="hwd-editor">
      <div className="hwd-toolbar" role="toolbar" aria-label="Formatting">
        <ToolMenu label="+" title="Add" items={[
          { label: "Heading", run: () => c().setHeading({ level: 2 }).run() },
          { label: "Bulleted list", run: () => c().toggleBulletList().run() },
          { label: "Numbered list", run: () => c().toggleOrderedList().run() },
          { label: "Quote", run: () => c().toggleBlockquote().run() },
          { label: "Line", run: () => c().setHorizontalRule().run() },
        ]} />
        <ToolButton on={source} label={lines(1)} title="HTML" run={toggleSource} />
        <ToolMenu label="¶" title="Format" items={[
          { label: "Normal text", run: () => c().setParagraph().run() },
          { label: "Heading", run: () => c().setHeading({ level: 2 }).run() },
          { label: "Small heading", run: () => c().setHeading({ level: 3 }).run() },
          { label: "Quote", run: () => c().toggleBlockquote().run() },
        ]} />
        <ToolMenu label={lines(0)} title="Align" items={[
          { label: "Align left", run: () => c().setTextAlign("left").run() },
          { label: "Center", run: () => c().setTextAlign("center").run() },
          { label: "Align right", run: () => c().setTextAlign("right").run() },
        ]} />
        <ToolButton on={editor.isActive("bold")} label="B" title="Bold" run={() => c().toggleBold().run()} />
        <ToolButton on={editor.isActive("italic")} label={<i>I</i>} title="Italic" run={() => c().toggleItalic().run()} />
        <ToolButton on={editor.isActive("underline")} label={<u>U</u>} title="Underline" run={() => c().toggleUnderline().run()} />
        <ToolButton on={editor.isActive("strike")} label={<s>S</s>} title="Strikethrough" run={() => c().toggleStrike().run()} />
        <ToolButton on={editor.isActive("link")} label={<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></svg>} title="Link" run={() => link(editor)} />
        <div className="hwd-toolbar-break" />
        <ToolMenu wide label="Insert Customer / Company Info" title="Insert Customer / Company Info" items={DOC_TAGS.map((t) => ({ label: t.label, run: () => insert(t.tag) }))} itemTip="Put this blank where the cursor is; it fills itself in for each customer" />
      </div>
      {source
        ? <textarea ref={area} className="hwd-source" aria-label={`${label} (HTML)`} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        : <EditorContent editor={editor} className="hwd-body" />}
      <div className="hwd-words">Words: {docWords(value)}</div>
    </div>
  );
}

/** "Header - Click to show": the letterhead every document is printed on. */
function HeaderToggle() {
  const [open, setOpen] = useState(false);
  const head = useApi<Letterhead>(open ? "/docs/letterhead" : null);
  return (
    <>
      <button type="button" className="hwd-header-btn" aria-expanded={open} onClick={() => setOpen(!open)}>Header - <span>{open ? "Click to hide" : "Click to show"}</span></button>
      {open && (
        <div className="hwd-letterhead">
          {head.data ? (
            <>
              <address>
                <strong>{head.data.name}</strong>
                {[...head.data.lines, head.data.phone, head.data.email, head.data.website].filter(Boolean).map((l, i) => <span key={i}>{l}</span>)}
              </address>
              {head.data.logoUrl ? <img src={head.data.logoUrl} alt={`${head.data.name} logo`} /> : <span />}
              <p className="muted">Printed at the top of every letter, with the customer&apos;s name and address under it. It comes from Settings → Company.</p>
            </>
          ) : <p className="muted" style={{ margin: 0 }}>{head.error ?? "Loading…"}</p>}
        </div>
      )}
    </>
  );
}

function SuccessAlert({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="hwd-success" role="status">
      <div>{children}</div>
      <button type="button" aria-label="Close" onClick={onClose}>×</button>
    </div>
  );
}

const unknownNote = (unknown: string[] | undefined) => (unknown?.length ? ` ${unknown.map((t) => `{{${t}}}`).join(", ")} ${unknown.length === 1 ? "isn't a fill-in" : "aren't fill-ins"} and will come out blank.` : "");

function RowButton({ icon, label, onClick, danger }: { icon: string; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" className={`hw-icon-btn${danger ? " danger" : ""}`} aria-label={label} title={label} onClick={onClick}><Icon name={icon} size={17} /></button>;
}

/* ───────────── The form both tabs share ───────────── */

type FormState = { id: string | null; name: string; content: string };
const BLANK: FormState = { id: null, name: "", content: "" };

function useDocForm() {
  const [form, setForm] = useState<FormState>(BLANK);
  // A new key remounts the editor with the content just loaded.
  const [editorKey, setEditorKey] = useState(0);
  const [errors, setErrors] = useState<{ name?: string; content?: string }>({});
  const load = useCallback((f: FormState) => { setForm(f); setErrors({}); setEditorKey((k) => k + 1); }, []);
  const check = () => {
    const r = docSchema.safeParse({ name: form.name, content: form.content });
    if (r.success) { setErrors({}); return r.data; }
    const e: { name?: string; content?: string } = {};
    for (const i of r.error.issues) { const k = i.path[0] as "name" | "content"; e[k] ??= i.message; }
    setErrors(e);
    return null;
  };
  return { form, setForm, editorKey, errors, load, check };
}

/* ───────────── Documents ───────────── */

export function DocumentsTab() {
  const list = useApi<Row[]>("/docs");
  const templates = useApi<Row[]>("/docs/templates");
  const f = useDocForm();
  const act = useAction();
  const [template, setTemplate] = useState("");
  const [alert, setAlert] = useState<ReactNode>(null);
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<Row | null>(null);
  const [del, setDel] = useState<Row | null>(null);
  const [send, setSend] = useState<{ mode: "email" | "print"; doc: Row } | null>(null);
  const [replace, setReplace] = useState<string | null>(null);

  const applyTemplate = async (id: string) => {
    const t = await api<Full>(`/docs/templates/${id}`);
    f.load({ id: f.form.id, name: t.name, content: t.content });
  };
  const pickTemplate = (id: string) => {
    setTemplate(id);
    if (!id) return;
    // Don't throw away something already written without asking.
    if (f.form.content.trim() || f.form.name.trim()) setReplace(id); else void act.run(() => applyTemplate(id));
  };
  const save = () => {
    const b = f.check();
    if (!b) return;
    void act.run(async () => {
      const r = await api<Full>(f.form.id ? `/docs/${f.form.id}` : "/docs", { method: f.form.id ? "PUT" : "POST", body: b });
      setAlert(`Document ${f.form.id ? "updated" : "added"} successfully.${unknownNote(r.unknown)}`);
      f.load(BLANK);
      setTemplate("");
      await list.reload();
    });
  };
  const edit = (d: Row) => void act.run(async () => {
    const full = await api<Full>(`/docs/${d.id}`);
    f.load({ id: full.id, name: full.name, content: full.content });
    setTemplate("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const remove = (d: Row) => void act.run(async () => {
    await api(`/docs/${d.id}`, { method: "DELETE" });
    setDel(null);
    if (f.form.id === d.id) f.load(BLANK);
    setAlert("Document deleted successfully.");
    await list.reload();
  });
  const shown = (list.data ?? []).filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="hwd-grid" data-lkeep="">
      <div className="hwd-left" data-lkeep="">
        {alert && <SuccessAlert onClose={() => setAlert(null)}>{alert}</SuccessAlert>}
        <div className="card hwd-form">
          <label className="hw-field">
            <span className="hw-label">Template</span>
            <select value={template} onChange={(e) => pickTemplate(e.target.value)} aria-label="Template">
              <option value="">--- Select Template ---</option>
              {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="hw-field">
            <span className="hw-label">Name <Req /></span>
            <input type="text" maxLength={DOC_NAME_MAX} value={f.form.name} onChange={(e) => f.setForm({ ...f.form, name: e.target.value })} aria-label="Name" aria-invalid={!!f.errors.name} />
            {f.errors.name && <span className="hwd-error">{f.errors.name}</span>}
          </label>
          <HeaderToggle />
          <div className="hw-field">
            <span className="hw-label">Content <Req /></span>
            <DocEditor key={f.editorKey} label="Content" value={f.form.content} onChange={(content) => f.setForm((s) => ({ ...s, content }))} />
            {f.errors.content && <span className="hwd-error">{f.errors.content}</span>}
          </div>
          {act.error && <div className="hw-errors">{act.error}</div>}
          <div className="hwd-buttons">
            {f.form.id && <button type="button" className="btn hw-soft" onClick={() => { f.load(BLANK); setTemplate(""); }}>Cancel</button>}
            <button type="button" className="btn" disabled={act.busy} onClick={save}>{f.form.id ? "Update Document" : "Create Document"}</button>
          </div>
        </div>
      </div>

      <div className="card hwd-list-card">
        <div className="hwd-list-head">{history ? "Document History" : "Documents List"}</div>
        {history ? <HistoryPanel doc={history} onClose={() => setHistory(null)} /> : (
          <div className="hwd-list-body">
            <input type="search" placeholder="Enter document name to search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
            {list.error && <div className="hw-errors">{list.error}</div>}
            {shown.length ? (
              <div className="hwd-rows">
                {shown.map((d) => (
                  <div className="hwd-row" key={d.id}>
                    <span className="hwd-row-name">{d.name}</span>
                    <span className="hwd-row-actions">
                      <RowButton icon="mail" label="Send Email" onClick={() => setSend({ mode: "email", doc: d })} />
                      <RowButton icon="print" label="Print" onClick={() => setSend({ mode: "print", doc: d })} />
                      <RowButton icon="list" label="History" onClick={() => setHistory(d)} />
                      <RowButton icon="pencil" label="Edit" onClick={() => edit(d)} />
                      <RowButton icon="trash" label="Delete" danger onClick={() => setDel(d)} />
                    </span>
                  </div>
                ))}
              </div>
            ) : <p className="hwd-none">{list.loading && !list.data ? "Loading…" : "(No documents found)"}</p>}
          </div>
        )}
      </div>

      {del && <ConfirmDialog title="Delete Document" message="Are you sure you want to delete this document?" busy={act.busy} onYes={() => remove(del)} onNo={() => setDel(null)} />}
      {replace && (
        <ConfirmDialog title="Use Template" message="Replace the name and content you have here with the template's?"
          onYes={() => { const id = replace; setReplace(null); void act.run(() => applyTemplate(id)); }} onNo={() => { setReplace(null); setTemplate(""); }} />
      )}
      {send && <SendDialog mode={send.mode} doc={send.doc} onClose={() => setSend(null)} onDone={(msg) => { setSend(null); setAlert(msg); }} />}
    </div>
  );
}

function HistoryPanel({ doc, onClose }: { doc: Row; onClose: () => void }) {
  const h = useApi<History[]>(`/docs/${doc.id}/history`);
  return (
    <div className="hwd-list-body hwd-history">
      <div className="hwd-history-name">{doc.name}</div>
      {h.error && <div className="hw-errors">{h.error}</div>}
      {(h.data ?? []).map((r) => {
        const t = docHistoryText(r.action, r.detail);
        return (
          <p key={r.id}>
            <strong>{t.verb}</strong>{t.rest} by {r.by ?? "someone no longer here"} on {longDateTime(r.at)}
            {r.detail?.messageId && <> · <Link href={`/customers/messages/${r.detail.messageId}`}>who got it</Link></>}
          </p>
        );
      })}
      {!h.data && !h.error && <p className="muted">Loading…</p>}
      <div style={{ textAlign: "center" }}><button type="button" className="btn hw-soft" onClick={onClose}>Close</button></div>
    </div>
  );
}

/* ───────────── Send Email and Print ───────────── */

/**
 * Homeworks' pop-up: who it goes to on the left, "Select Customers" on the right. Email sends one
 * email per customer (the document as the email, or an email template with the document attached);
 * Print opens one PDF with a letter for each customer.
 */
function SendDialog({ mode, doc, onClose, onDone }: { mode: "email" | "print"; doc: Row; onClose: () => void; onDone: (msg: ReactNode) => void }) {
  const email = mode === "email";
  const [picked, setPicked] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [emailTemplate, setEmailTemplate] = useState("");
  const [attachPdf, setAttachPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [previewFor, setPreviewFor] = useState("");
  const act = useAction();
  const found = useApi<Customer[]>(`/docs/customers?q=${encodeURIComponent(search)}`);
  const emailTemplates = useApi<EmailTemplate[]>(email ? "/templates" : null);
  useEffect(() => { const t = setTimeout(() => setSearch(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  const choices = (found.data ?? []).filter((c) => !pickedIds.has(c.id));
  const cant = (c: Customer) => (!email ? null : c.sample ? "sample customer" : !c.email ? "no email address" : c.optedOut ? "unsubscribed" : null);
  const add = (c: Customer) => {
    if (picked.length >= DOC_CUSTOMERS_MAX) { setError(`Pick up to ${DOC_CUSTOMERS_MAX} customers at a time`); return; }
    setError(null);
    setPicked([...picked, c]);
  };

  const go = () => {
    if (!picked.length) { setError("Please select at least one customer"); return; }
    setError(null);
    const customerIds = picked.map((p) => p.id);
    if (email) {
      void act.run(async () => {
        const r = await api<EmailResult>(`/docs/${doc.id}/email`, { body: { customerIds, emailTemplateId: emailTemplate || null, attachPdf: attachPdf || !!emailTemplate } });
        onDone(
          <>
            {r.sending ? `"${doc.name}" is on its way to ${people(r.sending)}.` : "Nobody could be emailed."}
            {r.skippedNames.length > 0 && <> Skipped: {r.skippedNames.map((x) => `${x.name} (${x.reason.toLowerCase()})`).join(", ")}.</>}
            {r.sending > 0 && <> <Link href={`/customers/messages/${r.messageId}`}>See how it&apos;s going</Link></>}
          </>,
        );
      });
      return;
    }
    void act.run(async () => {
      await openPdf(`/docs/${doc.id}/print`, { customerIds }, `${doc.name}.pdf`);
      onDone(`"${doc.name}" is ready to print for ${people(customerIds.length)}.`);
    });
  };
  const previewId = picked.some((p) => p.id === previewFor) ? previewFor : picked[0]?.id ?? "";
  const togglePreview = () => {
    if (!picked.length) { setError("Please select at least one customer"); return; }
    setError(null);
    setPreview(!preview);
  };

  return (
    <div className="hw-dialog-backdrop hwd-scroll" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`hw-dialog hwd-dialog${email ? "" : " print"}`} role="dialog" aria-modal="true" aria-label={email ? "Send Email" : "Print"}>
        <div className="hwd-dialog-left">
          {email && (
            <label className="hw-field">
              <span className="hw-label">Email Template</span>
              <select value={emailTemplate} onChange={(e) => setEmailTemplate(e.target.value)} aria-label="Email Template">
                <option value="">--- Use The Selected Document As The Email Content ---</option>
                {(emailTemplates.data ?? []).filter((t) => t.channel === "email" && t.audience === "customer").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <div className="hw-field">
            <span className="hw-label">Customers to Send to <Req /></span>
            <div className={`hwd-box${email ? "" : " tall"}`} aria-label="Customers to Send to">
              {picked.length === 0 && <span>(Please select customers from the Select Customers box)</span>}
              {picked.map((p) => (
                <span className="hw-chip" key={p.id}>{p.name}<button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>×</button></span>
              ))}
            </div>
            {error && <span className="hwd-error">{error}</span>}
          </div>
          <div className="hw-field">
            <span className="hw-label">Document</span>
            <div className="hwd-box">{doc.name}</div>
          </div>
          {email && (
            <>
              <label className="check hw-check">
                <input type="checkbox" checked={attachPdf || !!emailTemplate} disabled={!!emailTemplate} onChange={(e) => setAttachPdf(e.target.checked)} /> Attach PDF of document to email
              </label>
              <p className="hwd-hint">
                {emailTemplate
                  ? <><strong>The email template is the email</strong>, and the document goes with it as a PDF.</>
                  : <><strong>The document is the email</strong>, filled in for each customer. Pick an email template above to send it as a PDF attachment with your own cover note.</>}
              </p>
            </>
          )}
          {act.error && <div className="hw-errors">{act.error}</div>}
          <div className="hwd-dialog-foot">
            <button type="button" className="btn hw-soft" onClick={onClose}>Close</button>
            <span className="hwd-foot-right">
              <button type="button" className="btn hw-soft" aria-expanded={preview} onClick={togglePreview}>{preview ? "Hide Preview" : "Preview"}</button>
              <button type="button" className="btn" disabled={act.busy} onClick={go}>{email ? (act.busy ? "Sending…" : "Send Email") : act.busy ? "Printing…" : "Print"}</button>
            </span>
          </div>
        </div>
        <div className="hwd-list-card hwd-pick-card">
          <div className="hwd-list-head">Select Customers</div>
          <div className="hwd-list-body">
            <input type="search" autoFocus placeholder="Enter customer name to search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
            {found.error && <div className="hw-errors">{found.error}</div>}
            <div className="hwd-pick">
              {choices.map((c) => {
                const why = cant(c);
                return (
                  <button type="button" key={c.id} disabled={!!why} onClick={() => add(c)} title={why ? `Can't be emailed: ${why}` : `Add ${c.name}`}>
                    <strong>{c.name}</strong>
                    <small>{why ? `(${why})` : c.email ? `(${c.email})` : "(no email address)"}</small>
                  </button>
                );
              })}
              {found.data && !choices.length && <p className="hwd-none">{found.data.length ? "(Everyone here is already on the list)" : "(No customers found)"}</p>}
              {found.data?.length === 50 && <p className="hwd-none muted">Showing the first 50. Search to find others.</p>}
            </div>
          </div>
        </div>
        {preview && previewId && (
          <div className="hwd-preview">
            <label className="hwd-preview-who">
              <span>Preview for</span>
              <select value={previewId} onChange={(e) => setPreviewFor(e.target.value)} aria-label="Preview for">
                {picked.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <DocPreview docId={doc.id} docName={doc.name} customerId={previewId} emailTemplateId={emailTemplate || null} show={email ? "email" : "letter"} attachPdf={email && (attachPdf || !!emailTemplate)} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────── Preview ───────────── */

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The letter as a page: letterhead, the customer's name and address, then the words. (The PDF is the exact print.) */
function letterPage(head: Letterhead | null, letter: PreviewData["letter"]) {
  const lines = head ? [...head.lines, head.phone, head.email, head.website].filter((x): x is string => !!x) : [];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#eef0f3;padding:14px;font-family:Helvetica,Arial,sans-serif;color:#1a1f29}
.page{background:#fff;max-width:7.6in;margin:0 auto;padding:.45in .5in .8in;box-shadow:0 1px 5px rgba(0,0,0,.22);min-height:8.4in;box-sizing:border-box}
.head{display:flex;justify-content:space-between;gap:16px;font-size:9pt;line-height:1.3;color:#6b7280}
.head b{display:block;font-size:11pt;color:#1a1f29}.head img{max-height:.95in;max-width:2.2in}
.to{margin:.95in 0 0 .35in;font-size:10pt;line-height:1.25}.to b{display:block;font-size:10.5pt}
.body{margin:.9in .35in 0;font-size:11pt;line-height:1.42;overflow-wrap:anywhere}
.body p{margin:0 0 .6em;min-height:1em}.body h2{font-size:15pt;margin:.3em 0 .4em}.body h3{font-size:12.5pt;margin:.3em 0 .4em}
.body ul,.body ol{margin:0 0 .6em;padding-left:1.5em}.body li p{margin:0 0 .2em}
.body blockquote{margin:0 0 .6em;padding-left:12px;border-left:2px solid #d1d5db}.body hr{border:0;border-top:1px solid #d1d5db;margin:.6em 0}.body a{color:#124d99}
</style></head><body><div class="page">
<div class="head"><div>${head ? `<b>${escHtml(head.name)}</b>${lines.map(escHtml).join("<br>")}` : ""}</div>${head?.logoUrl ? `<img src="${escHtml(head.logoUrl)}" alt="">` : ""}</div>
<div class="to"><b>${escHtml(letter.toName)}</b>${letter.toLines.map(escHtml).join("<br>")}</div>
<div class="body">${letter.html}</div>
</div></body></html>`;
}

/**
 * The document as one customer will get it, before anything is sent: the email (the document, or
 * the email template chosen), or the letter as it prints, with the exact PDF one click away.
 */
function DocPreview({ docId, docName, customerId, emailTemplateId, show, attachPdf }: { docId: string; docName: string; customerId: string; emailTemplateId: string | null; show: "email" | "letter"; attachPdf?: boolean }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const head = useApi<Letterhead>(show === "letter" ? "/docs/letterhead" : null);
  const pdf = useAction();
  useEffect(() => {
    let live = true;
    setError(null);
    api<PreviewData>(`/docs/${docId}/preview`, { body: { customerId, emailTemplateId } }).then((d) => { if (live) setData(d); }, (e: Error) => { if (live) { setData(null); setError(e.message); } });
    return () => { live = false; };
  }, [docId, customerId, emailTemplateId]);
  const openLetter = () => void pdf.run(() => openPdf(`/docs/${docId}/print`, { customerIds: [customerId], preview: true }, `${docName}.pdf`));
  if (error) return <div className="hw-errors">{error}</div>;
  if (!data) return <p className="muted" style={{ margin: 0 }}>Loading the preview…</p>;
  return (
    <div className="hwd-preview-body">
      {show === "email" ? (
        <>
          <div className="hwd-preview-line"><span className="muted">To:</span> {data.customer.name} {data.customer.email ? <span className="muted">({data.customer.email})</span> : <span className="hwd-error">(no email address)</span>}</div>
          <div className="hwd-preview-line"><span className="muted">Subject:</span> {data.email.subject}</div>
          <iframe title="Email preview" sandbox="" srcDoc={data.email.html} className="hwd-preview-frame" />
          <p className="hwd-preview-note">
            An Unsubscribe link is added at the bottom of the real email.
            {attachPdf && <> The letter goes with it as a PDF: <button type="button" className="hw-link" disabled={pdf.busy} onClick={openLetter}>{pdf.busy ? "Opening…" : "open the PDF"}</button>.</>}
          </p>
        </>
      ) : (
        <>
          <iframe title="Letter preview" sandbox="" srcDoc={letterPage(head.data, data.letter)} className="hwd-preview-frame letter" />
          <p className="hwd-preview-note">
            This shows the words and layout. <button type="button" className="hw-link" disabled={pdf.busy} onClick={openLetter}>{pdf.busy ? "Opening…" : "Open the exact page as a PDF"}</button> (it doesn&apos;t count as printed).
          </p>
        </>
      )}
      {pdf.error && <div className="hw-errors">{pdf.error}</div>}
    </div>
  );
}

/* ───────────── From the Customers page ───────────── */

/**
 * Customers → Send → Document: email a document to the ticked customers (or everyone the list
 * matches), or print it as letters, with a preview first. Emails go out one by one in the
 * background, like the page's other emails; letters open as one PDF.
 */
export function DocumentSender({ selection, audience, onClose, onSent }: { selection: Selection; audience: string; onClose: () => void; onSent: (m: { id: string; sending: number }) => void }) {
  const docs = useApi<Row[]>("/docs");
  const emailTemplates = useApi<EmailTemplate[]>("/templates");
  const [docId, setDocId] = useState("");
  const [emailTemplate, setEmailTemplate] = useState("");
  const [attachPdf, setAttachPdf] = useState(false);
  const [who, setWho] = useState<Audience | null>(null);
  const [show, setShow] = useState<"email" | "letter">("email");
  const [notice, setNotice] = useState<string | null>(null);
  const counting = useAction();
  const sending = useAction();
  const printing = useAction();
  const doc = docs.data?.find((d) => d.id === docId) ?? null;
  useEffect(() => {
    setWho(null);
    if (!docId) return;
    void counting.run(async () => setWho(await api<Audience>(`/docs/${docId}/audience`, { body: selection })));
  }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = who?.sending ?? 0;
  const tooMany = (count: number) => count > DOC_PRINT_MAX;
  const print = (only: "all" | "notEmailed", count: number) => void printing.run(async () => {
    if (!doc) return;
    setNotice(null);
    await openPdf(`/docs/${doc.id}/print`, { ...selection, only }, `${doc.name}.pdf`);
    setNotice(`Letters for ${people(count)} are ready to print.`);
  });
  return (
    <section className="card stack cm-compose" aria-label="Send a document">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Send a document</h2>
        <button type="button" className="btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        To: <strong>{audience}</strong>
        {who ? <> · an email reaches <strong>{who.sending.toLocaleString()}</strong> of {who.total.toLocaleString()}</> : docId && !counting.error ? " · counting…" : ""}
        {who?.skipped.map((x) => <span key={x.reason}> · {x.n.toLocaleString()} skipped: {x.label.toLowerCase()}</span>)}
      </p>
      {who && !who.emailReady && <div className="hw-errors">Email isn&apos;t set up on this server yet, so nothing can be emailed. Letters can still be printed.</div>}
      <div className="cm-grid">
        <div className="stack">
          <label>Document
            <select value={docId} onChange={(e) => { setDocId(e.target.value); setNotice(null); }} aria-label="Document">
              <option value="">--- Select Document ---</option>
              {(docs.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {docs.data && !docs.data.length ? "You haven't written any documents yet. " : ""}
            Documents are written in <Link href="/docs">Resources → Documents</Link>.
          </p>
          <label>Email Template
            <select value={emailTemplate} onChange={(e) => setEmailTemplate(e.target.value)} aria-label="Email Template">
              <option value="">--- Use The Selected Document As The Email Content ---</option>
              {(emailTemplates.data ?? []).filter((t) => t.channel === "email" && t.audience === "customer").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={attachPdf || !!emailTemplate} disabled={!!emailTemplate} onChange={(e) => setAttachPdf(e.target.checked)} /> Attach PDF of document to email
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {emailTemplate ? "The email template is the email, and the document goes with it as a PDF." : "The document is the email, filled in for each customer."}
            {" "}Each customer gets their own. Customers with no email address, ones who unsubscribed and sample customers are skipped; you can print letters for them instead.
          </p>
        </div>
        <div className="stack cm-preview">
          {doc && who?.first ? (
            <>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div className="todo-label">Preview for {who.first.name}</div>
                <div className="hwd-switch" role="tablist" aria-label="Preview">
                  <button type="button" role="tab" aria-selected={show === "email"} className={show === "email" ? "on" : ""} onClick={() => setShow("email")}>Email</button>
                  <button type="button" role="tab" aria-selected={show === "letter"} className={show === "letter" ? "on" : ""} onClick={() => setShow("letter")}>Printed letter</button>
                </div>
              </div>
              <DocPreview docId={doc.id} docName={doc.name} customerId={who.first.id} emailTemplateId={emailTemplate || null} show={show} attachPdf={attachPdf || !!emailTemplate} />
            </>
          ) : <p className="muted">{doc ? (who ? "Nobody is on this list." : "Loading…") : "Pick a document to see it filled in for the first customer."}</p>}
        </div>
      </div>
      {(counting.error ?? sending.error ?? printing.error) && <div className="hw-errors">{counting.error ?? sending.error ?? printing.error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn primary" disabled={sending.busy || !doc || !n || !who?.emailReady}
          onClick={() => doc && confirm(`Email "${doc.name}" to ${people(n)} now? This can't be unsent.`) && sending.run(async () => {
            const r = await api<EmailResult>(`/docs/${doc.id}/email`, { body: { ...selection, emailTemplateId: emailTemplate || null, attachPdf: attachPdf || !!emailTemplate, audience } });
            onSent({ id: r.messageId, sending: r.sending });
          })}>
          {sending.busy ? "Sending…" : `Email ${people(n)}`}
        </button>
        <button type="button" className="btn" disabled={printing.busy || !doc || !who?.total || tooMany(who.total)} title={who && tooMany(who.total) ? `One PDF holds up to ${DOC_PRINT_MAX.toLocaleString()} letters; narrow the list` : undefined}
          onClick={() => who && print("all", who.total)}>
          {printing.busy ? "Making the letters…" : `Print letters for all ${(who?.total ?? 0).toLocaleString()}`}
        </button>
        {!!who?.byMail && (
          <button type="button" className="btn" disabled={printing.busy || !doc || tooMany(who.byMail)} onClick={() => print("notEmailed", who.byMail)}>
            Print letters for the {who.byMail.toLocaleString()} email can&apos;t reach
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

/* ───────────── Document Templates ───────────── */

export function DocTemplatesTab() {
  const list = useApi<Row[]>("/docs/templates");
  const { can } = useAuth();
  const f = useDocForm();
  const act = useAction();
  const [alert, setAlert] = useState<ReactNode>(null);
  const [del, setDel] = useState<Row | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const imp = useAction();

  const save = () => {
    const b = f.check();
    if (!b) return;
    void act.run(async () => {
      const r = await api<Full>(f.form.id ? `/docs/templates/${f.form.id}` : "/docs/templates", { method: f.form.id ? "PUT" : "POST", body: b });
      setAlert(`Template ${f.form.id ? "updated" : "added"} successfully.${unknownNote(r.unknown)}`);
      f.load(BLANK);
      await list.reload();
    });
  };
  const edit = (t: Row) => void act.run(async () => {
    const full = await api<Full>(`/docs/templates/${t.id}`);
    f.load({ id: full.id, name: full.name, content: full.content });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const remove = (t: Row) => void act.run(async () => {
    await api(`/docs/templates/${t.id}`, { method: "DELETE" });
    setDel(null);
    if (f.form.id === t.id) f.load(BLANK);
    setAlert("Template deleted successfully.");
    await list.reload();
  });
  const importFile = (picked: File | undefined) => {
    if (!picked) return;
    void imp.run(async () => {
      let body: unknown;
      try { body = JSON.parse(await picked.text()); } catch { throw new Error("That isn't the Homeworks documents file Crewdesk made (it should end in .json)."); }
      const r = await api<{ added: number; updated: number; kept: number; skipped: number }>("/docs/import", { body });
      const n = (c: number) => `${c} document template${c === 1 ? "" : "s"}`;
      const bits = [
        r.added ? `${n(r.added)} brought in from Homeworks` : "",
        r.updated ? `${n(r.updated)} brought up to date from the file` : "",
        r.kept ? `${n(r.kept)} left as ${r.kept === 1 ? "it is" : "they are"} because ${r.kept === 1 ? "it was" : "they were"} changed here` : "",
      ].filter(Boolean);
      setAlert(bits.length ? `${bits.join("; ")}.` : "Nothing new in that file: everything in it is already here.");
      await list.reload();
    });
    if (file.current) file.current.value = "";
  };
  const admin = can("admin", "customers");

  return (
    <div className="hwd-grid" data-lkeep="">
      <div className="hwd-left" data-lkeep="">
        {alert && <SuccessAlert onClose={() => setAlert(null)}>{alert}</SuccessAlert>}
        <div className="card hwd-form">
          <label className="hw-field">
            <span className="hw-label">Name <Req /></span>
            <input type="text" maxLength={DOC_NAME_MAX} value={f.form.name} onChange={(e) => f.setForm({ ...f.form, name: e.target.value })} aria-label="Name" aria-invalid={!!f.errors.name} />
            {f.errors.name && <span className="hwd-error">{f.errors.name}</span>}
          </label>
          <HeaderToggle />
          <div className="hw-field">
            <span className="hw-label">Content <Req /></span>
            <DocEditor key={f.editorKey} label="Content" value={f.form.content} onChange={(content) => f.setForm((s) => ({ ...s, content }))} />
            {f.errors.content && <span className="hwd-error">{f.errors.content}</span>}
          </div>
          {act.error && <div className="hw-errors">{act.error}</div>}
          <div className="hwd-buttons">
            {f.form.id && <button type="button" className="btn hw-soft" onClick={() => f.load(BLANK)}>Cancel</button>}
            <button type="button" className="btn" disabled={act.busy} onClick={save}>{f.form.id ? "Update Template" : "Create Template"}</button>
          </div>
        </div>
      </div>

      <div className="card hwd-list-card">
        <div className="hwd-list-head">Templates List</div>
        <div className="hwd-list-body">
          {list.error && <div className="hw-errors">{list.error}</div>}
          {list.data?.length ? (
            <div className="hwd-rows">
              {list.data.map((t) => (
                <div className="hwd-row" key={t.id}>
                  <span className="hwd-row-name">{t.name}</span>
                  <span className="hwd-row-actions">
                    <RowButton icon="pencil" label="Edit" onClick={() => edit(t)} />
                    <RowButton icon="trash" label="Delete" danger onClick={() => setDel(t)} />
                  </span>
                </div>
              ))}
            </div>
          ) : <p className="hwd-none">{list.loading && !list.data ? "Loading…" : "(No templates found)"}</p>}
          {admin && list.data && (
            <div className="hwd-import">
              <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => importFile(e.target.files?.[0])} />
              {!list.data.some((t) => t.imported === "homeworks") && <span>Your Homeworks document templates aren&apos;t here yet. Choose the Homeworks documents file Crewdesk made for you.</span>}
              <button type="button" className={list.data.some((t) => t.imported === "homeworks") ? "hw-link" : "btn sm"} disabled={imp.busy} onClick={() => file.current?.click()}>{imp.busy ? "Importing…" : "Import from Homeworks"}</button>
              {imp.error && <span className="hwd-error">{imp.error}</span>}
            </div>
          )}
        </div>
      </div>

      {del && <ConfirmDialog title="Delete Template" message="Are you sure you want to delete this template?" busy={act.busy} onYes={() => remove(del)} onNo={() => setDel(null)} />}
    </div>
  );
}

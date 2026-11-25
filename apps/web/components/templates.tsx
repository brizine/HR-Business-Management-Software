"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import LinkExt from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";
import {
  MESSAGE_KINDS, MESSAGE_KIND_LABELS, MESSAGE_KIND_NEEDS, TAG_GROUPS, TEMPLATE_AUDIENCES, TEMPLATE_AUDIENCE_LABELS, TEMPLATE_TAGS, TEMPLATE_TEXT_MAX, smsSegments,
  type MessageKind, type TagNeeds, type TemplateAudience, type TemplateChannel, type TemplateDefaults,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { CustomerPicker } from "./customers";
import { Popover } from "./customer-list";
import { ErrorBox } from "./ui";

export type Template = {
  id: string; channel: TemplateChannel; audience: TemplateAudience; name: string; subject: string | null; body: string;
  system: boolean; systemKey: string | null; imported: string | null; updatedAt: string; needs: TagNeeds[]; usedFor: MessageKind[];
  /** Made in the builder. */
  designed?: boolean;
  /** The automations and sequences that send it. */
  usedBy?: string[];
  /** How many pictures in it still come from Homeworks' storage. */
  homeworksPictures?: number;
};
const NEEDS_LABELS: Record<TagNeeds, string> = { invoice: "an invoice", estimate: "an estimate", visit: "a work order", payment: "a payment" };

/* ───────────── Tags ───────────── */

/** Every merge tag by group, with a search; picking one inserts {{TAG}}. */
export function TagMenu({ onPick, label = "Insert tag" }: { onPick: (tag: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const shown = TEMPLATE_TAGS.filter((t) => !q.trim() || `${t.label} ${t.tag} ${t.group}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover open={open} setOpen={setOpen} label={label} buttonClass="btn sm" className="cl-pop-wide" align="right">
      <div className="stack" style={{ gap: 6 }}>
        <input type="search" autoFocus placeholder="Find a tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a tag" />
        <div className="tpl-tags">
          {TAG_GROUPS.map((g) => {
            const ts = shown.filter((t) => t.group === g);
            if (!ts.length) return null;
            return (
              <div key={g}>
                <div className="todo-label">{g}</div>
                {ts.map((t) => (
                  <button key={t.tag} type="button" className="tpl-tag" onClick={() => { onPick(t.tag); setOpen(false); setQ(""); }} title={`{{${t.tag}}} · e.g. ${t.example}${t.needs ? ` · only when sending about ${NEEDS_LABELS[t.needs]}` : ""}`}>
                    {t.label}{t.needs ? <span className="muted"> · {t.needs}</span> : null}
                  </button>
                ))}
              </div>
            );
          })}
          {!shown.length && <p className="muted" style={{ margin: 0 }}>No tags match.</p>}
        </div>
      </div>
    </Popover>
  );
}

/** Puts {{TAG}} where the cursor is in an input or textarea. */
function insertAt(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, set: (v: string) => void, tag: string) {
  const text = `{{${tag}}}`;
  const at = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? at;
  set(value.slice(0, at) + text + value.slice(end));
  requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
}

/* ───────────── The email editor ───────────── */

function Tool({ on, label, title, run, disabled }: { on?: boolean; label: React.ReactNode; title: string; run: () => void; disabled?: boolean }) {
  return <button type="button" className={`tpl-tool${on ? " on" : ""}`} title={title} aria-label={title} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>{label}</button>;
}

/** A formatted email body: bold, italic, underline, headings, lists, alignment, links and tags. */
export function EmailEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, codeBlock: false, code: false }),
      Underline,
      LinkExt.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: "Write the email. Insert tags like the customer's name from the button above." }),
    ],
    content: value,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => onChange(ed.isEmpty ? "" : ed.getHTML()),
  });
  const link = (ed: Editor) => {
    const prev = ed.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link to (a web address, or a link tag like {{REVIEW_PAGE}}). Leave empty to remove the link.", prev ?? "https://");
    if (url === null) return;
    if (!url.trim() || url.trim() === "https://") ed.chain().focus().extendMarkRange("link").unsetLink().run();
    else ed.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };
  if (!editor) return <div className="tpl-editor tpl-editor-loading" />;
  return (
    <div className="tpl-editor">
      <div className="tpl-toolbar" role="toolbar" aria-label="Formatting">
        <Tool on={editor.isActive("bold")} label={<b>B</b>} title="Bold" run={() => editor.chain().focus().toggleBold().run()} />
        <Tool on={editor.isActive("italic")} label={<i>I</i>} title="Italic" run={() => editor.chain().focus().toggleItalic().run()} />
        <Tool on={editor.isActive("underline")} label={<u>U</u>} title="Underline" run={() => editor.chain().focus().toggleUnderline().run()} />
        <span className="tpl-sep" />
        <Tool on={editor.isActive("heading", { level: 2 })} label="H" title="Heading" run={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <Tool on={editor.isActive("bulletList")} label="•" title="Bulleted list" run={() => editor.chain().focus().toggleBulletList().run()} />
        <Tool on={editor.isActive("orderedList")} label="1." title="Numbered list" run={() => editor.chain().focus().toggleOrderedList().run()} />
        <span className="tpl-sep" />
        <Tool on={editor.isActive({ textAlign: "left" })} label="⇤" title="Align left" run={() => editor.chain().focus().setTextAlign("left").run()} />
        <Tool on={editor.isActive({ textAlign: "center" })} label="↔" title="Center" run={() => editor.chain().focus().setTextAlign("center").run()} />
        <span className="tpl-sep" />
        <Tool on={editor.isActive("link")} label="🔗" title="Link" run={() => link(editor)} />
        <Tool label="↶" title="Undo" run={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} />
        <Tool label="↷" title="Redo" run={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} />
        <span style={{ marginLeft: "auto" }} />
        <TagMenu onPick={(t) => editor.chain().focus().insertContent(`{{${t}}}`).run()} />
      </div>
      <EditorContent editor={editor} className="tpl-body" />
    </div>
  );
}

/* ───────────── One template: edit and preview ───────────── */

type Preview = { channel: TemplateChannel; subject?: string; html?: string; text?: string; segments?: ReturnType<typeof smsSegments>; unknown: string[]; needs: TagNeeds[]; missing: TagNeeds[]; sample: boolean };
type Ctx = { invoices: { id: string; label: string }[]; estimates: { id: string; label: string }[]; visits: { id: string; label: string }[]; payments: { id: string; label: string }[] };

/**
 * The editor for one template (or a new one) beside a live preview: with example values, or
 * filled in for a customer you pick (and their invoice, estimate, work order or payment).
 */
export function TemplateEditor({ template, channel, onSaved, onDeleted, onDirty }: {
  template: Template | null; channel: TemplateChannel; onSaved: (t: Template) => void; onDeleted: () => void; onDirty: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [audience, setAudience] = useState<TemplateAudience>(template?.audience ?? "customer");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const act = useAction();
  const dirty = !template ? !!(name || subject || body) : name !== template.name || audience !== template.audience || (subject ?? "") !== (template.subject ?? "") || body !== template.body;
  useEffect(() => { onDirty(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preview: for a customer (and what the message is about), or with example values.
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [pick, setPick] = useState<{ invoiceId?: string; estimateId?: string; visitId?: string; paymentId?: string }>({});
  const ctx = useApi<Ctx>(customer ? `/templates/context?customerId=${customer.id}` : null);
  useEffect(() => {
    if (!ctx.data) return;
    setPick({ invoiceId: ctx.data.invoices[0]?.id, estimateId: ctx.data.estimates[0]?.id, visitId: ctx.data.visits[0]?.id, paymentId: ctx.data.payments[0]?.id });
  }, [ctx.data]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<Preview>("/templates/preview", { method: "POST", body: { channel, subject, body, customerId: customer?.id ?? null, ...pick } })
        .then((p) => { setPreview(p); setPreviewError(null); }, (e) => setPreviewError((e as Error).message));
    }, 350);
    return () => clearTimeout(t);
  }, [channel, subject, body, customer, pick]);

  const save = () => act.run(async () => {
    const payload = { channel, audience, name, subject: channel === "email" ? subject : null, body };
    const t = template ? await api<Template>(`/templates/${template.id}`, { method: "PUT", body: payload }) : await api<Template>("/templates", { method: "POST", body: payload });
    setBody(t.body); setSubject(t.subject ?? "");
    setNotice("Saved.");
    onSaved(t);
  });
  const testSend = () => act.run(async () => {
    const r = await api<{ to: string }>("/templates/test", { method: "POST", body: { channel, subject, body, customerId: customer?.id ?? null, ...pick } });
    setNotice(`Sent a test to ${r.to}.`);
  });
  const clone = () => act.run(async () => { const t = await api<Template>(`/templates/${template!.id}/clone`, { method: "POST" }); onSaved(t); });
  const remove = () => { if (confirm(`Delete "${template!.name}"?`)) act.run(async () => { await api(`/templates/${template!.id}`, { method: "DELETE" }); onDeleted(); }); };
  const reset = () => { if (confirm("Put back Crewdesk's original wording?")) act.run(async () => { const t = await api<Template>(`/templates/${template!.id}/reset`, { method: "POST" }); setName(t.name); setSubject(t.subject ?? ""); setBody(t.body); onSaved(t); }); };

  const needs = preview?.needs ?? [];
  const show = (n: TagNeeds) => needs.includes(n) && customer;
  const choose = (k: keyof typeof pick, list: { id: string; label: string }[] | undefined, label: string) => (
    <label>{label}
      <select value={pick[k] ?? ""} onChange={(e) => setPick({ ...pick, [k]: e.target.value || undefined })}>
        <option value="">{list?.length ? "None" : "They have none"}</option>
        {(list ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
    </label>
  );

  return (
    <div className="tpl-edit">
      <form className="card stack tpl-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{template ? template.name : `New ${channel} template`}</h2>
          <span className="row" style={{ gap: 6 }}>
            {template?.system && <span className="badge" title="Crewdesk's own: change the wording, or reset it">Crewdesk</span>}
            {template?.imported && <span className="badge">From {template.imported === "homeworks" ? "Homeworks" : template.imported}</span>}
            {template?.usedFor.map((k) => <span key={k} className="badge ok" title="Goes out with these (Defaults tab)">Used for {MESSAGE_KIND_LABELS[k].toLowerCase()}</span>)}
          </span>
        </div>
        <div className="formgrid">
          <label>Name *<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={channel === "email" ? "Spring aeration offer" : "On our way"} /></label>
          <label>Who it&apos;s for
            <select value={audience} onChange={(e) => setAudience(e.target.value as TemplateAudience)}>
              {TEMPLATE_AUDIENCES.map((a) => <option key={a} value={a}>{TEMPLATE_AUDIENCE_LABELS[a]}</option>)}
            </select>
          </label>
        </div>
        {channel === "email" && (
          <label>
            <span className="row" style={{ justifyContent: "space-between" }}>Subject *<TagMenu label="Insert tag" onPick={(t) => insertAt(subjectRef.current, subject, setSubject, t)} /></span>
            <input ref={subjectRef} required maxLength={250} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your invoice is ready, {{CUSTOMER_FIRST_NAME}}" />
          </label>
        )}
        {channel === "email" ? (
          <EmailEditor key={template?.id ?? "new"} value={body} onChange={setBody} />
        ) : (
          <label>
            <span className="row" style={{ justifyContent: "space-between" }}>Message *<TagMenu onPick={(t) => insertAt(textRef.current, body, setBody, t)} /></span>
            <textarea ref={textRef} required rows={7} maxLength={TEMPLATE_TEXT_MAX} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hi {{CUSTOMER_FIRST_NAME}}, we're on our way to {{EVENT_PROPERTY_ADDRESS}}!" />
          </label>
        )}
        {preview?.unknown.length ? <div className="alert warn">Not tags Crewdesk knows (check the spelling): {preview.unknown.map((u) => `{{${u}}}`).join(", ")}</div> : null}
        {needs.length > 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Uses details of {needs.map((n) => NEEDS_LABELS[n]).join(" and ")}: those tags are filled in when it&apos;s sent about one{needs.includes("invoice") || needs.includes("estimate") || needs.includes("payment") ? " (Defaults tab)" : ""}, and left empty otherwise.</p>}
        <ErrorBox error={act.error} />
        {notice && !act.error && <p className="muted" style={{ margin: 0 }}>{notice}</p>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={act.busy || !dirty}>{template ? "Save" : "Create template"}</button>
          {channel === "email" && <button type="button" className="btn" disabled={act.busy} onClick={testSend} title="Sends this (as it is now) to your own email">Send me a test</button>}
          {template && <button type="button" className="btn" disabled={act.busy} onClick={clone}>Copy</button>}
          {template?.system && <button type="button" className="btn" disabled={act.busy} onClick={reset}>Reset to Crewdesk&apos;s wording</button>}
          {template && !template.system && <button type="button" className="btn bad-text" disabled={act.busy} onClick={remove} style={{ marginLeft: "auto" }}>Delete</button>}
        </div>
      </form>

      <div className="card stack tpl-preview">
        <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Preview</h3>
          <span className="muted" style={{ fontSize: 13 }}>{preview?.sample ? "With example values" : customer ? `For ${customer.name}` : ""}</span>
        </div>
        {customer ? (
          <div className="row" style={{ gap: 8 }}><span>Customer: <strong>{customer.name}</strong></span><button type="button" className="linkbtn" onClick={() => { setCustomer(null); setPick({}); }}>Use example values</button></div>
        ) : <CustomerPicker label="Preview for a customer" onPick={(c) => setCustomer(c)} />}
        {customer && (show("invoice") || show("estimate") || show("visit") || show("payment")) && (
          <div className="formgrid">
            {show("invoice") && choose("invoiceId", ctx.data?.invoices, "Invoice")}
            {show("estimate") && choose("estimateId", ctx.data?.estimates, "Estimate")}
            {show("visit") && choose("visitId", ctx.data?.visits, "Work order")}
            {show("payment") && choose("paymentId", ctx.data?.payments, "Payment")}
          </div>
        )}
        {preview?.missing.length ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>No {preview.missing.map((n) => NEEDS_LABELS[n].replace(/^an? /, "")).join(" or ")} picked, so those tags are empty here.</p> : null}
        <ErrorBox error={previewError} />
        {preview?.channel === "email" && preview.html != null && (
          <>
            <div className="tpl-subject"><span className="muted">Subject:</span> {preview.subject}</div>
            <iframe className="tpl-frame" title="Email preview" sandbox="" srcDoc={preview.html} />
          </>
        )}
        {preview?.channel === "text" && preview.text != null && (
          <>
            <div className="tpl-bubble">{preview.text || <span className="muted">(empty)</span>}</div>
            {preview.segments && preview.segments.segments > 0 && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {preview.segments.units} characters · {preview.segments.segments} text{preview.segments.segments === 1 ? "" : "s"} per send
                {preview.segments.encoding === "Unicode" ? " (the emoji or special characters make each text hold 70 characters instead of 160)" : ""}.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────── Defaults ───────────── */

/** Which template goes out with invoices, estimates and receipts (like Homeworks' invoice and estimate settings). */
export function DefaultsTab({ templates, canEdit }: { templates: Template[]; canEdit: boolean }) {
  const d = useApi<TemplateDefaults>("/templates/defaults/current");
  const [draft, setDraft] = useState<TemplateDefaults | null>(null);
  useEffect(() => { if (d.data) setDraft(d.data); }, [d.data]);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  if (!draft) return <ErrorBox error={d.error} />;
  // Only templates for customers that use nothing the message doesn't have (and whatever is chosen now).
  const fits = (t: Template, k: MessageKind) => (t.audience === "customer" && t.needs.every((n) => MESSAGE_KIND_NEEDS[k].includes(n))) || t.id === draft[k].email || t.id === draft[k].text;
  const set = (k: MessageKind, patch: Partial<TemplateDefaults["invoice"]>) => { setDraft({ ...draft, [k]: { ...draft[k], ...patch } }); setSaved(false); };
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); act.run(async () => { setDraft(await api<TemplateDefaults>("/templates/defaults/current", { method: "PUT", body: draft })); setSaved(true); }); }}>
      <p className="muted" style={{ margin: 0 }}>What Crewdesk sends when you send an invoice or estimate, and when a customer pays online. Texts go to customers whose invoices are set to go by text, once texting is connected.</p>
      <div className="tablewrap">
        <table className="tpl-defaults">
          <thead><tr><th /><th>Email template</th><th>Text template</th><th>Attach the PDF</th></tr></thead>
          <tbody>
            {MESSAGE_KINDS.map((k) => (
              <tr key={k}>
                <th scope="row">{MESSAGE_KIND_LABELS[k]}</th>
                <td>
                  <select aria-label={`${MESSAGE_KIND_LABELS[k]} email template`} disabled={!canEdit} value={draft[k].email ?? ""} onChange={(e) => set(k, { email: e.target.value || null })}>
                    {templates.filter((t) => t.channel === "email" && fits(t, k)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td>
                  <select aria-label={`${MESSAGE_KIND_LABELS[k]} text template`} disabled={!canEdit} value={draft[k].text ?? ""} onChange={(e) => set(k, { text: e.target.value || null })}>
                    <option value="">Don&apos;t text</option>
                    {templates.filter((t) => t.channel === "text" && fits(t, k)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td><label className="check"><input type="checkbox" disabled={!canEdit} checked={draft[k].attachPdf} onChange={(e) => set(k, { attachPdf: e.target.checked })} /> {k === "receipt" ? "The paid invoice" : k === "invoice" ? "The invoice" : "The estimate"}</label></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label style={{ maxWidth: 520 }}>Your review link (for {"{{REVIEW_PAGE}}"})
        <input disabled={!canEdit} value={draft.reviewUrl ?? ""} onChange={(e) => { setDraft({ ...draft, reviewUrl: e.target.value }); setSaved(false); }} placeholder="https://g.page/r/your-business/review" />
      </label>
      <ErrorBox error={act.error} />
      {canEdit ? <div className="row"><button className="btn primary" disabled={act.busy}>Save</button>{saved && <span className="muted">Saved.</span>}</div> : <p className="muted" style={{ margin: 0 }}>Only admins in Customers &amp; billing change these.</p>}
    </form>
  );
}

/** Brings in the templates exported from Homeworks (a .json file); ones already brought in are skipped. */
export function ImportTemplates({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();
  const file = useRef<HTMLInputElement>(null);
  const run = (f: File) => act.run(async () => {
    let json: unknown;
    try { json = JSON.parse(await f.text()); } catch { throw new Error("That file isn't a templates file (.json)"); }
    const r = await api<{ added: number; updated: number; kept: number; skipped: number }>("/templates/import", { method: "POST", body: json });
    const n = (c: number) => `${c} template${c === 1 ? "" : "s"}`;
    setMsg([`Added ${n(r.added)}`, r.updated ? `brought ${n(r.updated)} up to date` : "", r.kept ? `left ${n(r.kept)} alone (changed here)` : "", r.skipped ? `skipped ${r.skipped} (already here or empty)` : ""].filter(Boolean).join("; ") + ".");
    onDone();
  });
  return (
    <Popover open={open} setOpen={setOpen} label="Import" align="right" className="cl-pop-wide">
      <div className="stack" style={{ gap: 8 }}>
        <strong>Import templates from Homeworks</strong>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Choose the Homeworks file Crewdesk made (.json). Each template comes in once. A newer file brings a template up to date only if nobody has changed it here.</p>
        <input ref={file} type="file" accept=".json,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) run(f); e.target.value = ""; }} />
        <ErrorBox error={act.error} />
        {msg && <p style={{ margin: 0 }}>{msg}</p>}
      </div>
    </Popover>
  );
}

/** Templates in the list, filtered by a search and who they're for. */
export function useFilteredTemplates(all: Template[], channel: TemplateChannel, q: string, who: string) {
  return useMemo(() => all
    .filter((t) => t.channel === channel)
    .filter((t) => !who || (who === "system" ? t.system : who === "homeworks" ? t.imported === "homeworks" : t.audience === who))
    .filter((t) => !q.trim() || `${t.name} ${t.subject ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())), [all, channel, q, who]);
}

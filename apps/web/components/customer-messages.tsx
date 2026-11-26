"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MESSAGE_FIELDS, MESSAGE_STATUS_LABELS, unknownFields } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/** Who a Send is for: the ticked customers, or everyone the list matches. */
export type Selection = { ids: string[] } | { match: { status: string; q?: string; filters: unknown[] } };

type Preview = {
  total: number; sending: number; skipped: { reason: string; label: string; n: number }[]; emailReady: boolean;
  sample: { name: string; email: string | null; subject: string; html: string; text: string } | null;
  /** A template's fill-ins about an invoice, estimate, work order or payment (blank in an email to a list). */
  needs?: string[];
};
const NEEDS_WORDS: Record<string, string> = { invoice: "an invoice", estimate: "an estimate", visit: "a work order", payment: "a payment" };

/**
 * Email the customers picked on the list: subject and message with fill-in fields, a live preview
 * as the first customer will see it, a test to yourself, then send. The emails go out one by one in
 * the background; the Bulk emails tab shows how it's going.
 */
export function EmailComposer({ selection, audience, onClose, onSent }: { selection: Selection; audience: string; onClose: () => void; onSent: (m: { id: string; sending: number }) => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // An email template from Marketing → Templates, sent as designed, instead of a typed message.
  const [templateId, setTemplateId] = useState("");
  const templates = useApi<{ id: string; name: string; channel: string; audience: string }[]>("/templates");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const sending = useAction();
  const testing = useAction();
  const loading = useAction();
  // The counts and preview follow what's typed (after a pause).
  useEffect(() => {
    const t = setTimeout(() => loading.run(async () => setPreview(await api<Preview>("/customer-messages/preview", { body: templateId ? { ...selection, templateId } : { ...selection, subject, body } }))), !templateId && (subject || body) ? 400 : 0);
    return () => clearTimeout(t);
  }, [subject, body, templateId]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = templateId ? true : !!subject.trim() && !!body.trim();
  const content = templateId ? { templateId } : { subject, body };
  const insert = (field: string) => {
    const el = box.current;
    const tag = `{${field}}`;
    if (!el) { setBody(body + tag); return; }
    const [a, b] = [el.selectionStart ?? body.length, el.selectionEnd ?? body.length];
    setBody(body.slice(0, a) + tag + body.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  };
  const typos = unknownFields(`${subject} ${body}`);
  const n = preview?.sending ?? 0;
  return (
    <section className="card stack cm-compose" aria-label="Email customers">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Email customers</h2>
        <button type="button" className="btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        To: <strong>{audience}</strong>
        {preview ? <> · goes to <strong>{preview.sending.toLocaleString()}</strong> of {preview.total.toLocaleString()}</> : " · counting…"}
        {preview?.skipped.map((s) => <span key={s.reason}> · {s.n.toLocaleString()} skipped: {s.label.toLowerCase()}</span>)}
      </p>
      {preview && !preview.emailReady && <ErrorBox error="Email isn't set up on this server yet, so nothing can be sent." />}
      <div className="cm-grid">
        <div className="stack">
          <label>Template
            <select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setNotice(null); }} aria-label="Template">
              <option value="">--- Write a message here ---</option>
              {(templates.data ?? []).filter((t) => t.channel === "email" && t.audience === "customer").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {templateId ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              It goes out as designed in <Link href="/templates">Marketing → Templates</Link>, filled in for each customer, with your company details and an unsubscribe link underneath.
              {preview?.needs?.length ? <span className="bad-text"> This template has fill-ins about {preview.needs.map((k) => NEEDS_WORDS[k] ?? k).join(" and ")}; they&apos;ll be blank in an email to a list.</span> : null}
            </p>
          ) : (<>
          <label>Subject<input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Spring service starts next week" /></label>
          <label>Message
            <textarea ref={box} rows={10} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)}
              placeholder={"Hi {first_name},\n\nOur spring round starts next week…\n\nThanks,\n{company}"} />
          </label>
          <div className="cm-fields" aria-label="Fill-in fields">
            <span className="muted">Insert:</span>
            {MESSAGE_FIELDS.map(([k, label, hint]) => <button key={k} type="button" className="cl-addcol" title={hint || undefined} onClick={() => insert(k)}>{label}</button>)}
          </div>
          {typos.length > 0 && <p className="bad-text" style={{ margin: 0 }}>Not a fill-in field (check the spelling): {typos.join(", ")}</p>}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Your company name, address and phone, and an unsubscribe link, are added at the bottom. Replies go to your company email.
            Customers who unsubscribe still get their invoices and receipts.
          </p>
          </>)}
        </div>
        <div className="stack cm-preview">
          <div className="todo-label">Preview{preview?.sample ? ` for ${preview.sample.name}` : ""}</div>
          {preview?.sample ? (
            <>
              <div className="cm-subject"><span className="muted">Subject:</span> {preview.sample.subject || <span className="muted">(none yet)</span>}</div>
              <iframe title="Email preview" sandbox="" srcDoc={preview.sample.html} className="cm-frame" />
            </>
          ) : <p className="muted">{preview && !preview.sending ? "Nobody on this list can get it." : templateId ? "Loading the preview…" : "Type a subject or message, or pick a template, to see it filled in."}</p>}
        </div>
      </div>
      <ErrorBox error={sending.error ?? testing.error ?? loading.error} />
      {notice && <div className="notice" role="status">{notice}</div>}
      <div className="row">
        <button type="button" className="btn primary" disabled={sending.busy || !n || !ready || !preview?.emailReady}
          onClick={() => confirm(`Email ${n.toLocaleString()} customer${n === 1 ? "" : "s"} now? This can't be unsent.`) && sending.run(async () => {
            const m = await api<{ id: string; counts: { queued: number } }>("/customer-messages", { body: { ...selection, ...content, audience } });
            onSent({ id: m.id, sending: m.counts?.queued ?? n });
          })}>
          Send to {n.toLocaleString()} customer{n === 1 ? "" : "s"}
        </button>
        <button type="button" className="btn" disabled={testing.busy || !ready || !preview?.emailReady}
          onClick={() => testing.run(async () => { const r = await api<{ to: string }>("/customer-messages/test", { body: { ...selection, ...content } }); setNotice(`Sent a test to ${r.to}.`); })}>
          Send me a test
        </button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

/**
 * Phone numbers for the customers picked, one per line, to paste into Talkroute's bulk texting
 * (texting straight from Crewdesk needs Talkroute's API).
 */
export function CopyPhones({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const [data, setData] = useState<{ phones: { name: string; phone: string }[]; missing: number; sample: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const { error, run } = useAction();
  useEffect(() => { run(async () => setData(await api("/customer-messages/phones", { body: selection }))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const text = (data?.phones ?? []).map((p) => p.phone).join("\n");
  const download = () => {
    const csv = ["Name,Phone", ...(data?.phones ?? []).map((p) => `"${p.name.replace(/"/g, '""')}",${p.phone}`)].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "phone-numbers.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <section className="card stack" aria-label="Phone numbers for texting">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Phone numbers for texting</h2>
        <button type="button" className="btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <ErrorBox error={error} />
      {!data ? <p className="muted">Gathering numbers…</p> : (
        <>
          <p style={{ margin: 0 }}>
            <strong>{data.phones.length.toLocaleString()}</strong> number{data.phones.length === 1 ? "" : "s"}
            {data.missing ? <span className="muted"> · {data.missing.toLocaleString()} customer{data.missing === 1 ? " has" : "s have"} no full phone number</span> : null}
            {data.sample ? <span className="muted"> · {data.sample.toLocaleString()} sample customer{data.sample === 1 ? "" : "s"} left out</span> : null}
            <span className="muted"> · the same number is listed once</span>
          </p>
          <textarea readOnly rows={Math.min(8, Math.max(3, data.phones.length))} value={text} aria-label="Phone numbers" />
          <div className="row">
            <button type="button" className="btn primary" disabled={!text} onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>{copied ? "Copied" : "Copy numbers"}</button>
            <button type="button" className="btn" disabled={!text} onClick={download}>Download (names and numbers)</button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Paste them into Talkroute&apos;s bulk texting. Texting from Crewdesk itself, with replies on the customer&apos;s page, needs API access from Talkroute.
          </p>
        </>
      )}
    </section>
  );
}

type CustomerEmailsData = { emailOptOutAt: string | null; messages: { id: string; subject: string; createdAt: string; status: string; sentAt: string | null; email: string | null; skipLabel: string | null }[] };
const RECIPIENT_STATUS: Record<string, string> = { queued: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Didn't go", skipped: "Skipped" };

/** On a customer's page: emails sent to them from the Customers list, and whether they've unsubscribed. */
export function CustomerEmails({ customerId }: { customerId: string }) {
  const data = useApi<CustomerEmailsData>(`/customer-messages/customer/${customerId}`);
  const { busy, error, run } = useAction();
  const d = data.data;
  if (!d || (!d.messages.length && !d.emailOptOutAt)) return null;
  return (
    <div className="card">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Emails to customers</h2>
      {d.emailOptOutAt && (
        <p className="row" style={{ gap: 8 }}>
          <span className="badge">Unsubscribed {fmtDate(d.emailOptOutAt)}</span>
          <span className="muted">They still get invoices and receipts.</span>
          <button type="button" className="linkbtn" disabled={busy} onClick={() => confirm("Only put them back on if they asked to be. Resubscribe?") && run(async () => { await api(`/customer-messages/customer/${customerId}/resubscribe`, { method: "POST" }); data.reload(); })}>Resubscribe</button>
        </p>
      )}
      <ErrorBox error={error} />
      {d.messages.length > 0 && (
        <ul className="plain-list">
          {d.messages.map((m) => (
            <li key={m.id}>
              <Link href={`/customers/messages/${m.id}`}><strong>{m.subject}</strong></Link>
              <span className="muted"> · {fmtDate(m.sentAt ?? m.createdAt)} · {RECIPIENT_STATUS[m.status] ?? m.status}{m.skipLabel ? ` (${m.skipLabel.toLowerCase()})` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const MESSAGE_STATUS = MESSAGE_STATUS_LABELS;
export const RECIPIENT_STATUS_LABELS = RECIPIENT_STATUS;

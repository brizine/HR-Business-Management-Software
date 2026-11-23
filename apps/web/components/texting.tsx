"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TEXT_MAX, formatPhone, textSegments } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/** Texting customers from your own number: the connection, a customer's conversation, and the inbox. */

type Settings = { available: boolean; connected: boolean; provider: string; fromNumber?: string; connectedAt?: string; accountName?: string | null };

/** Settings → Integrations. */
export function TextingCard() {
  const { can } = useAuth();
  const owner = can("owner", "customers");
  const s = useApi<Settings>("/texting/settings");
  const [key, setKey] = useState("");
  const [from, setFrom] = useState("");
  const { busy, error, run } = useAction();
  const d = s.data;
  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Texting (Talkroute)</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>Text customers from your Talkroute number, so they keep texting the number they know. Texts and replies show on the customer&apos;s page, and replies come to you as notifications.</p>
      </div>
      <ErrorBox error={s.error} />
      {d?.connected ? (
        <>
          <div className="row" style={{ gap: 8 }}><span className="badge ok">Connected</span><span>{formatPhone(d.fromNumber)}{d.accountName ? ` · ${d.accountName}` : ""}</span></div>
          {owner && <div><button className="btn danger" disabled={busy} onClick={() => confirm("Disconnect texting? Automations that text will skip their texts until it's connected again.") && run(async () => { await api("/texting/settings", { method: "DELETE" }); s.reload(); })}>Disconnect</button></div>}
        </>
      ) : d && !d.available ? (
        <p className="notice" style={{ margin: 0 }}>Not available yet. Talkroute gives API access on request (with a plan that includes texting through the API). Once you have an API key from Talkroute, the connection can be finished and turned on here.</p>
      ) : d && owner ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/texting/settings", { method: "PUT", body: { apiKey: key, fromNumber: from } }); setKey(""); s.reload(); }); }}>
          <label>Talkroute API key<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required /></label>
          <label>Your Talkroute number<input inputMode="tel" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="(405) 555-0100" required /></label>
          <div><button className="btn primary" disabled={busy}>Connect</button></div>
        </form>
      ) : d ? <p className="muted" style={{ margin: 0 }}>Only the owner can connect texting.</p> : null}
      <ErrorBox error={error} />
    </div>
  );
}

type Text = { id: string; direction: "in" | "out"; body: string; status: string; error: string | null; source: string; by: string | null; at: string };
type Conversation = { connected: boolean; number: string | null; optedOut: string | null; texts: Text[] };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The box under "Write a text": counts characters and how many texts it'll be sent as. */
export function TextComposer({ onSend, disabled, placeholder }: { onSend: (body: string) => Promise<void>; disabled?: boolean; placeholder?: string }) {
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  const seg = textSegments(body);
  return (
    <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); run(async () => { await onSend(body.trim()); setBody(""); }); }}>
      <textarea rows={3} maxLength={TEXT_MAX} value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder ?? "Write a text"} disabled={disabled} aria-label="Text message" />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 12 }}>{seg.length} characters{seg.segments > 1 ? ` · sent as ${seg.segments} texts` : ""}{seg.unicode ? " · emoji or special characters make texts shorter" : ""}</span>
        <button className="btn primary" disabled={busy || disabled || !body.trim()}>{busy ? "Sending…" : "Send text"}</button>
      </div>
      <ErrorBox error={error} />
    </form>
  );
}

/** A customer's texts, oldest at the top, with a box to send one. */
export function CustomerTexts({ customerId, focus }: { customerId: string; focus?: boolean }) {
  const conv = useApi<Conversation>(`/texting/customers/${customerId}`);
  const end = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [conv.data?.texts.length]);
  useEffect(() => { if (focus) card.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [focus]);
  const d = conv.data;
  return (
    <div className="card" ref={card}>
      <h2 className="cp-h">Texts{d?.number ? <span className="muted" style={{ fontWeight: 400 }}> · {formatPhone(d.number)}</span> : null}</h2>
      <ErrorBox error={conv.error} />
      {d && (
        <>
          {d.texts.length > 0 ? (
            <div className="sms-thread" role="log" aria-label="Texts">
              {d.texts.map((t) => (
                <div key={t.id} className={`sms ${t.direction}${t.status === "failed" ? " failed" : ""}`}>
                  <div className="sms-body">{t.body}</div>
                  <div className="sms-meta">{when(t.at)}{t.direction === "out" ? ` · ${t.source === "automation" ? "automation" : t.by ?? "office"}${t.status === "failed" ? ` · not sent: ${t.error ?? ""}` : ""}` : ""}</div>
                </div>
              ))}
              <div ref={end} />
            </div>
          ) : <p className="muted" style={{ margin: "6px 0" }}>No texts yet.</p>}
          {!d.connected ? <p className="muted" style={{ margin: 0 }}>Texting isn&apos;t connected yet (Settings → Integrations).</p>
            : d.optedOut ? <p className="bad-text" style={{ margin: 0 }}>They replied STOP on {new Date(d.optedOut).toLocaleDateString()}, so they can&apos;t be texted until they reply START.</p>
            : !d.number ? <p className="muted" style={{ margin: 0 }}>Add a mobile number to text them.</p>
            : <TextComposer onSend={async (body) => { await api(`/texting/customers/${customerId}`, { body: { body } }); conv.reload(); }} />}
        </>
      )}
    </div>
  );
}

type Inbox = { unread: number; conversations: { customerId: string | null; name: string | null; phone: string; last: { body: string; direction: string; status: string; at: string }; unread: number }[] };

/** The Texts page: every conversation, newest first, unread ones marked. */
export function TextInbox() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inbox = useApi<Inbox>(`/texting/conversations${unreadOnly ? "?unread=1" : ""}`);
  const settings = useApi<Settings>("/texting/settings");
  const [assigning, setAssigning] = useState<string | null>(null);
  const { error, run } = useAction();
  const d = inbox.data;
  return (
    <div className="stack">
      {settings.data && !settings.data.connected && <p className="notice" style={{ margin: 0 }}>Texting isn&apos;t connected yet, so nothing new comes in here. See Settings → Integrations.</p>}
      <div className="row"><label className="check"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>{d && d.unread > 0 && <span className="badge warn">{d.unread} unread</span>}</div>
      <ErrorBox error={inbox.error ?? error} />
      <div className="card" style={{ padding: 0 }}>
        {d?.conversations.length ? (
          <ul className="plain-list sms-inbox">
            {d.conversations.map((c) => (
              <li key={c.customerId ?? c.phone} className={c.unread ? "unread" : ""}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{c.customerId ? <Link href={`/customers/${c.customerId}?tab=communication&texts=1`}>{c.name}</Link> : formatPhone(c.phone)}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{when(c.last.at)}{c.unread ? ` · ${c.unread} new` : ""}</span>
                </div>
                <div className="muted sms-preview">{c.last.direction === "out" ? "You: " : ""}{c.last.body}</div>
                {!c.customerId && (
                  assigning === c.phone
                    ? <CustomerPick onPick={(id) => run(async () => { await api("/texting/assign", { body: { phone: c.phone, customerId: id } }); setAssigning(null); inbox.reload(); })} onCancel={() => setAssigning(null)} />
                    : <button type="button" className="linkbtn" onClick={() => setAssigning(c.phone)}>Not a customer yet. File under a customer…</button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted" style={{ padding: 16, margin: 0 }}>{inbox.loading ? "Loading…" : unreadOnly ? "Nothing unread." : "No texts yet."}</p>}
      </div>
    </div>
  );
}

function CustomerPick({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const res = useApi<{ rows: { id: string; name: string; number: number }[] }>(q.trim().length >= 2 ? `/customers?status=all&limit=8&q=${encodeURIComponent(q.trim())}` : null);
  return (
    <div className="stack" style={{ gap: 4, marginTop: 6 }}>
      <div className="row"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer name" aria-label="Find a customer" /><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
      {(res.data?.rows ?? []).map((r) => <button key={r.id} type="button" className="linkbtn" style={{ textAlign: "left" }} onClick={() => onPick(r.id)}>{r.name} <span className="muted">#{r.number}</span></button>)}
    </div>
  );
}

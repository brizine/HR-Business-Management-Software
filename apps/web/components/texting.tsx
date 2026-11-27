"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  TEXT_DAYS, TEXT_DAY_LABELS, TEXT_HISTORY_DAYS, TEXT_MAX, TEXT_MEDIA_MAX_BYTES, formatPhone, textInitials, textSegments, textWords,
  type TextDay, type TextFilter, type TextingChoices, type TextingJob,
} from "@crewdesk/shared";
import { API_URL, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { ConfirmDialog } from "./automation-bits";
import { Icon } from "./icons";
import { TagMenu } from "./templates";

/**
 * Texting from the company's own number (Talkroute), laid out like Homeworks' Resources → Text:
 * Text Messages (every conversation, with the one that's open beside the list), Send Text Messages
 * (to customers, groups, the team, crews or a number), and the Error Log. Also the connection on
 * Settings → Integrations, with who's told when a text comes in, and a customer's texts on their page.
 */

type Settings = {
  available: boolean; connected: boolean; provider: string; fromNumber?: string; connectedAt?: string; accountName?: string | null; webhook?: boolean; hookAt?: string | null;
  notify: { picked: boolean; people: { id: string; name: string }[] };
  calls?: boolean; options: TextingChoices; history: TextingJob | null; contacts: TextingJob | null; timezone: string; myQuiet: Quiet;
};
type Quiet = { start: string; end: string } | null;
type Media = { id: string; fileName: string; contentType: string };
type Text = { id: string; direction: "in" | "out" | "note"; body: string; status: string; error: string | null; source: string; by: string | null; at: string; sendAt?: string | null; media?: Media[] };
type ThreadRow = {
  id: string; phone: string; kind: "customer" | "employee" | "unknown"; name: string | null; customerId: string | null; employeeId: string | null;
  status: "open" | "done"; unread: number; optedOut: string | null; last: { body: string; direction: "in" | "out"; status: string; at: string };
  assignedId: string | null; assignedName?: string | null;
};
type ThreadList = { total: number; page: number; pageSize: number; unread: number; threads: ThreadRow[] };
type ThreadFull = ThreadRow & { connected: boolean; fromNumber: string | null; texts: Text[] };
type Template = { id: string; channel: string; audience: string; name: string; body: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** Today's texts show the time; older ones the date (as Homeworks' list does). */
const shortWhen = (iso: string) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
const who = (t: { name: string | null; phone: string }) => t.name ?? formatPhone(t.phone);

/** Tells the chat bubble on the top bar to count again (something was read or arrived). */
const changed = () => window.dispatchEvent(new Event("crewdesk:texts"));

/* ───────────── Settings → Integrations ───────────── */

type NumberRow = { number: string; label: string | null; canSend: boolean; registered?: boolean | null };

export function TextingCard() {
  const { can } = useAuth();
  const owner = can("owner", "customers"), admin = can("admin", "customers");
  const s = useApi<Settings>("/texting/settings");
  const [key, setKey] = useState("");
  const [numbers, setNumbers] = useState<NumberRow[] | null>(null);
  const [from, setFrom] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const d = s.data;
  const find = () => run(async () => {
    const r = await api<{ numbers: NumberRow[] }>("/texting/settings/numbers", { body: { apiKey: key } });
    setNumbers(r.numbers);
    setFrom(r.numbers.find((n) => n.canSend)?.number ?? "");
  });
  const connect = () => run(async () => {
    const r = await api<{ webhook: boolean; webhookError?: string }>("/texting/settings", { method: "PUT", body: { apiKey: key, fromNumber: from } });
    setKey(""); setNumbers(null);
    setNote(r.webhook ? null : `Connected. Talkroute couldn't be set to tell Crewdesk about new texts${r.webhookError ? ` (${r.webhookError})` : ""}, so Crewdesk checks for them every few minutes instead.`);
    await s.reload();
  });
  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Texting (Talkroute)</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>Text customers from your Talkroute number, so they keep texting the number they know. Conversations are on <Link href="/texts">Resources → Text</Link> and each customer&apos;s page, and the people you pick are told on their phones when a text comes in.</p>
      </div>
      <ErrorBox error={s.error} />
      {d?.connected ? (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className="badge ok">Connected</span>
            <span>{formatPhone(d.fromNumber)}{d.accountName ? ` · ${d.accountName}` : ""}</span>
            <span className="muted" style={{ fontSize: 13 }}>{d.webhook ? "New texts arrive as they're sent" : "New texts are checked for every few minutes"}{d.hookAt ? ` · last one ${when(d.hookAt)}` : ""}</span>
          </div>
          {note && <p className="notice" style={{ margin: 0 }}>{note}</p>}
          {admin && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api<{ to: string }>("/texting/settings/test", { method: "POST" }); setNote(`A test text is on its way to ${r.to}.`); })}>Send a test text to my phone</button>
              {owner && <button className="btn danger" disabled={busy} onClick={() => confirm("Disconnect texting? Automations that text will skip their texts until it's connected again.") && run(async () => { await api("/texting/settings", { method: "DELETE" }); setNote(null); await s.reload(); })}>Disconnect</button>}
            </div>
          )}
        </>
      ) : d && !d.available ? (
        <p className="notice" style={{ margin: 0 }}>Not available yet.</p>
      ) : d && owner ? (
        <div className="stack">
          <label>Talkroute API key<input type="password" autoComplete="off" value={key} onChange={(e) => { setKey(e.target.value); setNumbers(null); }} placeholder="tr_live_…" /></label>
          {!numbers ? (
            <div><button className="btn primary" disabled={busy || key.trim().length < 8} onClick={find}>{busy ? "Asking Talkroute…" : "Find my numbers"}</button></div>
          ) : (
            <>
              <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, padding: 0, marginBottom: 4 }}>Which number do customers text?</legend>
                {numbers.map((n) => (
                  <label key={n.number} className="check" style={{ alignItems: "baseline" }}>
                    <input type="radio" name="texting-number" disabled={!n.canSend} checked={from === n.number} onChange={() => setFrom(n.number)} />
                    <span>{formatPhone(n.number)}{n.label ? ` · ${n.label}` : ""}
                      {!n.canSend ? <span className="muted"> · texting isn&apos;t turned on for this number in Talkroute</span> : n.registered === false ? <span className="muted"> · not registered for business texting yet (carriers may block its texts)</span> : null}</span>
                  </label>
                ))}
                {!numbers.length && <p className="muted" style={{ margin: 0 }}>This Talkroute account has no number that can text yet.</p>}
              </fieldset>
              <div><button className="btn primary" disabled={busy || !from} onClick={connect}>{busy ? "Connecting…" : "Connect"}</button></div>
            </>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>The key comes from your Talkroute account (it starts with tr_live_). It&apos;s stored encrypted and never shown again. Reading texts works with any API access; <strong>sending</strong> through the API needs Talkroute&apos;s bulk texting plan.</p>
        </div>
      ) : d ? <p className="muted" style={{ margin: 0 }}>Only the owner can connect texting.</p> : null}
      <ErrorBox error={error} />
      {d && admin && <NotifyPicker settings={d} onSaved={s.reload} />}
      {d?.connected && admin && <TextingChoicesForm settings={d} onSaved={s.reload} />}
      {d?.connected && admin && <TextingJobs settings={d} reload={s.reload} />}
      {d && !admin && d.notify.people.length > 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Told when a text comes in: {d.notify.people.map((p) => p.name).join(", ")}.</p>}
    </div>
  );
}

/** Who's told (phone and inbox) when a text comes in. The people picked can also read and answer texts. */
function NotifyPicker({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const people = useApi<{ picked: string[]; people: { id: string; name: string; role: string; hasApp: boolean; quiet: Quiet }[] }>("/texting/settings/people");
  const [ids, setIds] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (people.data && ids === null) setIds(people.data.picked); }, [people.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = ids ?? [];
  const dirty = !!people.data && JSON.stringify([...picked].sort()) !== JSON.stringify([...people.data.picked].sort());
  const toggle = (id: string) => { setSaved(false); setIds(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]); };
  return (
    <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Who&apos;s told when a text comes in</h3>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          Each person ticked gets a notification on their phone (and in their Crewdesk inbox) for every incoming text, and can read and answer texts on Resources → Text and in the phone app, even if they aren&apos;t a Customers &amp; billing manager.
          {!settings.notify.picked && " Nobody is ticked yet, so the Customers & billing managers are told."}
        </p>
      </div>
      <ErrorBox error={people.error ?? error} />
      <div className="txt-people">
        {(people.data?.people ?? []).map((p) => (
          <div key={p.id} className="txt-person">
            <label className="check">
              <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
              <span>{p.name} <span className="muted">· {p.role.charAt(0).toUpperCase() + p.role.slice(1)}{p.hasApp ? "" : " · no phone signed in to the app yet"}</span></span>
            </label>
            {picked.includes(p.id) && <QuietHours value={p.quiet} label={`Quiet hours for ${p.name}`} onSave={(quiet) => run(async () => { await api("/texting/settings/quiet", { method: "PUT", body: { employeeId: p.id, quiet } }); await people.reload(); })} />}
          </div>
        ))}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>During someone&apos;s quiet hours a text still lands in their Crewdesk inbox, but their phone doesn&apos;t buzz ({settings.timezone.replace(/_/g, " ")} time).</p>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !dirty} onClick={() => run(async () => { await api("/texting/settings/notify", { method: "PUT", body: { employeeIds: picked } }); setSaved(true); await people.reload(); onSaved(); })}>{busy ? "Saving…" : "Save who's told"}</button>
        {saved && !dirty && <span className="muted" role="status">Saved.</span>}
        {picked.some((id) => people.data?.people.find((p) => p.id === id && !p.hasApp)) && <span className="muted" style={{ fontSize: 13 }}>Someone without the app on their phone still gets it in their Crewdesk inbox (and by email, if their notification settings say so).</span>}
      </div>
    </div>
  );
}

/** "Don't buzz my phone between these times": off, or a start and an end (which may run past midnight). */
function QuietHours({ value, onSave, label }: { value: Quiet; onSave: (q: Quiet) => void; label: string }) {
  const [on, setOn] = useState(!!value);
  const [start, setStart] = useState(value?.start ?? "21:00");
  const [end, setEnd] = useState(value?.end ?? "07:00");
  useEffect(() => { setOn(!!value); if (value) { setStart(value.start); setEnd(value.end); } }, [value?.start, value?.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: Quiet) => { if ((next?.start ?? "") !== (value?.start ?? "") || (next?.end ?? "") !== (value?.end ?? "")) onSave(next); };
  return (
    <span className="txt-quiet" role="group" aria-label={label}>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); save(e.target.checked ? { start, end } : null); }} /> Quiet hours</label>
      {on && (
        <>
          <input type="time" aria-label="Quiet from" value={start} onChange={(e) => setStart(e.target.value)} onBlur={() => start && end && start !== end && save({ start, end })} />
          <span>to</span>
          <input type="time" aria-label="Quiet until" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={() => start && end && start !== end && save({ start, end })} />
        </>
      )}
    </span>
  );
}

/** The after-hours reply (with the office's hours) and the missed-call text. */
function TextingChoicesForm({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [o, setO] = useState<TextingChoices>(settings.options);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  // Compared field by field (what's saved comes back with its fields in another order).
  const same = (a: TextingChoices, b: TextingChoices) => a.autoReply.enabled === b.autoReply.enabled && a.autoReply.message === b.autoReply.message && a.missedCall.enabled === b.missedCall.enabled && a.missedCall.message === b.missedCall.message
    && TEXT_DAYS.every((d) => (a.autoReply.hours[d]?.open ?? "") === (b.autoReply.hours[d]?.open ?? "") && (a.autoReply.hours[d]?.close ?? "") === (b.autoReply.hours[d]?.close ?? ""));
  const dirty = !same(o, settings.options);
  const auto = (patch: Partial<TextingChoices["autoReply"]>) => { setSaved(false); setO({ ...o, autoReply: { ...o.autoReply, ...patch } }); };
  const day = (d: TextDay, h: { open: string; close: string } | null) => auto({ hours: { ...o.autoReply.hours, [d]: h } });
  return (
    <div className="stack" style={{ gap: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div className="stack" style={{ gap: 6 }}>
        <label className="check"><input type="checkbox" checked={o.autoReply.enabled} onChange={(e) => auto({ enabled: e.target.checked })} /> <strong>After-hours reply:</strong> answer a text by itself when the office is closed</label>
        {o.autoReply.enabled && (
          <>
            <textarea rows={2} maxLength={480} aria-label="After-hours reply" value={o.autoReply.message} onChange={(e) => auto({ message: e.target.value })} />
            <div className="txt-hours" role="group" aria-label="Office hours">
              {TEXT_DAYS.map((d) => {
                const h = o.autoReply.hours[d];
                return (
                  <div key={d} className="txt-hours-row">
                    <label className="check"><input type="checkbox" checked={!!h} onChange={(e) => day(d, e.target.checked ? { open: "08:00", close: "17:00" } : null)} /> {TEXT_DAY_LABELS[d]}</label>
                    {h ? <><input type="time" aria-label={`${TEXT_DAY_LABELS[d]} opens`} value={h.open} onChange={(e) => day(d, { ...h, open: e.target.value })} /><span>to</span><input type="time" aria-label={`${TEXT_DAY_LABELS[d]} closes`} value={h.close} onChange={(e) => day(d, { ...h, close: e.target.value })} /></> : <span className="muted">Closed</span>}
                  </div>
                );
              })}
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sent once per conversation every 8 hours, never to someone who replied STOP or to your own team. Tags like {"{{CUSTOMER_FIRST_NAME}}"} and {"{{COMPANY_NAME}}"} are filled in.</p>
          </>
        )}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <label className="check"><input type="checkbox" checked={o.missedCall.enabled} onChange={(e) => { setSaved(false); setO({ ...o, missedCall: { ...o.missedCall, enabled: e.target.checked } }); }} /> <strong>Missed-call text:</strong> text someone whose call wasn&apos;t answered</label>
        {o.missedCall.enabled && (
          <>
            <textarea rows={2} maxLength={480} aria-label="Missed-call text" value={o.missedCall.message} onChange={(e) => { setSaved(false); setO({ ...o, missedCall: { ...o.missedCall, message: e.target.value } }); }} />
            {!settings.calls && <p className="notice" style={{ margin: 0 }}>Talkroute isn&apos;t telling Crewdesk about calls on this connection. Disconnect and connect again to turn that on.</p>}
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Goes when a call to your number is missed or goes to voicemail, at most once per number every 8 hours.</p>
          </>
        )}
      </div>
      <ErrorBox error={error} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !dirty} onClick={() => run(async () => { await api("/texting/settings/options", { method: "PUT", body: o }); setSaved(true); onSaved(); })}>{busy ? "Saving…" : "Save automatic replies"}</button>
        {saved && !dirty && <span className="muted" role="status">Saved.</span>}
      </div>
    </div>
  );
}

const jobLine = (j: TextingJob, what: string) => (j.error ? `Stopped: ${j.error}` : j.finishedAt ? `${what.replace("{n}", j.added.toLocaleString())} · ${when(j.finishedAt)}` : `Working… ${j.done.toLocaleString()} of ${j.total.toLocaleString()}`);

/** The long jobs: bringing in past conversations, and copying customers into Talkroute's contacts. */
function TextingJobs({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [days, setDays] = useState<number>(90);
  const { busy, error, run } = useAction();
  const working = (j: TextingJob | null) => !!j && !j.finishedAt;
  const going = working(settings.history) || working(settings.contacts);
  useEffect(() => { if (!going) return; const t = setInterval(reload, 3000); return () => clearInterval(t); }, [going]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack" style={{ gap: 10, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong>Past conversations:</strong>
        <select aria-label="How far back" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: "auto" }}>
          {TEXT_HISTORY_DAYS.map((d) => <option key={d} value={d}>{d === 365 ? "the last year" : `the last ${d} days`}</option>)}
        </select>
        <button className="btn" disabled={busy || working(settings.history)} onClick={() => run(async () => { await api("/texting/settings/history", { body: { days } }); reload(); })}>Bring in from Talkroute</button>
        {settings.history && <span className="muted" role="status">{jobLine(settings.history, "{n} texts brought in")}</span>}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong>Talkroute contacts:</strong>
        <button className="btn" disabled={busy || working(settings.contacts)} onClick={() => run(async () => { await api("/texting/settings/contacts", { method: "POST" }); reload(); })}>Copy customers to Talkroute</button>
        {settings.contacts && <span className="muted" role="status">{jobLine(settings.contacts, "{n} added")}</span>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Past conversations come in as history: nobody is notified and nothing is marked unread. Copying customers puts their names in Talkroute&apos;s apps; ones already copied are left alone, and new customers are copied overnight from then on.</p>
      <ErrorBox error={error} />
    </div>
  );
}

/* ───────────── The top bar's chat bubble ───────────── */

/** Homeworks' chat bubble: opens Text, with how many conversations have something unread. */
export function TextsButton() {
  const { me } = useAuth();
  const allowed = !!me?.access?.texting;
  const [unread, setUnread] = useState(0);
  const load = useCallback(() => { if (allowed) api<{ unread: number }>("/texting/unread").then((r) => setUnread(r.unread), () => {}); }, [allowed]);
  useEffect(() => {
    load();
    const t = setInterval(load, 45_000);
    window.addEventListener("crewdesk:texts", load);
    window.addEventListener("focus", load);
    return () => { clearInterval(t); window.removeEventListener("crewdesk:texts", load); window.removeEventListener("focus", load); };
  }, [load]);
  if (!allowed) return null;
  return (
    <Link href="/texts" className="topbar-icon" aria-label={`Text messages, ${unread} unread`} title="Text messages">
      <Icon name="messages" />
      {unread > 0 && <span className="topbar-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </Link>
  );
}

/* ───────────── Writing a text ───────────── */

/** The message box, as Homeworks has it: Insert Customer / Company Info, Insert Template, and the count underneath. */
function MessageBox({ value, onChange, disabled, rows = 4, templates, placeholder = "Type your message...", tools }: { value: string; onChange: (v: string) => void; disabled?: boolean; rows?: number; templates?: Template[]; placeholder?: string; tools?: ReactNode }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const el = box.current;
    const at = el ? el.selectionStart ?? value.length : value.length, end = el ? el.selectionEnd ?? at : at;
    onChange((value.slice(0, at) + text + value.slice(end)).slice(0, TEXT_MAX));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };
  const seg = textSegments(value);
  return (
    <div className={`txt-box${disabled ? " off" : ""}`}>
      <textarea ref={box} rows={rows} maxLength={TEXT_MAX} value={value} disabled={disabled} placeholder={placeholder} aria-label="Message" onChange={(e) => onChange(e.target.value)} />
      <div className="txt-box-tools">
        <TagMenu label="Insert Customer / Company Info" onPick={(tag) => insert(`{{${tag}}}`)} />
        {templates && templates.length > 0 && (
          <select aria-label="Insert Template" value="" disabled={disabled} onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) onChange(value.trim() ? `${value.trimEnd()}\n${t.body}`.slice(0, TEXT_MAX) : t.body.slice(0, TEXT_MAX)); }}>
            <option value="">Insert Template</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {tools}
      </div>
      <div className="txt-box-count">
        <span>Words: {textWords(value)}</span><span>Characters: {seg.length}</span>
        <span>{seg.segments > 1 ? `Sent as ${seg.segments} texts` : "1 text"}{seg.unicode ? " (emoji or special characters make texts shorter)" : ""}</span>
      </div>
    </div>
  );
}

const useTextTemplates = () => (useApi<Template[]>("/templates").data ?? []).filter((t) => t.channel === "text");

/** The box under "Write a text" on a customer's page: counts characters and how many texts it'll be sent as. */
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

/** Shrinks a photo so carriers will pass it along (a phone's photo is several times too big). */
async function textPicture(file: File): Promise<File> {
  if (file.type === "image/gif" || file.size <= TEXT_MEDIA_MAX_BYTES * 0.9) return file;
  const bmp = await createImageBitmap(file);
  for (const [side, quality] of [[1600, 0.82], [1280, 0.78], [1024, 0.7], [800, 0.6]] as const) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", quality));
    if (blob && blob.size <= TEXT_MEDIA_MAX_BYTES * 0.95) return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  }
  throw new Error("That picture is too big to text, even shrunk");
}

const sender = (t: Text) => (t.source === "automation" ? "automation" : t.source === "auto" ? "sent automatically" : t.source === "talkroute" ? "sent from Talkroute" : t.by ?? "office");

/** The conversation: their texts on the left, yours on the right, the office's own notes across the middle, and anything waiting to go at the end. */
function Bubbles({ texts, onTakeBack }: { texts: Text[]; onTakeBack?: (id: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [texts.length]);
  return (
    <>
      {texts.map((t) => {
        if (t.direction === "note") return <div key={t.id} className="sms note"><div className="sms-body">{t.body}</div><div className="sms-meta">Note (not sent) · {t.by ?? "office"} · {when(t.at)}</div></div>;
        const waiting = t.status === "scheduled";
        return (
          <div key={t.id} className={`sms ${t.direction}${t.status === "failed" ? " failed" : ""}${waiting ? " waiting" : ""}`}>
            {(t.media ?? []).map((m) => (
              /^image\//.test(m.contentType)
                ? <a key={m.id} className="sms-pic" href={`${API_URL}/texting/media/${m.id}`} target="_blank" rel="noopener noreferrer"><img src={`${API_URL}/texting/media/${m.id}`} alt="Picture sent by text" loading="lazy" /></a>
                : <a key={m.id} className="sms-file" href={`${API_URL}/texting/media/${m.id}?download=1`}><Icon name="download" size={14} /> {m.fileName}</a>
            ))}
            {t.body && <div className="sms-body">{t.body}</div>}
            <div className="sms-meta">
              {waiting ? <>Goes {t.sendAt ? when(t.sendAt) : "later"} · {t.by ?? "office"}{onTakeBack && <> · <button type="button" className="linkbtn" onClick={() => onTakeBack(t.id)}>Take it back</button></>}</> : (
                <>{when(t.at)}{t.direction === "out" ? ` · ${sender(t)}${t.status === "failed" ? ` · not sent: ${t.error ?? ""}` : t.status === "queued" || t.status === "sending" ? " · sending" : ""}` : ""}</>
              )}
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </>
  );
}

/** A customer's texts on their page, oldest at the top, with a box to send one. */
export function CustomerTexts({ customerId, focus }: { customerId: string; focus?: boolean }) {
  const conv = useApi<{ connected: boolean; number: string | null; optedOut: string | null; texts: Text[] }>(`/texting/customers/${customerId}`);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) card.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [focus]);
  useEffect(() => { if (conv.data) changed(); }, [conv.data?.texts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = conv.data;
  return (
    <div className="card" ref={card}>
      <h2 className="cp-h">Texts{d?.number ? <span className="muted" style={{ fontWeight: 400 }}> · {formatPhone(d.number)}</span> : null}</h2>
      <ErrorBox error={conv.error} />
      {d && (
        <>
          {d.texts.length > 0 ? <div className="sms-thread" role="log" aria-label="Texts"><Bubbles texts={d.texts} onTakeBack={(textId) => void api(`/texting/texts/${textId}`, { method: "DELETE" }).then(() => conv.reload())} /></div> : <p className="muted" style={{ margin: "6px 0" }}>No texts yet.</p>}
          {!d.connected ? <p className="muted" style={{ margin: 0 }}>Texting isn&apos;t connected yet (Settings → Integrations).</p>
            : d.optedOut ? <p className="bad-text" style={{ margin: 0 }}>They replied STOP on {new Date(d.optedOut).toLocaleDateString()}, so they can&apos;t be texted until they reply START.</p>
            : !d.number ? <p className="muted" style={{ margin: 0 }}>Add a mobile number to text them.</p>
            : <TextComposer onSend={async (body) => { await api(`/texting/customers/${customerId}`, { body: { body } }); conv.reload(); }} />}
        </>
      )}
    </div>
  );
}

type Call = { id: string; kind: "call" | "voicemail"; direction: "in" | "out"; result: "answered" | "missed" | "hangup"; seconds: number; phone: string; callerName: string | null; transcript: string | null; at: string };
const callLength = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}`.trim() : `${s} s`);
const callWords = (c: Call) => (c.kind === "voicemail" ? "Voicemail" : c.direction === "out" ? "Call to them" : c.result === "missed" ? "Missed call" : c.result === "hangup" ? "Call (hung up)" : "Call from them");

/** A customer's calls and voicemails on the company's number, as Talkroute reports them; a voicemail can be read and played. */
export function CustomerCalls({ customerId }: { customerId: string }) {
  const data = useApi<{ on: boolean; rows: Call[] }>(`/texting/calls?customerId=${customerId}`);
  const [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
  const { error, run } = useAction();
  const rows = data.data?.rows ?? [];
  if (!rows.length) return null;
  return (
    <div className="card">
      <h2 className="cp-h">Calls &amp; voicemails</h2>
      <ErrorBox error={error} />
      <ul className="txt-calls">
        {rows.map((c) => (
          <li key={c.id} className={c.result === "missed" || c.kind === "voicemail" ? "missed" : ""}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <strong>{callWords(c)}</strong>
              <span className="muted" style={{ fontSize: 12 }}>{when(c.at)}{c.seconds ? ` · ${callLength(c.seconds)}` : ""}</span>
            </div>
            {c.transcript && <div className="txt-call-words">&ldquo;{c.transcript}&rdquo;</div>}
            {c.kind === "voicemail" && (audio?.id === c.id
              ? <audio controls autoPlay src={audio.url} style={{ width: "100%", marginTop: 4 }}>Your browser can&apos;t play this recording.</audio>
              : <button type="button" className="linkbtn" onClick={() => run(async () => setAudio({ id: c.id, url: (await api<{ url: string }>(`/texting/calls/${c.id}/audio`)).url }))}>Play the recording</button>)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── Text Messages: the list and the open conversation ───────────── */

const FILTERS: [TextFilter, string][] = [["all", "All"], ["unread", "Unread"], ["mine", "Mine"], ["open", "Open"], ["done", "Done"]];

export function TextMessagesTab() {
  const params = useSearchParams();
  const router = useRouter();
  const { can } = useAuth();
  const [filter, setFilter] = useState<TextFilter>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(params.get("thread"));
  const [starting, setStarting] = useState(false);
  const list = useApi<ThreadList>(`/texting/threads?filter=${filter}&page=${page}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
  const settings = useApi<Settings>("/texting/settings");
  // New texts show up without a refresh.
  useEffect(() => { const t = setInterval(() => void list.reload(), 20_000); return () => clearInterval(t); }, [list.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = params.get("thread"); if (id) setOpen(id); }, [params]);
  const pick = (id: string | null) => { setOpen(id); router.replace(id ? `/texts?thread=${id}` : "/texts", { scroll: false }); };
  const d = list.data;
  const first = d && d.total ? (d.page - 1) * d.pageSize + 1 : 0, last = d ? Math.min(d.page * d.pageSize, d.total) : 0;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <>
      {settings.data && !settings.data.connected && <p className="notice" style={{ margin: 0 }}>Texting isn&apos;t connected yet, so nothing new comes in here. {can("owner", "customers") ? <Link href="/settings/integrations">Connect Talkroute</Link> : "The owner connects it under Settings → Integrations."}</p>}
      {settings.data && <div className="txt-mine"><span className="muted">Text notifications on my phone:</span> <QuietHours value={settings.data.myQuiet} label="My quiet hours" onSave={(quiet) => void api("/texting/settings/quiet", { method: "PUT", body: { quiet } }).then(() => settings.reload())} /></div>}
      <div className="card txt-pane" data-lkeep="">
        <aside className={`txt-list${open ? " has-open" : ""}`} aria-label="Conversations">
          <div className="txt-seg" role="tablist" aria-label="Show">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => { setFilter(k); setPage(1); }}>
                {label}{k === "unread" && d && d.unread > 0 ? <span className="txt-dot">{d.unread}</span> : null}
              </button>
            ))}
          </div>
          <form className="txt-search" role="search" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setPage(1); }}>
            <input type="search" placeholder="Search for messages or users..." aria-label="Search for messages or users" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) { setSearch(""); setPage(1); } }} />
            <button type="submit" aria-label="Search"><Icon name="search" size={16} /></button>
          </form>
          <ErrorBox error={list.error} />
          <ul className="txt-rows">
            {(d?.threads ?? []).map((t) => (
              <li key={t.id}>
                <button type="button" className={`${open === t.id ? "on" : ""}${t.unread ? " unread" : ""}`} onClick={() => pick(t.id)} aria-current={open === t.id ? "true" : undefined}>
                  <span className="txt-avatar" aria-hidden="true">{textInitials(t.name)}</span>
                  <span className="txt-row-main">
                    <span className="txt-row-top"><strong>{who(t)}</strong><span className="txt-row-when">{shortWhen(t.last.at)}</span></span>
                    <span className="txt-row-preview">{t.last.direction === "out" ? "You: " : ""}{t.last.body}</span>
                    {t.assignedName && <span className="txt-row-owner">{t.assignedName}&apos;s</span>}
                  </span>
                  {t.unread > 0 && <span className="txt-dot" aria-label={`${t.unread} unread`}>{t.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
          {d && !d.threads.length && <p className="muted txt-empty">{search ? "No conversations match." : filter === "unread" ? "Nothing unread." : filter === "mine" ? "No conversations are yours right now." : filter === "done" ? "Nothing marked done." : "No texts yet."}</p>}
          {d && d.total > 0 && (
            <div className="txt-pager">
              <div className="txt-pager-btns">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <span aria-current="page">{page}</span>
                <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
              <span className="muted">{first}-{last} of {d.total}</span>
            </div>
          )}
          <button type="button" className="txt-new" onClick={() => setStarting(true)} aria-label="New message" title="New message"><Icon name="plus" size={20} /></button>
        </aside>
        <section className={`txt-thread${open ? " is-open" : ""}`} aria-label="Conversation">
          {open ? <Conversation key={open} id={open} onBack={() => pick(null)} onChanged={() => { void list.reload(); changed(); }} onGone={() => { pick(null); void list.reload(); changed(); }} />
            : <div className="txt-hello"><span className="txt-avatar big" aria-hidden="true"><Icon name="messages" size={26} /></span><strong>Select a conversation to start messaging.</strong><span className="muted">Or press + to start a new one.</span></div>}
        </section>
      </div>
      {starting && <NewConversation onClose={() => setStarting(false)} onOpen={(id) => { setStarting(false); pick(id); void list.reload(); }} />}
    </>
  );
}

type QuickReply = { id: string; title: string; body: string };

/** Short answers the office sends often, a click away; "Save this one" keeps what's in the box. */
function QuickReplies({ current, onPick }: { current: string; onPick: (body: string) => void }) {
  const list = useApi<{ rows: QuickReply[] }>("/texting/quick-replies");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { error, run } = useAction();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const rows = list.data?.rows ?? [];
  return (
    <div className="txt-quick" ref={wrap}>
      <button type="button" className="btn sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Quick replies ▾</button>
      {open && (
        <div className="txt-quick-menu" role="menu">
          {rows.map((r) => (
            <div key={r.id} className="txt-quick-row">
              <button type="button" role="menuitem" title={r.body} onClick={() => { onPick(r.body); setOpen(false); }}><strong>{r.title}</strong><span>{r.body}</span></button>
              <button type="button" className="hw-icon-btn danger" aria-label={`Delete ${r.title}`} title="Delete" onClick={() => confirm(`Delete the quick reply "${r.title}"?`) && run(async () => { await api(`/texting/quick-replies/${r.id}`, { method: "DELETE" }); await list.reload(); })}>×</button>
            </div>
          ))}
          {list.data && !rows.length && <p className="muted" style={{ margin: "4px 8px" }}>None yet. Write an answer you send often, then save it here.</p>}
          <button type="button" className="txt-quick-save" disabled={!current.trim()} onClick={() => { const title = prompt("A short name for this quick reply", current.trim().split(/\s+/).slice(0, 4).join(" "))?.trim(); if (title) run(async () => { await api("/texting/quick-replies", { body: { title, body: current.trim() } }); await list.reload(); }); }}>
            <Icon name="plus" size={14} /> Save what&apos;s in the box as a quick reply
          </button>
          <ErrorBox error={error} />
        </div>
      )}
    </div>
  );
}

/** A local date and time box's value ("2026-11-27T08:00") for some minutes from now. */
const localInput = (d: Date) => new Date(+d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function Conversation({ id, onBack, onChanged, onGone }: { id: string; onBack: () => void; onChanged: () => void; onGone: () => void }) {
  const { can } = useAuth();
  const router = useRouter();
  const conv = useApi<ThreadFull>(`/texting/threads/${id}`);
  const people = useApi<{ people: { id: string; name: string }[]; me: string }>("/texting/people");
  const templates = useTextTemplates();
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"text" | "note">("text");
  const [later, setLater] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState(false);
  const [made, setMade] = useState<{ id: string; title: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const count = conv.data?.texts.length ?? 0;
  // Opening it marked its replies read; tell the list and the bubble.
  useEffect(() => { if (conv.data) onChanged(); }, [count]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(() => void conv.reload(), 10_000); return () => clearInterval(t); }, [conv.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = conv.data;
  const after = async () => { await conv.reload(); onChanged(); };
  const act = (path: string, payload?: unknown) => run(async () => { await api(`/texting/threads/${id}/${path}`, { method: "POST", body: payload ?? {} }); await after(); });
  const send = () => run(async () => {
    if (mode === "note") await api(`/texting/threads/${id}/note`, { body: { body: body.trim() } });
    else await api(`/texting/threads/${id}`, { body: { body: body.trim(), ...(later ? { sendAt: new Date(later).toISOString() } : {}) } });
    setBody(""); setLater(null); await after();
  });
  const sendPicture = (picked: File | undefined) => { if (picked) run(async () => {
    const f = await textPicture(picked);
    const fd = new FormData();
    fd.append("body", body.trim());
    fd.append("file", f, f.name);
    await api(`/texting/threads/${id}/picture`, { method: "POST", body: fd });
    setBody(""); if (file.current) file.current.value = ""; await after();
  }); };
  if (conv.error && !d) return <div className="txt-hello"><ErrorBox error={conv.error} /><button type="button" className="btn" onClick={onBack}>Back</button></div>;
  if (!d) return <div className="txt-hello"><span className="muted">Loading…</span></div>;
  // What they last said, to start a work order or estimate with.
  const lastIn = [...d.texts].reverse().find((t) => t.direction === "in" && t.body);
  const notes = lastIn ? `From a text on ${when(lastIn.at)}: "${lastIn.body}"` : "";
  const startUrl = (path: string) => `${path}?customerId=${d.customerId}${notes ? `&notes=${encodeURIComponent(notes.slice(0, 1500))}` : ""}`;
  return (
    <>
      <header className="txt-head">
        <button type="button" className="txt-back" onClick={onBack} aria-label="Back to conversations"><Icon name="left" size={18} /></button>
        <span className="txt-avatar" aria-hidden="true">{textInitials(d.name)}</span>
        <div className="txt-head-who">
          {d.customerId ? <Link href={`/customers/${d.customerId}`}>{d.name}</Link> : <strong>{who(d)}</strong>}
          <span className="muted">{formatPhone(d.phone)}{d.kind === "employee" ? " · on your team" : d.kind === "unknown" ? " · not a customer yet" : ""}</span>
        </div>
        <div className="txt-head-tools">
          <select className="txt-assign" aria-label="Whose conversation this is" title="Give this conversation to one person. Only they are told about its texts from then on." value={d.assignedId ?? ""} disabled={busy}
            onChange={(e) => act("assign", { employeeId: e.target.value || null })}>
            <option value="">Everyone&apos;s</option>
            {(people.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.id === people.data?.me ? `Mine (${p.name})` : p.name}</option>)}
          </select>
          <div className="txt-quick">
            <button type="button" className="btn sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Create ▾</button>
            {menu && (
              <div className="txt-quick-menu right" role="menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" role="menuitem" className="txt-menu-item" onClick={() => { setMenu(false); run(async () => { setMade(await api<{ id: string; title: string }>(`/texting/threads/${id}/todo`, { method: "POST", body: {} })); await after(); }); }}>To-do from their last text</button>
                {d.customerId && can("manager", "customers") && <button type="button" role="menuitem" className="txt-menu-item" onClick={() => router.push(startUrl("/visits/new"))}>Work order…</button>}
                {d.customerId && can("manager", "customers") && <button type="button" role="menuitem" className="txt-menu-item" onClick={() => router.push(startUrl("/estimates/new"))}>Estimate…</button>}
              </div>
            )}
          </div>
          <button type="button" className="btn sm" disabled={busy} onClick={() => run(async () => { await api(`/texting/threads/${id}/unread`, { method: "POST" }); onChanged(); onBack(); })}>Mark unread</button>
          <button type="button" className={`btn sm txt-state ${d.status}`} disabled={busy} aria-pressed={d.status === "done"} title={d.status === "done" ? "Marked done. Click to open it again." : "Open. Click when it's been dealt with."}
            onClick={() => act("status", { status: d.status === "done" ? "open" : "done" })}>{d.status === "done" ? "Done" : "Open"}</button>
          {can("admin", "customers") && <button type="button" className="btn sm" disabled={busy} onClick={() => setDeleting(true)}>Delete Messages</button>}
        </div>
      </header>
      {made && <div className="txt-file" role="status">To-do made: <Link href={`/todos/${made.id}`}>{made.title}</Link> <button type="button" className="linkbtn" onClick={() => setMade(null)}>OK</button></div>}
      {d.kind === "unknown" && can("manager", "customers") && (
        <div className="txt-file">
          {filing ? <CustomerPick onCancel={() => setFiling(false)} onPick={(customerId) => run(async () => { await api("/texting/assign", { body: { phone: d.phone, customerId } }); setFiling(false); await after(); })} />
            : <button type="button" className="linkbtn" onClick={() => setFiling(true)}>This number isn&apos;t on a customer yet. File the conversation under a customer…</button>}
        </div>
      )}
      <div className="txt-bubbles sms-thread" role="log" aria-label="Texts">
        {d.texts.length ? <Bubbles texts={d.texts} onTakeBack={(textId) => run(async () => { await api(`/texting/texts/${textId}`, { method: "DELETE" }); await after(); })} /> : <p className="muted" style={{ margin: "auto" }}>No texts yet. Write the first one below.</p>}
      </div>
      <footer className="txt-foot">
        {!d.connected && mode === "text" ? <p className="muted" style={{ margin: "0 0 8px" }}>Texting isn&apos;t connected yet (Settings → Integrations).</p>
          : d.optedOut && mode === "text" ? <p className="bad-text" style={{ margin: "0 0 8px" }}>They replied STOP on {new Date(d.optedOut).toLocaleDateString()}, so they can&apos;t be texted until they reply START.</p> : null}
        <form className={mode === "note" ? "txt-noting" : ""} onSubmit={(e) => { e.preventDefault(); if (body.trim()) send(); }}>
          <MessageBox value={body} onChange={setBody} templates={mode === "text" ? templates : undefined} rows={3} placeholder={mode === "note" ? "Write a note for the office. It isn't sent to them." : undefined}
            tools={mode === "text" ? (
              <>
                <QuickReplies current={body} onPick={(b) => setBody(b.slice(0, TEXT_MAX))} />
                <button type="button" className="btn sm" disabled={busy || !d.connected || !!d.optedOut} title="Text a picture (JPG, PNG or GIF). What's typed in the box goes with it." onClick={() => file.current?.click()}><Icon name="upload" size={14} /> Picture</button>
                <input ref={file} type="file" accept="image/jpeg,image/png,image/gif" hidden onChange={(e) => sendPicture(e.target.files?.[0])} />
              </>
            ) : undefined} />
          <div className="txt-foot-send">
            <div className="txt-seg small" role="tablist" aria-label="What to write">
              <button type="button" role="tab" aria-selected={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>Text</button>
              <button type="button" role="tab" aria-selected={mode === "note"} className={mode === "note" ? "on" : ""} onClick={() => { setMode("note"); setLater(null); }}>Note</button>
            </div>
            <ErrorBox error={error} />
            {mode === "text" && (later === null
              ? <button type="button" className="linkbtn" onClick={() => setLater(localInput(new Date(Date.now() + 3_600_000)))}>Send later…</button>
              : <span className="txt-later"><input type="datetime-local" aria-label="When to send it" value={later} min={localInput(new Date(Date.now() + 120_000))} onChange={(e) => setLater(e.target.value)} /><button type="button" className="linkbtn" onClick={() => setLater(null)}>Send now instead</button></span>)}
            <button className="btn hw-and" disabled={busy || !body.trim() || (mode === "text" && (!d.connected || !!d.optedOut))}>{busy ? "Working…" : mode === "note" ? "Add note" : later ? "Schedule" : "Send"}</button>
          </div>
        </form>
      </footer>
      {deleting && <ConfirmDialog title="Delete Messages" busy={busy} onNo={() => setDeleting(false)}
        message={<>Delete the whole conversation with <strong>{who(d)}</strong> from Crewdesk? Its texts are removed here (they stay in Talkroute).</>}
        onYes={() => run(async () => { await api(`/texting/threads/${id}`, { method: "DELETE" }); setDeleting(false); onGone(); })} />}
    </>
  );
}

function CustomerPick({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const res = useApi<{ rows: { id: string; name: string; number: number }[] }>(q.trim().length >= 2 ? `/customers?status=all&limit=8&q=${encodeURIComponent(q.trim())}` : null);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer name" aria-label="Find a customer" /><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
      {(res.data?.rows ?? []).map((r) => <button key={r.id} type="button" className="linkbtn" style={{ textAlign: "left" }} onClick={() => onPick(r.id)}>{r.name} <span className="muted">#{r.number}</span></button>)}
    </div>
  );
}

function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  return (
    <div className="hw-dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`hw-dialog txt-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="hw-dialog-head"><span>{title}</span><button type="button" className="hw-dialog-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="hw-dialog-body">{children}</div>
      </div>
    </div>
  );
}

type Recipient = { id: string; name: string; detail: string; ok: boolean };
type Kind = "customers" | "groups" | "employees" | "crews";

/** One of the pick lists (customers, groups, the team, crews), searched as you type. */
function RecipientList({ kind, q, onPick, picked, extra }: { kind: Kind; q: string; onPick: (r: Recipient) => void; picked: (id: string) => boolean; extra?: (r: Recipient) => ReactNode }) {
  const [term, setTerm] = useState(q);
  useEffect(() => { const t = setTimeout(() => setTerm(q), 250); return () => clearTimeout(t); }, [q]);
  const list = useApi<{ rows: Recipient[] }>(`/texting/recipients?kind=${kind}${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ""}`);
  const rows = list.data?.rows ?? [];
  return (
    <ul className="txt-pick" aria-label={kind}>
      {rows.map((r) => (
        <li key={r.id} className={r.ok ? "" : "off"}>
          <span className="txt-pick-name">{r.name}<span className="muted"> · {r.detail}</span></span>
          {extra?.(r)}
          <button type="button" className="hw-icon-btn" disabled={!r.ok || picked(r.id)} aria-label={`Add ${r.name}`} title={picked(r.id) ? "Already on it" : r.ok ? "Add" : r.detail} onClick={() => onPick(r)}><Icon name="plus" size={16} /></button>
        </li>
      ))}
      {list.data && !rows.length && <li className="none">{kind === "groups" ? "(No groups found)" : kind === "customers" && !term.trim() ? "Type a name to find a customer." : "Nothing matches."}</li>}
    </ul>
  );
}

/** Start a conversation: with a customer, someone on the team, or a number typed in. */
function NewConversation({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const [kind, setKind] = useState<"customers" | "employees" | "number">("customers");
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const open = (payload: Record<string, string>) => run(async () => onOpen((await api<{ id: string }>("/texting/threads/open", { body: payload })).id));
  return (
    <Dialog title="New message" onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="txt-seg" role="tablist" aria-label="Who to">
          {([["customers", "Customers"], ["employees", "Employees"], ["number", "A number"]] as const).map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setQ(""); }}>{label}</button>)}
        </div>
        {kind === "number" ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); open({ phone: q }); }}>
            <input autoFocus inputMode="tel" placeholder="(405) 555-0100" aria-label="Mobile number" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn hw-and" disabled={busy || q.replace(/\D/g, "").length < 10}>Start</button>
          </form>
        ) : (
          <>
            <input autoFocus type="search" placeholder={kind === "customers" ? "Search customers..." : "Search employees..."} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
            <RecipientList kind={kind} q={q} picked={() => false} onPick={(r) => open(kind === "customers" ? { customerId: r.id } : { employeeId: r.id })} />
          </>
        )}
        <ErrorBox error={error} />
      </div>
    </Dialog>
  );
}

/* ───────────── Send Text Messages ───────────── */

type Picked = { kind: Kind | "phones"; id: string; name: string };
type Batch = { id: string; at: string; by: string | null; label: string; body: string; total: number; stopped: boolean; sent: number; failed: number; waiting: number; scheduled: number; sendAt: string | null; skipped: { name: string; reason: string }[] };

export function SendTextsTab() {
  const settings = useApi<Settings>("/texting/settings");
  const batches = useApi<{ rows: Batch[] }>("/texting/batches");
  const templates = useTextTemplates();
  const [kind, setKind] = useState<Kind | "phones">("customers");
  const [q, setQ] = useState("");
  const [to, setTo] = useState<Picked[]>([]);
  const [body, setBody] = useState("");
  const [template, setTemplate] = useState("");
  const [done, setDone] = useState<{ text: string; skipped: { name: string; reason: string }[] } | null>(null);
  const [later, setLater] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupsKey, setGroupsKey] = useState(0);
  const [editing, setEditing] = useState<Recipient | null>(null);
  const [phone, setPhone] = useState("");
  const { busy, error, run } = useAction();
  const group = useAction();
  const sending = batches.data?.rows.some((b) => b.waiting > 0 && !b.stopped);
  // While a send to many is going out, show it counting up.
  useEffect(() => { if (!sending) return; const t = setInterval(() => void batches.reload(), 5000); return () => clearInterval(t); }, [sending, batches.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (k: Picked["kind"], r: { id: string; name: string }) => { setDone(null); setTo((cur) => (cur.some((x) => x.kind === k && x.id === r.id) ? cur : [...cur, { kind: k, id: r.id, name: r.name }])); };
  const ids = (k: Picked["kind"]) => to.filter((x) => x.kind === k).map((x) => x.id);
  const send = () => run(async () => {
    const r = await api<{ sent: number; queued: number; sendAt?: string | null; skipped: { name: string; reason: string }[] }>("/texting/send", { body: { body: body.trim(), customerIds: ids("customers"), employeeIds: ids("employees"), groupIds: ids("groups"), crewIds: ids("crews"), phones: ids("phones"), ...(later ? { sendAt: new Date(later).toISOString() } : {}) } });
    setDone({ text: r.sendAt ? `${r.queued} ${r.queued === 1 ? "text is" : "texts are"} set to go ${when(r.sendAt)}. Take them back under Messages History.` : r.queued ? `${r.queued} texts are lined up and going out a few a minute. Watch them under Messages History.` : "Sent.", skipped: r.skipped });
    setBody(""); setTemplate(""); setTo([]); setLater(null);
    await batches.reload();
  });
  const sendLabel = kind === "groups" ? "Send Messages To" : "Send Message To";
  return (
    <div className="txt-send" data-lkeep="">
      <div className="txt-send-main">
        <div className="card txt-card">
          <h3>Messages History</h3>
          <div className="txt-history">
            {(batches.data?.rows ?? []).map((b) => (
              <div key={b.id} className="txt-batch">
                <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <strong>{b.label}</strong>
                  <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{when(b.at)}{b.by ? ` · ${b.by}` : ""}</span>
                </div>
                <div className="txt-batch-body">{b.body}</div>
                <div className="row" style={{ gap: 10, fontSize: 13, flexWrap: "wrap" }}>
                  <span>{b.sent} of {b.total} sent</span>
                  {b.waiting > 0 && !b.stopped && <span className="hwf-tag warn" style={{ marginLeft: 0 }}>{b.waiting} waiting</span>}
                  {b.scheduled > 0 && !b.stopped && <span className="hwf-tag" style={{ marginLeft: 0 }}>{b.scheduled} set for {b.sendAt ? when(b.sendAt) : "later"}</span>}
                  {b.failed > 0 && <Link href="/texts?tab=errors" className="bad-text">{b.failed} didn&apos;t go</Link>}
                  {b.skipped.length > 0 && <span className="muted" title={b.skipped.slice(0, 30).map((s) => `${s.name}: ${s.reason}`).join("\n")}>{b.skipped.length} left out</span>}
                  {b.stopped && <span className="muted">Stopped</span>}
                  {(b.waiting > 0 || b.scheduled > 0) && !b.stopped && <button type="button" className="linkbtn" onClick={() => confirm("Stop this send? Texts that haven't gone yet won't be sent.") && run(async () => { await api(`/texting/batches/${b.id}/stop`, { method: "POST" }); await batches.reload(); })}>{b.scheduled > 0 ? "Take back" : "Stop"}</button>}
                </div>
              </div>
            ))}
            {batches.data && !batches.data.rows.length && <p className="muted" style={{ margin: 0 }}>Texts sent to several people at once are listed here. One-to-one texts are under Text Messages.</p>}
          </div>
        </div>
        <div className="card txt-card">
          {settings.data && !settings.data.connected && <p className="notice" style={{ margin: 0 }}>Texting isn&apos;t connected yet (Settings → Integrations).</p>}
          <label>Template
            <select value={template} onChange={(e) => { setTemplate(e.target.value); const t = templates.find((x) => x.id === e.target.value); if (t) setBody(t.body.slice(0, TEXT_MAX)); }}>
              <option value="">--- Select Template ---</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <div className="txt-field">
            <span>{sendLabel} <span className="hwf-star">*</span></span>
            <div className="txt-to">
              {to.map((x) => <span className="hwf-chip" key={`${x.kind}:${x.id}`}><button type="button" aria-label={`Remove ${x.name}`} onClick={() => setTo(to.filter((y) => y !== x))}>×</button>{x.kind === "groups" ? "Group: " : x.kind === "crews" ? "Crew: " : ""}{x.name}</span>)}
              {!to.length && <span className="muted">{kind === "groups" ? "(Please select a group at the right box)" : "(Please select a customer / employee at the upper right box)"}</span>}
            </div>
          </div>
          <div className="txt-field">
            <span>Message <span className="hwf-star">*</span></span>
            <MessageBox value={body} onChange={setBody} rows={6} />
          </div>
          <ErrorBox error={error} />
          {done && (
            <div className="hwd-success" role="status">
              <div>{done.text}{done.skipped.length > 0 && <> Left out: {done.skipped.slice(0, 6).map((s) => `${s.name} (${s.reason.toLowerCase()})`).join(", ")}{done.skipped.length > 6 ? ` and ${done.skipped.length - 6} more` : ""}.</>}</div>
              <button type="button" aria-label="Close" onClick={() => setDone(null)}>×</button>
            </div>
          )}
          <div className="txt-send-btn">
            {later === null
              ? <button type="button" className="linkbtn" onClick={() => setLater(localInput(new Date(Date.now() + 3_600_000)))}>Send later…</button>
              : <span className="txt-later"><input type="datetime-local" aria-label="When to send it" value={later} min={localInput(new Date(Date.now() + 120_000))} onChange={(e) => setLater(e.target.value)} /><button type="button" className="linkbtn" onClick={() => setLater(null)}>Send now instead</button></span>}
            <button type="button" className="btn hw-and" disabled={busy || !body.trim() || !to.length || !settings.data?.connected} onClick={send}>{busy ? "Sending…" : later ? "Schedule" : "Send"}</button>
          </div>
        </div>
      </div>
      <div className="txt-send-side">
        <div className="card txt-card">
          <div className="txt-seg" role="tablist" aria-label="Send to">
            {([["customers", "Customers"], ["groups", "Groups"], ["employees", "Employees"], ["crews", "Crews"], ["phones", "Number"]] as const).map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setQ(""); }}>{label}</button>)}
          </div>
          {kind === "phones" ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (phone.replace(/\D/g, "").length >= 10) { add("phones", { id: phone.trim(), name: formatPhone(phone) }); setPhone(""); } }}>
              <input inputMode="tel" placeholder="(405) 555-0100" aria-label="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button className="btn" disabled={phone.replace(/\D/g, "").length < 10}>Add</button>
            </form>
          ) : (
            <>
              <input type="search" placeholder={kind === "groups" ? "search for group..." : `search for ${kind === "customers" ? "customer" : kind === "employees" ? "employee" : "crew"}...`} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
              <RecipientList key={`${kind}:${groupsKey}`} kind={kind} q={q} picked={(id) => to.some((x) => x.kind === kind && x.id === id)} onPick={(r) => add(kind, r)}
                extra={kind === "groups" ? (r) => (
                  <>
                    <button type="button" className="hw-icon-btn" aria-label={`Members of ${r.name}`} title="Group members" onClick={() => setEditing(r)}><Icon name="user" size={16} /></button>
                    <button type="button" className="hw-icon-btn" aria-label={`Rename ${r.name}`} title="Rename" onClick={() => { const name = prompt("Group name", r.name)?.trim(); if (name && name !== r.name) group.run(async () => { await api(`/texting/groups/${r.id}`, { method: "PUT", body: { name } }); setGroupsKey((k) => k + 1); }); }}><Icon name="pencil" size={15} /></button>
                    <button type="button" className="hw-icon-btn danger" aria-label={`Delete ${r.name}`} title="Delete group" onClick={() => confirm(`Delete the group "${r.name}"? The customers in it aren't touched.`) && group.run(async () => { await api(`/texting/groups/${r.id}`, { method: "DELETE" }); setTo((cur) => cur.filter((x) => !(x.kind === "groups" && x.id === r.id))); setGroupsKey((k) => k + 1); })}>×</button>
                  </>
                ) : undefined} />
            </>
          )}
        </div>
        {kind === "groups" && (
          <div className="card txt-card">
            <h3>Add Customer Group</h3>
            <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); group.run(async () => { await api("/texting/groups", { body: { name: groupName } }); setGroupName(""); setGroupsKey((k) => k + 1); }); }}>
              <label><span>Group Name <span className="hwf-star">*</span></span><input value={groupName} maxLength={80} onChange={(e) => setGroupName(e.target.value)} /></label>
              <ErrorBox error={group.error} />
              <div className="txt-send-btn"><button className="btn hw-and" disabled={group.busy || !groupName.trim()}>Add Group</button></div>
            </form>
          </div>
        )}
        <div className="card txt-card txt-number"><strong>Your Phone Number:</strong> {settings.data?.connected ? formatPhone(settings.data.fromNumber) : "not connected yet"}</div>
      </div>
      {editing && <GroupMembers group={editing} onClose={() => { setEditing(null); setGroupsKey((k) => k + 1); }} />}
    </div>
  );
}

/** A group's members: customers and people on the team, added with + and taken off with ×. */
function GroupMembers({ group, onClose }: { group: Recipient; onClose: () => void }) {
  const data = useApi<{ members: { id: string; kind: string; name: string; detail: string }[] }>(`/texting/groups/${group.id}`);
  const [kind, setKind] = useState<"customers" | "employees">("customers");
  const [q, setQ] = useState("");
  const { error, run } = useAction();
  const add = (r: Recipient) => run(async () => { await api(`/texting/groups/${group.id}/members`, { body: kind === "customers" ? { customerId: r.id } : { employeeId: r.id } }); await data.reload(); });
  const names = new Set((data.data?.members ?? []).map((m) => m.name));
  return (
    <Dialog title={`Group members: ${group.name}`} onClose={onClose} wide>
      <div className="txt-members">
        <div className="stack" style={{ gap: 8 }}>
          <div className="txt-seg" role="tablist" aria-label="Add">
            {([["customers", "Customers"], ["employees", "Employees"]] as const).map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setQ(""); }}>{label}</button>)}
          </div>
          <input autoFocus type="search" placeholder={`Search ${kind}...`} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          <RecipientList kind={kind} q={q} picked={() => false} onPick={add} extra={(r) => (names.has(r.name) ? <span className="muted" style={{ fontSize: 12 }}>in the group</span> : null)} />
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <strong>In the group ({data.data?.members.length ?? 0})</strong>
          <ErrorBox error={data.error ?? error} />
          <ul className="txt-pick">
            {(data.data?.members ?? []).map((m) => (
              <li key={m.id}>
                <span className="txt-pick-name">{m.name}<span className="muted"> · {m.kind === "employee" ? "team · " : ""}{m.detail}</span></span>
                <button type="button" className="hw-icon-btn danger" aria-label={`Remove ${m.name}`} title="Take out of the group" onClick={() => run(async () => { await api(`/texting/groups/${group.id}/members/${m.id}`, { method: "DELETE" }); await data.reload(); })}>×</button>
              </li>
            ))}
            {data.data && !data.data.members.length && <li className="none">Nobody yet. Add customers or employees with +.</li>}
          </ul>
        </div>
      </div>
      <div className="hw-dialog-foot" style={{ margin: "12px -16px -16px" }}><button type="button" className="btn hw-and" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}

/* ───────────── Error Log ───────────── */

export function TextErrorsTab() {
  const data = useApi<{ rows: { id: string; at: string; error: string; phone: string; name: string | null; threadId: string | null; body: string }[] }>("/texting/errors");
  const rows = data.data?.rows ?? [];
  return (
    <div className="card hw-table-card">
      <ErrorBox error={data.error} />
      <div className="tablewrap">
        <table className="hw-table">
          <thead><tr><th>Date</th><th>Error Message</th><th>Number</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                <td>{r.error}<div className="muted" style={{ fontSize: 13 }}>&ldquo;{r.body}&rdquo;</div></td>
                <td style={{ whiteSpace: "nowrap" }}>{r.threadId ? <Link href={`/texts?thread=${r.threadId}`}>{r.name ?? formatPhone(r.phone)}</Link> : r.name ?? formatPhone(r.phone)}{r.name ? <div className="muted" style={{ fontSize: 13 }}>{formatPhone(r.phone)}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.data && !rows.length && <div className="hwf-none">No texts have failed.</div>}
    </div>
  );
}

/* ───────────── The Customers page: text the customers ticked (or all that match) ───────────── */

export function BulkText({ selection, audience, onClose }: { selection: Record<string, unknown>; audience: string; onClose: () => void }) {
  const templates = useTextTemplates();
  const [body, setBody] = useState("");
  const [done, setDone] = useState<{ sent: number; queued: number; skipped: { name: string; reason: string }[] } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <section className="card stack" aria-label="Text these customers">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Text {audience}</h2>
        <button type="button" className="btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {done ? (
        <>
          <p style={{ margin: 0 }}>{done.queued ? `${done.queued} texts are lined up and going out a few a minute.` : "Sent."} <Link href="/texts?tab=send">See how it's going</Link></p>
          {done.skipped.length > 0 && <p className="muted" style={{ margin: 0 }}>Left out ({done.skipped.length}): {done.skipped.slice(0, 8).map((s) => `${s.name} (${s.reason.toLowerCase()})`).join(", ")}{done.skipped.length > 8 ? "…" : ""}</p>}
        </>
      ) : (
        <>
          <MessageBox value={body} onChange={setBody} templates={templates} rows={5} />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Each customer gets their own text (tags are filled in for them), from your Talkroute number. Customers who replied STOP, have no mobile number, or are samples are left out.</p>
          <ErrorBox error={error} />
          <div><button type="button" className="btn primary" disabled={busy || !body.trim()} onClick={() => run(async () => setDone(await api("/texting/send", { body: { ...selection, body: body.trim(), audience } })))}>{busy ? "Sending…" : "Send text"}</button></div>
        </>
      )}
    </section>
  );
}

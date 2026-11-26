"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { clockText, type EventKind } from "@crewdesk/shared";
import { useAction } from "@/lib/hooks";
import {
  assignmentText, dateLabel, dispatchApi, dollars, eventHours, eventHref, hoursBoth, monthDay, relativeDay, time12, trim1,
  type Board, type DEvent,
} from "./data";
import { Check, Dialog, Ico, MenuItem, MiniCal, Pop, anchorOf } from "./beta-parts";

/* The beta board's windows and panels: assign, reschedule, waiting list, delete, skip; the status pill; an event's menu; the Work View. */

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const STATUS_LABEL: Record<string, string> = { open: "Open", on_site: "Open", skipped: "Skipped", completed: "Complete" };

/** The round status pill. With `onPick` it opens the Open / Skipped / Complete choices. */
export function StatusPill({ e, onPick, large }: { e: DEvent; onPick?: (s: "open" | "skipped" | "completed") => void; large?: boolean }) {
  const [at, setAt] = useState<ReturnType<typeof anchorOf> | null>(null);
  const now = e.status === "on_site" ? "open" : e.status;
  return (
    <>
      <button type="button" className={`dx-status s-${now}${large ? " large" : ""}`} aria-label="Set status" disabled={!onPick} onClick={(ev) => { ev.stopPropagation(); setAt(anchorOf(ev.currentTarget)); }}>
        <span className="dx-status-dot"><Ico name={now === "completed" ? "check" : now === "skipped" ? "minus" : "clock"} size={10} /></span>
        {STATUS_LABEL[e.status]}{onPick && <Ico name="down" size={12} />}
      </button>
      {e.onSite && <span className="dx-onsite" title="The crew is on site">On site</span>}
      <Pop at={at} onClose={() => setAt(null)} width={180}>
        {(["open", "skipped", "completed"] as const).filter((s) => !(s === "skipped" && e.kind === "todo")).map((s) => (
          <MenuItem key={s} checked={now === s} disabled={now === s} onClick={() => { setAt(null); onPick?.(s); }}>{STATUS_LABEL[s]}</MenuItem>
        ))}
      </Pop>
    </>
  );
}

export function TypeIcon({ kind }: { kind: EventKind }) {
  return <span className={`dx-type t-${kind}`} title={kind === "visit" ? "Work order" : "To-do"}><Ico name={kind === "visit" ? "wrench" : "todo"} size={12} /></span>;
}

export type EventAction = "view" | "zoom" | "open" | "skipped" | "completed" | "assign" | "reschedule" | "duplicate" | "edit" | "delete" | "text" | "email" | "unroute";
/** What can be done to one event (its row's ⋮, a right-click on its card or pin). */
export function EventMenu({ e, at, onClose, onAction, withView, canText }: { e: DEvent; at: { x: number; y: number; w?: number; h?: number } | null; onClose: () => void; onAction: (a: EventAction) => void; withView?: boolean; canText: boolean }) {
  const now = e.status === "on_site" ? "open" : e.status;
  const go = (a: EventAction) => () => { onClose(); onAction(a); };
  const done = e.status === "completed";
  return (
    <Pop at={at} onClose={onClose} width={220} align="right">
      {withView && <MenuItem icon="eye" onClick={go("view")}>View</MenuItem>}
      <MenuItem icon="pin" disabled={e.location?.lat == null} hint={e.location?.lat == null ? "No location on the map" : undefined} onClick={go("zoom")}>Zoom to location</MenuItem>
      <hr />
      <MenuItem checked={now === "open"} disabled={now === "open"} onClick={go("open")}>Open</MenuItem>
      {e.kind === "visit" && <MenuItem checked={now === "skipped"} disabled={now === "skipped"} onClick={go("skipped")}>Skipped</MenuItem>}
      <MenuItem checked={now === "completed"} disabled={now === "completed"} onClick={go("completed")}>Complete</MenuItem>
      <hr />
      {e.customer && <MenuItem icon="message" disabled={!canText} hint={canText ? undefined : "Texting isn't connected, or you aren't set up to send texts"} onClick={go("text")}>Text customer</MenuItem>}
      {e.customer && <MenuItem icon="mail" onClick={go("email")}>Email customer</MenuItem>}
      <MenuItem icon="users" onClick={go("assign")}>Assign</MenuItem>
      <MenuItem icon="calendar" disabled={done} hint={done ? "Completed ones can't be rescheduled" : undefined} onClick={go("reschedule")}>Reschedule</MenuItem>
      {e.route && <MenuItem icon="route" onClick={go("unroute")}>Remove from route</MenuItem>}
      <MenuItem icon="copy" onClick={go("duplicate")}>Duplicate</MenuItem>
      <MenuItem icon="pencil" onClick={go("edit")}>Edit</MenuItem>
      <MenuItem icon="trash" danger onClick={go("delete")}>Delete</MenuItem>
    </Pop>
  );
}

/* ───────────── Assign ───────────── */

/** Pick one crew, or one or more employees (never both). */
export function AssignDialog({ board, events, title = "Assign crew or employee", onClose, onAssign }: { board: Board; events: DEvent[]; title?: string; onClose: () => void; onAssign: (to: { crewId: string | null; employeeIds: string[] }) => Promise<unknown> }) {
  const same = events.every((e) => e.crewId === events[0].crewId && [...e.assigneeIds].sort().join() === [...events[0].assigneeIds].sort().join());
  const had = events.some((e) => e.crewId || e.assigneeIds.length);
  const [crewId, setCrewId] = useState<string | null>(same ? events[0]?.crewId ?? null : null);
  const [people, setPeople] = useState<string[]>(same && !events[0]?.crewId ? events[0]?.assigneeIds ?? [] : []);
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const crews = board.crews.filter((c) => match(c.name));
  const persons = board.people.filter((p) => match(p.name));
  const nothing = !crewId && !people.length;
  const summary = crewId ? `1 crew (${board.crews.find((c) => c.id === crewId)?.memberIds.length ?? 0}) assigned` : people.length ? `${people.length} employee${people.length === 1 ? "" : "s"} assigned` : !same && had ? "Mixed assignment" : "Nobody assigned";
  return (
    <Dialog title={title} onClose={onClose} footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="dx-btn dark" disabled={busy || (nothing && !had)} onClick={() => run(() => onAssign({ crewId, employeeIds: crewId ? [] : people }))}>{busy ? "Saving…" : nothing ? "Unassign" : had ? "Update assignment" : "Assign"}</button>
    </>}>
      <div className="dx-assign">
        <label className="dx-search-line"><Ico name="search" /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search crews and employees" /></label>
        <div className="dx-assign-list">
          <div className="dx-assign-head"><Ico name="users" /> Crews</div>
          {crews.map((c) => (
            <label key={c.id} className="dx-assign-row">
              <Check checked={crewId === c.id} label={c.name} onChange={(v) => { setCrewId(v ? c.id : null); if (v) setPeople([]); }} />
              <span className="dx-dot" style={{ background: c.color }} /><span>{c.name}</span><span className="dx-muted">{c.memberIds.length} {c.memberIds.length === 1 ? "person" : "people"}{c.truck ? ` · ${c.truck}` : ""}</span>
            </label>
          ))}
          {!crews.length && <div className="dx-assign-none">{board.crews.length ? "No crews match." : <>No crews yet. <Link href="/crews">Add one</Link></>}</div>}
          <div className="dx-assign-head"><Ico name="user" /> Employees</div>
          {persons.map((p) => (
            <label key={p.id} className="dx-assign-row">
              <Check checked={people.includes(p.id)} label={p.name} onChange={(v) => { setPeople(v ? [...people, p.id] : people.filter((x) => x !== p.id)); if (v) setCrewId(null); }} />
              <span className="dx-dot" style={{ background: p.color }} /><span>{p.name}</span>
            </label>
          ))}
        </div>
        <div className="dx-assign-sum"><span>{summary}</span>{!nothing && <button type="button" className="dx-link" onClick={() => { setCrewId(null); setPeople([]); }}>Clear</button>}</div>
        {error && <p className="dx-error">{error}</p>}
      </div>
    </Dialog>
  );
}

/* ───────────── Reschedule, waiting list, delete, skip ───────────── */

export function RescheduleDialog({ events, today, onClose, onDone }: { events: DEvent[]; today: string; onClose: () => void; onDone: (date: string) => Promise<unknown> }) {
  const [date, setDate] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const skipped = events.filter((e) => e.status === "skipped").length;
  const recurring = events.filter((e) => e.seriesId).length;
  return (
    <Dialog title={`Reschedule ${events.length} event${events.length === 1 ? "" : "s"}`} onClose={onClose} width={360} footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="dx-btn dark" disabled={busy || !date} onClick={() => run(() => onDone(date!))}>{busy ? "Moving…" : "Reschedule"}</button>
    </>}>
      <MiniCal value={date} onPick={setDate} today={today} />
      {date && <p className="dx-note">Moving to <strong>{dateLabel(date, { weekday: "long", month: "long", day: "numeric" })}</strong>. Who does {events.length === 1 ? "it" : "them"} stays the same.</p>}
      {skipped > 0 && <p className="dx-note">{skipped} skipped event{skipped === 1 ? "" : "s"} will be re-opened.</p>}
      {recurring > 0 && <p className="dx-note">{recurring === 1 && events.length === 1 ? "This one is part of a repeating series: only this visit moves." : `${recurring} of these repeat: only these visits move, not the rest of each series.`}</p>}
      {events.some((e) => e.route) && <p className="dx-note">Stops on a route come off it; route them again on their new day.</p>}
      {error && <p className="dx-error">{error}</p>}
    </Dialog>
  );
}

export function WaitlistDialog({ events, onClose, onDone }: { events: DEvent[]; onClose: () => void; onDone: (dueBy: "keep" | string | null) => Promise<unknown> }) {
  const [mode, setMode] = useState<"empty" | "set">("empty");
  const [date, setDate] = useState("");
  const { busy, error, run } = useAction();
  const todos = events.filter((e) => e.kind === "todo").length;
  return (
    <Dialog title="Move to waitlist" onClose={onClose} footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="dx-btn dark" disabled={busy || !!todos || (mode === "set" && !date)} onClick={() => run(() => onDone(mode === "set" ? date : null))}>{busy ? "Moving…" : "Move to waitlist"}</button>
    </>}>
      <p>{events.length} event{events.length === 1 ? "" : "s"} will move to the waitlist, keeping {events.length === 1 ? "its scheduled date" : "their scheduled dates"} as the earliest date.</p>
      {todos > 0 ? <p className="dx-error">To-dos can't go on the waiting list; only work orders can. Take the {todos === 1 ? "to-do" : `${todos} to-dos`} out of the selection.</p> : (
        <>
          <p><strong>What should the latest date be?</strong></p>
          <label className="dx-radio"><input type="radio" checked={mode === "empty"} onChange={() => setMode("empty")} /> Leave the latest date empty</label>
          <label className="dx-radio"><input type="radio" checked={mode === "set"} onChange={() => setMode("set")} /> Set a latest date</label>
          {mode === "set" && <input type="date" className="dx-input" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Latest date" />}
        </>
      )}
      {error && <p className="dx-error">{error}</p>}
    </Dialog>
  );
}

export function ConfirmDialog({ title, children, action, danger, onClose, onDone }: { title: string; children: React.ReactNode; action: string; danger?: boolean; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { busy, error, run } = useAction();
  return (
    <Dialog title={title} onClose={onClose} footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
      <button type="button" className={`dx-btn ${danger ? "danger" : "dark"}`} disabled={busy} onClick={() => run(onDone)}>{busy ? "Working…" : action}</button>
    </>}>
      {children}
      {error && <p className="dx-error">{error}</p>}
    </Dialog>
  );
}

export function SkipDialog({ count, onClose, onDone }: { count: number; onClose: () => void; onDone: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Dialog title={count === 1 ? "Skip event" : `Skip ${count} events`} onClose={onClose} footer={<>
      <button type="button" className="dx-btn" onClick={onClose}>Cancel</button>
      <button type="button" className="dx-btn dark" disabled={busy || !reason.trim()} onClick={() => run(() => onDone(reason.trim()))}>{busy ? "Skipping…" : "Skip"}</button>
    </>}>
      <p>Please provide a reason for skipping the event{count === 1 ? "" : "s"}</p>
      <textarea className="dx-input" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
      {error && <p className="dx-error">{error}</p>}
    </Dialog>
  );
}

/* ───────────── Dispatch notes ───────────── */

const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function NotesThread({ e, onAdded }: { e: DEvent; onAdded: (notes: DEvent["dispatchNotes"]) => void }) {
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  const send = () => text.trim() && run(async () => { const r = await dispatchApi.note(e.key, text.trim()); setText(""); onAdded(r.dispatchNotes); });
  return (
    <div className="dx-notes">
      {e.dispatchNotes.map((n) => (
        <div key={n.id} className="dx-note-item"><p>{n.body}</p><span>Sent by {n.by ?? "someone"} at {stamp(n.at)}</span></div>
      ))}
      <div className="dx-note-send">
        <input className="dx-input" placeholder="Send dispatch note" value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); send(); } }} aria-label="Send dispatch note" />
        <button type="button" className="dx-icon-btn solid" aria-label="Send" disabled={busy || !text.trim()} onClick={send}><Ico name="send" /></button>
      </div>
      {error && <p className="dx-error">{error}</p>}
    </div>
  );
}

/** The yellow notepad by an event's name: its dispatch notes, and a box to add one. */
export function NotesButton({ e, onAdded }: { e: DEvent; onAdded: (notes: DEvent["dispatchNotes"]) => void }) {
  const [at, setAt] = useState<ReturnType<typeof anchorOf> | null>(null);
  if (!e.dispatchNotes.length) return null;
  return (
    <>
      <button type="button" className="dx-notepad" title={`${e.dispatchNotes.length} dispatch note${e.dispatchNotes.length === 1 ? "" : "s"}`} aria-label="Dispatch notes" onClick={(ev) => { ev.stopPropagation(); setAt(anchorOf(ev.currentTarget)); }}><Ico name="note" size={14} /></button>
      <Pop at={at} onClose={() => setAt(null)} width={320} className="pad"><NotesThread e={e} onAdded={onAdded} /></Pop>
    </>
  );
}

/* ───────────── Work View ───────────── */

/** Everything about one event, beside the list. Arrows step through the rows. */
export function WorkView({ e, board, today, tags, onClose, onStep, onStatus, onAction, onNotes, canText }: {
  e: DEvent; board: Board; today: string; tags: { id: string; name: string; color: string }[]; onClose: () => void; onStep: (by: 1 | -1) => void;
  onStatus: (s: "open" | "skipped" | "completed") => void; onAction: (a: EventAction) => void; onNotes: (notes: DEvent["dispatchNotes"]) => void; canText: boolean;
}) {
  const [tab, setTab] = useState<"visit" | "dispatch" | "property">("visit");
  const [menu, setMenu] = useState<ReturnType<typeof anchorOf> | null>(null);
  const [who, setWho] = useState(false);
  const hours = eventHours(e);
  const share = hours > 0 ? Math.min(1, e.trackedSeconds / 3600 / hours) : 0;
  const myTags = useMemo(() => e.tagIds.map((id) => tags.find((t) => t.id === id)).filter((t): t is { id: string; name: string; color: string } => !!t), [e.tagIds, tags]);
  const assigned = assignmentText(e, board);
  return (
    <aside className="dx-work" aria-label={`Work View details for ${e.title}`}>
      <div className="dx-work-bar">
        <button type="button" className="dx-icon-btn" aria-label="Previous table row" onClick={() => onStep(-1)}><Ico name="up" /></button>
        <button type="button" className="dx-icon-btn" aria-label="Next table row" onClick={() => onStep(1)}><Ico name="down" /></button>
        <span style={{ flex: 1 }} />
        <button type="button" className="dx-icon-btn" aria-label="Close work view" onClick={onClose}><Ico name="x" /></button>
      </div>
      <div className="dx-work-body">
        <div className="dx-work-top">
          <span className="dx-work-color" style={{ background: e.color }} />
          <div className="dx-work-title">
            <div className="dx-work-when">{monthDay(e.date)} <span className="dx-freq">{e.frequency ?? "Single visit"}</span></div>
            <h2>{e.title}</h2>
            {e.customer && <button type="button" className="dx-link" onClick={() => setWho(!who)}>{e.customer.name}</button>}
          </div>
          <StatusPill e={e} onPick={onStatus} large />
          <button type="button" className="dx-icon-btn" aria-label="Event actions" onClick={(ev) => setMenu(anchorOf(ev.currentTarget))}><Ico name="dots" /></button>
        </div>
        {who && e.customer && (
          <div className="dx-work-contact">
            {e.customer.phone ? <a className="dx-btn" href={`tel:${e.customer.phone}`}><Ico name="phone" /> Call</a> : <span className="dx-muted">No phone number on file</span>}
            {e.customer.phone && <button type="button" className="dx-btn" disabled={!canText} onClick={() => onAction("text")}><Ico name="message" /> Text</button>}
            <button type="button" className="dx-btn" onClick={() => onAction("email")}><Ico name="mail" /> Email</button>
            <Link className="dx-link" href={`/customers/${e.customer.id}`}>Open customer</Link>
          </div>
        )}
        <ul className="dx-work-facts">
          <li><Ico name="pin" /> <span>{e.location?.address ?? "No location"}{e.location?.mapCode ? ` · MC ${e.location.mapCode}` : ""}</span></li>
          {e.startTime && <li><Ico name="calendar" /> <span>{time12(e.startTime)}{e.endTime ? ` – ${time12(e.endTime)}` : ""} · {relativeDay(e.date, today)}</span></li>}
          <li><Ico name="clock" /> <span>{trim1(hours)} BH{e.estSource === "size" ? " (estimated from lawn size)" : e.estSource === "history" ? " (from past visits)" : ""}</span></li>
          <li><Ico name="user" /> <button type="button" className="dx-link plain" aria-label="Edit crew or employee assignment" onClick={() => onAction("assign")}>{assigned || "Unassigned"}</button></li>
          {e.route && <li><Ico name="route" /> <span>Stop {pad2(e.route.order)} on its route</span></li>}
          <li><Ico name="tag" /> {myTags.length ? myTags.map((t) => <span key={t.id} className="dx-chip">{t.name}</span>) : <span className="dx-muted">No tags</span>}</li>
        </ul>

        <h3>Notes</h3>
        <div className="dx-work-notes">
          <div className="dx-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "visit"} className={tab === "visit" ? "on" : ""} onClick={() => setTab("visit")}>Visit</button>
            <button type="button" role="tab" aria-selected={tab === "dispatch"} className={tab === "dispatch" ? "on" : ""} onClick={() => setTab("dispatch")}>Dispatch{e.dispatchNotes.length ? ` (${e.dispatchNotes.length})` : ""}</button>
            <button type="button" role="tab" aria-selected={tab === "property"} className={tab === "property" ? "on" : ""} disabled={!e.propertyId} onClick={() => setTab("property")}>Property</button>
          </div>
          {tab === "visit" && (e.notes ? <p className="dx-work-text">{e.notes}</p> : <p className="dx-muted">No visit notes. <Link className="dx-link" href={eventHref(e, true)}>Add note →</Link></p>)}
          {tab === "dispatch" && <NotesThread e={e} onAdded={onNotes} />}
          {tab === "property" && (e.propertyNotes ? <p className="dx-work-text">{e.propertyNotes}</p> : <p className="dx-muted">No property notes.</p>)}
        </div>

        <h3>Items &amp; services</h3>
        {e.services.length ? <ul className="dx-work-lines">{e.services.map((s, i) => <li key={i}><span>{s.name}</span><span className="dx-muted">× {trim1(s.quantity)}</span></li>)}</ul> : <p className="dx-muted">No line items</p>}
        {e.totalCents != null && e.kind === "visit" && <p className="dx-work-total">Total <strong>{dollars(e.totalCents)}</strong>{e.invoice ? <> · <Link className="dx-link" href={`/invoices/${e.invoice.id}`}>Invoice {e.invoice.number ?? "(draft)"}</Link></> : e.invoiceable ? " · Not invoiced" : " · Not invoiceable"}</p>}

        <h3>Time tracking</h3>
        <div className="dx-work-time"><Ico name="clock" size={18} /> <strong>{clockText(e.trackedSeconds)}</strong>{e.onSite && <span className="dx-onsite">On site now</span>}</div>
        <div className="dx-bar-track"><span style={{ width: `${share * 100}%` }} /></div>
        <div className="dx-work-time-foot"><span>{hoursBoth(e.trackedSeconds).split(" ")[0]} tracked</span><span>BH: {Math.floor(hours)}h {Math.round((hours % 1) * 60)}m</span></div>

        <h3>Media</h3>
        <p className="dx-muted">{e.fileCount ? `${e.fileCount} photo${e.fileCount === 1 ? "" : "s"} or file${e.fileCount === 1 ? "" : "s"}.` : "No photos or files yet."} <Link className="dx-link" href={eventHref(e)}>{e.kind === "visit" ? "Open the work order" : "Open the to-do"} →</Link></p>
        {e.kind === "visit" && <p className="dx-muted dx-work-foot">Custom fields and visit forms are on the work order's own page.</p>}
      </div>
      <Pop at={menu} onClose={() => setMenu(null)} width={200} align="right">
        <MenuItem icon="external" onClick={() => { setMenu(null); onAction("view"); }}>{e.kind === "visit" ? "View work order" : "View to-do"}</MenuItem>
        <MenuItem icon="pencil" onClick={() => { setMenu(null); onAction("edit"); }}>Edit</MenuItem>
        <MenuItem icon="calendar" disabled={e.status === "completed"} onClick={() => { setMenu(null); onAction("reschedule"); }}>Reschedule</MenuItem>
        <MenuItem icon="copy" onClick={() => { setMenu(null); onAction("duplicate"); }}>Duplicate</MenuItem>
        <MenuItem icon="trash" danger onClick={() => { setMenu(null); onAction("delete"); }}>Delete</MenuItem>
      </Pop>
    </aside>
  );
}

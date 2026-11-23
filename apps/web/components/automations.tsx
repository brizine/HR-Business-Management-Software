"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  AUTOMATION_ACTIONS, AUTOMATION_FIELDS, AUTOMATION_TRIGGERS, SAMPLE_AUTOMATION_VARS, STOP_CONDITIONS, describeWait, fillTemplate, isInactive, stopsFor, textSegments,
  type AutomationAction, type AutomationTrigger, type StopCondition,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { TagChip, useTags } from "@/components/customers";

/** Automations (like Homeworks'): what happens when, the steps, templates, review and history. */

type Step = { waitMinutes: number; action: AutomationAction; templateId?: string | null; employeeIds: string[]; tagId?: string | null; todoTitle?: string | null };
type Automation = {
  id: string; name: string; description: string | null; enabled: boolean; trigger: AutomationTrigger; daysBefore: number | null; tagId: string | null;
  onlyTagIds: string[]; exceptTagIds: string[]; stopWhen: StopCondition[]; review: boolean; steps: Step[];
  counts: { running: number; review: number; done: number; stopped: number };
};
type Template = { id: string; kind: "email" | "text"; name: string; subject: string | null; body: string };
type RunLog = { step: number; action: string; status: string; detail: string; at: string };
type Run = {
  id: string; status: string; stepIndex: number; steps: number; nextAt: string | null; createdAt: string; finishedAt: string | null; stoppedReason: string | null; log: RunLog[];
  subjectType: string; subjectId: string | null; automation: { id: string; name: string; trigger: string }; customer: { id: string; name: string } | null;
  next: { action: string; wait: string } | null; preview: { subject: string | null; body: string } | null;
};

const TRIGGER_GROUPS = [...new Set(Object.values(AUTOMATION_TRIGGERS).map((t) => t.group))];
const ACTION_SHORT: Record<AutomationAction, string> = { email_customer: "Email customer", text_customer: "Text customer", email_staff: "Email office", notify_staff: "Notify office", add_tag: "Add tag", remove_tag: "Remove tag", create_todo: "To-do" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const STATUS: Record<string, [string, string]> = { running: ["Running", "info"], review: ["Needs review", "warn"], done: ["Done", "ok"], stopped: ["Stopped", ""], skipped: ["Skipped", ""], failed: ["Failed", "bad"] };
export const RunStatus = ({ s }: { s: string }) => <span className={`badge ${STATUS[s]?.[1] ?? ""}`}>{STATUS[s]?.[0] ?? s}</span>;

export function AutomationsPage() {
  const [tab, setTab] = useState<"list" | "review" | "history" | "templates">("list");
  const list = useApi<{ review: number; automations: Automation[] }>("/automations");
  return (
    <div className="stack auto-page">
      <nav className="cal-seg cp-tabs" aria-label="Automations sections">
        {([["list", "Automations"], ["review", `Review${list.data?.review ? ` (${list.data.review})` : ""}`], ["history", "History"], ["templates", "Templates"]] as const).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      {tab === "list" && <AutomationList list={list} />}
      {tab === "review" && <ReviewList onChange={list.reload} />}
      {tab === "history" && <RunHistory />}
      {tab === "templates" && <Templates />}
    </div>
  );
}

function triggerText(a: Pick<Automation, "trigger" | "daysBefore" | "tagId">, tags: { id: string; name: string }[]) {
  const t = AUTOMATION_TRIGGERS[a.trigger]?.label ?? a.trigger;
  if (a.trigger === "visit_upcoming") return `${a.daysBefore ?? 1} day${a.daysBefore === 1 ? "" : "s"} before a work order`;
  if (a.trigger === "tag_added" || a.trigger === "tag_removed") return `${t}: ${tags.find((x) => x.id === a.tagId)?.name ?? "?"}`;
  return t;
}

function AutomationList({ list }: { list: ReturnType<typeof useApi<{ review: number; automations: Automation[] }>> }) {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const { tags } = useTags();
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const { busy, error, run } = useAction();
  const rows = list.data?.automations ?? [];
  if (editing) return <AutomationEditor automation={editing === "new" ? null : editing} onDone={() => { setEditing(null); list.reload(); }} />;
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>When something happens, these run their steps in order, each after its wait. A new automation only starts for things that happen after it&apos;s turned on. Texts only go out 9 AM to 6 PM.</p>
      {admin && (
        <div className="row">
          <button className="btn primary" onClick={() => setEditing("new")}>New automation</button>
          <button className="btn" disabled={busy} onClick={() => run(async () => { await api("/automations/starter", { method: "POST" }); list.reload(); })}>Add the starter automations</button>
        </div>
      )}
      <ErrorBox error={list.error ?? error} />
      <div className="card" style={{ padding: 0 }}>
        {rows.length ? (
          <div className="tablewrap">
            <table>
              <thead><tr><th>On</th><th>Automation</th><th>When</th><th>Steps</th><th>Running</th><th /></tr></thead>
              <tbody>{rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <label className="switch" title={a.enabled ? "On" : "Off"}>
                      <input type="checkbox" checked={a.enabled} disabled={!admin || busy} aria-label={`${a.name} on`}
                        onChange={(e) => { const on = e.target.checked; if (!on && (a.counts.running || a.counts.review) && !confirm(`Turn off "${a.name}"? Its ${a.counts.running + a.counts.review} running stop.`)) return; run(async () => { await api(`/automations/${a.id}/enabled`, { body: { enabled: on } }); list.reload(); }); }} />
                      <span>{a.enabled ? "On" : "Off"}</span>
                    </label>
                  </td>
                  <td><strong>{a.name}</strong>{a.review && <span className="badge" style={{ marginLeft: 6 }}>review first</span>}{a.description && <div className="muted" style={{ fontSize: 12 }}>{a.description}</div>}</td>
                  <td>{triggerText(a, tags)}</td>
                  <td style={{ fontSize: 13 }}>{a.steps.map((s, i) => <div key={i}>{i + 1}. {describeWait(s.waitMinutes)}: {ACTION_SHORT[s.action]}</div>)}</td>
                  <td>{a.counts.running}{a.counts.review ? <span className="badge warn" style={{ marginLeft: 4 }}>{a.counts.review} review</span> : null}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    {admin && <button className="btn" onClick={() => setEditing(a)}>Edit</button>}
                    {admin && <button className="btn danger" disabled={busy} onClick={() => confirm(`Delete "${a.name}"? Its history goes too.`) && run(async () => { await api(`/automations/${a.id}`, { method: "DELETE" }); list.reload(); })}>Delete</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="muted" style={{ padding: 16, margin: 0 }}>{list.loading ? "Loading…" : "No automations yet. Add the starter set (all off) to see how they work, or make your own."}</p>}
      </div>
    </div>
  );
}

/** "Instantly" / after N minutes, hours or days. */
function WaitInput({ minutes, onChange, first }: { minutes: number; onChange: (m: number) => void; first: boolean }) {
  const unit = minutes === 0 ? "now" : minutes % 1440 === 0 ? "days" : minutes % 60 === 0 ? "hours" : "minutes";
  const n = unit === "days" ? minutes / 1440 : unit === "hours" ? minutes / 60 : minutes;
  const mult = { now: 0, minutes: 1, hours: 60, days: 1440 } as const;
  return (
    <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
      <select value={unit} onChange={(e) => { const u = e.target.value as keyof typeof mult; onChange(u === "now" ? 0 : Math.max(1, n || 1) * mult[u]); }} aria-label="When" style={{ width: "auto" }}>
        <option value="now">{first ? "Instantly" : "Right after the step before"}</option>
        <option value="minutes">After minutes</option><option value="hours">After hours</option><option value="days">After days</option>
      </select>
      {unit !== "now" && <input type="number" min={1} max={unit === "days" ? 120 : unit === "hours" ? 2880 : 10000} value={n} onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1) * mult[unit])} style={{ width: 80 }} aria-label="How many" />}
    </div>
  );
}

function AutomationEditor({ automation, onDone }: { automation: Automation | null; onDone: () => void }) {
  const { tags } = useTags();
  const tpls = useApi<Template[]>("/automations/templates");
  const staff = useApi<any[]>("/employees");
  const people = (staff.data ?? []).filter((e) => !isInactive(e.status));
  const [a, setA] = useState<Omit<Automation, "id" | "counts">>(automation ?? {
    name: "", description: "", enabled: false, trigger: "estimate_sent", daysBefore: 1, tagId: null, onlyTagIds: [], exceptTagIds: [], stopWhen: ["estimate_answered", "customer_cancelled"], review: false,
    steps: [{ waitMinutes: 0, action: "email_customer", templateId: null, employeeIds: [], tagId: null, todoTitle: null }],
  });
  const { busy, error, run } = useAction();
  const set = (patch: Partial<typeof a>) => setA({ ...a, ...patch });
  const setStep = (i: number, patch: Partial<Step>) => set({ steps: a.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: number) => { const s = [...a.steps]; [s[i], s[i + d]] = [s[i + d], s[i]]; set({ steps: s }); };
  const allowedStops = stopsFor(a.trigger);
  const tagOptions = tags.filter((t) => !t.archived);
  const kindFor = (act: AutomationAction) => (act === "text_customer" ? "text" : act === "email_customer" || act === "email_staff" ? "email" : act === "notify_staff" ? "any" : null);
  return (
    <form className="card stack auto-form" onSubmit={(e) => { e.preventDefault(); run(async () => {
      const body = { ...a, stopWhen: a.stopWhen.filter((s) => allowedStops.includes(s)) };
      await api(automation ? `/automations/${automation.id}` : "/automations", { method: automation ? "PUT" : "POST", body }); onDone();
    }); }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>{automation ? `Edit "${automation.name}"` : "New automation"}</h2>
      <div className="formgrid">
        <label>Name<input value={a.name} onChange={(e) => set({ name: e.target.value })} required maxLength={120} /></label>
        <label>Description (optional)<input value={a.description ?? ""} onChange={(e) => set({ description: e.target.value })} maxLength={500} /></label>
      </div>
      <fieldset className="stack" style={{ gap: 8 }}>
        <legend>When</legend>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label>This happens
            <select value={a.trigger} onChange={(e) => { const t = e.target.value as AutomationTrigger; set({ trigger: t, stopWhen: stopsFor(t).filter((s) => AUTOMATION_TRIGGERS[t].stop.includes(s as never) || s === "customer_cancelled") }); }} style={{ width: "auto" }}>
              {TRIGGER_GROUPS.map((g) => <optgroup key={g} label={g}>{(Object.entries(AUTOMATION_TRIGGERS) as [AutomationTrigger, (typeof AUTOMATION_TRIGGERS)[AutomationTrigger]][]).filter(([, t]) => t.group === g).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</optgroup>)}
            </select>
          </label>
          {a.trigger === "visit_upcoming" && <label>Days before (at 8 AM)<input type="number" min={1} max={14} value={a.daysBefore ?? 1} onChange={(e) => set({ daysBefore: Number(e.target.value) || 1 })} style={{ width: 80 }} /></label>}
          {(a.trigger === "tag_added" || a.trigger === "tag_removed") && <label>Tag<select value={a.tagId ?? ""} onChange={(e) => set({ tagId: e.target.value || null })} required style={{ width: "auto" }}><option value="">Choose…</option>{tagOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
        </div>
        <TagPick label="Only customers with any of these tags (optional)" value={a.onlyTagIds} onChange={(onlyTagIds) => set({ onlyTagIds })} tags={tagOptions} />
        <TagPick label="Never customers with any of these tags" value={a.exceptTagIds} onChange={(exceptTagIds) => set({ exceptTagIds })} tags={tagOptions} />
      </fieldset>
      <fieldset className="stack" style={{ gap: 8 }}>
        <legend>Steps</legend>
        {a.steps.map((s, i) => {
          const kind = kindFor(s.action);
          const choices = (tpls.data ?? []).filter((t) => kind === "any" || t.kind === kind);
          return (
            <div key={i} className="card inset stack auto-step" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>Step {i + 1}</strong>
                <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>↑</button>
                  <button type="button" className="btn" disabled={i === a.steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>↓</button>
                  {a.steps.length > 1 && <button type="button" className="btn" onClick={() => set({ steps: a.steps.filter((_, j) => j !== i) })} aria-label={`Remove step ${i + 1}`}>✕</button>}
                </div>
              </div>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <label>When<WaitInput minutes={s.waitMinutes} first={i === 0} onChange={(waitMinutes) => setStep(i, { waitMinutes })} /></label>
                <label>Do this
                  <select value={s.action} onChange={(e) => setStep(i, { action: e.target.value as AutomationAction, templateId: null })} style={{ width: "auto" }}>
                    {(Object.entries(AUTOMATION_ACTIONS) as [AutomationAction, string][]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                {kind && (
                  <label>Template
                    <select value={s.templateId ?? ""} onChange={(e) => setStep(i, { templateId: e.target.value || null })} required style={{ width: "auto", maxWidth: 320 }}>
                      <option value="">Choose…</option>
                      {choices.map((t) => <option key={t.id} value={t.id}>{t.kind === "text" ? "Text: " : "Email: "}{t.name}</option>)}
                    </select>
                  </label>
                )}
                {(s.action === "add_tag" || s.action === "remove_tag") && <label>Tag<select value={s.tagId ?? ""} onChange={(e) => setStep(i, { tagId: e.target.value || null })} required style={{ width: "auto" }}><option value="">Choose…</option>{tagOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
                {s.action === "create_todo" && <label>To-do<input value={s.todoTitle ?? ""} onChange={(e) => setStep(i, { todoTitle: e.target.value })} placeholder="Call about estimate {estimate_number}" required /></label>}
              </div>
              {(s.action === "email_staff" || s.action === "notify_staff" || s.action === "create_todo") && (
                <div className="row" role="group" aria-label="Who in the office">
                  <span className="muted" style={{ fontSize: 13 }}>{s.action === "create_todo" ? "For:" : "To:"}</span>
                  {people.map((p) => (
                    <label key={p.id} className="check"><input type="checkbox" checked={s.employeeIds.includes(p.id)} onChange={(e) => setStep(i, { employeeIds: e.target.checked ? [...s.employeeIds, p.id] : s.employeeIds.filter((x) => x !== p.id) })} /> {p.firstName} {p.lastName}</label>
                  ))}
                </div>
              )}
              {s.action === "text_customer" && <span className="muted" style={{ fontSize: 12 }}>Texts go out 9 AM to 6 PM; otherwise they wait for 9 AM. They&apos;re skipped while texting isn&apos;t connected or the customer replied STOP.</span>}
            </div>
          );
        })}
        {a.steps.length < 12 && <div><button type="button" className="btn" onClick={() => set({ steps: [...a.steps, { waitMinutes: 1440, action: "email_customer", templateId: null, employeeIds: [], tagId: null, todoTitle: null }] })}>Add a step</button></div>}
      </fieldset>
      <fieldset className="stack" style={{ gap: 6 }}>
        <legend>Stop early when</legend>
        {allowedStops.map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={a.stopWhen.includes(k)} onChange={(e) => set({ stopWhen: e.target.checked ? [...a.stopWhen, k] : a.stopWhen.filter((x) => x !== k) })} /> {STOP_CONDITIONS[k]}</label>
        ))}
      </fieldset>
      <label className="check"><input type="checkbox" checked={a.review} onChange={(e) => set({ review: e.target.checked })} /> Review first: customer emails and texts wait in Automations → Review until someone sends them</label>
      <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On (starts for things that happen from now on)</label>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save automation</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function TagPick({ label, value, onChange, tags }: { label: string; value: string[]; onChange: (v: string[]) => void; tags: { id: string; name: string; color: string }[] }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="muted" style={{ fontSize: 13 }}>{label}</span>
      <div className="row" style={{ gap: 6 }}>
        {tags.map((t) => (
          <label key={t.id} className="check" style={{ opacity: value.includes(t.id) ? 1 : 0.7 }}>
            <input type="checkbox" checked={value.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} /> <TagChip tag={t} />
          </label>
        ))}
        {!tags.length && <span className="muted">No tags yet.</span>}
      </div>
    </div>
  );
}

function ReviewList({ onChange }: { onChange: () => void }) {
  const runs = useApi<Run[]>("/automations/runs?status=review");
  const { busy, error, run } = useAction();
  const decide = (id: string, decision: "send" | "skip" | "stop") => run(async () => { await api(`/automations/runs/${id}/review`, { body: { decision } }); runs.reload(); onChange(); });
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>Customer emails and texts from automations set to &quot;review first&quot; wait here. Send one as it is, skip just this step, or stop the automation for that customer.</p>
      <ErrorBox error={runs.error ?? error} />
      {(runs.data ?? []).map((r) => (
        <div key={r.id} className="card stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span><strong>{r.automation.name}</strong> · {r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : "—"} · step {r.stepIndex + 1} of {r.steps}: {r.next?.action}</span>
            <span className="muted" style={{ fontSize: 12 }}>started {when(r.createdAt)}</span>
          </div>
          {r.preview && <div className="card inset">{r.preview.subject && <div><strong>{r.preview.subject}</strong></div>}<div style={{ whiteSpace: "pre-wrap" }}>{r.preview.body}</div></div>}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => decide(r.id, "send")}>Send</button>
            <button className="btn" disabled={busy} onClick={() => decide(r.id, "skip")}>Skip this step</button>
            <button className="btn danger" disabled={busy} onClick={() => decide(r.id, "stop")}>Stop for this customer</button>
          </div>
        </div>
      ))}
      {runs.data && !runs.data.length && <p className="muted">Nothing waiting for review.</p>}
    </div>
  );
}

/** Runs, newest first (all, or one customer's), with what each step did. */
export function RunHistory({ customerId }: { customerId?: string }) {
  const [status, setStatus] = useState("");
  const runs = useApi<Run[]>(`/automations/runs?limit=200${status ? `&status=${status}` : ""}${customerId ? `&customerId=${customerId}` : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="stack">
      <div className="row">
        <label>Show<select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}><option value="">All</option><option value="running,review">Running or in review</option><option value="done">Done</option><option value="stopped">Stopped</option></select></label>
      </div>
      <ErrorBox error={runs.error ?? error} />
      <div className="card" style={{ padding: 0 }}>
        {runs.data?.length ? (
          <ul className="plain-list auto-runs">
            {runs.data.map((r) => (
              <li key={r.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <button type="button" className="linkbtn" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <strong>{r.automation.name}</strong>{!customerId && r.customer ? <> · {r.customer.name}</> : null}
                  </button>
                  <span className="row" style={{ gap: 6 }}>
                    <RunStatus s={r.status} />
                    <span className="muted" style={{ fontSize: 12 }}>{when(r.createdAt)}</span>
                    {(r.status === "running" || r.status === "review") && <button className="btn" disabled={busy} onClick={() => confirm("Stop this automation for this customer?") && run(async () => { await api(`/automations/runs/${r.id}/stop`, { method: "POST" }); runs.reload(); })}>Stop</button>}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {r.automation.trigger}{r.status === "running" && r.next ? ` · next: ${r.next.action}${r.nextAt ? ` ${when(r.nextAt)}` : ""}` : ""}{r.stoppedReason ? ` · ${r.stoppedReason}` : ""}
                  {customerId ? null : r.customer ? <> · <Link href={`/customers/${r.customer.id}`}>open customer</Link></> : null}
                </div>
                {open === r.id && (
                  <ol className="auto-log">
                    {r.log.map((l, i) => <li key={i}><RunStatus s={l.status} /> {ACTION_SHORT[l.action as AutomationAction] ?? l.action}: {l.detail} <span className="muted">· {when(l.at)}</span></li>)}
                    {!r.log.length && <li className="muted">No steps done yet.</li>}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="muted" style={{ padding: 16, margin: 0 }}>{runs.loading ? "Loading…" : "Nothing yet."}</p>}
      </div>
    </div>
  );
}

/** Email and text templates with {fill-ins}. */
function Templates() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const tpls = useApi<Template[]>("/automations/templates");
  const [editing, setEditing] = useState<Template | { kind: "email" | "text" } | null>(null);
  const { busy, error, run } = useAction();
  if (editing) return <TemplateEditor tpl={editing} onDone={() => { setEditing(null); tpls.reload(); }} />;
  return (
    <div className="stack">
      {admin && <div className="row"><button className="btn primary" onClick={() => setEditing({ kind: "email" })}>New email template</button><button className="btn" onClick={() => setEditing({ kind: "text" })}>New text template</button></div>}
      <ErrorBox error={tpls.error ?? error} />
      {(["email", "text"] as const).map((k) => (
        <div key={k} className="card">
          <h2 className="cp-h">{k === "email" ? "Email templates" : "Text templates"}</h2>
          <ul className="plain-list">
            {(tpls.data ?? []).filter((t) => t.kind === k).map((t) => (
              <li key={t.id} className="row" style={{ justifyContent: "space-between" }}>
                <span><strong>{t.name}</strong><span className="muted"> · {(t.subject ?? t.body).slice(0, 80)}</span></span>
                {admin && <span className="row" style={{ gap: 4 }}><button className="btn" onClick={() => setEditing(t)}>Edit</button><button className="btn danger" disabled={busy} onClick={() => confirm(`Delete "${t.name}"?`) && run(async () => { await api(`/automations/templates/${t.id}`, { method: "DELETE" }); tpls.reload(); })}>Delete</button></span>}
              </li>
            ))}
            {!(tpls.data ?? []).some((t) => t.kind === k) && <li className="muted">None yet.</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TemplateEditor({ tpl, onDone }: { tpl: Template | { kind: "email" | "text" }; onDone: () => void }) {
  const existing = "id" in tpl ? tpl : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [subject, setSubject] = useState(existing?.subject ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const area = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useAction();
  const insert = (k: string) => {
    const el = area.current, tag = `{${k}}`;
    if (!el) { setBody(body + tag); return; }
    const s = el.selectionStart ?? body.length, e = el.selectionEnd ?? body.length;
    setBody(body.slice(0, s) + tag + body.slice(e));
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + tag.length; });
  };
  const seg = textSegments(fillTemplate(body, SAMPLE_AUTOMATION_VARS));
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => {
      const b = { kind: tpl.kind, name, subject: tpl.kind === "email" ? subject : null, body };
      await api(existing ? `/automations/templates/${existing.id}` : "/automations/templates", { method: existing ? "PUT" : "POST", body: b }); onDone();
    }); }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>{existing ? "Edit" : "New"} {tpl.kind} template</h2>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
      {tpl.kind === "email" && <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} /></label>}
      <label>{tpl.kind === "email" ? "Message" : "Text"}<textarea ref={area} rows={tpl.kind === "email" ? 10 : 4} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={tpl.kind === "text" ? 1000 : 10000} /></label>
      <div className="stack" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: 13 }}>Fill-ins (click to add where the cursor is):</span>
        <div className="row" style={{ gap: 4 }}>{AUTOMATION_FIELDS.map(([k, l, hint]) => <button key={k} type="button" className="chip-btn" title={hint || undefined} onClick={() => insert(k)}>{l}</button>)}</div>
        <span className="muted" style={{ fontSize: 12 }}>Fill-ins that don&apos;t apply (e.g. an invoice&apos;s on an estimate automation) come out blank.</span>
      </div>
      {tpl.kind === "text" && <span className="muted" style={{ fontSize: 12 }}>About {seg.length} characters with sample values{seg.segments > 1 ? `, sent as ${seg.segments} texts` : ""}. Include &quot;Reply STOP to opt out&quot; in texts that aren&apos;t replies.</span>}
      <div className="card inset">
        <div className="muted" style={{ fontSize: 12 }}>Preview with sample values</div>
        {tpl.kind === "email" && <strong>{fillTemplate(subject, SAMPLE_AUTOMATION_VARS)}</strong>}
        <div style={{ whiteSpace: "pre-wrap" }}>{fillTemplate(body, SAMPLE_AUTOMATION_VARS)}</div>
      </div>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save template</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

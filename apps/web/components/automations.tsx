"use client";
import Link from "next/link";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AUTOMATION_ACTIONS, RUN_TIMES, SIMPLE_ACTION_KEYS, SUB_ACTIONS, TRIGGERS, TRIGGER_GROUPS, ACTION_KEYS,
  automationProblems, cannotTurnOn, describeRunTime, describeWait, splitWait, triggerDef, triggerLabel, triggersFor,
  type ActionKey, type AutomationAction, type AutomationCond, type AutomationDef, type SequenceBlock, type SubAction, type TriggerKey, type TriggerUse,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "@/components/ui";

/**
 * Marketing → Automations, like Homeworks: Automations (one trigger, one action), Sequence
 * Automations (IF / OR / AND / ELSE blocks of timed actions, with Stop when), Sequence History,
 * Review, and Automation History. Messages come from Templates.
 */

export type Automation = {
  id: string; number: number; kind: "simple" | "sequence"; name: string; description: string | null; labels: string[]; enabled: boolean; review: boolean;
  def: AutomationDef; imported: string | null; problems: string[]; cannotTurnOn: string | null; deadBlocks: { index: number; why: string }[];
  counts: { running: number; review: number; done: number; skipped: number; lastAt: string | null };
};
type Options = {
  templates: { id: string; name: string; channel: "email" | "text"; audience: "customer" | "internal" }[];
  tags: { id: string; name: string; color: string }[];
  categories: { id: string; name: string }[];
  services: { id: string; name: string }[];
  employees: { id: string; name: string; owner: boolean }[];
  automations: { id: string; number: number; name: string; kind: string }[];
};
type Step = { id: string; kind: string; idx: number; action: AutomationAction; dueAt: string | null; status: string; detail: string | null; doneAt: string | null };
type Run = {
  id: string; status: string; reason: string | null; triggerKey: string; blockIndex: number | null; triggeredAt: string; createdAt: string; finishedAt: string | null;
  subjectType: string; subjectId: string | null; automation: { id: string; name: string; kind: string; number: number }; customer: { id: string; name: string } | null; steps: Step[];
};

const blankCond = (key = ""): AutomationCond => ({ key, tagIds: [], categoryIds: [], serviceIds: [] });
const blankAction = (action: ActionKey = "email_customer", waitMinutes = 0): AutomationAction => ({ waitMinutes, action, templateId: null, employeeIds: [], tagId: null, todoTitle: null });
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const STATUS_TONE: Record<string, string> = { done: "ok", running: "", waiting: "", review: "warn", skipped: "", stopped: "warn", failed: "bad" };
const actionLabel = (k: string) => AUTOMATION_ACTIONS[k as ActionKey]?.label ?? k;
const channelOf = (k: ActionKey): "email" | "text" | null => { const d = AUTOMATION_ACTIONS[k]; return "channel" in d ? d.channel : null; };

export function useAutomationOptions() {
  return useApi<Options>("/automations/options");
}

/* ───────────── Pickers ───────────── */

/** The triggers for a use, grouped like Homeworks' list; ones Crewdesk doesn't have are greyed out. */
function TriggerSelect({ value, onChange, use, label, required }: { value: string; onChange: (k: string) => void; use: TriggerUse; label: string; required?: boolean }) {
  const keys = triggersFor(use);
  return (
    <label>
      <span>{label}{required && <span className="req"> *</span>}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">--- Please select ---</option>
        {TRIGGER_GROUPS.map((g) => {
          const inGroup = keys.filter((k) => TRIGGERS[k].group === g);
          if (!inGroup.length) return null;
          return (
            <optgroup key={g} label={g}>
              {inGroup.map((k) => {
                const na = "na" in TRIGGERS[k] ? (TRIGGERS[k] as { na?: string }).na : undefined;
                return <option key={k} value={k} disabled={!!na && k !== value} title={na}>{triggerLabel(k, use)}{na ? " (not in Crewdesk yet)" : ""}</option>;
              })}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

/** Click to pick (tags, categories, services, people). */
function Toggles({ items, value, onChange, label, empty }: { items: { id: string; name: string; color?: string }[]; value: string[]; onChange: (v: string[]) => void; label: string; empty: ReactNode }) {
  return (
    <fieldset className="au-toggles">
      <legend>{label}</legend>
      {items.length ? items.map((t) => {
        const on = value.includes(t.id);
        return (
          <button key={t.id} type="button" aria-pressed={on} className={`tag ${t.color ? `tag-${t.color}` : "tag-gray"} tag-toggle ${on ? "on" : ""}`}
            onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}>{on ? "✓ " : ""}{t.name}</button>
        );
      }) : <span className="muted">{empty}</span>}
    </fieldset>
  );
}

/** What a trigger or condition needs picked: tags, to-do categories, services. */
function CondParams({ cond, onChange, o }: { cond: AutomationCond; onChange: (c: AutomationCond) => void; o: Options }) {
  const p = triggerDef(cond.key)?.param;
  if (p === "tags") return <Toggles label="Which tag (any of these)" items={o.tags} value={cond.tagIds} onChange={(tagIds) => onChange({ ...cond, tagIds })} empty={<>No tags yet (Settings → Customers).</>} />;
  if (p === "categories") return <Toggles label="Which category (any of these)" items={o.categories} value={cond.categoryIds} onChange={(categoryIds) => onChange({ ...cond, categoryIds })} empty="No to-do categories yet." />;
  if (p === "services") return <Toggles label="Which service (any of these)" items={o.services} value={cond.serviceIds} onChange={(serviceIds) => onChange({ ...cond, serviceIds })} empty="No services on the price list yet." />;
  return null;
}

function NaNote({ k, inSequence }: { k: string; inSequence?: boolean }) {
  const d = triggerDef(k);
  if (!d || !("na" in d) || !d.na) return null;
  return <p className="au-na">{d.na} {inSequence ? "This block won't run (the others still do)." : "It can be kept, but it can't be turned on."}</p>;
}

/** The templates for an action: customer ones first for customer actions, team ones first for the rest. */
function TemplateSelect({ action, value, onChange, o }: { action: ActionKey; value: string | null; onChange: (id: string | null) => void; o: Options }) {
  const d = AUTOMATION_ACTIONS[action];
  if (!("channel" in d)) return null;
  const list = o.templates.filter((t) => t.channel === d.channel);
  const first = d.to === "customer" ? "customer" : "internal";
  const groups = [[first, list.filter((t) => t.audience === first)], [first === "customer" ? "internal" : "customer", list.filter((t) => t.audience !== first)]] as const;
  const label = d.channel === "email" ? "Email template" : action === "push_notification" ? "Message (text template)" : "Text template";
  return (
    <label>
      <span>{label}<span className="req"> *</span></span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
        <option value="">--- Please select ---</option>
        {groups.map(([aud, items]) => items.length ? (
          <optgroup key={aud} label={aud === "customer" ? "To customers" : "To your team"}>
            {items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </optgroup>
        ) : null)}
      </select>
    </label>
  );
}

/** One action's details: template, people, tag or to-do title. */
function ActionFields({ act, onChange, o, keys }: { act: AutomationAction; onChange: (a: AutomationAction) => void; o: Options; keys: readonly ActionKey[] }) {
  const d = AUTOMATION_ACTIONS[act.action];
  return (
    <div className="au-fields">
      <label>
        <span>Action<span className="req"> *</span></span>
        <select value={act.action} onChange={(e) => onChange({ ...blankAction(e.target.value as ActionKey, act.waitMinutes), employeeIds: act.employeeIds })} aria-label="Action">
          {keys.map((k) => <option key={k} value={k}>{AUTOMATION_ACTIONS[k].label}</option>)}
        </select>
      </label>
      <TemplateSelect action={act.action} value={act.templateId} onChange={(templateId) => onChange({ ...act, templateId })} o={o} />
      {d.to === "employee" && (
        <Toggles label={act.action === "push_notification" ? "Who (none picked: the owner)" : "Employee"} items={o.employees} value={act.employeeIds} onChange={(employeeIds) => onChange({ ...act, employeeIds })} empty="No employees." />
      )}
      {"needs" in d && d.needs === "tag" && (
        <label>
          <span>Tag<span className="req"> *</span></span>
          <select value={act.tagId ?? ""} onChange={(e) => onChange({ ...act, tagId: e.target.value || null })} aria-label="Tag">
            <option value="">--- Please select ---</option>
            {o.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      {"needs" in d && d.needs === "todo" && (
        <label>
          <span>To-do title<span className="req"> *</span></span>
          <input value={act.todoTitle ?? ""} maxLength={200} placeholder="Call {{CUSTOMER_NAME}} about estimate {{ESTIMATE_NUMBER}}" onChange={(e) => onChange({ ...act, todoTitle: e.target.value })} />
        </label>
      )}
    </div>
  );
}

/** Homeworks' waiting period: Instantly, or after days, hours and minutes (from the trigger). */
function WaitInput({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const w = splitWait(minutes);
  const [after, setAfter] = useState(minutes > 0);
  const set = (p: Partial<typeof w>) => { const n = { ...w, ...p }; onChange(Math.max(0, n.days) * 1440 + Math.max(0, n.hours) * 60 + Math.max(0, n.minutes)); };
  const name = useRef(`wait-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div className="au-wait">
      <span className="au-wait-label"><span>Waiting period<span className="req"> *</span></span></span>
      <div className="row" style={{ gap: 12 }}>
        <label className="check"><input type="radio" name={name} checked={!after} onChange={() => { setAfter(false); onChange(0); }} /> Instantly</label>
        <label className="check"><input type="radio" name={name} checked={after} onChange={() => { setAfter(true); if (!minutes) onChange(1440); }} /> After</label>
      </div>
      {after && (
        <div className="au-wait-row">
          <span className="au-unit"><input type="number" min={0} max={366} value={w.days} onChange={(e) => set({ days: Number(e.target.value) || 0 })} aria-label="Days" /><b>Days</b></span>
          <span className="au-unit"><input type="number" min={0} max={23} value={w.hours} onChange={(e) => set({ hours: Number(e.target.value) || 0 })} aria-label="Hours" /><b>Hrs</b></span>
          <span className="au-unit"><input type="number" min={0} max={59} value={w.minutes} onChange={(e) => set({ minutes: Number(e.target.value) || 0 })} aria-label="Minutes" /><b>Min</b></span>
        </div>
      )}
    </div>
  );
}

/* ───────────── Shared bits ───────────── */

function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <div className="au-problems" role="alert"><strong>Before it can be saved:</strong><ul>{list.map((p) => <li key={p}>{p}</li>)}</ul></div>;
}

function TextHours() {
  return <div className="au-notice">Texts are sent only between <strong>9:00 AM</strong> and <strong>6:00 PM</strong>. One that comes due at night waits until 9 AM.</div>;
}

function Labels({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => { const t = draft.trim().replace(/,$/, ""); if (t && !value.includes(t)) onChange([...value, t].slice(0, 20)); setDraft(""); };
  return (
    <label>
      Labels (to find it later)
      <div className="au-labels">
        {value.map((l) => <span key={l} className="tag tag-gray">{l} <button type="button" className="au-x" aria-label={`Remove ${l}`} onClick={() => onChange(value.filter((x) => x !== l))}>×</button></span>)}
        <input value={draft} placeholder="Add a label" maxLength={40} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} onBlur={add} />
      </div>
    </label>
  );
}

function OnOff({ a, onChanged, admin }: { a: Automation; onChanged: () => void; admin: boolean }) {
  const { busy, error, run } = useAction();
  const blocked = !a.enabled && (a.cannotTurnOn || a.problems[0]);
  return (
    <>
      <label className="switch" title={blocked ? String(blocked) : a.enabled ? "On" : "Off"}>
        <input type="checkbox" checked={a.enabled} disabled={!admin || busy || !!blocked} aria-label={`${a.name} on`}
          onChange={(e) => {
            const on = e.target.checked;
            if (!on && (a.counts.running || a.counts.review) && !confirm(`Turn off "${a.name}"? What's still waiting for ${a.counts.running} customer${a.counts.running === 1 ? "" : "s"} won't happen.`)) return;
            if (on && a.imported && !confirm(`Turn on "${a.name}"? It starts for things that happen from now on, and will message real customers.`)) return;
            run(async () => { await api(`/automations/${a.id}/enabled`, { body: { enabled: on } }); onChanged(); });
          }} />
        <span>{a.enabled ? "On" : "Off"}</span>
      </label>
      {error && <div className="au-err">{error}</div>}
    </>
  );
}

/* ───────────── Automations (simple) ───────────── */

type SimpleForm = Extract<AutomationDef, { kind: "simple" }> & { name: string; description: string | null; labels: string[]; enabled: boolean; review: boolean };

function simpleSummary(a: Automation, o: Options | null) {
  if (a.def.kind !== "simple") return { trigger: "", runTime: "", action: "", sub: "" };
  const d = a.def;
  const tagNames = d.trigger.tagIds.map((id) => o?.tags.find((t) => t.id === id)?.name).filter(Boolean);
  const next = d.subAction === "run_automation" ? o?.automations.find((x) => x.id === d.subAutomationId) : null;
  return {
    trigger: `${triggerLabel(d.trigger.key, "simple")}${tagNames.length ? `: ${tagNames.join(", ")}` : ""}`,
    runTime: describeRunTime(d),
    action: actionLabel(d.action.action),
    sub: d.subAction === "run_automation" ? `Run ${next ? `#${next.number} ${next.name}` : "another automation"}${d.subDelayMinutes ? ` (${describeWait(d.subDelayMinutes).toLowerCase()})` : ""}` : d.subAction === "stop_automation" ? "Stop automation" : "Nothing",
  };
}

export function AutomationList({ kind }: { kind: "simple" | "sequence" }) {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const list = useApi<{ review: number; automations: Automation[] }>("/automations");
  const opts = useAutomationOptions();
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [q, setQ] = useState("");
  const [fTrigger, setFTrigger] = useState("");
  const [fAction, setFAction] = useState("");
  const [fStatus, setFStatus] = useState("");
  const { busy, error, run } = useAction();
  const rows = (list.data?.automations ?? []).filter((a) => a.kind === kind);
  const shown = rows.filter((a) => {
    if (fStatus && (fStatus === "on") !== a.enabled) return false;
    if (q && !`${a.number} ${a.name} ${a.description ?? ""} ${a.labels.join(" ")}`.toLowerCase().includes(q.toLowerCase())) return false;
    const trig = a.def.kind === "simple" ? [a.def.trigger.key] : a.def.blocks.flatMap((b) => [b.trigger.key, ...b.or.map((x) => x.key)]);
    if (fTrigger && !trig.includes(fTrigger)) return false;
    const acts = a.def.kind === "simple" ? [a.def.action.action] : a.def.blocks.flatMap((b) => b.actions.map((x) => x.action));
    if (fAction && !acts.includes(fAction as ActionKey)) return false;
    return true;
  });
  if (editing && opts.data) {
    const close = () => { setEditing(null); list.reload(); opts.reload(); };
    return kind === "simple"
      ? <SimpleEditor automation={editing === "new" ? null : editing} o={opts.data} onDone={close} />
      : <SequenceEditor automation={editing === "new" ? null : editing} o={opts.data} onDone={close} />;
  }
  const o = opts.data;
  const usedTriggers = [...new Set(rows.flatMap((a) => (a.def.kind === "simple" ? [a.def.trigger.key] : a.def.blocks.flatMap((b) => [b.trigger.key, ...b.or.map((x) => x.key)]))))];
  return (
    <div className="stack" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="au-filters">
        {admin && <button className="btn primary" onClick={() => setEditing("new")}>{kind === "simple" ? "New automation" : "New sequence"}</button>}
        <input type="search" placeholder={kind === "simple" ? "Find an automation" : "Find a sequence"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find" />
        <select value={fTrigger} onChange={(e) => setFTrigger(e.target.value)} aria-label="Trigger">
          <option value="">Any trigger</option>
          {usedTriggers.map((k) => <option key={k} value={k}>{triggerLabel(k)}</option>)}
        </select>
        <select value={fAction} onChange={(e) => setFAction(e.target.value)} aria-label="Action">
          <option value="">Any action</option>
          {ACTION_KEYS.map((k) => <option key={k} value={k}>{AUTOMATION_ACTIONS[k].label}</option>)}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Status">
          <option value="">On and off</option><option value="on">On</option><option value="off">Off</option>
        </select>
        <span className="muted" style={{ fontSize: 13 }}>{shown.length} of {rows.length}</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {kind === "simple"
          ? "When the trigger happens, at the run time, it does the action. It only starts for things that happen after it's turned on."
          : "IF the trigger happens (and the AND conditions are true), the actions run at their times. ELSE blocks catch other triggers. It stops for a customer when a Stop when happens."}
      </p>
      <ErrorBox error={list.error ?? error} />
      <div className="card" style={{ padding: 0 }}>
        {shown.length ? (
          <div className="tablewrap">
            <table className="au-table">
              <thead>
                {kind === "simple"
                  ? <tr><th>Id</th><th>On / Off</th><th>Automation name</th><th>Trigger</th><th>Run time</th><th>Action</th><th>Sub action</th><th>Review</th><th>Notes</th><th>Labels</th><th /></tr>
                  : <tr><th>Id</th><th>On / Off</th><th>Title</th><th>Triggers</th><th>Actions</th><th>Stop when</th><th>Review</th><th>Running</th><th /></tr>}
              </thead>
              <tbody>
                {shown.map((a) => {
                  const s = simpleSummary(a, o);
                  const flags = (
                    <>
                      {a.imported === "homeworks" && <span className="badge" title="Imported from Homeworks">Homeworks</span>}
                      {a.problems.length > 0 && <span className="badge bad" title={a.problems.join("\n")}>Needs attention</span>}
                      {a.cannotTurnOn && <span className="badge warn" title={a.cannotTurnOn}>Can&apos;t run in Crewdesk</span>}
                      {!a.cannotTurnOn && a.deadBlocks?.length > 0 && <span className="badge warn" title={a.deadBlocks.map((b) => `Block ${b.index + 1}: ${b.why}`).join("\n")}>{a.deadBlocks.length} block{a.deadBlocks.length === 1 ? "" : "s"} won&apos;t run</span>}
                      {a.counts.review > 0 && <Link href="/automations?tab=review" className="badge warn">{a.counts.review} in review</Link>}
                    </>
                  );
                  const buttons = admin && (
                    <td className="au-row-actions">
                      <button className="btn sm" onClick={() => setEditing(a)}>Edit</button>
                      <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api(`/automations/${a.id}/clone`, { method: "POST" }); list.reload(); opts.reload(); })}>Clone</button>
                      <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Delete "${a.name}"? Its history goes too.`) && run(async () => { await api(`/automations/${a.id}`, { method: "DELETE" }); list.reload(); opts.reload(); })}>Delete</button>
                    </td>
                  );
                  if (kind === "simple") return (
                    <tr key={a.id}>
                      <td className="muted">{a.number}</td>
                      <td><OnOff a={a} admin={admin} onChanged={list.reload} /></td>
                      <td><strong>{a.name}</strong><div className="au-flags">{flags}</div></td>
                      <td>{s.trigger}</td>
                      <td>{s.runTime}</td>
                      <td>{s.action}</td>
                      <td>{s.sub}</td>
                      <td>{a.review ? "Yes" : "No"}</td>
                      <td className="au-notes">{a.description}</td>
                      <td>{a.labels.map((l) => <span key={l} className="tag tag-gray">{l}</span>)}</td>
                      {buttons}
                    </tr>
                  );
                  const d = a.def as Extract<AutomationDef, { kind: "sequence" }>;
                  return (
                    <tr key={a.id}>
                      <td className="muted">{a.number}</td>
                      <td><OnOff a={a} admin={admin} onChanged={list.reload} /></td>
                      <td><strong>{a.name}</strong>{a.description && <div className="au-notes">{a.description}</div>}<div className="au-flags">{flags}</div></td>
                      <td>{d.blocks.map((b, i) => <div key={i}><span className="muted">{i ? "ELSE " : "IF "}</span>{[b.trigger, ...b.or].map((c) => triggerLabel(c.key)).join(" or ")}{b.and.length ? <span className="muted"> + {b.and.length} condition{b.and.length === 1 ? "" : "s"}</span> : null}</div>)}</td>
                      <td>{d.blocks.reduce((n, b) => n + b.actions.length, 0)}</td>
                      <td>{d.stops.length ? d.stops.map((c) => triggerLabel(c.key, "stop")).join("; ") : <span className="muted">—</span>}</td>
                      <td>{a.review ? "Yes" : "No"}</td>
                      <td>{a.counts.running}</td>
                      {buttons}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted" style={{ padding: 16, margin: 0 }}>{list.loading ? "Loading…" : rows.length ? "None match." : kind === "simple" ? "No automations yet." : "No sequences yet."}</p>}
      </div>
    </div>
  );
}

function SimpleEditor({ automation, o, onDone }: { automation: Automation | null; o: Options; onDone: () => void }) {
  const start: SimpleForm = automation && automation.def.kind === "simple"
    ? { ...automation.def, name: automation.name, description: automation.description, labels: automation.labels, enabled: automation.enabled, review: automation.review }
    : { kind: "simple", name: "", description: null, labels: [], enabled: false, review: false, trigger: blankCond(), runAt: null, delayMinutes: 0, daysBefore: null, action: blankAction(), subAction: "none", subAutomationId: null, subDelayMinutes: 0 };
  const [f, setF] = useState<SimpleForm>(start);
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useAction();
  const set = (p: Partial<SimpleForm>) => setF({ ...f, ...p });
  const d = triggerDef(f.trigger.key);
  const problems = f.trigger.key ? automationProblems(f) : ["Choose the trigger"];
  if (!f.name.trim()) problems.unshift("Name it");
  const save = () => {
    setTried(true);
    if (problems.length) return;
    run(async () => {
      await api(automation ? `/automations/${automation.id}` : "/automations", { method: automation ? "PUT" : "POST", body: f });
      onDone();
    });
  };
  return (
    <div className="card au-form">
      <h2 style={{ margin: 0 }}>{automation ? `Edit automation #${automation.number}` : "New automation"}</h2>
      <label><span>Automation name<span className="req"> *</span></span><input value={f.name} maxLength={150} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
      <TriggerSelect use="simple" label="Trigger condition" required value={f.trigger.key}
        onChange={(key) => { const nd = triggerDef(key); set({ trigger: blankCond(key), daysBefore: nd?.before ? nd.before[0] : null, runAt: null, delayMinutes: 0 }); }} />
      <NaNote k={f.trigger.key} />
      <CondParams cond={f.trigger} o={o} onChange={(trigger) => set({ trigger })} />
      {d?.param === "datetime" && (
        <div className="row">
          <label><span>Date<span className="req"> *</span></span><input type="date" value={f.runAt?.slice(0, 10) ?? ""} onChange={(e) => set({ runAt: e.target.value ? `${e.target.value}T${f.runAt?.slice(11) || "09:00"}` : null })} /></label>
          <label><span>Time<span className="req"> *</span></span><input type="time" value={f.runAt?.slice(11) ?? "09:00"} onChange={(e) => set({ runAt: f.runAt ? `${f.runAt.slice(0, 10)}T${e.target.value}` : null })} /></label>
        </div>
      )}
      {f.trigger.key && d?.param !== "datetime" && (
        <label>
          <span>Run time<span className="req"> *</span></span>
          {d?.before ? (
            <select value={f.daysBefore ?? ""} onChange={(e) => set({ daysBefore: Number(e.target.value) || null })} aria-label="Run time">
              {d.before.map((n) => <option key={n} value={n}>{n} day{n === 1 ? "" : "s"} before (at 9 AM)</option>)}
            </select>
          ) : (
            <select value={f.delayMinutes} onChange={(e) => set({ delayMinutes: Number(e.target.value) })} aria-label="Run time">
              {RUN_TIMES.map((r) => <option key={r.minutes} value={r.minutes}>{r.label}</option>)}
              {!RUN_TIMES.some((r) => r.minutes === f.delayMinutes) && <option value={f.delayMinutes}>{describeWait(f.delayMinutes)}</option>}
            </select>
          )}
        </label>
      )}
      <ActionFields act={f.action} o={o} keys={SIMPLE_ACTION_KEYS} onChange={(action) => set({ action })} />
      {channelOf(f.action.action) === "text" && f.action.action !== "push_notification" && <TextHours />}
      <div className="row">
        <label>
          Sub action
          <select value={f.subAction} onChange={(e) => set({ subAction: e.target.value as SubAction })} aria-label="Sub action">
            {(Object.keys(SUB_ACTIONS) as SubAction[]).map((k) => <option key={k} value={k}>{SUB_ACTIONS[k]}</option>)}
          </select>
        </label>
        {f.subAction === "run_automation" && (
          <>
            <label>
              <span>Automation<span className="req"> *</span></span>
              <select value={f.subAutomationId ?? ""} onChange={(e) => set({ subAutomationId: e.target.value || null })} aria-label="Automation to run">
                <option value="">--- Please select ---</option>
                {o.automations.filter((x) => x.kind === "simple" && x.id !== automation?.id).map((x) => <option key={x.id} value={x.id}>#{x.number} {x.name}</option>)}
              </select>
            </label>
            <label>
              When
              <select value={f.subDelayMinutes} onChange={(e) => set({ subDelayMinutes: Number(e.target.value) })} aria-label="When to run it">
                {RUN_TIMES.map((r) => <option key={r.minutes} value={r.minutes}>{r.label}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      <label className="check"><input type="checkbox" checked={f.review} onChange={(e) => set({ review: e.target.checked })} /> Review before execution <span className="muted">(each time, it waits in Review until someone sends it)</span></label>
      <label>Notes / description<textarea rows={3} maxLength={2000} value={f.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} /></label>
      <Labels value={f.labels} onChange={(labels) => set({ labels })} />
      <label className="check"><input type="checkbox" checked={f.enabled} disabled={!!d && "na" in d && !!d.na} onChange={(e) => set({ enabled: e.target.checked })} /> On <span className="muted">(starts for things that happen after it&apos;s turned on)</span></label>
      {tried && <Problems list={problems} />}
      <ErrorBox error={error} />
      <div className="au-foot">
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{automation ? "Update automation" : "Add automation"}</button>
      </div>
    </div>
  );
}

/* ───────────── Sequences ───────────── */

type SeqForm = Extract<AutomationDef, { kind: "sequence" }> & { name: string; description: string | null; labels: string[]; enabled: boolean; review: boolean };

function CondRow({ pill, cond, onChange, onRemove, use, o, label }: { pill: string; cond: AutomationCond; onChange: (c: AutomationCond) => void; onRemove?: () => void; use: TriggerUse; o: Options; label: string }) {
  return (
    <div className="au-cond">
      <span className={`au-pill ${pill.toLowerCase().replace(/\s.*/, "")}`}>{pill}</span>
      <div className="au-cond-body">
        <TriggerSelect use={use} label={label} required value={cond.key} onChange={(key) => onChange(blankCond(key))} />
        <NaNote k={cond.key} inSequence />
        <CondParams cond={cond} onChange={onChange} o={o} />
      </div>
      {onRemove && <button type="button" className="btn sm" aria-label="Remove" onClick={onRemove}>Remove</button>}
    </div>
  );
}

function ActionRow({ act, onChange, onRemove, o, timed }: { act: AutomationAction; onChange: (a: AutomationAction) => void; onRemove: () => void; o: Options; timed: boolean }) {
  return (
    <div className={`au-action ${timed ? "" : "untimed"}`}>
      {timed && <WaitInput minutes={act.waitMinutes} onChange={(waitMinutes) => onChange({ ...act, waitMinutes })} />}
      <ActionFields act={act} o={o} keys={ACTION_KEYS} onChange={(a) => onChange({ ...a, waitMinutes: act.waitMinutes })} />
      <button type="button" className="btn sm" onClick={onRemove}>Remove</button>
    </div>
  );
}

function SequenceEditor({ automation, o, onDone }: { automation: Automation | null; o: Options; onDone: () => void }) {
  const start: SeqForm = automation && automation.def.kind === "sequence"
    ? { ...automation.def, name: automation.name, description: automation.description, labels: automation.labels, enabled: automation.enabled, review: automation.review }
    : { kind: "sequence", name: "", description: null, labels: [], enabled: false, review: false, blocks: [{ trigger: blankCond(), or: [], and: [], actions: [blankAction()] }], stops: [], stopActions: [] };
  const [f, setF] = useState<SeqForm>(start);
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useAction();
  const set = (p: Partial<SeqForm>) => setF({ ...f, ...p });
  const setBlock = (i: number, p: Partial<SequenceBlock>) => set({ blocks: f.blocks.map((b, j) => (j === i ? { ...b, ...p } : b)) });
  const blank = [...f.blocks.flatMap((b) => [b.trigger, ...b.or, ...b.and]), ...f.stops].some((c) => !c.key);
  const problems = blank ? ["Choose every trigger and condition (or remove the empty ones)"] : automationProblems(f);
  if (!f.name.trim()) problems.unshift("Give it a title");
  const hasText = [...f.blocks.flatMap((b) => b.actions), ...f.stopActions].some((x) => channelOf(x.action) === "text" && x.action !== "push_notification");
  const save = () => {
    setTried(true);
    if (problems.length) return;
    run(async () => {
      await api(automation ? `/automations/${automation.id}` : "/automations", { method: automation ? "PUT" : "POST", body: f });
      onDone();
    });
  };
  return (
    <div className="card au-form au-seq">
      <h2 style={{ margin: 0 }}>{automation ? `Edit sequence #${automation.number}` : "New sequence"}</h2>
      <div className="au-two">
        <label><span>Sequence title<span className="req"> *</span></span><input value={f.name} maxLength={150} onChange={(e) => set({ name: e.target.value })} autoFocus /></label>
        <label>Sequence description<textarea rows={2} maxLength={2000} value={f.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={f.review} onChange={(e) => set({ review: e.target.checked })} /> Review before execution <span className="muted">(every action in this sequence waits in Review until someone sends it)</span></label>
      {hasText && <TextHours />}
      <div className="au-blocks">
        {f.blocks.map((b, i) => (
          <section key={i} className="au-block" aria-label={i ? `Else block ${i}` : "If block"}>
            <CondRow pill={i ? "ELSE IF" : "IF"} label={i ? "ELSE trigger" : "IF trigger"} use="if" cond={b.trigger} o={o} onChange={(trigger) => setBlock(i, { trigger })} onRemove={i ? () => set({ blocks: f.blocks.filter((_, j) => j !== i) }) : undefined} />
            {b.or.map((c, j) => (
              <CondRow key={`or${j}`} pill="OR" label="OR when" use="if" cond={c} o={o} onChange={(nc) => setBlock(i, { or: b.or.map((x, k) => (k === j ? nc : x)) })} onRemove={() => setBlock(i, { or: b.or.filter((_, k) => k !== j) })} />
            ))}
            {b.and.map((c, j) => (
              <CondRow key={`and${j}`} pill="AND" label="AND" use="and" cond={c} o={o} onChange={(nc) => setBlock(i, { and: b.and.map((x, k) => (k === j ? nc : x)) })} onRemove={() => setBlock(i, { and: b.and.filter((_, k) => k !== j) })} />
            ))}
            {b.actions.map((x, j) => (
              <ActionRow key={`a${j}`} act={x} o={o} timed onChange={(nx) => setBlock(i, { actions: b.actions.map((y, k) => (k === j ? nx : y)) })} onRemove={() => setBlock(i, { actions: b.actions.filter((_, k) => k !== j) })} />
            ))}
            <div className="row">
              <button type="button" className="btn sm au-and" onClick={() => setBlock(i, { and: [...b.and, blankCond()] })}>AND condition</button>
              <button type="button" className="btn sm au-or" onClick={() => setBlock(i, { or: [...b.or, blankCond()] })}>OR condition</button>
              <button type="button" className="btn sm au-act" onClick={() => setBlock(i, { actions: [...b.actions, blankAction("email_customer", b.actions[b.actions.length - 1]?.waitMinutes ?? 0)] })}>Action</button>
            </div>
          </section>
        ))}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn au-else" disabled={f.blocks.length >= 10} onClick={() => set({ blocks: [...f.blocks, { trigger: blankCond(), or: [], and: [], actions: [blankAction()] }] })}>ELSE trigger</button>
        </div>
        <section className="au-block au-stop" aria-label="Stop when">
          <strong>Stop when</strong>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>For that customer, what&apos;s still waiting stops when any of these happens; then the stop actions run.</p>
          {f.stops.map((c, j) => (
            <CondRow key={`s${j}`} pill={j ? "OR" : "STOP"} label="when" use="stop" cond={c} o={o} onChange={(nc) => set({ stops: f.stops.map((x, k) => (k === j ? nc : x)) })} onRemove={() => set({ stops: f.stops.filter((_, k) => k !== j) })} />
          ))}
          {f.stopActions.map((x, j) => (
            <ActionRow key={`sa${j}`} act={x} o={o} timed={false} onChange={(nx) => set({ stopActions: f.stopActions.map((y, k) => (k === j ? nx : y)) })} onRemove={() => set({ stopActions: f.stopActions.filter((_, k) => k !== j) })} />
          ))}
          <div className="row">
            <button type="button" className="btn sm au-or" onClick={() => set({ stops: [...f.stops, blankCond()] })}>{f.stops.length ? "OR stop condition" : "Stop condition"}</button>
            <button type="button" className="btn sm au-act" disabled={!f.stops.length} onClick={() => set({ stopActions: [...f.stopActions, blankAction("email_admin")] })}>Stop action</button>
          </div>
        </section>
      </div>
      <Labels value={f.labels} onChange={(labels) => set({ labels })} />
      <label className="check"><input type="checkbox" checked={f.enabled} disabled={!blank && !!cannotTurnOn(f) && !f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> On <span className="muted">(starts for things that happen after it&apos;s turned on; changes apply to new runs)</span></label>
      {tried && <Problems list={problems} />}
      <ErrorBox error={error} />
      <div className="au-foot">
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{automation ? "Update sequence" : "Add sequence"}</button>
      </div>
    </div>
  );
}

/* ───────────── Review ───────────── */

type ReviewItem = {
  id: string; kind: string; action: AutomationAction; actionLabel: string; createdAt: string; triggeredAt: string; triggerKey: string;
  automation: { id: string; name: string; kind: string; number: number }; customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  preview: { channel: "email" | "text"; subject: string | null; body: string } | null;
};

export function ReviewTab() {
  const list = useApi<ReviewItem[]>("/automations/review/list");
  const { busy, error, run } = useAction();
  const decide = (id: string, decision: "send" | "skip" | "stop") => run(async () => { await api(`/automations/steps/${id}/review`, { body: { decision } }); list.reload(); });
  const rows = list.data ?? [];
  return (
    <div className="stack" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Automations and sequences set to &quot;Review before execution&quot; wait here. Send it (texts at night go at 9 AM), skip just this one, or stop the rest for that customer.</p>
      <ErrorBox error={list.error ?? error} />
      {!rows.length && <div className="card"><Empty>{list.loading ? "Loading…" : "Nothing is waiting for review."}</Empty></div>}
      {rows.map((r) => (
        <div key={r.id} className="card au-review">
          <div className="au-review-head">
            <div>
              <strong>{r.actionLabel}</strong>
              {r.customer && <> · <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link></>}
              <div className="muted" style={{ fontSize: 13 }}>
                {r.automation.kind === "sequence" ? "Sequence" : "Automation"} #{r.automation.number} {r.automation.name} · {triggerLabel(r.triggerKey)} {when(r.triggeredAt)}{r.kind === "stop" ? " · stop action" : ""}
              </div>
            </div>
            <div className="row">
              <button className="btn primary sm" disabled={busy} onClick={() => decide(r.id, "send")}>Send now</button>
              <button className="btn sm" disabled={busy} onClick={() => decide(r.id, "skip")}>Skip</button>
              {r.kind === "action" && <button className="btn sm danger" disabled={busy} onClick={() => confirm("Stop the rest of this for them?") && decide(r.id, "stop")}>Stop for this customer</button>}
            </div>
          </div>
          {r.preview && (r.preview.channel === "email" ? (
            <div className="au-preview">
              <div className="tpl-subject"><span className="muted">Subject:</span> {r.preview.subject}</div>
              <iframe className="au-frame" sandbox="" title={`Preview for ${r.customer?.name ?? "the team"}`} srcDoc={`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;margin:12px">${r.preview.body}</body>`} />
            </div>
          ) : <div className="tpl-bubble">{r.preview.body}</div>)}
        </div>
      ))}
    </div>
  );
}

/* ───────────── History ───────────── */

/** Sequence History (or a customer's runs): each run with its actions. */
export function RunHistory({ customerId, kind }: { customerId?: string; kind?: "simple" | "sequence" }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [skipped, setSkipped] = useState(false);
  const [more, setMore] = useState<Run[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(kind ? { kind } : {}), ...(customerId ? { customerId } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}), ...(skipped ? { skipped: "1" } : {}) }).toString();
  const list = useApi<{ runs: Run[]; more: string | null }>(`/automations/runs?${qs}`);
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const rows = [...(list.data?.runs ?? []), ...more.filter((m) => !list.data?.runs.some((r) => r.id === m.id))];
  const next = cursor ?? list.data?.more ?? null;
  const loadMore = () => run(async () => {
    const r = await api<{ runs: Run[]; more: string | null }>(`/automations/runs?${qs}&before=${encodeURIComponent(next!)}`);
    setMore([...more, ...r.runs]); setCursor(r.more ?? "");
  });
  return (
    <div className="stack" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="au-filters">
        {!customerId && <input type="search" placeholder="Find by name or customer" value={q} onChange={(e) => { setQ(e.target.value); setMore([]); setCursor(null); }} aria-label="Find" />}
        <select value={status} onChange={(e) => { setStatus(e.target.value); setMore([]); setCursor(null); }} aria-label="Status">
          <option value="">Any status</option><option value="running">Running</option><option value="done">Done</option><option value="stopped">Stopped</option><option value="skipped">Skipped</option>
        </select>
        <label className="check"><input type="checkbox" checked={skipped} onChange={(e) => { setSkipped(e.target.checked); setMore([]); setCursor(null); }} /> Show skipped</label>
      </div>
      <ErrorBox error={list.error ?? error} />
      <div className="card" style={{ padding: 0 }}>
        {rows.length ? (
          <div className="tablewrap">
            <table className="au-table">
              <thead><tr><th>Date</th><th>{kind === "simple" ? "Automation" : kind === "sequence" ? "Sequence" : "Automation"}</th>{!customerId && <th>Customer</th>}<th>Trigger</th><th>Status</th><th>Actions</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const done = r.steps.filter((s) => !["waiting", "review"].includes(s.status)).length;
                  const nextStep = r.steps.find((s) => s.status === "waiting" || s.status === "review");
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td style={{ whiteSpace: "nowrap" }}>{when(r.createdAt)}</td>
                        <td>#{r.automation.number} {r.automation.name}{r.blockIndex ? <span className="muted"> (ELSE {r.blockIndex})</span> : null}</td>
                        {!customerId && <td>{r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : <span className="muted">—</span>}</td>}
                        <td>{triggerLabel(r.triggerKey)}</td>
                        <td><span className={`badge ${STATUS_TONE[r.status] ?? ""}`}>{r.status}</span>{r.reason && <div className="muted" style={{ fontSize: 12 }}>{r.reason}</div>}</td>
                        <td>{r.steps.length ? `${done} of ${r.steps.filter((s) => s.kind === "action").length}` : "—"}{nextStep && <div className="muted" style={{ fontSize: 12 }}>Next: {actionLabel(nextStep.action.action)} {nextStep.status === "review" ? "(in review)" : nextStep.dueAt ? when(nextStep.dueAt) : ""}</div>}</td>
                        <td className="au-row-actions">
                          {r.steps.length > 0 && <button className="btn sm" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{open === r.id ? "Hide" : "Details"}</button>}
                          {r.status === "running" && <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Stop "${r.automation.name}"${r.customer ? ` for ${r.customer.name}` : ""}? What's still waiting won't happen.`) && run(async () => { await api(`/automations/runs/${r.id}/stop`, { method: "POST" }); list.reload(); })}>Stop</button>}
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr key={`${r.id}-steps`} className="au-steps-row">
                          <td colSpan={customerId ? 6 : 7}>
                            <ol className="au-steps">
                              {r.steps.map((s) => (
                                <li key={s.id}>
                                  <span className={`badge ${STATUS_TONE[s.status] ?? ""}`}>{s.status}</span>
                                  <strong>{s.kind === "stop" ? "Stop action: " : ""}{actionLabel(s.action.action)}</strong>
                                  <span className="muted">{s.doneAt ? when(s.doneAt) : s.dueAt ? `due ${when(s.dueAt)}` : ""}</span>
                                  {s.detail && <span>{s.detail}</span>}
                                </li>
                              ))}
                            </ol>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted" style={{ padding: 16, margin: 0 }}>{list.loading ? "Loading…" : "Nothing has run yet."}</p>}
      </div>
      {next && <button className="btn" disabled={busy} onClick={loadMore} style={{ justifySelf: "start" }}>Load more</button>}
    </div>
  );
}

type HistoryRow = { id: string; at: string; status: string; detail: string | null; kind: string; action: string; triggerKey: string; automation: { id: string; name: string; kind: string; number: number }; customer: { id: string; name: string } | null };

/** Automation History: each action that was done, skipped or failed. */
export function ActionHistory({ kind }: { kind?: "simple" | "sequence" }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [more, setMore] = useState<HistoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}) }).toString();
  const list = useApi<{ rows: HistoryRow[]; more: string | null }>(`/automations/history?${qs}`);
  const { busy, error, run } = useAction();
  const rows = [...(list.data?.rows ?? []), ...more.filter((m) => !list.data?.rows.some((r) => r.id === m.id))];
  const next = cursor ?? list.data?.more ?? null;
  return (
    <div className="stack" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="au-filters">
        <input type="search" placeholder="Find by automation or message" value={q} onChange={(e) => { setQ(e.target.value); setMore([]); setCursor(null); }} aria-label="Find" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setMore([]); setCursor(null); }} aria-label="Status">
          <option value="">Done, skipped and failed</option><option value="done">Done</option><option value="skipped">Skipped</option><option value="failed">Failed</option>
        </select>
      </div>
      <ErrorBox error={list.error ?? error} />
      <div className="card" style={{ padding: 0 }}>
        {rows.length ? (
          <div className="tablewrap">
            <table className="au-table">
              <thead><tr><th>Date</th><th>Automation</th><th>Trigger condition</th><th>Action</th><th>Customer</th><th>Status message</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                  <td>#{r.automation.number} {r.automation.name}</td>
                  <td>{triggerLabel(r.triggerKey)}</td>
                  <td>{r.kind === "stop" ? "Stop action: " : ""}{actionLabel(r.action)}</td>
                  <td>{r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : <span className="muted">—</span>}</td>
                  <td><span className={`badge ${STATUS_TONE[r.status] ?? ""}`}>{r.status}</span> {r.detail}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="muted" style={{ padding: 16, margin: 0 }}>{list.loading ? "Loading…" : "Nothing has run yet."}</p>}
      </div>
      {next && <button className="btn" disabled={busy} style={{ justifySelf: "start" }} onClick={() => run(async () => {
        const r = await api<{ rows: HistoryRow[]; more: string | null }>(`/automations/history?${qs}&before=${encodeURIComponent(next)}`);
        setMore([...more, ...r.rows]); setCursor(r.more ?? "");
      })}>Load more</button>}
    </div>
  );
}

/* ───────────── A customer's automations ───────────── */

export function CustomerAutomations({ customerId, name }: { customerId: string; name: string }) {
  const list = useApi<{ automations: { id: string; number: number; kind: string; name: string; enabled: boolean; trigger: string | null; off: boolean }[] }>(`/automations/customer/${customerId}`);
  const { busy, error, run } = useAction();
  const [showAll, setShowAll] = useState(false);
  const rows = (list.data?.automations ?? []).filter((a) => showAll || a.enabled || a.off);
  return (
    <div className="stack" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>Automations for {name}</strong>
          <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show ones that are off for everyone</label>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>Turn one off to keep it from running for {name}. <Link href="/automations">Set up automations</Link></p>
        <ErrorBox error={list.error ?? error} />
        {rows.length ? (
          <ul className="au-cust">
            {rows.map((a) => (
              <li key={a.id}>
                <label className="switch">
                  <input type="checkbox" checked={!a.off} disabled={busy} aria-label={`${a.name} for ${name}`}
                    onChange={(e) => run(async () => { await api(`/automations/customer/${customerId}/${a.id}`, { method: "PUT", body: { on: e.target.checked } }); list.reload(); })} />
                  <span>{a.off ? "Off for them" : "On"}</span>
                </label>
                <span><strong>#{a.number} {a.name}</strong> <span className="muted">· {a.kind === "sequence" ? "Sequence" : "Automation"}{a.trigger ? ` · ${triggerLabel(a.trigger)}` : ""}{a.enabled ? "" : " · off for everyone"}</span></span>
              </li>
            ))}
          </ul>
        ) : <Empty>{list.loading ? "Loading…" : "No automations are on."}</Empty>}
      </div>
      <RunHistory customerId={customerId} />
    </div>
  );
}

/* ───────────── Homeworks import ───────────── */

export function ImportAutomations({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ added: number; already: number; notes: string[]; tagsMade: number; missingTemplates: number } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <>
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}>Import from Homeworks</button>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        run(async () => {
          const body = JSON.parse(await file.text());
          setResult(await api("/automations/import", { body }));
          onDone();
        });
      }} />
      {(error || result) && (
        <div className="card au-import" role="status">
          <ErrorBox error={error} />
          {result && (
            <>
              <strong>Imported {result.added} (all turned off){result.already ? `; ${result.already} were already here` : ""}.</strong>
              <p className="muted" style={{ margin: "4px 0" }}>
                Check each one and turn it on when it&apos;s right.{result.tagsMade ? ` ${result.tagsMade} customer tag${result.tagsMade === 1 ? " was" : "s were"} added.` : ""}
                {result.missingTemplates ? ` ${result.missingTemplates} template pick${result.missingTemplates === 1 ? "" : "s"} couldn't be matched (import the Homeworks templates first, in Templates).` : ""}
              </p>
              {result.notes.length > 0 && <ul style={{ margin: 0 }}>{result.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              <button className="btn sm" onClick={() => setResult(null)}>OK</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** For the page's badge: how many actions wait in Review. */
export function useReviewCount() {
  const list = useApi<{ review: number }>("/automations");
  return useMemo(() => list.data?.review ?? 0, [list.data]);
}

"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  RUN_TIMES, SIMPLE_ACTION_KEYS, SIMPLE_TRIGGER_ORDER, SUB_ACTIONS, SUB_DELAYS, actionLabel, automationProblems, describeRunTime, isTextAction, parseRunTime, runTimeOptions,
  runTimeValue, triggerDef, triggerLabel,
  type ActionKey, type AutomationCond, type AutomationDef, type SubAction,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import {
  ConfirmDialog, CondParam, Field, HwToggle, IconButton, PLEASE, Pager, PickOne, TagBox, TemplateSelect, TextHours, TriggerNote, TriggerSelect, actionOf, blankCond, hwDate,
  useAutomationOptions, type Automation, type Options,
} from "@/components/automation-bits";

/**
 * Marketing → Automations, screen for screen like Homeworks: the Automations tab (filters, the
 * table with its On / Off and Review pills, pencil and trash), the add / edit form, Review
 * Sequence, Sequence History and Automation History, and a customer's own Automations tab.
 * Sequence Automations are in automation-sequences.tsx.
 */

type ListData = { review: number; automations: Automation[] };
type Simple = Extract<AutomationDef, { kind: "simple" }>;

const COLUMNS = ["Id", "On - Off", "Automation Name", "Trigger Condition", "Run Time", "Action", "Sub Action", "Review", "Notes", "Tags", "Actions"] as const;
type Column = (typeof COLUMNS)[number];
const subActionText = (d: Simple) => SUB_ACTIONS[d.subAction];

/** What the filters look at, and what the table shows, for one automation. */
function rowOf(a: Automation) {
  const d = a.def as Simple;
  return { trigger: d.trigger.key, runTime: runTimeValue(d.trigger.key, d), runTimeText: describeRunTime(d), action: d.action.action, subAction: d.subAction };
}

type Filters = { condition: string; runtime: string; action: string; subAction: string; status: string };
const NO_FILTERS: Filters = { condition: "", runtime: "", action: "", subAction: "", status: "" };

/** Homeworks' filter card: five lists, then Filter and New Automation. */
function FilterCard({ onFilter, newHref, inline }: { onFilter: (f: Filters) => void; newHref: string | null; inline?: boolean }) {
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const set = (p: Partial<Filters>) => setF({ ...f, ...p });
  const buttons = (
    <div className="hw-filter-buttons">
      <button type="submit" className="btn primary">Filter</button>
      {newHref && <Link href={newHref} className="btn primary">New Automation</Link>}
    </div>
  );
  return (
    <form className={`card hw-filter ${inline ? "inline" : ""}`} onSubmit={(e) => { e.preventDefault(); onFilter(f); }}>
      <div className="hw-filter-row">
        <select value={f.condition} onChange={(e) => set({ condition: e.target.value })} aria-label="Trigger Condition" className="wide">
          <option value="">--- Trigger Condition ---</option>
          {SIMPLE_TRIGGER_ORDER.map((k) => <option key={k} value={k}>{triggerLabel(k, "simple")}</option>)}
        </select>
        <select value={f.runtime} onChange={(e) => set({ runtime: e.target.value })} aria-label="Run Time">
          <option value="">--- Run Time ---</option>
          {RUN_TIMES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <select value={f.action} onChange={(e) => set({ action: e.target.value })} aria-label="Action">
          <option value="">--- Action ---</option>
          {SIMPLE_ACTION_KEYS.map((k) => <option key={k} value={k}>{actionLabel(k, true)}</option>)}
        </select>
        <select value={f.subAction} onChange={(e) => set({ subAction: e.target.value })} aria-label="Sub Action">
          <option value="">--- Sub Action ---</option>
          <option value="none">Nothing</option>
          <option value="run_automation">Run Another Automation</option>
        </select>
        <select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          <option value="">--- Status ---</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        {inline && buttons}
      </div>
      {!inline && buttons}
    </form>
  );
}

const matches = (a: Automation, f: Filters, on: boolean) => {
  const r = rowOf(a);
  return (!f.condition || r.trigger === f.condition) && (!f.runtime || r.runTime === f.runtime) && (!f.action || r.action === f.action)
    && (!f.subAction || r.subAction === f.subAction) && (!f.status || (f.status === "on") === on);
};

/** "11/11 Columns": tick the columns to show (kept on this computer). */
function useColumns(key: string, all: readonly Column[]) {
  const [hidden, setHidden] = useState<Column[]>([]);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(key) ?? "[]"); if (Array.isArray(saved)) setHidden(saved.filter((c) => all.includes(c))); } catch { /* keep all */ }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (c: Column) => { const next = hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c]; setHidden(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* fine */ } };
  const showAll = () => { setHidden([]); try { localStorage.removeItem(key); } catch { /* fine */ } };
  return { shown: all.filter((c) => !hidden.includes(c)), hidden, toggle, showAll };
}
function ColumnChooser({ all, cols }: { all: readonly Column[]; cols: ReturnType<typeof useColumns> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div className="hw-cols" ref={box}>
      <button type="button" className="hw-cols-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{cols.shown.length}/{all.length} Columns</button>
      {open && (
        <div className="hw-cols-menu">
          <button type="button" className="hw-cols-all" disabled={!cols.hidden.length} onClick={cols.showAll}>Select All</button>
          {all.map((c) => <label key={c} className="check"><input type="checkbox" checked={!cols.hidden.includes(c)} onChange={() => cols.toggle(c)} /> {c}</label>)}
        </div>
      )}
    </div>
  );
}

/** The table Homeworks shows: Id, On - Off, name, trigger, run time, action, sub action, Review, Notes, Tags, Actions. */
function AutomationTable({ rows, all, storeKey, isOn, onToggle, onReview, onDelete, canEdit, busy, note }: {
  rows: Automation[]; all: readonly Column[]; storeKey: string; isOn: (a: Automation) => boolean; onToggle: (a: Automation, on: boolean) => void; onReview?: (a: Automation, review: boolean) => void;
  onDelete?: (a: Automation) => void; canEdit: boolean; busy: boolean; note?: (a: Automation) => string | null;
}) {
  const cols = useColumns(storeKey, all);
  const has = (c: Column) => cols.shown.includes(c);
  return (
    <div className="card hw-table-card">
      <div className="hw-table-top"><ColumnChooser all={all} cols={cols} /></div>
      <div className="tablewrap">
        <table className="hw-table">
          <thead><tr>{cols.shown.map((c) => <th key={c} className={`c-${c.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((a) => {
              const r = rowOf(a);
              const d = a.def as Simple;
              const why = note?.(a) ?? null;
              return (
                <tr key={a.id}>
                  {has("Id") && <td>{a.number}</td>}
                  {has("On - Off") && <td><HwToggle on={isOn(a)} disabled={!canEdit || busy} label={`${a.name}: on or off`} onChange={(on) => onToggle(a, on)} /></td>}
                  {has("Automation Name") && <td className="c-name">{a.name}{why && <div className="hw-row-note">{why}</div>}</td>}
                  {has("Trigger Condition") && <td>{triggerLabel(r.trigger, "simple")}</td>}
                  {has("Run Time") && <td>{r.runTimeText}</td>}
                  {has("Action") && <td>{actionLabel(d.action.action, true)}</td>}
                  {has("Sub Action") && <td>{subActionText(d)}</td>}
                  {has("Review") && <td><HwToggle on={a.review} disabled={!onReview || !canEdit || busy} label={`${a.name}: review before execution`} onChange={(v) => onReview?.(a, v)} /></td>}
                  {has("Notes") && <td className="c-notes">{a.description}</td>}
                  {has("Tags") && <td className="c-tags">{a.labels.join(", ")}</td>}
                  {has("Actions") && (
                    <td className="c-actions">
                      {canEdit && (
                        <div className="hw-row-actions">
                          <IconButton icon="pencil" label={`Edit ${a.name}`} href={`/automations?tab=automations&edit=${a.id}`} />
                          <IconButton icon="trash" label={`Delete ${a.name}`} danger disabled={busy} onClick={() => onDelete?.(a)} />
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={cols.shown.length} className="hw-empty">No Records Found</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────────── Automations tab ───────────── */

export function AutomationsTab({ edit, isNew }: { edit: string | null; isNew: boolean }) {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const router = useRouter();
  const list = useApi<ListData>("/automations");
  const opts = useAutomationOptions();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  // Why a switch wouldn't turn on, shown under that automation's name.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const all = (list.data?.automations ?? []).filter((a) => a.kind === "simple");
  const rows = all.filter((a) => matches(a, filters, a.enabled));
  const back = () => { router.push("/automations?tab=automations"); list.reload(); opts.reload(); };

  if (isNew || edit) {
    const current = edit ? all.find((a) => a.id === edit) ?? null : null;
    if (!opts.data || (edit && !list.data)) return <div className="card hw-form"><p className="muted">Loading…</p></div>;
    if (edit && !current) return <div className="card hw-form"><p>That automation isn't here any more. <Link href="/automations?tab=automations">Back to Automations</Link></p></div>;
    return <AutomationForm key={edit ?? "new"} automation={current} o={opts.data} onDone={back} />;
  }
  return (
    <>
      {admin && list.data && <HomeworksNotice data={list.data} onChanged={() => { list.reload(); opts.reload(); }} />}
      <FilterCard onFilter={setFilters} newHref={admin ? "/automations?tab=automations&new=1" : null} />
      <ErrorBox error={list.error ?? error} />
      {list.data ? (
        <AutomationTable rows={rows} all={COLUMNS} storeKey="crewdesk.automations.columns" canEdit={admin} busy={busy} isOn={(a) => a.enabled} note={(a) => (a.enabled ? null : refused[a.id] ?? null)}
          onToggle={(a, on) => run(async () => {
            try { await api(`/automations/${a.id}/enabled`, { body: { enabled: on } }); setRefused(({ [a.id]: _gone, ...rest }) => rest); }
            catch (e) { setRefused((r) => ({ ...r, [a.id]: (e as Error).message })); }
            list.reload();
          })}
          onReview={(a, review) => run(async () => { await api(`/automations/${a.id}/review`, { body: { review } }); list.reload(); })}
          onDelete={setDeleting} />
      ) : <div className="card hw-table-card"><p className="muted" style={{ margin: 0 }}>Loading…</p></div>}
      {admin && list.data && all.some((a) => a.imported === "homeworks") && <ImportAgain onChanged={() => { list.reload(); opts.reload(); }} />}
      {deleting && (
        <ConfirmDialog title="Delete Automation" message="Are you sure you want to delete this Automation?" busy={busy} onNo={() => setDeleting(null)}
          onYes={() => run(async () => { try { await api(`/automations/${deleting.id}`, { method: "DELETE" }); } finally { setDeleting(null); } list.reload(); opts.reload(); })} />
      )}
    </>
  );
}

/* ───────────── Add / edit an automation ───────────── */

type Form = {
  name: string; trigger: AutomationCond; runAt: string | null; runTime: string; action: ActionKey | ""; templateId: string | null; employeeId: string; tagId: string | null;
  subAction: SubAction; subAutomationId: string | null; subDelay: string; review: boolean; description: string; labels: string[];
};

function AutomationForm({ automation, o, onDone }: { automation: Automation | null; o: Options; onDone: () => void }) {
  const d = automation?.def.kind === "simple" ? automation.def : null;
  const [f, setF] = useState<Form>(d && automation ? {
    name: automation.name, trigger: d.trigger, runAt: d.runAt, runTime: runTimeValue(d.trigger.key, d), action: d.action.action, templateId: d.action.templateId, employeeId: d.action.employeeIds[0] ?? "",
    tagId: d.action.tagId, subAction: d.subAction, subAutomationId: d.subAutomationId, subDelay: d.subAction === "run_automation" ? String(d.subDelayMinutes) : "", review: automation.review,
    description: automation.description ?? "", labels: automation.labels,
  } : { name: "", trigger: blankCond(), runAt: null, runTime: "", action: "", templateId: null, employeeId: "", tagId: null, subAction: "none", subAutomationId: null, subDelay: "", review: false, description: "", labels: [] });
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useAction();
  const set = (p: Partial<Form>) => setF({ ...f, ...p });
  const td = triggerDef(f.trigger.key);
  const ad = f.action ? actionOf(f.action) : undefined;
  const certain = td?.param === "datetime";
  const rt = parseRunTime(f.runTime);

  const payload = () => ({
    kind: "simple" as const, name: f.name.trim(), description: f.description.trim() || null, labels: f.labels, enabled: automation ? automation.enabled : true, review: f.review,
    trigger: f.trigger, runAt: certain ? f.runAt : null, delayMinutes: rt?.delayMinutes ?? 0, daysBefore: rt?.daysBefore ?? null,
    action: { waitMinutes: 0, action: f.action as ActionKey, templateId: f.templateId, employeeIds: f.employeeId ? [f.employeeId] : [], tagId: f.tagId, todoTitle: null },
    subAction: f.subAction, subAutomationId: f.subAutomationId, subDelayMinutes: Number(f.subDelay || 0),
  });
  const problems: string[] = [];
  if (!f.name.trim()) problems.push("Automation Name is required");
  if (!f.trigger.key) problems.push("Trigger Condition is required");
  else if (!certain && !rt) problems.push("Run Time is required");
  if (!f.action) problems.push("Action is required");
  if (f.trigger.key && f.action && (certain || rt)) problems.push(...automationProblems(payload()));
  if (f.subAction === "run_automation" && f.subDelay === "") problems.push("When To Run The Next Automation is required");

  const save = () => {
    setTried(true);
    if (problems.length) return;
    run(async () => { await api(automation ? `/automations/${automation.id}` : "/automations", { method: automation ? "PUT" : "POST", body: payload() }); onDone(); });
  };

  return (
    <div className="card hw-form">
      <Field label="Automation Name" required><input value={f.name} maxLength={150} onChange={(e) => set({ name: e.target.value })} autoFocus={!automation} /></Field>
      <Field label="Trigger Condition" required>
        <TriggerSelect use="simple" label="Trigger Condition" value={f.trigger.key} onChange={(key) => set({ trigger: blankCond(key), runAt: null, runTime: "" })} />
      </Field>
      <TriggerNote k={f.trigger.key} use="simple" />
      {td?.param === "tags" && (
        <>
          <Field label="Tags Type" required><select value="customers" onChange={() => undefined} aria-label="Tags Type"><option value="customers">Used with Customers</option></select></Field>
          <Field label="Tags" required><CondParam cond={f.trigger} o={o} onChange={(trigger) => set({ trigger })} /></Field>
        </>
      )}
      {certain && (
        <div className="hw-field">
          <span className="hw-label">Date &amp; Time<em className="hw-req"> *</em></span>
          <div className="hw-datetime">
            <input type="date" aria-label="Date" value={f.runAt?.slice(0, 10) ?? ""} onChange={(e) => set({ runAt: e.target.value ? `${e.target.value}T${f.runAt?.slice(11) || "09:00"}` : null })} />
            <input type="time" aria-label="Time" value={f.runAt?.slice(11) ?? ""} onChange={(e) => set({ runAt: f.runAt && e.target.value ? `${f.runAt.slice(0, 10)}T${e.target.value}` : f.runAt })} />
          </div>
        </div>
      )}
      {f.trigger.key && !certain && (
        <Field label="Run Time" required>
          <select value={f.runTime} onChange={(e) => set({ runTime: e.target.value })} aria-label="Run Time">
            <option value="">{PLEASE}</option>
            {runTimeOptions(f.trigger.key).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            {f.runTime && !runTimeOptions(f.trigger.key).some((r) => r.value === f.runTime) && automation?.def.kind === "simple" && <option value={f.runTime}>{describeRunTime(automation.def)}</option>}
          </select>
        </Field>
      )}
      <Field label="Action" required>
        <select value={f.action} onChange={(e) => set({ action: e.target.value as ActionKey | "", templateId: null, tagId: null, employeeId: "" })} aria-label="Action">
          <option value="">{PLEASE}</option>
          {SIMPLE_ACTION_KEYS.map((k) => <option key={k} value={k}>{actionLabel(k, true)}</option>)}
        </select>
      </Field>
      {ad?.to === "employee" && <Field label="Employee" required><PickOne label="Employee" items={o.employees} value={f.employeeId} onChange={(employeeId) => set({ employeeId })} /></Field>}
      {ad?.channel === "text" && <Field label="Text Template" required><TemplateSelect channel="text" value={f.templateId} o={o} onChange={(templateId) => set({ templateId })} /></Field>}
      {ad?.channel === "email" && <Field label="Email Template" required><TemplateSelect channel="email" value={f.templateId} o={o} onChange={(templateId) => set({ templateId })} /></Field>}
      {f.action && isTextAction(f.action) && <TextHours />}
      {ad?.needs === "tag" && (
        <>
          <Field label="Tags Type" required><select value="customers" onChange={() => undefined} aria-label="Tags Type for the action"><option value="customers">Used with Customers</option></select></Field>
          <Field label="Tags" required><PickOne label="Tag to add or remove" items={o.tags} value={f.tagId ?? ""} onChange={(id) => set({ tagId: id || null })} /></Field>
        </>
      )}
      <Field label="Sub Action" half>
        <select value={f.subAction} onChange={(e) => set({ subAction: e.target.value as SubAction })} aria-label="Sub Action">
          {(Object.keys(SUB_ACTIONS) as SubAction[]).map((k) => <option key={k} value={k}>{SUB_ACTIONS[k]}</option>)}
        </select>
      </Field>
      {f.subAction === "run_automation" && (
        <>
          <Field label="Next Automation" required>
            <PickOne label="Next Automation" items={o.automations.filter((x) => x.kind === "simple" && x.id !== automation?.id)} value={f.subAutomationId ?? ""} onChange={(id) => set({ subAutomationId: id || null })} />
          </Field>
          <Field label="When To Run The Next Automation" required>
            <select value={f.subDelay} onChange={(e) => set({ subDelay: e.target.value })} aria-label="When To Run The Next Automation">
              <option value="">{PLEASE}</option>
              {SUB_DELAYS.map((r) => <option key={r.minutes} value={r.minutes}>{r.label}</option>)}
            </select>
          </Field>
        </>
      )}
      <label className="check hw-check"><input type="checkbox" checked={f.review} onChange={(e) => set({ review: e.target.checked })} /> Review Before Execution <span className="hw-help">(If checked, this automation will be reviewed before execution)</span></label>
      <Field label="Notes / Description" className="wide"><textarea rows={8} maxLength={2000} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <div className="hw-field wide"><span className="hw-label">Tags</span><TagBox value={f.labels} onChange={(labels) => set({ labels })} /></div>
      {tried && problems.length > 0 && <div className="hw-errors" role="alert">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
      <ErrorBox error={error} />
      <div className="hw-form-foot">
        <button type="button" className="btn hw-soft" onClick={onDone}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{automation ? "Update Automation" : "Add Automation"}</button>
      </div>
    </div>
  );
}

/* ───────────── History and review ───────────── */

type HistoryRow = {
  id: string; number: number; addedAt: string; scheduledAt: string | null; executedAt: string | null; status: string; detail: string | null; kind: string; action: string; actionLabel: string;
  triggerKey: string; runId: string; runStatus: string; automation: { id: string; name: string; kind: string; number: number }; customer: { id: string; name: string } | null;
};
type HistoryData = { rows: HistoryRow[]; page: number; pages: number; total: number };
const STATUS_WORDS: Record<string, string> = { waiting: "Pending", review: "Waiting for review", done: "Done", skipped: "Skipped", failed: "Failed", stopped: "Stopped" };
const rowTone = (status: string) => (status === "done" ? "row_success" : status === "skipped" || status === "failed" ? "row_error" : "");

/** Automation History: ID, Date, Trigger Condition, Action, Status Message; green for sent, red for skipped or failed. */
export function AutomationHistoryTab() {
  const [page, setPage] = useState(1);
  const list = useApi<HistoryData>(`/automations/history?kind=simple&page=${page}`);
  const rows = list.data?.rows ?? [];
  return (
    <>
      <ErrorBox error={list.error} />
      <div className="card hw-table-card">
        <div className="tablewrap">
          <table className="hw-table hw-history">
            {rows.length > 0 && <thead><tr><th>ID</th><th>Date</th><th>Trigger Condition</th><th>Action</th><th>Status Message</th></tr></thead>}
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={rowTone(r.status)}>
                  <td>{r.number}</td>
                  <td>{hwDate(r.executedAt ?? r.addedAt)}</td>
                  <td>{triggerLabel(r.triggerKey, "simple")}</td>
                  <td>{r.actionLabel}</td>
                  <td>{r.detail}</td>
                </tr>
              ))}
              {!rows.length && <tr><td className="hw-empty">{list.loading ? "Loading…" : "No Records Found"}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {rows.length > 0 && <Pager page={list.data?.page ?? 1} pages={list.data?.pages ?? 1} onPage={setPage} />}
    </>
  );
}

/** Sequence History: each action a sequence queued, with when it was added, scheduled and executed. */
export function SequenceHistoryTab() {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: "addedAt" | "scheduledAt" | "executedAt"; asc: boolean } | null>(null);
  const list = useApi<HistoryData>(`/automations/history?kind=sequence&show=all&page=${page}`);
  const rows = useMemo(() => {
    const r = [...(list.data?.rows ?? [])];
    if (sort) r.sort((a, b) => { const x = a[sort.key] ? Date.parse(a[sort.key]!) : 0, y = b[sort.key] ? Date.parse(b[sort.key]!) : 0; return sort.asc ? x - y : y - x; });
    return r;
  }, [list.data, sort]);
  const head = (key: "addedAt" | "scheduledAt" | "executedAt", label: string) => (
    <th><button type="button" className="hw-sort" onClick={() => setSort({ key, asc: sort?.key === key ? !sort.asc : true })}>{label}{sort?.key === key ? (sort.asc ? " ▲" : " ▼") : ""}</button></th>
  );
  return (
    <>
      <ErrorBox error={list.error} />
      <div className="card hw-table-card">
        <div className="tablewrap">
          <table className="hw-table hw-history history_table">
            {rows.length > 0 && <thead><tr><th>ID</th><th>Sequence</th><th>Customer</th><th>Action</th>{head("addedAt", "Added At")}{head("scheduledAt", "Scheduled At")}{head("executedAt", "Executed At")}<th>Status</th></tr></thead>}
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={rowTone(r.status)}>
                  <td>{r.number}</td>
                  <td>{r.automation.name}</td>
                  <td>{r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : ""}</td>
                  <td>{r.kind === "stop" ? "Stop Action: " : ""}{r.actionLabel}</td>
                  <td>{hwDate(r.addedAt)}</td>
                  <td>{hwDate(r.scheduledAt)}</td>
                  <td>{r.executedAt ? hwDate(r.executedAt) : r.status === "waiting" || r.status === "review" ? "PENDING" : ""}</td>
                  <td>{r.detail ?? STATUS_WORDS[r.status] ?? r.status}</td>
                </tr>
              ))}
              {!rows.length && <tr><td className="hw-empty">{list.loading ? "Loading…" : "No Records Found"}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {rows.length > 0 && <Pager page={list.data?.page ?? 1} pages={list.data?.pages ?? 1} onPage={setPage} />}
    </>
  );
}

type ReviewItem = {
  id: string; number: number; kind: string; actionLabel: string; createdAt: string; triggeredAt: string; triggerKey: string;
  automation: { id: string; name: string; kind: string; number: number }; customer: { id: string; name: string } | null;
  preview: { channel: "email" | "text"; subject: string | null; body: string } | null;
};

/** Review Sequence: what's waiting because of "Review Before Execution". Approve sends it; Reject skips it. */
export function ReviewTab({ onChanged }: { onChanged?: () => void }) {
  const list = useApi<ReviewItem[]>("/automations/review/list");
  const { busy, error, run } = useAction();
  const [asking, setAsking] = useState<{ item: ReviewItem; decision: "send" | "skip" } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.data ?? [];
  return (
    <>
      <ErrorBox error={list.error ?? error} />
      <div className="card hw-table-card">
        <div className="tablewrap">
          <table className="hw-table hw-history">
            {rows.length > 0 && <thead><tr><th>ID</th><th>Sequence</th><th>Customer</th><th>Trigger Condition</th><th>Action</th><th>Added At</th><th>Actions</th></tr></thead>}
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>{r.number}</td>
                    <td>{r.automation.name}</td>
                    <td>{r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : ""}</td>
                    <td>{triggerLabel(r.triggerKey, r.automation.kind === "simple" ? "simple" : "if")}</td>
                    <td>{r.kind === "stop" ? "Stop Action: " : ""}{r.actionLabel}{r.preview && <> <button type="button" className="hw-link" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide message" : "View message"}</button></>}</td>
                    <td>{hwDate(r.createdAt)}</td>
                    <td className="hw-review-buttons">
                      <button type="button" className="btn primary sm approve-cron" disabled={busy} onClick={() => setAsking({ item: r, decision: "send" })}>Approve</button>
                      <button type="button" className="btn danger-solid sm reject-cron" disabled={busy} onClick={() => setAsking({ item: r, decision: "skip" })}>Reject</button>
                    </td>
                  </tr>
                  {open === r.id && r.preview && (
                    <tr className="hw-preview-row">
                      <td colSpan={7}>
                        {r.preview.channel === "email" ? (
                          <>
                            <div className="hw-preview-subject"><span className="muted">Subject:</span> {r.preview.subject}</div>
                            <iframe className="hw-preview-frame" sandbox="" title={`Message for ${r.customer?.name ?? "the team"}`} srcDoc={`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;margin:12px">${r.preview.body}</body>`} />
                          </>
                        ) : <div className="tpl-bubble">{r.preview.body}</div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!rows.length && <tr><td className="hw-empty">{list.loading ? "Loading…" : "No Records Found"}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {asking && (
        <ConfirmDialog title="Review Automation Job" busy={busy} onNo={() => setAsking(null)}
          message={asking.decision === "send" ? "Do you really want to approve this automation job?" : "Do you really want to reject this automation job?"}
          onYes={() => run(async () => { try { await api(`/automations/steps/${asking.item.id}/review`, { body: { decision: asking.decision } }); } finally { setAsking(null); } list.reload(); onChanged?.(); })} />
      )}
    </>
  );
}

/* ───────────── A customer's Automations tab ───────────── */

const CUSTOMER_COLUMNS = COLUMNS.filter((c) => c !== "Actions");

/**
 * The customer's Automations tab, as Homeworks has it: the same filters and table, with On / Off
 * for just this customer. Sequences are listed after the automations; what has run for them is below.
 */
export function CustomerAutomations({ customerId, name }: { customerId: string; name: string }) {
  const { can } = useAuth();
  const list = useApi<{ automations: (Automation & { off: boolean })[] }>(`/automations/customer/${customerId}`);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const history = useApi<HistoryData>(`/automations/history?customerId=${customerId}&show=all&page=${page}`);
  const { busy, error, run } = useAction();
  const all = list.data?.automations ?? [];
  const offIds = new Set(all.filter((a) => a.off).map((a) => a.id));
  const isOn = (a: Automation) => a.enabled && !offIds.has(a.id);
  const simple = all.filter((a) => a.kind === "simple" && matches(a, filters, isOn(a)));
  const sequences = all.filter((a) => a.kind === "sequence");
  // Why a switch wouldn't turn on, shown under that automation's name.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const toggle = (a: Automation, on: boolean) => {
    if (on && !a.enabled) { setRefused((r) => ({ ...r, [a.id]: "It's off for everyone. Turn it on in Marketing → Automations first." })); return; }
    run(async () => { await api(`/automations/customer/${customerId}/${a.id}`, { method: "PUT", body: { on } }); setRefused(({ [a.id]: _gone, ...rest }) => rest); list.reload(); history.reload(); });
  };
  const rows = history.data?.rows ?? [];
  return (
    <div className="hw" data-lkeep="">
      <FilterCard inline onFilter={setFilters} newHref={can("admin", "customers") ? "/automations?tab=automations&new=1" : null} />
      <ErrorBox error={list.error ?? error} />
      <AutomationTable rows={simple} all={CUSTOMER_COLUMNS} storeKey="crewdesk.automations.customer-columns" canEdit busy={busy} isOn={isOn} onToggle={toggle}
        note={(a) => refused[a.id] ?? null} />
      {sequences.length > 0 && (
        <div className="card hw-table-card">
          <strong className="hw-card-title">Sequence Automations</strong>
          <div className="tablewrap">
            <table className="hw-table">
              <thead><tr><th>Id</th><th>On - Off</th><th>Sequence</th><th>Description</th></tr></thead>
              <tbody>{sequences.map((a) => (
                <tr key={a.id}>
                  <td>{a.number}</td>
                  <td><HwToggle on={isOn(a)} disabled={busy} label={`${a.name}: on or off for ${name}`} onChange={(on) => toggle(a, on)} /></td>
                  <td className="c-name">{a.name}{refused[a.id] && <div className="hw-row-note">{refused[a.id]}</div>}</td>
                  <td className="c-notes">{a.description}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card hw-table-card">
        <strong className="hw-card-title">Automation History for {name}</strong>
        <div className="tablewrap">
          <table className="hw-table hw-history">
            {rows.length > 0 && <thead><tr><th>ID</th><th>Date</th><th>Automation</th><th>Trigger Condition</th><th>Action</th><th>Status Message</th><th /></tr></thead>}
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={rowTone(r.status)}>
                  <td>{r.number}</td>
                  <td>{r.executedAt ? hwDate(r.executedAt) : r.scheduledAt ? `Scheduled ${hwDate(r.scheduledAt)}` : hwDate(r.addedAt)}</td>
                  <td>{r.automation.name}</td>
                  <td>{triggerLabel(r.triggerKey, r.automation.kind === "simple" ? "simple" : "if")}</td>
                  <td>{r.kind === "stop" ? "Stop Action: " : ""}{r.actionLabel}</td>
                  <td>{r.detail ?? STATUS_WORDS[r.status] ?? r.status}</td>
                  <td>{r.status === "waiting" && r.runStatus === "running" && <button type="button" className="btn sm" disabled={busy} onClick={() => confirm(`Stop "${r.automation.name}" for ${name}? What's still waiting won't happen.`) && run(async () => { await api(`/automations/runs/${r.runId}/stop`, { method: "POST" }); history.reload(); })}>Stop</button>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td className="hw-empty">{history.loading ? "Loading…" : "No Records Found"}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {rows.length > 0 && (history.data?.pages ?? 1) > 1 && <Pager page={history.data?.page ?? 1} pages={history.data?.pages ?? 1} onPage={setPage} />}
    </div>
  );
}

/* ───────────── Bringing in Homeworks ───────────── */

type ImportResult = { added: number; already: number; notes: string[]; tagsMade: number; missingTemplates: number; templatesAdded: number; templatesUpdated?: number };
/** Picks the Homeworks file and brings it in. */
function useHomeworksImport(onChanged: () => void) {
  const input = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const { busy, error, run } = useAction();
  const field = (
    <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      run(async () => { setImported(await api("/automations/import", { body: JSON.parse(await file.text()) })); onChanged(); });
    }} />
  );
  return { field, pick: () => input.current?.click(), imported, clear: () => setImported(null), busy, error };
}

function ImportSummary({ r }: { r: ImportResult }) {
  return (
    <div>
      <strong>
        {r.added > 0 ? `Imported ${r.added} automations and sequences${r.templatesAdded ? ` and ${r.templatesAdded} templates` : ""}, all turned off` : r.templatesAdded || r.templatesUpdated ? "" : "Nothing new to import"}
        {r.templatesUpdated ? ` ${r.templatesUpdated} email template${r.templatesUpdated === 1 ? "" : "s"} brought up to date with ${r.templatesUpdated === 1 ? "its" : "their"} Homeworks design.` : ""}
        {!r.added && r.templatesAdded ? ` ${r.templatesAdded} templates added.` : ""}
        {r.already ? ` (${r.already} were already here${r.added ? "" : "; their Homeworks Ids and tags are up to date"})` : ""}.
      </strong>
      {r.tagsMade > 0 && <> {r.tagsMade} customer tag{r.tagsMade === 1 ? " was" : "s were"} added.</>}
      {r.missingTemplates > 0 && <> {r.missingTemplates} template pick{r.missingTemplates === 1 ? "" : "s"} couldn&apos;t be matched.</>}
      {r.notes.length > 0 && <ul>{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

/** Shown to admins until Homeworks' automations are here: a button to bring in the file (everything comes in turned off). */
export function HomeworksNotice({ data, onChanged }: { data: ListData; onChanged: () => void }) {
  const imp = useHomeworksImport(onChanged);
  const fromHomeworks = data.automations.filter((a) => a.imported === "homeworks");
  // Brought in from the first file, which didn't carry their Homeworks Ids and tags.
  const older = fromHomeworks.some((a) => a.wasOn == null);
  if (fromHomeworks.length > 0 && !older && !imp.imported && !imp.error) return null;
  return (
    <div className="card hw-notice" role="status">
      {imp.field}
      <ErrorBox error={imp.error} />
      {fromHomeworks.length === 0 && !imp.imported && (
        <>
          <div><strong>Your Homeworks automations aren&apos;t here yet.</strong> Choose the Homeworks file Crewdesk made for you (templates, automations and sequences in one). Everything comes in turned off.</div>
          <button type="button" className="btn primary" disabled={imp.busy} onClick={imp.pick}>{imp.busy ? "Importing…" : "Import from Homeworks"}</button>
        </>
      )}
      {older && !imp.imported && (
        <>
          <div><strong>Your Homeworks automations came from an earlier file.</strong> Import the new Homeworks file to bring over their Homeworks Ids and tags. Nothing you&apos;ve changed here is touched.</div>
          <button type="button" className="btn primary" disabled={imp.busy} onClick={imp.pick}>{imp.busy ? "Importing…" : "Import from Homeworks"}</button>
        </>
      )}
      {imp.imported && (
        <>
          <ImportSummary r={imp.imported} />
          <button type="button" className="btn sm hw-soft" onClick={imp.clear}>OK</button>
        </>
      )}
    </div>
  );
}

/** Under the list, for admins: bring in a Homeworks file again (what's already here is left as it is). */
export function ImportAgain({ onChanged }: { onChanged: () => void }) {
  const imp = useHomeworksImport(onChanged);
  return (
    <div className="hw-import-again">
      {imp.field}
      <button type="button" className="hw-link" disabled={imp.busy} onClick={imp.pick}>{imp.busy ? "Importing…" : "Import from Homeworks"}</button>
      {imp.error && <span className="hw-row-note">{imp.error}</span>}
      {imp.imported && <span className="muted"> <ImportSummary r={imp.imported} /></span>}
    </div>
  );
}

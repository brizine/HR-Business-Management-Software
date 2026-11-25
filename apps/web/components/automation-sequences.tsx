"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ACTION_KEYS, actionLabel, automationProblems, isTextAction, splitWait, triggerLabel, waitText,
  type ActionKey, type AutomationAction, type AutomationCond, type AutomationDef,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { Icon } from "@/components/icons";
import {
  CondParam, ConfirmDialog, Field, HwToggle, IconButton, PLEASE, PickOne, Req, TemplateSelect, TextHours, TriggerNote, TriggerSelect, actionOf, blankCond, useAutomationOptions,
  type Automation, type Options,
} from "@/components/automation-bits";
import { HomeworksNotice } from "@/components/automations";

/**
 * Sequence Automations, like Homeworks': a card per sequence (title, description and Id, On / Off;
 * open it to read what it does, Delete, Edit) and the editor (IF Trigger, Conditions, timed
 * Actions, ELSE Triggers, Stop When).
 */

type Seq = Extract<AutomationDef, { kind: "sequence" }>;
type ListData = { review: number; wasOnAndReady: number; automations: Automation[] };

/** The password for a protected sequence, asked once (the owner is never asked). */
async function passwordFor(a: Automation): Promise<string | null | undefined> {
  if (!a.locked) return undefined;
  try { await api(`/automations/${a.id}/unlock`, { body: { password: "" } }); return undefined; } catch { /* not the owner: ask */ }
  const given = window.prompt(`"${a.name}" is protected with a password. Enter it to continue:`);
  if (given == null) return null;
  await api(`/automations/${a.id}/unlock`, { body: { password: given } });
  return given;
}
const lockHeader = (password: string | undefined) => (password ? { "x-sequence-password": password } : undefined);

/* ───────────── The list ───────────── */

export function SequencesTab({ edit, isNew }: { edit: string | null; isNew: boolean }) {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const router = useRouter();
  const list = useApi<ListData>("/automations");
  const opts = useAutomationOptions();
  const [open, setOpen] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<{ a: Automation; password?: string } | null>(null);
  const [unlocked, setUnlocked] = useState<Record<string, string | undefined>>({});
  // Why a switch wouldn't turn on, shown on that sequence's card.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const rows = (list.data?.automations ?? []).filter((a) => a.kind === "sequence").sort((a, b) => a.number - b.number);
  const back = () => { router.push("/automations?tab=sequences"); list.reload(); opts.reload(); };

  if (isNew || edit) {
    const current = edit ? rows.find((a) => a.id === edit) ?? null : null;
    if (!opts.data || (edit && !list.data)) return <div className="card hw-form hw-seq-form"><p className="muted">Loading…</p></div>;
    if (edit && !current) return <div className="card hw-form hw-seq-form"><p>That sequence isn't here any more. <Link href="/automations?tab=sequences">Back to Sequence Automations</Link></p></div>;
    if (current?.locked && !(current.id in unlocked)) {
      return <Locked a={current} onOpen={(pw) => setUnlocked({ ...unlocked, [current.id]: pw })} onBack={back} />;
    }
    return <SequenceForm key={edit ?? "new"} automation={current} password={current ? unlocked[current.id] : undefined} o={opts.data} onDone={back} />;
  }
  const toggleOpen = (id: string) => setOpen(open.includes(id) ? open.filter((x) => x !== id) : [...open, id]);
  return (
    <>
      {admin && list.data && <HomeworksNotice data={list.data} onChanged={() => { list.reload(); opts.reload(); }} />}
      {admin && <div className="hw-top-right"><Link href="/automations?tab=sequences&new=1" className="btn primary">New Automation Sequence</Link></div>}
      <ErrorBox error={list.error ?? error} />
      <div className="hw-seq-list">
        {rows.map((a) => {
          const isOpen = open.includes(a.id);
          return (
            <div key={a.id} className="card hw-seq-card">
              <div className="hw-seq-head">
                <button type="button" className="hw-seq-title" aria-expanded={isOpen} onClick={() => toggleOpen(a.id)}>
                  <span className="hw-seq-name">{a.name}</span>
                  <span className="hw-seq-desc">{a.description ? `${a.description} ` : ""}(ID: {a.number})</span>
                  <Icon name="chevron" size={16} className={`hw-seq-chevron ${isOpen ? "open" : ""}`} />
                </button>
                <HwToggle on={a.enabled} disabled={!admin || busy} label={`${a.name}: on or off`}
                  onChange={(on) => run(async () => {
                    try { await api(`/automations/${a.id}/enabled`, { body: { enabled: on } }); setRefused(({ [a.id]: _gone, ...rest }) => rest); }
                    catch (e) { setRefused((r) => ({ ...r, [a.id]: (e as Error).message })); }
                    list.reload();
                  })} />
                {!a.enabled && refused[a.id] && <div className="hw-row-note">{refused[a.id]}</div>}
              </div>
              {isOpen && (
                <div className="hw-seq-body">
                  <SequenceSummary def={a.def as Seq} dead={a.deadBlocks} />
                  {admin && (
                    <div className="hw-seq-actions">
                      <button type="button" className="btn danger-solid" disabled={busy} onClick={() => run(async () => { const pw = await passwordFor(a); if (pw !== null) setDeleting({ a, password: pw }); })}>Delete</button>
                      <Link href={`/automations?tab=sequences&edit=${a.id}`} className="btn primary">Edit</Link>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {list.data && !rows.length && <div className="card hw-table-card"><p className="hw-empty">No Records Found</p></div>}
      </div>
      {deleting && (
        <ConfirmDialog title="Delete Sequence" message="Are you sure you want to delete this Automation Sequence?" busy={busy} onNo={() => setDeleting(null)}
          onYes={() => run(async () => { try { await api(`/automations/${deleting.a.id}`, { method: "DELETE", headers: lockHeader(deleting.password) }); } finally { setDeleting(null); } list.reload(); opts.reload(); })} />
      )}
    </>
  );
}

/** A protected sequence: its password, before it opens. */
function Locked({ a, onOpen, onBack }: { a: Automation; onOpen: (password: string | undefined) => void; onBack: () => void }) {
  const [pw, setPw] = useState("");
  const { busy, error, run } = useAction();
  // The owner goes straight in.
  useEffect(() => {
    api(`/automations/${a.id}/unlock`, { body: { password: "" } }).then(() => onOpen(undefined)).catch(() => undefined);
  }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form className="card hw-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/automations/${a.id}/unlock`, { body: { password: pw } }); onOpen(pw); }); }}>
      <p style={{ margin: 0 }}><strong>{a.name}</strong> is protected with a password.</p>
      <Field label="Password" required half><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="off" /></Field>
      <ErrorBox error={error} />
      <div className="hw-form-foot">
        <button type="button" className="btn hw-soft" onClick={onBack}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !pw}>Open</button>
      </div>
    </form>
  );
}

/** What a sequence does, in Homeworks' words: "This trigger sequence will kickstart when … wait for … then …". */
function SequenceSummary({ def, dead }: { def: Seq; dead: { index: number; why: string }[] }) {
  return (
    <>
      {def.blocks.map((b, i) => (
        <div key={i}>
          <span className={`hw-label-pill ${i ? "else" : "if"}`}>{i ? "ELSE" : "IF"}</span>
          {dead.some((x) => x.index === i) && <span className="hw-row-note inline"> Crewdesk can&apos;t run this part: {dead.find((x) => x.index === i)!.why}</span>}
          <div className="hw-trigger-block">
            <div className="hw-kick">
              This trigger sequence will kickstart when <span className="hw-pill trigger">{triggerLabel(b.trigger.key)}</span>
              {b.when.map((group, gi) => group.map((c, ci) => (
                <span key={`${gi}-${ci}`}> <span className={`hw-label-pill ${gi > 0 && ci === 0 ? "else" : "if"}`}>{gi > 0 && ci === 0 ? "OR" : "AND"}</span> when <span className="hw-pill trigger">{triggerLabel(c.key, "and")}</span></span>
              )))}
            </div>
            <div className="hw-action-block">
              <strong>Actions Performed</strong>
              {b.actions.map((x, j) => <div key={j}>wait for <span className="hw-pill wait">{waitText(x.waitMinutes)}</span> then <span className="hw-pill wait">{actionLabel(x.action).replace(/\s*\(Due.*$/, "")}</span></div>)}
            </div>
          </div>
        </div>
      ))}
      {def.stops.length > 0 && (
        <div className="hw-stop-block">
          This trigger sequence will stop when {def.stops.map((c, i) => <span key={i}>{i > 0 && " or when "}<span className="hw-pill stop">{triggerLabel(c.key, "stop")}</span></span>)}
          {def.stopActions.length > 0 && <span>; then {def.stopActions.map((x, i) => <span key={i}>{i > 0 && ", "}<span className="hw-pill wait">{actionLabel(x.action).replace(/\s*\(Due.*$/, "")}</span></span>)}</span>}
        </div>
      )}
    </>
  );
}

/* ───────────── The editor ───────────── */

type ActF = Omit<AutomationAction, "action"> & { action: ActionKey | ""; after: boolean };
type BlockF = { trigger: AutomationCond; when: AutomationCond[][]; actions: ActF[] };
type FormState = { name: string; description: string; review: boolean; protect: boolean; password: string; blocks: BlockF[]; stops: AutomationCond[]; stopActions: ActF[] };

const blankAct = (): ActF => ({ waitMinutes: 0, after: false, action: "", templateId: null, employeeIds: [], tagId: null, todoTitle: null });
const actF = (x: AutomationAction): ActF => ({ ...x, after: x.waitMinutes > 0 });
const blankBlock = (): BlockF => ({ trigger: blankCond(), when: [], actions: [] });

/** Homeworks' Waiting Period: Instantly or After, with Days, Hrs and Min. */
function WaitingPeriod({ act, onChange }: { act: ActF; onChange: (a: ActF) => void }) {
  const w = splitWait(act.waitMinutes);
  const name = useRef(`wait-${Math.random().toString(36).slice(2)}`).current;
  const set = (p: Partial<typeof w>) => { const n = { ...w, ...p }; onChange({ ...act, after: true, waitMinutes: Math.max(0, n.days) * 1440 + Math.max(0, n.hours) * 60 + Math.max(0, n.minutes) }); };
  const num = (v: string, max: number) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
  return (
    <div className="hw-wait">
      <span className="hw-label">Waiting Period<Req /></span>
      <div className="hw-wait-radios">
        <label className="check"><input type="radio" name={name} checked={!act.after} onChange={() => onChange({ ...act, after: false, waitMinutes: 0 })} /> Instantly</label>
        <label className="check"><input type="radio" name={name} checked={act.after} onChange={() => onChange({ ...act, after: true })} /> After</label>
      </div>
      <div className="hw-wait-inputs">
        <span className="hw-unit"><input type="number" min={0} max={366} placeholder="0" value={act.after && w.days ? w.days : ""} onChange={(e) => set({ days: num(e.target.value, 366) })} aria-label="Days" /><b>Days</b></span>
        <span className="hw-unit"><input type="number" min={0} max={23} placeholder="0" value={act.after && w.hours ? w.hours : ""} onChange={(e) => set({ hours: num(e.target.value, 23) })} aria-label="Hours" /><b>Hrs</b></span>
        <span className="hw-unit"><input type="number" min={0} max={59} placeholder="0" value={act.after && w.minutes ? w.minutes : ""} onChange={(e) => set({ minutes: num(e.target.value, 59) })} aria-label="Minutes" /><b>Min</b></span>
      </div>
    </div>
  );
}

/** One action row: Waiting Period, Action (and Employee under it), then its Template, Tag or Title, and the trash. */
function ActionRow({ act, onChange, onRemove, o }: { act: ActF; onChange: (a: ActF) => void; onRemove: () => void; o: Options }) {
  const d = act.action ? actionOf(act.action) : undefined;
  return (
    <div className="hw-action-row">
      <WaitingPeriod act={act} onChange={onChange} />
      <div className="hw-action-col">
        <Field label="Action" required>
          <select value={act.action} onChange={(e) => onChange({ ...act, action: e.target.value as ActionKey | "", templateId: null, tagId: null, todoTitle: null, employeeIds: [] })} aria-label="Action">
            <option value="">{PLEASE}</option>
            {ACTION_KEYS.map((k) => <option key={k} value={k}>{actionLabel(k)}</option>)}
          </select>
        </Field>
        {d?.to === "employee" && <Field label="Employee" required><PickOne label="Employee" items={o.employees} value={act.employeeIds[0] ?? ""} onChange={(id) => onChange({ ...act, employeeIds: id ? [id] : [] })} /></Field>}
      </div>
      <div className="hw-action-col">
        {d?.channel === "text" && <Field label="Text Template" required><TemplateSelect channel="text" value={act.templateId} o={o} onChange={(templateId) => onChange({ ...act, templateId })} /></Field>}
        {d?.channel === "email" && <Field label="Email Template" required><TemplateSelect channel="email" value={act.templateId} o={o} onChange={(templateId) => onChange({ ...act, templateId })} /></Field>}
        {d?.needs === "tag" && <Field label="Tag" required><PickOne label="Tag" items={o.tags} value={act.tagId ?? ""} onChange={(id) => onChange({ ...act, tagId: id || null })} /></Field>}
        {d?.needs === "todo" && <Field label="Title" required><input value={act.todoTitle ?? ""} maxLength={200} onChange={(e) => onChange({ ...act, todoTitle: e.target.value })} aria-label="Title" /></Field>}
      </div>
      <div className="hw-action-trash"><IconButton icon="trash" label="Remove this action" danger onClick={onRemove} /></div>
    </div>
  );
}

/** A condition card: the green stripe ("&", or "-" for the first of an OR group), Condition, its tag, and the trash. */
function ConditionCard({ mark, cond, onChange, onRemove, o }: { mark: string; cond: AutomationCond; onChange: (c: AutomationCond) => void; onRemove: () => void; o: Options }) {
  return (
    <div className="hw-cond-card">
      <span className="hw-cond-mark" aria-hidden="true">{mark}</span>
      <div className="hw-cond-body">
        <Field label="Condition" required><TriggerSelect use="and" label="Condition" value={cond.key} onChange={(key) => onChange(blankCond(key))} /></Field>
        <CondParam cond={cond} onChange={onChange} o={o} />
        <TriggerNote k={cond.key} use="and" inSequence />
      </div>
      <IconButton icon="trash" label="Remove this condition" danger onClick={onRemove} />
    </div>
  );
}

function SequenceForm({ automation, password, o, onDone }: { automation: Automation | null; password?: string; o: Options; onDone: () => void }) {
  const d = automation?.def.kind === "sequence" ? automation.def : null;
  const [f, setF] = useState<FormState>(d && automation ? {
    name: automation.name, description: automation.description ?? "", review: automation.review, protect: automation.locked, password: "",
    blocks: d.blocks.map((b) => ({ trigger: b.trigger, when: b.when, actions: b.actions.map(actF) })), stops: d.stops, stopActions: d.stopActions.map(actF),
  } : { name: "", description: "", review: false, protect: false, password: "", blocks: [blankBlock()], stops: [], stopActions: [] });
  const [tried, setTried] = useState(false);
  const { busy, error, run } = useAction();
  const set = (p: Partial<FormState>) => setF({ ...f, ...p });
  const setBlock = (i: number, p: Partial<BlockF>) => set({ blocks: f.blocks.map((b, j) => (j === i ? { ...b, ...p } : b)) });

  const toAction = (x: ActF): AutomationAction => ({ waitMinutes: x.after ? x.waitMinutes : 0, action: x.action as ActionKey, templateId: x.templateId, employeeIds: x.employeeIds, tagId: x.tagId, todoTitle: x.todoTitle?.trim() || null });
  const stops = f.stops.filter((c) => c.key);
  const payload = () => ({
    kind: "sequence" as const, name: f.name.trim(), description: f.description.trim() || null, labels: automation?.labels ?? [], enabled: automation ? automation.enabled : true, review: f.review,
    blocks: f.blocks.map((b) => ({ trigger: b.trigger, when: b.when.filter((g) => g.length), actions: b.actions.map(toAction) })), stops, stopActions: f.stopActions.map(toAction),
    // A new password sets it; unticking takes it off; ticked with nothing typed keeps what's there.
    ...(f.protect ? (f.password ? { password: f.password } : {}) : automation?.locked ? { password: "" } : {}),
  });
  const problems: string[] = [];
  if (!f.name.trim()) problems.push("Sequence Title is required");
  f.blocks.forEach((b, i) => {
    const which = f.blocks.length > 1 ? (i ? `ELSE Trigger ${i}: ` : "IF Trigger: ") : "";
    if (!b.trigger.key) problems.push(`${which}choose the ${i ? "Trigger" : "IF Trigger"}`);
    if (b.when.flat().some((c) => !c.key)) problems.push(`${which}choose each Condition (or remove it)`);
    if (!b.actions.length) problems.push(`${which}add an Action`);
    if (b.actions.some((x) => !x.action)) problems.push(`${which}choose each Action`);
    if (b.actions.some((x) => x.after && !x.waitMinutes)) problems.push(`${which}enter the Waiting Period (or choose Instantly)`);
  });
  if (f.stops.slice(1).some((c) => !c.key)) problems.push("Stop When: choose each OR condition (or remove it)");
  if (f.stopActions.some((x) => !x.action)) problems.push("Stop Action: choose each Action");
  if (f.stopActions.length && !stops.length) problems.push("Stop Action: choose a Stop When first");
  if (f.protect && !f.password && !automation?.locked) problems.push("Enter the password to protect the sequence with");
  if (!problems.length) problems.push(...automationProblems(payload()));

  const hasText = [...f.blocks.flatMap((b) => b.actions), ...f.stopActions].some((x) => x.action && isTextAction(x.action));
  const save = () => {
    setTried(true);
    if (problems.length) return;
    run(async () => { await api(automation ? `/automations/${automation.id}` : "/automations", { method: automation ? "PUT" : "POST", body: payload(), headers: lockHeader(password) }); onDone(); });
  };
  const mainStop = f.stops[0] ?? blankCond();

  return (
    <div className="card hw-form hw-seq-form">
      <div className="hw-two">
        <Field label="Sequence Title" required><input value={f.name} maxLength={150} onChange={(e) => set({ name: e.target.value })} autoFocus={!automation} /></Field>
        <Field label="Sequence Description"><textarea rows={1} maxLength={2000} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      </div>
      <label className="check hw-check"><input type="checkbox" checked={f.review} onChange={(e) => set({ review: e.target.checked })} /> Review Before Execution <span className="hw-help">(If checked, this automation sequence will be reviewed before execution for any action performed in this sequence)</span></label>
      <div className="hw-two hw-password">
        <label className="check hw-check"><input type="checkbox" checked={f.protect} onChange={(e) => set({ protect: e.target.checked, password: "" })} /> Do you want to protect the Sequence with a password?</label>
        {f.protect && <input type="text" autoComplete="off" placeholder={automation?.locked ? "Password (leave empty to keep the one it has)" : "Password"} aria-label="Password" value={f.password} maxLength={100} onChange={(e) => set({ password: e.target.value })} />}
      </div>
      {(hasText || !automation) && <TextHours />}

      <div className="hw-rules">
        {!automation && <h5 className="hw-rules-title">Start/Stop Rules</h5>}
        {f.blocks.map((b, i) => (
          <div key={i}>
            {i > 0 && (
              <div className="hw-sep">
                <span className="hw-sep-pill">ELSE ↓ Trigger</span>
                <IconButton icon="trash" label="Remove this ELSE Trigger" onClick={() => set({ blocks: f.blocks.filter((_, j) => j !== i) })} />
              </div>
            )}
            <section className="hw-block" aria-label={i ? `ELSE Trigger ${i}` : "IF Trigger"}>
              <div className="hw-third">
                <Field label={i ? "Trigger" : "IF Trigger"} required><TriggerSelect use="if" label={i ? "Trigger" : "IF Trigger"} value={b.trigger.key} onChange={(key) => setBlock(i, { trigger: blankCond(key) })} /></Field>
                <CondParam cond={b.trigger} o={o} onChange={(trigger) => setBlock(i, { trigger })} />
                <TriggerNote k={b.trigger.key} use="if" inSequence />
              </div>
              {b.when.map((group, gi) => (
                <div key={gi} className="hw-cond-group">
                  {gi > 0 && (
                    <div className="hw-sep small">
                      <span className="hw-sep-pill">ELSE</span>
                      <IconButton icon="trash" label="Remove this group of conditions" danger onClick={() => setBlock(i, { when: b.when.filter((_, k) => k !== gi) })} />
                    </div>
                  )}
                  <div className="hw-cond-row">
                    {group.map((c, ci) => (
                      <ConditionCard key={ci} mark={gi > 0 && ci === 0 ? "-" : "&"} cond={c} o={o}
                        onChange={(nc) => setBlock(i, { when: b.when.map((g, k) => (k === gi ? g.map((x, m) => (m === ci ? nc : x)) : g)) })}
                        onRemove={() => setBlock(i, { when: b.when.map((g, k) => (k === gi ? g.filter((_, m) => m !== ci) : g)).filter((g) => g.length) })} />
                    ))}
                  </div>
                </div>
              ))}
              <div className="hw-actions">
                {b.actions.map((x, j) => (
                  <ActionRow key={j} act={x} o={o} onChange={(nx) => setBlock(i, { actions: b.actions.map((y, k) => (k === j ? nx : y)) })} onRemove={() => setBlock(i, { actions: b.actions.filter((_, k) => k !== j) })} />
                ))}
              </div>
              <div className="hw-block-buttons">
                <button type="button" className="btn hw-and" onClick={() => setBlock(i, { when: b.when.length ? b.when.map((g, k) => (k === b.when.length - 1 ? [...g, blankCond()] : g)) : [[blankCond()]] })}>AND Condition</button>
                <button type="button" className="btn hw-or" onClick={() => setBlock(i, { when: [...b.when, [blankCond()]] })}>OR Condition</button>
                <button type="button" className="btn hw-act" onClick={() => setBlock(i, { actions: [...b.actions, blankAct()] })}>Action</button>
              </div>
            </section>
          </div>
        ))}
        <div className="hw-top-right"><button type="button" className="btn hw-and" disabled={f.blocks.length >= 10} onClick={() => set({ blocks: [...f.blocks, blankBlock()] })}>ELSE Trigger</button></div>

        <section className="hw-block hw-stop" aria-label="Stop When">
          <div className="hw-third">
            <Field label="Stop When"><TriggerSelect use="stop" label="Stop When" value={mainStop.key} onChange={(key) => set({ stops: key ? [blankCond(key), ...f.stops.slice(1)] : f.stops.slice(1) })} /></Field>
            <CondParam cond={mainStop} o={o} onChange={(c) => set({ stops: [c, ...f.stops.slice(1)] })} />
            <TriggerNote k={mainStop.key} use="stop" inSequence />
          </div>
          <div className="hw-cond-row">
            {f.stops.slice(1).map((c, j) => (
              <div key={j} className="hw-cond-card stop-or">
                <span className="hw-cond-mark or" aria-hidden="true">OR</span>
                <div className="hw-cond-body">
                  <Field label="when" required><TriggerSelect use="stop" label="OR when" value={c.key} onChange={(key) => set({ stops: f.stops.map((x, k) => (k === j + 1 ? blankCond(key) : x)) })} /></Field>
                  <CondParam cond={c} o={o} onChange={(nc) => set({ stops: f.stops.map((x, k) => (k === j + 1 ? nc : x)) })} />
                  <TriggerNote k={c.key} use="stop" inSequence />
                </div>
                <IconButton icon="trash" label="Remove this stop condition" danger onClick={() => set({ stops: f.stops.filter((_, k) => k !== j + 1) })} />
              </div>
            ))}
          </div>
          <div className="hw-actions">
            {f.stopActions.map((x, j) => (
              <ActionRow key={j} act={x} o={o} onChange={(nx) => set({ stopActions: f.stopActions.map((y, k) => (k === j ? nx : y)) })} onRemove={() => set({ stopActions: f.stopActions.filter((_, k) => k !== j) })} />
            ))}
          </div>
          <div className="hw-block-buttons">
            <button type="button" className="btn hw-or" onClick={() => set({ stops: [...(f.stops.length ? f.stops : [blankCond()]), blankCond()] })}>OR Stop Condition</button>
            <button type="button" className="btn hw-act" onClick={() => set({ stopActions: [...f.stopActions, blankAct()] })}>Stop Action</button>
          </div>
        </section>
      </div>

      {tried && problems.length > 0 && <div className="hw-errors" role="alert">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
      <ErrorBox error={error} />
      <div className="hw-form-foot">
        <button type="button" className="btn hw-soft" onClick={onDone}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{automation ? "Update Sequence" : "Create Automation Sequence"}</button>
      </div>
    </div>
  );
}

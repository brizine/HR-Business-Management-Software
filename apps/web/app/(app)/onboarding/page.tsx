"use client";
import Link from "next/link";
import { useState } from "react";
import { TASK_ACTIONS, type TaskAction } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { OnboardingTask } from "@/components/onboarding-task";

const ACTION_LABELS: Record<TaskAction, string> = { none: "Check off", upload: "Upload a document", sign: "Sign a document" };

function MyTasks() {
  const { data, reload } = useApi<any[]>("/onboarding/tasks");
  if (!data?.length) return null;
  const mine = data.filter((t) => t.assignee === "employee");
  const left = mine.filter((t) => !t.completedAt).length;
  return (
    <div className="card">
      <h2>My onboarding checklist</h2>
      <p className="muted" style={{ marginTop: 0 }}>{left ? `${left} of ${mine.length} left. Upload tasks accept a photo from your phone.` : "All done. Thanks!"}</p>
      <table><tbody>{data.map((t) => <OnboardingTask key={t.id} task={t} mode="self" onChange={reload} />)}</tbody></table>
    </div>
  );
}

function WaitingOnMe() {
  const { data, reload } = useApi<any[]>("/onboarding/assigned");
  if (!data?.length) return null;
  return (
    <div className="card">
      <h2>Waiting on you ({data.length})</h2>
      <table><tbody>{data.map((t) => (
        <OnboardingTask key={t.id} mode="manager" onChange={reload}
          task={{ ...t, title: `${t.title}: ${t.employee.name}`, description: t.employee.startDate ? `starts ${fmtDate(t.employee.startDate)}` : t.description }} />
      ))}</tbody></table>
    </div>
  );
}

type TaskDraft = { title: string; assignee: string; dueInDays: number; action: TaskAction; documentId: string };
const blank = (): TaskDraft => ({ title: "", assignee: "employee", dueInDays: 0, action: "none", documentId: "" });

function TemplateBuilder({ onSaved }: { onSaved: () => void }) {
  const companyDocs = useApi<any[]>("/documents");
  const docs = (companyDocs.data ?? []).filter((d) => !d.employeeId && !d.assetId);
  const [name, setName] = useState("");
  const [tasks, setTasks] = useState<TaskDraft[]>([blank()]);
  const { busy, error, run } = useAction();
  const set = (i: number, patch: Partial<TaskDraft>) => setTasks(tasks.map((t, j) => (i === j ? { ...t, ...patch } : t)));

  return (
    <div className="card">
      <h2>New checklist template</h2>
      <div className="stack">
        <label>Template name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Field crew onboarding" /></label>
        {tasks.map((t, i) => (
          <div className="formgrid" key={i} style={{ borderTop: i ? "1px solid var(--border)" : undefined, paddingTop: i ? 10 : 0 }}>
            <label>Task<input value={t.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="e.g. Upload driver's license" /></label>
            <label>Who does it
              <select value={t.assignee} onChange={(e) => set(i, { assignee: e.target.value, ...(e.target.value !== "employee" ? { action: "none" as const } : {}) })}>
                <option value="employee">New hire</option><option value="manager">Their manager</option><option value="admin">An admin</option>
              </select>
            </label>
            <label>To finish it
              <select value={t.action} disabled={t.assignee !== "employee"} onChange={(e) => set(i, { action: e.target.value as TaskAction })}>
                {TASK_ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
              </select>
            </label>
            {t.action === "sign" && (
              <label>Document to sign
                <select value={t.documentId} onChange={(e) => set(i, { documentId: e.target.value })}>
                  <option value="">Choose…</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            <label>Due (days after start)<input type="number" min="0" value={t.dueInDays} onChange={(e) => set(i, { dueInDays: Number(e.target.value) })} /></label>
            <div style={{ alignSelf: "end" }}><button className="btn sm danger" onClick={() => setTasks(tasks.filter((_, j) => j !== i))}>Remove</button></div>
          </div>
        ))}
        {tasks.some((t) => t.action === "sign") && !docs.length && (
          <p className="muted">Upload the document to sign (e.g. your handbook) on the <Link href="/documents">Documents</Link> page first, as a company-wide document.</p>
        )}
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn" onClick={() => setTasks([...tasks, blank()])}>+ Task</button>
          <button className="btn primary" disabled={busy || !name} onClick={() => run(async () => {
            await api("/onboarding/templates", { body: {
              name,
              tasks: tasks.filter((t) => t.title).map((t) => ({ ...t, documentId: t.action === "sign" ? t.documentId || null : null })),
            } });
            setName(""); setTasks([blank()]); onSaved();
          })}>Save template</button>
        </div>
      </div>
    </div>
  );
}

export default function Onboarding() {
  const { can } = useAuth();
  const progress = useApi<any[]>(can("manager") ? "/onboarding/progress" : null);
  const templates = useApi<any[]>(can("manager") ? "/onboarding/templates" : null);

  return (
    <>
      <PageHead title="Onboarding" sub="Checklists that take new hires from offer to first day" />
      <MyTasks />
      {can("manager") && (
        <>
          <WaitingOnMe />
          <div className="card">
            <h2>New hires in progress</h2>
            {progress.data?.length ? (
              <table><tbody>{progress.data.map((p) => (
                <tr key={p.employeeId}>
                  <td>
                    <Link href={`/people/${p.employeeId}`}>{p.name}</Link>
                    <div className="muted">
                      Starts {fmtDate(p.startDate)} · {p.hasLogin ? "Account set up" : p.invitedAt ? `Invited ${fmtDate(p.invitedAt)}, not signed up yet` : "Not invited"}
                    </div>
                  </td>
                  <td style={{ width: "40%" }}>
                    <div className="progress"><div style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} /></div>
                    <div className="muted">{p.done} of {p.total} tasks {p.overdue > 0 && <Badge value="overdue" />}</div>
                  </td>
                </tr>
              ))}</tbody></table>
            ) : <Empty>No one is onboarding right now.</Empty>}
          </div>
          <div className="card">
            <h2>Checklist templates</h2>
            {templates.data?.length ? templates.data.map((t) => (
              <details key={t.id} style={{ padding: "6px 0" }}>
                <summary><strong>{t.name}</strong> <span className="muted">({t.tasks.length} tasks)</span></summary>
                <ul>{t.tasks.map((x: any, i: number) => (
                  <li key={i}>{x.title} <span className="muted">· {x.assignee === "employee" ? "new hire" : x.assignee} · day {x.dueInDays}{x.action && x.action !== "none" ? ` · ${ACTION_LABELS[x.action as TaskAction].toLowerCase()}` : ""}</span></li>
                ))}</ul>
                {can("admin") && <button className="btn sm danger" onClick={() => confirm(`Delete "${t.name}"? Checklists already started aren't affected.`) && api(`/onboarding/templates/${t.id}`, { method: "DELETE" }).then(templates.reload)}>Delete template</button>}
              </details>
            )) : <Empty>No templates yet.</Empty>}
          </div>
          {can("admin") && <TemplateBuilder onSaved={templates.reload} />}
        </>
      )}
    </>
  );
}

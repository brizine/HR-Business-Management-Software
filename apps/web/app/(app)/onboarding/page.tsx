"use client";
import Link from "next/link";
import { useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";

function MyTasks() {
  const { data, reload } = useApi<any[]>("/onboarding/tasks");
  if (!data?.length) return null;
  return (
    <div className="card">
      <h2>My onboarding tasks</h2>
      <table><tbody>{data.map((t) => (
        <tr key={t.id}>
          <td>{t.title}{t.requiresDocument && <div className="muted">Upload the document on the Documents page</div>}</td>
          <td>Due {fmtDate(t.dueDate)}</td>
          <td>{t.completedAt ? <Badge value="completed" /> : t.assignee === "employee"
            ? <button className="btn sm primary" onClick={() => api(`/onboarding/tasks/${t.id}/complete`, { method: "POST" }).then(reload)}>Done</button>
            : <span className="muted">Waiting on {t.assignee}</span>}</td>
        </tr>
      ))}</tbody></table>
    </div>
  );
}

function TemplateBuilder({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [tasks, setTasks] = useState([{ title: "", assignee: "employee", dueInDays: 0, requiresDocument: false }]);
  const { busy, error, run } = useAction();
  const set = (i: number, patch: object) => setTasks(tasks.map((t, j) => (i === j ? { ...t, ...patch } : t)));

  return (
    <div className="card">
      <h2>New checklist template</h2>
      <div className="stack">
        <label>Template name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Field crew onboarding" /></label>
        {tasks.map((t, i) => (
          <div className="formgrid" key={i}>
            <label>Task<input value={t.title} onChange={(e) => set(i, { title: e.target.value })} /></label>
            <label>Assigned to
              <select value={t.assignee} onChange={(e) => set(i, { assignee: e.target.value })}>
                <option>employee</option><option>manager</option><option>admin</option>
              </select>
            </label>
            <label>Due (days after start)<input type="number" min="0" value={t.dueInDays} onChange={(e) => set(i, { dueInDays: Number(e.target.value) })} /></label>
            <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={t.requiresDocument} onChange={(e) => set(i, { requiresDocument: e.target.checked })} /> Needs document</label>
          </div>
        ))}
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn" onClick={() => setTasks([...tasks, { title: "", assignee: "employee", dueInDays: 0, requiresDocument: false }])}>+ Task</button>
          <button className="btn primary" disabled={busy} onClick={() => run(async () => {
            await api("/onboarding/templates", { body: { name, tasks: tasks.filter((t) => t.title) } });
            setName(""); setTasks([{ title: "", assignee: "employee", dueInDays: 0, requiresDocument: false }]); onSaved();
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
          <div className="card">
            <h2>New hires in progress</h2>
            {progress.data?.length ? (
              <table><tbody>{progress.data.map((p) => (
                <tr key={p.employeeId}>
                  <td><Link href={`/people/${p.employeeId}`}>{p.name}</Link><div className="muted">Starts {fmtDate(p.startDate)}</div></td>
                  <td style={{ width: "40%" }}>
                    <div className="progress"><div style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} /></div>
                    <div className="muted">{p.done} of {p.total} tasks</div>
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
                <ul>{t.tasks.map((x: any, i: number) => <li key={i}>{x.title} <span className="muted">· {x.assignee} · day {x.dueInDays}</span></li>)}</ul>
              </details>
            )) : <Empty>No templates yet.</Empty>}
          </div>
          {can("admin") && <TemplateBuilder onSaved={templates.reload} />}
        </>
      )}
    </>
  );
}

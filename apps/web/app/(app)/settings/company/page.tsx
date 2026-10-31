"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { EmployeeLayoutEditor, TeamFilterLayoutEditor } from "@/components/layout-editor";
import { PageLayoutsCard } from "@/components/page-layout";

type Kind = "jobTitles" | "departments";
type Menus = { jobTitles: string[]; departments: string[]; usage: Record<Kind, Record<string, number>> };

/** One editable menu: add, rename (updates everyone who has it), reorder, remove. */
function MenuEditor({ kind, title, noun, data, onChange }: { kind: Kind; title: string; noun: string; data: Menus; onChange: (m: Menus) => void }) {
  const list = data[kind];
  const usage = data.usage[kind];
  const [adding, setAdding] = useState("");
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<Menus>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveList = (next: string[]) => run(() => api<Menus>("/employees/menus", { method: "PUT", body: { jobTitles: data.jobTitles, departments: data.departments, [kind]: next } }));
  const move = (i: number, to: number) => { const next = [...list]; const [v] = next.splice(i, 1); next.splice(to, 0, v); saveList(next); };
  const unlisted = Object.keys(usage).filter((v) => !list.includes(v)).sort();

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p className="muted" style={{ margin: 0 }}>The choices in the {title.toLowerCase()} menu on the employee and hiring forms, in this order.</p>
      {list.length ? (
        <ol className="menu-list">
          {list.map((v, i) => (
            <li key={v}>
              {renaming?.from === v ? (
                <form className="row" style={{ flex: 1 }} onSubmit={async (e) => {
                  e.preventDefault();
                  if (renaming.to.trim() === v) return setRenaming(null);
                  if (await run(() => api<Menus>("/employees/menus/rename", { body: { kind, from: v, to: renaming.to } }))) setRenaming(null);
                }}>
                  <input autoFocus value={renaming.to} onChange={(e) => setRenaming({ from: v, to: e.target.value })} aria-label={`New name for ${v}`} maxLength={80} required style={{ flex: 1, minWidth: 140 }} />
                  <button className="btn sm primary" disabled={busy}>Save</button>
                  <button type="button" className="btn sm" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span style={{ flex: 1 }}>{v}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{usage[v] ? `${usage[v]} ${usage[v] === 1 ? "person" : "people"}` : "not used"}</span>
                  <button type="button" className="btn sm" disabled={busy || i === 0} aria-label={`Move ${v} up`} onClick={() => move(i, i - 1)}>↑</button>
                  <button type="button" className="btn sm" disabled={busy || i === list.length - 1} aria-label={`Move ${v} down`} onClick={() => move(i, i + 1)}>↓</button>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => setRenaming({ from: v, to: v })}>Rename</button>
                  <button type="button" className="btn sm danger" disabled={busy} onClick={() =>
                    confirm(usage[v] ? `Take "${v}" off the list? The ${usage[v]} ${usage[v] === 1 ? "person who has it keeps" : "people who have it keep"} it until someone changes it.` : `Take "${v}" off the list?`)
                    && saveList(list.filter((x) => x !== v))}>Remove</button>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : <p className="muted" style={{ margin: 0 }}>No {noun}s yet.</p>}
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        const v = adding.trim();
        if (!v) return;
        if (list.includes(v)) return setError(`"${v}" is already on the list`);
        if (await saveList([...list, v])) setAdding("");
      }}>
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={`New ${noun}`} aria-label={`New ${noun}`} maxLength={80} style={{ flex: 1, maxWidth: 320 }} />
        <button className="btn primary" disabled={busy || !adding.trim()}>Add</button>
      </form>
      {unlisted.length > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          In use but not on the list: {unlisted.map((v, i) => (
            <span key={v}>{i > 0 && ", "}{v} <button type="button" className="btn sm" disabled={busy} onClick={() => saveList([...list, v])}>Add</button></span>
          ))}
        </p>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

export default function CompanySettings() {
  const { can } = useAuth();
  const menus = useApi<Menus>(can("owner") ? "/employees/menus" : null);
  return (
    <>
      <PageHead title="Company settings" sub="Owner only. Page layouts and the choices people pick from across Crewdesk." />
      <SettingsTabs />
      {!can("owner") ? <p className="muted">Only the owner can change company settings.</p> : !menus.data ? <ErrorBox error={menus.error} /> : (
        <>
        <PageLayoutsCard />
        <EmployeeLayoutEditor />
        <TeamFilterLayoutEditor />
        <div className="grid cols-2" style={{ alignItems: "start" }}>
          <MenuEditor kind="jobTitles" title="Job titles" noun="job title" data={menus.data} onChange={menus.setData} />
          <MenuEditor kind="departments" title="Departments" noun="department" data={menus.data} onChange={menus.setData} />
        </div>
        </>
      )}
    </>
  );
}

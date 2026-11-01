"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { MENU_LISTS, defaultLabel, type MenuKey, type StoredList } from "@crewdesk/shared";
import { useMenuData, type Menus } from "@/lib/menus";
import { ErrorBox } from "./ui";

type Kind = "jobTitles" | "departments" | StoredList;

/** One editable list: add, rename (updates everything that uses it), reorder, remove. */
export function MenuEditor({ kind, title, noun, data, onChange }: { kind: Kind; title: string; noun: string; data: Menus; onChange: (m: Menus) => void }) {
  const list = data[kind];
  const usage = data.usage[kind] ?? {};
  const own = kind === "jobTitles" || kind === "departments";
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
  const saveList = (next: string[]) => run(() => own
    ? api<Menus>("/employees/menus", { method: "PUT", body: { jobTitles: data.jobTitles, departments: data.departments, [kind]: next } })
    : api<Menus>(`/employees/menus/lists/${kind}`, { method: "PUT", body: { values: next } }));
  const move = (i: number, to: number) => { const next = [...list]; const [v] = next.splice(i, 1); next.splice(to, 0, v); saveList(next); };
  const unlisted = Object.keys(usage).filter((v) => !list.includes(v)).sort();

  return (
    <section className="stack menu-section" aria-label={title}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      <p className="muted" style={{ margin: 0 }}>The choices in the {title.toLowerCase()} menu, in this order. Renaming one updates everything that uses it.</p>
      {list.length ? (
        <ol className="menu-list">
          {list.map((v, i) => (
            <li key={v}>
              {renaming?.from === v ? (
                <form className="row" style={{ flex: 1 }} onSubmit={async (e) => {
                  e.preventDefault();
                  if (renaming.to.trim() === v) return setRenaming(null);
                  if (await run(() => (own ? api<Menus>("/employees/menus/rename", { body: { kind, from: v, to: renaming.to } }) : api<Menus>(`/employees/menus/lists/${kind}/rename`, { body: { from: v, to: renaming.to } })))) setRenaming(null);
                }}>
                  <input autoFocus value={renaming.to} onChange={(e) => setRenaming({ from: v, to: e.target.value })} aria-label={`New name for ${v}`} maxLength={80} required style={{ flex: 1, minWidth: 140 }} />
                  <button className="btn sm primary" disabled={busy}>Save</button>
                  <button type="button" className="btn sm" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span style={{ flex: 1 }}>{v}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{usage[v] ? `${usage[v]} in use` : "not used"}</span>
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
    </section>
  );
}

/** Fixed choices: Crewdesk acts on these, so only their wording can change. */
function LabelEditor({ menu, data, onChange }: { menu: Extract<(typeof MENU_LISTS)[number], { kind: "labels" }>; data: Menus; onChange: (m: Menus) => void }) {
  const current = data.labels[menu.key] ?? {};
  const [draft, setDraft] = useState<Record<string, string>>(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = menu.values.some((v) => (draft[v] ?? "") !== (current[v] ?? ""));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<Menus>(`/employees/menus/labels/${menu.key}`, { method: "PUT", body: { labels: Object.fromEntries(menu.values.map((v) => [v, draft[v] || null])) } }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack menu-section" aria-label={menu.label}>
      <h3 style={{ margin: 0 }}>{menu.label}</h3>
      <p className="muted" style={{ margin: 0 }}>Crewdesk acts on these choices, so they can&apos;t be added or removed, but you can change how each one reads.</p>
      <ol className="menu-list">
        {menu.values.map((v) => (
          <li key={v}>
            <span style={{ width: 130, flex: "none" }} className="muted">{defaultLabel(v)}</span>
            <input value={draft[v] ?? ""} placeholder={defaultLabel(v)} maxLength={60} aria-label={`New wording for ${defaultLabel(v)}`} style={{ flex: 1, minWidth: 120 }}
              onChange={(e) => { setDraft({ ...draft, [v]: e.target.value }); setSaved(false); }} />
          </li>
        ))}
      </ol>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary sm" disabled={busy || !changed} onClick={save}>Save wording</button>
        {saved && !changed && <span className="muted" role="status">Saved.</span>}
      </div>
    </section>
  );
}

/** Editors for the given drop-down menus (the layout editor passes the current page's). */
export function MenuEditors({ keys }: { keys?: readonly MenuKey[] }) {
  const { menus, setMenus } = useMenuData();
  const shown = MENU_LISTS.filter((m) => !keys || keys.includes(m.key));
  return (
    <div className="menu-sections">
      {shown.map((m) => m.kind === "labels"
        ? <LabelEditor key={m.key} menu={m} data={menus} onChange={setMenus} />
        : <MenuEditor key={m.key} kind={m.key as Kind} title={m.label} noun={m.noun} data={menus} onChange={setMenus} />)}
    </div>
  );
}

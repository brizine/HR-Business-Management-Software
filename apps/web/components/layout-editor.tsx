"use client";
import { useEffect, useState } from "react";
import { PROFILE_FIELDS, TEAM_FILTERS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";

type Item = { key: string; label: string };
type Layout = { order: string[]; hidden: string[] };

/**
 * Owner, in Settings → Company: drag items into order (↑ ↓ do the same without a mouse) and,
 * when `hideable`, untick ones to hide. Nothing changes for anyone until Save.
 */
function LayoutEditor({ title, description, items, saved, hideable, onSave }: {
  title: string; description: string; items: readonly Item[]; saved: Layout; hideable?: boolean; onSave: (l: Layout) => Promise<Layout>;
}) {
  const labels = Object.fromEntries(items.map((i) => [i.key, i.label]));
  const [draft, setDraft] = useState(saved);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const changed = draft.order.join() !== saved.order.join() || [...draft.hidden].sort().join() !== [...saved.hidden].sort().join();

  const edit = (next: Layout) => { setDraft(next); setDone(false); };
  const move = (key: string, to: number) => {
    const order = draft.order.filter((k) => k !== key);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, key);
    edit({ ...draft, order });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p className="muted" style={{ margin: 0 }}>{description}</p>
      <ol className="field-order-list" aria-label={title}>
        {draft.order.map((key, i) => {
          const hidden = draft.hidden.includes(key);
          return (
            <li
              key={key}
              draggable
              className={`${dragging === key ? "dragging" : ""}${hidden ? " is-hidden" : ""}`}
              onDragStart={(ev) => { setDragging(key); ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", key); }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(ev) => { ev.preventDefault(); if (dragging && dragging !== key) move(dragging, i); }}
              onDrop={(ev) => ev.preventDefault()}
            >
              <span className="drag-handle" aria-hidden="true">⠿</span>
              <span className="field-order-num">{i + 1}</span>
              {hideable && (
                <input type="checkbox" checked={!hidden} title={hidden ? "Hidden. Tick to show." : "Shown. Untick to hide."} aria-label={`Show ${labels[key]}`}
                  onChange={() => edit({ ...draft, hidden: hidden ? draft.hidden.filter((k) => k !== key) : [...draft.hidden, key] })} />
              )}
              <span style={{ flex: 1 }}>{labels[key]}{hidden && <span className="muted"> (hidden)</span>}</span>
              <button type="button" className="btn sm" aria-label={`Move ${labels[key]} up`} disabled={i === 0} onClick={() => move(key, i - 1)}>↑</button>
              <button type="button" className="btn sm" aria-label={`Move ${labels[key]} down`} disabled={i === draft.order.length - 1} onClick={() => move(key, i + 1)}>↓</button>
            </li>
          );
        })}
      </ol>
      <ErrorBox error={error} />
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !changed} onClick={save}>{busy ? "Saving…" : "Save layout"}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => edit({ order: items.map((i) => i.key), hidden: [] })}>Reset to default</button>
        {changed && <button type="button" className="btn" disabled={busy} onClick={() => setDraft(saved)}>Undo changes</button>}
        {done && !changed && <span className="muted" role="status">Saved. Everyone now sees this layout.</span>}
      </div>
    </div>
  );
}

/** The order of the details on every employee page. */
export function EmployeeLayoutEditor() {
  const saved = useApi<{ order: string[] }>("/employees/field-order");
  if (!saved.data) return <ErrorBox error={saved.error} />;
  return (
    <LayoutEditor
      title="Employee page layout"
      description="The order of the details on every employee's page. Drag them by the ⠿ handle (or use ↑ ↓), then Save layout. People still only see the details they're allowed to."
      items={PROFILE_FIELDS}
      saved={{ order: saved.data.order, hidden: [] }}
      onSave={async (l) => { const res = await api<{ order: string[] }>("/employees/field-order", { method: "PUT", body: { order: l.order } }); saved.setData(res); return { order: res.order, hidden: [] }; }}
    />
  );
}

/** The order of the Team page's filters, and which ones show. */
export function TeamFilterLayoutEditor() {
  const saved = useApi<Layout>("/employees/team-filters");
  if (!saved.data) return <ErrorBox error={saved.error} />;
  return (
    <LayoutEditor
      title="Team page filters"
      description="The order of the filters on the Team page. Drag them (or use ↑ ↓), untick any you don't want shown, then Save layout. Pay filters only ever show for managers and up."
      items={TEAM_FILTERS}
      saved={saved.data}
      hideable
      onSave={async (l) => { const res = await api<Layout>("/employees/team-filters", { method: "PUT", body: l }); saved.setData(res); return res; }}
    />
  );
}

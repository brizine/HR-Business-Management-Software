"use client";
import { useState } from "react";
import { TAG_COLORS } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { SettingsTabs } from "@/components/settings-tabs";
import { TagChip, useTags, type Tag } from "@/components/customers";

/** Customer settings (admins in Customers & billing): the tag list and the cancellation reasons. */
export default function CustomerSettings() {
  const { can } = useAuth();
  return (
    <>
      <SettingsTabs />
      <PageHead title="Customers" sub="Tags and cancellation reasons used on customers and properties." />
      {can("admin", "customers") ? <><TagsCard /><ReasonsCard /></> : <p className="muted">Only admins in Customers &amp; billing can change these.</p>}
    </>
  );
}

function TagsCard() {
  const { tags, reload } = useTags();
  const [editing, setEditing] = useState<Tag | "new" | null>(null);
  const [merging, setMerging] = useState<Tag | null>(null);
  const action = useAction();
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Tags</h2>
        <button className="btn primary" onClick={() => setEditing("new")}>Add tag</button>
      </div>
      <p className="muted">Staff pick from this list, so the same thing isn&apos;t tagged three ways. Archiving hides a tag from new use but keeps it where it is.</p>
      {editing && <TagForm tag={editing === "new" ? null : editing} onDone={() => { setEditing(null); reload(); }} />}
      {merging && (
        <form className="card inset row" onSubmit={(e) => {
          e.preventDefault();
          const intoId = (new FormData(e.currentTarget).get("into") as string) || "";
          action.run(async () => { await api(`/crm/tags/${merging.id}/merge`, { body: { intoId } }); setMerging(null); reload(); });
        }}>
          <span>Merge <TagChip tag={merging} /> into</span>
          <select name="into" required>{tags.filter((t) => t.id !== merging.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <button className="btn primary" disabled={action.busy}>Merge</button>
          <button type="button" className="btn" onClick={() => setMerging(null)}>Cancel</button>
        </form>
      )}
      <ErrorBox error={action.error} />
      {tags.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Tag</th><th>Description</th><th>Customers</th><th>Properties</th><th /></tr></thead>
            <tbody>{tags.map((t) => (
              <tr key={t.id} style={t.archived ? { opacity: 0.6 } : undefined}>
                <td><TagChip tag={t} />{t.archived && <span className="muted"> archived</span>}</td>
                <td>{t.description ?? ""}</td>
                <td>{t.customers}</td>
                <td>{t.properties}</td>
                <td className="row">
                  <button className="btn" onClick={() => setEditing(t)}>Edit</button>
                  <button className="btn" onClick={() => setMerging(t)}>Merge…</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No tags yet. Try &quot;Commercial&quot;, &quot;HOA&quot;, &quot;Dog in yard&quot;, &quot;Gate code needed&quot;, &quot;VIP&quot;.</Empty>}
    </div>
  );
}

function TagForm({ tag, onDone }: { tag: Tag | null; onDone: () => void }) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? "gray");
  const [description, setDescription] = useState(tag?.description ?? "");
  const [archived, setArchived] = useState(tag?.archived ?? false);
  const { busy, error, run } = useAction();
  return (
    <form className="card inset stack" onSubmit={(e) => {
      e.preventDefault();
      const body = { name, color, archived, ...(description.trim() ? { description } : {}) };
      run(async () => { await api(tag ? `/crm/tags/${tag.id}` : "/crm/tags", { method: tag ? "PUT" : "POST", body }); onDone(); });
    }}>
      <div className="formgrid">
        <label>Name<input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Color
          <select value={color} onChange={(e) => setColor(e.target.value)}>{TAG_COLORS.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select>
        </label>
        <label>Description<input maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </div>
      <div className="row">Preview: <TagChip tag={{ name: name || "Tag", color }} />{tag && <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>}</div>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function ReasonsCard() {
  const reasons = useApi<any[]>("/crm/cancel-reasons");
  const [editing, setEditing] = useState<any | "new" | null>(null);
  const action = useAction();
  const list = reasons.data ?? [];
  const move = (i: number, d: number) => {
    const ids = list.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    action.run(async () => { reasons.setData(await api("/crm/cancel-reasons-order", { method: "PUT", body: { ids } })); });
  };
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Cancellation reasons</h2>
        <button className="btn primary" onClick={() => setEditing("new")}>Add reason</button>
      </div>
      <p className="muted">The drop-down shown when a customer or property is cancelled. Retired reasons stay on past cancellations.</p>
      {editing && <ReasonForm reason={editing === "new" ? null : editing} onDone={() => { setEditing(null); reasons.reload(); }} />}
      <ErrorBox error={action.error} />
      <ol className="plain-list">
        {list.map((r, i) => (
          <li key={r.id} className="row" style={{ justifyContent: "space-between", opacity: r.retired ? 0.6 : 1 }}>
            <span><strong>{r.label}</strong> <span className="muted">{r.initiatedBy === "company" ? "our decision" : "customer's decision"}{r.commentRequired ? " · comment required" : ""}{r.retired ? " · retired" : ""}</span></span>
            <span className="row">
              <button className="btn" aria-label={`Move ${r.label} up`} disabled={i === 0 || action.busy} onClick={() => move(i, -1)}>↑</button>
              <button className="btn" aria-label={`Move ${r.label} down`} disabled={i === list.length - 1 || action.busy} onClick={() => move(i, 1)}>↓</button>
              <button className="btn" onClick={() => setEditing(r)}>Edit</button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReasonForm({ reason, onDone }: { reason: any | null; onDone: () => void }) {
  const [label, setLabel] = useState(reason?.label ?? "");
  const [initiatedBy, setInitiatedBy] = useState(reason?.initiatedBy ?? "customer");
  const [commentRequired, setCommentRequired] = useState(!!reason?.commentRequired);
  const [retired, setRetired] = useState(!!reason?.retired);
  const { busy, error, run } = useAction();
  return (
    <form className="card inset stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => { await api(reason ? `/crm/cancel-reasons/${reason.id}` : "/crm/cancel-reasons", { method: reason ? "PUT" : "POST", body: { label, initiatedBy, commentRequired, retired } }); onDone(); });
    }}>
      <div className="formgrid">
        <label>Reason<input required maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label>Whose decision
          <select value={initiatedBy} onChange={(e) => setInitiatedBy(e.target.value)}>
            <option value="customer">The customer&apos;s</option>
            <option value="company">Ours (e.g. non-payment)</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={commentRequired} onChange={(e) => setCommentRequired(e.target.checked)} /> Comment required</label>
        {reason && <label className="check"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> Retired</label>}
      </div>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

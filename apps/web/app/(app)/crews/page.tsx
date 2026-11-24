"use client";
import Link from "next/link";
import { useState } from "react";
import { TODO_COLORS, isInactive } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi, useNewForm } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Crew {
  id: string; name: string; color: string; leadId: string | null; assetId: string | null; assetName: string | null; notes: string | null; active: boolean; dailyHours?: number;
  members: { id: string; firstName: string; lastName: string; title: string | null; status: string }[]; memberIds: string[];
}

/** Crews (like Homeworks'): named teams with a lead, members and their truck. Work orders go to a crew. */
export default function Crews() {
  const { can } = useAuth();
  const manager = can("manager", "customers");
  const list = useApi<Crew[]>("/crews?all=1");
  const [editing, setEditing] = useState<Crew | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useNewForm(() => { if (manager) setEditing("new"); });
  const crews = list.data ?? [];
  return (
    <>
      <PageHead title="Crews" sub="Teams that work orders go to: a crew lead, the members and the truck they take.">
        <Link className="btn" href="/visits">Work orders</Link>
        {manager && <button className="btn primary" onClick={() => setEditing("new")}>Add crew</button>}
      </PageHead>
      {notice && <div className="notice" role="status">{notice} <button type="button" className="linkbtn" onClick={() => setNotice(null)}>OK</button></div>}
      {editing && (
        <CrewForm crew={editing === "new" ? null : editing} onCancel={() => setEditing(null)} onDeleted={() => { setEditing(null); list.reload(); setNotice("Crew deleted. Its work orders keep their people."); }}
          onSaved={(c, updated) => { setEditing(null); list.reload(); setNotice(`Saved ${c.name}.${updated ? ` ${updated} open work order${updated === 1 ? "" : "s"} updated with the new members.` : ""}`); }} />
      )}
      <ErrorBox error={list.error} />
      {crews.length ? (
        <div className="crew-grid" data-lkeep="1">
          {crews.map((c) => (
            <div key={c.id} className="card crew-card" style={{ borderTopColor: c.color, opacity: c.active ? 1 : 0.6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}><span className="visit-dot" style={{ background: c.color }} />{c.name}</h2>
                {!c.active && <span className="badge">inactive</span>}
              </div>
              <ul className="plain-list crew-members">
                {c.members.map((m) => (
                  <li key={m.id}>{m.firstName} {m.lastName}{m.id === c.leadId ? <span className="badge" style={{ marginLeft: 6 }}>lead</span> : null}{m.title ? <span className="muted"> · {m.title}</span> : null}</li>
                ))}
                {!c.members.length && <li className="muted">Nobody on this crew yet</li>}
              </ul>
              {c.assetName && <div className="muted">Truck: {c.assetId ? <Link href={`/fleet/${c.assetId}`}>{c.assetName}</Link> : c.assetName}</div>}
              {c.notes && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{c.notes}</div>}
              <div className="row">
                <Link className="btn" href={`/visits?crew=${c.id}`}>Work orders</Link>
                {manager && <button className="btn" onClick={() => setEditing(c)}>Edit</button>}
              </div>
            </div>
          ))}
        </div>
      ) : list.data ? <div className="card"><Empty>No crews yet.{manager ? " Add one for each team you send out, like “Spray crew” or “Mowing 1”." : ""}</Empty></div> : null}
    </>
  );
}

function CrewForm({ crew, onSaved, onCancel, onDeleted }: { crew: Crew | null; onSaved: (c: Crew, updated: number) => void; onCancel: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(crew?.name ?? "");
  const [color, setColor] = useState(crew?.color ?? TODO_COLORS[0].key);
  const [leadId, setLeadId] = useState(crew?.leadId ?? "");
  const [members, setMembers] = useState<string[]>(crew?.memberIds.filter((id) => id !== crew.leadId) ?? []);
  const [assetId, setAssetId] = useState(crew?.assetId ?? "");
  const [notes, setNotes] = useState(crew?.notes ?? "");
  const [active, setActive] = useState(crew?.active ?? true);
  const [dailyHours, setDailyHours] = useState(String(crew?.dailyHours ?? 8));
  const [updateOpen, setUpdateOpen] = useState(true);
  const staff = useApi<any[]>("/employees");
  const assets = useApi<any[]>("/assets");
  const save = useAction();
  const del = useAction();
  const team = (staff.data ?? []).filter((e) => !isInactive(e.status) || members.includes(e.id) || e.id === leadId);
  const changedPeople = crew && (leadId !== (crew.leadId ?? "") || [...members].sort().join() !== crew.memberIds.filter((id) => id !== crew.leadId).sort().join());
  return (
    <form className="card stack todo-form" onSubmit={(e) => {
      e.preventDefault();
      save.run(async () => {
        const body = { name, color, leadId: leadId || null, memberIds: members, assetId: assetId || null, notes, active, dailyHours: Number(dailyHours) || 8, updateOpenWorkOrders: !!changedPeople && updateOpen };
        const r = crew ? await api<Crew & { workOrdersUpdated?: number }>(`/crews/${crew.id}`, { method: "PUT", body }) : await api<Crew & { workOrdersUpdated?: number }>("/crews", { body });
        onSaved(r, r.workOrdersUpdated ?? 0);
      });
    }}>
      <h2>{crew ? `Edit ${crew.name}` : "New crew"}</h2>
      <div className="formgrid">
        <label>Name *<input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Spray crew" /></label>
        <label>Crew lead
          <select value={leadId} onChange={(e) => { setLeadId(e.target.value); setMembers((m) => m.filter((x) => x !== e.target.value)); }}>
            <option value="">No lead</option>
            {team.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
          </select>
        </label>
        <label>Truck or equipment
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">None</option>
            {(assets.data ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>Hours per day<input inputMode="decimal" required value={dailyHours} onChange={(e) => setDailyHours(e.target.value)} /><span className="muted field-hint">On the waiting list&apos;s workload strip</span></label>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <span className="todo-label">Color (on the calendar and work orders)</span>
        <div className="todo-colors" role="radiogroup" aria-label="Color">
          {TODO_COLORS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={color.toLowerCase() === c.key} aria-label={c.label} title={c.label} style={{ background: c.key }} onClick={() => setColor(c.key)} />)}
        </div>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <span className="todo-label">Members</span>
        <div className="todo-people" role="group" aria-label="Members">
          {team.filter((e) => e.id !== leadId).map((e) => (
            <label key={e.id} className="check"><input type="checkbox" checked={members.includes(e.id)} onChange={() => setMembers((m) => (m.includes(e.id) ? m.filter((x) => x !== e.id) : [...m, e.id]))} /> {e.firstName} {e.lastName}{e.title ? <span className="muted"> · {e.title}</span> : null}</label>
          ))}
        </div>
      </div>
      <label>Notes (optional)<textarea maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Licensed applicators; takes the 200-gallon rig" /></label>
      {crew && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (inactive crews aren&apos;t offered on new work orders)</label>}
      {changedPeople && <label className="check"><input type="checkbox" checked={updateOpen} onChange={(e) => setUpdateOpen(e.target.checked)} /> Also give this crew&apos;s open work orders (today on) the new people</label>}
      <ErrorBox error={save.error || del.error} />
      <div className="row">
        <button className="btn primary" disabled={save.busy}>{save.busy ? "Saving…" : crew ? "Save" : "Add crew"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {crew && <button type="button" className="btn danger" disabled={del.busy} style={{ marginLeft: "auto" }}
          onClick={() => confirm(`Delete ${crew.name}? Its work orders keep their people.`) && del.run(async () => { await api(`/crews/${crew.id}`, { method: "DELETE" }); onDeleted(); })}>Delete crew</button>}
      </div>
    </form>
  );
}

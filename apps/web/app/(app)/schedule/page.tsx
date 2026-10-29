"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, ErrorBox, PageHead } from "@/components/ui";

const DAY = 86_400_000;

/** Local midnight on Monday, `offset` weeks from this one. */
function weekStart(offset: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hours = (s: any) => (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 3_600_000;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

type Draft = { id?: string; employeeId: string; date: string; start: string; end: string; position?: string; location?: string; assetId?: string; notes?: string; status?: string };

function ShiftEditor({ draft, employees, assets, onClose, onSaved }: { draft: Draft; employees: any[]; assets: any[]; onClose: () => void; onSaved: (warnings: string[]) => void }) {
  const { busy, error, run } = useAction();
  const save = (form: HTMLFormElement) => {
    const f = new FormData(form);
    const date = f.get("date") as string;
    const startsAt = new Date(`${date}T${f.get("start")}`);
    let endsAt = new Date(`${date}T${f.get("end")}`);
    // An end time at or before the start means the shift runs past midnight.
    if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + DAY);
    const str = (k: string) => (f.get(k) as string) || undefined;
    const body = {
      employeeId: str("employeeId") ?? null,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      position: str("position"),
      location: str("location"),
      assetId: str("assetId") ?? null,
      notes: str("notes"),
    };
    run(async () => {
      const res = await api(draft.id ? `/shifts/${draft.id}` : "/shifts", { method: draft.id ? "PATCH" : "POST", body });
      onSaved(res.warnings);
    });
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{draft.id ? "Edit shift" : "New shift"} {draft.status && <Badge value={draft.status} />}</h2>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(e.currentTarget); }}>
        <div className="formgrid">
          <label>Who
            <select name="employeeId" defaultValue={draft.employeeId}>
              <option value="">Open shift (anyone can claim)</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </label>
          <label>Date<input name="date" type="date" defaultValue={draft.date} required /></label>
          <label>Start<input name="start" type="time" defaultValue={draft.start} required /></label>
          <label>End<input name="end" type="time" defaultValue={draft.end} required /></label>
          <label>Position<input name="position" defaultValue={draft.position} placeholder="Driver, crew lead…" /></label>
          <label>Location / job site<input name="location" defaultValue={draft.location} /></label>
          <label>Vehicle / equipment
            <select name="assetId" defaultValue={draft.assetId ?? ""}>
              <option value="">None</option>
              {assets.filter((a) => a.status !== "retired").map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== "active" ? ` (${a.status.replace(/_/g, " ")})` : ""}</option>)}
            </select>
          </label>
          <label>Notes<input name="notes" defaultValue={draft.notes} /></label>
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy}>Save</button>
          {draft.id && (
            <button type="button" className="btn danger" disabled={busy} onClick={() => confirm("Delete this shift?") && run(async () => { await api(`/shifts/${draft.id}`, { method: "DELETE" }); onSaved([]); })}>
              Delete
            </button>
          )}
          {draft.status === "published" && <span className="muted">The employee will be notified of changes.</span>}
        </div>
      </form>
    </div>
  );
}

export default function Schedule() {
  const { me, can } = useAuth();
  const manager = can("manager");
  const [offset, setOffset] = useState(0);
  const from = weekStart(offset);
  const to = weekStart(offset + 1);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const list = useApi<any[]>(`/shifts?from=${from.toISOString()}&to=${to.toISOString()}`);
  const employees = useApi<any[]>("/employees");
  const assets = useApi<any[]>("/assets");
  const drops = useApi<any[]>(manager ? "/shifts/drop-requests" : null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();

  const staff = useMemo(() => (employees.data ?? []).filter((e) => e.status !== "terminated"), [employees.data]);
  const shifts = (list.data ?? []).map((r) => ({ ...r.shift, assetName: r.assetName }));
  const drafts = shifts.filter((s) => s.status === "draft").length;
  const reload = () => { list.reload(); drops.reload(); };

  const openEditor = (s: any) =>
    setEditing({
      id: s.id, employeeId: s.employeeId ?? "", date: ymd(new Date(s.startsAt)), start: hm(s.startsAt), end: hm(s.endsAt),
      position: s.position ?? "", location: s.location ?? "", assetId: s.assetId ?? "", notes: s.notes ?? "", status: s.status,
    });

  const chipClick = (s: any) => {
    if (manager) return openEditor(s);
    if (!s.employeeId && s.status === "published") {
      if (confirm(`Pick up this shift on ${new Date(s.startsAt).toLocaleDateString()}?`)) {
        action.run(async () => { await api(`/shifts/${s.id}/claim`, { method: "POST" }); setNotice("Shift picked up. It's on your schedule."); reload(); });
      }
    } else if (s.employeeId === me?.user.id && !s.dropRequestedAt) {
      const reason = prompt("Ask your manager to take you off this shift. Reason (optional):");
      if (reason !== null) action.run(async () => { await api(`/shifts/${s.id}/drop-request`, { body: { reason: reason || undefined } }); setNotice("Request sent to your manager."); reload(); });
    }
  };

  const Chip = ({ s }: { s: any }) => {
    const clickable = manager || (!s.employeeId && s.status === "published") || (s.employeeId === me?.user.id && !s.dropRequestedAt);
    return (
      <div className={`shift ${s.status === "draft" ? "draft" : ""} ${!s.employeeId ? "open" : ""} ${s.employeeId === me?.user.id ? "mine" : ""}`}
        onClick={() => clickable && chipClick(s)} style={{ cursor: clickable ? "pointer" : "default" }}
        title={[s.position, s.location, s.assetName, s.notes].filter(Boolean).join(" · ")}>
        <strong>{time(s.startsAt)}–{time(s.endsAt)}</strong>
        {s.position && <div>{s.position}</div>}
        {s.assetName && <div className="muted">🚚 {s.assetName}</div>}
        {s.dropRequestedAt && <Badge value="drop requested" />}
      </div>
    );
  };

  const cell = (employeeId: string | null, day: Date) => (
    <td key={day.toISOString()} className="shiftcell">
      {shifts.filter((s) => (s.employeeId ?? null) === employeeId && sameDay(new Date(s.startsAt), day)).map((s) => <Chip key={s.id} s={s} />)}
      {manager && (
        <button className="addshift" title="Add shift" onClick={() => setEditing({ employeeId: employeeId ?? "", date: ymd(day), start: "08:00", end: "16:30" })}>+</button>
      )}
    </td>
  );

  const rows = manager ? staff : [...staff.filter((e) => e.id === me?.user.id), ...staff.filter((e) => e.id !== me?.user.id && shifts.some((s) => s.employeeId === e.id))];

  return (
    <>
      <PageHead title="Schedule" sub={`Week of ${from.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}`}>
        <button className="btn sm" onClick={() => setOffset(offset - 1)}>← Prev</button>
        <button className="btn sm" onClick={() => setOffset(0)}>This week</button>
        <button className="btn sm" onClick={() => setOffset(offset + 1)}>Next →</button>
        {manager && (
          <>
            <button className="btn" disabled={action.busy} onClick={() => confirm("Copy last week's shifts into this week as drafts?") && action.run(async () => {
              const r = await api("/shifts/copy-week", { body: { from: weekStart(offset - 1).toISOString(), to: from.toISOString() } });
              setNotice(`Copied ${r.copied} shift${r.copied === 1 ? "" : "s"}${r.skipped ? `; skipped ${r.skipped} that would double-book someone` : ""}.`);
              reload();
            })}>Copy last week</button>
            <button className="btn primary" disabled={!drafts || action.busy} onClick={() => action.run(async () => {
              const r = await api("/shifts/publish", { body: { from: from.toISOString(), to: to.toISOString() } });
              setNotice(`Published ${r.published} shift${r.published === 1 ? "" : "s"}. Your team has been notified.`);
              reload();
            })}>Publish{drafts ? ` (${drafts})` : ""}</button>
          </>
        )}
      </PageHead>
      <ErrorBox error={action.error || list.error} />
      {notice && <div className="card row" style={{ justifyContent: "space-between" }}><span>{notice}</span><button className="btn sm" onClick={() => setNotice(null)}>×</button></div>}
      {editing && (
        <ShiftEditor key={editing.id ?? `${editing.employeeId}-${editing.date}`} draft={editing} employees={staff} assets={assets.data ?? []} onClose={() => setEditing(null)}
          onSaved={(w) => { setEditing(null); setNotice(w.length ? `Saved with warnings: ${w.join("; ")}` : null); reload(); }} />
      )}
      {manager && !!drops.data?.length && (
        <div className="card">
          <h2>Drop requests</h2>
          <table><tbody>{drops.data.map(({ shift: s, employee }) => (
            <tr key={s.id}>
              <td>{employee.firstName} {employee.lastName}<div className="muted">{s.dropReason ?? "No reason given"}</div></td>
              <td>{new Date(s.startsAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, {time(s.startsAt)}–{time(s.endsAt)}</td>
              <td className="row">
                <button className="btn sm primary" onClick={() => action.run(async () => { await api(`/shifts/${s.id}/drop-decision`, { body: { approve: true } }); reload(); })}>Approve (make open)</button>
                <button className="btn sm" onClick={() => action.run(async () => { await api(`/shifts/${s.id}/drop-decision`, { body: { approve: false } }); reload(); })}>Deny</button>
              </td>
            </tr>
          ))}</tbody></table>
        </div>
      )}
      <div className="card tablewrap" style={{ padding: 0 }}>
        <table className="schedule">
          <thead>
            <tr>
              <th>Employee</th>
              {days.map((d) => (
                <th key={d.toISOString()} className={sameDay(d, new Date()) ? "today" : ""}>
                  {d.toLocaleDateString([], { weekday: "short" })} <span className="muted">{d.getMonth() + 1}/{d.getDate()}</span>
                </th>
              ))}
              <th>Hours</th>
            </tr>
          </thead>
          <tbody>
            <tr className="openrow">
              <td><strong>Open shifts</strong><div className="muted">{manager ? "Anyone can claim" : "Click to pick up"}</div></td>
              {days.map((d) => cell(null, d))}
              <td />
            </tr>
            {rows.map((e) => {
              const total = shifts.filter((s) => s.employeeId === e.id).reduce((h, s) => h + hours(s), 0);
              return (
                <tr key={e.id}>
                  <td><strong>{e.firstName} {e.lastName}</strong><div className="muted">{e.title ?? ""}</div></td>
                  {days.map((d) => cell(e.id, d))}
                  <td style={{ color: total > 40 ? "var(--warn)" : undefined, fontWeight: 600 }} title={total > 40 ? "Scheduled into overtime" : ""}>
                    {total ? total.toFixed(1) : "—"}{total > 40 && " ⚠"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {manager
          ? "Dashed shifts are drafts only you can see. Publish to share them and notify your team."
          : "Click one of your shifts to ask to drop it, or an open shift to pick it up."}
      </p>
    </>
  );
}

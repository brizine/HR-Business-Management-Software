"use client";
import { useEffect, useState } from "react";
import { WEEKDAYS, type AvailabilityRule } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type Kind = "all" | "before" | "after" | "between";
type Row = { weekday: number; kind: Kind; startTime: string; endTime: string; note: string };

const kindOf = (r: AvailabilityRule): Kind =>
  !r.startTime && !r.endTime ? "all" : !r.startTime ? "before" : !r.endTime ? "after" : "between";

function toRule(r: Row): AvailabilityRule {
  return {
    weekday: r.weekday,
    startTime: r.kind === "after" || r.kind === "between" ? r.startTime : null,
    endTime: r.kind === "before" || r.kind === "between" ? r.endTime : null,
    note: r.note || null,
  };
}

/** Edits someone's recurring "can't work" times. Omit employeeId for the signed-in user. */
export function AvailabilityEditor({ employeeId, onSaved }: { employeeId?: string; onSaved?: () => void }) {
  const qs = employeeId ? `?employeeId=${employeeId}` : "";
  const { data } = useApi<any[]>(`/availability${qs}`);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (data) {
      setRows(data.map((r) => ({ weekday: r.weekday, kind: kindOf(r), startTime: r.startTime ?? "14:00", endTime: r.endTime ?? "12:00", note: r.note ?? "" })));
    }
  }, [data]);
  if (!rows) return null;

  const set = (i: number, patch: Partial<Row>) => { setSaved(false); setRows(rows.map((r, j) => (i === j ? { ...r, ...patch } : r))); };

  return (
    <div className="stack">
      {rows.length ? rows.map((r, i) => (
        <div className="row" key={i}>
          <select value={r.weekday} onChange={(e) => set(i, { weekday: Number(e.target.value) })} style={{ width: 130 }}>
            {WEEKDAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}
          </select>
          <select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as Kind })} style={{ width: 150 }}>
            <option value="all">All day</option>
            <option value="before">Before…</option>
            <option value="after">After…</option>
            <option value="between">Between…</option>
          </select>
          {(r.kind === "after" || r.kind === "between") && <input type="time" value={r.startTime} onChange={(e) => set(i, { startTime: e.target.value })} style={{ width: 120 }} />}
          {r.kind === "between" && <span className="muted">and</span>}
          {(r.kind === "before" || r.kind === "between") && <input type="time" value={r.endTime} onChange={(e) => set(i, { endTime: e.target.value })} style={{ width: 120 }} />}
          <input placeholder="Reason (optional)" value={r.note} onChange={(e) => set(i, { note: e.target.value })} style={{ width: 180 }} />
          <button className="btn sm danger" onClick={() => { setSaved(false); setRows(rows.filter((_, j) => j !== i)); }}>Remove</button>
        </div>
      )) : <Empty>Available any day, any time.</Empty>}
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn" onClick={() => { setSaved(false); setRows([...rows, { weekday: 1, kind: "all", startTime: "14:00", endTime: "12:00", note: "" }]); }}>
          + Add a time I can&apos;t work
        </button>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => {
          await api(`/availability${qs}`, { method: "PUT", body: { rules: rows.map(toRule) } });
          setSaved(true);
          onSaved?.();
        })}>Save availability</button>
        {saved && <span className="muted">Saved{employeeId ? "" : ". Your manager has been notified"}.</span>}
      </div>
    </div>
  );
}

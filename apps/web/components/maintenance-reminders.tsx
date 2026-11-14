"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "./ui";

type Lead = { remindMilesBefore: number | null; remindHoursBefore: number | null; remindDaysBefore: number | null };
type FleetSettings = Lead & { repeatOverdueDays: number | null };

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

/** "1,000 mi / 14 days" for the lead times that are set. */
export function describeLead(l: Partial<Lead>) {
  return [l.remindMilesBefore != null && `${l.remindMilesBefore.toLocaleString()} mi`, l.remindHoursBefore != null && `${l.remindHoursBefore} hrs`, l.remindDaysBefore != null && `${l.remindDaysBefore} days`].filter(Boolean).join(" / ");
}

/** Assets page: company-wide reminder timing for maintenance schedules (and scheduled work orders). */
export function MaintenanceReminderDefaults({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const admin = can("admin", "fleet");
  const data = useApi<FleetSettings>("/assets/settings");
  const [v, setV] = useState({ miles: "", hours: "", days: "", repeat: "" });
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (data.data) setV({ miles: str(data.data.remindMilesBefore), hours: str(data.data.remindHoursBefore), days: str(data.data.remindDaysBefore), repeat: str(data.data.repeatOverdueDays) });
  }, [data.data]);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => { setV({ ...v, [k]: e.target.value }); setSaved(false); };
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api("/assets/settings", { method: "PUT", body: { remindMilesBefore: num(v.miles), remindHoursBefore: num(v.hours), remindDaysBefore: num(v.days), repeatOverdueDays: num(v.repeat) } });
        data.reload();
        setSaved(true);
      });
    }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Maintenance Reminders</h2>
        <button type="button" className="btn sm" onClick={onClose}>Close</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        How far ahead the &ldquo;due soon&rdquo; reminder goes out, for every asset. Leave a box blank to use 10% of each schedule&apos;s interval
        (e.g. 500 miles ahead for a 5,000-mile oil change). A schedule can set its own timing on its asset&apos;s page. Work orders scheduled by
        mileage, hours or date use these too (blank: 500 miles, 25 hours, 7 days).
      </p>
      <fieldset disabled={!admin || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="formgrid">
          <label>Remind this many miles before<input type="number" min="1" value={v.miles} onChange={set("miles")} placeholder="10% of interval" /></label>
          <label>Remind this many engine hours before<input type="number" min="1" step="0.5" value={v.hours} onChange={set("hours")} placeholder="10% of interval" /></label>
          <label>Remind this many days before<input type="number" min="1" value={v.days} onChange={set("days")} placeholder="10% of interval" /></label>
          <label>While overdue, remind again every (days)<input type="number" min="1" max="90" value={v.repeat} onChange={set("repeat")} placeholder="Only once" /></label>
        </div>
      </fieldset>
      <ErrorBox error={error} />
      {admin ? <div className="row"><button className="btn primary" disabled={busy}>Save reminder settings</button>{saved && <span className="muted" role="status">Saved.</span>}</div>
        : <p className="muted" style={{ margin: 0 }}>Only owners and admins can change these.</p>}
    </form>
  );
}

/** Asset page: one schedule's own reminder timing (blank = the company default). */
export function ScheduleReminderEditor({ schedule, onSaved, onClose }: { schedule: Lead & { id: string; name: string }; onSaved: () => void; onClose: () => void }) {
  const [v, setV] = useState({ miles: str(schedule.remindMilesBefore), hours: str(schedule.remindHoursBefore), days: str(schedule.remindDaysBefore) });
  const { busy, error, run } = useAction();
  const save = (body: Lead) => run(async () => { await api(`/assets/schedules/${schedule.id}`, { method: "PATCH", body }); onSaved(); });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <strong>When to remind about {schedule.name}</strong>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ width: 150 }}>Miles before<input type="number" min="1" value={v.miles} onChange={(e) => setV({ ...v, miles: e.target.value })} placeholder="Default" /></label>
        <label style={{ width: 150 }}>Engine hours before<input type="number" min="1" step="0.5" value={v.hours} onChange={(e) => setV({ ...v, hours: e.target.value })} placeholder="Default" /></label>
        <label style={{ width: 150 }}>Days before<input type="number" min="1" value={v.days} onChange={(e) => setV({ ...v, days: e.target.value })} placeholder="Default" /></label>
        <button type="button" className="btn primary sm" disabled={busy} onClick={() => save({ remindMilesBefore: num(v.miles), remindHoursBefore: num(v.hours), remindDaysBefore: num(v.days) })}>Save</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => save({ remindMilesBefore: null, remindHoursBefore: null, remindDaysBefore: null })}>Use company default</button>
        <button type="button" className="btn sm" onClick={onClose}>Cancel</button>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>Blank boxes use the company default (Assets → Reminder settings), or 10% of the interval if that&apos;s blank too.</span>
      <ErrorBox error={error} />
    </div>
  );
}

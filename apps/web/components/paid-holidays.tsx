"use client";
import { useState } from "react";
import {
  EMPLOYMENT_TYPES,
  HOLIDAY_PRESETS,
  MONTH_NAMES,
  WEEKDAY_NAMES,
  describeHolidayRule,
  type HolidayRule,
  type HolidayRules,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { useMenuData } from "@/lib/menus";
import { Empty, ErrorBox } from "./ui";

type Holiday = { id: string; name: string; rule: HolidayRule; hours: number; observe: "nearest" | "none"; active: boolean };
type Upcoming = { holidayId: string; name: string; hours: number; date: string; observed: string };
type Data = { holidays: Holiday[]; rules: HolidayRules; upcoming: Upcoming[] };

const day = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" }) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString([], opts);

/** Who gets holiday pay, in a sentence. */
function describeRules(r: HolidayRules, typeLabel: (t: string) => string) {
  const who = r.eligibleTypes.length ? r.eligibleTypes.map((t) => typeLabel(t) + (t === "part_time" && r.partTimeShare < 1 ? ` (${Math.round(r.partTimeShare * 100)}% of the hours)` : "")).join(", ") : "nobody yet";
  return [
    `Paid to: ${who}`,
    r.waitingDays ? `after ${r.waitingDays} days from their hire date` : null,
    r.requireWorkAround ? "must work the scheduled day before and after (approved time off counts)" : null,
    r.workedMultiplier > 1 ? `working on a holiday pays ${r.workedMultiplier}× for those hours, on top of holiday pay` : null,
  ].filter(Boolean).join(" · ");
}

/** Add or edit one holiday: name, date rule, paid hours, weekend handling. */
function HolidayForm({ holiday, onSaved, onCancel }: { holiday?: Holiday; onSaved: () => void; onCancel?: () => void }) {
  const r = holiday?.rule;
  const [name, setName] = useState(holiday?.name ?? "");
  const [kind, setKind] = useState<HolidayRule["kind"]>(r?.kind ?? "fixed");
  const [month, setMonth] = useState(String(r && r.kind !== "once" ? r.month : 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(r?.kind === "fixed" ? r.day : 1));
  const [nth, setNth] = useState(String(r?.kind === "nth" ? r.nth : 1));
  const [weekday, setWeekday] = useState(String(r?.kind === "nth" ? r.weekday : 1));
  const [offset, setOffset] = useState(String(r?.kind === "nth" ? r.offsetDays ?? 0 : 0));
  const [date, setDate] = useState(r?.kind === "once" ? r.date : "");
  const [hours, setHours] = useState(String(holiday?.hours ?? 8));
  const [observe, setObserve] = useState(holiday ? holiday.observe === "nearest" : true);
  const { busy, error, run } = useAction();
  const rule = (): HolidayRule =>
    kind === "fixed" ? { kind, month: Number(month), day: Number(dayOfMonth) }
      : kind === "nth" ? { kind, month: Number(month), weekday: Number(weekday), nth: Number(nth) as 1, offsetDays: Number(offset) }
        : { kind, date };
  const preview = kind !== "once" || date ? describeHolidayRule(rule()) : "";

  return (
    <form className="stack holiday-form" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const body = { name, rule: rule(), hours: Number(hours), observe: observe ? "nearest" : "none", active: holiday?.active ?? true };
        await api(holiday ? `/holidays/${holiday.id}` : "/holidays", { method: holiday ? "PUT" : "POST", body });
        onSaved();
      });
    }}>
      <h3 style={{ margin: 0 }}>{holiday ? `Edit ${holiday.name}` : "Add a Holiday"}</h3>
      <div className="formgrid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Christmas Day" /></label>
        <label>Date rule
          <select value={kind} onChange={(e) => setKind(e.target.value as HolidayRule["kind"])}>
            <option value="fixed">Same date every year</option>
            <option value="nth">A weekday in a month (e.g. 4th Thursday)</option>
            <option value="once">One time only</option>
          </select>
        </label>
        <label>Paid hours<input type="number" min="0" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} required /></label>
      </div>
      <div className="formgrid">
        {kind === "fixed" && (
          <>
            <label>Month<select value={month} onChange={(e) => setMonth(e.target.value)}>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
            <label>Day<input type="number" min="1" max="31" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} required /></label>
          </>
        )}
        {kind === "nth" && (
          <>
            <label>Which<select value={nth} onChange={(e) => setNth(e.target.value)}>{[["1", "1st"], ["2", "2nd"], ["3", "3rd"], ["4", "4th"], ["-1", "Last"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label>Weekday<select value={weekday} onChange={(e) => setWeekday(e.target.value)}>{WEEKDAY_NAMES.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></label>
            <label>Month<select value={month} onChange={(e) => setMonth(e.target.value)}>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
            <label>Shift<select value={offset} onChange={(e) => setOffset(e.target.value)}>
              <option value="0">That day</option>
              <option value="1">The day after</option>
              <option value="-1">The day before</option>
            </select></label>
          </>
        )}
        {kind === "once" && <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>}
      </div>
      {preview && <p className="muted" style={{ margin: 0 }}>{preview}</p>}
      <label className="check"><input type="checkbox" checked={observe} onChange={(e) => setObserve(e.target.checked)} /> If it falls on a weekend, give the day off on the Friday before (Saturday) or the Monday after (Sunday)</label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{holiday ? "Save holiday" : "Add holiday"}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** Who gets paid holidays: employment types, waiting period, part-time share, pay for working one. */
function RulesForm({ rules, onSaved }: { rules: HolidayRules; onSaved: () => void }) {
  const { label } = useMenuData();
  const [types, setTypes] = useState<string[]>(rules.eligibleTypes);
  const [waiting, setWaiting] = useState(String(rules.waitingDays));
  const [share, setShare] = useState(String(Math.round(rules.partTimeShare * 100)));
  const [multiplier, setMultiplier] = useState(String(rules.workedMultiplier));
  const [workAround, setWorkAround] = useState(!!rules.requireWorkAround);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <form className="stack" onChange={() => setSaved(false)} onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api("/holidays/rules", { method: "PUT", body: { eligibleTypes: types, waitingDays: Number(waiting || 0), partTimeShare: Number(share || 0) / 100, workedMultiplier: Number(multiplier), requireWorkAround: workAround } });
        setSaved(true);
        onSaved();
      });
    }}>
      <h3 style={{ margin: 0 }}>Holiday Pay Rules</h3>
      <fieldset className="contact-fieldset" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <legend>Who gets paid holidays</legend>
        {EMPLOYMENT_TYPES.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />
            {label("employmentType", t).replace(/^./, (c) => c.toUpperCase())}
          </label>
        ))}
      </fieldset>
      <div className="formgrid">
        <label>Waiting period after hire (days)<input type="number" min="0" max="730" value={waiting} onChange={(e) => setWaiting(e.target.value)} /></label>
        {types.includes("part_time") && (
          <label>Part-time get (% of the hours)<input type="number" min="0" max="100" step="5" value={share} onChange={(e) => setShare(e.target.value)} /></label>
        )}
        <label>Working on a holiday pays
          <select value={multiplier} onChange={(e) => setMultiplier(e.target.value)}>
            <option value="1">Normal pay (plus holiday pay)</option>
            <option value="1.5">Time and a half (plus holiday pay)</option>
            <option value="2">Double time (plus holiday pay)</option>
            <option value="2.5">2.5× (plus holiday pay)</option>
            <option value="3">Triple time (plus holiday pay)</option>
          </select>
        </label>
      </div>
      <label className="check" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={workAround} onChange={(e) => setWorkAround(e.target.checked)} />
        <span>
          Must work their scheduled day before and scheduled day after the holiday to get holiday pay
          <span className="muted" style={{ display: "block", fontSize: 13 }}>
            Uses each person&apos;s published shifts: their last scheduled day before the holiday and first one after. Approved time off on those days counts as worked. People with no shifts around the holiday aren&apos;t affected.
          </span>
        </span>
      </label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Holiday hours and the extra pay for working a holiday show on Payroll and in the export. Salaried employees&apos; holiday hours are listed for your records.</p>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save rules</button>{saved && <span className="muted" role="status">Saved.</span>}</div>
    </form>
  );
}

/** Time off page: upcoming paid holidays for everyone; admins manage the list and the rules. */
export function PaidHolidays() {
  const { can } = useAuth();
  const { label } = useMenuData();
  const admin = can("admin", "timeoff");
  const data = useApi<Data>("/holidays");
  const [tab, setTab] = useState<"upcoming" | "manage" | "rules">("upcoming");
  const [editing, setEditing] = useState<string | null>(null);
  const [presets, setPresets] = useState<string[]>([]);
  const action = useAction();
  const d = data.data;
  const typeLabel = (t: string) => label("employmentType", t).replace(/^./, (c) => c.toUpperCase());
  const have = new Set(d?.holidays.map((h) => h.name.toLowerCase()));
  const available = HOLIDAY_PRESETS.filter((p) => !have.has(p.name.toLowerCase()));

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Paid Holidays</h2>
        {admin && (
          <div className="row" role="tablist" style={{ gap: 6 }}>
            {([["upcoming", "Upcoming"], ["manage", "Holidays"], ["rules", "Rules"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn sm ${tab === k ? "primary" : ""}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
        )}
      </div>
      {!d ? <ErrorBox error={data.error} /> : (
        <>
          <p className="muted" style={{ margin: 0 }}>{describeRules(d.rules, typeLabel)}.</p>
          {tab === "upcoming" && (d.upcoming.length ? (
            <table><tbody>{d.upcoming.map((u) => (
              <tr key={`${u.holidayId}-${u.observed}`}>
                <td style={{ width: 170 }}><strong>{day(u.observed)}</strong></td>
                <td>{u.name}{u.date !== u.observed && <div className="muted" style={{ fontSize: 12 }}>The holiday is {day(u.date, { weekday: "long", month: "short", day: "numeric" })}; the day off moves to the nearest weekday.</div>}</td>
                <td style={{ textAlign: "right" }}>{u.hours}h paid</td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>{admin ? "No paid holidays yet. Add them under Holidays." : "No paid holidays in the next year."}</Empty>)}

          {admin && tab === "manage" && (
            <>
              {d.holidays.length ? (
                <table><tbody>{d.holidays.map((h) => (
                  editing === h.id ? (
                    <tr key={h.id}><td colSpan={4}><HolidayForm holiday={h} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); data.reload(); }} /></td></tr>
                  ) : (
                    <tr key={h.id} style={{ opacity: h.active ? 1 : 0.55 }}>
                      <td><strong>{h.name}</strong>{!h.active && <span className="muted"> (off)</span>}<div className="muted" style={{ fontSize: 13 }}>{describeHolidayRule(h.rule)}{h.observe === "nearest" ? " · weekends move to Fri/Mon" : ""}</div></td>
                      <td>{h.hours}h</td>
                      <td className="row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn sm" onClick={() => setEditing(h.id)}>Edit</button>
                        <button className="btn sm" onClick={() => action.run(async () => { await api(`/holidays/${h.id}`, { method: "PUT", body: { name: h.name, rule: h.rule, hours: h.hours, observe: h.observe, active: !h.active } }); data.reload(); })}>{h.active ? "Turn off" : "Turn on"}</button>
                        <button className="btn sm danger" onClick={() => confirm(`Delete ${h.name}?`) && action.run(async () => { await api(`/holidays/${h.id}`, { method: "DELETE" }); data.reload(); })}>Delete</button>
                      </td>
                    </tr>
                  )
                ))}</tbody></table>
              ) : <Empty>No holidays yet.</Empty>}
              <ErrorBox error={action.error} />
              {available.length > 0 && (
                <div className="stack holiday-presets">
                  <h3 style={{ margin: 0 }}>Add Common Holidays</h3>
                  <div className="row" style={{ flexWrap: "wrap", gap: "6px 16px" }}>
                    {available.map((p) => (
                      <label key={p.key} className="check">
                        <input type="checkbox" checked={presets.includes(p.key)} onChange={(e) => setPresets(e.target.checked ? [...presets, p.key] : presets.filter((k) => k !== p.key))} />
                        {p.name} <span className="muted" style={{ fontSize: 12 }}>({describeHolidayRule(p.rule).replace(", every year", "")})</span>
                      </label>
                    ))}
                  </div>
                  <div className="row">
                    <button className="btn" disabled={!presets.length || action.busy} onClick={() => action.run(async () => { await api("/holidays/presets", { body: { keys: presets, hours: 8 } }); setPresets([]); data.reload(); })}>
                      Add {presets.length || ""} selected (8h each)
                    </button>
                    <button type="button" className="btn sm" onClick={() => setPresets(presets.length === available.length ? [] : available.map((p) => p.key))}>{presets.length === available.length ? "Select none" : "Select all"}</button>
                  </div>
                </div>
              )}
              {!editing && <HolidayForm key={d.holidays.length} onSaved={() => data.reload()} />}
            </>
          )}

          {admin && tab === "rules" && <RulesForm rules={d.rules} onSaved={() => data.reload()} />}
        </>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import { describePto, type PtoGrantSchedule } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { ErrorBox } from "./ui";

type TierDraft = { afterYears: string; hoursPer: string; grantHours: string };

/** "1h per N hours worked" in the form; the API stores the rate (1/N). */
const toHoursPer = (rate: number | null | undefined) => (rate ? String(Math.round((1 / rate) * 100) / 100) : "");
const toRate = (hoursPer: string) => (hoursPer.trim() === "" ? 0 : 1 / Number(hoursPer));
const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** Add or edit a time-off policy: earn by hours worked, award hours by date, and step up with years of service. */
export function PtoPolicyForm({ policy, onSaved, onCancel }: { policy?: any; onSaved: () => void; onCancel?: () => void }) {
  const [name, setName] = useState(policy?.name ?? "");
  const [hoursPer, setHoursPer] = useState(toHoursPer(policy?.accrualRate));
  const [schedule, setSchedule] = useState<PtoGrantSchedule>(policy?.grantSchedule ?? "none");
  const [grantHours, setGrantHours] = useState(policy?.annualGrantHours ? String(policy.annualGrantHours) : "");
  const [grantDate, setGrantDate] = useState(policy?.grantDate ? `2000-${policy.grantDate}` : "2000-01-01");
  const [dayOfMonth, setDayOfMonth] = useState(String(policy?.grantDayOfMonth ?? 1));
  const [cap, setCap] = useState(policy?.maxBalanceHours != null ? String(policy.maxBalanceHours) : "");
  const [carry, setCarry] = useState(policy?.carryoverLimitHours != null ? String(policy.carryoverLimitHours) : "");
  const [resetOn, setResetOn] = useState<"yearly_date" | "anniversary">(policy?.carryoverReset ?? "yearly_date");
  const [resetDate, setResetDate] = useState(policy?.carryoverDate ?? "01-01");
  const [tiers, setTiers] = useState<TierDraft[]>(
    (policy?.tiers ?? []).map((t: any) => ({ afterYears: String(t.afterYears), hoursPer: t.accrualRate == null ? "" : toHoursPer(t.accrualRate) || "0", grantHours: t.grantHours == null ? "" : String(t.grantHours) })),
  );
  const { busy, error, run } = useAction();

  const body = {
    name,
    accrualRate: toRate(hoursPer),
    annualGrantHours: schedule === "none" ? 0 : Number(grantHours || 0),
    grantSchedule: schedule,
    grantDate: schedule === "yearly_date" ? grantDate.slice(5) : null,
    grantDayOfMonth: schedule === "monthly" ? Number(dayOfMonth) : null,
    maxBalanceHours: num(cap),
    carryoverLimitHours: num(carry),
    carryoverReset: resetOn,
    carryoverDate: resetDate,
    tiers: tiers
      .filter((t) => t.afterYears.trim() !== "")
      .map((t) => ({ afterYears: Number(t.afterYears), accrualRate: t.hoursPer.trim() === "" ? null : t.hoursPer === "0" ? 0 : toRate(t.hoursPer), grantHours: schedule === "none" ? null : num(t.grantHours) })),
  };
  const setTier = (i: number, patch: Partial<TierDraft>) => setTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <form className="stack" style={{ marginTop: 12 }} onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api(policy ? `/pto/policies/${policy.id}` : "/pto/policies", { method: policy ? "PUT" : "POST", body });
        onSaved();
      });
    }}>
      <strong>{policy ? `Edit ${policy.name}` : "Add a policy"}</strong>
      <div className="formgrid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Vacation" /></label>
        <label>Max balance (h)<input type="number" min="0" step="any" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="No cap" /></label>
      </div>

      <fieldset className="pto-section">
        <legend>Earn by hours worked</legend>
        <label>1 hour off for every<span className="row" style={{ flexWrap: "nowrap" }}>
          <input type="number" min="1" step="any" value={hoursPer} onChange={(e) => setHoursPer(e.target.value)} placeholder="e.g. 30" style={{ width: 110 }} />
          <span className="muted">hours worked (leave blank for none)</span>
        </span></label>
      </fieldset>

      <fieldset className="pto-section">
        <legend>Award hours by date</legend>
        <div className="formgrid">
          <label>When
            <select value={schedule} onChange={(e) => setSchedule(e.target.value as PtoGrantSchedule)}>
              <option value="none">Don&apos;t award by date</option>
              <option value="yearly_date">Every year on a set date</option>
              <option value="anniversary">Every year on their hire anniversary</option>
              <option value="monthly">Every month on a set day</option>
            </select>
          </label>
          {schedule === "yearly_date" && (
            <label>Date each year
              <span className="row" style={{ flexWrap: "nowrap" }}>
                <select value={grantDate.slice(5, 7)} onChange={(e) => setGrantDate(`2000-${e.target.value}-${grantDate.slice(8)}`)} aria-label="Month">
                  {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m, i) => <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
                </select>
                <select value={grantDate.slice(8)} onChange={(e) => setGrantDate(`${grantDate.slice(0, 8)}${e.target.value}`)} aria-label="Day">
                  {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0")).map((d) => <option key={d} value={d}>{Number(d)}</option>)}
                </select>
              </span>
            </label>
          )}
          {schedule === "monthly" && (
            <label>Day of the month
              <select value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)}>
                {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            </label>
          )}
          {schedule !== "none" && (
            <label>Hours each time<input type="number" min="0" step="any" required value={grantHours} onChange={(e) => setGrantHours(e.target.value)} placeholder="e.g. 40" /></label>
          )}
        </div>
        {schedule === "anniversary" && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Uses each person&apos;s hire date; people without one don&apos;t get anniversary awards.</p>}
      </fieldset>

      <fieldset className="pto-section">
        <legend>Carryover limit</legend>
        <div className="formgrid">
          <label>Most hours carried into the next year
            <input type="number" min="0" step="any" value={carry} onChange={(e) => setCarry(e.target.value)} placeholder="No limit" />
          </label>
          {carry.trim() !== "" && (
            <label>The year starts
              <select value={resetOn} onChange={(e) => setResetOn(e.target.value as "yearly_date" | "anniversary")}>
                <option value="yearly_date">On a set date</option>
                <option value="anniversary">On each person&apos;s hire anniversary</option>
              </select>
            </label>
          )}
          {carry.trim() !== "" && resetOn === "yearly_date" && (
            <label>Date
              <span className="row" style={{ flexWrap: "nowrap" }}>
                <select value={resetDate.slice(0, 2)} onChange={(e) => setResetDate(`${e.target.value}-${resetDate.slice(3)}`)} aria-label="Reset month">
                  {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m, i) => <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
                </select>
                <select value={resetDate.slice(3)} onChange={(e) => setResetDate(`${resetDate.slice(0, 2)}-${e.target.value}`)} aria-label="Reset day">
                  {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0")).map((d) => <option key={d} value={d}>{Number(d)}</option>)}
                </select>
              </span>
            </label>
          )}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {carry.trim() === ""
            ? "Leave blank to let unused hours carry over without limit."
            : `When the year starts, hours above ${carry || 0}h are removed (hours in pending requests are kept; it shows in their balance history). Use 0 for "use it or lose it". Any award on the same date is added after.`}
        </p>
      </fieldset>

      <fieldset className="pto-section">
        <legend>Increase with years of service</legend>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          From each anniversary, the higher amount applies (based on hire date). Leave a box blank to keep the amount above.
        </p>
        {tiers.map((t, i) => (
          <div key={i} className="row pto-tier">
            <label>After<span className="row" style={{ flexWrap: "nowrap" }}><input type="number" min="1" max="50" required value={t.afterYears} onChange={(e) => setTier(i, { afterYears: e.target.value })} style={{ width: 70 }} /><span className="muted">years</span></span></label>
            <label>1h per<span className="row" style={{ flexWrap: "nowrap" }}><input type="number" min="0" step="any" value={t.hoursPer} onChange={(e) => setTier(i, { hoursPer: e.target.value })} placeholder={hoursPer || "—"} style={{ width: 90 }} /><span className="muted">hours worked</span></span></label>
            {schedule !== "none" && (
              <label>Award<span className="row" style={{ flexWrap: "nowrap" }}><input type="number" min="0" step="any" value={t.grantHours} onChange={(e) => setTier(i, { grantHours: e.target.value })} placeholder={grantHours || "—"} style={{ width: 90 }} /><span className="muted">hours</span></span></label>
            )}
            <button type="button" className="btn sm danger" onClick={() => setTiers(tiers.filter((_, j) => j !== i))} aria-label={`Remove the ${t.afterYears || "new"}-year step`}>Remove</button>
          </div>
        ))}
        <div>
          <button type="button" className="btn sm" onClick={() => setTiers([...tiers, { afterYears: String(tiers.length ? Math.max(...tiers.map((t) => Number(t.afterYears) || 0)) + (tiers.length === 1 ? 4 : 5) : 1), hoursPer: "", grantHours: "" }])}>
            + Add a step
          </button>
        </div>
      </fieldset>

      {name && <p className="muted" style={{ margin: 0, fontSize: 13 }}><strong>Summary:</strong> {describePto(body)}</p>}
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{policy ? "Save policy" : "Add policy"}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

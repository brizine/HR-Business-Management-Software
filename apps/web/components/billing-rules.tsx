"use client";
import { useState } from "react";
import {
  DEFAULT_SEND_SCHEDULE, SEND_WEEKDAYS, describeLateFeeRule, describeSchedule, effectiveLateFeeRules, effectiveSchedule,
  type AutoSendSettings, type LateFeeRule, type LateFeeSettings, type SendSchedule,
} from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/**
 * Late fee steps and auto-send schedules (like Homeworks' Invoice Settings): the editors, the
 * company's cards for Settings, and a customer's own choices for their page.
 */

type RuleDraft = { days: string; kind: "amount" | "percent"; value: string };
const toDraft = (r: LateFeeRule): RuleDraft => ({ days: String(r.days), kind: r.kind, value: r.kind === "amount" ? (r.value / 100).toFixed(2) : String(r.value) });
const fromDraft = (d: RuleDraft): LateFeeRule => ({ days: Number(d.days), kind: d.kind, value: d.kind === "amount" ? Math.round(Number(String(d.value).replace(/[$,]/g, "")) * 100) : Number(d.value) });

/** The steps: "after N days, add $X / X%". */
export function LateFeeRulesEditor({ rules, onChange }: { rules: RuleDraft[]; onChange: (r: RuleDraft[]) => void }) {
  const set = (i: number, patch: Partial<RuleDraft>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rules.map((r, i) => (
        <div key={i} className="row br-rule">
          <label>Days after it&apos;s sent<input inputMode="numeric" value={r.days} onChange={(e) => set(i, { days: e.target.value })} aria-label={`Step ${i + 1} days`} /></label>
          <label>Fee
            <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
              <select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as RuleDraft["kind"] })} aria-label={`Step ${i + 1} kind`} style={{ width: "auto" }}>
                <option value="amount">$</option><option value="percent">%</option>
              </select>
              <input inputMode="decimal" value={r.value} onChange={(e) => set(i, { value: e.target.value })} aria-label={`Step ${i + 1} fee`} placeholder={r.kind === "amount" ? "15.00" : "1.5"} />
            </div>
          </label>
          <button type="button" className="btn" aria-label={`Remove step ${i + 1}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {rules.length < 6 && (
        <div><button type="button" className="btn" onClick={() => onChange([...rules, { days: String((Number(rules.at(-1)?.days) || 0) + 30), kind: "amount", value: "" }])}>Add a step</button></div>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Each step adds its fee once, worked out from the original invoice total, so fees never stack on fees. Paid invoices get none.</p>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => [h, `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`] as const);

/** Daily (or weekdays), chosen days of the week, or monthly (a date or e.g. the first Monday). */
export function ScheduleEditor({ value, onChange }: { value: SendSchedule; onChange: (s: SendSchedule) => void }) {
  const set = (patch: Partial<SendSchedule>) => onChange({ ...value, ...patch });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label>How often
        <select value={value.frequency} onChange={(e) => set({ frequency: e.target.value as SendSchedule["frequency"] })} style={{ width: "auto" }}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select>
      </label>
      {value.frequency === "daily" && (
        <div className="row">
          <label className="check"><input type="radio" checked={!value.weekdaysOnly} onChange={() => set({ weekdaysOnly: false })} /> Every day</label>
          <label className="check"><input type="radio" checked={value.weekdaysOnly} onChange={() => set({ weekdaysOnly: true })} /> Every weekday (Mon–Fri)</label>
        </div>
      )}
      {value.frequency === "weekly" && (
        <div className="row" role="group" aria-label="Days">
          {SEND_WEEKDAYS.map((d, i) => (
            <label key={d} className="check"><input type="checkbox" checked={value.days.includes(i)} onChange={(e) => set({ days: e.target.checked ? [...value.days, i].sort() : value.days.filter((x) => x !== i) })} /> {d.slice(0, 3)}</label>
          ))}
        </div>
      )}
      {value.frequency === "monthly" && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="check"><input type="radio" checked={value.monthMode === "day"} onChange={() => set({ monthMode: "day" })} /> On the
            <select value={value.monthDay} disabled={value.monthMode !== "day"} onChange={(e) => set({ monthDay: Number(e.target.value) })} aria-label="Day of the month" style={{ width: "auto", marginLeft: 6 }}>
              {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}<option value={0}>last day</option>
            </select>
          </label>
          <label className="check"><input type="radio" checked={value.monthMode === "weekday"} onChange={() => set({ monthMode: "weekday" })} /> On the
            <select value={value.nth} disabled={value.monthMode !== "weekday"} onChange={(e) => set({ nth: Number(e.target.value) })} aria-label="Which week" style={{ width: "auto", marginLeft: 6 }}>
              {["First", "Second", "Third", "Fourth", "Last"].map((l, i) => <option key={l} value={i + 1}>{l}</option>)}
            </select>
            <select value={value.weekday} disabled={value.monthMode !== "weekday"} onChange={(e) => set({ weekday: Number(e.target.value) })} aria-label="Weekday" style={{ width: "auto", marginLeft: 6 }}>
              {SEND_WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </label>
        </div>
      )}
      <span className="muted" style={{ fontSize: 13 }}>{describeSchedule(value)}</span>
    </div>
  );
}

type Billing = { lateFees: LateFeeSettings; autoSend: AutoSendSettings };

/** Settings → Customers & billing: the company's late fee steps. */
export function LateFeesCard() {
  const saved = useApi<Billing>("/invoices/settings");
  const [form, setForm] = useState<{ enabled: boolean; emailCustomer: boolean; rules: RuleDraft[] } | null>(null);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);
  if (!saved.data) return null;
  const lf = saved.data.lateFees;
  const f = form ?? { enabled: lf.enabled, emailCustomer: lf.emailCustomer, rules: lf.rules.length ? lf.rules.map(toDraft) : [{ days: "30", kind: "amount" as const, value: "" }] };
  const set = (patch: Partial<typeof f>) => { setForm({ ...f, ...patch }); setDone(false); };
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/invoices/settings/late-fees", { method: "PUT", body: { enabled: f.enabled, emailCustomer: f.emailCustomer, rules: f.enabled ? f.rules.map(fromDraft) : f.rules.filter((r) => r.value).map(fromDraft) } }); saved.reload(); setForm(null); setDone(true); }); }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Late fees</h2>
      <p className="muted" style={{ margin: 0 }}>Added to unpaid invoices as they get older, like Homeworks. Customers use these unless their page says otherwise. Changing them only affects invoices sent from now on.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Add late fees</label>
      {f.enabled && (
        <>
          <LateFeeRulesEditor rules={f.rules} onChange={(rules) => set({ rules })} />
          <label className="check"><input type="checkbox" checked={f.emailCustomer} onChange={(e) => set({ emailCustomer: e.target.checked })} /> Email the customer when a fee is added (with the new balance and a pay link)</label>
        </>
      )}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save late fees</button>{done && <span className="ok-text">Saved</span>}</div>
    </form>
  );
}

/** Settings → Customers & billing: the company's auto-send schedule. */
export function AutoSendCard() {
  const saved = useApi<Billing>("/invoices/settings");
  const [form, setForm] = useState<AutoSendSettings | null>(null);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);
  if (!saved.data) return null;
  const f = form ?? saved.data.autoSend;
  const set = (patch: Partial<AutoSendSettings>) => { setForm({ ...f, ...patch }); setDone(false); };
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/invoices/settings/auto-send", { method: "PUT", body: f }); saved.reload(); setForm(null); setDone(true); }); }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Auto-send invoices</h2>
      <p className="muted" style={{ margin: 0 }}>On send days, each customer&apos;s draft invoices go out the way they get invoices (email and/or the print queue). Customers use this unless their page says otherwise.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Send invoices automatically</label>
      {f.enabled && (
        <>
          <ScheduleEditor value={f.schedule} onChange={(schedule) => set({ schedule })} />
          <label>At
            <select value={f.hour} onChange={(e) => set({ hour: Number(e.target.value) })} style={{ width: "auto" }}>{HOURS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}</select>
          </label>
          <label className="check"><input type="checkbox" checked={f.invoiceWorkOrders} onChange={(e) => set({ invoiceWorkOrders: e.target.checked })} /> First make invoices for their finished work orders that aren&apos;t on one yet</label>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>You get a notification with what was sent, and anything that couldn&apos;t be (e.g. a missing PO number).</p>
        </>
      )}
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save auto-send</button>{done && <span className="ok-text">Saved</span>}</div>
    </form>
  );
}

/** On a customer's page: what late fees and auto-sending they get (in words). */
export function describeCustomerRules(c: any, company: Billing | undefined) {
  if (!company) return { lateFees: "…", autoSend: "…" };
  const rules = effectiveLateFeeRules(company.lateFees, c.lateFeeMode, c.lateFeeRules);
  const sched = effectiveSchedule(company.autoSend, c.autoSendMode, c.autoSendSchedule);
  const tag = (mode: string, def: string) => (mode === "default" ? ` (${def})` : "");
  return {
    lateFees: (rules.length ? rules.map(describeLateFeeRule).join("; ") : "None") + tag(c.lateFeeMode, "company default"),
    autoSend: (sched ? describeSchedule(sched) : "Off") + tag(c.autoSendMode, "company default"),
  };
}

/** On a customer's page: their own late fee and auto-send choices. */
export function CustomerBillingRules({ customer, onSaved, onCancel }: { customer: any; onSaved: () => void; onCancel: () => void }) {
  const company = useApi<Billing>("/invoices/settings").data;
  const [lateFeeMode, setLateFeeMode] = useState<string>(customer.lateFeeMode ?? "default");
  const [rules, setRules] = useState<RuleDraft[]>((customer.lateFeeRules ?? []).map(toDraft));
  const [autoSendMode, setAutoSendMode] = useState<string>(customer.autoSendMode ?? "default");
  const [schedule, setSchedule] = useState<SendSchedule>(customer.autoSendSchedule ?? company?.autoSend.schedule ?? DEFAULT_SEND_SCHEDULE);
  const { busy, error, run } = useAction();
  const companyRules = company ? (company.lateFees.enabled && company.lateFees.rules.length ? company.lateFees.rules.map(describeLateFeeRule).join("; ") : "none") : "…";
  const companySend = company ? (company.autoSend.enabled ? describeSchedule(company.autoSend.schedule) : "off") : "…";
  return (
    <div className="card inset stack">
      <strong>Late fees</strong>
      {([["default", `Company default (${companyRules})`], ["none", "No late fees for this customer"], ["custom", "Their own steps"]] as const).map(([k, l]) => (
        <label key={k} className="check"><input type="radio" name="lfm" checked={lateFeeMode === k} onChange={() => { setLateFeeMode(k); if (k === "custom" && !rules.length) setRules([{ days: "30", kind: "amount", value: "" }]); }} /> {l}</label>
      ))}
      {lateFeeMode === "custom" && <LateFeeRulesEditor rules={rules} onChange={setRules} />}
      <strong>Auto-send invoices</strong>
      {([["default", `Company default (${companySend})`], ["off", "Don't send their invoices automatically"], ["custom", "Their own schedule"]] as const).map(([k, l]) => (
        <label key={k} className="check"><input type="radio" name="asm" checked={autoSendMode === k} onChange={() => setAutoSendMode(k)} /> {l}</label>
      ))}
      {autoSendMode === "custom" && <ScheduleEditor value={schedule} onChange={setSchedule} />}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Late fee changes apply to invoices sent from now on.</p>
      <ErrorBox error={error} />
      <div className="row">
        <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => {
          await api(`/customers/${customer.id}/billing-rules`, { method: "PUT", body: { lateFeeMode, lateFeeRules: lateFeeMode === "custom" ? rules.map(fromDraft) : [], autoSendMode, autoSendSchedule: autoSendMode === "custom" ? schedule : null } });
          onSaved();
        })}>Save</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

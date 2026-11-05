"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PAY_FREQUENCIES, PAY_FREQUENCY_LABELS, isInactive, upcomingPeriods, type PayFrequency } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox } from "./ui";
import { useMenuData } from "@/lib/menus";

interface Schedule {
  frequency: PayFrequency | null;
  anchorDate: string | null;
  paydayOffsetDays: number;
  approverIds: string[];
  /** Active owners and admins: the only people who can approve payroll. */
  approverChoices: { id: string; firstName: string; lastName: string; role: string }[];
  upcoming: { start: string; end: string; payday: string }[];
}

/** Payroll page: how often people are paid, payday, and who approves each period (the owner edits). */
export function PaySchedule() {
  const { can } = useAuth();
  const { label } = useMenuData();
  const owner = can("owner", "payroll");
  const saved = useApi<Schedule>("/pay-periods/schedule");
  const staff = useApi<any[]>("/employees");
  const [s, setS] = useState<Schedule | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (saved.data) setS(saved.data); }, [saved.data]);
  if (!s || !staff.data) return <ErrorBox error={saved.error || staff.error} />;
  const needsAnchor = s.frequency === "weekly" || s.frequency === "biweekly";
  const people = staff.data.filter((e) => !isInactive(e.status) || s.approverIds.includes(e.id));
  const edit = (patch: Partial<Schedule>) => { setS({ ...s, ...patch }); setDone(false); };
  const choices = (s.approverChoices ?? []).filter((c) => !s.approverIds.includes(c.id));
  const roleName = (r: string) => { const l = label("role", r); return l[0].toUpperCase() + l.slice(1); };

  // Live preview of the next periods from what's chosen (before saving).
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const ready = !!s.frequency && (!needsAnchor || !!s.anchorDate);
  const preview = ready ? upcomingPeriods(todayIso, { frequency: s.frequency!, anchorDate: s.anchorDate, paydayOffsetDays: s.paydayOffsetDays || 0 }, 4) : [];
  const short = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const long = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const changed = JSON.stringify([s.frequency, needsAnchor ? s.anchorDate : null, s.paydayOffsetDays, [...s.approverIds].sort()]) !==
    JSON.stringify([saved.data?.frequency ?? null, needsAnchor ? saved.data?.anchorDate ?? null : null, saved.data?.paydayOffsetDays, [...(saved.data?.approverIds ?? [])].sort()]);
  let step = 0;

  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        saved.setData(await api<Schedule>("/pay-periods/schedule", { method: "PUT", body: { frequency: s.frequency, anchorDate: needsAnchor ? s.anchorDate : null, paydayOffsetDays: s.paydayOffsetDays, approverIds: s.approverIds } }));
        setDone(true);
      });
    }}>
      <div>
        <h2 style={{ margin: 0 }}>Pay schedule</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>Set how often you pay, when each pay period starts, and when payday is. The preview below updates as you choose.</p>
      </div>
      <fieldset disabled={!owner} className="setup-steps">
        <div className="setup-step">
          <div className="setup-step-label"><span className="setup-step-num">{++step}</span><div><strong>How often do you pay?</strong></div></div>
          <div className="setup-step-control">
            <select value={s.frequency ?? ""} onChange={(e) => edit({ frequency: (e.target.value || null) as PayFrequency | null })} aria-label="How often people are paid">
              <option value="">Not set up</option>
              {PAY_FREQUENCIES.map((f) => <option key={f} value={f}>{PAY_FREQUENCY_LABELS[f]}</option>)}
            </select>
          </div>
        </div>

        {needsAnchor && (
          <div className="setup-step">
            <div className="setup-step-label"><span className="setup-step-num">{++step}</span><div><strong>When does a pay period start?</strong><div className="muted">Pick the first day of any pay period, past or future. The others are counted from it.</div></div></div>
            <div className="setup-step-control">
              <input type="date" required value={s.anchorDate ?? ""} onChange={(e) => edit({ anchorDate: e.target.value || null })} aria-label="First day of a pay period" />
              {s.anchorDate && <div className="muted setup-step-hint">Periods start on a {new Date(`${s.anchorDate}T12:00:00`).toLocaleDateString([], { weekday: "long" })} and run {s.frequency === "weekly" ? "7" : "14"} days.</div>}
            </div>
          </div>
        )}
        {(s.frequency === "semimonthly" || s.frequency === "monthly") && (
          <div className="setup-step">
            <div className="setup-step-label"><span className="setup-step-num">{++step}</span><div><strong>Pay periods</strong></div></div>
            <div className="setup-step-control"><div className="setup-step-hint" style={{ marginTop: 0 }}>{s.frequency === "monthly" ? "Each calendar month, the 1st to the last day." : "The 1st to the 15th, and the 16th to the end of the month."}</div></div>
          </div>
        )}

        {s.frequency && (
          <div className="setup-step">
            <div className="setup-step-label"><span className="setup-step-num">{++step}</span><div><strong>When is payday?</strong><div className="muted">Days after a pay period ends. 0 pays on its last day.</div></div></div>
            <div className="setup-step-control">
              <div className="row" style={{ flexWrap: "nowrap", gap: 8 }}>
                <input type="number" min={0} max={31} required value={s.paydayOffsetDays} onChange={(e) => edit({ paydayOffsetDays: Number(e.target.value) })} style={{ width: 90 }} aria-label="Payday, days after the period ends" />
                <span className="muted">days after the period ends</span>
              </div>
              {preview[0] && <div className="muted setup-step-hint">This period ends {long(preview[0].end)}, so payday is {long(preview[0].payday)}.</div>}
            </div>
          </div>
        )}

        {s.frequency && (
          <div className="setup-step">
            <div className="setup-step-label">
              <span className="setup-step-num">{++step}</span>
              <div><strong>Who approves each pay period?</strong><div className="muted">Owners and admins only. They&apos;re notified when a period ends to review and approve everyone&apos;s hours. With nobody picked, all admins are asked.</div></div>
            </div>
            <div className="setup-step-control">
              <select value="" onChange={(e) => e.target.value && edit({ approverIds: [...s.approverIds, e.target.value] })} aria-label="Add an approver" style={{ width: "100%", maxWidth: 340 }}>
                <option value="">{choices.length ? "Add an approver…" : "Everyone eligible is already added"}</option>
                {choices.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName} · {roleName(c.role)}</option>)}
              </select>
              {s.approverIds.length > 0 && (
                <div className="approver-chips" aria-label="Approvers">
                  {s.approverIds.map((id) => {
                    const p = s.approverChoices.find((c) => c.id === id) ?? people.find((e) => e.id === id);
                    const ok = s.approverChoices.some((c) => c.id === id);
                    return (
                      <span key={id} className={`approver-chip${ok ? "" : " bad"}`} title={ok ? undefined : "Not an owner or admin. Remove to save."}>
                        {p ? `${p.firstName} ${p.lastName}` : "Unknown"}<span className="muted"> · {ok ? roleName(p!.role) : "not an owner or admin"}</span>
                        <button type="button" aria-label={`Remove ${p?.firstName ?? "approver"}`} onClick={() => edit({ approverIds: s.approverIds.filter((x) => x !== id) })}>×</button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </fieldset>

      {preview.length > 0 && (
        <div className="pay-preview">
          <strong style={{ fontSize: 14 }}>{changed ? "Preview (not saved yet)" : "Coming up"}</strong>
          <table>
            <thead><tr><th>Pay period</th><th>Payday</th></tr></thead>
            <tbody>{preview.map((p) => (
              <tr key={p.start}><td>{short(p.start)} – {short(p.end)}{p.end.slice(0, 4) !== todayIso.slice(0, 4) || p.start.slice(0, 4) !== p.end.slice(0, 4) ? `, ${p.end.slice(0, 4)}` : ""}</td><td>{long(p.payday)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <ErrorBox error={error} />
      {owner ? (
        <div className="row">
          <button className="btn primary" disabled={busy || !changed}>Save pay schedule</button>
          {done && !changed && <span className="muted" role="status">Saved.</span>}
          {changed && <span className="muted">You have unsaved changes.</span>}
        </div>
      ) : <p className="muted" style={{ margin: 0 }}>Only the owner can change the pay schedule.</p>}
    </form>
  );
}

/** Ended pay periods and whether they're approved. `onUse` fills the export dates. */
export function PayPeriodList({ onUse }: { onUse?: (start: string, end: string) => void }) {
  const list = useApi<{ periods: any[] }>("/pay-periods");
  if (!list.data) return <ErrorBox error={list.error} />;
  return (
    <div className="card">
      <h2>Pay periods</h2>
      {list.data.periods.length ? (
        <table><tbody>{list.data.periods.map((p) => (
          <tr key={p.id}>
            <td><Link href={`/pay-periods/${p.id}`}>{fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}</Link><div className="muted">Payday {fmtDate(p.payday)}</div></td>
            <td><Badge value={p.status === "approved" ? "approved" : "pending"} />{p.approvedBy && <div className="muted" style={{ fontSize: 12 }}>by {p.approvedBy}</div>}</td>
            <td style={{ textAlign: "right" }}>{onUse && <button className="btn sm" onClick={() => onUse(p.periodStart, p.periodEnd)}>Use dates</button>}</td>
          </tr>
        ))}</tbody></table>
      ) : <Empty>Pay periods show up here once the first one ends.</Empty>}
    </div>
  );
}

"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PAY_FREQUENCIES, PAY_FREQUENCY_LABELS, isInactive, type PayFrequency } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox } from "./ui";

interface Schedule {
  frequency: PayFrequency | null;
  anchorDate: string | null;
  paydayOffsetDays: number;
  approverIds: string[];
  upcoming: { start: string; end: string; payday: string }[];
}

/** Payroll page: how often people are paid, payday, and who approves each period (the owner edits). */
export function PaySchedule() {
  const { can } = useAuth();
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

  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        saved.setData(await api<Schedule>("/pay-periods/schedule", { method: "PUT", body: { frequency: s.frequency, anchorDate: needsAnchor ? s.anchorDate : null, paydayOffsetDays: s.paydayOffsetDays, approverIds: s.approverIds } }));
        setDone(true);
      });
    }}>
      <h2 style={{ margin: 0 }}>Pay schedule</h2>
      <fieldset disabled={!owner} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="formgrid">
          <label>How often people are paid
            <select value={s.frequency ?? ""} onChange={(e) => edit({ frequency: (e.target.value || null) as PayFrequency | null })}>
              <option value="">Not set up</option>
              {PAY_FREQUENCIES.map((f) => <option key={f} value={f}>{PAY_FREQUENCY_LABELS[f]}</option>)}
            </select>
          </label>
          {needsAnchor && (
            <label>First day of a pay period
              <input type="date" required value={s.anchorDate ?? ""} onChange={(e) => edit({ anchorDate: e.target.value || null })} />
              <span className="muted" style={{ fontSize: 12 }}>Any period&apos;s start date; the rest are counted from it.</span>
            </label>
          )}
          {s.frequency && (
            <label>Payday
              <span className="row" style={{ flexWrap: "nowrap" }}>
                <input type="number" min={0} max={31} required value={s.paydayOffsetDays} onChange={(e) => edit({ paydayOffsetDays: Number(e.target.value) })} style={{ width: 80 }} />
                <span className="muted">days after the period ends</span>
              </span>
            </label>
          )}
        </div>
        {s.frequency && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, padding: 0 }}>Who approves each pay period</legend>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              When a period ends, these people get a notification to review everyone&apos;s hours and approve them. Approvers can see each person&apos;s hours and estimated pay
              for the period, so pick people who should. With nobody picked, admins are asked.
            </p>
            <div className="formgrid">
              {people.map((e) => (
                <label key={e.id} className="check">
                  <input type="checkbox" checked={s.approverIds.includes(e.id)}
                    onChange={(ev) => edit({ approverIds: ev.target.checked ? [...s.approverIds, e.id] : s.approverIds.filter((x) => x !== e.id) })} />
                  {e.firstName} {e.lastName}<span className="muted"> · {e.role}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </fieldset>
      {saved.data?.upcoming.length ? (
        <div>
          <strong style={{ fontSize: 14 }}>Coming up</strong>
          <table><tbody>{saved.data.upcoming.map((p) => (
            <tr key={p.start}><td>{fmtDate(p.start)} – {fmtDate(p.end)}</td><td className="muted">Payday {fmtDate(p.payday)}</td></tr>
          ))}</tbody></table>
        </div>
      ) : null}
      <ErrorBox error={error} />
      {owner ? (
        <div className="row"><button className="btn primary" disabled={busy}>Save pay schedule</button>{done && <span className="muted" role="status">Saved.</span>}</div>
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

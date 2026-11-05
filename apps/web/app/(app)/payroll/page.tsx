"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { lastEndedPeriod, type PayFrequency } from "@crewdesk/shared";
import { api, download, fmtDate, fmtDateTime, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox, PageHead } from "@/components/ui";
import { PayPeriodList, PaySchedule } from "@/components/pay-schedule";
import { BusinessAddressFields, businessAddressValues } from "@/components/business-address-fields";
import { PayPeriodPicker, rangeLabel } from "@/components/pay-period-picker";

function lastWeek() {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) - 7);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { start: iso(monday), end: iso(sunday) };
}

function Settings({ settings, onSaved }: { settings: any; onSaved: () => void }) {
  const { can } = useAuth();
  const owner = can("owner", "payroll");
  const [provider, setProvider] = useState(settings.payrollProvider);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <form className="card stack" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const str = (k: string) => ((f.get(k) as string) ?? "").trim();
      run(async () => {
        await api("/payroll/settings", { method: "PUT", body: {
          payrollProvider: provider,
          payrollProviderCompanyId: provider === "check" ? str("payrollProviderCompanyId") || null : settings.payrollProviderCompanyId,
          weeklyOvertimeThreshold: Number(f.get("weeklyOvertimeThreshold")),
          taxFormsInCrewdesk: f.get("taxFormsInCrewdesk") === "on",
          legalName: str("legalName") || undefined,
          ein: str("ein"),
          ...businessAddressValues(str),
        } });
        setSaved(true);
        onSaved();
      });
    }}>
      <h2 style={{ margin: 0 }}>Payroll settings</h2>
      <fieldset disabled={!owner} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <label>How you run payroll
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setSaved(false); }}>
            <option value="csv">No payroll provider: export hours and run payroll myself (or send to my accountant)</option>
            <option value="check">Check (embedded payroll): send hours automatically</option>
          </select>
        </label>
        {provider === "check" && (
          <label>Check company ID<input name="payrollProviderCompanyId" defaultValue={settings.payrollProviderCompanyId ?? ""} placeholder="com_xxxxx" /></label>
        )}
        <label className="check">
          <input type="checkbox" name="taxFormsInCrewdesk" defaultChecked={settings.taxFormsInCrewdesk} />
          Collect W-4, I-9 and direct deposit forms in Crewdesk
        </label>
        <p className="muted" style={{ margin: 0 }}>
          Turn this off if your payroll provider collects tax and bank details from employees itself.
          {provider === "check" && settings.taxFormsInCrewdesk && " Check normally collects W-4 and bank details during employee setup, so you may not need both."}
        </p>
        <div className="formgrid">
          <label>Legal business name (for tax forms)<input name="legalName" defaultValue={settings.legalName ?? ""} /></label>
          <label>Employer ID number (EIN)<input name="ein" defaultValue={settings.ein ?? ""} placeholder="12-3456789" /></label>
          <label>Weekly overtime after (hours)<input name="weeklyOvertimeThreshold" type="number" min="1" defaultValue={settings.weeklyOvertimeThreshold} /></label>
        </div>
        <BusinessAddressFields initial={settings} />
      </fieldset>
      <ErrorBox error={error} />
      {owner ? (
        <div className="row"><button className="btn" disabled={busy}>Save settings</button>{saved && <span className="muted">Saved.</span>}</div>
      ) : <p className="muted">Only the owner can change payroll settings.</p>}
    </form>
  );
}

export default function Payroll() {
  const initial = lastWeek();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [approvedOnly, setApprovedOnly] = useState(false);
  const settings = useApi("/payroll/settings");
  // With a pay schedule, open on the last pay period that has ended (unless a period was already picked).
  const schedule = useApi<{ frequency: PayFrequency | null; anchorDate: string | null; paydayOffsetDays: number }>("/pay-periods/schedule");
  const picked = useRef(false);
  useEffect(() => {
    const sc = schedule.data;
    if (picked.current || !sc?.frequency || ((sc.frequency === "weekly" || sc.frequency === "biweekly") && !sc.anchorDate)) return;
    const t = new Date();
    const p = lastEndedPeriod(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`, { frequency: sc.frequency, anchorDate: sc.anchorDate, paydayOffsetDays: sc.paydayOffsetDays });
    setStart(p.start);
    setEnd(p.end);
  }, [schedule.data]);
  const q = `periodStart=${start}&periodEnd=${end}${approvedOnly ? "&approvedOnly=true" : ""}`;
  const preview = useApi<any[]>(`/payroll/preview?${q}`);
  const runs = useApi<any[]>("/payroll/runs");
  const pending = useApi<any[]>("/tax-forms/pending");
  const action = useAction();
  const rows = (preview.data ?? []).filter((l) => l.totalHours > 0 || l.ptoHours > 0 || l.holidayHours > 0 || l.holidayNotes?.length > 0 || l.payType === "salary");
  const unapproved = (preview.data ?? []).reduce((n, l) => n + l.unapprovedEntries, 0);
  const s = settings.data;
  const usesProvider = s?.payrollProvider === "check";
  const formsToEnter = (pending.data ?? []).filter((f) => f.type !== "i9").length;
  const sum = (k: string) => rows.reduce((t, l) => t + l[k], 0).toFixed(2);

  return (
    <>
      <PageHead title="Payroll" sub={usesProvider ? "Hours go to Check for you to approve there; you can still export a CSV any time." : "Export hours for each pay period and run payroll in your own system, or send the file to your accountant."} />
      {formsToEnter > 0 && !usesProvider && (
        <div className="card row" style={{ justifyContent: "space-between" }}>
          <span>{formsToEnter} new or updated W-4 / direct deposit form{formsToEnter > 1 ? "s" : ""} to enter in your payroll system.</span>
          <Link className="btn sm primary" href="/tax-forms">Review</Link>
        </div>
      )}
      <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>Export hours</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>Pick a pay period to see everyone&apos;s hours below, then export them{usesProvider ? " or send them to Check" : ""}.</p>
      </div>
      <div className="row">
        <PayPeriodPicker start={start} end={end} schedule={schedule.data ?? null} onChange={(a, b) => { setStart(a); setEnd(b); picked.current = true; }} />
        <label className="check"><input type="checkbox" checked={approvedOnly} onChange={(e) => setApprovedOnly(e.target.checked)} /> Approved time only</label>
        <div style={{ flex: 1 }} />
        <button className="btn primary" disabled={action.busy} onClick={() => action.run(async () => { await download(`/payroll/export.csv?${q}`, `payroll-${start}-to-${end}.csv`); runs.reload(); })}>
          Export CSV
        </button>
        {usesProvider && (
          <button className="btn" disabled={action.busy}
            onClick={() => confirm("Send these hours to Check as a draft payroll?") && action.run(async () => { await api("/payroll/submit", { body: { periodStart: start, periodEnd: end, approvedOnly } }); runs.reload(); })}>
            Send to Check
          </button>
        )}
      </div>
      </div>
      <ErrorBox error={action.error || preview.error} />
      {unapproved > 0 && (
        <div className="card row" style={{ justifyContent: "space-between" }}>
          <span><Badge value="pending" /> {unapproved} time entr{unapproved === 1 ? "y hasn't" : "ies haven't"} been approved yet{approvedOnly ? " and are left out of this export" : ""}.</span>
          <Link className="btn sm" href="/time">Review timesheets</Link>
        </div>
      )}
      <div className="card tablewrap">
        <h2>Hours for {rangeLabel(start, end)}</h2>
        {rows.length ? (
          <table>
            <thead><tr><th>Employee</th><th>Rate</th><th>Regular</th><th>Overtime</th><th>Time off</th><th>Holiday</th><th>Est. gross</th></tr></thead>
            <tbody>{rows.map((l) => (
              <tr key={l.employeeId}>
                <td>{l.firstName} {l.lastName}{l.payType === "salary" && <div className="muted">Salaried</div>}{l.unapprovedEntries > 0 && <div className="muted">{l.unapprovedEntries} unapproved</div>}</td>
                <td>{money(l.payRateCents)}{l.payType === "hourly" ? "/hr" : "/yr"}</td>
                <td>{l.regularHours.toFixed(2)}</td>
                <td>{l.overtimeHours.toFixed(2)}</td>
                <td>{l.ptoHours ? l.ptoHours.toFixed(2) : "—"}</td>
                <td title={l.holidayWorkedHours ? `${l.holidayWorkedHours.toFixed(2)}h worked on a holiday` : undefined}>{l.holidayHours ? l.holidayHours.toFixed(2) : "—"}{l.holidayWorkedHours ? <div className="muted" style={{ fontSize: 12 }}>+{l.holidayWorkedHours.toFixed(2)}h worked</div> : null}{l.holidayNotes?.map((n: string) => <div key={n} className="muted" style={{ fontSize: 12, maxWidth: 260 }}>⚠ {n}</div>)}</td>
                <td>{l.estimatedGrossCents == null ? <span className="muted">Salary</span> : money(l.estimatedGrossCents)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr>
              <th>Total</th><th />
              <th>{sum("regularHours")}</th><th>{sum("overtimeHours")}</th><th>{sum("ptoHours")}</th><th>{sum("holidayHours")}</th>
              <th>{money(rows.reduce((t, l) => t + (l.estimatedGrossCents ?? 0), 0))}</th>
            </tr></tfoot>
          </table>
        ) : <Empty>No hours or time off in this period.</Empty>}
        <p className="muted">
          Gross pay before taxes and deductions. Overtime is 1.5× after {s?.weeklyOvertimeThreshold ?? 40} hours a week; approved time off is paid at the regular rate.
          The CSV has one row per employee with regular, overtime and time-off hours, ready to key into QuickBooks, ADP, Gusto, Paychex, or to send to your accountant.
        </p>
      </div>
      <div className="grid cols-2">
        <PaySchedule />
        <PayPeriodList onUse={(a, b) => { setStart(a); setEnd(b); picked.current = true; window.scrollTo({ top: 0, behavior: "smooth" }); }} />
      </div>
      <div className="grid cols-2">
        {s && <Settings settings={s} onSaved={settings.reload} />}
        <div className="card">
          <h2>History</h2>
          {runs.data?.length ? (
            <table><tbody>{runs.data.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}<div className="muted">{fmtDateTime(r.createdAt)}</div></td>
                <td>{r.provider === "csv" ? "Exported" : `Sent to ${r.provider}`}</td>
                <td>{r.totals ? `${(r.totals.regularHours + r.totals.overtimeHours + (r.totals.ptoHours ?? 0)).toFixed(1)}h` : ""}</td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No payroll exports yet.</Empty>}
        </div>
      </div>
    </>
  );
}
